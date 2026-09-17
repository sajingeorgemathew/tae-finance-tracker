import 'server-only'

import { createClient } from '@/lib/supabase/server'
import type {
  Batch,
  FinanceRecordStatus,
  Program,
  Student,
  StudentFinanceRecord,
  UUID,
} from '@/types/finance'

import { type PageOptions, raiseQueryError, resolveRange } from './query'

/**
 * Student finance records — a student's money for one program/batch.
 *
 * Reads only. Nothing here recomputes or reconciles a `legacy_*` value: those
 * columns are the workbook's own words and stay that way even when they
 * disagree with the payments on file. A computed balance is a separate,
 * explicitly-labelled figure and arrives with the finance grid in a later
 * ticket.
 */

const FINANCE_RECORD_COLUMNS =
  'id, student_id, program_id, batch_id, legacy_total_fee, legacy_total_paid, legacy_balance, current_total_fee, currency, status, legacy_source_sheet, legacy_source_row, created_at, updated_at'

/** Just enough of a program/batch to label a row without a second query. */
type ProgramSummary = Pick<Program, 'id' | 'name' | 'short_code'>
type BatchSummary = Pick<Batch, 'id' | 'name' | 'code'>

export interface FinanceRecordWithRelations extends StudentFinanceRecord {
  student: Student | null
  program: ProgramSummary | null
  batch: BatchSummary | null
}

const FINANCE_RECORD_WITH_RELATIONS_COLUMNS = `${FINANCE_RECORD_COLUMNS},
  student:students (
    id, student_number, first_name, middle_name, last_name, display_name,
    legacy_name, email, phone, active, legacy_source, created_at, updated_at
  ),
  program:programs (id, name, short_code),
  batch:batches (id, name, code)`

export interface ListFinanceRecordsOptions extends PageOptions {
  programId?: UUID
  batchId?: UUID
  studentId?: UUID
  status?: FinanceRecordStatus
}

/** Finance records with their student, program and batch attached. */
export async function listFinanceRecords(
  options: ListFinanceRecordsOptions = {},
): Promise<FinanceRecordWithRelations[]> {
  const supabase = await createClient()
  const { from, to } = resolveRange(options)

  let query = supabase
    .from('student_finance_records')
    .select(FINANCE_RECORD_WITH_RELATIONS_COLUMNS)
    .order('created_at')
    .range(from, to)

  if (options.programId) query = query.eq('program_id', options.programId)
  if (options.batchId) query = query.eq('batch_id', options.batchId)
  if (options.studentId) query = query.eq('student_id', options.studentId)
  if (options.status) query = query.eq('status', options.status)

  const { data, error } = await query
  if (error) raiseQueryError('list finance records', error)

  return (data ?? []) as unknown as FinanceRecordWithRelations[]
}

export async function getFinanceRecordById(
  id: UUID,
): Promise<FinanceRecordWithRelations | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('student_finance_records')
    .select(FINANCE_RECORD_WITH_RELATIONS_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error) raiseQueryError('load finance record', error)

  return (data as unknown as FinanceRecordWithRelations | null) ?? null
}

/** Every finance record for one student, across programs and batches. */
export async function listFinanceRecordsForStudent(
  studentId: UUID,
): Promise<FinanceRecordWithRelations[]> {
  return listFinanceRecords({ studentId, limit: 100 })
}

/**
 * How many finance records match, without fetching any of them.
 *
 * Uses a head request, so no row contents cross the wire. Note that a HEAD
 * response carries no body, so postgrest-js cannot report an error code for one
 * — a failure surfaces here as a null count, which is reported as 0.
 */
export async function countFinanceRecords(
  options: Omit<ListFinanceRecordsOptions, keyof PageOptions> = {},
): Promise<number> {
  const supabase = await createClient()

  let query = supabase
    .from('student_finance_records')
    .select('id', { head: true, count: 'exact' })

  if (options.programId) query = query.eq('program_id', options.programId)
  if (options.batchId) query = query.eq('batch_id', options.batchId)
  if (options.studentId) query = query.eq('student_id', options.studentId)
  if (options.status) query = query.eq('status', options.status)

  const { count, error } = await query
  if (error) raiseQueryError('count finance records', error)

  return count ?? 0
}
