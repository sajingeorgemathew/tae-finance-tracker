import 'server-only'

import { createClient } from '@/lib/supabase/server'

import { raiseQueryError } from '../query.ts'
import {
  groupBatchesIntoIntakes,
  intakeForBatch,
  resolveRequestedIntake,
  sessionOfBatchName,
  UNASSIGNED_INTAKE,
  type FinanceIntake,
  type IntakeSelection,
} from './intake.ts'
import { combineBatchGrids, type BatchGridPart } from './intake-grid.ts'
import type { RawManifestColumn } from './manifest.ts'
import {
  buildFinanceGrid,
  type RawFinanceRecord,
  type RawInstallment,
  type RawPayment,
} from './view-model.ts'
import type { BatchOption, FinanceGridView, ProgramOption } from './types.ts'

/**
 * Loading the finance grid from hosted Supabase.
 *
 * ## Authorization
 *
 * The request-scoped client only, which carries the signed-in user's JWT, so
 * Row Level Security decides every row. The service-role key is never touched
 * here — it bypasses RLS entirely and using it to render a page would make the
 * policies decorative. Viewer, finance and admin can all read; this ticket
 * writes nothing at all.
 *
 * A consequence to keep in mind: a caller without finance access sees an empty
 * grid, not an error. Absence of rows is not proof that a batch is empty.
 *
 * ## Query strategy — seven requests, regardless of intake size
 *
 *   1. programs
 *   2. batches (with the legacy sheet name the intake grouping keys on)
 *   3. `batch_id` of every finance record, to count students per batch
 *   4. the selected intake's finance records — every underlying batch in one
 *      `in (...)` — with their student embedded, and
 *   5. the selected intake's column manifests, one `in (...)` — issued together
 *   6. installments and 7. payments for those records, by `in (...)`
 *
 * An intake is at most two batches (FINANCE-GRID-03C), and combining them adds
 * no request: steps 4 and 5 take every underlying batch id at once, steps 6
 * and 7 take every record id at once. Nothing loops over batches or students.
 * A Morning + Evening intake of 41 students costs the same round trips as a
 * single batch of 6. The unassigned view has no batch and so no manifest;
 * step 5 is skipped there.
 *
 * Step 3 reads one uuid column across all 397 finance records rather than
 * issuing a count per batch, which would be 23 requests to fill one dropdown.
 *
 * Payments are the one place a `legacy_raw_json` field is read, and only one
 * key of it: `receipt_sent`, extracted by the database with `->>` so the rest
 * of the payload — routing notes, workbook formulas, the row-local Balance Fees
 * formula — never crosses the wire at all.
 */

/** Intake records are small; this is a guard against a missing filter, not a page size. */
const RECORD_LIMIT = 500

/** Installments and payments per intake run to low hundreds. */
const CHILD_LIMIT = 2000

/** Every finance record, across batches. Only used to tally, so it is bounded high. */
const TALLY_LIMIT = 5000

const RECORD_COLUMNS = `
  id, student_id, batch_id, legacy_total_fee, legacy_total_paid, legacy_balance,
  legacy_source_row, legacy_raw_json,
  student:students (
    id, student_number, first_name, middle_name, last_name, display_name, legacy_name
  )`

const INSTALLMENT_COLUMNS =
  'id, student_finance_record_id, sequence_number, scheduled_amount, legacy_column_name, default_note, custom_note'

/**
 * `legacy_receipt_sent` is a projection of one JSON key, not the column.
 * PostgREST evaluates `->>` server-side, so the browser-bound view model is
 * built without the full payload ever being fetched. Tracker Master's
 * `Balance Fees` is not selected, here or anywhere.
 */
const PAYMENT_COLUMNS =
  'id, student_finance_record_id, amount, payment_date, payment_method, note, voided_at, legacy_receipt_sent:legacy_raw_json->>receipt_sent'

/**
 * The layout fields only, plus the batch each row belongs to so a two-batch
 * intake can be split back into its manifests. The workbook hash, sheet name
 * and table key stay in the database.
 */
const MANIFEST_COLUMNS =
  'batch_id, column_key, section, source_column_letter, source_header, normalized_role, value_kind, display_order, is_grid_visible, display_even_if_blank'

/** Two batches' layouts are a few dozen rows; this guards a missing filter. */
const MANIFEST_LIMIT = 500

export interface LoadFinanceGridOptions {
  /** Program short code from the URL, e.g. `'PSW'`. */
  program?: string | null
  /** Intake key from the URL, or `'unassigned'`. */
  intake?: string | null
  /**
   * A GRID-03 `?batch=<uuid>` (or `'unassigned'`), honoured for old links.
   * Ignored when `intake` is given. When it resolves, the view carries a
   * `legacyBatchRedirect` so the page can move the address bar to the new form.
   */
  batch?: string | null
}

type ManifestRowWithBatch = RawManifestColumn & { batch_id: string }

