import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { configToSchema } from '@payloadcms/graphql'
import { createRequire } from 'node:module'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server'
import { buildConfig, createLocalReq, getPayload, handleEndpoints, type Config, type Payload } from 'payload'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { answersFor, flowSteps, wizardsPlugin, type Answer } from '../src/index.js'
import { guardDb, ScopeError } from '../src/steps.js'

// The schema builder loads graphql as CommonJS, so the test must too: two copies of the library refuse to work together.
const { graphql } = createRequire(import.meta.url)('graphql') as typeof import('graphql')

// Two made-up sites share one steps collection. The host adds the `site` field itself.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let scoped: Payload
let open: Payload
let replset: MongoMemoryReplSet
let standalone: MongoMemoryServer
let scopedKey = ''
let dbOf: (name: string) => ReturnType<typeof mongooseAdapter> | ReturnType<typeof sqliteAdapter>
const sqliteDir = mkdtempSync(join(tmpdir(), 'wizards-scope-sqlite-'))
const uploads = mkdtempSync(join(tmpdir(), 'wizards-scope-media-'))
const flows = { 'kit-activation': { slots: [{ steps: 'safety' }] }, 'check-in': { slots: [{ steps: 'arrival' }] } }

// The scope hook the tests can bend: the default reads the caller's site.
let hook: (req: { user?: { site?: string } | null }) => unknown = (req) => ({ site: { equals: req.user?.site } })

const siteField = (c: Config): Config => ({
  ...c,
  collections: (c.collections ?? []).map((x) => (x.slug === 'guided-steps' ? { ...x, fields: [...x.fields, { name: 'site', type: 'text' as const, required: true, index: true }] } : x)),
})

// Host hooks that run after the plugin: a field hook and a later collection hook that can set the site, from a made-up
// header over REST or from these variables over Local.
let forceField: string | null = null
let forceCollection: string | null = null
const hostHooks = (c: Config): Config => ({
  ...c,
  collections: (c.collections ?? []).map((x) =>
    x.slug === 'guided-steps'
      ? {
          ...x,
          hooks: { ...x.hooks, beforeChange: [...(x.hooks?.beforeChange ?? []), ({ data }) => (forceCollection ? { ...data, site: forceCollection } : data)] },
          fields: x.fields.map((f) => ('name' in f && f.name === 'site' ? { ...f, hooks: { beforeChange: [({ value, req }: { value?: unknown; req: { headers?: Headers } }) => forceField ?? req.headers?.get?.('x-force-site') ?? value] } } : f)),
        }
      : x,
  ),
})

const config = (db: string, scope: boolean, indexWith?: string[]) =>
  buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    typescript: { autoGenerate: false },
    db: dbOf(db),
    collections: [
      { slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }, { name: 'site', type: 'text' }] },
      { slug: 'media', upload: { staticDir: uploads }, access: { read: ({ req }) => (req.user ? { site: { equals: (req.user as { site?: string }).site } } : false), create: () => true }, fields: [{ name: 'site', type: 'text' }] },
    ],
    plugins: [
      wizardsPlugin({
        flows,
        access: { edit: ({ req }) => (req.user as { role?: string } | null)?.role === 'editor' },
        ...(scope ? { scope: { where: ({ req }) => hook(req as never) as never, ...(indexWith ? { indexWith } : {}) } } : {}),
      }),
      siteField,
      hostHooks,
    ],
  })

const as = (u: Doc | null) => ({ overrideAccess: false, user: u as never })
const users: Record<string, Doc> = {}
const tokens: Record<string, string> = {}
const asUser = (name: string) => as(users[name]!)
const reqOf = async (p: Payload, name: string) => createLocalReq({ user: users[name] as never }, p)

const make = (p: Payload, who: string, data: Doc) => p.create({ collection: 'guided-steps' as never, data: { flow: 'kit-activation', group: 'safety', kind: 'gate', stopMessage: 'Do this first.', ...data } as never, ...asUser(who) }) as Promise<Doc>
const keysOf = (r: { docs: unknown[] }) => (r.docs as Doc[]).map((d) => d.key).sort()
const yesTo = async (flow: string, who: string): Promise<Answer[]> => {
  const { slots } = await flowSteps(scoped, { flow, req: await reqOf(scoped, who) })
  return slots.flatMap((s) => ('step' in s ? [{ key: s.step.key, hash: s.step.hash, value: 'yes' }] : []))
}
const rest = async (p: Payload, path: string, who: string | null) => {
  const res = await handleEndpoints({ config: p.config, payloadInstanceCacheKey: scopedKey, request: new Request(`http://localhost:3000/api${path}`, { headers: who ? { Authorization: `JWT ${tokens[who]}` } : {} }) })
  return { status: res.status, body: (await res.json()) as Doc }
}
const gql = async (who: string, query: string) => {
  const { schema } = configToSchema(scoped.config)
  const req = (await reqOf(scoped, who)) as Doc
  req.payloadAPI = 'GraphQL'
  return graphql({ schema, source: query, contextValue: { req } as never })
}

beforeAll(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  standalone = await MongoMemoryServer.create()
}, 120_000)

afterAll(async () => {
  await replset?.stop()
  await standalone?.stop()
  rmSync(uploads, { recursive: true, force: true })
  rmSync(sqliteDir, { recursive: true, force: true })
})

// The same checks on every database the plugin runs on. SQLite is run with its default (no transactions) and with them on.
let count = 0
const variants: [string, (name: string) => ReturnType<typeof mongooseAdapter> | ReturnType<typeof sqliteAdapter>][] = [
  ['mongo replica set', (name) => mongooseAdapter({ url: replset.getUri(name), ensureIndexes: true })],
  ['mongo standalone', (name) => mongooseAdapter({ url: standalone.getUri(name), ensureIndexes: true })],
  ['sqlite, default settings', (name) => sqliteAdapter({ client: { url: `file:${join(sqliteDir, `${name}.db`)}` } })],
  ['sqlite, transactions on', (name) => sqliteAdapter({ client: { url: `file:${join(sqliteDir, `${name}.db`)}` }, transactionOptions: {} })],
]

