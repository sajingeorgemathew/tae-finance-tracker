/**
 * The apply: the plan, written to the database, then checked.
 *
 * Phase B1 proved the mapping. This module performs it. It is the only part of
 * the importer that writes historical finance data, and every property that
 * makes that safe lives here or in the two modules it leans on:
 *
 *   * IDs are derived, not generated (`deterministic-ids.mts`), so a retry
 *     after a partial transport failure converges instead of doubling.
 *   * Rows are built before anything is sent (`apply-rows.mts`), so a mapping
 *     fault is raised with no rows written rather than halfway through.
 *   * Writing goes in foreign-key order, and each entity class is verified by
 *     reading back the ids that class actually wrote. A mismatch stops the run
 *     there; it never continues blindly to the next class.
 *
 * Nothing here recalculates, normalizes, deduplicates or infers. That work does
 * not exist in this file because it does not exist in the plan.
 *
 * Logging is aggregate. No student name, student number, payer or individual
 * amount is written to the console or to the committed report.
 */

import { sourceKey } from './source-keys.mts'
import { buildApplyRows, findDuplicateIds, idsOf } from './apply-rows.mts'
import {
  entityId,
  IMPORT_NAMESPACE,
  NAMESPACE_NAME,
  UUID_V5_PATTERN,
} from './deterministic-ids.mts'
import {
  connectForWrite,
  countByIds,
  countRows,
  insertChunked,
  selectByIds,
  WriteAccessError,
} from './supabase-write.mts'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ApplyRows, ProgramIds } from './apply-rows.mts'
import type { DryRunPlan } from './plan.mts'

/**
 * `import_batches.import_type` for this run.
 *
 * FINANCE-IMPORT-02 specifies `legacy_finance_workbook`. The foundation
 * migration's CHECK constraint admits only
 * ('finance_workbook', 'students', 'payments', 'other'), and the ticket locks
 * the applied migration list to four files, so widening the constraint is out
 * of scope for this phase. `finance_workbook` is the constrained vocabulary's
 * term for exactly this import; the ticket's intended label is recorded in
 * `notes` so the deviation is visible in the row itself rather than only here.
 */
export const IMPORT_TYPE = 'finance_workbook'

/** The ticket's intended label, preserved in the batch row's notes. */
export const INTENDED_IMPORT_TYPE = 'legacy_finance_workbook'

/**
 * The tables that must stay empty. Receipts, deliveries and reminders are not
 * created by an import: the workbook's "Receipt Sent" values are historical
 * metadata and survive only inside preserved `legacy_raw_json`.
 */
export const MUST_STAY_EMPTY = ['receipts', 'receipt_deliveries', 'reminder_deliveries'] as const

export interface VerificationCheck {
  name: string
  expected: string
  actual: string
  passed: boolean
}

export interface EntityOutcome {
  table: string
  planned: number
  inserted: number
  verified: number
  passed: boolean
}

export interface ApplyResult {
  importBatchId: string
  importType: string
  status: 'completed' | 'failed'
  workbookSha256: string
  namespace: { name: string; uuid: string }
  entities: EntityOutcome[]
  checks: VerificationCheck[]
  counters: { rowsSeen: number; rowsImported: number; rowsSkipped: number }
  tableTotals: Record<string, number>
  failure: string | null
}

export class ApplyVerificationError extends Error {}

function check(
  checks: VerificationCheck[],
  name: string,
  expected: unknown,
  actual: unknown,
): void {
  checks.push({
    name,
    expected: String(expected),
    actual: String(actual),
    passed: String(expected) === String(actual),
  })
}

/**
 * The import batch row's id, derived from the workbook hash.
 *
 * Deterministic for the same reason every other id is: a re-run after a failed
 * apply must continue the same import rather than open a second one against the
 * same workbook. A *completed* import of this hash is refused before the apply
 * starts, so reuse only ever continues a run that did not finish.
 */
export function importBatchIdFor(sha256: string): string {
  return entityId(sourceKey(sha256, 'import-batch'))
}

/** Reads `programs` and maps short code -> id. Creates nothing. */
async function readProgramIds(client: SupabaseClient): Promise<ProgramIds> {
  const { data, error } = await client.from('programs').select('id, short_code')
  if (error) throw new WriteAccessError(`reading programs failed: ${error.message}`)

  return new Map(
    (data ?? []).map((row) => [
      String((row as { short_code: unknown }).short_code),
      String((row as { id: unknown }).id),
    ]),
  )
}

