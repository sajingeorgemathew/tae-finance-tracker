/**
 * FINANCE-IMPORT-02 — historical finance import.
 *
 *   npm run finance:import:dry-run     plan only, writes nothing
 *   npm run finance:import:apply       plan, gate, then write (Phase B2)
 *
 * Reads the historical finance workbook, performs the complete mapping, and
 * writes:
 *
 *   .private/finance-import-analysis/*.json     full detail, Git-ignored
 *   docs/FINANCE-IMPORT-02-DRY-RUN.md           sanitised, committable
 *   docs/FINANCE-IMPORT-02-APPLY.md             sanitised, committable (apply)
 *
 * **Dry run is the default.** Applying requires *both* the `--apply` flag and
 * `FINANCE_IMPORT_APPLY=YES` in the environment. With either absent the script
 * runs the dry run and writes nothing — it does not prompt, and it does not
 * warn and continue. Two independent signals are required because a flag alone
 * is one shell-history arrow-key away from writing historical financial data to
 * production.
 *
 * The confirmation is supplied per invocation. It is deliberately not written
 * to `.env.local` or to source control: a persisted confirmation is not a
 * confirmation.
 *
 * There is no `--force`. A completed import of the same workbook hash is
 * refused, and the way to change that is review, not a flag.
 *
 * Console output is aggregate only. No student name, student number, payer or
 * individual amount is ever logged — that detail exists solely in the private
 * JSON, which is Git-ignored.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { applyPlan } from './importer/apply.mts'
import { renderApplyReport } from './importer/apply-report.mts'
import { APPLY_OPERATOR_VERIFICATION } from './importer/operator-verification.mts'
import { runPreflight } from './importer/apply-preflight.mts'
import { buildDryRunPlan } from './importer/plan.mts'
import { readEnvironment } from './importer/supabase-write.mts'
import { verifyRls } from './importer/rls-verification.mts'
import {
  countOperationalTables,
  diffCounts,
  findPriorImport,
  probeSchema,
} from './importer/supabase-readonly.mts'
import { hashWorkbookOnDisk, WorkbookDiscoveryError, findWorkbookCandidates } from './lib/workbook-source.mts'
import { renderDryRunReport } from './importer/dry-run-report.mts'

import type { ApplyResult } from './importer/apply.mts'
import type { DryRunPlan } from './importer/plan.mts'
import type { RlsVerification } from './importer/rls-verification.mts'

const PRIVATE_DIR = path.join('.private', 'finance-import-analysis')
const REPORT_PATH = path.join('docs', 'FINANCE-IMPORT-02-DRY-RUN.md')
const APPLY_REPORT_PATH = path.join('docs', 'FINANCE-IMPORT-02-APPLY.md')

/** The environment variable that must say YES, alongside `--apply`. */
export const APPLY_ENV_VAR = 'FINANCE_IMPORT_APPLY'
export const APPLY_ENV_VALUE = 'YES'

function writeJson(repoRoot: string, name: string, data: unknown): string {
  const target = path.join(repoRoot, PRIVATE_DIR, name)
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  return path.join(PRIVATE_DIR, name).split(path.sep).join('/')
}

/**
 * Writes the row-level plan to the Git-ignored private directory.
 *
 * These files carry student numbers, names and amounts. They exist so a
 * reviewer can check individual decisions; they must never be committed.
 */
function writePrivateOutputs(repoRoot: string, plan: DryRunPlan): string[] {
  mkdirSync(path.join(repoRoot, PRIVATE_DIR), { recursive: true })

  return [
    writeJson(repoRoot, 'import-dry-run.json', {
      fingerprint: plan.fingerprint,
      sheetNames: plan.sheetNames,
      programs: plan.programs,
      counts: plan.counts,
      readiness: plan.readiness,
      invariantViolations: plan.invariantViolations,
      tables: plan.tables,
      deferred: plan.deferred,
      notImportedSheets: plan.notImportedSheets,
      errorCells: plan.errorCells,
      eceaOrdinalColumnsPreservedAsLegacyOnly: plan.tables
        .filter((entry) => entry.programShortCode === 'ECEA')
        .map((entry) => ({
          sheetName: entry.sheetName,
          tableKey: entry.tableKey,
          normalizedInstallments: entry.installmentCount,
          columnsPreservedInLegacyRawJsonOnly: entry.excludedScheduleColumns,
        })),
    }),
    writeJson(repoRoot, 'import-exceptions.json', {
      plannedImportExceptions: plan.importExceptions,
      missingAmountExceptions: plan.importExceptions.filter(
        (exception) => exception.reason === 'missing_amount',
      ),
      byReason: plan.counts.importExceptionsByReason,
    }),
    writeJson(repoRoot, 'batch-plan.json', {
      batches: plan.batches,
      nameCollisions: plan.batchNameCollisions,
    }),
    writeJson(repoRoot, 'student-plan.json', {
      students: plan.students,
      unresolvedStudents: plan.unresolvedStudents,
      unresolvedBatchStudents: plan.unresolvedStudents.filter(
        (student) => student.unresolvedOrigin === 'batch_table',
      ),
      unresolvedTrackerStudents: plan.unresolvedStudents.filter(
        (student) => student.unresolvedOrigin === 'tracker_master',
      ),
      batchRowsWithoutStudentNumber: plan.batchRowsWithoutStudentNumber,
      nameConflicts: plan.nameConflicts,
    }),
    writeJson(repoRoot, 'finance-record-plan.json', plan.financeRecords),
    writeJson(repoRoot, 'installment-plan.json', plan.installments),
    writeJson(repoRoot, 'payment-routing.json', {
      payments: plan.payments,
      preservedDuplicateCandidates: plan.preservedDuplicateCandidates,
    }),
    writeJson(repoRoot, 'unresolved-records.json', {
      unresolved: plan.unresolved,
      preservedAsImportExceptions: plan.unresolved.filter(
        (row) => row.preservedAs === 'import_exception',
      ),
      withNoDestination: plan.unresolved.filter((row) => row.preservedAs === null),
      totalsRowsExcluded: plan.totalsRowsExcluded,
    }),
  ]
}