describe.each(variants)('%s', (_label, makeDb) => {
const n = `-${++count}`
beforeAll(async () => {
  dbOf = makeDb
  scopedKey = `scoped${n}`
  scoped = await getPayload({ key: `scoped${n}`, config: await config(`scoped${n}`, true, ['site']) })
  open = await getPayload({ key: `open${n}`, config: await config(`open${n}`, false) })
  for (const [name, role, site] of [['editorA', 'editor', 'a'], ['editorB', 'editor', 'b'], ['memberA', 'member', 'a']] as const) {
    const u = (await scoped.create({ collection: 'users' as never, data: { email: `${name}@example.com`, password: 'made-up-pass-1', role, site } as never, overrideAccess: true })) as Doc
    users[name] = { ...u, collection: 'users' }
    tokens[name] = (await scoped.login({ collection: 'users' as never, data: { email: `${name}@example.com`, password: 'made-up-pass-1' } as never })).token as string
  }
  // The same key on both sites: possible because the index takes the site.
  await make(scoped, 'editorA', { site: 'a', key: 'wash', question: 'Hands washed (A)?' })
  await make(scoped, 'editorA', { site: 'a', key: 'a-only', question: 'Only on site A?' })
  await make(scoped, 'editorA', { site: 'a', key: 'a-off', question: 'Switched off on A', active: false })
  await make(scoped, 'editorB', { site: 'b', key: 'wash', question: 'Hands washed (B)?' })
  await make(scoped, 'editorB', { site: 'b', key: 'b-only', question: 'Only on site B?' })
  await make(scoped, 'editorA', { site: 'a', flow: 'check-in', group: 'arrival', key: 'arrived', question: 'At the event?' })
}, 120_000)

afterAll(async () => {
  await scoped?.destroy()
  await open?.destroy()
})

describe('unset scope keeps 0.1.0 behavior', () => {
  it('shows every step to every reader, needs no req and still takes the same key twice only per flow', async () => {
    const make0 = (data: Doc) => open.create({ collection: 'guided-steps' as never, data: { flow: 'kit-activation', group: 'safety', kind: 'gate', stopMessage: 's', ...data } as never, overrideAccess: true }) as Promise<Doc>
    await make0({ site: 'a', key: 'one', question: 'q' })
    await make0({ site: 'b', key: 'two', question: 'q' })
    // Without indexWith, the index is flow + key: a second site can't reuse a key.
    await expect(make0({ site: 'b', key: 'one', question: 'q' })).rejects.toThrow()
    const { slots } = await flowSteps(open, { flow: 'kit-activation' })
    expect(slots.map((s) => ('step' in s ? s.step.key : s.code))).toEqual(['one', 'two'])
    const answers = slots.flatMap((s) => ('step' in s ? [{ key: s.step.key, hash: s.step.hash, value: 'yes' }] : []))
    expect((await answersFor(open, { flow: 'kit-activation', answers })).ok).toBe(true)
    expect((await open.find({ collection: 'guided-steps' as never, ...as(null) })).totalDocs).toBe(2)
  })
})

describe('reads stay inside the caller’s site', () => {
  it('Local with overrideAccess: false, for an editor and for the public', async () => {
    expect(keysOf(await scoped.find({ collection: 'guided-steps' as never, where: { flow: { equals: 'kit-activation' } } as never, ...asUser('editorA') }))).toEqual(['a-off', 'a-only', 'wash'])
    expect(keysOf(await scoped.find({ collection: 'guided-steps' as never, where: { flow: { equals: 'kit-activation' } } as never, ...asUser('editorB') }))).toEqual(['b-only', 'wash'])
    // A reader who isn't an editor still gets active steps only, and only their site's.
    expect(keysOf(await scoped.find({ collection: 'guided-steps' as never, where: { flow: { equals: 'kit-activation' } } as never, ...asUser('memberA') }))).toEqual(['a-only', 'wash'])
    const other = (await scoped.find({ collection: 'guided-steps' as never, where: { key: { equals: 'b-only' } } as never, overrideAccess: true })).docs[0] as Doc
    await expect(scoped.findByID({ collection: 'guided-steps' as never, id: other.id, ...asUser('editorA') })).rejects.toThrow()
  })

  it('REST list and REST count', async () => {
    expect(keysOf((await rest(scoped, '/guided-steps?limit=50&where[flow][equals]=kit-activation', 'editorA')).body as never)).toEqual(['a-off', 'a-only', 'wash'])
    expect(keysOf((await rest(scoped, '/guided-steps?limit=50&where[flow][equals]=kit-activation', 'editorB')).body as never)).toEqual(['b-only', 'wash'])
    expect((await rest(scoped, '/guided-steps/count?where[flow][equals]=kit-activation', 'editorA')).body.totalDocs).toBe(3)
    expect((await rest(scoped, '/guided-steps/count?where[flow][equals]=kit-activation', 'editorB')).body.totalDocs).toBe(2)
    // No signed-in user means no site: refused, never all sites.
    expect((await rest(scoped, '/guided-steps?limit=50', null)).body.docs ?? []).toEqual([])
  })

  it('GraphQL list', async () => {
    const q = '{ GuidedSteps(limit: 50, where: { flow: { equals: "kit-activation" } }) { totalDocs docs { key } } }'
    const a = await gql('editorA', q)
    expect(a.errors).toBeUndefined()
    expect((a.data as Doc).GuidedSteps.docs.map((d: Doc) => d.key).sort()).toEqual(['a-off', 'a-only', 'wash'])
    const b = await gql('editorB', q)
    expect((b.data as Doc).GuidedSteps.totalDocs).toBe(2)
  })

  it('Local count', async () => {
    expect((await scoped.count({ collection: 'guided-steps' as never, where: { flow: { equals: 'kit-activation' } } as never, ...asUser('editorA') })).totalDocs).toBe(3)
    expect((await scoped.count({ collection: 'guided-steps' as never, where: { flow: { equals: 'kit-activation' } } as never, ...asUser('editorB') })).totalDocs).toBe(2)
  })

  it('flowSteps and answersFor use the caller’s site, with the same key on both', async () => {
    const a = await flowSteps(scoped, { flow: 'kit-activation', req: await reqOf(scoped, 'editorA') })
    const b = await flowSteps(scoped, { flow: 'kit-activation', req: await reqOf(scoped, 'editorB') })
    const text = (r: typeof a) => r.slots.map((s) => ('step' in s ? `${s.step.key}:${s.step.question}` : s.code))
    expect(text(a)).toEqual(['a-only:Only on site A?', 'wash:Hands washed (A)?'])
    expect(text(b)).toEqual(['b-only:Only on site B?', 'wash:Hands washed (B)?'])
    const answersA = await yesTo('kit-activation', 'editorA')
    expect((await answersFor(scoped, { flow: 'kit-activation', answers: answersA, req: await reqOf(scoped, 'editorA') })).ok).toBe(true)
    // Site A's answers are wrong for site B: its steps and wording differ.
    expect((await answersFor(scoped, { flow: 'kit-activation', answers: answersA, req: await reqOf(scoped, 'editorB') })).ok).toBe(false)
  })
})

describe('scope fails closed', () => {
  it('refuses flowSteps and answersFor with a scope and no req, never falling back to all sites', async () => {
    await expect(flowSteps(scoped, { flow: 'kit-activation' })).rejects.toThrow(/needs `req`/)
    expect(await answersFor(scoped, { flow: 'kit-activation', answers: await yesTo('kit-activation', 'editorA') })).toMatchObject({ ok: false, problem: 'noScope' })
  })

  for (const [name, bad] of [['throws', () => { throw new Error('no site') }], ['returns {}', () => ({})], ['returns null', () => null], ['returns an array', () => [{ site: { equals: 'a' } }]], ['returns an empty or', () => ({ or: [] })], ['returns an empty and', () => ({ and: [] })], ['returns an empty operator object', () => ({ site: {} })], ['returns an empty or inside an and', () => ({ and: [{ or: [] }] })], ['returns an undefined value', () => ({ site: { equals: undefined } })], ['returns an empty in list', () => ({ site: { in: [] } })], ['returns an unknown operator', () => ({ site: { near: 'a' } })], ['returns a field with no operator object', () => ({ site: 'a' })], ['returns a class instance', () => new (class { site = { equals: 'a' } })()]] as const) {
    it(`refuses every path when the hook ${name}`, async () => {
      const good = hook
      const answers = await yesTo('kit-activation', 'editorA')
      hook = bad as never
      try {
        await expect(scoped.find({ collection: 'guided-steps' as never, ...asUser('editorA') })).rejects.toThrow(/not allowed/)
        await expect(scoped.count({ collection: 'guided-steps' as never, ...asUser('editorA') })).rejects.toThrow(/not allowed/)
        expect((await rest(scoped, '/guided-steps?limit=50', 'editorA')).body.docs ?? []).toEqual([])
        expect(((await gql('editorA', '{ GuidedSteps(limit: 50) { totalDocs } }')).data as Doc | null)?.GuidedSteps?.totalDocs ?? 0).toBe(0)
        await expect(flowSteps(scoped, { flow: 'kit-activation', req: await reqOf(scoped, 'editorA') })).rejects.toThrow()
        expect(await answersFor(scoped, { flow: 'kit-activation', answers, req: await reqOf(scoped, 'editorA') })).toMatchObject({ ok: false, problem: 'noScope' })
        await expect(make(scoped, 'editorA', { site: 'a', key: 'refused', question: 'q' })).rejects.toThrow()
        const mine = hook
        hook = good
        const [doc] = (await scoped.find({ collection: 'guided-steps' as never, where: { key: { equals: 'a-only' } } as never, ...asUser('editorA') })).docs as Doc[]
        hook = mine
        await expect(scoped.update({ collection: 'guided-steps' as never, id: doc!.id, data: { question: 'changed' } as never, ...asUser('editorA') })).rejects.toThrow()
        await expect(scoped.delete({ collection: 'guided-steps' as never, id: doc!.id, ...asUser('editorA') })).rejects.toThrow()
      } finally {
        hook = good
      }
      expect(keysOf(await scoped.find({ collection: 'guided-steps' as never, where: { key: { equals: 'a-only' } } as never, ...asUser('editorA') }))).toEqual(['a-only'])
    })
  }
})

describe('only equals and in, with non-empty scalar values, are a scope', () => {
  const refuses = async (name: string, bad: unknown) => {
    const good = hook
    hook = (() => bad) as never
    try {
      const req = await reqOf(scoped, 'editorA')
      const access = (scoped.collections['guided-steps' as never] as Doc).config.access as Record<string, (a: Doc) => Promise<unknown>>
      for (const op of ['read', 'create', 'update', 'delete']) expect(await access[op]!({ req, id: 'x' }), `${name}: ${op}`).toBe(false)
      await expect(scoped.find({ collection: 'guided-steps' as never, ...asUser('editorA') }), name).rejects.toThrow()
      await expect(make(scoped, 'editorA', { site: 'a', key: 'op-refused', question: 'q' }), name).rejects.toThrow()
      await expect(flowSteps(scoped, { flow: 'kit-activation', req }), name).rejects.toThrow()
    } finally {
      hook = good
    }
  }
  const refused: [string, unknown][] = [
    ...['not_equals', 'like', 'contains', 'greater_than', 'greater_than_equal', 'less_than', 'less_than_equal'].map((op): [string, unknown] => [op, { site: { [op]: 'a' } }]),
    ['not_in', { site: { not_in: ['a'] } }],
    ['exists', { site: { exists: true } }],
    ['exists as a string', { site: { exists: 'false' } }],
    ['equals plus a second operator', { site: { equals: 'a', not_equals: 'b' } }],
    ['an operator inside an or', { or: [{ site: { equals: 'a' } }, { site: { like: '' } }] }],
    ['an operator inside an and inside an or', { or: [{ and: [{ site: { contains: '' } }] }] }],
    ['equals an empty string', { site: { equals: '' } }],
    ['equals null', { site: { equals: null } }],
    ['equals NaN', { site: { equals: Number.NaN } }],
    ['equals Infinity', { site: { equals: Infinity } }],
    ['equals a boolean', { site: { equals: true } }],
    ['equals an object', { site: { equals: { id: 'a' } } }],
    ['equals a list', { site: { equals: ['a'] } }],
    ['in an empty string in the list', { site: { in: [''] } }],
    ['in a list with a good value and an empty one', { site: { in: ['a', ''] } }],
    ['in a list with null', { site: { in: ['a', null] } }],
    ['in a list with an object', { site: { in: [{ id: 'a' }] } }],
    ['in a string, not a list', { site: { in: 'a' } }],
    ['in null', { site: { in: null } }],
    ['an empty string in an or', { or: [{ site: { equals: 'a' } }, { site: { equals: '' } }] }],
  ]
  for (const [name, bad] of refused) it(`refuses ${name} on every path`, () => refuses(name, bad))

  it('accepts equals and in, alone, together and inside and and or', async () => {
    const good = hook
    try {
      for (const ok of [{ site: { equals: 'a' } }, { site: { in: ['a', 'zzz'] } }, { and: [{ site: { in: ['a'] } }, { site: { equals: 'a' } }] }, { or: [{ site: { equals: 'zzz' } }, { site: { equals: 'a' } }] }]) {
        hook = (() => ok) as never
        const doc = await make(scoped, 'editorA', { site: 'a', key: 'op-ok', question: 'q' })
        expect(doc.site).toBe('a')
        await expect(make(scoped, 'editorA', { site: 'b', key: 'op-ok-b', question: 'q' })).rejects.toMatchObject({ status: 403 })
        await scoped.delete({ collection: 'guided-steps' as never, id: doc.id, overrideAccess: true })
      }
    } finally {
      hook = good
    }
  })

  it('refuses a stored site that is missing, null, a list or an object, even when its text would match', async () => {
    const good = hook
    const base = { flow: 'kit-activation', group: 'safety', kind: 'gate', stopMessage: 's', question: 'q' }
    const create = async (data: Doc) => scoped.db.create({ collection: 'guided-steps' as never, data: { ...base, ...data } as never, req: await reqOf(scoped, 'editorA') })
    try {
      for (const [scope, site] of [
        [{ site: { equals: 'undefined' } }, undefined],
        [{ site: { in: ['undefined', 'null'] } }, undefined],
        [{ site: { equals: 'null' } }, null],
        [{ site: { in: ['null'] } }, null],
        [{ site: { equals: 'a' } }, ['a']],
        [{ site: { in: ['a'] } }, ['a']],
        [{ site: { equals: 'a' } }, { id: 'a' }],
        [{ site: { in: ['a'] } }, { id: 'a', toString: 'b' }],
        [{ site: { equals: '[object Object]' } }, { id: 'a' }],
      ] as [unknown, unknown][]) {
        hook = (() => scope) as never
        await expect(create({ key: 'weird', site }), JSON.stringify([scope, site])).rejects.toMatchObject({ status: 403 })
      }
      hook = (() => ({ site: { equals: 'a' } })) as never
      const [doc] = (await scoped.find({ collection: 'guided-steps' as never, where: { key: { equals: 'a-only' } } as never, overrideAccess: true })).docs as Doc[]
      await expect(scoped.update({ collection: 'guided-steps' as never, id: doc!.id, data: { site: { id: 'a', toString: 'b' } } as never, ...asUser('editorA') })).rejects.toThrow()
      await expect(scoped.db.updateOne({ collection: 'guided-steps' as never, id: doc!.id, data: { site: { id: 'a', toString: 'b' } } as never, req: await reqOf(scoped, 'editorA') })).rejects.toMatchObject({ status: 403 })
    } finally {
      hook = good
    }
    expect((await scoped.count({ collection: 'guided-steps' as never, where: { key: { equals: 'weird' } } as never, overrideAccess: true })).totalDocs).toBe(0)
    expect(((await scoped.find({ collection: 'guided-steps' as never, where: { key: { equals: 'a-only' } } as never, overrideAccess: true })).docs[0] as Doc).site).toBe('a')
  })

  it('refuses a bulk update or an upsert on the adapter while a scope is set', async () => {
    const req = await reqOf(scoped, 'editorA')
    await expect((scoped.db as Doc).updateMany({ collection: 'guided-steps', data: { site: 'a' }, where: { flow: { equals: 'kit-activation' } }, req })).rejects.toMatchObject({ status: 403 })
    await expect((scoped.db as Doc).upsert({ collection: 'guided-steps', data: { site: 'a' }, where: { key: { equals: 'a-only' } }, req })).rejects.toMatchObject({ status: 403 })
  })

  it('refuses updateOne with upsert set, so a no-match where inserts nothing', async () => {
    const req = await reqOf(scoped, 'editorA')
    const where = { key: { equals: 'upsert-probe' } }
    await expect((scoped.db as Doc).updateOne({ collection: 'guided-steps', data: { site: 'a', key: 'upsert-probe' }, where, options: { upsert: true }, req })).rejects.toMatchObject({ status: 403 })
    await expect((scoped.db as Doc).updateOne({ collection: 'guided-steps', data: { site: 'a', key: 'upsert-probe' }, where, upsert: true, req })).rejects.toMatchObject({ status: 403 })
    expect((await scoped.count({ collection: 'guided-steps' as never, where: where as never, overrideAccess: true })).totalDocs).toBe(0)
  })
})

describe('the scope is checked on the step as it will be stored, after every host hook', () => {
  const post = (who: string, body: Doc, headers: Doc = {}) => handleEndpoints({ config: scoped.config, payloadInstanceCacheKey: scopedKey, request: new Request('http://localhost:3000/api/guided-steps', { method: 'POST', headers: { Authorization: `JWT ${tokens[who]}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ flow: 'kit-activation', group: 'safety', kind: 'gate', stopMessage: 's', question: 'q', ...body }) }) })
  const patch = (who: string, id: unknown, body: Doc, headers: Doc = {}) => handleEndpoints({ config: scoped.config, payloadInstanceCacheKey: scopedKey, request: new Request(`http://localhost:3000/api/guided-steps/${id}`, { method: 'PATCH', headers: { Authorization: `JWT ${tokens[who]}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }) })
  const count = async (key: string) => (await scoped.count({ collection: 'guided-steps' as never, where: { key: { equals: key } } as never, overrideAccess: true })).totalDocs
  const aOnly = async () => ((await scoped.find({ collection: 'guided-steps' as never, where: { and: [{ key: { equals: 'a-only' } }, { flow: { equals: 'kit-activation' } }] } as never, overrideAccess: true })).docs[0]) as Doc

  for (const [label, set] of [['a field hook', (v: string | null) => { forceField = v }], ['a collection hook added after the plugin', (v: string | null) => { forceCollection = v }]] as const) {
    it(`cannot move a create or an update to another site with ${label}, over Local`, async () => {
      set('b')
      try {
        await expect(make(scoped, 'editorA', { site: 'a', key: 'hooked', question: 'q' })).rejects.toMatchObject({ status: 403 })
        const doc = await aOnly()
        await expect(scoped.update({ collection: 'guided-steps' as never, id: doc.id, data: { question: 'moved by a hook' } as never, ...asUser('editorA') })).rejects.toMatchObject({ status: 403 })
        // The same hook for the other editor lands on its own site, which is allowed.
        await expect(make(scoped, 'editorB', { site: 'a', key: 'hooked-b', question: 'q' })).resolves.toMatchObject({ site: 'b' })
      } finally {
        set(null)
      }
      expect(await count('hooked')).toBe(0)
      expect((await aOnly()).site).toBe('a')
      expect((await aOnly()).question).toBe('Only on site A?')
      for (const d of (await scoped.find({ collection: 'guided-steps' as never, where: { key: { equals: 'hooked-b' } } as never, overrideAccess: true })).docs as Doc[]) await scoped.delete({ collection: 'guided-steps' as never, id: d.id, ...asUser('editorB') })
    })
  }

  it('cannot move a create or an update to another site with a header-driven field hook, over REST', async () => {
    expect((await post('editorA', { site: 'a', key: 'rest-hooked' }, { 'x-force-site': 'b' })).status).toBe(403)
    expect((await patch('editorA', (await aOnly()).id, { question: 'rest moved' }, { 'x-force-site': 'b' })).status).toBe(403)
    expect(await count('rest-hooked')).toBe(0)
    expect((await aOnly()).site).toBe('a')
    // Without the header the same calls work, so the refusals came from the check.
    const ok = await post('editorA', { site: 'a', key: 'rest-fine' })
    expect(ok.status).toBe(201)
    for (const d of (await scoped.find({ collection: 'guided-steps' as never, where: { key: { equals: 'rest-fine' } } as never, overrideAccess: true })).docs as Doc[]) await scoped.delete({ collection: 'guided-steps' as never, id: d.id, ...asUser('editorA') })
  })
})

describe('writes stay inside the caller’s site', () => {
  it('creates in the caller’s site, and refuses a create into another site, leaving nothing behind', async () => {
    await expect(make(scoped, 'editorA', { site: 'a', key: 'new-a', question: 'q' })).resolves.toBeTruthy()
    await expect(make(scoped, 'editorA', { site: 'b', key: 'sneaky', question: 'q' })).rejects.toThrow()
    expect((await scoped.count({ collection: 'guided-steps' as never, where: { key: { equals: 'sneaky' } } as never, overrideAccess: true })).totalDocs).toBe(0)
  })

  it('refuses a member to create, and a create with no site', async () => {
    await expect(make(scoped, 'memberA', { site: 'a', key: 'member-made', question: 'q' })).rejects.toThrow()
    await expect(make(scoped, 'editorA', { key: 'no-site', question: 'q' })).rejects.toThrow()
  })

  it('updates in the caller’s site and refuses to touch another site’s step', async () => {
    const find = async (key: string, site: string) => ((await scoped.find({ collection: 'guided-steps' as never, where: { and: [{ key: { equals: key } }, { site: { equals: site } }] } as never, overrideAccess: true })).docs[0]) as Doc
    const mineA = await find('wash', 'a')
    const theirsB = await find('wash', 'b')
    await expect(scoped.update({ collection: 'guided-steps' as never, id: mineA.id, data: { question: 'Hands washed, A?' } as never, ...asUser('editorA') })).resolves.toBeTruthy()
    await expect(scoped.update({ collection: 'guided-steps' as never, id: theirsB.id, data: { question: 'taken over' } as never, ...asUser('editorA') })).rejects.toThrow()
    expect((await find('wash', 'b')).question).toBe('Hands washed (B)?')
  })

  it('refuses an update that moves a step out of the caller’s site, and the step stays put', async () => {
    const [doc] = (await scoped.find({ collection: 'guided-steps' as never, where: { key: { equals: 'a-only' } } as never, overrideAccess: true })).docs as Doc[]
    await expect(scoped.update({ collection: 'guided-steps' as never, id: doc!.id, data: { site: 'b', question: 'moved' } as never, ...asUser('editorA') })).rejects.toThrow()
    const after = (await scoped.findByID({ collection: 'guided-steps' as never, id: doc!.id, overrideAccess: true })) as Doc
    expect([after.site, after.question]).toEqual(['a', 'Only on site A?'])
  })

  it('refuses a bulk update that would move steps out, and one site’s bulk update never reaches the other', async () => {
    await expect(scoped.update({ collection: 'guided-steps' as never, where: { flow: { equals: 'kit-activation' } } as never, data: { site: 'b' } as never, ...asUser('editorA') })).resolves.toMatchObject({ docs: [], errors: expect.any(Array) })
    expect((await scoped.count({ collection: 'guided-steps' as never, where: { and: [{ flow: { equals: 'kit-activation' } }, { site: { equals: 'a' } }] } as never, overrideAccess: true })).totalDocs).toBeGreaterThanOrEqual(4)
  })

  it('deletes in the caller’s site and refuses to delete another site’s step', async () => {
    const [a] = (await scoped.find({ collection: 'guided-steps' as never, where: { key: { equals: 'new-a' } } as never, overrideAccess: true })).docs as Doc[]
    const [b] = (await scoped.find({ collection: 'guided-steps' as never, where: { key: { equals: 'b-only' } } as never, overrideAccess: true })).docs as Doc[]
    await expect(scoped.delete({ collection: 'guided-steps' as never, id: b!.id, ...asUser('editorA') })).rejects.toThrow()
    expect((await scoped.count({ collection: 'guided-steps' as never, where: { key: { equals: 'b-only' } } as never, overrideAccess: true })).totalDocs).toBe(1)
    await expect(scoped.delete({ collection: 'guided-steps' as never, id: a!.id, ...asUser('editorA') })).resolves.toBeTruthy()
  })

  it('applies over REST too: a PATCH from the wrong site is refused', async () => {
    const [b] = (await scoped.find({ collection: 'guided-steps' as never, where: { key: { equals: 'b-only' } } as never, overrideAccess: true })).docs as Doc[]
    const res = await handleEndpoints({ config: scoped.config, payloadInstanceCacheKey: scopedKey, request: new Request(`http://localhost:3000/api/guided-steps/${b!.id}`, { method: 'PATCH', headers: { Authorization: `JWT ${tokens.editorA}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'rest takeover' }) }) })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(((await scoped.findByID({ collection: 'guided-steps' as never, id: b!.id, overrideAccess: true })) as Doc).question).toBe('Only on site B?')
  })
})

describe('checks run per site', () => {
  it('refuses a site whose group was never seeded, even when another site has one', async () => {
    const withSteps = await answersFor(scoped, { flow: 'check-in', answers: await yesTo('check-in', 'editorA'), req: await reqOf(scoped, 'editorA') })
    expect(withSteps.ok).toBe(true) // the control: site A has the arrival step
    expect(await answersFor(scoped, { flow: 'check-in', answers: [], req: await reqOf(scoped, 'editorB') })).toMatchObject({ ok: false, problem: 'noSteps', key: 'arrival' })
    expect((await flowSteps(scoped, { flow: 'check-in', req: await reqOf(scoped, 'editorB') })).empty).toEqual(['arrival'])
  })

  it('keeps the start-up checks config-wide: scope never hides a flow registered twice', async () => {
    const twice = (c: Config) => ({ ...c, custom: { ...c.custom, wizardFlows: [{ owner: 'other', flows: { f: { slots: [{ code: 'x' }] } } }] } })
    await expect(getPayload({ key: `scope-dup${n}`, config: await buildConfig({ secret: 's', telemetry: false, typescript: { autoGenerate: false }, db: mongooseAdapter({ url: replset.getUri('scope-dup') }), collections: [{ slug: 'users', auth: true, fields: [] }], plugins: [wizardsPlugin({ flows: { f: { slots: [{ code: 'x' }] } }, access: { edit: () => true }, media: false, scope: { where: () => ({ site: { equals: 'a' } }) } }), twice] }) } as never)).rejects.toThrow(/registered by both/)
  })
})

describe('indexWith', () => {
  it('lets two sites share a key and still refuses a repeat on the same site', async () => {
    await expect(make(scoped, 'editorA', { site: 'a', key: 'wash', question: 'again' })).rejects.toThrow()
    expect((await scoped.count({ collection: 'guided-steps' as never, where: { key: { equals: 'wash' } } as never, overrideAccess: true })).totalDocs).toBe(2)
  })
})


describe('refusals before the write, as 403', () => {
  it('refuses a seed with no user before anything is saved, on every database', async () => {
    await expect(scoped.create({ collection: 'guided-steps' as never, data: { flow: 'kit-activation', group: 'safety', kind: 'gate', stopMessage: 's', site: 'b', key: 'seeded', question: 'q' } as never, overrideAccess: true })).rejects.toThrow()
    expect((await scoped.count({ collection: 'guided-steps' as never, where: { key: { equals: 'seeded' } } as never, overrideAccess: true })).totalDocs).toBe(0)
  })

  it('answers 403, not 400 or 500, for a create into another site and for a move out, whether or not the key exists there', async () => {
    for (const data of [{ site: 'b', key: 'wash', question: 'q' }, { site: 'b', key: 'free-key', question: 'q' }])
      await expect(make(scoped, 'editorA', data)).rejects.toMatchObject({ status: 403 })
    const [doc] = (await scoped.find({ collection: 'guided-steps' as never, where: { key: { equals: 'a-only' } } as never, overrideAccess: true })).docs as Doc[]
    await expect(scoped.update({ collection: 'guided-steps' as never, id: doc!.id, data: { site: 'b', key: 'wash' } as never, ...asUser('editorA') })).rejects.toMatchObject({ status: 403 })
    const post = await handleEndpoints({ config: scoped.config, payloadInstanceCacheKey: scopedKey, request: new Request('http://localhost:3000/api/guided-steps', { method: 'POST', headers: { Authorization: `JWT ${tokens.editorA}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ flow: 'kit-activation', group: 'safety', kind: 'gate', stopMessage: 's', site: 'b', key: 'wash', question: 'q' }) }) })
    expect(post.status).toBe(403)
  })

  it('refuses an anonymous delete by where and leaves the other site’s steps', async () => {
    const before = (await scoped.count({ collection: 'guided-steps' as never, overrideAccess: true })).totalDocs
    await scoped.delete({ collection: 'guided-steps' as never, where: { flow: { equals: 'kit-activation' } } as never, overrideAccess: true }).catch(() => null)
    expect((await scoped.count({ collection: 'guided-steps' as never, overrideAccess: true })).totalDocs).toBe(before)
  })

  it('refuses an anonymous or other-site delete by id in beforeDelete even with overrideAccess', async () => {
    const [b] = (await scoped.find({ collection: 'guided-steps' as never, where: { key: { equals: 'b-only' } } as never, overrideAccess: true })).docs as Doc[]
    await expect(scoped.delete({ collection: 'guided-steps' as never, id: b!.id, overrideAccess: true, user: users.editorA as never })).rejects.toMatchObject({ status: 403 })
    expect((await scoped.count({ collection: 'guided-steps' as never, where: { key: { equals: 'b-only' } } as never, overrideAccess: true })).totalDocs).toBe(1)
  })
})

describe('the access functions themselves', () => {
  const access = () => (scoped.collections['guided-steps' as never] as Doc).config.access as Record<string, (a: Doc) => Promise<unknown>>
  const call = async (op: string, who: string) => access()[op]!({ req: await reqOf(scoped, who), id: 'x' })

  it('update, delete and read hand back the site filter for an editor, and refuse a member to write', async () => {
    expect(await call('update', 'editorA')).toEqual({ site: { equals: 'a' } })
    expect(await call('delete', 'editorB')).toEqual({ site: { equals: 'b' } })
    expect(await call('read', 'editorA')).toEqual({ site: { equals: 'a' } })
    expect(await call('read', 'memberA')).toEqual({ and: [{ active: { equals: true } }, { site: { equals: 'a' } }] })
    expect(await call('update', 'memberA')).toBe(false)
    expect(await call('create', 'memberA')).toBe(false)
    expect(await call('create', 'editorA')).toBe(true)
  })

  it('refuse everything when the hook is bad, including a class instance', async () => {
    const good = hook
    try {
      for (const bad of [() => { throw new Error('x') }, () => ({}), () => null, () => new (class { site = { equals: 'a' } })()]) {
        hook = bad as never
        for (const op of ['read', 'create', 'update', 'delete']) expect(await call(op, 'editorA'), op).toBe(false)
      }
    } finally {
      hook = good
    }
  })
})

describe('media is looked up as the caller', () => {
  const file = (site: string, name: string, mimetype: string) => scoped.create({ collection: 'media' as never, data: { site } as never, file: { data: Buffer.from('made-up'), mimetype, name, size: 7 }, overrideAccess: true }) as Promise<Doc>

  it('refuses another site’s video and captions, and shows a site its own', async () => {
    const [aVideo, aVtt, bVideo, bVtt] = [await file('a', 'a.mp4', 'video/mp4'), await file('a', 'a.vtt', 'text/vtt'), await file('b', 'b.mp4', 'video/mp4'), await file('b', 'b.vtt', 'text/vtt')]
    await expect(make(scoped, 'editorA', { site: 'a', key: 'takes-b', question: 'q', video: bVideo.id, captions: bVtt.id })).rejects.toThrow(/video file/)
    expect((await scoped.count({ collection: 'guided-steps' as never, where: { key: { equals: 'takes-b' } } as never, overrideAccess: true })).totalDocs).toBe(0)
    await make(scoped, 'editorA', { site: 'a', key: 'has-video', question: 'With a video', video: aVideo.id, captions: aVtt.id })
    const steps = (await flowSteps(scoped, { flow: 'kit-activation', req: await reqOf(scoped, 'editorA') })).slots.flatMap((s) => ('step' in s ? [s.step] : []))
    expect(steps.find((x) => x.key === 'has-video')!.video?.url).toMatch(/\/a(-\d+)?\.mp4$/)
    // If the file ends up outside the site, the step shows no video rather than the other site's file.
    const [doc] = (await scoped.find({ collection: 'guided-steps' as never, where: { key: { equals: 'has-video' } } as never, overrideAccess: true })).docs as Doc[]
    await scoped.db.updateOne({ collection: 'guided-steps' as never, id: doc!.id, data: { site: 'a', video: bVideo.id, captions: bVtt.id } as never, req: await reqOf(scoped, 'editorA') })
    const after = (await flowSteps(scoped, { flow: 'kit-activation', req: await reqOf(scoped, 'editorA') })).slots.flatMap((s) => ('step' in s ? [s.step] : []))
    expect(after.find((x) => x.key === 'has-video')!.video).toBeNull()
  })
})

describe('start-up', () => {
  it('warns when scope is set without indexWith, and not with it', async () => {
    const run = async (indexWith?: string[]) => {
      const warn = vi.fn()
      const spy = (c: Config): Config => ({ ...c, onInit: async (p) => { p.logger.warn = warn as never; await c.onInit?.(p) } })
      const key = `warn${n}${indexWith ? 'i' : 'n'}`
      const p = await getPayload({ key, config: await buildConfig({ secret: 's', telemetry: false, typescript: { autoGenerate: false }, db: makeDb(key), collections: [{ slug: 'users', auth: true, fields: [] }], plugins: [wizardsPlugin({ flows, access: { edit: () => true }, media: false, scope: { where: () => ({ site: { equals: 'a' } }), ...(indexWith ? { indexWith } : {}) } }), siteField, spy] }) } as never)
      await p.destroy()
      return warn
    }
    expect((await run()).mock.calls.join(' ')).toMatch(/indexWith/)
    expect((await run(['site'])).mock.calls).toHaveLength(0)
  })
})

describe('the stored step is checked too, not only the incoming data', () => {
  const stored = async (key: string) => ((await scoped.find({ collection: 'guided-steps' as never, where: { and: [{ key: { equals: key } }, { flow: { equals: 'kit-activation' } }] } as never, overrideAccess: true })).docs[0]) as Doc
  const anyDb = () => scoped.db as unknown as Doc

  it('refuses an overrideAccess update that sets site a on site b’s step, and the step stays on b', async () => {
    const b = await stored('b-only')
    await expect(scoped.update({ collection: 'guided-steps' as never, id: b.id, data: { site: 'a', question: 'taken over' } as never, overrideAccess: true, user: users.editorA as never })).rejects.toMatchObject({ status: 403 })
    const after = await stored('b-only')
    expect(after.site).toBe('b')
    expect(after.question).toBe('Only on site B?')
  })

  it('refuses db.updateOne with site a’s request on site b’s step, by id and by where', async () => {
    const b = await stored('b-only')
    const req = await reqOf(scoped, 'editorA')
    await expect(anyDb().updateOne({ collection: 'guided-steps', id: b.id, data: { site: 'a' }, req })).rejects.toMatchObject({ status: 403 })
    await expect(anyDb().updateOne({ collection: 'guided-steps', where: { id: { equals: b.id } }, data: { site: 'a' }, req })).rejects.toMatchObject({ status: 403 })
    expect((await stored('b-only')).site).toBe('b')
  })

  it('still lets db.updateOne change a step on the caller’s own site', async () => {
    const a = await stored('a-only')
    await anyDb().updateOne({ collection: 'guided-steps', id: a.id, data: { site: 'a', question: 'Only on site A?' }, req: await reqOf(scoped, 'editorA') })
    expect((await stored('a-only')).site).toBe('a')
  })

  it('refuses db.deleteOne and db.deleteMany from site a that would reach site b’s step, and deletes nothing', async () => {
    const b = await stored('b-only')
    const req = await reqOf(scoped, 'editorA')
    const total = async () => (await scoped.count({ collection: 'guided-steps' as never, overrideAccess: true })).totalDocs
    const before = await total()
    await expect(anyDb().deleteOne({ collection: 'guided-steps', where: { id: { equals: b.id } }, req })).rejects.toMatchObject({ status: 403 })
    // A where that matches both sites’ steps is refused whole, so site a’s own steps are not deleted either.
    await expect(anyDb().deleteMany({ collection: 'guided-steps', where: { flow: { equals: 'kit-activation' } }, req })).rejects.toMatchObject({ status: 403 })
    await expect(anyDb().deleteMany({ collection: 'guided-steps', where: {}, req })).rejects.toMatchObject({ status: 403 })
    expect(await total()).toBe(before)
    expect((await stored('b-only')).site).toBe('b')
  })

  it('lets db.deleteOne and db.deleteMany delete steps that are all on the caller’s site', async () => {
    const req = await reqOf(scoped, 'editorA')
    await make(scoped, 'editorA', { site: 'a', key: 'tmp-1', question: 'q' })
    await make(scoped, 'editorA', { site: 'a', key: 'tmp-2', question: 'q' })
    const tmp = (await scoped.find({ collection: 'guided-steps' as never, where: { key: { like: 'tmp-' } } as never, overrideAccess: true })).docs as Doc[]
    expect(tmp).toHaveLength(2)
    await anyDb().deleteOne({ collection: 'guided-steps', where: { id: { equals: tmp.find((d) => d.key === 'tmp-1')!.id } }, req })
    await anyDb().deleteMany({ collection: 'guided-steps', where: { key: { equals: 'tmp-2' } }, req })
    const left = (await scoped.find({ collection: 'guided-steps' as never, where: { key: { like: 'tmp-' } } as never, overrideAccess: true })).docs as Doc[]
    expect(left.map((d) => d.key)).toEqual([])
  })

  it('refuses a deleteOne or deleteMany that carries an id of the caller’s own step next to a where on another site’s', async () => {
    const a = await stored('a-only')
    const b = await stored('b-only')
    const req = await reqOf(scoped, 'editorA')
    const total = async () => (await scoped.count({ collection: 'guided-steps' as never, overrideAccess: true })).totalDocs
    const before = await total()
    await expect(anyDb().deleteOne({ collection: 'guided-steps', id: a.id, where: { id: { equals: b.id } }, req })).rejects.toMatchObject({ status: 403 })
    await expect(anyDb().deleteMany({ collection: 'guided-steps', id: a.id, where: {}, req })).rejects.toMatchObject({ status: 403 })
    expect(await total()).toBe(before)
  })

  it('refuses a db.updateOne with an empty id and a where on another site’s step', async () => {
    const b = await stored('b-only')
    const req = await reqOf(scoped, 'editorA')
    await expect(anyDb().updateOne({ collection: 'guided-steps', id: '', where: { id: { equals: b.id } }, data: { site: 'a' }, req })).rejects.toMatchObject({ status: 403 })
    await expect(anyDb().updateOne({ collection: 'guided-steps', id: 0, where: { id: { equals: b.id } }, data: { site: 'a' }, req })).rejects.toMatchObject({ status: 403 })
    expect((await stored('b-only')).site).toBe('b')
  })

  it('calls the scope hook once for a db.updateOne and once for a db.deleteOne', async () => {
    const a = await stored('a-only')
    const req = await reqOf(scoped, 'editorA')
    const saved = hook
    let calls = 0
    hook = (r) => { calls++; return saved(r) }
    try {
      await anyDb().updateOne({ collection: 'guided-steps', id: a.id, data: { site: 'a' }, req })
      expect(calls).toBe(1)
      calls = 0
      await anyDb().deleteMany({ collection: 'guided-steps', where: { key: { equals: 'nothing-here' } }, req })
      expect(calls).toBe(1)
    } finally {
      hook = saved
    }
  })

  it('refuses a deleteMany with where {} inside a transaction as 403, and deletes nothing', async () => {
    const req = (await reqOf(scoped, 'editorA')) as Doc
    const total = async () => (await scoped.count({ collection: 'guided-steps' as never, overrideAccess: true })).totalDocs
    const before = await total()
    const txn = await scoped.db.beginTransaction?.()
    if (txn) req.transactionID = txn
    try {
      await expect(anyDb().deleteMany({ collection: 'guided-steps', where: {}, req })).rejects.toMatchObject({ status: 403 })
    } finally {
      if (txn) await scoped.db.rollbackTransaction(txn as never)
    }
    expect(await total()).toBe(before)
  })

  it('refuses db calls with no req while a scope is set, and leaves other collections alone', async () => {
    const b = await stored('b-only')
    await expect(anyDb().deleteOne({ collection: 'guided-steps', where: { id: { equals: b.id } } })).rejects.toMatchObject({ status: 403 })
    expect((await scoped.count({ collection: 'users' as never, overrideAccess: true })).totalDocs).toBeGreaterThan(0)
  })
})

describe('versions and drafts are refused while a scope is set', () => {
  const withVersions = (versions: unknown) => (c: Config): Config => ({ ...c, collections: (c.collections ?? []).map((x) => (x.slug === 'guided-steps' ? ({ ...x, versions } as never) : x)) })
  const boot = async (key: string, plugin: (c: Config) => Config, scope = true) => {
    const p = await getPayload({
      key,
      config: await buildConfig({
        secret: 's', telemetry: false, typescript: { autoGenerate: false }, db: makeDb(key),
        collections: [{ slug: 'users', auth: true, fields: [{ name: 'site', type: 'text' }] }],
        plugins: [wizardsPlugin({ flows, access: { edit: () => true }, media: false, ...(scope ? { scope: { where: () => ({ site: { equals: 'a' } }), indexWith: ['site'] } } : {}) }), siteField, plugin],
      } as never),
    })
    await p.destroy()
  }

  for (const [label, versions] of [['versions: true', true], ['drafts', { drafts: true }], ['drafts with autosave', { drafts: { autosave: true } }]] as const)
    it(`refuses to start with ${label} on the steps`, async () => {
      await expect(boot(`ver${n}${label.length}`, withVersions(versions))).rejects.toThrow(/can.t have versions or drafts/)
    })

  it('does not touch the same config with no scope', async () => {
    await expect(boot(`ver-open${n}`, withVersions({ drafts: true }), false)).resolves.toBeUndefined()
  })

  it('a draft or autosave write can’t move a step to another site, and the step stays put', async () => {
    const [a] = (await scoped.find({ collection: 'guided-steps' as never, where: { and: [{ key: { equals: 'a-only' } }, { flow: { equals: 'kit-activation' } }] } as never, overrideAccess: true })).docs as Doc[]
    for (const extra of [{ draft: true }, { draft: true, autosave: true }])
      await expect(scoped.update({ collection: 'guided-steps' as never, id: a!.id, data: { site: 'b' } as never, ...extra, ...asUser('editorA') })).rejects.toMatchObject({ status: 403 })
    await expect(scoped.create({ collection: 'guided-steps' as never, data: { flow: 'kit-activation', group: 'safety', kind: 'gate', stopMessage: 's', site: 'b', key: 'drafted', question: 'q' } as never, draft: true, ...asUser('editorA') })).rejects.toMatchObject({ status: 403 })
    const res = await handleEndpoints({ config: scoped.config, payloadInstanceCacheKey: scopedKey, request: new Request(`http://localhost:3000/api/guided-steps/${a!.id}?draft=true`, { method: 'PATCH', headers: { Authorization: `JWT ${tokens.editorA}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ site: 'b' }) }) })
    expect(res.status).toBe(403)
    expect(((await scoped.findByID({ collection: 'guided-steps' as never, id: a!.id, overrideAccess: true })) as Doc).site).toBe('a')
    expect((await scoped.count({ collection: 'guided-steps' as never, where: { key: { equals: 'drafted' } } as never, overrideAccess: true })).totalDocs).toBe(0)
  })

  it('findVersions has nothing to read: the steps have no versions, so no other site’s versions come back', async () => {
    await expect(scoped.findVersions({ collection: 'guided-steps' as never, ...asUser('editorB') })).rejects.toThrow()
    const res = await handleEndpoints({ config: scoped.config, payloadInstanceCacheKey: scopedKey, request: new Request('http://localhost:3000/api/guided-steps/versions', { headers: { Authorization: `JWT ${tokens.editorB}` } }) })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((scoped.config.collections.find((c) => c.slug === 'guided-steps') as Doc).versions).toBeFalsy()
  })
})

describe('plugin order: the final database adapter must still carry the check', () => {
  const boot = async (key: string, plugins: ((c: Config) => Config)[]) => {
    const base = makeDb(key)
    const p = await getPayload({
      key,
      config: await buildConfig({
        secret: 's', telemetry: false, typescript: { autoGenerate: false }, db: base,
        collections: [{ slug: 'users', auth: true, fields: [{ name: 'site', type: 'text' }] }],
        plugins: [wizardsPlugin({ flows, access: { edit: () => true }, media: false, scope: { where: () => ({ site: { equals: 'a' } }), indexWith: ['site'] } }), siteField, ...plugins.map((f) => (c: Config) => f({ ...c, custom: { ...c.custom, base } }))],
      } as never),
    })
    await p.destroy()
  }

  it('refuses to start when a later plugin puts the original config.db back', async () => {
    await expect(boot(`order-restore${n}`, [(c) => ({ ...c, db: (c.custom as Doc).base })])).rejects.toThrow(/not the one this plugin wrapped/)
  })

  it('refuses to start when a later plugin wraps create outside the check', async () => {
    const wrap = (c: Config): Config => ({ ...c, db: { ...c.db, init: (a: { payload: Payload }) => { const ad = c.db.init(a as never) as unknown as Doc; const inner = ad.create; return { ...ad, create: (x: Doc) => inner.call(ad, x) } as never } } })
    await expect(boot(`order-wrap${n}`, [wrap])).rejects.toThrow(/Put .wizardsPlugin. last/)
  })

  for (const name of ['updateMany', 'upsert', 'find', 'deleteOne', 'updateOne', 'deleteMany'])
    it(`refuses to start when a later plugin wraps ${name} outside the check`, async () => {
      const wrap = (c: Config): Config => ({ ...c, db: { ...c.db, init: (a: { payload: Payload }) => { const ad = c.db.init(a as never) as unknown as Doc; const inner = ad[name]; return { ...ad, [name]: (x: Doc) => inner.call(ad, x) } as never } } })
      await expect(boot(`order-wrap-${name}${n}`, [wrap])).rejects.toThrow(new RegExp(`adapter's ${name} is not the one`))
    })

  it('starts when no plugin touches db after it', async () => {
    await expect(boot(`order-ok${n}`, [])).resolves.toBeUndefined()
  })
})

describe('a where on a localized field is counted in the locale the call uses', () => {
  it('refuses a db.updateOne in locale es on a localized field that reaches another site’s step, on every database', async () => {
    const key = `loc${n}`
    const p = await getPayload({
      key,
      config: await buildConfig({
        secret: 's', telemetry: false, typescript: { autoGenerate: false }, db: makeDb(key),
        localization: { locales: ['en', 'es'], defaultLocale: 'en' },
        collections: [{ slug: 'users', auth: true, fields: [{ name: 'site', type: 'text' }] }],
        plugins: [wizardsPlugin({ flows, access: { edit: () => true }, media: false, scope: { where: ({ req }) => ({ site: { equals: (req.user as { site?: string } | null)?.site } }), indexWith: ['site'] } }), siteField],
      } as never),
    })
    try {
      const mk = async (site: string, k: string) => {
        const doc = (await p.create({ collection: 'guided-steps' as never, data: { flow: 'kit-activation', group: 'safety', kind: 'gate', stopMessage: 's', site, key: k, question: `en ${k}` } as never, user: { id: 'x', collection: 'users', site } as never, overrideAccess: true })) as Doc
        await p.update({ collection: 'guided-steps' as never, id: doc.id, locale: 'es' as never, data: { question: `hola ${k}`, stopMessage: 'es' } as never, user: { id: 'x', collection: 'users', site } as never, overrideAccess: true })
        return doc
      }
      await mk('a', 'one')
      const b = await mk('b', 'two')
      const req = await createLocalReq({ user: { id: 'x', collection: 'users', site: 'a' } as never }, p)
      await expect((p.db as unknown as Doc).updateOne({ collection: 'guided-steps', where: { question: { equals: 'hola two' } }, locale: 'es', data: { site: 'a' }, req })).rejects.toMatchObject({ status: 403 })
      const after = (await p.findByID({ collection: 'guided-steps' as never, id: b.id, overrideAccess: true })) as Doc
      expect(after.site).toBe('b')
    } finally {
      await p.destroy()
    }
  })
})

})

// The start-up refusals of guardDb, directly, so each can be removed on its own and a test notices.
describe('guardDb refuses what it can’t guard', () => {
  const o = { scope: { where: () => ({ site: { equals: 'a' } }) }, slug: 'guided-steps', flows: {}, edit: () => true, media: false, adminGroup: 'Wizards' } as never
  const fn = async () => ({})
  const full = { find: fn, create: fn, updateOne: fn, deleteOne: fn, deleteMany: fn }
  const init = (adapter: Record<string, unknown>) => (guardDb(o, { init: () => ({ ...adapter }) } as never) as { init: (a: never) => unknown }).init({} as never)

  it('throws when db is missing, or has no init', () => {
    expect(() => guardDb(o, undefined)).toThrow(/needs `db` set before this plugin/)
    expect(() => guardDb(o, {} as never)).toThrow(/needs `db` set before this plugin/)
  })

  it('throws when the adapter lacks find, create, updateOne, deleteOne or deleteMany, naming it', () => {
    for (const name of Object.keys(full)) {
      const { [name]: _gone, ...rest } = full as Record<string, unknown>
      expect(() => init(rest)).toThrow(new RegExp(`no ${name}`))
    }
  })

  it('wraps a complete adapter, and passes everything through with no scope', () => {
    const wrapped = init({ ...full, updateMany: fn, upsert: fn }) as Record<string, unknown>
    for (const name of ['create', 'updateOne', 'deleteOne', 'deleteMany', 'updateMany', 'upsert']) expect(wrapped[name]).not.toBe((full as Record<string, unknown>)[name] ?? fn)
    const db = { init: () => ({}) } as never
    expect(guardDb({ ...(o as object), scope: undefined } as never, db)).toBe(db)
  })

  it('a scope error is a 403, the same status for each refusal', async () => {
    expect(new ScopeError('x').status).toBe(403)
    const wrapped = init(full) as Doc
    await expect(wrapped.create({ collection: 'guided-steps', data: { site: 'a' } })).rejects.toMatchObject({ status: 403, isPublic: true })
  })

  it('hands the adapter a where with the scope in it and no id, so the write itself stays inside the scope', async () => {
    const seen: Doc[] = []
    const spy = (name: string) => async (a: Doc) => { seen.push({ name, ...a }); return name === 'find' ? { docs: [] } : {} }
    const wrapped = init({ find: spy('find'), create: spy('create'), updateOne: spy('updateOne'), deleteOne: spy('deleteOne'), deleteMany: spy('deleteMany') }) as Doc
    const req = {}
    await wrapped.updateOne({ collection: 'guided-steps', id: 'x1', data: { site: 'a' }, req })
    await wrapped.updateOne({ collection: 'guided-steps', id: '', where: { key: { equals: 'k' } }, data: { site: 'a' }, req })
    await wrapped.deleteOne({ collection: 'guided-steps', id: 'x2', where: { key: { equals: 'k' } }, req })
    await wrapped.deleteMany({ collection: 'guided-steps', where: {}, req })
    const writes = seen.filter((s) => s.name !== 'find')
    expect(writes.map((w) => w.name)).toEqual(['updateOne', 'updateOne', 'deleteOne', 'deleteMany'])
    for (const w of writes) {
      expect(w.id).toBeUndefined()
      expect(JSON.stringify(w.where)).toContain('"site":{"equals":"a"}')
    }
    expect(JSON.stringify(writes[0]!.where)).toContain('"id":{"equals":"x1"}')
    expect(JSON.stringify(writes[1]!.where)).toContain('"key"')
    expect(JSON.stringify(writes[2]!.where)).not.toContain('x2')
  })

  it('passes the call’s locale to the read of the stored steps', async () => {
    const seen: Doc[] = []
    const counter = async (a: Doc) => { seen.push(a); return { docs: [] } }
    const wrapped = init({ ...full, find: counter }) as Doc
    await wrapped.updateOne({ collection: 'guided-steps', where: { key: { equals: 'k' } }, locale: 'es', data: { site: 'a' }, req: {} })
    expect(seen.length).toBeGreaterThan(0)
    for (const s of seen) expect(s.locale).toBe('es')
  })

  it('refuses at config time when a scope is set and no db is given', async () => {
    await expect(buildConfig({ secret: 's', telemetry: false, collections: [{ slug: 'users', auth: true, fields: [] }], plugins: [wizardsPlugin({ flows, access: { edit: () => true }, media: false, scope: { where: () => ({ site: { equals: 'a' } }) } })] } as never)).rejects.toThrow(/needs `db` set before this plugin/)
  })
})
