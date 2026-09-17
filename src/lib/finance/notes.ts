import { format, isValid, parseISO } from 'date-fns'

import type { ISODate, InstallmentType } from '@/types/finance'

/**
 * Installment and receipt note resolution.
 *
 * Two rules, both deliberately in application code rather than in SQL:
 *
 * 1. An item carries a system-generated `default_note`. Staff may add a
 *    `custom_note`, which overrides it for display. The default is never
 *    overwritten, so the override can always be cleared and the original note
 *    comes back.
 *
 * 2. The effective note is `custom_note ?? default_note`. Read it through
 *    `effectiveNote()` — never read `custom_note` directly for display.
 *
 * Pure functions only: no database access, no `server-only`, so receipt and
 * reminder rendering can reuse them on either side of the wire.
 */

/** Anything carrying the default/override note pair — installments, receipts. */
export interface NotePair {
  default_note: string | null
  custom_note: string | null
}

/**
 * The note to display for an item.
 *
 * A custom note that is empty or only whitespace counts as absent, so clearing
 * the field in a form falls back to the default rather than showing nothing.
 */
export function effectiveNote(item: NotePair): string | null {
  const custom = item.custom_note?.trim()
  if (custom) return custom

  const fallback = item.default_note?.trim()
  return fallback ? fallback : null
}

/** True when staff have overridden the system note with their own. */
export function hasCustomNote(item: NotePair): boolean {
  return Boolean(item.custom_note?.trim())
}

/**
 * The system-generated note for a scheduled item.
 *
 * Month names come from the date itself rather than a hardcoded list, so a
 * schedule is never limited to twelve items. `other` has no sensible default —
 * it returns null and the caller is expected to supply a custom note.
 *
 * Examples:
 *   { type: 'enrollment' }                           -> 'Enrolment fee'
 *   { type: 'monthly', month: '2025-09-01' }         -> 'September installment'
 *   { type: 'monthly' }                              -> 'Monthly installment'
 */
export function defaultNoteFor(input: {
  type: InstallmentType
  month?: ISODate | null
}): string | null {
  switch (input.type) {
    case 'enrollment':
      return 'Enrolment fee'

    case 'monthly': {
      const monthName = formatMonthName(input.month)
      return monthName ? `${monthName} installment` : 'Monthly installment'
    }

    case 'other':
      return null
  }
}

/** `'2025-09-01'` -> `'September'`. Returns null for a missing or unparseable date. */
function formatMonthName(month: ISODate | null | undefined): string | null {
  if (!month) return null

  const parsed = parseISO(month)
  if (!isValid(parsed)) return null

  // 'LLLL' is the standalone month name, which is what reads correctly on its
  // own in a note. 'MMMM' is the formatting-context variant.
  return format(parsed, 'LLLL')
}
