import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { buildConfig, getPayload, type Config, type Payload } from 'payload'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hasText } from '../src/blank.js'
import { answersFor, contentHash, flowSteps, wizardsPlugin, type Answer } from '../src/index.js'

// Made-up steps on throwaway SQLite files, in two languages. Each site has its own collection slug, so the schemas
// don't collide in one process.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const dir = mkdtempSync(join(tmpdir(), 'wizards-blank-'))
const started: Payload[] = []
let off: Payload
let on: Payload
let drafts: Payload

// A host hook that runs after the plugin's own checks and can change the text being saved, as a later plugin or an
// import might. Off unless a test sets it.
let override: ((data: Doc) => Doc) | null = null
const lateHook = (c: Config): Config => ({ ...c, collections: (c.collections ?? []).map((x) => (x.slug.startsWith('steps-') ? { ...x, hooks: { ...x.hooks, beforeChange: [...(x.hooks?.beforeChange ?? []), ({ data }) => (override ? override(data) : data)] } } : x)) })

const site = async (name: string, fallback: boolean, extra?: (c: Config) => Config) => {
  const slug = `steps-${name}`
  const p = await getPayload({
    key: `blank-${name}`,
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      localization: { locales: ['en', 'es'], defaultLocale: 'en', fallback },
      db: sqliteAdapter({ client: { url: `file:${join(dir, `${name}.db`)}` } }),
      collections: [{ slug: 'users', auth: true, fields: [] }],
      plugins: [wizardsPlugin({ slug, flows: { f: { slots: [{ code: 'start' }, { steps: 'g' }] } }, access: { edit: () => true }, media: false }), lateHook, ...(extra ? [extra] : [])],
    }),
  } as never)
  started.push(p)
  return p
}
const slugOf = (p: Payload) => (p.config.custom?.wizards as { slug: string }).slug
const make = (p: Payload, data: Doc, locale = 'en') => p.create({ collection: slugOf(p) as never, locale: locale as never, data: { flow: 'f', group: 'g', kind: 'gate', ...data } as never }) as Promise<Doc>
const edit = (p: Payload, id: unknown, data: Doc, locale: string) => p.update({ collection: slugOf(p) as never, id: id as never, locale: locale as never, data: data as never })
// Saves text past the plugin's save check, as older or imported data might be stored.
const plant = async (p: Payload, id: unknown, change: (data: Doc) => Doc) => {
  override = change
  try {
    await p.update({ collection: slugOf(p) as never, id: id as never, data: {} as never })
  } finally {
    override = null
  }
}
const clear = async (p: Payload) => {
  await p.delete({ collection: slugOf(p) as never, where: { id: { exists: true } } as never })
}
// A yes to every step: the answers a client could post, worked out from what the page was given.
const yesTo = async (p: Payload, locale?: string): Promise<Answer[]> => {
  const { slots } = await flowSteps(p, { flow: 'f', locale })
  return slots.flatMap((s) => ('step' in s ? [{ key: s.step.key, hash: s.step.hash, value: s.step.kind === 'info' ? 'seen' : s.step.kind === 'choice' ? s.step.options.find((o) => !o.stops)!.value : 'yes' }] : []))
}
const stepKeys = async (p: Payload, locale?: string) => (await flowSteps(p, { flow: 'f', locale })).slots.flatMap((s) => ('step' in s ? [s.step.key] : []))

beforeAll(async () => {
  off = await site('off', false)
  on = await site('on', true)
  drafts = await site('drafts', false, (c) => ({ ...c, collections: (c.collections ?? []).map((x) => (x.slug === 'steps-drafts' ? { ...x, versions: { drafts: true } } : x)) }))
}, 120_000)

afterAll(async () => {
  for (const p of started) await p.destroy()
  rmSync(dir, { recursive: true, force: true })
})

