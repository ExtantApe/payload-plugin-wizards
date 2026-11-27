import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Config, type Payload } from 'payload'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { answersFor, contentHash, flowSteps, flowsOf, wizardsPlugin, type Answer, type FlowRegistration } from '../src/index.js'
import { stepsCollection } from '../src/steps.js'

// A made-up kit activation flow, with safety steps edited in the admin.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let payload: Payload
let mongo: MongoMemoryReplSet
// Test uploads go to a throwaway folder, never the repo.
const uploads = mkdtempSync(join(tmpdir(), 'wizards-media-'))
const editor = { id: 'e1', role: 'editor', collection: 'users' }
const member = { id: 'm1', role: 'member', collection: 'users' }
const as = (u: Doc | null) => ({ overrideAccess: false, user: u as never })

const step = (data: Doc) => payload.create({ collection: 'guided-steps' as never, data: { flow: 'kit-activation', group: 'safety', kind: 'gate', stopMessage: 'Do this first, then press Yes.', ...data } as never, ...as(editor) }) as Promise<Doc>
const yesTo = async (flow = 'kit-activation'): Promise<Answer[]> => {
  const { slots } = await flowSteps(payload, { flow })
  return slots.flatMap((s) => ('step' in s ? [{ key: s.step.key, hash: s.step.hash, value: s.step.kind === 'info' ? 'seen' : s.step.kind === 'choice' ? s.step.options.find((o) => !o.stops)!.value : 'yes' }] : []))
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      localization: { locales: ['en', 'es'], defaultLocale: 'en', fallback: true },
      db: mongooseAdapter({ url: mongo.getUri('wizards'), ensureIndexes: true }),
      collections: [
        { slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }] },
        { slug: 'media', upload: { staticDir: uploads }, access: { read: () => true, create: () => true }, fields: [] },
      ],
      plugins: [
        wizardsPlugin({
          flows: { 'kit-activation': { slots: [{ code: 'find-kit' }, { steps: 'safety' }, { code: 'sampled' }] }, 'nobody-home': { slots: [{ steps: 'not-seeded' }] }, audit: { slots: [{ steps: 'audit' }] } },
          access: { edit: ({ req }) => (req.user as { role?: string } | null)?.role === 'editor' },
        }),
        // Another plugin registers a flow after Wizards, with no import.
        (c: Config) => ({ ...c, custom: { ...c.custom, wizardFlows: [...((c.custom?.wizardFlows as FlowRegistration[]) ?? []), { owner: 'events', flows: { 'check-in': { slots: [{ steps: 'arrival' }] } } }] } }),
      ],
    }),
  })
  await step({ key: 'one-animal', order: 1, question: 'Is only this animal out?' })
  await step({ key: 'clean-hands', order: 2, question: 'Clean hands or fresh gloves?' })
  await step({ key: 'how-to', order: 3, kind: 'info', question: 'How to swab', body: 'Swab gently.', stopMessage: '' })
  await step({ key: 'sealed', order: 4, kind: 'choice', question: 'Have you sealed this tube?', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No', stops: true }] })
  await step({ key: 'old', order: 5, question: 'An old step', active: false })
  await step({ flow: 'check-in', group: 'arrival', key: 'arrived', question: 'Are you at the event?' })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
  rmSync(uploads, { recursive: true, force: true })
})

describe('steps', () => {
  it('lets editors change steps, the public read active ones only, and nobody else write', async () => {
    expect((await payload.find({ collection: 'guided-steps' as never, where: { flow: { equals: 'kit-activation' } } as never, ...as(null) })).docs.map((d) => (d as Doc).key)).not.toContain('old')
    expect((await payload.find({ collection: 'guided-steps' as never, where: { flow: { equals: 'kit-activation' } } as never, ...as(editor) })).docs.map((d) => (d as Doc).key)).toContain('old')
    await expect(payload.create({ collection: 'guided-steps' as never, data: { flow: 'kit-activation', group: 'safety', key: 'x', kind: 'gate', question: 'x', stopMessage: 's' } as never, ...as(member) })).rejects.toThrow()
  })

  it('refuses a gate without a stop message or a video without captions', async () => {
    await expect(step({ key: 'no-stop', group: 'other', question: 'q', stopMessage: '' })).rejects.toThrow(/stop message/)
    const video = (await payload.create({ collection: 'media' as never, data: {} as never, file: { data: Buffer.from('made-up'), mimetype: 'video/mp4', name: 'v.mp4', size: 7 }, overrideAccess: true })) as Doc
    await expect(step({ key: 'no-captions', group: 'other', question: 'q', video: video.id })).rejects.toThrow(/captions/)
  })
})

