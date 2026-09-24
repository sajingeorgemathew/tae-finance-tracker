/**
 * Comparison forms for contact fields — dry-run only.
 *
 * Nothing here is ever written back. Each function returns a *comparison*
 * value alongside a status, and the raw text survives on the canonical row.
 * The rules are deliberately conservative: nothing is corrected, no domain is
 * guessed, no country is assumed for a number that does not state one.
 */

import type { EmailStatus, PhoneStatus } from './canonical.mts'

// -----------------------------------------------------------------------------
// Student numbers
// -----------------------------------------------------------------------------

/**
 * Trims and preserves. `'  0125  '` -> `'0125'`; `''` -> null.
 *
 * Text semantics are kept on purpose: a student number is an identifier, not
 * a quantity, and `Number('0125')` would silently become a different student.
 */
export function normalizeStudentNumber(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const trimmed = String(raw).replace(/ /g, ' ').trim()
  return trimmed === '' ? null : trimmed
}

/** True when the number is made of digits only, the shape every known program uses. */
export function isDigitsOnly(studentNumber: string): boolean {
  return /^\d+$/.test(studentNumber)
}

// -----------------------------------------------------------------------------
// Email
// -----------------------------------------------------------------------------

/**
 * Basic syntax: one `@`, something on both sides, a dot in the domain, no
 * whitespace. Not RFC 5322; a check that a value is *shaped* like an address
 * so a name typed into the wrong column is not staged as an email.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface NormalizedEmail {
  raw: string | null
  normalized: string | null
  status: EmailStatus
}

export function normalizeEmail(raw: string | null | undefined): NormalizedEmail {
  if (raw === null || raw === undefined) return { raw: null, normalized: null, status: 'missing' }
  const text = String(raw)
  const trimmed = text.replace(/ /g, ' ').trim()
  if (trimmed === '') return { raw: text, normalized: null, status: 'missing' }
  const lowered = trimmed.toLowerCase()
  if (!EMAIL_SHAPE.test(lowered)) return { raw: text, normalized: null, status: 'invalid' }
  return { raw: text, normalized: lowered, status: 'valid' }
}

// -----------------------------------------------------------------------------
// Phone
// -----------------------------------------------------------------------------

export interface NormalizedPhone {
  raw: string | null
  /** `+1XXXXXXXXXX` for a NANP number, `+<digits>` for an explicit international one. */
  normalized: string | null
  status: PhoneStatus
  /** Why a value was not accepted, for the private report. */
  note: string | null
}

/** Presentation characters a phone number is commonly written with. */
const PRESENTATION = /[\s().\- ]/g

/**
 * A North American number: area code and exchange each start 2–9.
 * This is the documented rule for deriving `+1XXXXXXXXXX`.
 */
function isNanp(tenDigits: string): boolean {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(tenDigits)
}

export function normalizePhone(raw: string | null | undefined): NormalizedPhone {
  if (raw === null || raw === undefined) return { raw: null, normalized: null, status: 'missing', note: null }
  const text = String(raw)
  const trimmed = text.replace(/ /g, ' ').trim()
  if (trimmed === '') return { raw: text, normalized: null, status: 'missing', note: null }

  // Several numbers in one cell are not one phone number.
  if (/[/,;]|\bor\b|\band\b/i.test(trimmed)) {
    return { raw: text, normalized: null, status: 'invalid', note: 'several values in one cell' }
  }

  const stripped = trimmed.replace(PRESENTATION, '')
  const explicitPlus = stripped.startsWith('+')
  const digits = explicitPlus ? stripped.slice(1) : stripped

  if (!/^\d+$/.test(digits)) {
    return { raw: text, normalized: null, status: 'invalid', note: 'contains non-digit characters' }
  }

  if (explicitPlus) {
    if (digits.length === 11 && digits.startsWith('1') && isNanp(digits.slice(1))) {
      return { raw: text, normalized: `+${digits}`, status: 'valid_nanp', note: null }
    }
    if (digits.length >= 8 && digits.length <= 15 && !digits.startsWith('1')) {
      return { raw: text, normalized: `+${digits}`, status: 'international_explicit', note: null }
    }
    return { raw: text, normalized: null, status: 'invalid', note: 'explicit country code but not a valid length' }
  }

  if (digits.length === 10 && isNanp(digits)) {
    return { raw: text, normalized: `+1${digits}`, status: 'valid_nanp', note: null }
  }
  if (digits.length === 11 && digits.startsWith('1') && isNanp(digits.slice(1))) {
    return { raw: text, normalized: `+${digits}`, status: 'valid_nanp', note: null }
  }
  if (digits.length < 10) {
    return { raw: text, normalized: null, status: 'invalid', note: `${digits.length} digits, fewer than a complete number` }
  }
  // 10 digits that fail the NANP shape, or 11+ digits with no `+`: the
  // country is not stated and is not assumed.
  return { raw: text, normalized: null, status: 'ambiguous', note: `${digits.length} digits without a country code` }
}

// -----------------------------------------------------------------------------
// Names
// -----------------------------------------------------------------------------

/** Trims; keeps spelling and case exactly. Empty becomes null. */
export function cleanNamePart(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const trimmed = String(raw).replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
  return trimmed === '' ? null : trimmed
}

/** The parts joined with single spaces, or null when every part is blank. */
export function joinNameParts(...parts: (string | null | undefined)[]): string | null {
  const cleaned = parts.map(cleanNamePart).filter((part): part is string => part !== null)
  return cleaned.length === 0 ? null : cleaned.join(' ')
}

/**
 * A comparison form for names: lower case, single spaces, punctuation that is
 * only presentation removed. Used to *report* differences, never to match
 * identities.
 */
export function nameComparisonKey(value: string | null | undefined): string | null {
  const cleaned = cleanNamePart(value)
  if (cleaned === null) return null
  return cleaned
    .toLowerCase()
    .replace(/[.,'`’"-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
