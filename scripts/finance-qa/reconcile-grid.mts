/**
 * FINANCE-GRID-03B — read-only reconciliation of the grid against the workbook.
 *
 *   npm run finance:reconcile
 *
 * For every batch table the import mapped, this compares two things:
 *
 *   * the ORIGINAL WORKBOOK BATCH TABLE, parsed with the importer's own
 *     block detection and table builder (`importer/batch-tables.mts`), read
 *     cell by cell from the source rows; and
 *   * the CURRENT GRID VIEW MODEL, built by the application's own
 *     `buildFinanceGrid` from rows read out of hosted Supabase through an
 *     authenticated admin session under Row Level Security — never the
 *     service role — using the exact column projections `load.ts` uses.
 *
 * Rows are joined by deterministic identity only: the finance record id is
 * the importer's v5 UUID over (workbook hash, sheet, source row, table key),
 * recomputed here from the workbook. No student is matched by name or by a
 * nearby number.
 *
 * Nothing is recomputed on the way through. A source cell that is blank must
 * be blank in the grid; a recorded zero must be `$0.00`; a negative must stay
 * negative; Total Fee, Total Paid and Balance must equal the batch sheet's own
 * snapshot cell and never a Tracker Master figure. The comparison is against
 * the workbook as preserved, not against totals recalculated from payments.
 *
 * It writes nothing to Supabase. Its outputs are Git-ignored row-level JSON
 * under `.private/finance-qa/` and an aggregate, PII-free Markdown summary in
 * the same folder for the committed acceptance report to cite.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import type { SupabaseClient } from '@supabase/supabase-js'

import { APPROVED_WORKBOOK_SHA256 } from '../finance-import/importer/apply-preflight.mts'
import { discoverBatchTables, type SupportedBatchTable } from '../finance-import/importer/batch-tables.mts'
import { proposedBatchName } from '../finance-import/importer/batches.mts'
import {
  manifestColumnKey,
  manifestValueKindFor,
  planColumnManifest,
  planTableManifest,
} from '../finance-import/importer/column-manifest.mts'
import { entityId } from '../finance-import/importer/deterministic-ids.mts'
import { readLegacyFigure, resolveSummaryColumns } from '../finance-import/importer/finance-records.mts'
import { scheduleColumns } from '../finance-import/importer/installments.mts'
import { buildDryRunPlan, type DryRunPlan } from '../finance-import/importer/plan.mts'
import {
  batchSourceKey,
  financeRecordSourceKey,
  paymentSourceKey,
} from '../finance-import/importer/source-keys.mts'
import type { SourceCell, SourceRow, SourceTable } from '../finance-import/importer/source-tables.mts'
import { hashWorkbookOnDisk, openWorkbook } from '../finance-import/lib/workbook-source.mts'
import type { ColumnRole } from '../finance-import/lib/headers.mts'

import type { RawManifestColumn } from '../../src/lib/finance/grid/manifest.ts'
import type { MoneyCell } from '../../src/lib/finance/grid/money.ts'
import {
  buildFinanceGrid,
  type BuiltGrid,
  type RawFinanceRecord,
  type RawInstallment,
  type RawPayment,
} from '../../src/lib/finance/grid/view-model.ts'

import { openHostedSession, type HostedSession } from './hosted-session.mts'

const PRIVATE_DIR = path.join('.private', 'finance-qa')

const EPSILON = 0.005

// -----------------------------------------------------------------------------
// The loader's own projections, read from its source so the two cannot drift
// -----------------------------------------------------------------------------

interface LoaderProjection {
  records: string
  installments: string
  payments: string
  manifest: string
}

/**
 * Pulls the four `select(...)` strings out of `src/lib/finance/grid/load.ts`.
 *
 * `load.ts` is `server-only` and cannot be imported here, and copying the
 * strings by hand is how a QA tool ends up checking a projection the page no
 * longer uses. Reading them from the file is the honest alternative.
 */
function readLoaderProjection(repoRoot: string): LoaderProjection {
  const source = readFileSync(path.join(repoRoot, 'src', 'lib', 'finance', 'grid', 'load.ts'), 'utf8')

  const pick = (name: string): string => {
    const match = new RegExp(`const ${name} =\\s*(?:\`([^\`]*)\`|'([^']*)')`).exec(source)
    if (!match) throw new Error(`could not find ${name} in load.ts`)
    return (match[1] ?? match[2]).replace(/\s+/g, ' ').trim()
  }

  return {
    records: pick('RECORD_COLUMNS'),
    installments: pick('INSTALLMENT_COLUMNS'),
    payments: pick('PAYMENT_COLUMNS'),
    manifest: pick('MANIFEST_COLUMNS'),
  }
}

// -----------------------------------------------------------------------------
// Hosted reads — authenticated, paged, read-only
// -----------------------------------------------------------------------------

interface HostedProgram {
  id: string
  name: string
  short_code: string
}

interface HostedBatch {
  id: string
  program_id: string
  name: string
  code: string | null
  legacy_sheet_name: string | null
  start_date: string | null
  active: boolean
}

interface HostedManifestRow extends RawManifestColumn {
  id: string
  batch_id: string
  source_header_inherited: boolean
  origin: string
  legacy_sheet_name: string | null
  legacy_table_key: string | null
  source_workbook_hash: string | null
}

async function selectAll<T>(
  client: SupabaseClient,
  table: string,
  columns: string,
  orderBy: string,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .order(orderBy)
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`read ${table}: ${error.message}`)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < pageSize) break
  }
  return out
}

interface HostedRecord extends RawFinanceRecord {
  program_id: string
}

interface HostedData {
  programs: HostedProgram[]
  batches: HostedBatch[]
  records: HostedRecord[]
  installments: RawInstallment[]
  payments: RawPayment[]
  manifest: HostedManifestRow[]
  requestCount: number
}

async function readHosted(session: HostedSession, projection: LoaderProjection): Promise<HostedData> {
  const { client } = session
  let requestCount = 0
  const count = <T,>(promise: Promise<T>): Promise<T> => {
    requestCount += 1
    return promise
  }

  const programs = await count(selectAll<HostedProgram>(client, 'programs', 'id, name, short_code', 'short_code'))
  const batches = await count(
    selectAll<HostedBatch>(client, 'batches', 'id, program_id, name, code, legacy_sheet_name, start_date, active', 'code'),
  )
  // The loader's projection plus `program_id`, which the unassigned audit needs
  // to tally by program. A superset: the view model reads nothing extra.
  const records = await count(
    selectAll<HostedRecord>(client, 'student_finance_records', `${projection.records}, program_id`, 'id'),
  )
  const installments = await count(selectAll<RawInstallment>(client, 'installments', projection.installments, 'id'))
  const payments = await count(selectAll<RawPayment>(client, 'payments', projection.payments, 'id'))
  const manifest = await count(
    selectAll<HostedManifestRow>(
      client,
      'batch_finance_columns',
      `id, batch_id, ${projection.manifest}, source_header_inherited, origin, legacy_sheet_name, legacy_table_key, source_workbook_hash`,
      'id',
    ),
  )

  return { programs, batches, records, installments, payments, manifest, requestCount }
}

// -----------------------------------------------------------------------------
// Expected values, read straight from the source cells
// -----------------------------------------------------------------------------

/** The importer's own rule for a cell it would have omitted from legacy_raw_json. */
function omittedAsBlank(cell: SourceCell | undefined): boolean {
  return !cell || (cell.isBlank && cell.formula === null && !cell.isError)
}

/** What the grid must show for a preserved ACTUAL cell, derived from the source. */
function expectedActualCell(cell: SourceCell | undefined): MoneyCell {
  if (omittedAsBlank(cell)) return { kind: 'blank' }
  const source = cell as SourceCell
  if (source.isError) {
    const text = source.text ?? (source.rawValue === null ? null : String(source.rawValue))
    return { kind: 'error', text: text ?? '#ERROR' }
  }
  const value = source.rawValue
  if (typeof value === 'number') return { kind: 'amount', amount: value, display: '' }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return { kind: 'blank' }
    const parsed = Number(trimmed)
    return Number.isFinite(parsed)
      ? { kind: 'amount', amount: parsed, display: '' }
      : { kind: 'text', text: trimmed }
  }
  if (typeof value === 'boolean') return { kind: 'text', text: String(value) }
  return { kind: 'blank' }
}

/** What the grid must show for a scheduled cell: a number, or nothing at all. */
function expectedScheduledCell(cell: SourceCell | undefined): MoneyCell {
  if (!cell || cell.isBlank || cell.isError || cell.numeric === null) return { kind: 'blank' }
  return { kind: 'amount', amount: cell.numeric, display: '' }
}

type CellOutcome =
  | 'blank_preserved'
  | 'zero_preserved'
  | 'negative_preserved'
  | 'amount_match'
  | 'text_match'
  | 'error_match'
  | 'value_mismatch'
  | 'blank_zero_mismatch'
  | 'sign_mismatch'
  | 'kind_mismatch'

