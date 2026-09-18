/**
 * Student numbers and names, handled as evidence rather than as keys.
 *
 * Student numbers are TEXT. Some sheets store them as numbers and some as
 * strings — 125213 appears both ways in this workbook — and the moment one is
 * put through a JS number it can lose a leading zero or pick up float noise.
 * Everything here works on the text Excel itself would display.
 *
 * Names are never used to decide that two rows are the same person. The
 * comparison form below exists only so the report can *count* cases worth a
 * human looking at, such as one ID spelled two ways.
 */

import { rawText } from './excel-values.mts'

import type { RawCell } from './excel-values.mts'

/** The program prefixes the database is configured for today. */
export const KNOWN_PREFIXES: Record<string, string> = {
  '125': 'PSW',
  '121': 'ECEA',
}

/** Prefix length used when grouping student numbers. */
const PREFIX_LENGTH = 3

/**
 * A student number exactly as the workbook displays it.
 *
 * Uses Excel's own formatted text for numeric cells so nothing is reformatted
 * on the way in. Returns null when the cell is blank.
 */
export function studentIdText(cell: RawCell | null): string | null {
  const text = rawText(cell)
  if (text === null) return null
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

/** How a student number is stored, which varies between sheets. */
export type StudentIdStorage = 'number' | 'text' | 'other' | 'absent'

export function studentIdStorage(cell: RawCell | null): StudentIdStorage {
  if (!cell || cell.value === undefined || cell.value === null) return 'absent'
  if (cell.type === 'n') return 'number'
  if (cell.type === 's') return 'text'
  return 'other'
}

/**
 * The leading group of a student number, e.g. 125 for both 12506 and 125213.
 *
 * Returns null for anything that does not start with enough digits, which is
 * itself worth reporting rather than coercing.
 */
export function studentIdPrefix(id: string | null): string | null {
  if (id === null) return null
  const digits = id.replace(/\D/g, '')
  if (digits.length < PREFIX_LENGTH) return null
  return digits.slice(0, PREFIX_LENGTH)
}

/** True when the number keeps a leading zero that a numeric read would drop. */
export function hasLeadingZero(id: string | null): boolean {
  return id !== null && /^0\d/.test(id)
}

/**
 * A name reduced to a comparison form: trimmed, inner whitespace collapsed,
 * case folded.
 *
 * This is an exact-match aid for reporting only. It never merges two students:
 * no fuzzy distance, no initial matching, no nickname handling. Two rows that
 * reduce to the same string are *reported* as worth review, not combined.
 */
export function nameComparisonForm(...parts: (string | null)[]): string {
  return parts
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .replace(/ /g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/** A one-way, non-reversible label for a person, for private cross-referencing. */
export function anonymousLabel(index: number): string {
  return `student-${String(index).padStart(4, '0')}`
}
