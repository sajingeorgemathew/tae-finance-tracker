import 'server-only'

import { createClient } from '@/lib/supabase/server'
import type { Program, UUID } from '@/types/finance'

import { raiseQueryError } from './query'

/**
 * Read access to program configuration.
 *
 * Programs are admin-write by RLS: they decide student-number prefixes and
 * receipt-number components, so changing one retroactively changes how new
 * receipts are numbered. Writes therefore go through an admin screen in a later
 * ticket, not through a generic helper here.
 */

const PROGRAM_COLUMNS =
  'id, name, short_code, student_number_prefix, receipt_course_code, receipt_course_suffix, active, created_at, updated_at'

/** Active programs, ordered by short code. Pass `includeInactive` to see all. */
export async function listPrograms(
  options: { includeInactive?: boolean } = {},
): Promise<Program[]> {
  const supabase = await createClient()

  let query = supabase.from('programs').select(PROGRAM_COLUMNS).order('short_code')
  if (!options.includeInactive) {
    query = query.eq('active', true)
  }

  const { data, error } = await query
  if (error) raiseQueryError('list programs', error)

  return (data ?? []) as Program[]
}

export async function getProgramById(id: UUID): Promise<Program | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('programs')
    .select(PROGRAM_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error) raiseQueryError('load program', error)

  return (data as Program | null) ?? null
}

/** Looks a program up by its short code, e.g. `'PSW'`. Short codes are unique. */
export async function getProgramByShortCode(shortCode: string): Promise<Program | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('programs')
    .select(PROGRAM_COLUMNS)
    .eq('short_code', shortCode)
    .maybeSingle()

  if (error) raiseQueryError('load program by short code', error)

  return (data as Program | null) ?? null
}