function compareCells(expected: MoneyCell, actual: MoneyCell | undefined): CellOutcome {
  const got: MoneyCell = actual ?? { kind: 'blank' }

  if (expected.kind === 'blank' && got.kind === 'blank') return 'blank_preserved'

  if (expected.kind === 'amount' && got.kind === 'amount') {
    if (Math.abs(expected.amount - got.amount) <= EPSILON) {
      if (expected.amount === 0) return 'zero_preserved'
      if (expected.amount < 0) return 'negative_preserved'
      return 'amount_match'
    }
    if (Math.abs(expected.amount + got.amount) <= EPSILON) return 'sign_mismatch'
    return 'value_mismatch'
  }

  if (expected.kind === 'text' && got.kind === 'text') {
    return expected.text === got.text ? 'text_match' : 'value_mismatch'
  }
  if (expected.kind === 'error' && got.kind === 'error') {
    return expected.text === got.text ? 'error_match' : 'value_mismatch'
  }

  const zeroVsBlank =
    (expected.kind === 'blank' && got.kind === 'amount' && got.amount === 0) ||
    (got.kind === 'blank' && expected.kind === 'amount' && expected.amount === 0)
  if (zeroVsBlank) return 'blank_zero_mismatch'

  // A figure on one side and nothing on the other is a lost (or invented)
  // value, and is reported as one; a text or error cell standing where a
  // figure or blank should be is a difference of kind.
  const amountVsBlank =
    (expected.kind === 'amount' && got.kind === 'blank') ||
    (expected.kind === 'blank' && got.kind === 'amount')
  if (amountVsBlank) return 'value_mismatch'

  if (expected.kind !== got.kind) return 'kind_mismatch'
  return 'value_mismatch'
}

const MISMATCH_OUTCOMES: ReadonlySet<CellOutcome> = new Set([
  'value_mismatch',
  'blank_zero_mismatch',
  'sign_mismatch',
  'kind_mismatch',
])

function describeCell(cell: MoneyCell | undefined): string {
  if (!cell) return '(absent)'
  switch (cell.kind) {
    case 'blank':
      return 'blank'
    case 'amount':
      return String(cell.amount)
    case 'text':
      return `text:${cell.text}`
    case 'error':
      return `error:${cell.text}`
  }
}

// -----------------------------------------------------------------------------
// Expected columns
// -----------------------------------------------------------------------------

interface ExpectedColumn {
  key: string
  label: string
  letter: string
  order: number
  role: ColumnRole
  visible: boolean
  allBlank: boolean
}

const FLAT_MONEY_ROLES: ReadonlySet<ColumnRole> = new Set<ColumnRole>([
  'total_fee',
  'enrollment_fee',
  'installment_ordinal',
  'late_fees',
  'month',
  'total_paid',
  'balance',
  'outstanding',
  'discount',
  'amount_paid',
])

function studentRows(table: SourceTable): SourceRow[] {
  return table.rows.filter((row) => row.kind === 'student')
}

/** The ACTUAL columns the workbook table has, in sheet order, with visibility. */
function expectedActualColumns(table: SourceTable): ExpectedColumn[] {
  const split = table.columns.some(
    (column) => column.section === 'actual' || column.section === 'installment',
  )
  const columns = split
    ? table.columns.filter((column) => column.section === 'actual')
    : table.columns.filter((column) => column.section === 'flat' && FLAT_MONEY_ROLES.has(column.role))

  const rows = studentRows(table)

  return [...columns]
    .sort((a, b) => a.column - b.column)
    .map((column, index) => {
      const header = column.header?.trim() ?? ''
      return {
        key: manifestColumnKey('actual', column.letter),
        label: header === '' ? `Column ${column.letter}` : header,
        letter: column.letter,
        order: index + 1,
        role: column.role,
        visible: manifestValueKindFor(column.role) === 'money',
        allBlank: rows.every((row) => omittedAsBlank(row.cellByColumn.get(column.column))),
      }
    })
}

/** The INSTALLMENT columns, exactly as the importer numbered them. */
function expectedScheduledColumns(table: SourceTable): ExpectedColumn[] {
  const rows = studentRows(table)
  return scheduleColumns(table).columns.map((scheduled) => ({
    key: manifestColumnKey('installment', scheduled.column.letter),
    label: (scheduled.column.header as string).trim(),
    letter: scheduled.column.letter,
    order: scheduled.sequenceNumber,
    role: scheduled.column.role,
    visible: true,
    allBlank: rows.every((row) => {
      const cell = row.cellByColumn.get(scheduled.column.column)
      return !cell || cell.isBlank
    }),
  }))
}

// -----------------------------------------------------------------------------
// Per-batch reconciliation
// -----------------------------------------------------------------------------

interface RowDetail {
  sourceRow: number
  financeRecordId: string
  matched: boolean
  studentNumberSource: string | null
  studentNumberGrid: string | null
  nameSource: string | null
  nameGrid: string | null
  nameSourceKind: 'batch_sheet' | 'batch_sheet_whitespace' | 'tracker_master' | 'other' | null
  fee: { expected: string; grid: string; outcome: CellOutcome }
  paid: { expected: string; grid: string; outcome: CellOutcome }
  balance: { expected: string; grid: string; outcome: CellOutcome }
  actualMismatches: { column: string; expected: string; grid: string; outcome: CellOutcome }[]
  scheduledMismatches: { column: string; expected: string; grid: string; outcome: CellOutcome }[]
  receipt: { expected: string; grid: string; ok: boolean }
  payments: { hosted: number; grid: number; planned: number; ok: boolean; notes: string[] }
  legacyFlags: string[]
}

interface BatchResult {
  batchName: string
  batchCode: string
  program: string
  hostedBatchId: string
  identity: { ok: boolean; notes: string[] }
  rows: { source: number; grid: number; matched: number; missing: number; extra: number }
  studentNumbers: {
    sourceNumbered: number
    gridNumbered: number
    sourceUnresolved: number
    gridUnresolved: number
    mismatches: number
  }
  names: { batchSheetSpelling: number; batchSheetWhitespace: number; trackerMasterSpelling: number; other: number }
  columns: {
    sourceActualTotal: number
    sourceActualVisible: number
    sourceActualHidden: number
    gridActual: number
    sourceScheduled: number
    gridScheduled: number
    mismatches: string[]
    derivedColumnsInGrid: number
  }
  allBlankColumns: { expectedVisible: number; expectedHidden: number; gridReported: number; ok: boolean; expectedList: string[] }
  values: {
    cellsCompared: number
    blanksPreserved: number
    zerosPreserved: number
    negativesPreserved: number
    amountsMatched: number
    textCells: number
    errorCells: number
    valueMismatches: number
    blankZeroMismatches: number
    signMismatches: number
    kindMismatches: number
  }
  snapshots: {
    feeMismatches: number
    paidMismatches: number
    balanceMismatches: number
    balanceSource: string
    negativeBalances: number
    zeroPaid: number
  }
  schedule: { cellsCompared: number; blanks: number; matched: number; mismatches: number }
  receipts: { mismatches: number; byStatus: Record<string, number> }
  payments: {
    gridPayments: number
    hostedPayments: number
    plannedPayments: number
    mismatches: number
  }
  totals: {
    ok: boolean
    fees: string
    paid: string
    balance: string
    feesMissing: number
    paidMissing: number
    balanceMissing: number
    notes: string[]
  }
  manifest: { planned: number; hosted: number; mismatches: string[] }
  balanceConvention: string
  ecea: { checked: boolean; notes: string[]; ok: boolean } | null
  status: 'PASS' | 'REVIEW'
  reasons: string[]
  rowDetails: RowDetail[]
}

function figureToCell(value: number | null): MoneyCell {
  return value === null ? { kind: 'blank' } : { kind: 'amount', amount: value, display: '' }
}

