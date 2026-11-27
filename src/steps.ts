import { createHash } from 'node:crypto'

import { APIError } from 'payload'
import type { CollectionBeforeChangeHook, CollectionBeforeDeleteHook, CollectionConfig, Config, CollectionSlug, Payload, PayloadRequest, Where } from 'payload'

import { hasText, isBlankStep } from './blank.js'
import type { Answer, Flow, FlowRegistration, Req, Resolved, Step, WizardRecord } from './types.js'

const configOf = (payload: Payload): Resolved => {
  const o = payload.config.custom?.wizards as Resolved | undefined
  if (!o) throw new Error('Wizards: the plugin is not configured on this site.')
  return o
}

/** The scope could not be worked out, or a write or read falls outside it. Carries status 403. */
export class ScopeError extends APIError {
  constructor(message: string) {
    super(message, 403, undefined, true)
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** A value a scope may compare to: a non-empty string or a finite number. Nothing else is allowed, so nothing can match everything. */
const scalar = (v: unknown): v is string | number => (typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isFinite(v))

/**
 * A scope is safe to apply only if it can't match everything by accident and means the same thing in memory and in
 * every database. At every depth: `and` and `or` are non-empty arrays of scopes, and a field maps to a non-empty
 * object of `equals` (one non-empty string or finite number) and `in` (a non-empty list of them). Any other operator,
 * an empty or null value and anything not recognized is refused. Plain objects only. A deliberate match-all is the
 * host's own choice, made without the scope option.
 */
const validScope = (w: unknown): w is Where => {
  if (!isObject(w)) return false
  const keys = Object.keys(w)
  if (!keys.length) return false
  return keys.every((k) => {
    const v = w[k]
    if (k === 'and' || k === 'or') return Array.isArray(v) && v.length > 0 && v.every(validScope)
    if (!isObject(v)) return false
    const ops = Object.keys(v)
    return ops.length > 0 && ops.every((op) => (op === 'equals' ? scalar(v[op]) : op === 'in' ? Array.isArray(v[op]) && (v[op] as unknown[]).length > 0 && (v[op] as unknown[]).every(scalar) : false))
  })
}

const pathValue = (doc: Doc, path: string): unknown => path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Doc)[k] : undefined), doc)

/**
 * Whether a document (as it will be saved) matches a validated scope. A stored value that isn't a string or a number
 * (an object, a list, null, nothing) matches nothing, so a write the databases would read differently is refused.
 */
const matches = (doc: Doc, w: Where): boolean =>
  Object.entries(w).every(([k, v]) => {
    if (k === 'and') return (v as Where[]).every((x) => matches(doc, x))
    if (k === 'or') return (v as Where[]).some((x) => matches(doc, x))
    const raw = pathValue(doc, k)
    if (typeof raw !== 'string' && typeof raw !== 'number') return false
    const val = String(raw)
    return Object.entries(v as Record<string, unknown>).every(([op, arg]) => (op === 'equals' ? val === String(arg) : op === 'in' ? (arg as unknown[]).map(String).includes(val) : false))
  })

/**
 * The caller's scope: `null` when the host set none (0.1.0 behavior), otherwise its `where`. Fails closed: no
 * request, a hook that throws, or anything that isn't a valid scope raises ScopeError.
 */
const scopeOf = async (o: Resolved, req: Req | undefined): Promise<Where | null> => {
  if (!o.scope) return null
  if (!req) throw new ScopeError('Wizards: a scope is set, so this call needs `req`.')
  let w: unknown
  try {
    w = await o.scope.where({ req: req as PayloadRequest })
  } catch {
    throw new ScopeError('Wizards: the scope hook threw, so the call is refused.')
  }
  if (!validScope(w)) throw new ScopeError('Wizards: the scope hook must return a non-empty filter that uses only `equals` and `in`, with non-empty string or number values, so the call is refused.')
  return w
}

/** An access result with the scope ANDed in. `false` stays false; a failing scope refuses. */
const withScope = async (o: Resolved, req: Req, result: boolean | Where): Promise<boolean | Where> => {
  if (result === false) return false
  let scope: Where | null
  try {
    scope = await scopeOf(o, req)
  } catch {
    return false
  }
  if (!scope) return result
  return result === true ? scope : { and: [result, scope] }
}

