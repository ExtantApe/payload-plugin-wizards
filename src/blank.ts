/**
 * Text a person must read is there: a string with something in it besides spaces. Anything else counts as blank,
 * including a missing value and an object (such as every language at once).
 */
export const hasText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/**
 * Whether a step, as read in one language, lacks text a person is asked to agree to or be stopped by: the question
 * (the title of an information step), the stop message of a gate or choice, or the label of any option of a choice.
 * Such a step is never shown, answered or recorded.
 */
export const isBlankStep = (s: { kind?: unknown; question?: unknown; stopMessage?: unknown; options?: unknown }): boolean =>
  !hasText(s.question) ||
  (s.kind !== 'info' && !hasText(s.stopMessage)) ||
  (s.kind === 'choice' && !(Array.isArray(s.options) && s.options.every((o) => Boolean(o) && typeof o === 'object' && hasText((o as { label?: unknown }).label))))