function reconcileBatch(
  hash: string,
  entry: SupportedBatchTable,
  plan: DryRunPlan,
  hosted: HostedData,
  built: BuiltGrid,
  hostedBatch: HostedBatch,
  program: HostedProgram | undefined,
  hostedRecords: RawFinanceRecord[],
  hostedInstallments: RawInstallment[],
  hostedPayments: RawPayment[],
  hostedManifest: HostedManifestRow[],
): BatchResult {
  const { table } = entry
  const reasons: string[] = []
  const batchCode = `${table.sheetName}!${table.key}`

  // --- Identity --------------------------------------------------------------
  const identityNotes: string[] = []
  const expectedBatchId = entityId(batchSourceKey(hash, table.sheetName, table.key))
  if (hostedBatch.id !== expectedBatchId) identityNotes.push('deterministic batch id differs')
  if (hostedBatch.code !== batchCode) identityNotes.push(`batch code is ${JSON.stringify(hostedBatch.code)}, expected ${JSON.stringify(batchCode)}`)
  if (hostedBatch.legacy_sheet_name !== table.sheetName) identityNotes.push('legacy sheet name differs')
  if (program?.short_code !== entry.programShortCode) {
    identityNotes.push(`program is ${program?.short_code ?? 'unknown'}, expected ${entry.programShortCode}`)
  }
  const expectedName = proposedBatchName(table)
  if (hostedBatch.name !== expectedName) identityNotes.push(`batch name is ${JSON.stringify(hostedBatch.name)}, expected ${JSON.stringify(expectedName)}`)
  if (!hostedBatch.active) identityNotes.push('batch is inactive and would not be listed')
  if (identityNotes.length > 0) reasons.push(`identity: ${identityNotes.join('; ')}`)

  // --- Rows, joined by deterministic identity -------------------------------
  const sourceRows = studentRows(table)
  const gridById = new Map(built.rows.map((row) => [row.financeRecordId, row]))
  const expectedIds = new Set<string>()

  const summary = resolveSummaryColumns(table)
  const actualColumns = expectedActualColumns(table)
  const visibleActual = actualColumns.filter((column) => column.visible)
  const scheduled = expectedScheduledColumns(table)

  const plannedStudentByKey = new Map(
    [...plan.students, ...plan.unresolvedStudents].map((student) => [student.sourceKey, student]),
  )
  const plannedRecordByKey = new Map(plan.financeRecords.map((record) => [record.sourceKey, record]))
  const plannedPaymentsByRecordId = new Map<string, DryRunPlan['payments']>()
  for (const payment of plan.payments) {
    if (payment.unresolved !== null || payment.financeRecordSourceKey === null) continue
    const id = entityId(payment.financeRecordSourceKey)
    const list = plannedPaymentsByRecordId.get(id) ?? []
    list.push(payment)
    plannedPaymentsByRecordId.set(id, list)
  }
  const hostedPaymentsByRecord = new Map<string, RawPayment[]>()
  for (const payment of hostedPayments) {
    const list = hostedPaymentsByRecord.get(payment.student_finance_record_id) ?? []
    list.push(payment)
    hostedPaymentsByRecord.set(payment.student_finance_record_id, list)
  }

  const values = {
    cellsCompared: 0,
    blanksPreserved: 0,
    zerosPreserved: 0,
    negativesPreserved: 0,
    amountsMatched: 0,
    textCells: 0,
    errorCells: 0,
    valueMismatches: 0,
    blankZeroMismatches: 0,
    signMismatches: 0,
    kindMismatches: 0,
  }
  const tally = (outcome: CellOutcome): void => {
    values.cellsCompared += 1
    switch (outcome) {
      case 'blank_preserved':
        values.blanksPreserved += 1
        break
      case 'zero_preserved':
        values.zerosPreserved += 1
        break
      case 'negative_preserved':
        values.negativesPreserved += 1
        break
      case 'amount_match':
        values.amountsMatched += 1
        break
      case 'text_match':
        values.textCells += 1
        break
      case 'error_match':
        values.errorCells += 1
        break
      case 'value_mismatch':
        values.valueMismatches += 1
        break
      case 'blank_zero_mismatch':
        values.blankZeroMismatches += 1
        break
      case 'sign_mismatch':
        values.signMismatches += 1
        break
      case 'kind_mismatch':
        values.kindMismatches += 1
        break
    }
  }

  const schedule = { cellsCompared: 0, blanks: 0, matched: 0, mismatches: 0 }
  const snapshots = { feeMismatches: 0, paidMismatches: 0, balanceMismatches: 0, negativeBalances: 0, zeroPaid: 0 }
  const names = { batchSheetSpelling: 0, batchSheetWhitespace: 0, trackerMasterSpelling: 0, other: 0 }
  const numbers = { sourceNumbered: 0, gridNumbered: 0, sourceUnresolved: 0, gridUnresolved: 0, mismatches: 0 }
  const receipts = { mismatches: 0, byStatus: {} as Record<string, number> }
  const payments = { gridPayments: 0, hostedPayments: 0, plannedPayments: 0, mismatches: 0 }

  const rowDetails: RowDetail[] = []
  let matched = 0
  let missing = 0

  for (const row of sourceRows) {
    const recordKey = financeRecordSourceKey(hash, table.sheetName, row.row, table.key)
    const id = entityId(recordKey)
    expectedIds.add(id)
    const grid = gridById.get(id)

    if (row.studentNumber === null) numbers.sourceUnresolved += 1
    else numbers.sourceNumbered += 1

    const planned = plannedRecordByKey.get(recordKey)
    const plannedStudent = planned ? plannedStudentByKey.get(planned.studentSourceKey) : undefined
    const batchSheetName = [row.fullName ?? [row.firstName, row.middleName, row.lastName].filter(Boolean).join(' ')]
      .map((value) => value.trim())
      .find((value) => value !== '') ?? null

    const expectedFee = figureToCell(readLegacyFigure(row, summary.totalFee).value)
    const expectedPaid = figureToCell(readLegacyFigure(row, summary.totalPaid).value)
    const expectedBalance = figureToCell(readLegacyFigure(row, summary.balance).value)

    if (!grid) {
      missing += 1
      rowDetails.push({
        sourceRow: row.row,
        financeRecordId: id,
        matched: false,
        studentNumberSource: row.studentNumber,
        studentNumberGrid: null,
        nameSource: batchSheetName,
        nameGrid: null,
        nameSourceKind: null,
        fee: { expected: describeCell(expectedFee), grid: '(absent)', outcome: 'kind_mismatch' },
        paid: { expected: describeCell(expectedPaid), grid: '(absent)', outcome: 'kind_mismatch' },
        balance: { expected: describeCell(expectedBalance), grid: '(absent)', outcome: 'kind_mismatch' },
        actualMismatches: [],
        scheduledMismatches: [],
        receipt: { expected: '?', grid: '(absent)', ok: false },
        payments: { hosted: 0, grid: 0, planned: 0, ok: false, notes: ['row absent from grid'] },
        legacyFlags: [],
      })
      continue
    }
    matched += 1

    // Student number: exact, or exactly absent.
    if (grid.studentNumber === null) numbers.gridUnresolved += 1
    else numbers.gridNumbered += 1
    if ((grid.studentNumber ?? null) !== (row.studentNumber ?? null)) numbers.mismatches += 1

    // Name: the display name is the planned student's legacy name, which is
    // Tracker Master's spelling where one exists, else the batch sheet's.
    let nameKind: RowDetail['nameSourceKind'] = 'other'
    if (batchSheetName !== null && grid.studentName === batchSheetName.trim()) nameKind = 'batch_sheet'
    else if (batchSheetName !== null && grid.studentName === collapseWhitespace(batchSheetName)) {
      // The sheet cell carries doubled or stray spaces inside the name; the
      // display name collapses them and changes nothing else.
      nameKind = 'batch_sheet_whitespace'
    } else if (
      plannedStudent &&
      plannedStudent.nameVariants.some(
        (variant) => variant.origin === 'tracker_master' && variant.value.trim() === grid.studentName,
      )
    ) {
      nameKind = 'tracker_master'
    }
    if (nameKind === 'batch_sheet') names.batchSheetSpelling += 1
    else if (nameKind === 'batch_sheet_whitespace') names.batchSheetWhitespace += 1
    else if (nameKind === 'tracker_master') names.trackerMasterSpelling += 1
    else names.other += 1
    if (plannedStudent && (plannedStudent.legacyDisplayName ?? '').trim() !== grid.studentName) {
      // The view model may prefer display_name or parsed parts; report but do
      // not fail unless the name is from nowhere at all.
      if (nameKind === 'other') reasons.push(`row ${row.row}: displayed name matches no source spelling`)
    }

    // Snapshots.
    const feeOutcome = compareCells(expectedFee, grid.legacyTotalFee)
    const paidOutcome = compareCells(expectedPaid, grid.legacyTotalPaid)
    const balanceOutcome = compareCells(expectedBalance, grid.legacyBalance)
    if (MISMATCH_OUTCOMES.has(feeOutcome)) snapshots.feeMismatches += 1
    if (MISMATCH_OUTCOMES.has(paidOutcome)) snapshots.paidMismatches += 1
    if (MISMATCH_OUTCOMES.has(balanceOutcome)) snapshots.balanceMismatches += 1
    if (expectedBalance.kind === 'amount' && expectedBalance.amount < 0) snapshots.negativeBalances += 1
    if (expectedPaid.kind === 'amount' && expectedPaid.amount === 0) snapshots.zeroPaid += 1

    // Every ACTUAL cell of every visible column, and every hidden column must
    // leak nothing.
    const actualMismatches: RowDetail['actualMismatches'] = []
    for (const column of visibleActual) {
      const sourceColumn = table.columns.find((candidate) => candidate.letter === column.letter)
      const cell = sourceColumn ? row.cellByColumn.get(sourceColumn.column) : undefined
      const expected = expectedActualCell(cell)
      const outcome = compareCells(expected, grid.actualCells[column.key])
      tally(outcome)
      if (MISMATCH_OUTCOMES.has(outcome)) {
        actualMismatches.push({
          column: `${column.letter} ${JSON.stringify(column.label)}`,
          expected: describeCell(expected),
          grid: describeCell(grid.actualCells[column.key]),
          outcome,
        })
      }
    }
    for (const column of actualColumns.filter((candidate) => !candidate.visible)) {
      if (column.key in grid.actualCells) {
        actualMismatches.push({
          column: `${column.letter} ${JSON.stringify(column.label)}`,
          expected: 'hidden',
          grid: describeCell(grid.actualCells[column.key]),
          outcome: 'kind_mismatch',
        })
        values.kindMismatches += 1
      }
    }
    // A key in the grid that the source never had would be an invented column.
    for (const key of Object.keys(grid.actualCells)) {
      if (!visibleActual.some((column) => column.key === key)) {
        actualMismatches.push({ column: key, expected: '(no such source column)', grid: describeCell(grid.actualCells[key]), outcome: 'kind_mismatch' })
        values.kindMismatches += 1
      }
    }

    // Scheduled cells.
    const scheduledMismatches: RowDetail['scheduledMismatches'] = []
    for (const column of scheduled) {
      const sourceColumn = table.columns.find((candidate) => candidate.letter === column.letter)
      const cell = sourceColumn ? row.cellByColumn.get(sourceColumn.column) : undefined
      const expected = expectedScheduledCell(cell)
      const outcome = compareCells(expected, grid.scheduledCells[column.key])
      schedule.cellsCompared += 1
      if (outcome === 'blank_preserved') schedule.blanks += 1
      if (MISMATCH_OUTCOMES.has(outcome)) {
        schedule.mismatches += 1
        scheduledMismatches.push({
          column: `${column.letter} ${JSON.stringify(column.label)}`,
          expected: describeCell(expected),
          grid: describeCell(grid.scheduledCells[column.key]),
          outcome,
        })
      } else {
        schedule.matched += 1
      }
    }
    for (const key of Object.keys(grid.scheduledCells)) {
      if (!scheduled.some((column) => column.key === key)) {
        schedule.mismatches += 1
        scheduledMismatches.push({ column: key, expected: '(no such source column)', grid: describeCell(grid.scheduledCells[key]), outcome: 'kind_mismatch' })
      }
    }

    // Payments: grid entries vs hosted rows vs the workbook's planned payments.
    const hostedForRecord = hostedPaymentsByRecord.get(id) ?? []
    const plannedForRecord = plannedPaymentsByRecordId.get(id) ?? []
    const paymentNotes: string[] = []
    payments.gridPayments += grid.payments.length
    payments.hostedPayments += hostedForRecord.length
    payments.plannedPayments += plannedForRecord.length
    if (grid.payments.length !== hostedForRecord.length) paymentNotes.push('grid payment count differs from hosted')
    if (hostedForRecord.length !== plannedForRecord.length) paymentNotes.push('hosted payment count differs from workbook')
    const gridPaymentById = new Map(grid.payments.map((payment) => [payment.id, payment]))
    for (const planned of plannedForRecord) {
      const paymentId = entityId(paymentSourceKey(hash, planned.legacySourceSheet, planned.legacySourceRow))
      const hostedRow = hostedForRecord.find((payment) => payment.id === paymentId)
      const gridEntry = gridPaymentById.get(paymentId)
      if (!hostedRow) {
        paymentNotes.push(`planned payment ${paymentId} not hosted`)
        continue
      }
      if (!gridEntry) {
        paymentNotes.push(`hosted payment ${paymentId} absent from drawer`)
        continue
      }
      const hostedAmount = hostedRow.amount === null ? null : Number(hostedRow.amount)
      if (planned.amount === null || hostedAmount === null || Math.abs(planned.amount - hostedAmount) > EPSILON) {
        paymentNotes.push(`amount differs for ${paymentId}`)
      }
      if (gridEntry.amount.kind !== 'amount' || hostedAmount === null || Math.abs(gridEntry.amount.amount - hostedAmount) > EPSILON) {
        paymentNotes.push(`drawer amount differs for ${paymentId}`)
      }
      if ((planned.paymentDate ?? null) !== (hostedRow.payment_date ?? null)) paymentNotes.push(`date differs for ${paymentId}`)
      if ((gridEntry.date ?? null) !== (hostedRow.payment_date ?? null)) paymentNotes.push(`drawer date differs for ${paymentId}`)
      // Method spelling: exact, untrimmed against hosted; the drawer trims for display only.
      if ((planned.paymentMethod ?? null) !== (hostedRow.payment_method ?? null)) paymentNotes.push(`method spelling differs for ${paymentId}`)
      if ((gridEntry.method ?? null) !== (hostedRow.payment_method?.trim() || null)) paymentNotes.push(`drawer method differs for ${paymentId}`)
      const plannedReceipt = (planned.legacyRawJson as { receipt_sent?: unknown }).receipt_sent
      if ((plannedReceipt ?? null) !== (hostedRow.legacy_receipt_sent ?? null)) paymentNotes.push(`receipt value differs for ${paymentId}`)
      if ((gridEntry.legacyReceiptSent ?? null) !== (hostedRow.legacy_receipt_sent?.trim() || null)) paymentNotes.push(`drawer receipt value differs for ${paymentId}`)
    }
    if (paymentNotes.length > 0) payments.mismatches += 1

    // Receipt status, recomputed from the hosted receipt values by the rule.
    const stated = hostedForRecord
      .map((payment) => payment.legacy_receipt_sent?.trim().toLowerCase() ?? '')
      .filter((value) => value !== '')
    const expectedStatus =
      stated.length === 0 ? 'unknown' : stated.every((value) => value === 'yes') ? 'sent' : stated.every((value) => value === 'no') ? 'not_sent' : 'mixed'
    receipts.byStatus[grid.receiptStatus] = (receipts.byStatus[grid.receiptStatus] ?? 0) + 1
    if (expectedStatus !== grid.receiptStatus) receipts.mismatches += 1

    rowDetails.push({
      sourceRow: row.row,
      financeRecordId: id,
      matched: true,
      studentNumberSource: row.studentNumber,
      studentNumberGrid: grid.studentNumber,
      nameSource: batchSheetName,
      nameGrid: grid.studentName,
      nameSourceKind: nameKind,
      fee: { expected: describeCell(expectedFee), grid: describeCell(grid.legacyTotalFee), outcome: feeOutcome },
      paid: { expected: describeCell(expectedPaid), grid: describeCell(grid.legacyTotalPaid), outcome: paidOutcome },
      balance: { expected: describeCell(expectedBalance), grid: describeCell(grid.legacyBalance), outcome: balanceOutcome },
      actualMismatches,
      scheduledMismatches,
      receipt: { expected: expectedStatus, grid: grid.receiptStatus, ok: expectedStatus === grid.receiptStatus },
      payments: {
        hosted: hostedForRecord.length,
        grid: grid.payments.length,
        planned: plannedForRecord.length,
        ok: paymentNotes.length === 0,
        notes: paymentNotes,
      },
      legacyFlags: grid.legacyFlags,
    })
  }

  const extra = built.rows.filter((row) => !expectedIds.has(row.financeRecordId)).length
  if (missing > 0) reasons.push(`${missing} source student row(s) have no grid row`)
  if (extra > 0) reasons.push(`${extra} grid row(s) correspond to no source student row`)
  if (numbers.mismatches > 0) reasons.push(`${numbers.mismatches} student number(s) differ`)
  if (snapshots.feeMismatches + snapshots.paidMismatches + snapshots.balanceMismatches > 0) {
    reasons.push(`snapshot mismatches: fee ${snapshots.feeMismatches}, paid ${snapshots.paidMismatches}, balance ${snapshots.balanceMismatches}`)
  }
  const valueMismatchTotal = values.valueMismatches + values.blankZeroMismatches + values.signMismatches + values.kindMismatches
  if (valueMismatchTotal > 0) reasons.push(`${valueMismatchTotal} ACTUAL cell mismatch(es)`)
  if (schedule.mismatches > 0) reasons.push(`${schedule.mismatches} scheduled cell mismatch(es)`)
  if (receipts.mismatches > 0) reasons.push(`${receipts.mismatches} receipt status mismatch(es)`)
  if (payments.mismatches > 0) reasons.push(`${payments.mismatches} row(s) with drawer/payment mismatches`)

  // --- Columns ---------------------------------------------------------------
  const columnMismatches: string[] = []
  const gridActual = built.columns
  if (gridActual.length !== visibleActual.length) {
    columnMismatches.push(`ACTUAL: grid shows ${gridActual.length} columns, workbook has ${visibleActual.length} visible`)
  }
  visibleActual.forEach((column, index) => {
    const got = gridActual[index]
    if (!got) return
    if (got.key !== column.key) columnMismatches.push(`ACTUAL position ${index + 1}: grid ${got.key}, workbook ${column.key}`)
    else if (got.label !== column.label) columnMismatches.push(`ACTUAL ${column.key}: grid label ${JSON.stringify(got.label)}, workbook ${JSON.stringify(column.label)}`)
    if (got.origin !== 'manifest') columnMismatches.push(`ACTUAL ${got.key}: origin ${got.origin}, expected manifest`)
    if (got.valueKind !== 'money') columnMismatches.push(`ACTUAL ${got.key}: value kind ${got.valueKind}`)
  })
  const gridScheduled = built.scheduledColumns
  if (gridScheduled.length !== scheduled.length) {
    columnMismatches.push(`INSTALLMENT: grid shows ${gridScheduled.length} columns, workbook has ${scheduled.length}`)
  }
  scheduled.forEach((column, index) => {
    const got = gridScheduled[index]
    if (!got) return
    if (got.key !== column.key) columnMismatches.push(`INSTALLMENT position ${index + 1}: grid ${got.key}, workbook ${column.key}`)
    else if (got.label !== column.label) columnMismatches.push(`INSTALLMENT ${column.key}: grid label ${JSON.stringify(got.label)}, workbook ${JSON.stringify(column.label)}`)
    if (got.order !== column.order) columnMismatches.push(`INSTALLMENT ${column.key}: order ${got.order}, expected ${column.order}`)
    if (got.origin !== 'manifest') columnMismatches.push(`INSTALLMENT ${got.key}: origin ${got.origin}, expected manifest`)
  })
  const derivedColumnsInGrid = [...gridActual, ...gridScheduled].filter((column) => column.origin === 'derived').length
  if (built.layoutSource !== 'manifest') columnMismatches.push(`layout source is ${built.layoutSource}`)
  if (columnMismatches.length > 0) reasons.push(`columns: ${columnMismatches.join('; ')}`)

  // --- All-blank structural columns -----------------------------------------
  const expectedBlankVisible = [...visibleActual, ...scheduled].filter((column) => column.allBlank)
  const expectedBlankHidden = actualColumns.filter((column) => !column.visible && column.allBlank)
  const allBlankOk = expectedBlankVisible.length === built.blankStructuralColumns
  if (!allBlankOk) reasons.push(`all-blank columns: grid reports ${built.blankStructuralColumns}, workbook has ${expectedBlankVisible.length}`)

  // --- Totals ----------------------------------------------------------------
  const sumOf = (cells: MoneyCell[]) => {
    let cents = 0
    let counted = 0
    for (const cell of cells) {
      if (cell.kind !== 'amount') continue
      cents += Math.round(cell.amount * 100)
      counted += 1
    }
    return { total: counted === 0 ? null : cents / 100, missing: cells.length - counted }
  }
  const expectedFees = sumOf(sourceRows.map((row) => figureToCell(readLegacyFigure(row, summary.totalFee).value)))
  const expectedPaidTotal = sumOf(sourceRows.map((row) => figureToCell(readLegacyFigure(row, summary.totalPaid).value)))
  const expectedBalanceTotal = sumOf(sourceRows.map((row) => figureToCell(readLegacyFigure(row, summary.balance).value)))
  const totalsNotes: string[] = []
  const checkTotal = (label: string, expected: { total: number | null; missing: number }, got: MoneyCell, missing: number) => {
    const gotAmount = got.kind === 'amount' ? got.amount : null
    if (expected.total === null ? gotAmount !== null : gotAmount === null || Math.abs(gotAmount - expected.total) > EPSILON) {
      totalsNotes.push(`${label}: grid ${gotAmount ?? 'blank'}, workbook ${expected.total ?? 'blank'}`)
    }
    if (expected.missing !== missing) totalsNotes.push(`${label} missing count: grid ${missing}, workbook ${expected.missing}`)
  }
  checkTotal('total fees', expectedFees, built.totals.totalFees, built.totals.feesMissing)
  checkTotal('total paid', expectedPaidTotal, built.totals.totalPaid, built.totals.paidMissing)
  checkTotal('balance', expectedBalanceTotal, built.totals.balance, built.totals.balanceMissing)
  if (built.totals.students !== sourceRows.length) totalsNotes.push(`students: grid ${built.totals.students}, workbook ${sourceRows.length}`)
  if (totalsNotes.length > 0) reasons.push(`summary strip: ${totalsNotes.join('; ')}`)

  // --- Manifest, field by field against the workbook-derived plan -----------
  const plannedManifest = planTableManifest(hash, entry)
  const manifestMismatches: string[] = []
  const hostedById = new Map(hostedManifest.map((row) => [row.id, row]))
  for (const planned of plannedManifest) {
    const row = hostedById.get(planned.id)
    if (!row) {
      manifestMismatches.push(`missing hosted row for ${planned.section}:${planned.sourceColumnLetter}`)
      continue
    }
    const checks: [string, unknown, unknown][] = [
      ['section', row.section, planned.section],
      ['letter', row.source_column_letter, planned.sourceColumnLetter],
      ['header', row.source_header, planned.sourceHeader],
      ['inherited', row.source_header_inherited, planned.sourceHeaderInherited],
      ['key', row.column_key, planned.columnKey],
      ['role', row.normalized_role, planned.normalizedRole],
      ['kind', row.value_kind, planned.valueKind],
      ['order', row.display_order, planned.displayOrder],
      ['visible', row.is_grid_visible, planned.isGridVisible],
      ['even_if_blank', row.display_even_if_blank, planned.displayEvenIfBlank],
      ['origin', row.origin, planned.origin],
      ['sheet', row.legacy_sheet_name, planned.legacySheetName],
      ['table', row.legacy_table_key, planned.legacyTableKey],
      ['hash', row.source_workbook_hash, planned.sourceWorkbookHash],
      ['batch', row.batch_id, planned.batchId],
    ]
    for (const [field, got, want] of checks) {
      if (got !== want) manifestMismatches.push(`${planned.columnKey} ${field}: hosted ${JSON.stringify(got)}, workbook ${JSON.stringify(want)}`)
    }
  }
  if (hostedManifest.length !== plannedManifest.length) {
    manifestMismatches.push(`hosted has ${hostedManifest.length} rows, workbook plan has ${plannedManifest.length}`)
  }
  if (manifestMismatches.length > 0) reasons.push(`manifest: ${manifestMismatches.length} field mismatch(es)`)

  // --- ECEA ------------------------------------------------------------------
  let ecea: BatchResult['ecea'] = null
  if (entry.programShortCode === 'ECEA') {
    const notes: string[] = []
    if (built.scheduledColumns.length !== 0) notes.push(`grid shows ${built.scheduledColumns.length} scheduled columns; expected none`)
    if (hostedInstallments.length !== 0) notes.push(`${hostedInstallments.length} hosted installments exist for ECEA`)
    const balanceColumn = built.columns.find((column) => column.role === 'balance')
    if (!balanceColumn) notes.push('Balance column not present in the ACTUAL group')
    else if (!built.rows.every((row) => (row.actualCells[balanceColumn.key]?.kind ?? 'blank') === 'blank')) {
      notes.push('Balance column holds a value for some student')
    }
    if (!built.rows.every((row) => row.legacyBalance.kind === 'blank')) notes.push('legacy balance is not blank for every student')
    if (built.totals.balance.kind !== 'blank') notes.push('batch balance total is not blank')
    if (built.balanceConvention.filterable) notes.push('balance filters are enabled')
    for (const label of ['Enrollment fees', '1st Installment', '2nd Installment', 'Late fees']) {
      if (!built.columns.some((column) => column.label.toLowerCase() === label.toLowerCase())) notes.push(`ordinal column ${JSON.stringify(label)} not in the ACTUAL group`)
    }
    ecea = { checked: true, notes, ok: notes.length === 0 }
    if (notes.length > 0) reasons.push(`ECEA: ${notes.join('; ')}`)
  }

  return {
    batchName: hostedBatch.name,
    batchCode,
    program: entry.programShortCode,
    hostedBatchId: hostedBatch.id,
    identity: { ok: identityNotes.length === 0, notes: identityNotes },
    rows: { source: sourceRows.length, grid: built.rows.length, matched, missing, extra },
    studentNumbers: numbers,
    names,
    columns: {
      sourceActualTotal: actualColumns.length,
      sourceActualVisible: visibleActual.length,
      sourceActualHidden: actualColumns.length - visibleActual.length,
      gridActual: gridActual.length,
      sourceScheduled: scheduled.length,
      gridScheduled: gridScheduled.length,
      mismatches: columnMismatches,
      derivedColumnsInGrid,
    },
    allBlankColumns: {
      expectedVisible: expectedBlankVisible.length,
      expectedHidden: expectedBlankHidden.length,
      gridReported: built.blankStructuralColumns,
      ok: allBlankOk,
      expectedList: expectedBlankVisible.map((column) => `${column.key} ${JSON.stringify(column.label)}`),
    },
    values,
    snapshots: {
      ...snapshots,
      balanceSource: summary.evidence.find((line) => line.startsWith('legacy_balance')) ?? '',
    },
    schedule,
    receipts,
    payments,
    totals: {
      ok: totalsNotes.length === 0,
      fees: expectedFees.total === null ? 'blank' : String(expectedFees.total),
      paid: expectedPaidTotal.total === null ? 'blank' : String(expectedPaidTotal.total),
      balance: expectedBalanceTotal.total === null ? 'blank' : String(expectedBalanceTotal.total),
      feesMissing: built.totals.feesMissing,
      paidMissing: built.totals.paidMissing,
      balanceMissing: built.totals.balanceMissing,
      notes: totalsNotes,
    },
    manifest: { planned: plannedManifest.length, hosted: hostedManifest.length, mismatches: manifestMismatches },
    balanceConvention: built.balanceConvention.convention,
    ecea,
    status: reasons.length === 0 ? 'PASS' : 'REVIEW',
    reasons,
    rowDetails,
  }
}