export interface ParsedArguments {
  apply: boolean
  unknown: string[]
}

/** Parses argv. `--apply` is one of the two signals an apply needs. */
export function parseArguments(argv: readonly string[]): ParsedArguments {
  const flags = argv.filter((argument) => argument.startsWith('--'))
  return {
    apply: flags.includes('--apply'),
    unknown: flags.filter((flag) => flag !== '--apply'),
  }
}

export interface ApplyGate {
  /** Both signals present: the run may write. */
  authorised: boolean
  flagPresent: boolean
  confirmationPresent: boolean
  reason: string
}

/**
 * Decides whether this invocation may write.
 *
 * Both signals, or neither counts. An `--apply` with no confirmation is not a
 * near-miss to be warned about and continued past; it runs the dry run.
 */
export function resolveApplyGate(
  parsed: ParsedArguments,
  env: Record<string, string | undefined>,
): ApplyGate {
  const flagPresent = parsed.apply
  const confirmationPresent = env[APPLY_ENV_VAR] === APPLY_ENV_VALUE

  if (flagPresent && confirmationPresent) {
    return { authorised: true, flagPresent, confirmationPresent, reason: `--apply and ${APPLY_ENV_VAR}=${APPLY_ENV_VALUE} both present` }
  }
  if (flagPresent) {
    return {
      authorised: false,
      flagPresent,
      confirmationPresent,
      reason: `--apply was given but ${APPLY_ENV_VAR}=${APPLY_ENV_VALUE} is not set; running the dry run instead`,
    }
  }
  if (confirmationPresent) {
    return {
      authorised: false,
      flagPresent,
      confirmationPresent,
      reason: `${APPLY_ENV_VAR}=${APPLY_ENV_VALUE} is set but --apply was not given; running the dry run instead`,
    }
  }
  return { authorised: false, flagPresent, confirmationPresent, reason: 'dry run (the default)' }
}

function gitBranch(repoRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

function gitStatusLines(repoRoot: string): string[] {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot })
      .toString()
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
  } catch {
    return []
  }
}