export async function loadFinanceGrid(
  options: LoadFinanceGridOptions = {},
): Promise<FinanceGridView> {
  const supabase = await createClient()

  // --- 1. Programs -----------------------------------------------------------
  const programsResult = await supabase
    .from('programs')
    .select('id, name, short_code')
    .eq('active', true)
    .order('short_code')

  if (programsResult.error) raiseQueryError('list programs', programsResult.error)

  const programs: ProgramOption[] = (programsResult.data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    shortCode: row.short_code as string,
  }))

  // --- 2. Batches ------------------------------------------------------------
  const batchesResult = await supabase
    .from('batches')
    .select('id, program_id, name, start_date, legacy_sheet_name')
    .eq('active', true)

  if (batchesResult.error) raiseQueryError('list batches', batchesResult.error)

  // --- 3. Student counts, in one request -------------------------------------
  const tallyResult = await supabase
    .from('student_finance_records')
    .select('batch_id, program_id')
    .range(0, TALLY_LIMIT - 1)

  if (tallyResult.error) raiseQueryError('count students per batch', tallyResult.error)

  const countByBatch = new Map<string, number>()
  const unassignedByProgram = new Map<string, number>()
  for (const row of tallyResult.data ?? []) {
    const batchId = row.batch_id as string | null
    if (batchId === null) {
      const programId = row.program_id as string
      unassignedByProgram.set(programId, (unassignedByProgram.get(programId) ?? 0) + 1)
    } else {
      countByBatch.set(batchId, (countByBatch.get(batchId) ?? 0) + 1)
    }
  }

  const programById = new Map(programs.map((program) => [program.id, program]))

  const batches: BatchOption[] = (batchesResult.data ?? [])
    .map((row) => {
      const programId = row.program_id as string
      const name = row.name as string
      return {
        id: row.id as string,
        programId,
        programShortCode: programById.get(programId)?.shortCode ?? '',
        name,
        startDate: (row.start_date as string | null) ?? null,
        legacySheetName: (row.legacy_sheet_name as string | null) ?? null,
        session: sessionOfBatchName(name),
        studentCount: countByBatch.get(row.id as string) ?? 0,
      }
    })
    // A batch whose program is inactive or unreadable has no place in a program
    // selector that only offers active programs.
    .filter((batch) => batch.programShortCode !== '')

  // --- Selection -------------------------------------------------------------
  const requestedProgram = options.program?.trim() || null
  const selectedProgram =
    requestedProgram === null || requestedProgram.toLowerCase() === 'all'
      ? (programs.find((program) => program.shortCode === 'PSW') ?? programs[0] ?? null)
      : (programs.find(
          (program) => program.shortCode.toLowerCase() === requestedProgram.toLowerCase(),
        ) ??
        programs.find((program) => program.shortCode === 'PSW') ??
        programs[0] ??
        null)

  const batchesInScope = selectedProgram
    ? batches.filter((batch) => batch.programId === selectedProgram.id)
    : batches

  const intakes: FinanceIntake[] = groupBatchesIntoIntakes(batchesInScope)

  const requestedIntake = options.intake?.trim() || null
  const legacyBatch = requestedIntake === null ? options.batch?.trim() || null : null

  const wantsUnassigned =
    requestedIntake === UNASSIGNED_INTAKE || legacyBatch === UNASSIGNED_INTAKE

  let resolved: IntakeSelection
  let legacyBatchRedirect: FinanceGridView['legacyBatchRedirect'] = null

  if (wantsUnassigned) {
    resolved = { intake: null, note: 'Showing records the import could not tie to a single batch.' }
  } else if (legacyBatch !== null) {
    // An old link names a real batch. Show the intake that contains it,
    // narrowed to that batch's session, and tell the page to canonicalise.
    const mapped = intakeForBatch(intakes, legacyBatch)
    if (mapped) {
      resolved = { intake: mapped.intake, note: 'Showing the intake that contains the batch named in the link.' }
      legacyBatchRedirect = { intakeKey: mapped.intake.key, session: mapped.session }
    } else {
      const fallback = resolveRequestedIntake(intakes, null)
      resolved = {
        intake: fallback.intake,
        note: `The requested batch is not available for this program. ${fallback.note}`,
      }
    }
  } else {
    resolved = resolveRequestedIntake(intakes, requestedIntake)
  }

  const unassignedCount = selectedProgram
    ? (unassignedByProgram.get(selectedProgram.id) ?? 0)
    : 0

  const emptyView: FinanceGridView = {
    programs,
    intakes,
    batches: batchesInScope,
    selectedProgram,
    selectedIntake: null,
    unassigned: wantsUnassigned,
    unassignedCount,
    selectionNote: resolved.note,
    legacyBatchRedirect,
    columns: [],
    scheduledColumns: [],
    layoutSource: 'none',
    blankStructuralColumns: 0,
    rows: [],
    totals: {
      students: 0,
      totalFees: { kind: 'blank' },
      totalPaid: { kind: 'blank' },
      balance: { kind: 'blank' },
      feesMissing: 0,
      paidMissing: 0,
      balanceMissing: 0,
    },
    balanceConvention: {
      convention: 'unverifiable',
      checked: 0,
      disagreeing: 0,
      filterable: false,
      note: 'No rows are loaded, so no balance convention could be established.',
    },
    batchConventions: [],
    statusCounts: { outstanding: 0, settled: 0, credit: 0, unknown: 0 },
    sessionCounts: { Morning: 0, Evening: 0 },
    truncated: false,
  }

  if (!wantsUnassigned && resolved.intake === null) return emptyView
  if (wantsUnassigned && (selectedProgram === null || unassignedCount === 0)) return emptyView

  const intake = resolved.intake
  const batchIds = intake?.underlyingBatchIds ?? []

  // --- 4 & 5. Finance records and the column manifests for the selection -----
  let recordQuery = supabase
    .from('student_finance_records')
    .select(RECORD_COLUMNS)
    .order('legacy_source_row', { nullsFirst: false })
    .range(0, RECORD_LIMIT - 1)

  if (wantsUnassigned) {
    recordQuery = recordQuery.is('batch_id', null).eq('program_id', selectedProgram!.id)
  } else {
    recordQuery = recordQuery.in('batch_id', batchIds)
  }

  // The manifests are the batches', not the rows', so they are fetched
  // alongside the records rather than after them — and once for the whole
  // intake, never per batch and never per student. The unassigned records
  // have no batch and therefore no manifest.
  const manifestQuery = wantsUnassigned
    ? Promise.resolve({ data: [] as ManifestRowWithBatch[], error: null })
    : supabase
        .from('batch_finance_columns')
        .select(MANIFEST_COLUMNS)
        .in('batch_id', batchIds)
        .order('section')
        .order('display_order')
        .range(0, MANIFEST_LIMIT - 1)

  const [recordsResult, manifestResult] = await Promise.all([recordQuery, manifestQuery])
  if (recordsResult.error) raiseQueryError('load finance records for intake', recordsResult.error)
  if (manifestResult.error) raiseQueryError('load column layout for intake', manifestResult.error)

  const records = (recordsResult.data ?? []) as unknown as RawFinanceRecord[]
  const manifest = (manifestResult.data ?? []) as unknown as ManifestRowWithBatch[]
  const recordIds = records.map((record) => record.id)

  if (recordIds.length === 0) {
    return { ...emptyView, selectedIntake: intake, selectionNote: resolved.note }
  }

  // --- 6 & 7. Installments and payments for exactly those records ------------
  const [installmentsResult, paymentsResult] = await Promise.all([
    supabase
      .from('installments')
      .select(INSTALLMENT_COLUMNS)
      .in('student_finance_record_id', recordIds)
      .order('sequence_number', { nullsFirst: false })
      .range(0, CHILD_LIMIT - 1),
    supabase
      .from('payments')
      .select(PAYMENT_COLUMNS)
      .in('student_finance_record_id', recordIds)
      .order('payment_date', { nullsFirst: false })
      .range(0, CHILD_LIMIT - 1),
  ])

  if (installmentsResult.error) {
    raiseQueryError('load installments for intake', installmentsResult.error)
  }
  if (paymentsResult.error) raiseQueryError('load payments for intake', paymentsResult.error)

  const installments = (installmentsResult.data ?? []) as unknown as RawInstallment[]
  const payments = (paymentsResult.data ?? []) as unknown as RawPayment[]

  // --- Build each real batch on its own, then place them side by side --------
  const programShortCode = selectedProgram?.shortCode ?? ''
  const parts: BatchGridPart[] = wantsUnassigned
    ? [
        {
          batchId: '',
          batchName: '',
          session: null,
          grid: buildFinanceGrid({
            records,
            installments,
            payments,
            manifest: [],
            programShortCode,
            batchName: null,
            batchId: null,
            session: null,
          }),
        },
      ]
    : intake!.batches.map((batch) => {
        const batchRecords = records.filter((record) => record.batch_id === batch.id)
        const batchRecordIds = new Set(batchRecords.map((record) => record.id))
        return {
          batchId: batch.id,
          batchName: batch.name,
          session: batch.session,
          grid: buildFinanceGrid({
            records: batchRecords,
            installments: installments.filter((item) => batchRecordIds.has(item.student_finance_record_id)),
            payments: payments.filter((item) => batchRecordIds.has(item.student_finance_record_id)),
            manifest: manifest.filter((row) => row.batch_id === batch.id),
            programShortCode,
            batchName: batch.name,
            batchId: batch.id,
            session: batch.session,
          }),
        }
      })

  const combined = combineBatchGrids(parts)

  return {
    programs,
    intakes,
    batches: batchesInScope,
    selectedProgram,
    selectedIntake: intake,
    unassigned: wantsUnassigned,
    unassignedCount,
    selectionNote: resolved.note,
    legacyBatchRedirect,
    ...combined,
    // A cap reached is reported rather than silently trimming a student's
    // history off the bottom of the screen.
    truncated:
      records.length >= RECORD_LIMIT ||
      manifest.length >= MANIFEST_LIMIT ||
      installments.length >= CHILD_LIMIT ||
      payments.length >= CHILD_LIMIT,
  }
}
