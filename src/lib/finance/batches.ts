import 'server-only'

import { createClient } from '@/lib/supabase/server'
import type { Batch, UUID } from '@/types/finance'

import { raiseQueryError } from './query'

/**
 * Batches — the cohorts a finance record belongs to.
 *
 * `legacy_sheet_name` is how FINANCE-IMPORT-02 will match a workbook sheet to a
 * batch, which is why the lookup by sheet name exists before the importer does.
 */

const BATCH_COLUMNS =
  'id, program_id, name, code, start_date, end_date, active, legacy_sheet_name, created_at, updated_at'

export async function listBatches(
  options: { programId?: UUID; includeInactive?: boolean } = {},
): Promise<Batch[]> {
  const supabase = await createClient()

  let query = supabase
    .from('batches')
    .select(BATCH_COLUMNS)
    .order('start_date', { ascending: false, nullsFirst: false })
    .order('name')

  if (options.programId) {
    query = query.eq('program_id', options.programId)
  }
  if (!options.includeInactive) {
    query = query.eq('active', true)
  }

  const { data, error } = await query
  if (error) raiseQueryError('list batches', error)

  return (data ?? []) as Batch[]
}

export async function getBatchById(id: UUID): Promise<Batch | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('batches')
    .select(BATCH_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error) raiseQueryError('load batch', error)

  return (data as Batch | null) ?? null
}

/**
 * Batches mapped to a given legacy worksheet.
 *
 * Returns a list rather than a single row: the schema does not enforce that a
 * sheet name maps to exactly one batch, and the import analysis that would
 * justify such a constraint has not happened yet.
 */
export async function findBatchesByLegacySheetName(sheetName: string): Promise<Batch[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('batches')
    .select(BATCH_COLUMNS)
    .eq('legacy_sheet_name', sheetName)
    .order('name')

  if (error) raiseQueryError('find batches by legacy sheet name', error)

  return (data ?? []) as Batch[]
}