// -----------------------------------------------------------------------------
// Unassigned audit
// -----------------------------------------------------------------------------

interface UnassignedCandidate {
  financeRecordId: string
  studentNumber: string | null
  program: string
  unassignedReason: string
  paymentCount: number
  paymentTotal: number
  trackerBatchDates: string[]
  candidateBatchTables: { batchName: string; code: string }[]
  /**
   * Whether a human plausibly has enough to decide, and why. Nothing here
   * assigns anything: it grades the evidence a later reconciliation screen
   * could put in front of a person.
   */
  assessment: 'human_assignable' | 'month_hint_only' | 'genuinely_uncertain'
  assessmentNote: string
  /** Batches whose month and year match the Tracker Master batch text. */
  monthHintBatches: string[]
}

interface UnassignedAudit {
  totalRecords: number
  totalStudents: number
  totalPayments: number
  numberedStudents: number
  unresolvedStudents: number
  byProgram: Record<string, number>
  byReason: Record<string, number>
  humanAssignable: number
  monthHintOnly: number
  genuinelyUncertain: number
  candidates: UnassignedCandidate[]
  gridView: {
    program: string
    rows: number
    layoutSource: string
    columns: number
    scheduledColumns: number
    balanceFilterable: boolean
    receiptByStatus: Record<string, number>
    unresolvedRows: number
    legacyFlags: Record<string, number>
  }[]
}

