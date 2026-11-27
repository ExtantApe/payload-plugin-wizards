/** Characters that draw nothing: Unicode's default-ignorable code points, plus the braille blank (U+2800). */
const invisible = /[\p{Default_Ignorable_Code_Point}\u2800]/gu
/** What counts as something to read: a letter, number, punctuation mark or symbol (emoji included). */
const readable = /[\p{L}\p{N}\p{P}\p{S}]/u

/**
 * Text a person must read is there: a string that still has a letter, number, punctuation mark or symbol once the
 * characters that draw nothing are removed. Spaces, control characters and lone combining marks don't count.
 * Anything else counts as blank, including a missing value and an object (such as every language at once).
 */
export const hasText = (v: unknown): v is string => typeof v === 'string' && readable.test(v.replace(invisible, ''))

/**
 * Whether a step, as read in one language, lacks text a person is asked to agree to or be stopped by: the question
 * (the title of an information step), the stop message of a gate or choice, or the label of any option of a choice.
 * Such a step is never shown, answered or recorded.
 */
export const isBlankStep = (s: { kind?: unknown; question?: unknown; stopMessage?: unknown; options?: unknown }): boolean =>
  !hasText(s.question) ||
  (s.kind !== 'info' && !hasText(s.stopMessage)) ||
  (s.kind === 'choice' && !(Array.isArray(s.options) && s.options.every((o) => Boolean(o) && typeof o === 'object' && hasText((o as { label?: unknown }).label))))
