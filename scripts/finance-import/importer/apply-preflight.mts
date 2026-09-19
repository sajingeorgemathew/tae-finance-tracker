/**
 * The apply's safety gate.
 *
 * Everything that must be true before a single historical finance row is
 * written, checked in one place and reported as a list rather than as the first
 * thing that happened to fail. A reviewer reading the output sees the whole
 * state of the gate, not one blocker at a time.
 *
 * The baseline counts below are the figures reviewed and approved after Phase
 * B1. They are **not** the source of the import — the plan is regenerated from
 * the workbook on every run, and these are what it is compared against. A
 * regenerated count that differs from its baseline stops the apply and is
 * reported as a named difference, which is the point: the numbers are a
 * tripwire, not an input.
 */

import type { DryRunPlan } from './plan.mts'
import type { PriorImportCheck, TableCounts } from './supabase-readonly.mts'

/** The workbook this phase is approved for. A different file is a different job. */
export const APPROVED_WORKBOOK_SHA256 =
  '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2'

/**
 * Counts reviewed and approved at the end of Phase B1.
 *
 * Compared against, never written from.
 */
export const REVIEWED_BASELINE = {
  batches: 23,
  pswBatches: 22,
  eceaBatches: 1,
  numberedStudents: 378,
  unresolvedStudents: 7,
  totalStudents: 385,
  financeRecords: 397,
  payments: 1013,
  importExceptions: 1,
  trackerMasterTransactionRows: 1014,
  pswInstallments: 1825,
  eceaInstallments: 0,
  frenchRowsDeferred: 3,
} as const

/**
 * The migrations that must be applied before the apply runs.
 *
 * Verified structurally — by the columns and tables they create — rather than
 * by a version table, because the project is not linked to the hosted Supabase
 * project and migrations are applied by hand. What matters is that the schema
 * is there, not that a ledger says it is.
 */
export const REQUIRED_MIGRATIONS = [
  '20260917143000_finance_foundation',
  '20260917150000_initial_program_configuration',
  '20260918120000_legacy_raw_json',
  '20260918130000_import_exceptions',
] as const

/** Tables that must be empty before a first import. */
export const MUST_BE_EMPTY_BEFORE_APPLY = [
  'batches',
  'students',
  'student_finance_records',
  'installments',
  'payments',
  'receipts',
  'receipt_deliveries',
  'import_exceptions',
] as const

export interface GateCheck {
  name: string
  detail: string
  passed: boolean
}

export interface PreflightResult {
  passed: boolean
  checks: GateCheck[]
  blockers: string[]
}

function gate(checks: GateCheck[], name: string, passed: boolean, detail: string): void {
  checks.push({ name, detail, passed })
}

export interface PreflightInputs {
  plan: DryRunPlan
  /** SHA-256 of the workbook, re-read from disk. */
  workbookSha256: string
  branch: string
  gitStatusLines: string[]
  /** Structural schema probe: column/table -> present. */
  schemaPresence: Record<string, boolean>
  countsBefore: TableCounts
  priorImport: PriorImportCheck
}

/**
 * Runs every gate. Returns the whole list, passed or not.
 *
 * Nothing here writes, and nothing here can be overridden by a flag: there is
 * deliberately no `--force`. A gate that should not apply is a gate that should
 * be changed in review, not bypassed at the command line.
 */
