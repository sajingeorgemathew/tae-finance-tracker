import 'server-only'

import { createClient } from '@/lib/supabase/server'

import { raiseQueryError } from '../query.ts'
import { resolveRequestedBatch, UNASSIGNED_BATCH } from './select-batch.ts'
import { buildFinanceGrid, type RawFinanceRecord, type RawInstallment, type RawPayment } from './view-model.ts'
import type { RawManifestColumn } from './manifest.ts'
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
 * ## Query strategy — seven requests, regardless of batch size
 *
 *   1. programs
 *   2. batches
 *   3. `batch_id` of every finance record, to count students per batch
 *   4. the selected batch's finance records, with their student embedded, and
 *   5. the selected batch's column manifest — issued together
 *   6. installments and 7. payments for those records, by `in (...)`
 *
 * Nothing loops over students. Step 4 uses a PostgREST embed rather than a
 * lookup per row, step 5 is one request for the whole batch's layout, and
 * steps 6 and 7 take the whole batch's record ids at once — so a batch of 30
 * students costs the same round trips as a batch of 3. The unassigned view has
 * no batch and so no manifest; step 5 is skipped there.
 *
 * Step 3 reads one uuid column across all 397 finance records rather than
 * issuing a count per batch, which would be 23 requests to fill one dropdown.
 *
 * Payments are the one place a `legacy_raw_json` field is read, and only one
 * key of it: `receipt_sent`, extracted by the database with `->>` so the rest
 * of the payload — routing notes, workbook formulas, the row-local Balance Fees
 * formula — never crosses the wire at all.
 */

/** Batch records are small; this is a guard against a missing filter, not a page size. */
const RECORD_LIMIT = 500

/** Installments and payments per batch run to low hundreds. */
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
 * built without the full payload ever being fetched.
 */
const PAYMENT_COLUMNS =
  'id, student_finance_record_id, amount, payment_date, payment_method, note, voided_at, legacy_receipt_sent:legacy_raw_json->>receipt_sent'

/**
 * The layout fields only. The workbook hash, sheet name and table key stay in
 * the database: the browser needs a column's key, heading, section, role,
 * kind and order, and nothing about where in a spreadsheet it once sat.
 */
const MANIFEST_COLUMNS =
  'column_key, section, source_column_letter, source_header, normalized_role, value_kind, display_order, is_grid_visible, display_even_if_blank'

/** A batch's layout is a few dozen rows; this guards a missing filter. */
const MANIFEST_LIMIT = 500

export interface LoadFinanceGridOptions {
  /** Program short code from the URL, e.g. `'PSW'`. */
  program?: string | null
  /** Batch id from the URL, or `'unassigned'`. */
  batch?: string | null
}

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
    .select('id, program_id, name, start_date')
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
      return {
        id: row.id as string,
        programId,
        programShortCode: programById.get(programId)?.shortCode ?? '',
        name: row.name as string,
        startDate: (row.start_date as string | null) ?? null,
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

  const wantsUnassigned = options.batch === UNASSIGNED_BATCH
  const resolved = wantsUnassigned
    ? { batch: null, note: 'Showing records the import could not tie to a single batch.' }
    : resolveRequestedBatch(batchesInScope, options.batch?.trim() || null)

  const unassignedCount = selectedProgram
    ? (unassignedByProgram.get(selectedProgram.id) ?? 0)
    : 0

  const emptyView: FinanceGridView = {
    programs,
    batches: batchesInScope,
    selectedProgram,
    selectedBatch: null,
    unassigned: wantsUnassigned,
    unassignedCount,
    batchSelectionNote: resolved.note,
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
    truncated: false,
  }

  if (!wantsUnassigned && resolved.batch === null) return emptyView
  if (wantsUnassigned && (selectedProgram === null || unassignedCount === 0)) return emptyView

  // --- 4 & 5. Finance records and the column manifest for the selection ------
  let recordQuery = supabase
    .from('student_finance_records')
    .select(RECORD_COLUMNS)
    .order('legacy_source_row', { nullsFirst: false })
    .range(0, RECORD_LIMIT - 1)

  if (wantsUnassigned) {
    recordQuery = recordQuery.is('batch_id', null).eq('program_id', selectedProgram!.id)
  } else {
    recordQuery = recordQuery.eq('batch_id', resolved.batch!.id)
  }

  // The manifest is the batch's, not the rows', so it is fetched alongside the
  // records rather than after them, and it is fetched once — never per student.
  // The unassigned records have no batch and therefore no manifest.
  const manifestQuery = wantsUnassigned
    ? Promise.resolve({ data: [] as RawManifestColumn[], error: null })
    : supabase
        .from('batch_finance_columns')
        .select(MANIFEST_COLUMNS)
        .eq('batch_id', resolved.batch!.id)
        .order('section')
        .order('display_order')
        .range(0, MANIFEST_LIMIT - 1)

  const [recordsResult, manifestResult] = await Promise.all([recordQuery, manifestQuery])
  if (recordsResult.error) raiseQueryError('load finance records for batch', recordsResult.error)
  if (manifestResult.error) raiseQueryError('load column layout for batch', manifestResult.error)

  const records = (recordsResult.data ?? []) as unknown as RawFinanceRecord[]
  const manifest = (manifestResult.data ?? []) as unknown as RawManifestColumn[]
  const recordIds = records.map((record) => record.id)

  if (recordIds.length === 0) {
    return { ...emptyView, selectedBatch: resolved.batch, batchSelectionNote: resolved.note }
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
    raiseQueryError('load installments for batch', installmentsResult.error)
  }
  if (paymentsResult.error) raiseQueryError('load payments for batch', paymentsResult.error)

  const installments = (installmentsResult.data ?? []) as unknown as RawInstallment[]
  const payments = (paymentsResult.data ?? []) as unknown as RawPayment[]

  const built = buildFinanceGrid({
    records,
    installments,
    payments,
    manifest,
    programShortCode: selectedProgram?.shortCode ?? '',
    batchName: resolved.batch?.name ?? null,
  })

  return {
    programs,
    batches: batchesInScope,
    selectedProgram,
    selectedBatch: resolved.batch,
    unassigned: wantsUnassigned,
    unassignedCount,
    batchSelectionNote: resolved.note,
    ...built,
    // A cap reached is reported rather than silently trimming a student's
    // history off the bottom of the screen.
    truncated:
      records.length >= RECORD_LIMIT ||
      manifest.length >= MANIFEST_LIMIT ||
      installments.length >= CHILD_LIMIT ||
      payments.length >= CHILD_LIMIT,
  }
}