/** Refuses, before anything is saved, a step that would sit outside the caller's scope. */
const checkWrite = (next: Doc, scope: Where) => {
  if (!matches(next, scope)) throw new ScopeError('This step would be outside your scope.')
}

type Method = (this: unknown, args: Doc) => Promise<unknown>

/** The adapter functions this plugin put its check in, so start-up can tell whether a later plugin took them out. */
const guarded = new WeakSet<Method>()
const checked = ['create', 'updateOne', 'deleteOne', 'deleteMany'] as const
const refused = ['updateMany', 'upsert'] as const
/** Passed straight through, but marked: the stored-step check reads with `find`, so a later plugin that wraps it would be noticed. */
const watched = ['find'] as const

/** Whether an object has anything in it. */
const hasKeys = (w: Where | undefined): w is Where => Boolean(w) && Object.keys(w as object).length > 0

/**
 * What the adapter will act on, worked out the way the adapters do: `updateOne` uses `id` when it is truthy and the
 * `where` otherwise; `deleteOne` and `deleteMany` use only the `where` and ignore an `id`.
 */
const targetOf = (name: string, a: Doc): Where | undefined => (name === 'updateOne' && a.id ? { id: { equals: a.id } } : (a.where as Where | undefined))

/**
 * Reads the stored steps the call would touch and refuses unless every one of them is inside the scope. It reads in
 * the locale the call uses, so a `where` on a localized field means the same here as in the write, and it reads with
 * `find`, which every database allows inside a transaction.
 */
const checkStored = async (adapter: Record<string, Method | undefined>, o: Resolved, a: Doc, target: Where | undefined, scope: Where) => {
  const locale = a.locale ?? (a.req as Req | undefined)?.locale
  const howMany = async (where: Where) =>
    ((await adapter.find!.call(adapter, { collection: o.slug, where, locale, limit: 0, pagination: false, select: { id: true }, req: a.req })) as { docs: unknown[] }).docs.length
  const base: Where = hasKeys(target) ? target : {}
  const all = await howMany(base)
  if (all && (await howMany(hasKeys(target) ? { and: [base, scope] } : scope)) !== all) throw new ScopeError('This step is outside your scope.')
}

/**
 * Puts the scope check at the one place every save passes last: the database adapter's create and update, which
 * receive the step exactly as it will be stored, after every field hook and every collection hook any plugin added,
 * whatever the plugins do before the adapter is called. An update or delete also reads the stored steps and refuses
 * unless every one is inside the scope, so a call can't move another site's step into its own site or delete it, and
 * the write itself is handed the scope in its `where` (and no `id`), so a step that changes between the read and the
 * write is still not touched. A bulk update or an upsert straight on the adapter is refused while a scope is set. A
 * plugin that wraps `db` and is listed before this one runs after the check on `create`, `updateOne`, `deleteOne`
 * and `deleteMany`, so its changes to those calls are not checked.
 */