/** Aggregate console summary of the plan. No row-level detail. */
function printPlanSummary(plan: DryRunPlan): void {
  const { counts, readiness } = plan

  console.log(`Workbook      ${plan.fingerprint.fileName}`)
  console.log(`SHA-256       ${plan.fingerprint.sha256}`)
  console.log(`Sheets        ${plan.sheetNames.length}`)
  console.log('')
  console.log('Planned inserts')
  console.log(`  batches                  ${counts.batches}` +
    `  (PSW ${counts.batchesByProgram.PSW ?? 0}, ECEA ${counts.batchesByProgram.ECEA ?? 0})`)
  console.log(`  students                 ${counts.students}`)
  console.log(`  students (unresolved)    ${counts.unresolvedStudents}` +
    `  (batch ${counts.unresolvedBatchStudents}, tracker ${counts.unresolvedTrackerStudents})`)
  console.log(`  finance records          ${counts.financeRecords}` +
    `  (batch ${counts.financeRecordsBatchSpecific}, unassigned ${counts.financeRecordsUnassigned})`)
  console.log(`  installments             ${counts.installments}` +
    `  (PSW ${counts.installmentsByProgram.PSW ?? 0}, ECEA ${counts.installmentsByProgram.ECEA ?? 0})`)
  console.log(`  payments                 ${counts.paymentsPlanned} of ${counts.payments} source rows`)
  console.log(`  import exceptions        ${counts.importExceptions}` +
    `  (missing amount ${counts.missingAmountExceptions})`)
  console.log(`  receipts                 0`)
  console.log('')
  console.log('Payment routing')
  console.log(`  unique batch             ${counts.paymentRouting.uniqueBatch}`)
  console.log(`  ambiguous batch          ${counts.paymentRouting.ambiguousBatch}`)
  console.log(`  no batch found           ${counts.paymentRouting.batchNotFound}`)
  console.log(`  missing student number   ${counts.paymentRouting.missingStudentId}`)
  console.log('')
  console.log('Preserved, not corrected')
  console.log(`  totals rows excluded     ${counts.totalsRowsExcluded}`)
  console.log(`  duplicate candidates     ${counts.duplicateCandidateGroups} group(s) / ${counts.duplicateCandidateRows} rows`)
  console.log(`  same-ID name conflicts   ${counts.nameConflicts}`)
  console.log(`  formula/error cells      ${counts.errorCellsPreserved}`)
  console.log(`  French rows deferred     ${counts.frenchRowsDeferred}`)
  console.log('')
  console.log(`Unresolved rows            ${plan.unresolved.length}`)
  for (const blocker of readiness.blockers) console.log(`  BLOCKING  ${blocker}`)
  for (const note of readiness.notes) console.log(`  note      ${note}`)
  console.log('')
  console.log(`READY_FOR_APPLY=${readiness.ready ? 'true' : 'false'}`)
  console.log('')
}

