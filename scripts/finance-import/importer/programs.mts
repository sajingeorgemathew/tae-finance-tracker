/**
 * Program identity: the workbook's labels against the database's configuration.
 *
 * The workbook writes `PSW` and `ELCE`. The database is configured with `PSW`
 * and `ECEA`. `ELCE` -> `ECEA` is an approved alias for the *relationship only*:
 * the source text is never rewritten. Every mapped result therefore carries
 * both `sourceLabel` (what the workbook says, verbatim) and `shortCode` (what
 * the database row is keyed on), and the source label is what goes into
 * legacy_raw_json.
 *
 * French is deferred, not mapped and not guessed. There is no French row in
 * `programs`, and `programs` decides how receipt numbers are assembled, so
 * inventing one here would put a permanent wrong value on real receipts. French
 * rows are reported under `deferred_program_configuration` and planned for
 * nothing.
 */

/** A program the database is configured for. Mirrors the configuration migration. */
export interface CanonicalProgram {
  shortCode: string
  name: string
  studentNumberPrefix: string
  receiptCourseCode: string
  receiptCourseSuffix: string
}

/**
 * The two configured programs, as shipped by
 * `supabase/migrations/20260917150000_initial_program_configuration.sql`.
 *
 * Held here so the dry run can report what it would match against without a
 * database connection. The importer matches programs by `short_code`; it never
 * creates one.
 */
export const CANONICAL_PROGRAMS: Record<string, CanonicalProgram> = {
  PSW: {
    shortCode: 'PSW',
    name: 'NACC Personal Support Worker',
    studentNumberPrefix: '125',
    receiptCourseCode: '12500',
    receiptCourseSuffix: '25',
  },
  ECEA: {
    shortCode: 'ECEA',
    name: 'Early Childhood Education Assistant',
    studentNumberPrefix: '121',
    receiptCourseCode: '12100',
    receiptCourseSuffix: '21',
  },
}

/**
 * Workbook label -> canonical short code, matched on the upper-cased, trimmed
 * form. The keys are the labels this workbook actually uses.
 */
const PROGRAM_ALIASES: Record<string, string> = {
  PSW: 'PSW',
  ELCE: 'ECEA',
  ECEA: 'ECEA',
}

/** Labels that are deliberately not imported in this phase. */
const DEFERRED_LABELS: Record<string, string> = {
  FRENCH: 'deferred_program_configuration',
}

export type ProgramResolution =
  | {
      status: 'mapped'
      shortCode: string
      /** The workbook's own spelling, preserved exactly. */
      sourceLabel: string
      /** True when the workbook label differs from the canonical short code. */
      aliased: boolean
    }
  | { status: 'deferred'; sourceLabel: string; reason: string }
  | { status: 'blank' }
  | { status: 'unknown'; sourceLabel: string }

/**
 * Resolves a workbook program label.
 *
 * Matching folds case and trims, because `ELCE ` and `elce` are the same label
 * written carelessly. Nothing else is inferred: an unrecognised label resolves
 * to `unknown` and is reported, never coerced to the nearest program.
 */
export function resolveProgramLabel(label: string | null): ProgramResolution {
  if (label === null || label.trim() === '') return { status: 'blank' }

  const sourceLabel = label
  const matchForm = label.trim().toUpperCase()

  const deferred = DEFERRED_LABELS[matchForm]
  if (deferred !== undefined) return { status: 'deferred', sourceLabel, reason: deferred }

  const shortCode = PROGRAM_ALIASES[matchForm]
  if (shortCode === undefined) return { status: 'unknown', sourceLabel }

  return { status: 'mapped', shortCode, sourceLabel, aliased: shortCode !== matchForm }
}

/**
 * The program a sheet belongs to, from the sheet's own name and table titles.
 *
 * Used for the cohort sheets, which state their program in the sheet name
 * rather than in a column. Returns the same resolution shape as a cell value so
 * callers handle both the same way.
 */
export function resolveSheetProgram(sheetName: string, blockTitle: string | null): ProgramResolution {
  const haystack = `${sheetName} ${blockTitle ?? ''}`

  // Ordered most specific first. French is checked before the others so a sheet
  // that mentions both is deferred rather than imported.
  if (/\bfrench\b/i.test(haystack)) {
    return { status: 'deferred', sourceLabel: 'French', reason: DEFERRED_LABELS.FRENCH }
  }
  if (/\belce\b/i.test(haystack)) return resolveProgramLabel('ELCE')
  if (/\becea\b/i.test(haystack)) return resolveProgramLabel('ECEA')
  if (/\bpsw\b/i.test(haystack)) return resolveProgramLabel('PSW')

  return { status: 'unknown', sourceLabel: sheetName }
}