export function runPreflight(inputs: PreflightInputs): PreflightResult {
  const { plan, workbookSha256, branch, schemaPresence, countsBefore, priorImport } = inputs
  const checks: GateCheck[] = []
  const counts = plan.counts

  // --- 1. Branch -------------------------------------------------------------
  gate(
    checks,
    'branch is feature/finance-import-02',
    branch === 'feature/finance-import-02',
    branch,
  )

  // --- 2. Working tree -------------------------------------------------------
  // Reported, not enforced: this phase legitimately runs with the importer
  // uncommitted, and refusing to apply over a dirty tree would refuse the
  // normal case. What matters is that the reviewer sees it.
  gate(
    checks,
    'git working tree state recorded',
    true,
    inputs.gitStatusLines.length === 0
      ? 'clean'
      : `${inputs.gitStatusLines.length} changed/untracked path(s); recorded for review`,
  )

  // --- 3. Workbook hash ------------------------------------------------------
  gate(
    checks,
    'workbook SHA-256 matches the approved file',
    workbookSha256 === APPROVED_WORKBOOK_SHA256,
    workbookSha256 === APPROVED_WORKBOOK_SHA256 ? workbookSha256 : `got ${workbookSha256}`,
  )
  gate(
    checks,
    'the plan was built from that same file',
    plan.fingerprint.sha256 === APPROVED_WORKBOOK_SHA256,
    plan.fingerprint.sha256,
  )

  // --- 4 & 5. Migrations, verified structurally ------------------------------
  const missingSchema = Object.entries(schemaPresence)
    .filter(([, present]) => !present)
    .map(([name]) => name)
  gate(
    checks,
    `hosted schema carries all ${REQUIRED_MIGRATIONS.length} required migrations`,
    missingSchema.length === 0,
    missingSchema.length === 0
      ? REQUIRED_MIGRATIONS.join(', ')
      : `missing: ${missingSchema.join(', ')}`,
  )

  // --- 6 & 7. Dry run --------------------------------------------------------
  gate(checks, 'READY_FOR_APPLY', plan.readiness.ready, plan.readiness.ready ? 'true' : `false — ${plan.readiness.blockers.join('; ')}`)
  gate(
    checks,
    'plan has no invariant violations',
    plan.invariantViolations.length === 0,
    plan.invariantViolations.length === 0 ? 'none' : plan.invariantViolations.join('; '),
  )

  // --- 8. French deferred ----------------------------------------------------
  const french = plan.deferred.find((sheet) => sheet.sheetName === 'French')
  gate(
    checks,
    'French remains deferred',
    french !== undefined && counts.frenchRowsDeferred === REVIEWED_BASELINE.frenchRowsDeferred,
    `${counts.frenchRowsDeferred} meaningful row(s) deferred; no French program, batch, student, record, payment or installment is planned`,
  )

  // --- 9. Operational tables empty ------------------------------------------
  const nonEmpty = MUST_BE_EMPTY_BEFORE_APPLY.filter((table) => (countsBefore[table] ?? 0) > 0)
  gate(
    checks,
    'operational historical-import tables are empty',
    nonEmpty.length === 0,
    nonEmpty.length === 0
      ? 'all empty'
      : `not empty: ${nonEmpty.map((table) => `${table}=${countsBefore[table]}`).join(', ')}`,
  )

  // --- 10. No completed import of this workbook -----------------------------
  gate(
    checks,
    'no completed import of this workbook hash',
    priorImport.checked && !priorImport.alreadyImported,
    priorImport.note,
  )

  // --- 2. Regenerated plan vs. the reviewed baseline ------------------------
  const comparisons: [string, number, number][] = [
    ['batches', REVIEWED_BASELINE.batches, counts.batches],
    ['PSW batches', REVIEWED_BASELINE.pswBatches, counts.batchesByProgram.PSW ?? 0],
    ['ECEA batches', REVIEWED_BASELINE.eceaBatches, counts.batchesByProgram.ECEA ?? 0],
    ['numbered students', REVIEWED_BASELINE.numberedStudents, counts.students],
    ['unresolved students', REVIEWED_BASELINE.unresolvedStudents, counts.unresolvedStudents],
    ['total student rows', REVIEWED_BASELINE.totalStudents, counts.students + counts.unresolvedStudents],
    ['student finance records', REVIEWED_BASELINE.financeRecords, counts.financeRecords],
    ['payments', REVIEWED_BASELINE.payments, counts.paymentsPlanned],
    ['import exceptions', REVIEWED_BASELINE.importExceptions, counts.importExceptions],
    ['Tracker Master transaction rows', REVIEWED_BASELINE.trackerMasterTransactionRows, counts.payments],
    ['PSW installments', REVIEWED_BASELINE.pswInstallments, counts.installmentsByProgram.PSW ?? 0],
    ['ECEA installments', REVIEWED_BASELINE.eceaInstallments, counts.installmentsByProgram.ECEA ?? 0],
    ['French rows deferred', REVIEWED_BASELINE.frenchRowsDeferred, counts.frenchRowsDeferred],
  ]

  for (const [name, expected, actual] of comparisons) {
    gate(
      checks,
      `regenerated ${name} matches the reviewed baseline`,
      expected === actual,
      expected === actual ? `${actual}` : `baseline ${expected}, regenerated ${actual}`,
    )
  }

  // --- Conservation, before anything is written -----------------------------
  gate(
    checks,
    'payments + exceptions account for every Tracker Master transaction row',
    counts.paymentsPlanned + counts.importExceptions === counts.payments,
    `${counts.paymentsPlanned} + ${counts.importExceptions} = ${counts.paymentsPlanned + counts.importExceptions} of ${counts.payments}`,
  )

  const blockers = checks.filter((entry) => !entry.passed).map((entry) => `${entry.name}: ${entry.detail}`)

  return { passed: blockers.length === 0, checks, blockers }
}