function auditUnassigned(
  hash: string,
  plan: DryRunPlan,
  tables: readonly SupportedBatchTable[],
  hosted: HostedData,
): UnassignedAudit {
  const records = hosted.records.filter((record) => record.batch_id === null)
  const programById = new Map(hosted.programs.map((program) => [program.id, program]))
  const batchById = new Map(hosted.batches.map((batch) => [batch.id, batch]))

  // Where each numbered student appears in a batch table, per program.
  const appearances = new Map<string, { batchName: string; code: string; program: string }[]>()
  for (const entry of tables) {
    const batchId = entityId(batchSourceKey(hash, entry.table.sheetName, entry.table.key))
    const batch = batchById.get(batchId)
    for (const row of studentRows(entry.table)) {
      if (row.studentNumber === null) continue
      const list = appearances.get(row.studentNumber) ?? []
      list.push({
        batchName: batch?.name ?? `${entry.table.sheetName}!${entry.table.key}`,
        code: `${entry.table.sheetName}!${entry.table.key}`,
        program: entry.programShortCode,
      })
      appearances.set(row.studentNumber, list)
    }
  }

  const plannedById = new Map(plan.financeRecords.map((record) => [entityId(record.sourceKey), record]))
  const plannedPaymentsByRecordId = new Map<string, DryRunPlan['payments']>()
  for (const payment of plan.payments) {
    if (payment.financeRecordSourceKey === null) continue
    const id = entityId(payment.financeRecordSourceKey)
    const list = plannedPaymentsByRecordId.get(id) ?? []
    list.push(payment)
    plannedPaymentsByRecordId.set(id, list)
  }
  const paymentsByRecord = new Map<string, RawPayment[]>()
  for (const payment of hosted.payments) {
    const list = paymentsByRecord.get(payment.student_finance_record_id) ?? []
    list.push(payment)
    paymentsByRecord.set(payment.student_finance_record_id, list)
  }

  const candidates: UnassignedCandidate[] = []
  const byProgram: Record<string, number> = {}
  const byReason: Record<string, number> = {}
  const students = new Set<string>()
  let totalPayments = 0
  let numbered = 0

  for (const record of records) {
    const planned = plannedById.get(record.id)
    const raw = (planned?.legacyRawJson ?? (record.legacy_raw_json as Record<string, unknown>) ?? {}) as Record<string, unknown>
    const program =
      programById.get(record.program_id)?.short_code ??
      String(raw.program_short_code ?? planned?.programShortCode ?? 'unknown')
    const studentNumber = record.student?.student_number?.trim() || null
    const reason = String(raw.unassigned_reason ?? 'unknown')
    const payments = paymentsByRecord.get(record.id) ?? []
    const plannedPayments = plannedPaymentsByRecordId.get(record.id) ?? []

    students.add(record.student_id)
    totalPayments += payments.length
    if (studentNumber !== null) numbered += 1
    byProgram[program] = (byProgram[program] ?? 0) + 1
    byReason[reason] = (byReason[reason] ?? 0) + 1

    const trackerDates = [
      ...new Set(
        plannedPayments
          .map((payment) => (payment.legacyRawJson as { batch?: { formatted_text?: unknown } }).batch?.formatted_text)
          .filter((value): value is string => typeof value === 'string' && value.trim() !== ''),
      ),
    ]
    const tables = studentNumber === null ? [] : (appearances.get(studentNumber) ?? []).filter((entry) => entry.program === program)

    // Tracker Master's Batch cell reads like "Aug-25": a month and a year,
    // never a day, so it can point at a Morning/Evening pair and never
    // choose between them. Matched against a batch's start date, or, for
    // the six undated batches, against the month and year its name states.
    const monthHintBatches = hosted.batches
      .filter((batch) => programById.get(batch.program_id)?.short_code === program)
      .filter((batch) => trackerDates.some((text) => batchMatchesMonthText(batch, text)))
      .map((batch) => batch.name)

    let assessment: UnassignedCandidate['assessment']
    let assessmentNote: string
    if (studentNumber === null) {
      assessment = 'genuinely_uncertain'
      assessmentNote = 'no student number; nothing ties the record to a batch table'
    } else if (tables.length >= 1) {
      assessment = 'human_assignable'
      assessmentNote = `student appears in ${tables.length} batch table(s) for ${program}; a person can choose among them` +
        (monthHintBatches.length > 0 ? `; the Tracker Master batch month points at ${monthHintBatches.length} of the program's batches` : '')
    } else if (monthHintBatches.length > 0) {
      assessment = 'month_hint_only'
      assessmentNote = `student appears in no batch table; only the Tracker Master batch month (${trackerDates.join(', ')}) points at ${monthHintBatches.length} batch(es), which cannot tell Morning from Evening`
    } else if (trackerDates.length > 0) {
      assessment = 'genuinely_uncertain'
      assessmentNote = `student appears in no batch table and the Tracker Master batch month (${trackerDates.join(', ')}) matches no batch`
    } else {
      assessment = 'genuinely_uncertain'
      assessmentNote = 'student appears in no batch table and Tracker Master states no batch month'
    }

    candidates.push({
      financeRecordId: record.id,
      studentNumber,
      program,
      unassignedReason: reason,
      paymentCount: payments.length,
      paymentTotal: payments.reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0),
      trackerBatchDates: trackerDates,
      candidateBatchTables: tables.map(({ batchName, code }) => ({ batchName, code })),
      assessment,
      assessmentNote,
      monthHintBatches,
    })
  }

  // The unassigned view, as the grid would build it, per program.
  const gridView: UnassignedAudit['gridView'] = []
  for (const program of hosted.programs) {
    const programRecords = records.filter((record) => record.program_id === program.id)
    if (programRecords.length === 0) continue
    const ids = new Set(programRecords.map((record) => record.id))
    const built = buildFinanceGrid({
      records: programRecords,
      installments: hosted.installments.filter((row) => ids.has(row.student_finance_record_id)),
      payments: hosted.payments.filter((row) => ids.has(row.student_finance_record_id)),
      manifest: [],
      programShortCode: program.short_code,
      batchName: null,
    })
    gridView.push({
      program: program.short_code,
      rows: built.rows.length,
      layoutSource: built.layoutSource,
      columns: built.columns.length,
      scheduledColumns: built.scheduledColumns.length,
      balanceFilterable: built.balanceConvention.filterable,
      receiptByStatus: countBy(built.rows.map((row) => row.receiptStatus)),
      unresolvedRows: built.rows.filter((row) => row.studentNumber === null).length,
      legacyFlags: countBy(built.rows.flatMap((row) => row.legacyFlags)),
    })
  }

  return {
    totalRecords: records.length,
    totalStudents: students.size,
    totalPayments,
    numberedStudents: numbered,
    unresolvedStudents: records.length - numbered,
    byProgram,
    byReason,
    humanAssignable: candidates.filter((candidate) => candidate.assessment === 'human_assignable').length,
    monthHintOnly: candidates.filter((candidate) => candidate.assessment === 'month_hint_only').length,
    genuinelyUncertain: candidates.filter((candidate) => candidate.assessment === 'genuinely_uncertain').length,
    candidates,
    gridView,
  }
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/**
 * Whether a batch is the month and year a Tracker Master Batch cell names.
 *
 * The cell text is `Mon-YY`. A batch matches on its start date's month and
 * year, or, where the importer refused to invent a start date, on its name
 * stating that month with a year ending in the same two digits or no year
 * at all ("December - Evening"). Deliberately loose in the human's favour,
 * and never used to assign anything.
 */