/**
 * Writes one entity class and verifies it landed.
 *
 * Verification counts the ids this class wrote, not the table total, so a row
 * that was already there could never stand in for one that failed to insert.
 * A mismatch throws: the caller does not continue to the next class.
 */
async function writeClass(
  client: SupabaseClient,
  table: string,
  rows: readonly Record<string, unknown>[],
  log: (line: string) => void,
): Promise<EntityOutcome> {
  const duplicates = findDuplicateIds(rows)
  if (duplicates.length > 0) {
    throw new ApplyVerificationError(
      `${table}: ${duplicates.length} duplicate deterministic id(s) within the planned rows. ` +
        'Two source entities derived the same key; this is an identity fault, not a transport one.',
    )
  }

  const invalid = rows.filter((row) => !UUID_V5_PATTERN.test(String(row.id))).length
  if (invalid > 0) {
    throw new ApplyVerificationError(`${table}: ${invalid} row(s) have a malformed UUID`)
  }

  await insertChunked(client, table, rows)

  const verified = await countByIds(client, table, idsOf(rows))
  const passed = verified === rows.length
  log(
    `  ${table.padEnd(24)} planned ${String(rows.length).padStart(5)}` +
      `  verified ${String(verified).padStart(5)}  ${passed ? 'ok' : 'MISMATCH'}`,
  )

  if (!passed) {
    throw new ApplyVerificationError(
      `${table}: planned ${rows.length} row(s) but only ${verified} are present after the write. ` +
        'Stopping before the next entity class.',
    )
  }

  return { table, planned: rows.length, inserted: rows.length, verified, passed }
}

/**
 * Post-import verification, read back from the hosted database.
 *
 * Foreign keys are enforced by the schema, so these checks are not about
 * whether the database allowed the row — they are about whether every child
 * points at a row *this import* created, which a foreign key alone does not
 * say.
 */