describe('flows', () => {
  it('lists code slots and active content steps in order', async () => {
    const { slots } = await flowSteps(payload, { flow: 'kit-activation' })
    expect(slots.map((s) => ('code' in s ? s.code : s.step.key))).toEqual(['find-kit', 'one-animal', 'clean-hands', 'how-to', 'sealed', 'sampled'])
  })

  it('takes flows from other plugins, and refuses a flow registered twice at start-up', async () => {
    expect((await flowSteps(payload, { flow: 'check-in' })).slots).toHaveLength(1)
    const twice = (c: Config) => ({ ...c, custom: { ...c.custom, wizardFlows: [{ owner: 'other', flows: { 'kit-activation': { slots: [{ code: 'x' }] } } }] } })
    await expect(getPayload({ key: 'dup', config: await buildConfig({ secret: 's', telemetry: false, typescript: { autoGenerate: false }, db: mongooseAdapter({ url: mongo.getUri('wizards-dup') }), collections: [{ slug: 'users', auth: true, fields: [] }], plugins: [wizardsPlugin({ flows: { 'kit-activation': { slots: [{ code: 'x' }] } }, access: { edit: () => true }, media: false }), twice] }) } as never)).rejects.toThrow(/registered by both/)
  })
})

describe('answers are checked on the server', () => {
  it('passes when every step is answered with today’s wording, and gives the record to keep', async () => {
    const r = await answersFor(payload, { flow: 'kit-activation', answers: await yesTo() })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.record.answers.map((a) => a.key)).toEqual(['one-animal', 'clean-hands', 'how-to', 'sealed'])
  })

  it('fails closed: a No, a stopping choice, a missing, extra or repeated step, stale wording, junk or an unknown flow', async () => {
    const good = await yesTo()
    const swap = (key: string, change: Partial<Answer>) => good.map((a) => (a.key === key ? { ...a, ...change } : a))
    expect(await answersFor(payload, { flow: 'kit-activation', answers: swap('one-animal', { value: 'no' }) })).toMatchObject({ ok: false, problem: 'notYes', key: 'one-animal' })
    expect(await answersFor(payload, { flow: 'kit-activation', answers: swap('sealed', { value: 'no' }) })).toMatchObject({ ok: false, problem: 'notYes' })
    expect(await answersFor(payload, { flow: 'kit-activation', answers: swap('how-to', { value: 'yes' }) })).toMatchObject({ ok: false, problem: 'notYes' })
    expect(await answersFor(payload, { flow: 'kit-activation', answers: good.slice(1) })).toMatchObject({ ok: false, problem: 'missing' })
    expect(await answersFor(payload, { flow: 'kit-activation', answers: [...good, { key: 'invented', hash: 'x', value: 'yes' }] })).toMatchObject({ ok: false, problem: 'extra' })
    expect(await answersFor(payload, { flow: 'kit-activation', answers: [...good, good[0]!] })).toMatchObject({ ok: false, problem: 'extra' })
    expect(await answersFor(payload, { flow: 'kit-activation', answers: swap('clean-hands', { hash: 'stale' }) })).toMatchObject({ ok: false, problem: 'changed' })
    expect(await answersFor(payload, { flow: 'kit-activation', answers: 'yes' })).toMatchObject({ ok: false, problem: 'badAnswers' })
    expect(await answersFor(payload, { flow: 'kit-activation', answers: [{ key: 1 }] })).toMatchObject({ ok: false, problem: 'badAnswers' })
    expect(await answersFor(payload, { flow: 'no-such-flow', answers: good })).toMatchObject({ ok: false, problem: 'unknownFlow' })
  })

  it('fails answers given to the old wording once an editor changes a step', async () => {
    const before = await yesTo()
    const [doc] = (await payload.find({ collection: 'guided-steps' as never, where: { key: { equals: 'clean-hands' } } as never, overrideAccess: true })).docs as Doc[]
    await payload.update({ collection: 'guided-steps' as never, id: doc!.id, data: { question: 'Clean hands, or new gloves?' } as never, ...as(editor) })
    expect(await answersFor(payload, { flow: 'kit-activation', answers: before })).toMatchObject({ ok: false, problem: 'changed', key: 'clean-hands' })
    expect((await answersFor(payload, { flow: 'kit-activation', answers: await yesTo() })).ok).toBe(true)
  })
})