export const guardDb = (o: Resolved, db: Config['db'] | undefined): Config['db'] => {
  if (!o.scope) return db as Config['db']
  if (!db || typeof db.init !== 'function') throw new Error('Wizards: a scope needs `db` set before this plugin, so the check can sit at the database.')
  return {
    ...db,
    init: (args) => {
      const adapter = db.init(args) as unknown as Record<string, Method | undefined>
      for (const name of watched) {
        const original = adapter[name]
        if (typeof original !== 'function') throw new Error(`Wizards: the database adapter has no ${name}, so the scope can't be enforced.`)
        const wrapped: Method = function (this: unknown, a: Doc) {
          return original.call(this, a)
        }
        guarded.add(wrapped)
        adapter[name] = wrapped
      }
      for (const name of checked) {
        const original = adapter[name]
        if (typeof original !== 'function') throw new Error(`Wizards: the database adapter has no ${name}, so the scope can't be enforced.`)
        const wrapped: Method = async function (this: unknown, a: Doc) {
          if (a?.collection !== o.slug) return original.call(this, a)
          const scope = await scopeOf(o, a.req as Req)
          if (!scope) return original.call(this, a)
          if (name === 'create') {
            checkWrite((a.data ?? {}) as Doc, scope)
            return original.call(this, a)
          }
          if (name === 'updateOne') {
            // An upsert inserts when nothing matches, so the stored-step check would have nothing to read. Refused like `upsert` itself.
            if (a.upsert || (a.options as Doc | undefined)?.upsert) throw new ScopeError('Wizards: an upsert on the steps is refused while a scope is set.')
            checkWrite((a.data ?? {}) as Doc, scope)
          }
          const target = targetOf(name, a)
          await checkStored(adapter, o, a, target, scope)
          const { id: _id, ...rest } = a
          return original.call(this, { ...rest, where: hasKeys(target) ? { and: [target, scope] } : scope })
        }
        guarded.add(wrapped)
        adapter[name] = wrapped
      }
      for (const name of refused) {
        const original = adapter[name]
        if (typeof original !== 'function') continue
        const wrapped: Method = async function (this: unknown, a: Doc) {
          if (a?.collection === o.slug) throw new ScopeError(`Wizards: ${name} on the steps is refused while a scope is set.`)
          return original.call(this, a)
        }
        guarded.add(wrapped)
        adapter[name] = wrapped
      }
      return adapter as never
    },
  }
}

/**
 * Start-up check with a scope set: the adapter the site actually runs must still carry this plugin's check (a plugin
 * that puts back an earlier `config.db` removes it), and the steps must have no versions or drafts, which write
 * through adapter calls the check does not cover.
 */
export const assertGuarded = (o: Resolved, payload: Payload) => {
  if (!o.scope) return
  const db = payload.db as unknown as Record<string, Method | undefined>
  for (const name of [...watched, ...checked, ...refused]) {
    const fn = db[name]
    if (typeof fn === 'function' && !guarded.has(fn))
      throw new Error(`Wizards: the database adapter's ${name} is not the one this plugin wrapped, so the scope isn't enforced. Another plugin replaced or re-wrapped \`db\`. Put \`wizardsPlugin\` last among the plugins that touch \`db\`.`)
  }
  const steps = payload.config.collections.find((c) => c.slug === o.slug)
  if (steps?.versions) throw new Error('Wizards: a scope is set, so the steps collection can\u2019t have versions or drafts. They write through adapter calls the scope check does not cover.')
}

/** Refuses, before the delete, a step outside the caller's scope. */
const beforeDelete =
  (o: Resolved): CollectionBeforeDeleteHook =>
  async ({ id, req }) => {
    const scope = await scopeOf(o, req)
    if (!scope) return
    const { totalDocs } = await req.payload.count({ collection: o.slug as CollectionSlug, where: { and: [{ id: { equals: id } }, scope] }, overrideAccess: true, req })
    if (!totalDocs) throw new ScopeError('This step is outside your scope.')
  }

/** A media file as the hash sees it: its id and when it last changed, so a swapped or replaced file counts as new. */
const fileOf = (v: unknown) => (v && typeof v === 'object' ? [String((v as { id?: unknown }).id ?? ''), String((v as { updatedAt?: unknown }).updatedAt ?? '')] : v ? [String(v), ''] : null)

/**
 * What a person confirms, in the language they read it: question, body, kind, options, the stop message, and the
 * video with its captions. Worked out each time a step is read in a locale, never stored, so it can't be stale or
 * belong to another language.
 */
export const contentHash = (s: { question?: unknown; body?: unknown; kind?: unknown; options?: unknown; stopMessage?: unknown; video?: unknown; captions?: unknown }) =>
  createHash('sha256')
    .update(JSON.stringify([s.question ?? '', s.body ?? '', s.kind ?? '', (s.options as unknown[] | undefined)?.map((x) => { const o = x as { value?: unknown; label?: unknown; stops?: unknown }; return [o.value, o.label, Boolean(o.stops)] }) ?? [], s.stopMessage ?? '', fileOf(s.video), fileOf(s.captions)]))
    .digest('hex')
    .slice(0, 24)

const idOf = (v: unknown) => (v && typeof v === 'object' ? (v as { id?: unknown }).id : v)