async function verify(
  client: SupabaseClient,
  plan: DryRunPlan,
  rows: ApplyRows,
  programs: ProgramIds,
): Promise<{ checks: VerificationCheck[]; tableTotals: Record<string, number> }> {
  const checks: VerificationCheck[] = []

  // --- Planned vs. the reviewed baseline ------------------------------------
  check(checks, 'batches match the reviewed plan', 23, rows.batches.length)
  check(
    checks,
    'PSW batches',
    22,
    rows.batches.filter((row) => row.program_id === programs.get('PSW')).length,
  )
  check(
    checks,
    'ECEA batches',
    1,
    rows.batches.filter((row) => row.program_id === programs.get('ECEA')).length,
  )
  check(checks, 'numbered students', 378, plan.students.length)
  check(checks, 'unresolved students', 7, plan.unresolvedStudents.length)
  check(checks, 'total student rows', 385, rows.students.length)
  check(checks, 'finance records', 397, rows.financeRecords.length)
  check(checks, 'payments', 1013, rows.payments.length)
  check(checks, 'import exceptions', 1, rows.importExceptions.length)
  check(checks, 'PSW installments', 1825, rows.installments.length)

  const recordProgram = new Map(
    plan.financeRecords.map((record) => [record.sourceKey, record.programShortCode]),
  )
  check(
    checks,
    'ECEA installments',
    0,
    plan.installments.filter(
      (installment) => recordProgram.get(installment.financeRecordSourceKey) === 'ECEA',
    ).length,
  )

  // --- Financial source conservation ----------------------------------------
  // The rule the whole import answers to: no historical source transaction may
  // silently disappear.
  const trackerRows = plan.payments.length
  check(checks, 'Tracker Master meaningful transaction rows', 1014, trackerRows)
  check(
    checks,
    'payments + import exceptions = source transaction rows',
    trackerRows,
    rows.payments.length + rows.importExceptions.length,
  )

  // --- Unresolved students keep a null student number -----------------------
  check(
    checks,
    'unresolved students carry no manufactured student number',
    7,
    rows.students.filter((row) => row.student_number === null).length,
  )

  // --- Tables that must stay empty ------------------------------------------
  const tableTotals: Record<string, number> = {}
  for (const table of MUST_STAY_EMPTY) {
    const total = await countRows(client, table)
    tableTotals[table] = total
    check(checks, `${table} created by this import`, 0, total)
  }

  for (const table of [
    'batches',
    'students',
    'student_finance_records',
    'installments',
    'payments',
    'import_exceptions',
    'programs',
  ]) {
    tableTotals[table] = await countRows(client, table)
  }

  // --- French stays deferred -------------------------------------------------
  check(checks, 'programs in the database (PSW and ECEA only)', 2, tableTotals.programs)
  check(
    checks,
    'French meaningful rows deferred, none normalized',
    3,
    plan.deferred.find((sheet) => sheet.sheetName === 'French')?.meaningfulRows ?? 0,
  )
  check(
    checks,
    'batches created from the French sheet',
    0,
    rows.batches.filter((row) => String(row.legacy_sheet_name) === 'French').length,
  )

  // --- Foreign keys point at rows this import created -----------------------
  const financeRecordIds = new Set(idsOf(rows.financeRecords))
  const studentIds = new Set(idsOf(rows.students))
  const programIdValues = new Set(programs.values())

  const paymentsBack = await selectByIds(
    client,
    'payments',
    'id, student_finance_record_id',
    idsOf(rows.payments),
  )
  check(checks, 'payments read back', rows.payments.length, paymentsBack.length)
  check(
    checks,
    'payments with a finance record created by this import',
    rows.payments.length,
    paymentsBack.filter((row) => financeRecordIds.has(String(row.student_finance_record_id)))
      .length,
  )

  const installmentsBack = await selectByIds(
    client,
    'installments',
    'id, student_finance_record_id',
    idsOf(rows.installments),
  )
  check(checks, 'installments read back', rows.installments.length, installmentsBack.length)
  check(
    checks,
    'installments with a finance record created by this import',
    rows.installments.length,
    installmentsBack.filter((row) => financeRecordIds.has(String(row.student_finance_record_id)))
      .length,
  )

  const recordsBack = await selectByIds(
    client,
    'student_finance_records',
    'id, student_id, program_id, batch_id',
    idsOf(rows.financeRecords),
  )
  check(checks, 'finance records read back', rows.financeRecords.length, recordsBack.length)
  check(
    checks,
    'finance records with a student created by this import',
    rows.financeRecords.length,
    recordsBack.filter((row) => studentIds.has(String(row.student_id))).length,
  )
  check(
    checks,
    'finance records with a valid program',
    rows.financeRecords.length,
    recordsBack.filter((row) => programIdValues.has(String(row.program_id))).length,
  )
  check(
    checks,
    'finance records left unassigned by the approved plan',
    22,
    recordsBack.filter((row) => row.batch_id === null).length,
  )

  // --- Idempotency: derived ids are unique where uniqueness is expected -----
  for (const [name, rowSet] of [
    ['batches', rows.batches],
    ['students', rows.students],
    ['student_finance_records', rows.financeRecords],
    ['installments', rows.installments],
    ['payments', rows.payments],
    ['import_exceptions', rows.importExceptions],
  ] as const) {
    check(checks, `${name}: duplicate deterministic ids`, 0, findDuplicateIds(rowSet).length)
  }

  const allIds = [
    ...idsOf(rows.batches),
    ...idsOf(rows.students),
    ...idsOf(rows.financeRecords),
    ...idsOf(rows.installments),
    ...idsOf(rows.payments),
    ...idsOf(rows.importExceptions),
  ]
  check(
    checks,
    'deterministic ids unique across every entity class',
    allIds.length,
    new Set(allIds).size,
  )
  check(
    checks,
    'deterministic ids that are valid v5 UUIDs',
    allIds.length,
    allIds.filter((id) => UUID_V5_PATTERN.test(id)).length,
  )

  return { checks, tableTotals }
}

export interface ApplyOptions {
  repoRoot: string
  plan: DryRunPlan
  log: (line: string) => void
}

/**
 * Runs the apply end to end.
 *
 * Counter semantics, fixed here and documented in the report:
 *
 *   rows_seen      every entity row the reviewed plan requires — batches,
 *                  students, finance records, installments, payments and
 *                  import exceptions. The `import_batches` row itself is not
 *                  counted: it records the run, it is not imported by it.
 *   rows_imported  of those, the rows verified present in the database.
 *   rows_skipped   rows the plan required that the import did not write.
 *                  **The missing-amount Tracker Master row is not skipped** —
 *                  it is preserved as an import exception, and is counted in
 *                  both rows_seen and rows_imported as that exception. A
 *                  skipped row would be a silent drop, which this import has
 *                  none of, so the expected value is 0.
 */