describe('a step with a blank question or stop message is refused', () => {
  it('refuses a gate with no text in the reader’s language when fallback is off, and passes the language that has it', async () => {
    await clear(off)
    await make(off, { key: 'a', question: 'Is the lid on?', body: 'Check the lid.', stopMessage: 'Put the lid on first.' })
    expect(await stepKeys(off, 'en')).toEqual(['a'])
    expect((await answersFor(off, { flow: 'f', locale: 'en', answers: await yesTo(off, 'en') })).ok).toBe(true) // the control

    const es = await flowSteps(off, { flow: 'f', locale: 'es' })
    expect(es.slots.flatMap((s) => ('step' in s ? [s.step] : []))).toEqual([])
    expect(es.blank).toEqual(['a'])
    // A yes worked out from the blank wording, as a client could post it, is still refused.
    const forged = [{ key: 'a', hash: contentHash({ kind: 'gate' }), value: 'yes' }]
    expect(await answersFor(off, { flow: 'f', locale: 'es', answers: forged })).toMatchObject({ ok: false, problem: 'blankStep', key: 'a' })
    expect(await answersFor(off, { flow: 'f', locale: 'es', answers: [] })).toMatchObject({ ok: false, problem: 'blankStep', key: 'a' })
  })

  it('refuses a locale with no text of its own, and the all-locales read', async () => {
    await clear(off)
    await make(off, { key: 'a', question: 'Is the lid on?', stopMessage: 'Put the lid on first.' })
    for (const locale of ['xx', 'all']) {
      expect((await flowSteps(off, { flow: 'f', locale })).blank, locale).toEqual(['a'])
      expect(await answersFor(off, { flow: 'f', locale, answers: [{ key: 'a', hash: 'x', value: 'yes' }] }), locale).toMatchObject({ ok: false, problem: 'blankStep' })
    }
  })

  it('with fallback on, shows the default language’s text for a missing translation and records it as read', async () => {
    await clear(on)
    await make(on, { key: 'a', question: 'Is the lid on?', stopMessage: 'Put the lid on first.' })
    const r = await answersFor(on, { flow: 'f', locale: 'es', answers: await yesTo(on, 'es') })
    expect(r.ok && r.record.answers.map((a) => a.question)).toEqual(['Is the lid on?'])
  })

  it('refuses to save a question or option label that is only spaces, in any language', async () => {
    await clear(on)
    await expect(make(on, { key: 'w', question: '  \n\t', stopMessage: 'Stop.' })).rejects.toThrow(/question/)
    const d = await make(on, { key: 'a', question: 'Is the lid on?', stopMessage: 'Put the lid on first.' })
    await expect(edit(on, d.id, { question: '   ', stopMessage: 'Primero la tapa.' }, 'es')).rejects.toThrow(/question/)
    await expect(edit(on, d.id, { question: '¿Tapa puesta?', stopMessage: '   ' }, 'es')).rejects.toThrow(/stop message/)
    await expect(make(on, { key: 'c', kind: 'choice', question: 'Sealed?', stopMessage: 'Seal it.', options: [{ value: 'y', label: ' ' }, { value: 'n', label: 'No', stops: true }] })).rejects.toThrow(/option/)
  })

  it('refuses at read time, on the view and every answer, blank text that reached the database another way', async () => {
    await clear(on)
    const cases: [string, Doc, Doc][] = [
      ['spaces-only question', { kind: 'gate', question: 'Q?', stopMessage: 'Stop.' }, { question: '   ' }],
      ['spaces-only stop message', { kind: 'gate', question: 'Q?', stopMessage: 'Stop.' }, { stopMessage: ' \n ' }],
      ['empty stop message on a choice', { kind: 'choice', question: 'Q?', stopMessage: 'Stop.', options: [{ value: 'y', label: 'Yes' }, { value: 'n', label: 'No', stops: true }] }, { stopMessage: '' }],
      ['spaces-only option label', { kind: 'choice', question: 'Q?', stopMessage: 'Stop.', options: [{ value: 'y', label: 'Yes' }, { value: 'n', label: 'No', stops: true }] }, { options: [{ value: 'y', label: '  ' }, { value: 'n', label: 'No', stops: true }] }],
      ['spaces-only info title', { kind: 'info', question: 'How to', body: 'Gently.' }, { question: ' ' }],
    ]
    for (const [label, data, blank] of cases) {
      await clear(on)
      const d = await make(on, { key: 'k', ...data })
      const good = await yesTo(on)
      expect((await answersFor(on, { flow: 'f', answers: good })).ok, `${label}: control`).toBe(true)
      await plant(on, d.id, (x) => ({ ...x, ...blank }))
      expect((await flowSteps(on, { flow: 'f' })).blank, label).toEqual(['k'])
      expect(await stepKeys(on), label).toEqual([])
      expect(await answersFor(on, { flow: 'f', answers: good }), label).toMatchObject({ ok: false, problem: 'blankStep', key: 'k' })
    }
  })

  it('refuses a choice whose option has no label in the reader’s language', async () => {
    await clear(off)
    // Translated as a gate, then turned into a choice in English only: the Spanish option labels are missing.
    const d = await make(off, { key: 'c', question: 'Sealed?', stopMessage: 'Seal it.' })
    await edit(off, d.id, { question: '¿Sellado?', stopMessage: 'Séllalo.' }, 'es')
    await edit(off, d.id, { kind: 'choice', options: [{ value: 'y', label: 'Yes' }, { value: 'n', label: 'No', stops: true }] }, 'en')
    expect((await answersFor(off, { flow: 'f', locale: 'en', answers: await yesTo(off, 'en') })).ok).toBe(true) // the control
    const es = await flowSteps(off, { flow: 'f', locale: 'es' })
    expect([es.slots.flatMap((s) => ('step' in s ? [s.step] : [])), es.blank]).toEqual([[], ['c']])
    expect(await answersFor(off, { flow: 'f', locale: 'es', answers: [{ key: 'c', hash: 'x', value: 'y' }] })).toMatchObject({ ok: false, problem: 'blankStep', key: 'c' })
    // Saving Spanish text while the Spanish labels are still missing is refused.
    await expect(edit(off, d.id, { question: '¿Sellado ya?' }, 'es')).rejects.toThrow(/option/)
  })

  it('lets an info step go without a stop message and any step go without a body', async () => {
    await clear(on)
    await make(on, { key: 'i', kind: 'info', question: 'How to swab' })
    await make(on, { key: 'g', question: 'Swabbed?', stopMessage: 'Swab first.', order: 200 })
    expect((await flowSteps(on, { flow: 'f' })).blank).toEqual([])
    expect((await answersFor(on, { flow: 'f', answers: await yesTo(on) })).ok).toBe(true)
  })

  it('refuses a draft with no question, on save and on read, and the language a published step has no text in', async () => {
    await expect(drafts.create({ collection: 'steps-drafts' as never, draft: true, data: { flow: 'f', group: 'g', key: 'x', kind: 'gate', stopMessage: 'Stop.', _status: 'draft' } as never })).rejects.toThrow(/question/)
    override = (x) => ({ ...x, question: null })
    try {
      await drafts.create({ collection: 'steps-drafts' as never, draft: true, data: { flow: 'f', group: 'g', key: 'd', kind: 'gate', question: 'Draft?', stopMessage: 'Stop.', _status: 'draft' } as never })
    } finally {
      override = null
    }
    await drafts.create({ collection: 'steps-drafts' as never, locale: 'en' as never, data: { flow: 'f', group: 'g', key: 'p', kind: 'gate', question: 'Lid on?', stopMessage: 'Lid first.', _status: 'published' } as never })
    expect((await flowSteps(drafts, { flow: 'f', locale: 'en' })).blank).toEqual(['d'])
    expect(await answersFor(drafts, { flow: 'f', locale: 'en', answers: await yesTo(drafts, 'en') })).toMatchObject({ ok: false, problem: 'blankStep', key: 'd' })
    expect((await flowSteps(drafts, { flow: 'f', locale: 'es' })).blank.sort()).toEqual(['d', 'p'])
  })

  // Characters that draw nothing: zero-width space, joiner and word joiner, soft hyphen, Hangul fillers, braille blank,
  // a direction mark, the Mongolian vowel separator, NUL, a variation selector and a lone combining mark.
  const invisible: [string, string][] = [
    ['U+200B', '​'], ['U+200D', '‍'], ['U+2060', '⁠'], ['U+00AD', '­'], ['U+3164', 'ㅤ'], ['U+2800', '⠀'],
    ['U+200E', '‎'], ['U+180E', '᠎'], ['NUL', '\u0000'], ['U+FE0F', '️'], ['U+0301', '́'], ['U+115F', 'ᅟ'],
    ['U+1160', 'ᅠ'], ['U+FFA0', 'ﾠ'], ['a mix with spaces', ' ​ㅤ ⠀́ '],
  ]
  const visible: [string, string][] = [['emoji only', '😀'], ['an emoji sequence with ZWJ', '👩‍🔬'], ['non-Latin text', '火を消しましたか'], ['text with ZWJ', 'क्‍ष'], ['a question mark only', '?']]

  it('counts only text with a letter, number, punctuation or symbol left after removing invisible characters', () => {
    for (const [label, t] of invisible) expect(hasText(t), label).toBe(false)
    for (const [label, t] of visible) expect(hasText(t), label).toBe(true)
  })

  it('refuses to save a question, stop message or option label made only of invisible characters', async () => {
    await clear(on)
    for (const [label, t] of invisible) {
      await expect(make(on, { key: 'q', question: t, stopMessage: 'Stop.' }), `question ${label}`).rejects.toThrow(/question/)
      await expect(make(on, { key: 's', question: 'Q?', stopMessage: t }), `stop message ${label}`).rejects.toThrow(/stop message/)
      await expect(make(on, { key: 'c', kind: 'choice', question: 'Q?', stopMessage: 'Stop.', options: [{ value: 'y', label: t }, { value: 'n', label: 'No', stops: true }] }), `label ${label}`).rejects.toThrow(/option/)
    }
    expect((await on.find({ collection: slugOf(on) as never, limit: 0, pagination: false })).docs).toEqual([])
  })

  it('refuses on the view and every answer invisible-only text that reached the database another way', async () => {
    const choice = { kind: 'choice', question: 'Q?', stopMessage: 'Stop.', options: [{ value: 'y', label: 'Yes' }, { value: 'n', label: 'No', stops: true }] }
    for (const [label, t] of invisible) {
      for (const [field, blank] of [['question', { question: t }], ['stop message', { stopMessage: t }], ['option label', { options: [{ value: 'y', label: t }, { value: 'n', label: 'No', stops: true }] }]] as const) {
        await clear(on)
        const d = await make(on, { key: 'k', ...choice })
        const good = await yesTo(on)
        await plant(on, d.id, (x) => ({ ...x, ...blank }))
        expect((await flowSteps(on, { flow: 'f' })).blank, `${field} ${label}`).toEqual(['k'])
        expect(await answersFor(on, { flow: 'f', answers: good }), `${field} ${label}`).toMatchObject({ ok: false, problem: 'blankStep', key: 'k' })
      }
    }
  })

  it('saves, shows and passes emoji, non-Latin text and text with a joiner', async () => {
    for (const [label, t] of visible) {
      await clear(on)
      await make(on, { key: 'k', kind: 'choice', question: t, stopMessage: t, options: [{ value: 'y', label: t }, { value: 'n', label: 'No', stops: true }] })
      expect((await flowSteps(on, { flow: 'f' })).blank, label).toEqual([])
      const r = await answersFor(on, { flow: 'f', answers: await yesTo(on) })
      expect(r.ok && r.record.answers[0]!.question, label).toBe(t)
    }
  })

  it('records the default language when the locale given is empty', async () => {
    await clear(on)
    await make(on, { key: 'a', question: 'Is the lid on?', stopMessage: 'Put the lid on first.' })
    const r = await answersFor(on, { flow: 'f', locale: '', answers: await yesTo(on, '') })
    expect(r.ok && r.record.locale).toBe('en')
  })
})