const beforeChange =
  (o: Resolved): CollectionBeforeChangeHook =>
  async ({ data, originalDoc, req }) => {
    const next = { ...originalDoc, ...data }
    // The scope is checked later, at the database, once every hook has run.
    if (next.video && !next.captions) throw new Error('A step with a video needs its captions (a WebVTT file).')
    if (next.kind === 'choice' && !(Array.isArray(next.options) && next.options.length >= 2)) throw new Error('A choice step needs at least two options.')
    if (next.kind === 'choice') {
      const values = (next.options as { value?: unknown }[]).map((x) => String(x?.value ?? ''))
      // One value for a stopping and a going-on option would let the check accept either.
      if (new Set(values).size !== values.length) throw new Error('Each option in a choice step needs its own value.')
    }
    if (!hasText(next.question)) throw new Error('A step needs a question with words in it, in each language it is saved in.')
    if (next.kind === 'choice' && !(next.options as { label?: unknown }[]).every((x) => hasText(x?.label))) throw new Error('Each option in a choice step needs a label with words in it.')
    if (next.kind !== 'info' && !hasText(next.stopMessage)) throw new Error('A gate or choice step needs a stop message: what to do when the answer is No.')
    if (o.media && (next.video || next.captions)) {
      const mime = async (v: unknown) => String(((await req.payload.findByID({ collection: o.media as CollectionSlug, id: idOf(v) as string, depth: 0, overrideAccess: !o.scope, req }).catch(() => null)) as { mimeType?: unknown } | null)?.mimeType ?? '')
      if (next.video && !(await mime(next.video)).startsWith('video/')) throw new Error('The video needs to be a video file.')
      if (next.captions && !/^text\/(vtt|plain)$/.test(await mime(next.captions))) throw new Error('The captions need to be a WebVTT (.vtt) file.')
    }
    return data
  }

export const stepsCollection = (o: Resolved): CollectionConfig => ({
  slug: o.slug,
  labels: { singular: 'Guided step', plural: 'Guided steps' },
  admin: { group: o.adminGroup, useAsTitle: 'question', defaultColumns: ['flow', 'group', 'order', 'question', 'active'] },
  access: {
    read: async (args) => withScope(o, args.req, (await o.edit(args)) === true ? true : { active: { equals: true } }),
    create: async (args) => (await o.edit(args)) === true && (await withScope(o, args.req, true)) !== false,
    update: async (args) => withScope(o, args.req, (await o.edit(args)) === true),
    delete: async (args) => withScope(o, args.req, (await o.edit(args)) === true),
  },
  hooks: { beforeChange: [beforeChange(o)], beforeDelete: [beforeDelete(o)] },
  indexes: [{ fields: ['flow', 'key', ...(o.scope?.indexWith ?? [])], unique: true }],
  fields: [
    { name: 'flow', type: 'text', required: true, index: true },
    { name: 'key', type: 'text', required: true, admin: { description: 'Stable: answers name it. Don’t reuse a key for a different question.' } },
    { name: 'group', type: 'text', required: true, admin: { description: 'The flow takes a group of steps in one place, such as "safety".' } },
    { name: 'order', type: 'number', defaultValue: 100 },
    { name: 'kind', type: 'select', required: true, defaultValue: 'gate', options: [{ label: 'Gate (Yes needed to go on)', value: 'gate' }, { label: 'Information (Next)', value: 'info' }, { label: 'Choice', value: 'choice' }] },
    { name: 'question', type: 'text', required: true, localized: true },
    { name: 'body', type: 'textarea', localized: true, admin: { description: 'The text version: everything the video says.' } },
    ...(o.media
      ? [
          { name: 'video', type: 'upload' as const, relationTo: o.media as CollectionSlug },
          { name: 'captions', type: 'upload' as const, relationTo: o.media as CollectionSlug, admin: { description: 'WebVTT captions. Required with a video.' } },
        ]
      : []),
    {
      name: 'options',
      type: 'array',
      admin: { condition: (d) => d?.kind === 'choice' },
      fields: [
        { name: 'value', type: 'text', required: true },
        { name: 'label', type: 'text', required: true, localized: true },
        { name: 'stops', type: 'checkbox', admin: { description: 'This answer stops the flow until changed.' } },
      ],
    },
    { name: 'stopMessage', type: 'textarea', localized: true, admin: { description: 'What No says: what to do before going on.' } },
    { name: 'active', type: 'checkbox', defaultValue: true, index: true },
  ],
})

