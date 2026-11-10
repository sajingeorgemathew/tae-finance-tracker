/**
 * FINANCE-CUTOVER-05A — what the cutover is bound to.
 *
 * Every value a reviewer approved lives here and nowhere else: the exact
 * replacement workbook, the hosted pre-state the plan was computed against,
 * the launch cohorts, and where private output goes. A change to any of them
 * changes the cutover-plan hash, so an approved plan cannot drift silently.
 *
 * Cohorts are declared by program and month, never by sheet name. A sheet is
 * recognised as a cohort by its own structure (see `parse.mts`), and the month
 * is read from the sheet name first and the table title second — the same
 * reading the intake UI and the contact adapters already use.
 */

export const TICKET = 'FINANCE-CUTOVER-05A'

/** Private output, never tracked (`.private/` is ignored). */
export const PRIVATE_DIR = '.private/finance-cutover-05a'

export const BACKUP_FILE = 'hosted-backup.json'
export const BACKUP_MANIFEST_FILE = 'hosted-backup-manifest.json'
export const TARGET_FILE = 'target-dataset.json'
export const PLAN_FILE = 'cutover-plan.json'
export const ANALYSIS_FILE = 'cutover-analysis.json'
export const AGGREGATE_FILE = 'cutover-aggregate.md'
export const SQL_FILE = 'cutover-apply.sql'
/** The restore is staged; this manifest lists its files in order, with their hashes. */
export const RESTORE_FILE = 'restore-manifest.json'
export const RESTORE_DIR = 'restore'
export const BALANCE_POPULATION_FILE = 'balance-population.json'
export const DATED_PAYMENTS_FILE = 'dated-payment-reconciliation.json'

/** The replacement finance workbook (`reference/finance-tracker.xlsx.xlsx`). */
export const EXPECTED_WORKBOOK_SHA256 =
  '0d32527990b140d7ab587ee53841e27df87fbff50da4b09b28a9e278376a2dfe'

/** The historical workbook FINANCE-IMPORT-02 loaded. Superseded; recorded for provenance only. */
export const SUPERSEDED_WORKBOOK_SHA256 =
  '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2'

/**
 * The tables a backup must hold, in foreign-key dependency order (parents
 * first). `profiles` is deliberately absent: it is account data, not finance
 * data, and the cutover neither reads nor writes it.
 */
export const BACKUP_TABLES = [
  'programs',
  'batches',
  'students',
  'student_finance_records',
  'installments',
  'payments',
  'receipts',
  'receipt_deliveries',
  'reminder_deliveries',
  'import_batches',
  'import_exceptions',
  'batch_finance_columns',
  'audit_log',
] as const

export type BackupTable = (typeof BACKUP_TABLES)[number]

/**
 * The hosted pre-state the ticket was written against.
 *
 * The dry run reports the live values beside these; the apply refuses unless
 * the live state still equals the fingerprint recorded in the plan.
 */
export const EXPECTED_BASELINE: Record<BackupTable, number> & {
  students_email_non_null: number
  students_phone_non_null: number
} = {
  programs: 2,
  batches: 23,
  students: 385,
  student_finance_records: 397,
  installments: 1825,
  payments: 1013,
  receipts: 0,
  receipt_deliveries: 0,
  reminder_deliveries: 0,
  import_batches: 1,
  import_exceptions: 1,
  batch_finance_columns: 383,
  audit_log: 0,
  students_email_non_null: 0,
  students_phone_non_null: 0,
}

/**
 * The row-count baseline the narrowed launch is gated on, re-read from hosted
 * on 2026-11-02 (identical to the 2026-10-21 baseline: hosted has not changed).
 * The launch apply needs BOTH these counts AND the exact pre-state
 * fingerprint recorded in its plan.
 */
export const LAUNCH_EXPECTED_BASELINE: typeof EXPECTED_BASELINE = { ...EXPECTED_BASELINE }

export type CohortSource = 'workbook' | 'hosted'

/**
 * How a finance record is collected after the cutover — a generic strategy,
 * not a program-specific flag. These are exactly the values of
 * `student_finance_records.collection_mode`
 * (`20261021120000_finance_record_collection_mode.sql`). Approved per cohort:
 *
 *  * installment — the source has an installment schedule; the amount due is
 *    the schedule through the current calendar month minus what was paid.
 *  * legacy_balance — the payment ledger is known to be incomplete; the
 *    preserved balance snapshot is the collection basis and the old payment
 *    rows are historical evidence only.
 *  * balance — no trustworthy schedule; stated fee minus recorded payments.
 *  * configuration_incomplete — imported, visible, but no automatic reminder
 *    or receipt until the program's finance setup is completed.
 */
