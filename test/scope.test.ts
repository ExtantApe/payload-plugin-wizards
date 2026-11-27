import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { configToSchema } from '@payloadcms/graphql'
import { createRequire } from 'node:module'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, createLocalReq, getPayload, handleEndpoints, type Config, type Payload } from 'payload'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { answersFor, flowSteps, wizardsPlugin, type Answer } from '../src/index.js'

// The schema builder loads graphql as CommonJS, so the test must too: two copies of the library refuse to work together.
const { graphql } = createRequire(import.meta.url)('graphql') as typeof import('graphql')

// Two made-up sites share one steps collection. The host adds the `site` field itself.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let scoped: Payload
let open: Payload
let mongo: MongoMemoryReplSet
const uploads = mkdtempSync(join(tmpdir(), 'wizards-scope-media-'))
const flows = { 'kit-activation': { slots: [{ steps: 'safety' }] }, 'check-in': { slots: [{ steps: 'arrival' }] } }

// The scope hook the tests can bend: the default reads the caller's site.
let hook: (req: { user?: { site?: string } | null }) => unknown = (req) => ({ site: { equals: req.user?.site } })

const siteField = (c: Config): Config => ({
  ...c,
  collections: (c.collections ?? []).map((x) => (x.slug === 'guided-steps' ? { ...x, fields: [...x.fields, { name: 'site', type: 'text' as const, required: true, index: true }] } : x)),
})

const config = (db: string, scope: boolean, indexWith?: string[]) =>
  buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri(db), ensureIndexes: true }),
    collections: [
      { slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }, { name: 'site', type: 'text' }] },
      { slug: 'media', upload: { staticDir: uploads }, access: { read: () => true, create: () => true }, fields: [] },
    ],
    plugins: [
      wizardsPlugin({
        flows,
        access: { edit: ({ req }) => (req.user as { role?: string } | null)?.role === 'editor' },
        ...(scope ? { scope: { where: ({ req }) => hook(req as never) as never, ...(indexWith ? { indexWith } : {}) } } : {}),
      }),
      siteField,
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
  const res = await handleEndpoints({ config: p.config, request: new Request(`http://localhost:3000/api${path}`, { headers: who ? { Authorization: `JWT ${tokens[who]}` } : {} }) })
  return { status: res.status, body: (await res.json()) as Doc }
}
const gql = async (who: string, query: string) => {
  const { schema } = configToSchema(scoped.config)
  const req = (await reqOf(scoped, who)) as Doc
  req.payloadAPI = 'GraphQL'
  return graphql({ schema, source: query, contextValue: { req } as never })
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  scoped = await getPayload({ key: 'scoped', config: await config('scoped', true, ['site']) })
  open = await getPayload({ key: 'open', config: await config('open', false) })
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
  await mongo?.stop()
  rmSync(uploads, { recursive: true, force: true })
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

  for (const [name, bad] of [['throws', () => { throw new Error('no site') }], ['returns {}', () => ({})], ['returns null', () => null], ['returns an array', () => [{ site: { equals: 'a' } }]]] as const) {
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
    const res = await handleEndpoints({ config: scoped.config, request: new Request(`http://localhost:3000/api/guided-steps/${b!.id}`, { method: 'PATCH', headers: { Authorization: `JWT ${tokens.editorA}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'rest takeover' }) }) })
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
    await expect(getPayload({ key: 'scope-dup', config: await buildConfig({ secret: 's', telemetry: false, typescript: { autoGenerate: false }, db: mongooseAdapter({ url: mongo.getUri('scope-dup') }), collections: [{ slug: 'users', auth: true, fields: [] }], plugins: [wizardsPlugin({ flows: { f: { slots: [{ code: 'x' }] } }, access: { edit: () => true }, media: false, scope: { where: () => ({ site: { equals: 'a' } }) } }), twice] }) } as never)).rejects.toThrow(/registered by both/)
  })
})

describe('indexWith', () => {
  it('lets two sites share a key and still refuses a repeat on the same site', async () => {
    await expect(make(scoped, 'editorA', { site: 'a', key: 'wash', question: 'again' })).rejects.toThrow()
    expect((await scoped.count({ collection: 'guided-steps' as never, where: { key: { equals: 'wash' } } as never, overrideAccess: true })).totalDocs).toBe(2)
  })
})
