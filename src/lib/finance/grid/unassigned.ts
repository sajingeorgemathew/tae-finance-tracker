/**
 * Why a finance record has no batch — FINANCE-RECONCILE-04A.
 *
 * The importer wrote the routing outcome that created each unassigned record
 * into that record's preserved `legacy_raw_json` as `unassigned_reason`. It is
 * one of three closed values, and this module is the only place they are read
 * and turned into words. The raw JSON never leaves the server; the enum does.
 *
 * Nothing here decides anything. A reason explains a historical routing
 * outcome so a person can tell "two batch tables list this student" apart
 * from "no table lists them" apart from "the row carried no number" before a
 * later write workflow (RECONCILE-04B) lets them act on it.
 */

/** The importer's routing outcomes that leave a record with no batch. */
export type UnassignedReason = 'ambiguous_batch' | 'batch_not_found' | 'missing_student_id'

const REASONS: readonly UnassignedReason[] = ['ambiguous_batch', 'batch_not_found', 'missing_student_id']

export function isUnassignedReason(value: unknown): value is UnassignedReason {
  return typeof value === 'string' && (REASONS as readonly string[]).includes(value)
}

/**
 * The reason preserved on an unassigned record, or null.
 *
 * Only read for a record with no batch; a batch record's raw JSON is a
 * workbook row and carries no such key. An unknown value is null rather
 * than a guess, and the row then reads "Reason not recorded".
 */
export function unassignedReasonOf(legacyRawJson: unknown): UnassignedReason | null {
  if (legacyRawJson === null || typeof legacyRawJson !== 'object' || Array.isArray(legacyRawJson)) return null
  const value = (legacyRawJson as { unassigned_reason?: unknown }).unassigned_reason
  return isUnassignedReason(value) ? value : null
}

/** Short label for the badge. */
export function unassignedReasonLabel(reason: UnassignedReason | null): string {
  switch (reason) {
    case 'ambiguous_batch':
      return 'In two batch tables'
    case 'batch_not_found':
      return 'In no batch table'
    case 'missing_student_id':
      return 'No student number'
    case null:
      return 'Reason not recorded'
  }
}

/** The sentence behind the badge. States the routing rule, claims nothing more. */
export function unassignedReasonExplanation(reason: UnassignedReason | null): string {
  switch (reason) {
    case 'ambiguous_batch':
      return (
        'The student number appears in more than one batch table for this program, so the import ' +
        'could not tell which batch the Tracker Master payments belong to and did not guess.'
      )
    case 'batch_not_found':
      return (
        'No batch table for this program lists the student number, so the Tracker Master payments ' +
        'had no batch record to attach to. The Tracker Master batch cell is a month, not a cohort.'
      )
    case 'missing_student_id':
      return (
        'The Tracker Master row states no student number, so the payment was kept on its own ' +
        'unresolved student rather than matched to anyone by name.'
      )
    case null:
      return 'The import recorded no reason for leaving this record without a batch.'
  }
}