function batchMatchesMonthText(batch: HostedBatch, text: string): boolean {
  const match = /^([A-Za-z]{3,9})[-\s']+(\d{2,4})$/.exec(text.trim())
  if (!match) return false
  const month = MONTH_NAMES.findIndex((name) => name.startsWith(match[1].toLowerCase().slice(0, 3)))
  if (month === -1) return false
  const yearDigits = match[2].slice(-2)

  if (batch.start_date !== null) {
    return (
      batch.start_date.slice(5, 7) === String(month + 1).padStart(2, '0') &&
      batch.start_date.slice(2, 4) === yearDigits
    )
  }

  const name = batch.name.toLowerCase()
  if (!new RegExp(`\\b${MONTH_NAMES[month]}\\b`).test(name)) return false
  const yearInName = /\b(\d{2,4})\b/.exec(name)
  return yearInName === null || yearInName[1].slice(-2) === yearDigits
}

// -----------------------------------------------------------------------------
// Aggregate report
// -----------------------------------------------------------------------------

function renderAggregate(
  results: BatchResult[],
  manifestCounts: Record<string, number | string>,
  unassigned: UnassignedAudit,
  hostedCounts: Record<string, number>,
  session: { email: string; appRole: string | null; projectRef: string },
): string {
  const header = [
    '| Batch | Program | Source rows | Grid rows | Matched | Missing | Extra | Source cols (A+I) | Grid cols (A+I) | Column mismatches | Value mismatches | Blank/zero mismatches | Schedule mismatches | Status |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ]
  const rows = results.map((result) => {
    const valueMismatches = result.values.valueMismatches + result.values.signMismatches + result.values.kindMismatches +
      result.snapshots.feeMismatches + result.snapshots.paidMismatches + result.snapshots.balanceMismatches
    return `| ${result.batchName} | ${result.program} | ${result.rows.source} | ${result.rows.grid} | ${result.rows.matched} | ${result.rows.missing} | ${result.rows.extra} | ${result.columns.sourceActualVisible}+${result.columns.sourceScheduled} | ${result.columns.gridActual}+${result.columns.gridScheduled} | ${result.columns.mismatches.length} | ${valueMismatches} | ${result.values.blankZeroMismatches} | ${result.schedule.mismatches} | ${result.status} |`
  })

  const totals = results.reduce(
    (sum, result) => ({
      source: sum.source + result.rows.source,
      grid: sum.grid + result.rows.grid,
      matched: sum.matched + result.rows.matched,
      cells: sum.cells + result.values.cellsCompared,
      blanks: sum.blanks + result.values.blanksPreserved,
      zeros: sum.zeros + result.values.zerosPreserved,
      negatives: sum.negatives + result.values.negativesPreserved,
      amounts: sum.amounts + result.values.amountsMatched,
      text: sum.text + result.values.textCells,
      errors: sum.errors + result.values.errorCells,
      valueMismatches: sum.valueMismatches + result.values.valueMismatches + result.values.signMismatches + result.values.kindMismatches,
      blankZero: sum.blankZero + result.values.blankZeroMismatches,
      scheduleCells: sum.scheduleCells + result.schedule.cellsCompared,
      scheduleBlanks: sum.scheduleBlanks + result.schedule.blanks,
      scheduleMismatches: sum.scheduleMismatches + result.schedule.mismatches,
      snapshotMismatches: sum.snapshotMismatches + result.snapshots.feeMismatches + result.snapshots.paidMismatches + result.snapshots.balanceMismatches,
      negativeBalances: sum.negativeBalances + result.snapshots.negativeBalances,
      zeroPaid: sum.zeroPaid + result.snapshots.zeroPaid,
      receiptMismatches: sum.receiptMismatches + result.receipts.mismatches,
      paymentMismatches: sum.paymentMismatches + result.payments.mismatches,
      gridPayments: sum.gridPayments + result.payments.gridPayments,
      hostedPayments: sum.hostedPayments + result.payments.hostedPayments,
      plannedPayments: sum.plannedPayments + result.payments.plannedPayments,
      unresolved: sum.unresolved + result.studentNumbers.gridUnresolved,
      nameBatch: sum.nameBatch + result.names.batchSheetSpelling,
      nameBatchWhitespace: sum.nameBatchWhitespace + result.names.batchSheetWhitespace,
      nameTracker: sum.nameTracker + result.names.trackerMasterSpelling,
      nameOther: sum.nameOther + result.names.other,
      manifestMismatches: sum.manifestMismatches + result.manifest.mismatches.length,
      allBlankVisible: sum.allBlankVisible + result.allBlankColumns.expectedVisible,
      allBlankHidden: sum.allBlankHidden + result.allBlankColumns.expectedHidden,
    }),
    {
      source: 0, grid: 0, matched: 0, cells: 0, blanks: 0, zeros: 0, negatives: 0, amounts: 0, text: 0, errors: 0,
      valueMismatches: 0, blankZero: 0, scheduleCells: 0, scheduleBlanks: 0, scheduleMismatches: 0, snapshotMismatches: 0,
      negativeBalances: 0, zeroPaid: 0, receiptMismatches: 0, paymentMismatches: 0, gridPayments: 0, hostedPayments: 0,
      plannedPayments: 0, unresolved: 0, nameBatch: 0, nameBatchWhitespace: 0, nameTracker: 0, nameOther: 0, manifestMismatches: 0,
      allBlankVisible: 0, allBlankHidden: 0,
    },
  )

  const receiptTotals: Record<string, number> = {}
  for (const result of results) {
    for (const [status, count] of Object.entries(result.receipts.byStatus)) {
      receiptTotals[status] = (receiptTotals[status] ?? 0) + count
    }
  }

  const lines = [
    '# FINANCE-GRID-03B reconciliation — aggregate (no PII)',
    '',
    `Session: authenticated ${session.appRole ?? 'unknown'} via RLS on project ${session.projectRef}; service role used only to mint the one-time token.`,
    '',
    '## Hosted baseline counts (as read under RLS)',
    '',
    ...Object.entries(hostedCounts).map(([table, count]) => `- ${table}: ${count}`),
    '',
    '## Per batch',
    '',
    ...header,
    ...rows,
    '',
    `PASS: ${results.filter((result) => result.status === 'PASS').length} / ${results.length}`,
    `REVIEW: ${results.filter((result) => result.status === 'REVIEW').length}`,
    '',
    '## Review reasons',
    '',
    ...results.filter((result) => result.status === 'REVIEW').flatMap((result) => result.reasons.map((reason) => `- ${result.batchName}: ${reason}`)),
    ...(results.every((result) => result.status === 'PASS') ? ['- none'] : []),
    '',
    '## Totals across all batches',
    '',
    `- source student rows: ${totals.source}; grid rows: ${totals.grid}; matched by deterministic id: ${totals.matched}`,
    `- ACTUAL cells compared: ${totals.cells} — blanks preserved ${totals.blanks}, zeros preserved ${totals.zeros}, negatives preserved ${totals.negatives}, positive amounts matched ${totals.amounts}, text cells ${totals.text}, error cells ${totals.errors}`,
    `- ACTUAL value mismatches: ${totals.valueMismatches}; blank-vs-zero mismatches: ${totals.blankZero}`,
    `- snapshot (Total Fee / Total Paid / Balance) mismatches: ${totals.snapshotMismatches}; negative balances preserved: ${totals.negativeBalances}; recorded $0.00 Total Paid: ${totals.zeroPaid}`,
    `- scheduled cells compared: ${totals.scheduleCells} (${totals.scheduleBlanks} blank); schedule mismatches: ${totals.scheduleMismatches}`,
    `- receipt status mismatches: ${totals.receiptMismatches}; statuses: ${JSON.stringify(receiptTotals)}`,
    `- drawer payments: grid ${totals.gridPayments}, hosted ${totals.hostedPayments}, workbook-planned ${totals.plannedPayments}; rows with payment mismatches: ${totals.paymentMismatches}`,
    `- unresolved (no student number) rows in grids: ${totals.unresolved}`,
    `- display name source: batch-sheet spelling ${totals.nameBatch}, batch-sheet spelling with inner whitespace collapsed ${totals.nameBatchWhitespace}, Tracker Master spelling ${totals.nameTracker}, other ${totals.nameOther}`,
    `- all-blank structural columns: visible (restored) ${totals.allBlankVisible}, hidden text ${totals.allBlankHidden}`,
    `- manifest field mismatches (hosted vs workbook-derived): ${totals.manifestMismatches}`,
    '',
    '## Manifest',
    '',
    ...Object.entries(manifestCounts).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Unassigned audit',
    '',
    `- finance records: ${unassigned.totalRecords}`,
    `- students represented: ${unassigned.totalStudents}`,
    `- payments attached: ${unassigned.totalPayments}`,
    `- numbered students: ${unassigned.numberedStudents}; unresolved: ${unassigned.unresolvedStudents}`,
    `- by program: ${JSON.stringify(unassigned.byProgram)}`,
    `- by import reason: ${JSON.stringify(unassigned.byReason)}`,
    `- human-assignable (the student appears in one or more batch tables for the program): ${unassigned.humanAssignable}`,
    `- month hint only (in no batch table; Tracker Master names a month that matches a Morning/Evening pair): ${unassigned.monthHintOnly}`,
    `- genuinely uncertain (no student number, or a month that matches no batch): ${unassigned.genuinelyUncertain}`,
    `- grid view: ${JSON.stringify(unassigned.gridView)}`,
    '',
  ]
  return lines.join('\n')
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

async function main(): Promise<number> {
  const repoRoot = repoRootFromHere()
  const now = new Date()

  // --- Workbook --------------------------------------------------------------
  const source = openWorkbook(repoRoot, now)
  const hash = source.fingerprint.sha256
  console.log(`workbook: ${source.fingerprint.relativePath}`)
  console.log(`sha256:   ${hash}`)
  if (hash !== APPROVED_WORKBOOK_SHA256) {
    console.error('STOP: workbook hash differs from the approved import hash')
    return 2
  }

  const plan = buildDryRunPlan(repoRoot, now)
  const discovery = discoverBatchTables(source.workbook)
  console.log(`tables:   ${discovery.supported.length} supported, ${discovery.skipped.length} skipped`)

  // --- Hosted, authenticated -------------------------------------------------
  const session = await openHostedSession(repoRoot)
  console.log(`hosted:   project ${session.projectRef}, app role ${session.appRole ?? 'unknown'} (RLS enforced)`)

  const projection = readLoaderProjection(repoRoot)
  const hosted = await readHosted(session, projection)
  const hostedCounts = {
    programs: hosted.programs.length,
    batches: hosted.batches.length,
    student_finance_records: hosted.records.length,
    unassigned_finance_records: hosted.records.filter((record) => record.batch_id === null).length,
    students_with_a_finance_record: new Set(hosted.records.map((record) => record.student_id)).size,
    installments: hosted.installments.length,
    payments: hosted.payments.length,
    batch_finance_columns: hosted.manifest.length,
  }
  console.log(`          ${JSON.stringify(hostedCounts)}`)

  // Negative check: the same reads with no session must see nothing.
  const anonymousRecords = await session.anonymous.from('student_finance_records').select('id', { count: 'exact', head: true })
  const anonymousManifest = await session.anonymous.from('batch_finance_columns').select('id', { count: 'exact', head: true })
  const anonymousBlocked =
    (anonymousRecords.error !== null || (anonymousRecords.count ?? 0) === 0) &&
    (anonymousManifest.error !== null || (anonymousManifest.count ?? 0) === 0)
  console.log(`anon:     finance records visible ${anonymousRecords.count ?? 'error'}, manifest rows visible ${anonymousManifest.count ?? 'error'} → ${anonymousBlocked ? 'blocked' : 'NOT BLOCKED'}`)

  // --- Per batch -------------------------------------------------------------
  const batchById = new Map(hosted.batches.map((batch) => [batch.id, batch]))
  const programById = new Map(hosted.programs.map((program) => [program.id, program]))
  const results: BatchResult[] = []

  for (const entry of discovery.supported) {
    const batchId = entityId(batchSourceKey(hash, entry.table.sheetName, entry.table.key))
    const hostedBatch = batchById.get(batchId)
    if (!hostedBatch) {
      console.error(`no hosted batch for ${entry.table.sheetName}!${entry.table.key}`)
      continue
    }
    const program = programById.get(hostedBatch.program_id)

    // Exactly the loader's selection: records of this batch ordered by source
    // row, the batch's manifest, then children by record id.
    const records = hosted.records
      .filter((record) => record.batch_id === batchId)
      .sort((a, b) => (a.legacy_source_row ?? Number.MAX_SAFE_INTEGER) - (b.legacy_source_row ?? Number.MAX_SAFE_INTEGER))
    const ids = new Set(records.map((record) => record.id))
    const installments = hosted.installments.filter((row) => ids.has(row.student_finance_record_id))
    const payments = hosted.payments.filter((row) => ids.has(row.student_finance_record_id))
    const manifest = hosted.manifest
      .filter((row) => row.batch_id === batchId)
      .sort((a, b) => a.section.localeCompare(b.section) || a.display_order - b.display_order)

    const built = buildFinanceGrid({
      records,
      installments,
      payments,
      manifest,
      programShortCode: program?.short_code ?? '',
      batchName: hostedBatch.name,
    })

    results.push(
      reconcileBatch(hash, entry, plan, hosted, built, hostedBatch, program, records, installments, payments, manifest),
    )
  }

  // --- Manifest, globally ----------------------------------------------------
  const manifestPlan = planColumnManifest(
    hash,
    discovery.supported,
    hosted.batches.map((batch) => ({
      id: batch.id,
      code: batch.code,
      legacySheetName: batch.legacy_sheet_name,
      programShortCode: programById.get(batch.program_id)?.short_code ?? null,
    })),
  )
  const plannedIds = new Set(manifestPlan.rows.map((row) => row.id))
  const hostedIds = new Set(hosted.manifest.map((row) => row.id))
  const restored = manifestPlan.restoredColumns
  const hidden = manifestPlan.rows.filter((row) => !row.isGridVisible)
  const headersPreserved = manifestPlan.rows.filter((row) => {
    const hostedRow = hosted.manifest.find((candidate) => candidate.id === row.id)
    return hostedRow !== undefined && hostedRow.source_header === row.sourceHeader
  }).length
  const orderingOk = discovery.supported.every((entry) => {
    const batchId = entityId(batchSourceKey(hash, entry.table.sheetName, entry.table.key))
    const rows = hosted.manifest.filter((row) => row.batch_id === batchId)
    for (const section of ['actual', 'installment'] as const) {
      const inSection = rows.filter((row) => row.section === section).sort((a, b) => a.display_order - b.display_order)
      const letters = inSection.map((row) => row.source_column_letter ?? '')
      const sorted = [...letters].sort((a, b) => columnIndex(a) - columnIndex(b))
      if (letters.join(',') !== sorted.join(',')) return false
      if (inSection.some((row, index) => row.display_order !== index + 1)) return false
    }
    return true
  })
  const manifestCounts: Record<string, number | string> = {
    'workbook-derived rows': manifestPlan.rows.length,
    'hosted rows': hosted.manifest.length,
    'hosted rows matched to workbook-derived ids': [...hostedIds].filter((id) => plannedIds.has(id)).length,
    'hosted rows not in workbook plan': [...hostedIds].filter((id) => !plannedIds.has(id)).length,
    'workbook-planned rows missing from hosted': [...plannedIds].filter((id) => !hostedIds.has(id)).length,
    'ACTUAL rows (workbook / hosted)': `${manifestPlan.counts.actualRows} / ${hosted.manifest.filter((row) => row.section === 'actual').length}`,
    'INSTALLMENT rows (workbook / hosted)': `${manifestPlan.counts.installmentRows} / ${hosted.manifest.filter((row) => row.section === 'installment').length}`,
    'all-blank visible money columns restored': restored.length,
    'restored by role': JSON.stringify(countBy(restored.map((column) => column.role))),
    'hidden text rows (workbook / hosted)': `${hidden.length} / ${hosted.manifest.filter((row) => !row.is_grid_visible).length}`,
    'hidden by role': JSON.stringify(countBy(hidden.map((row) => row.normalizedRole))),
    'hidden rows with money kind': hidden.filter((row) => row.valueKind === 'money').length,
    'source headers preserved verbatim (hosted == workbook)': `${headersPreserved} / ${manifestPlan.rows.length}`,
    'display order equals sheet order in every batch and section': orderingOk ? 'yes' : 'NO',
    'plan blockers': manifestPlan.blockers.length,
  }

  // --- Unassigned ------------------------------------------------------------
  const unassigned = auditUnassigned(hash, plan, discovery.supported, hosted)

  // --- Outputs ---------------------------------------------------------------
  mkdirSync(path.join(repoRoot, PRIVATE_DIR), { recursive: true })
  const write = (name: string, value: unknown): string => {
    const target = path.join(repoRoot, PRIVATE_DIR, name)
    writeFileSync(target, `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`, 'utf8')
    return path.join(PRIVATE_DIR, name).split(path.sep).join('/')
  }
  const rowLevel = write('grid-reconciliation.json', {
    runAt: now.toISOString(),
    workbookHash: hash,
    projectRef: session.projectRef,
    sessionRole: session.appRole,
    hostedCounts,
    anonymousBlocked,
    results,
  })
  const unassignedPath = write('unassigned-audit.json', unassigned)
  const aggregate = renderAggregate(results, manifestCounts, unassigned, hostedCounts, session)
  const aggregatePath = write('aggregate.md', aggregate)

  console.log('')
  console.log(aggregate)
  console.log(`wrote ${rowLevel} (Git-ignored, row level)`)
  console.log(`wrote ${unassignedPath} (Git-ignored, row level)`)
  console.log(`wrote ${aggregatePath} (Git-ignored copy of the aggregate above)`)

  await session.signOut()

  const after = hashWorkbookOnDisk(repoRoot)
  if (after !== hash) {
    console.error(`WORKBOOK MODIFIED: hash before ${hash}, after ${after}`)
    return 3
  }
  console.log(`sha256 after: ${after} (unchanged)`)

  return results.every((result) => result.status === 'PASS') && anonymousBlocked ? 0 : 1
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function columnIndex(letter: string): number {
  let index = 0
  for (const character of letter.toUpperCase()) index = index * 26 + (character.charCodeAt(0) - 64)
  return index
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error)
      process.exit(1)
    },
  )
}

export { compareCells, expectedActualCell, expectedScheduledCell, type BatchResult, type CellOutcome }