/** Every flow: the site's own and those other plugins registered at `config.custom.wizardFlows`. One owner each. */
export function flowsOf(payload: Payload): Record<string, Flow> {
  const o = configOf(payload)
  const all: Record<string, Flow> = {}
  const owner: Record<string, string> = {}
  const add = (who: string, flows: Record<string, Flow>) => {
    for (const [k, f] of Object.entries(flows ?? {})) {
      if (owner[k]) throw new Error(`Wizards: the flow "${k}" is registered by both ${owner[k]} and ${who}.`)
      if (!Array.isArray(f?.slots) || !f.slots.length) throw new Error(`Wizards: the flow "${k}" from ${who} has no slots.`)
      const groups = f.slots.flatMap((s) => ('steps' in s ? [s.steps] : []))
      // A group in two slots would ask each step twice, and no answer could pass.
      if (new Set(groups).size !== groups.length) throw new Error(`Wizards: the flow "${k}" from ${who} uses a group of steps twice.`)
      owner[k] = who
      all[k] = f
    }
  }
  add('the site', o.flows)
  const regs = payload.config.custom?.wizardFlows as FlowRegistration[] | undefined
  for (const r of Array.isArray(regs) ? regs : []) add(String(r?.owner ?? 'a plugin'), r?.flows)
  return all
}

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const urlOf = (v: unknown) => (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string' ? (v as { url: string }).url : null)

/**
 * The content steps of a flow, in slot order, as the client shows them, in the locale asked for. Only active steps.
 * `empty` names any group of steps with no active step, and `blank` the key of any step left out because its
 * question, its stop message or an option label is blank in that locale (with `fallback: false`, an untranslated
 * step is blank). Either way the flow can't be passed until an editor fixes it.
 */
export async function flowSteps(payload: Payload, args: { flow: string; locale?: string; req?: Req }): Promise<{ slots: ({ code: string } | { step: Step })[]; empty: string[]; blank: string[] }> {
  const o = configOf(payload)
  const scope = await scopeOf(o, args.req)
  const flows = flowsOf(payload)
  const flow = Object.hasOwn(flows, args.flow) ? flows[args.flow]! : null
  if (!flow) throw new Error(`Wizards: no flow "${args.flow}".`)
  const docs = (await payload.find({ collection: o.slug as CollectionSlug, where: { and: [{ flow: { equals: args.flow } }, { active: { equals: true } }, ...(scope ? [scope] : [])] }, sort: ['order', 'key'], pagination: false, depth: scope ? 0 : 1, overrideAccess: true, ...(args.locale ? { locale: args.locale as never } : {}) })).docs as Doc[]
  // With a scope, files are fetched as the caller, so another site's video and captions never reach this site's page.
  if (scope) {
    const asCaller = async (v: unknown) => (v ? ((await payload.findByID({ collection: o.media as CollectionSlug, id: idOf(v) as string, depth: 0, overrideAccess: false, req: args.req }).catch(() => null)) as Doc | null) : null)
    for (const d of docs) {
      if (o.media) {
        d.video = await asCaller(d.video)
        d.captions = await asCaller(d.captions)
      }
    }
  }
  const out: ({ code: string } | { step: Step })[] = []
  const empty: string[] = []
  const blank: string[] = []
  for (const slot of flow.slots) {
    if ('code' in slot) out.push({ code: slot.code })
    else {
      const group = docs.filter((x) => x.group === slot.steps)
      if (!group.length) empty.push(slot.steps)
      for (const d of group) {
        if (isBlankStep(d)) {
          blank.push(String(d.key))
          continue
        }
        const video = urlOf(d.video)
        const captions = urlOf(d.captions)
        out.push({
          step: {
            key: d.key,
            group: d.group,
            kind: d.kind,
            question: d.question,
            body: d.body ?? '',
            video: video && captions ? { url: video, captionsUrl: captions } : null,
            options: ((d.options ?? []) as Doc[]).map((x) => ({ value: String(x.value), label: String(x.label), stops: Boolean(x.stops) })),
            stopMessage: d.stopMessage ?? '',
            hash: contentHash(d),
          },
        })
      }
    }
  }
  return { slots: out, empty, blank }
}

/**
 * Checks a flow's answers on the server before the owner acts. Fails closed: every active content step must be
 * answered exactly once, with the wording the server has now in that locale (its hash), and every gate Yes and every
 * choice a non-stopping option. A group of steps with no active step fails (`noSteps`): a safety group emptied by
 * mistake never waves a flow through. A step whose question, stop message or option label is blank in that locale
 * fails (`blankStep`), so nobody agrees to, or is recorded agreeing to, text they were never shown. A step changed since the screen loaded fails, and the person sees the new
 * wording. Returns the record to store with the action: the locale, and for each step the hash and the question as
 * the person read it, with the answer and the time. With a `scope` set, `req` is required and the check runs inside
 * the caller's scope; without it the answer is `noScope`, never all sites.
 */
export async function answersFor(payload: Payload, args: { flow: string; answers: unknown; locale?: string; req?: Req }): Promise<{ ok: true; record: WizardRecord } | { ok: false; problem: 'noScope' | 'unknownFlow' | 'noSteps' | 'blankStep' | 'badAnswers' | 'missing' | 'extra' | 'changed' | 'notYes'; key?: string }> {
  let flow: { slots: ({ code: string } | { step: Step })[]; empty: string[]; blank: string[] }
  try {
    flow = await flowSteps(payload, { flow: args.flow, locale: args.locale, req: args.req })
  } catch (e) {
    if (e instanceof ScopeError) return { ok: false, problem: 'noScope' }
    return { ok: false, problem: 'unknownFlow' }
  }
  if (flow.empty.length) return { ok: false, problem: 'noSteps', key: flow.empty[0] }
  if (flow.blank.length) return { ok: false, problem: 'blankStep', key: flow.blank[0] }
  if (!Array.isArray(args.answers) || args.answers.some((a) => !a || typeof a !== 'object' || typeof (a as Answer).key !== 'string' || typeof (a as Answer).hash !== 'string' || typeof (a as Answer).value !== 'string')) return { ok: false, problem: 'badAnswers' }
  const answers = args.answers as Answer[]
  const steps = flow.slots.flatMap((s) => ('step' in s ? [s.step] : []))
  const byKey = new Map<string, Answer[]>()
  for (const a of answers) byKey.set(a.key, [...(byKey.get(a.key) ?? []), a])
  for (const a of answers) if (!steps.some((s) => s.key === a.key)) return { ok: false, problem: 'extra', key: a.key }
  for (const s of steps) {
    const given = byKey.get(s.key) ?? []
    if (given.length !== 1) return { ok: false, problem: given.length ? 'extra' : 'missing', key: s.key }
    const a = given[0]!
    if (isBlankStep(s)) return { ok: false, problem: 'blankStep', key: s.key }
    if (a.hash !== s.hash) return { ok: false, problem: 'changed', key: s.key }
    if (s.kind === 'gate' && a.value !== 'yes') return { ok: false, problem: 'notYes', key: s.key }
    if (s.kind === 'info' && a.value !== 'seen') return { ok: false, problem: 'notYes', key: s.key }
    if (s.kind === 'choice') {
      const opt = s.options.find((x) => x.value === a.value)
      if (!opt || opt.stops) return { ok: false, problem: 'notYes', key: s.key }
    }
    if (s.kind !== 'gate' && s.kind !== 'info' && s.kind !== 'choice') return { ok: false, problem: 'notYes', key: s.key }
  }
  const localization = payload.config.localization
  const locale = args.locale || (localization ? localization.defaultLocale : null)
  return { ok: true, record: { flow: args.flow, at: new Date().toISOString(), locale, answers: steps.map((s) => ({ key: s.key, hash: s.hash, value: byKey.get(s.key)![0]!.value, question: s.question })) } }
}
