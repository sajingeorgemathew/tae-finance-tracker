import 'server-only'

import { createClient } from '@/lib/supabase/server'
import type { Student, UUID } from '@/types/finance'

import { resolveStudentName } from './grid/student-name'
import { type PageOptions, raiseQueryError, resolveRange, sanitizeSearchTerm } from './query'

/**
 * Students.
 *
 * Two things shape this module, both consequences of the legacy data:
 *
 * - A student number is not unique in the database, so every lookup by number
 *   returns a list. Callers must decide what an ambiguous match means rather
 *   than being handed a silently-chosen row.
 * - Names may be split into parts, or may only exist as `legacy_name`. Display
 *   goes through `studentDisplayName()` so every screen resolves it the same
 *   way.
 */

const STUDENT_COLUMNS =
  'id, student_number, first_name, middle_name, last_name, display_name, legacy_name, email, phone, active, legacy_source, created_at, updated_at'

export interface ListStudentsOptions extends PageOptions {
  /** Matches student number, name parts or email, case-insensitively. */
  search?: string
  includeInactive?: boolean
}

export async function listStudents(options: ListStudentsOptions = {}): Promise<Student[]> {
  const supabase = await createClient()
  const { from, to } = resolveRange(options)

  let query = supabase
    .from('students')
    .select(STUDENT_COLUMNS)
    .order('student_number', { nullsFirst: false })
    .order('last_name', { nullsFirst: false })
    .range(from, to)

  if (!options.includeInactive) {
    query = query.eq('active', true)
  }

  const search = options.search ? sanitizeSearchTerm(options.search) : ''
  if (search) {
    const pattern = `%${search}%`
    query = query.or(
      [
        `student_number.ilike.${pattern}`,
        `first_name.ilike.${pattern}`,
        `last_name.ilike.${pattern}`,
        `display_name.ilike.${pattern}`,
        `legacy_name.ilike.${pattern}`,
        `email.ilike.${pattern}`,
      ].join(','),
    )
  }

  const { data, error } = await query
  if (error) raiseQueryError('list students', error)

  return (data ?? []) as Student[]
}

export async function getStudentById(id: UUID): Promise<Student | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('students')
    .select(STUDENT_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error) raiseQueryError('load student', error)

  return (data as Student | null) ?? null
}

/**
 * Every student carrying this student number.
 *
 * Deliberately not `getStudentByNumber`: historical data may repeat a number,
 * and collapsing that to one row would hide a real data problem.
 */
export async function findStudentsByNumber(studentNumber: string): Promise<Student[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('students')
    .select(STUDENT_COLUMNS)
    .eq('student_number', studentNumber)
    .order('created_at')

  if (error) raiseQueryError('find students by number', error)

  return (data ?? []) as Student[]
}

/**
 * The label to show for a student, preferring what a human chose.
 *
 * Falls back through display name, parsed parts, the raw legacy name, and
 * finally the student number, so an incomplete historical row still renders as
 * something recognisable.
 *
 * The rule itself lives in `./grid/student-name`, which carries no
 * `server-only` import and so can also run in the finance grid's view-model
 * builder and in its tests. Re-exported rather than reimplemented: two copies
 * of a name-resolution chain is two screens eventually disagreeing about what
 * a student is called.
 */
export function studentDisplayName(student: Student): string {
  return resolveStudentName(student)
}