export async function applyPlan(options: ApplyOptions): Promise<ApplyResult> {
  const { repoRoot, plan, log } = options
  const client = connectForWrite(repoRoot)
  const importBatchId = importBatchIdFor(plan.fingerprint.sha256)

  const programs = await readProgramIds(client)
  const rows = buildApplyRows(plan, programs, importBatchId)

  const rowsSeen =
    rows.batches.length +
    rows.students.length +
    rows.financeRecords.length +
    rows.installments.length +
    rows.payments.length +
    rows.importExceptions.length

  const result: ApplyResult = {
    importBatchId,
    importType: IMPORT_TYPE,
    status: 'failed',
    workbookSha256: plan.fingerprint.sha256,
    namespace: { name: NAMESPACE_NAME, uuid: IMPORT_NAMESPACE },
    entities: [],
    checks: [],
    counters: { rowsSeen, rowsImported: 0, rowsSkipped: rowsSeen },
    tableTotals: {},
    failure: null,
  }

  // --- 1. import_batches, running -------------------------------------------
  log(
    'Write order: import_batches -> batches -> students -> finance records -> ' +
      'installments -> payments -> import exceptions -> verification -> completed',
  )
  log('')

  const { error: batchError } = await client.from('import_batches').upsert(
    {
      id: importBatchId,
      source_filename: plan.fingerprint.fileName,
      source_file_hash: plan.fingerprint.sha256,
      import_type: IMPORT_TYPE,
      status: 'running',
      started_at: new Date().toISOString(),
      rows_seen: rowsSeen,
      notes:
        'FINANCE-IMPORT-02 Phase B2 historical import. ' +
        `Ticket import_type "${INTENDED_IMPORT_TYPE}" is not admitted by the ` +
        `import_batches_import_type_check constraint; "${IMPORT_TYPE}" used instead. ` +
        'Entity ids are RFC 4122 v5 UUIDs over the importer source keys, namespace ' +
        `${IMPORT_NAMESPACE} ("${NAMESPACE_NAME}").`,
    },
    { onConflict: 'id' },
  )
  if (batchError) throw new WriteAccessError(`import_batches insert failed: ${batchError.message}`)
  log(`import batch ${importBatchId} status=running rows_seen=${rowsSeen}`)
  log('')

  try {
    // --- 2-7. Entity classes, in foreign-key-safe order ---------------------
    log('Writing entity classes')
    result.entities.push(await writeClass(client, 'batches', rows.batches, log))
    result.entities.push(await writeClass(client, 'students', rows.students, log))
    result.entities.push(
      await writeClass(client, 'student_finance_records', rows.financeRecords, log),
    )
    result.entities.push(await writeClass(client, 'installments', rows.installments, log))
    result.entities.push(await writeClass(client, 'payments', rows.payments, log))
    result.entities.push(await writeClass(client, 'import_exceptions', rows.importExceptions, log))
    log('')

    // --- 8. Verification ----------------------------------------------------
    log('Verifying against the hosted database')
    const { checks, tableTotals } = await verify(client, plan, rows, programs)
    result.checks = checks
    result.tableTotals = tableTotals

    const failed = checks.filter((entry) => !entry.passed)
    for (const entry of failed) {
      log(`  FAILED  ${entry.name}: expected ${entry.expected}, got ${entry.actual}`)
    }
    log(`  ${checks.length - failed.length}/${checks.length} checks passed`)
    log('')

    if (failed.length > 0) {
      throw new ApplyVerificationError(
        `${failed.length} verification check(s) failed; the import is not marked completed.`,
      )
    }

    const rowsImported = result.entities.reduce((total, entity) => total + entity.verified, 0)
    result.counters = { rowsSeen, rowsImported, rowsSkipped: rowsSeen - rowsImported }

    // --- 9. import_batches, completed ---------------------------------------
    const { error: completeError } = await client
      .from('import_batches')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        rows_seen: rowsSeen,
        rows_imported: rowsImported,
        rows_skipped: result.counters.rowsSkipped,
      })
      .eq('id', importBatchId)
    if (completeError) {
      throw new WriteAccessError(`marking the import completed failed: ${completeError.message}`)
    }

    result.status = 'completed'
    log(
      `import batch ${importBatchId} status=completed ` +
        `rows_imported=${rowsImported} rows_skipped=${result.counters.rowsSkipped}`,
    )
    return result
  } catch (error: unknown) {
    // Sanitised: an importer error names tables and counts, never a student and
    // never a credential.
    const note = error instanceof Error ? error.message : 'unknown failure'
    result.failure = note

    await client
      .from('import_batches')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        rows_imported: result.entities.reduce((total, entity) => total + entity.verified, 0),
        notes: `FINANCE-IMPORT-02 Phase B2 apply failed. ${note}`.slice(0, 2000),
      })
      .eq('id', importBatchId)

    throw error
  }
}
