import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Config, type Payload } from 'payload'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { answersFor, contentHash, flowSteps, wizardsPlugin, type Answer, type FlowRegistration } from '../src/index.js'

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
          flows: { 'kit-activation': { slots: [{ code: 'find-kit' }, { steps: 'safety' }, { code: 'sampled' }] }, 'nobody-home': { slots: [{ steps: 'not-seeded' }] } },
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
    for (const change of [{ question: 'q2' }, { body: 'b2' }, { stopMessage: 's2' }, { options: [{ value: 'y', label: 'Yes' }, { value: 'n', label: 'No' }] }, { video: { id: 'v2', updatedAt: 't1' } }, { video: { id: 'v1', updatedAt: 't2' } }, { captions: { id: 'c2', updatedAt: 't1' } }, { video: null }])
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