describe('what the security read found', () => {
  const file = (name: string, mimetype: string) => payload.create({ collection: 'media' as never, data: {} as never, file: { data: Buffer.from('made-up'), mimetype, name, size: 7 }, overrideAccess: true }) as Promise<Doc>

  it('never passes a group of steps with no active step: unseeded, mistyped or all switched off', async () => {
    expect(await answersFor(payload, { flow: 'nobody-home', answers: [] })).toMatchObject({ ok: false, problem: 'noSteps', key: 'not-seeded' })
    const arrival = (await payload.find({ collection: 'guided-steps' as never, where: { group: { equals: 'arrival' } } as never, overrideAccess: true })).docs as Doc[]
    expect((await answersFor(payload, { flow: 'check-in', answers: await yesTo('check-in') })).ok).toBe(true) // the control
    for (const d of arrival) await payload.update({ collection: 'guided-steps' as never, id: d.id, data: { active: false } as never, ...as(editor) })
    expect(await answersFor(payload, { flow: 'check-in', answers: [] })).toMatchObject({ ok: false, problem: 'noSteps', key: 'arrival' })
  })

  it('changes the hash with every part a person confirms: wording, options, stop message, video and captions', () => {
    const base = { question: 'q', body: 'b', kind: 'choice', options: [{ value: 'y', label: 'Yes' }, { value: 'n', label: 'No', stops: true }], stopMessage: 's', video: { id: 'v1', updatedAt: 't1' }, captions: { id: 'c1', updatedAt: 't1' } }
    const h = contentHash(base)
    for (const change of [{ question: 'q2' }, { body: 'b2' }, { stopMessage: 's2' }, { options: [{ value: 'y', label: 'Yes' }, { value: 'n', label: 'No' }] }, { video: { id: 'v2', updatedAt: 't1' } }, { video: { id: 'v1', updatedAt: 't2' } }, { captions: { id: 'c2', updatedAt: 't1' } }, { video: null }, { captions: { id: 'c1', updatedAt: 't2' } }, { captions: null }, { kind: 'gate' }, { options: [{ value: 'y2', label: 'Yes' }, { value: 'n', label: 'No', stops: true }] }, { options: [{ value: 'y', label: 'Yes, all of it' }, { value: 'n', label: 'No', stops: true }] }])
      expect(contentHash({ ...base, ...change }), JSON.stringify(change)).not.toBe(h)
    expect(contentHash({ ...base })).toBe(h)
  })

  it('works out the hash per language, and records the language and the question as read', async () => {
    const [doc] = (await payload.find({ collection: 'guided-steps' as never, where: { key: { equals: 'one-animal' } } as never, overrideAccess: true })).docs as Doc[]
    const english = await yesTo()
    await payload.update({ collection: 'guided-steps' as never, id: doc!.id, locale: 'es' as never, data: { question: '¿Solo este animal está fuera?', stopMessage: 'Primero esto.' } as never, ...as(editor) })
    // The Spanish edit leaves English answers good, and Spanish readers get their own hash.
    expect((await answersFor(payload, { flow: 'kit-activation', answers: english })).ok).toBe(true)
    const { slots } = await flowSteps(payload, { flow: 'kit-activation', locale: 'es' })
    const spanish = slots.flatMap((s) => ('step' in s ? [{ key: s.step.key, hash: s.step.hash, value: s.step.kind === 'info' ? 'seen' : s.step.kind === 'choice' ? 'yes' : 'yes' }] : []))
    expect(spanish.find((a) => a.key === 'one-animal')!.hash).not.toBe(english.find((a) => a.key === 'one-animal')!.hash)
    expect(await answersFor(payload, { flow: 'kit-activation', answers: english, locale: 'es' })).toMatchObject({ ok: false, problem: 'changed', key: 'one-animal' })
    const r = await answersFor(payload, { flow: 'kit-activation', answers: spanish, locale: 'es' })
    expect(r.ok && [r.record.locale, r.record.answers[0]!.question]).toEqual(['es', '¿Solo este animal está fuera?'])
    const en = await answersFor(payload, { flow: 'kit-activation', answers: english })
    expect(en.ok && [en.record.locale, en.record.answers[0]!.question]).toEqual(['en', 'Is only this animal out?'])
  })

  it('fails answers given before an editor changed only the stop message', async () => {
    const before = await yesTo()
    const [doc] = (await payload.find({ collection: 'guided-steps' as never, where: { key: { equals: 'sealed' } } as never, overrideAccess: true })).docs as Doc[]
    await payload.update({ collection: 'guided-steps' as never, id: doc!.id, data: { stopMessage: 'Seal it, then press Yes.' } as never, ...as(editor) })
    expect(await answersFor(payload, { flow: 'kit-activation', answers: before })).toMatchObject({ ok: false, problem: 'changed', key: 'sealed' })
  })

  it('refuses a choice whose options share a value', async () => {
    await expect(step({ key: 'dupe-values', group: 'other', kind: 'choice', question: 'q', options: [{ value: 'yes', label: 'Yes' }, { value: 'yes', label: 'Not yet', stops: true }] })).rejects.toThrow(/its own value/)
  })

  it('takes a video file with WebVTT captions, and refuses the wrong kind of file for either', async () => {
    const video = await file('ok.mp4', 'video/mp4')
    const vtt = await file('ok.vtt', 'text/vtt')
    const text = await file('notes.txt', 'application/pdf')
    await expect(step({ key: 'good-video', group: 'other', question: 'q', video: video.id, captions: vtt.id })).resolves.toBeTruthy()
    await expect(step({ key: 'bad-video', group: 'other', question: 'q', video: text.id, captions: vtt.id })).rejects.toThrow(/video file/)
    await expect(step({ key: 'bad-captions', group: 'other', question: 'q', video: video.id, captions: video.id })).rejects.toThrow(/WebVTT/)
  })

  it('refuses at start-up a flow that uses one group of steps twice', async () => {
    await expect(getPayload({ key: 'twice', config: await buildConfig({ secret: 's', telemetry: false, typescript: { autoGenerate: false }, db: mongooseAdapter({ url: mongo.getUri('wizards-twice') }), collections: [{ slug: 'users', auth: true, fields: [] }], plugins: [wizardsPlugin({ flows: { f: { slots: [{ steps: 'safety' }, { code: 'x' }, { steps: 'safety' }] } }, access: { edit: () => true }, media: false })] }) } as never)).rejects.toThrow(/group of steps twice/)
  })
})