export const COLLECTION_MODES = ['installment', 'legacy_balance', 'balance', 'configuration_incomplete'] as const

export type CollectionMode = (typeof COLLECTION_MODES)[number]

export interface CohortDeclaration {
  /** Stable id used in reports and in provenance. */
  id: string
  programShortCode: string
  /** `YYYY-MM` for a dated PSW intake; null for a program-wide roster. */
  yearMonth: string | null
  label: string
  source: CohortSource
  collectionMode: CollectionMode
}

/**
 * The launch scope. March 2026 is not in the replacement workbook, so it is
 * preserved from the hosted, already-reconciled database instead.
 */
export const TARGET_COHORTS: readonly CohortDeclaration[] = [
  { id: 'PSW-2026-03', programShortCode: 'PSW', yearMonth: '2026-03', label: 'PSW March 2026', source: 'hosted', collectionMode: 'legacy_balance' },
  { id: 'PSW-2026-04', programShortCode: 'PSW', yearMonth: '2026-04', label: 'PSW April 2026', source: 'workbook', collectionMode: 'installment' },
  { id: 'PSW-2026-06', programShortCode: 'PSW', yearMonth: '2026-06', label: 'PSW June 2026', source: 'workbook', collectionMode: 'installment' },
  { id: 'PSW-2026-08', programShortCode: 'PSW', yearMonth: '2026-08', label: 'PSW August 2026', source: 'workbook', collectionMode: 'installment' },
  { id: 'PSW-2026-09', programShortCode: 'PSW', yearMonth: '2026-09', label: 'PSW September 2026', source: 'workbook', collectionMode: 'installment' },
  { id: 'ECEA-CURRENT', programShortCode: 'ECEA', yearMonth: null, label: 'ECEA current roster', source: 'workbook', collectionMode: 'balance' },
  { id: 'FRENCH-CURRENT', programShortCode: 'FRENCH', yearMonth: null, label: 'French current roster', source: 'workbook', collectionMode: 'configuration_incomplete' },
]

/**
 * The narrowed first live launch (2026-11-02): PSW June, August and September
 * 2026 only, NON-DESTRUCTIVE outside those cohorts. Every hosted row that is
 * not one of the superseded June/August batch tables (their records,
 * installments, payments and column layout) is retained by id, every hosted
 * student is retained, and no other cohort's row is touched. Morning and
 * Evening stay separate batches.
 */
export const LAUNCH_SCOPE = {
  id: 'PSW-JUN-AUG-SEP-2026',
  cohortIds: ['PSW-2026-06', 'PSW-2026-08', 'PSW-2026-09'],
  /** Private output of the scoped plan, beside (never over) the full plan's files. */
  privateSubdir: 'launch-jas',
} as const

export interface TargetScope {
  id: string
  cohortIds: readonly string[]
  /** True: hosted rows outside the replaced in-scope batches are all retained. */
  preserveOutsideScope: true
}

/**
 * French is a real third program. It is configured generically — a
 * `programs` row and nothing else. The receipt-numbering fields stay NULL:
 * nobody has stated French's student-number prefix or course code, and a
 * guessed value would end up printed on real receipts. That leaves French
 * receipts blocked until an owner configures them, which the readiness report
 * says.
 */
export const FRENCH_PROGRAM = {
  shortCode: 'FRENCH',
  name: 'French',
  studentNumberPrefix: null,
  receiptCourseCode: null,
  receiptCourseSuffix: null,
} as const

/** How a workbook sheet's program is recognised from its own name and titles. */
export const PROGRAM_PATTERNS: readonly { shortCode: string; sourceLabel: string; pattern: RegExp }[] = [
  { shortCode: 'FRENCH', sourceLabel: 'French', pattern: /\bfrench\b/i },
  { shortCode: 'ECEA', sourceLabel: 'ELCE', pattern: /\belce\b/i },
  { shortCode: 'ECEA', sourceLabel: 'ECEA', pattern: /\becea\b/i },
  { shortCode: 'PSW', sourceLabel: 'PSW', pattern: /\bpsw\b/i },
]

/** `import_batches.import_type` for the cutover's own audit row. */
export const IMPORT_TYPE = 'finance_workbook'
