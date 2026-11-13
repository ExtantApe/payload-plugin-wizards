'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Answer, Step } from '../types.js'

/** One screen of the flow, as the server's flowSteps() returns it. */
export type WizardSlot = { code: string } | { step: Step }

/** What a code step's renderer gets. */
export type CodeStepContext = {
  /** Store `value` under `values[code]` (when given) and go to the next screen. */
  next: (value?: unknown) => void
  /** Go to the previous screen. Does nothing on the first. */
  back: () => void
  values: Record<string, unknown>
  answers: Answer[]
}

export type WizardResult = { answers: Answer[]; values: Record<string, unknown> }

export type WizardLabels = {
  yes: string
  no: string
  next: string
  back: string
  stepOf: (n: number, m: number) => string
  /** Shown when a code slot has no renderer. That's a bug in the site, not something the person can fix. */
  missingCode: (code: string) => string
  /** Shown when onFinish throws or rejects. The buttons come back so the person can try again. */
  finishFailed: string
  /** Visible marker on the option or button chosen earlier, so the choice isn't shown by color alone. */
  chosen: string
}

export type WizardProps = {
  slots: WizardSlot[]
  renderCode: Record<string, (ctx: CodeStepContext) => ReactNode>
  onFinish: (result: WizardResult) => void | Promise<void>
  labels?: Partial<WizardLabels>
}

export const defaultLabels: WizardLabels = {
  yes: 'Yes',
  no: 'No',
  next: 'Next',
  back: 'Back',
  stepOf: (n, m) => `Step ${n} of ${m}`,
  missingCode: (code) => `This step ("${code}") can't be shown. Please contact the site.`,
  finishFailed: "That didn't go through. Please try again.",
  chosen: '(chosen)',
}

const buttonStyle: CSSProperties = { minHeight: 44, minWidth: 44, padding: '0.5rem 1rem' }

function isCode(slot: WizardSlot): slot is { code: string } {
  return 'code' in slot
}

/**
 * A guided flow, one slot per screen. State lives in memory only: nothing is
 * written to localStorage, sessionStorage or cookies.
 */