async function main(): Promise<void> {
  const repoRoot = process.cwd()
  const parsed = parseArguments(process.argv.slice(2))

  if (parsed.unknown.length > 0) {
    console.error(`Unrecognised option(s): ${parsed.unknown.join(', ')}`)
    process.exit(2)
  }

  const gate = resolveApplyGate(parsed, process.env)

  console.log(
    gate.authorised
      ? 'FINANCE-IMPORT-02 Phase B2 — historical import APPLY'
      : 'FINANCE-IMPORT-02 — import dry run',
  )
  console.log(gate.authorised ? 'This run writes historical finance data.' : `No database writes. ${gate.reason}`)
  console.log('')

  const countsBefore = await countOperationalTables(repoRoot)

  const plan = buildDryRunPlan(repoRoot, new Date())
  const priorImport = await findPriorImport(repoRoot, plan.fingerprint.sha256)

  printPlanSummary(plan)

  const privateOutputs = writePrivateOutputs(repoRoot, plan)

  // -------------------------------------------------------------------------
  // Dry run: prove nothing changed, write the dry-run report, stop.
  // -------------------------------------------------------------------------
  if (!gate.authorised) {
    const countsAfter = await countOperationalTables(repoRoot)
    const workbookUnchanged = hashWorkbookOnDisk(repoRoot) === plan.fingerprint.sha256

    writeFileSync(
      path.join(repoRoot, REPORT_PATH),
      renderDryRunReport({
        plan,
        countsBefore,
        countsAfter,
        priorImport,
        workbookUnchanged,
        privateOutputs,
      }),
      'utf8',
    )

    console.log(`Supabase access: ${countsBefore.availability.reason}`)
    const changed = diffCounts(countsBefore.counts, countsAfter.counts).filter((row) => row.changed)
    if (changed.length === 0) {
      console.log('Supabase operational row counts unchanged by this run: yes')
    } else {
      console.error('Supabase row counts CHANGED during the dry run. This must not happen:')
      for (const row of changed) console.error(`  ${row.table}: ${row.before} -> ${row.after}`)
      process.exitCode = 1
    }
    console.log(`import_batches idempotency check: ${priorImport.note}`)
    console.log('')
    console.log(`Workbook unchanged after dry run: ${workbookUnchanged ? 'yes' : 'NO'}`)
    console.log('')
    console.log('Private plan (Git-ignored):')
    for (const file of privateOutputs) console.log(`  ${file}`)
    console.log(`Sanitised report: ${REPORT_PATH.split(path.sep).join('/')}`)

    if (parsed.apply) {
      console.log('')
      console.error(`Not applied. ${gate.reason}`)
      console.error(`To apply:  ${APPLY_ENV_VAR}=${APPLY_ENV_VALUE} npm run finance:import:apply`)
      process.exitCode = 2
    }

    if (!workbookUnchanged) {
      console.error('\nThe workbook hash changed during the dry run. This must not happen.')
      process.exitCode = 1
    }
    return
  }

  // -------------------------------------------------------------------------
  // Apply. Gate first; nothing is written until every check passes.
  // -------------------------------------------------------------------------
  console.log('Pre-flight safety gate')
  const preflight = runPreflight({
    plan,
    workbookSha256: hashWorkbookOnDisk(repoRoot),
    branch: gitBranch(repoRoot),
    gitStatusLines: gitStatusLines(repoRoot),
    schemaPresence: await probeSchema(repoRoot),
    countsBefore: countsBefore.counts,
    priorImport,
  })

  for (const entry of preflight.checks) {
    console.log(`  ${entry.passed ? 'ok  ' : 'STOP'}  ${entry.name}: ${entry.detail}`)
  }
  console.log('')

  if (!preflight.passed) {
    console.error('STOP. The pre-flight gate did not pass. Nothing was written.')
    for (const blocker of preflight.blockers) console.error(`  ${blocker}`)
    process.exit(1)
  }

  console.log(`Gate passed (${preflight.checks.length} checks). Applying.`)
  console.log('')

  const appliedAt = new Date()
  let result: ApplyResult
  try {
    result = await applyPlan({ repoRoot, plan, log: (line) => console.log(line) })
  } catch (error: unknown) {
    console.error('')
    console.error('APPLY FAILED. The import batch is marked failed where that was possible.')
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  // --- RLS verification, without the service role ---------------------------
  console.log('Row Level Security verification (not using the service role)')
  const env = readEnvironment(repoRoot)
  let rls: RlsVerification = {
    attempted: false,
    adminReadSucceeded: null,
    anonymousReadBlocked: null,
    note: 'not run: no publishable key or admin account available',
    details: {
      anonymousPaymentRows: null,
      anonymousError: null,
      adminPaymentRows: null,
      adminFinanceRecordRows: null,
      adminRole: null,
      adminError: null,
    },
  }

  const publishable = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (env.NEXT_PUBLIC_SUPABASE_URL && publishable && env.SUPABASE_SERVICE_ROLE_KEY) {
    const adminEmail = env.FINANCE_IMPORT_RLS_ADMIN_EMAIL ?? (await firstAdminEmail(repoRoot))
    if (adminEmail) {
      rls = await verifyRls({
        url: env.NEXT_PUBLIC_SUPABASE_URL,
        publishableKey: publishable,
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
        adminEmail,
        expectedPaymentRows: result.counters.rowsImported > 0 ? plan.counts.paymentsPlanned : 0,
      })
    }
  }
  console.log(`  unauthenticated read blocked: ${rls.anonymousReadBlocked === null ? 'not run' : rls.anonymousReadBlocked}`)
  console.log(`  admin read succeeded:         ${rls.adminReadSucceeded === null ? 'not run' : rls.adminReadSucceeded}`)
  console.log(`  ${rls.note}`)
  console.log('')

  // --- Reports --------------------------------------------------------------
  const workbookUnchanged = hashWorkbookOnDisk(repoRoot) === plan.fingerprint.sha256

  const applyPrivate = writeJson(repoRoot, 'import-apply-result.json', {
    result,
    rls,
    preflight,
    workbookUnchanged,
    appliedAt: appliedAt.toISOString(),
  })

  writeFileSync(
    path.join(repoRoot, APPLY_REPORT_PATH),
    renderApplyReport({
      result,
      plan,
      workbookUnchanged,
      appliedAt,
      privateOutputs: [applyPrivate],
      rls,
      operator: APPLY_OPERATOR_VERIFICATION,
    }),
    'utf8',
  )

  console.log(`Workbook unchanged after apply: ${workbookUnchanged ? 'yes' : 'NO'}`)
  console.log('')
  console.log('Private apply result (Git-ignored):')
  console.log(`  ${applyPrivate}`)
  console.log(`Sanitised report: ${APPLY_REPORT_PATH.split(path.sep).join('/')}`)

  const rlsFailed = rls.anonymousReadBlocked === false || rls.adminReadSucceeded === false
  if (!workbookUnchanged || rlsFailed) process.exitCode = 1
}

/** The admin account used for the RLS read-back. Its role is never changed. */
async function firstAdminEmail(repoRoot: string): Promise<string | null> {
  const { connectForWrite } = await import('./importer/supabase-write.mts')
  const client = connectForWrite(repoRoot)
  const { data } = await client
    .from('profiles')
    .select('email')
    .eq('role', 'admin')
    .eq('active', true)
    .limit(1)
  const email = (data ?? [])[0] as { email?: unknown } | undefined
  return email?.email ? String(email.email) : null
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main().catch((error: unknown) => {
    if (error instanceof WorkbookDiscoveryError) {
      console.error(error.message)
      const candidates = findWorkbookCandidates(process.cwd())
      if (candidates.length > 0) {
        console.error('Candidates found:')
        for (const candidate of candidates) console.error(`  reference/${candidate}`)
      }
      process.exit(1)
    }
    throw error
  })
}
