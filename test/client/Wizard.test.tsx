// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Wizard } from '../../src/client/index.js'
import type { WizardSlot } from '../../src/client/index.js'
import type { Step } from '../../src/types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const step = (over: Partial<Step> & { key: string }): Step => ({
  group: 'safety',
  kind: 'gate',
  question: `Question ${over.key}?`,
  body: `Body ${over.key}.`,
  video: null,
  options: [],
  stopMessage: `Stop ${over.key}.`,
  hash: `hash-${over.key}`,
  ...over,
})

const gateA = step({ key: 'a' })
const gateB = step({ key: 'b' })
const info = step({ key: 'i', kind: 'info' })
const choice = step({
  key: 'c',
  kind: 'choice',
  options: [
    { value: 'held', label: 'Still holding it', stops: true },
    { value: 'down', label: 'Put it down', stops: false },
  ],
})

const btn = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) })
const heading = () => screen.getByRole('heading', { level: 2 })

describe('<Wizard>', () => {
  it('shows one question per screen and moves focus to the heading', () => {
    render(<Wizard slots={[{ step: gateA }, { step: gateB }]} renderCode={{}} onFinish={() => {}} />)
    expect(screen.getAllByRole('heading')).toHaveLength(1)
    expect(heading().textContent).toBe('Question a?')
    expect(screen.queryByText('Question b?')).toBeNull()
    expect(heading().getAttribute('tabindex')).toBe('-1')

    fireEvent.click(btn('Yes'))
    expect(screen.getAllByRole('heading')).toHaveLength(1)
    expect(heading().textContent).toBe('Question b?')
    expect(document.activeElement).toBe(heading())
  })

  it('shows "Step N of M" and ties it to the heading', () => {
    render(<Wizard slots={[{ step: gateA }, { step: gateB }, { code: 'x' }]} renderCode={{ x: () => null }} onFinish={() => {}} />)
    const progress = screen.getByText('Step 1 of 3')
    expect(heading().getAttribute('aria-describedby')).toBe(progress.id)
    fireEvent.click(btn('Yes'))
    expect(screen.getByText('Step 2 of 3')).toBeTruthy()
  })

  it('uses translated labels', () => {
    render(
      <Wizard
        slots={[{ step: gateA }]}
        renderCode={{}}
        onFinish={() => {}}
        labels={{ yes: 'Sí', no: 'No', stepOf: (n, m) => `Paso ${n} de ${m}` }}
      />,
    )
    expect(btn('Sí')).toBeTruthy()
    expect(screen.getByText('Paso 1 de 1')).toBeTruthy()
  })

  it('No keeps the step, announces the stop message and records nothing', () => {
    const onFinish = vi.fn()
    render(<Wizard slots={[{ step: gateA }]} renderCode={{}} onFinish={onFinish} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('')
    fireEvent.click(btn('No'))
    expect(heading().textContent).toBe('Question a?')
    expect(status.textContent).toBe('Stop a.')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(onFinish).not.toHaveBeenCalled()
  })

  it('Yes goes on and records the hash', async () => {
    const onFinish = vi.fn()
    render(<Wizard slots={[{ step: gateA }, { step: gateB }]} renderCode={{}} onFinish={onFinish} />)
    fireEvent.click(btn('Yes'))
    expect(heading().textContent).toBe('Question b?')
    await act(async () => {
      fireEvent.click(btn('Yes'))
    })
    expect(onFinish).toHaveBeenCalledWith({
      answers: [
        { key: 'a', hash: 'hash-a', value: 'yes' },
        { key: 'b', hash: 'hash-b', value: 'yes' },
      ],
      values: {},
    })
  })

  it('has no Back on the first step; Back keeps answers and answering again replaces them', async () => {
    const onFinish = vi.fn()
    render(<Wizard slots={[{ step: choice }, { step: gateB }]} renderCode={{}} onFinish={onFinish} />)
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()

    fireEvent.click(btn('Put it down'))
    fireEvent.click(btn('Back'))
    expect(heading().textContent).toBe('Question c?')
    expect(document.activeElement).toBe(heading())
    // The earlier answer is kept, and shown as chosen in text, not only by color.
    expect(btn('Put it down').getAttribute('aria-pressed')).toBe('true')
    expect(btn('Put it down').textContent).toContain('(chosen)')

    fireEvent.click(btn('Put it down'))
    await act(async () => {
      fireEvent.click(btn('Yes'))
    })
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(onFinish.mock.calls[0]![0].answers).toEqual([
      { key: 'c', hash: 'hash-c', value: 'down' },
      { key: 'b', hash: 'hash-b', value: 'yes' },
    ])
  })

  it('No after Back withdraws the earlier Yes: no longer pressed or marked chosen', () => {
    render(<Wizard slots={[{ step: gateA }, { step: gateB }]} renderCode={{}} onFinish={() => {}} />)
    fireEvent.click(btn('Yes'))
    fireEvent.click(btn('Back'))
    expect(btn('Yes').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(btn('No'))
    expect(btn('Yes').getAttribute('aria-pressed')).toBe('false')
    expect(btn('Yes').textContent).not.toContain('(chosen)')
  })

  it('No, or a stopping option, after Back removes the earlier answer from what the flow holds', () => {
    for (const [safety, first, withdraw] of [[gateA, 'Yes', 'No'], [choice, 'Put it down', 'Still holding it']] as const) {
      const seen: unknown[] = []
      render(
        <Wizard
          slots={[{ code: 'look' }, { step: safety }, { step: gateB }]}
          renderCode={{ look: (ctx) => { seen.push(ctx.answers); return <button type="button" onClick={() => ctx.next()}>Go</button> } }}
          onFinish={() => {}}
        />,
      )
      fireEvent.click(btn('Go'))
      fireEvent.click(btn(first))
      fireEvent.click(btn('Back'))
      fireEvent.click(btn(withdraw))
      expect(heading().textContent).toBe(`Question ${safety.key}?`)
      fireEvent.click(btn('Back'))
      expect(seen.at(-1), withdraw).toEqual([])
      cleanup()
    }
  })

  it('changing an answer after Back replaces it rather than adding one', async () => {
    const onFinish = vi.fn()
    const twoOk = step({
      key: 'c2',
      kind: 'choice',
      options: [
        { value: 'one', label: 'One', stops: false },
        { value: 'two', label: 'Two', stops: false },
      ],
    })
    render(<Wizard slots={[{ step: twoOk }, { step: gateB }]} renderCode={{}} onFinish={onFinish} />)
    fireEvent.click(btn('One'))
    fireEvent.click(btn('Back'))
    fireEvent.click(btn('Two'))
    await act(async () => {
      fireEvent.click(btn('Yes'))
    })
    expect(onFinish.mock.calls[0]![0].answers).toEqual([
      { key: 'c2', hash: 'hash-c2', value: 'two' },
      { key: 'b', hash: 'hash-b', value: 'yes' },
    ])
  })

  it('choice: a stopping option stays and announces; a normal option records and goes on', () => {
    render(<Wizard slots={[{ step: choice }, { step: gateB }]} renderCode={{}} onFinish={() => {}} />)
    fireEvent.click(btn('Still holding it'))
    expect(heading().textContent).toBe('Question c?')
    expect(screen.getByRole('status').textContent).toBe('Stop c.')
    fireEvent.click(btn('Put it down'))
    expect(heading().textContent).toBe('Question b?')
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('info: Next records "seen"', async () => {
    const onFinish = vi.fn()
    render(<Wizard slots={[{ step: info }]} renderCode={{}} onFinish={onFinish} />)
    await act(async () => {
      fireEvent.click(btn('Next'))
    })
    expect(onFinish.mock.calls[0]![0].answers).toEqual([{ key: 'i', hash: 'hash-i', value: 'seen' }])
  })

  it('a video has a captions track, controls, and no autoplay; the text stays on the page', () => {
    const withVideo = step({ key: 'v', video: { url: '/v.mp4', captionsUrl: '/v.vtt' } })
    const { container } = render(<Wizard slots={[{ step: withVideo }]} renderCode={{}} onFinish={() => {}} />)
    const video = container.querySelector('video')!
    expect(video).toBeTruthy()
    expect(video.hasAttribute('controls')).toBe(true)
    expect(video.hasAttribute('autoplay')).toBe(false)
    expect(video.autoplay).toBe(false)
    expect(video.getAttribute('preload')).toBe('none')
    const track = video.querySelector('track')!
    expect(track.getAttribute('kind')).toBe('captions')
    expect(track.hasAttribute('default')).toBe(true)
    expect(track.getAttribute('src')).toBe('/v.vtt')
    expect(screen.getByText('Body v.')).toBeTruthy()
  })

  it('without a video, shows the body and no video element', () => {
    const { container } = render(<Wizard slots={[{ step: gateA }]} renderCode={{}} onFinish={() => {}} />)
    expect(container.querySelector('video')).toBeNull()
    expect(screen.getByText('Body a.')).toBeTruthy()
  })

  it("a code slot's ctx.next stores the value; ctx.back goes back", async () => {
    const onFinish = vi.fn()
    const slots: WizardSlot[] = [{ step: gateA }, { code: 'find-kit' }, { step: gateB }]
    const seen: unknown[] = []
    render(
      <Wizard
        slots={slots}
        renderCode={{
          'find-kit': (ctx) => {
            seen.push(ctx.answers)
            return (
              <div>
                <button type="button" onClick={() => ctx.next({ kitId: 'K1' })}>
                  Found it
                </button>
                <button type="button" onClick={ctx.back}>
                  Go back
                </button>
              </div>
            )
          },
        }}
        onFinish={onFinish}
      />,
    )
    fireEvent.click(btn('Yes'))
    expect(seen.at(-1)).toEqual([{ key: 'a', hash: 'hash-a', value: 'yes' }])
    fireEvent.click(btn('Go back'))
    expect(heading().textContent).toBe('Question a?')
    fireEvent.click(btn('Yes'))
    fireEvent.click(btn('Found it'))
    expect(heading().textContent).toBe('Question b?')
    await act(async () => {
      fireEvent.click(btn('Yes'))
    })
    expect(onFinish).toHaveBeenCalledWith({
      answers: [
        { key: 'a', hash: 'hash-a', value: 'yes' },
        { key: 'b', hash: 'hash-b', value: 'yes' },
      ],
      values: { 'find-kit': { kitId: 'K1' } },
    })
  })

  it('a code slot with no renderer shows a message instead of crashing', () => {
    render(<Wizard slots={[{ code: 'nope' }]} renderCode={{}} onFinish={() => {}} />)
    expect(screen.getByText(/can't be shown/)).toBeTruthy()
  })

  it('calls onFinish once, in slot order, with buttons disabled while it runs', async () => {
    let resolve!: () => void
    const onFinish = vi.fn(() => new Promise<void>((r) => (resolve = r)))
    render(<Wizard slots={[{ step: info }, { step: gateA }]} renderCode={{}} onFinish={onFinish} />)
    fireEvent.click(btn('Next'))
    await act(async () => {
      fireEvent.click(btn('Yes'))
    })
    expect(btn('Yes')).toHaveProperty('disabled', true)
    expect(btn('Back')).toHaveProperty('disabled', true)
    fireEvent.click(btn('Yes'))
    await act(async () => resolve())
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(onFinish.mock.calls[0]).toEqual([
      {
        answers: [
          { key: 'i', hash: 'hash-i', value: 'seen' },
          { key: 'a', hash: 'hash-a', value: 'yes' },
        ],
        values: {},
      },
    ])
  })

  it('if onFinish fails, says so and lets the person try again', async () => {
    const onFinish = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(undefined)
    render(<Wizard slots={[{ step: gateA }]} renderCode={{}} onFinish={onFinish} />)
    await act(async () => {
      fireEvent.click(btn('Yes'))
    })
    expect(screen.getByRole('alert').textContent).toMatch(/try again/)
    expect(btn('Yes')).toHaveProperty('disabled', false)
    await act(async () => {
      fireEvent.click(btn('Yes'))
    })
    expect(onFinish).toHaveBeenCalledTimes(2)
  })

  it('every button is type="button" with a visible label and a 44px minimum height', () => {
    render(<Wizard slots={[{ step: gateA }, { step: choice }]} renderCode={{}} onFinish={() => {}} />)
    fireEvent.click(btn('Yes'))
    for (const b of screen.getAllByRole('button')) {
      expect(b.getAttribute('type')).toBe('button')
      expect(b.textContent?.trim()).not.toBe('')
      expect(b.style.minHeight).toBe('44px')
    }
  })

  it('uses no web storage or cookies, and sends nothing itself', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const sent = vi.fn()
    vi.stubGlobal('fetch', sent)
    const beacon = vi.fn()
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })
    const cookieBefore = document.cookie
    render(
      <Wizard
        slots={[{ step: gateA }, { code: 'x' }, { step: choice }]}
        renderCode={{ x: (ctx) => <button type="button" onClick={() => ctx.next(1)}>Go</button> }}
        onFinish={() => {}}
      />,
    )
    fireEvent.click(btn('No'))
    fireEvent.click(btn('Yes'))
    fireEvent.click(btn('Go'))
    await act(async () => {
      fireEvent.click(btn('Put it down'))
    })
    expect(setItem).not.toHaveBeenCalled()
    expect(document.cookie).toBe(cookieBefore)
    // Answers leave the page only through onFinish.
    expect(sent).not.toHaveBeenCalled()
    expect(beacon).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    delete (navigator as { sendBeacon?: unknown }).sendBeacon
  })
})
