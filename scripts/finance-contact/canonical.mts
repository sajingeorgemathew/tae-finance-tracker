/**
 * FINANCE-CONTACT-04B1 — the program-independent contact row.
 *
 * Every master roster workbook, whatever its layout, is reduced to rows of
 * this one shape by a source adapter. Everything downstream — scope, identity
 * matching, hosted reconciliation, duplicate and conflict checks, exports —
 * works on `ContactImportRow` and never on a sheet, a heading or a program.
 *
 * The field list is an explicit allowlist. A heading an adapter does not map
 * is recorded by *name* in `ignoredHeadings` and its cells are never read.
 * Sensitive headings (password, date of birth, address, immigration status,
 * placement, documents) are listed in `SENSITIVE_HEADING_PATTERNS` so that a
 * heading matching one of them can never be mapped, even by mistake.
 */

/** A program's short code exactly as `programs.short_code` stores it. */
export type ProgramCode = string

/** The cohort a source table or column states. Never inferred. */
export type SourceSession = 'Morning' | 'Evening' | 'Weekday' | 'Weekend' | (string & {})

export type EmailStatus = 'valid' | 'invalid' | 'missing'

export type PhoneStatus =
  /** Ten NANP digits, or eleven starting with 1; comparison key is +1XXXXXXXXXX. */
  | 'valid_nanp'
  /** Written with an explicit `+` and a non-1 country code; compared as written. */
  | 'international_explicit'
  /** Digits that could be several things (no `+`, not NANP length). Not compared. */
  | 'ambiguous'
  /** Letters, several numbers in one cell, too few digits. Not compared. */
  | 'invalid'
  | 'missing'

/**
 * The staged, program-independent row. One per *source* row: a student listed
 * in two tables produces two canonical rows, each with its own provenance.
 */
export interface ContactImportRow {
  /** Stable id within one audit run: `<program>:<sheet>:<row>`. */
  stagedRowId: string

  sourceWorkbook: string
  sourceSheet: string
  /** The table's own title within the sheet, when the sheet holds several. */
  sourceTable: string | null
  /** 1-based Excel row. */
  sourceRow: number
  programCode: ProgramCode

  /** Exact text after trimming. Leading zeroes kept; never a number. */
  studentNumber: string | null
  studentNumberRaw: string | null

  firstName: string | null
  middleName: string | null
  lastName: string | null
  /** The source's own display name, or the parts joined when it has none. */
  displayName: string | null

  emailRaw: string | null
  emailNormalized: string | null
  emailStatus: EmailStatus

  phoneRaw: string | null
  phoneNormalized: string | null
  phoneStatus: PhoneStatus

  /** The intake as the source labels it, e.g. the table title's date. */
  intakeLabel: string | null
  /** ISO date of the intake when the source states one exactly. */
  intakeDate: string | null
  session: SourceSession | null
  /** A per-row start date, only where the source states it for the row. */
  sourceStartDate: string | null
  /** Enrollment outcome text the source states (e.g. GRADUATED). Never immigration status. */
  sourceStatus: string | null

  inOperationalScope: boolean
  exclusionReason: ScopeExclusion | null
}

export type ScopeExclusion = 'OUT_OF_SCOPE_HISTORICAL' | 'OUT_OF_SCOPE_FUTURE'

/** The canonical fields an adapter may map a heading to. Nothing else is staged. */
export const ALLOWED_FIELDS = [
  'studentNumber',
  'firstName',
  'middleName',
  'lastName',
  'displayName',
  'email',
  'phone',
  'session',
  'sourceStartDate',
  'sourceStatus',
] as const

export type AllowedField = (typeof ALLOWED_FIELDS)[number]

/**
 * Headings that must never be mapped, whatever an adapter says. Matched on
 * the normalized heading (lower case, single spaces). An adapter map that
 * points one of these at a field is a programming error and is rejected.
 */
export const SENSITIVE_HEADING_PATTERNS: readonly RegExp[] = [
  /pass\s*word/,
  /\bpwd\b/,
  /\bpin\b/,
  /d\.?\s*o\.?\s*b\b/,
  /date of birth/,
  /yyyy\/mm\/dd/,
  /\bbirth/,
  /address/,
  /\bsin\b/,
  /social insurance/,
  /bank/,
  /\bwp\b/,
  /permit/,
  /visa/,
  /immigration/,
  /citizen/,
  /refugee/,
  /placement/,
  /venue/,
  /transcript/,
  /college cert/,
  /\bnacc\b/,
  /doc status/,
  /medical/,
  /login/,
  /credential/,
]

/** True when a normalized heading names something the allowlist forbids. */
export function isSensitiveHeading(normalizedHeading: string): boolean {
  return SENSITIVE_HEADING_PATTERNS.some((pattern) => pattern.test(normalizedHeading))
}

/** Lower case, punctuation collapsed to spaces, single spaces, trimmed. */
export function normalizeHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9/&.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// -----------------------------------------------------------------------------
// Classification vocabulary
// -----------------------------------------------------------------------------

export const PRIMARY_CATEGORIES = [
  'EXACT_UNCHANGED',
  'SAFE_CONTACT_FILL',
  'CONTACT_DIFFERENCE',
  'SOURCE_MISSING_CONTACT',
  'SOURCE_INVALID_CONTACT',
  'STUDENT_NOT_IN_APP',
  'MISSING_STUDENT_NUMBER',
  'DUPLICATE_SOURCE_STUDENT_NUMBER',
  'DUPLICATE_HOSTED_STUDENT_NUMBER',
  'OUT_OF_SCOPE_HISTORICAL',
  'OUT_OF_SCOPE_FUTURE',
] as const

export type PrimaryCategory = (typeof PRIMARY_CATEGORIES)[number]

export const FLAGS = [
  'EXACT_UNCHANGED',
  'SAFE_CONTACT_FILL',
  'SAFE_EMAIL_FILL',
  'SAFE_PHONE_FILL',
  'CONTACT_DIFFERENCE',
  'EMAIL_DIFFERENCE',
  'PHONE_DIFFERENCE',
  'NAME_DIFFERENCE',
  'SOURCE_MISSING_EMAIL',
  'SOURCE_MISSING_PHONE',
  'SOURCE_INVALID_EMAIL',
  'SOURCE_INVALID_PHONE',
  'SOURCE_AMBIGUOUS_PHONE',
  'STUDENT_NOT_IN_APP',
  'MISSING_STUDENT_NUMBER',
  'STUDENT_NUMBER_NOT_DIGITS',
  'DUPLICATE_SOURCE_STUDENT_NUMBER',
  'DUPLICATE_SOURCE_CONFLICTING_CONTACT',
  'DUPLICATE_HOSTED_STUDENT_NUMBER',
  'SHARED_SOURCE_EMAIL',
  'SHARED_SOURCE_PHONE',
  'OUT_OF_SCOPE_HISTORICAL',
  'OUT_OF_SCOPE_FUTURE',
  'SCOPE_DATE_UNKNOWN',
  'SUBSET_ROW',
] as const

export type Flag = (typeof FLAGS)[number]

export const INTAKE_CATEGORIES = [
  'MATCHES_HOSTED_INTAKE',
  'DIFFERENT_HOSTED_INTAKE',
  'HOSTED_UNASSIGNED',
  'SOURCE_INTAKE_NOT_MAPPED',
  'NO_FINANCE_RECORD',
  'NOT_APPLICABLE',
] as const

export type IntakeCategory = (typeof INTAKE_CATEGORIES)[number]