describe('who can change the steps', () => {
  const stored = async (key: string) => (await payload.find({ collection: 'guided-steps' as never, where: { key: { equals: key } } as never, overrideAccess: true })).docs[0] as Doc

  it('refuses a member and a signed-out visitor to create, update or delete, and changes nothing', async () => {
    const before = await stored('one-animal')
    const total = async () => (await payload.count({ collection: 'guided-steps' as never, overrideAccess: true })).totalDocs
    const count = await total()
    for (const who of [member, null]) {
      await expect(payload.create({ collection: 'guided-steps' as never, data: { flow: 'kit-activation', group: 'safety', key: 'uninvited', kind: 'gate', question: 'q', stopMessage: 's' } as never, ...as(who) })).rejects.toMatchObject({ status: 403 })
      await expect(payload.update({ collection: 'guided-steps' as never, id: before.id, data: { active: false } as never, ...as(who) })).rejects.toMatchObject({ status: 403 })
      await expect(payload.delete({ collection: 'guided-steps' as never, id: before.id, ...as(who) })).rejects.toMatchObject({ status: 403 })
    }
    expect(await total()).toBe(count)
    expect((await stored('one-animal')).active).toBe(true)
  })

  it('hides a switched-off step from a member and a signed-out visitor, asked for by id', async () => {
    const off = await stored('old')
    for (const who of [member, null]) await expect(payload.findByID({ collection: 'guided-steps' as never, id: off.id, ...as(who) })).rejects.toThrow()
    await expect(payload.findByID({ collection: 'guided-steps' as never, id: off.id, ...as(editor) })).resolves.toMatchObject({ key: 'old' })
  })

  it('counts only an answer of exactly true from access.edit', async () => {
    for (const answer of ['yes', 1, {}, { id: { exists: true } }, undefined, null, false]) {
      const access = stepsCollection({ slug: 'guided-steps', flows: {}, edit: () => answer as never, media: false, adminGroup: 'Wizards' }).access as Record<string, (a: unknown) => Promise<unknown>>
      for (const op of ['create', 'update', 'delete']) expect(await access[op]!({ req: {} }), `${op}: ${JSON.stringify(answer)}`).toBe(false)
      expect(await access.read!({ req: {} }), `read: ${JSON.stringify(answer)}`).toEqual({ active: { equals: true } })
    }
  })

  it('refuses at config time a missing edit rule, a media collection that takes no uploads, and a malformed scope option', () => {
    const base = { collections: [{ slug: 'media', fields: [] }] } as never
    const edit = () => true
    expect(() => wizardsPlugin({} as never)(base)).toThrow(/access\.edit/)
    expect(() => wizardsPlugin({ access: {} } as never)(base)).toThrow(/access\.edit/)
    expect(() => wizardsPlugin({ access: { edit } })(base)).toThrow(/isn't an upload collection/)
    expect(() => wizardsPlugin({ access: { edit }, media: 'nowhere' })(base)).toThrow(/isn't an upload collection/)
    expect(() => wizardsPlugin({ access: { edit }, media: false, scope: {} as never })(base)).toThrow(/scope\.where/)
    for (const indexWith of ['site', [''], [1]]) expect(() => wizardsPlugin({ access: { edit }, media: false, scope: { where: () => ({}), indexWith: indexWith as never } })(base), JSON.stringify(indexWith)).toThrow(/indexWith/)
  })
})

describe('a step can’t be saved in a state that would weaken a flow', () => {
  const mine = (data: Doc) => step({ flow: 'audit', group: 'rules', question: 'q', ...data })
  const choice = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', stops: true }]

  it('refuses a blank stop message, a choice with no stop message and a choice with fewer than two options', async () => {
    await expect(mine({ key: 'blank-stop', stopMessage: '   \n ' })).rejects.toThrow(/stop message/)
    await expect(mine({ key: 'choice-no-stop', kind: 'choice', options: choice, stopMessage: '' })).rejects.toThrow(/stop message/)
    await expect(mine({ key: 'no-options', kind: 'choice' })).rejects.toThrow(/at least two options/)
    await expect(mine({ key: 'one-option', kind: 'choice', options: [{ value: 'a', label: 'A' }] })).rejects.toThrow(/at least two options/)
  })

  it('refuses an update that takes away the stop message or the captions, and keeps what was stored', async () => {
    const file = (name: string, mimetype: string) => payload.create({ collection: 'media' as never, data: {} as never, file: { data: Buffer.from('made-up'), mimetype, name, size: 7 }, overrideAccess: true }) as Promise<Doc>
    const doc = await mine({ key: 'kept', video: (await file('kept.mp4', 'video/mp4')).id, captions: (await file('kept.vtt', 'text/vtt')).id })
    const change = (data: Doc) => payload.update({ collection: 'guided-steps' as never, id: doc.id, data: data as never, ...as(editor) })
    await expect(change({ stopMessage: '' })).rejects.toThrow(/stop message/)
    await expect(change({ captions: null })).rejects.toThrow(/captions/)
    const after = (await payload.findByID({ collection: 'guided-steps' as never, id: doc.id, depth: 0, overrideAccess: true })) as Doc
    expect([after.stopMessage, Boolean(after.captions)]).toEqual(['Do this first, then press Yes.', true])
  })

  it('refuses a flow with no slots, from the site or from another plugin', () => {
    const site = (flows: unknown, wizardFlows?: unknown) => ({ config: { custom: { wizards: { flows }, wizardFlows } } }) as never
    expect(() => flowsOf(site({ f: { slots: [] } }))).toThrow(/from the site has no slots/)
    expect(() => flowsOf(site({ f: {} }))).toThrow(/has no slots/)
    expect(() => flowsOf(site({}, [{ owner: 'events', flows: { g: { slots: [] } } }]))).toThrow(/from events has no slots/)
  })
})

describe('more ways an answer check stays closed, and what it keeps', () => {
  const edit = async (key: string, data: Doc) => {
    const [doc] = (await payload.find({ collection: 'guided-steps' as never, where: { key: { equals: key } } as never, overrideAccess: true })).docs as Doc[]
    await payload.update({ collection: 'guided-steps' as never, id: doc!.id, data: data as never, ...as(editor) })
  }

  it('refuses an invented choice value, "seen" on a gate, and answers to a switched-off or other flow’s step', async () => {
    const good = await yesTo()
    const swap = (key: string, value: string) => good.map((a) => (a.key === key ? { ...a, value } : a))
    const check = (answers: unknown) => answersFor(payload, { flow: 'kit-activation', answers })
    expect(await check(swap('sealed', 'maybe'))).toMatchObject({ ok: false, problem: 'notYes', key: 'sealed' })
    expect(await check(swap('one-animal', 'seen'))).toMatchObject({ ok: false, problem: 'notYes', key: 'one-animal' })
    for (const key of ['old', 'arrived']) expect(await check([...good, { key, hash: 'x', value: 'yes' }])).toMatchObject({ ok: false, problem: 'extra', key })
  })

  it('refuses answers of any wrong shape', async () => {
    for (const answers of [undefined, null, {}, [null], ['yes'], [{ key: 'one-animal', value: 'yes' }], [{ key: 'one-animal', hash: 'x' }], [{ key: 'one-animal', hash: 'x', value: true }], [{ key: 'one-animal', hash: 1, value: 'yes' }]])
      expect(await answersFor(payload, { flow: 'kit-activation', answers }), JSON.stringify(answers) ?? 'undefined').toEqual({ ok: false, problem: 'badAnswers' })
  })

  it('treats a flow named like a built-in object property as unknown', async () => {
    for (const flow of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      await expect(flowSteps(payload, { flow }), flow).rejects.toThrow(/no flow/)
      expect(await answersFor(payload, { flow, answers: [] }), flow).toMatchObject({ ok: false, problem: 'unknownFlow' })
    }
  })

  it('never passes when the steps can’t be read', async () => {
    const answers = await yesTo()
    const spy = vi.spyOn(payload, 'find').mockRejectedValueOnce(new Error('database down'))
    try {
      expect((await answersFor(payload, { flow: 'kit-activation', answers })).ok).toBe(false)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
    expect((await answersFor(payload, { flow: 'kit-activation', answers })).ok).toBe(true) // the control
  })

  it('keeps only the key, hash, answer and question in the record, writes nothing, and adds no collection for answers', async () => {
    const answers = (await yesTo()).map((a) => ({ ...a, note: 'made-up extra the client sent', question: 'made-up wording from the client' }))
    const writes = (['create', 'updateOne', 'updateMany', 'upsert'] as const).map((name) => vi.spyOn(payload.db, name as 'create'))
    try {
      const r = await answersFor(payload, { flow: 'kit-activation', answers })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(Object.keys(r.record).sort()).toEqual(['answers', 'at', 'flow', 'locale'])
      for (const a of r.record.answers) expect(Object.keys(a).sort()).toEqual(['hash', 'key', 'question', 'value'])
      expect(JSON.stringify(r.record)).not.toContain('made-up')
      for (const w of writes) expect(w).not.toHaveBeenCalled()
    } finally {
      for (const w of writes) w.mockRestore()
    }
    expect(payload.config.collections.map((c) => c.slug).filter((s) => !s.startsWith('payload-')).sort()).toEqual(['guided-steps', 'media', 'users'])
  })

  it('gives the page only the step’s own fields', async () => {
    const { slots } = await flowSteps(payload, { flow: 'kit-activation' })
    for (const s of slots) if ('step' in s) expect(Object.keys(s.step).sort()).toEqual(['body', 'group', 'hash', 'key', 'kind', 'options', 'question', 'stopMessage', 'video'])
  })

  it('fails answers given before a step was added or switched off', async () => {
    const before = await yesTo()
    await step({ key: 'late-rule', order: 6, question: 'A rule added later?' })
    expect(await answersFor(payload, { flow: 'kit-activation', answers: before })).toMatchObject({ ok: false, problem: 'missing', key: 'late-rule' })
    await edit('late-rule', { active: false })
    const withIt = [...before, { key: 'late-rule', hash: 'x', value: 'yes' }]
    expect(await answersFor(payload, { flow: 'kit-activation', answers: withIt })).toMatchObject({ ok: false, problem: 'extra', key: 'late-rule' })
  })

  it('fails answers given before a step’s video file was replaced', async () => {
    const file = (name: string, mimetype: string) => ({ data: Buffer.from('made-up'), mimetype, name, size: 7 })
    const upload = (name: string, mimetype: string) => payload.create({ collection: 'media' as never, data: {} as never, file: file(name, mimetype), overrideAccess: true }) as Promise<Doc>
    const video = await upload('first.mp4', 'video/mp4')
    await step({ flow: 'audit', group: 'audit', key: 'watched', question: 'Did you watch it?', video: video.id, captions: (await upload('first.vtt', 'text/vtt')).id })
    const before = await yesTo('audit')
    expect((await answersFor(payload, { flow: 'audit', answers: before })).ok).toBe(true)
    await payload.update({ collection: 'media' as never, id: video.id, data: {} as never, file: file('second.mp4', 'video/mp4'), overrideAccess: true })
    expect(await answersFor(payload, { flow: 'audit', answers: before })).toMatchObject({ ok: false, problem: 'changed', key: 'watched' })
  })
})
