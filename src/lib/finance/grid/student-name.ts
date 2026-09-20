/**
 * Resolving what to call a student.
 *
 * This is the implementation behind `studentDisplayName()` in
 * `src/lib/finance/students.ts`, lifted out so it can run somewhere that module
 * cannot: that module is `server-only`, and the finance grid needs the same
 * rule in its view-model builder and in the tests that check it.
 *
 * `students.ts` re-exports this, so there is still exactly one fallback chain
 * and no screen can resolve a name differently from another.
 */

/** The name-bearing fields of a student row. */
export interface NamedStudent {
  student_number: string | null
  first_name: string | null
  middle_name: string | null
  last_name: string | null
  display_name: string | null
  /** The name exactly as the workbook spelled it. Never rewritten. */
  legacy_name: string | null
}

/**
 * The label to show for a student, preferring what a human chose.
 *
 * Falls back through display name, parsed parts, the raw legacy name, and
 * finally the student number, so an incomplete historical row still renders as
 * something recognisable. Nothing is invented: a row with none of those reads
 * "Unnamed student", which is the truth about it.
 */
export function resolveStudentName(student: NamedStudent): string {
  const display = student.display_name?.trim()
  if (display) return display

  const parts = [student.first_name, student.middle_name, student.last_name]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))

  if (parts.length > 0) return parts.join(' ')

  const legacy = student.legacy_name?.trim()
  if (legacy) return legacy

  const number = student.student_number?.trim()
  return number ? `Student ${number}` : 'Unnamed student'
}

/**
 * What the Student # column shows.
 *
 * The seven unresolved historical students carry no number, and the importer's
 * deterministic source key is emphatically not one — exposing it would hand
 * staff an identifier that looks official and is not. They get a plain
 * statement of absence instead.
 */
export const NO_STUDENT_NUMBER = 'No student number'