export function Wizard({ slots, renderCode, onFinish, labels: labelOverrides, }: WizardProps) {
  const labels: WizardLabels = { ...defaultLabels, ...labelOverrides }
  const baseId = useId()
  const [index, setIndex] = useState(0)
  // Answers keyed by slot index, so Back keeps them and answering again replaces them.
  const [answers, setAnswers] = useState<Record<number, Answer>>({})
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [stopMessage, setStopMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const finishing = useRef(false)
  const focusTarget = useRef<HTMLElement | null>(null)
  const mounted = useRef(false)

  // Move focus to the new screen's heading when the step changes. Not on first
  // render, so the page doesn't jump to the wizard before the person gets there.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    focusTarget.current?.focus()
  }, [index])

  const ordered = (byIndex: Record<number, Answer>): Answer[] =>
    slots.flatMap((slot, i) => (!isCode(slot) && byIndex[i] ? [byIndex[i]] : []))

  const advance = useCallback(
    (nextAnswers: Record<number, Answer>, nextValues: Record<string, unknown>) => {
      setStopMessage('')
      setError('')
      if (index < slots.length - 1) {
        setIndex(index + 1)
        return
      }
      if (finishing.current) return
      finishing.current = true
      setBusy(true)
      const result: WizardResult = {
        answers: slots.flatMap((slot, i) => (!isCode(slot) && nextAnswers[i] ? [nextAnswers[i]] : [])),
        values: nextValues,
      }
      Promise.resolve()
        .then(() => onFinish(result))
        .then(
          () => setDone(true),
          () => {
            finishing.current = false
            setBusy(false)
            setError(labels.finishFailed)
          },
        )
    },
    [index, slots, onFinish, labels.finishFailed],
  )

  const back = useCallback(() => {
    if (busy || done || index === 0) return
    setStopMessage('')
    setError('')
    setIndex(index - 1)
  }, [busy, done, index])

  const record = (step: Step, value: string) => {
    const nextAnswers = { ...answers, [index]: { key: step.key, hash: step.hash, value } }
    setAnswers(nextAnswers)
    advance(nextAnswers, values)
  }

  // No withdraws an earlier Yes on this step: it's no longer shown as chosen, and the flow can't finish with it.
  const stop = (message: string) => {
    setStopMessage(message)
    setAnswers((current) => {
      if (!(index in current)) return current
      const { [index]: _withdrawn, ...rest } = current
      return rest
    })
  }

  if (slots.length === 0) return null
  const slot = slots[index]
  if (!slot) return null

  const disabled = busy || done
  const progressId = `${baseId}-progress`
  const headingId = `${baseId}-heading`
  const progress = labels.stepOf(index + 1, slots.length)

  const backButton =
    index > 0 ? (
      <button type="button" style={buttonStyle} onClick={back} disabled={disabled} className="wizard-back">
        {labels.back}
      </button>
    ) : null

  const liveRegions = (
    <>
      <div role="status" aria-live="polite" className="wizard-stop">
        {stopMessage ? <p>{stopMessage}</p> : null}
      </div>
      <div role="alert" className="wizard-error">
        {error ? <p>{error}</p> : null}
      </div>
    </>
  )

  if (isCode(slot)) {
    const render = renderCode[slot.code]
    const ctx: CodeStepContext = {
      next: (value?: unknown) => {
        if (disabled) return
        const nextValues = value === undefined ? values : { ...values, [slot.code]: value }
        setValues(nextValues)
        advance(answers, nextValues)
      },
      back,
      values,
      answers: ordered(answers),
    }
    return (
      <section
        className="wizard"
        data-slot={slot.code}
        aria-labelledby={progressId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        ref={(el) => {
          focusTarget.current = el
        }}
      >
        <p id={progressId} className="wizard-progress">
          {progress}
        </p>
        {render ? render(ctx) : <p className="wizard-missing">{labels.missingCode(slot.code)}</p>}
        {liveRegions}
        <div className="wizard-nav">{backButton}</div>
      </section>
    )
  }

  const step = slot.step
  const previous = answers[index]?.value

  return (
    <section className="wizard" data-step={step.key} aria-labelledby={headingId} aria-busy={busy || undefined}>
      <p id={progressId} className="wizard-progress">
        {progress}
      </p>
      <h2
        id={headingId}
        tabIndex={-1}
        aria-describedby={progressId}
        ref={(el) => {
          focusTarget.current = el
        }}
      >
        {step.question}
      </h2>
      {step.video ? (
        // Never autoplays; the person starts it. The text version below is always on the page.
        <video controls preload="none" src={step.video.url} className="wizard-video">
          <track kind="captions" default src={step.video.captionsUrl} />
        </video>
      ) : null}
      {step.body ? <p className="wizard-body">{step.body}</p> : null}

      {step.kind === 'gate' ? (
        <div className="wizard-actions" role="group" aria-labelledby={headingId}>
          <button
            type="button"
            style={buttonStyle}
            disabled={disabled}
            aria-pressed={previous === 'yes'}
            onClick={() => record(step, 'yes')}
          >
            {labels.yes}
            {previous === 'yes' ? ` ${labels.chosen}` : null}
          </button>
          <button type="button" style={buttonStyle} disabled={disabled} onClick={() => stop(step.stopMessage)}>
            {labels.no}
          </button>
        </div>
      ) : null}

      {step.kind === 'info' ? (
        <div className="wizard-actions">
          <button type="button" style={buttonStyle} disabled={disabled} onClick={() => record(step, 'seen')}>
            {labels.next}
          </button>
        </div>
      ) : null}

      {step.kind === 'choice' ? (
        <div className="wizard-actions" role="group" aria-labelledby={headingId}>
          {step.options.map((option) => (
            <button
              key={option.value}
              type="button"
              style={buttonStyle}
              disabled={disabled}
              aria-pressed={previous === option.value}
              onClick={() => (option.stops ? stop(step.stopMessage) : record(step, option.value))}
            >
              {option.label}
              {previous === option.value ? ` ${labels.chosen}` : null}
            </button>
          ))}
        </div>
      ) : null}

      {liveRegions}
      <div className="wizard-nav">{backButton}</div>
    </section>
  )
}
