/**
 * Contact readiness for every target student — evidence only, nothing written.
 *
 * The contact masters are staged by the same adapters FINANCE-CONTACT-04B1
 * built (allowlisted headings only; passwords, dates of birth and the like are
 * never read). A target student is joined to master rows by **exact student
 * number** and nothing else: no name, email or phone match, no prefix or
 * leading-zero folding. A student with no number is never looked up.
 *
 * Email is the channel reminders and receipts are delivered on
 * (`reminder_deliveries.recipient_email`, `receipt_deliveries.recipient_email`
 * are NOT NULL), so readiness is decided on the email; the phone is reported
 * beside it.
 *
 * The cutover does not write a single contact. A later contact apply must be a
 * NEW 04B2 dry run against the post-cutover data, reviewed before `--apply`.
 */

import type { ContactImportRow } from '../finance-contact/canonical.mts'
import type { SharedContact } from '../finance-contact/reconcile.mts'

export const CONTACT_STATUSES = [
  'CONTACT_READY',
  'CONTACT_MISSING',
  'CONTACT_SHARED_REVIEW',
  'MISSING_STUDENT_NUMBER',
  'CONTACT_INVALID',
  'CONTACT_AMBIGUOUS',
] as const

export type ContactStatus = (typeof CONTACT_STATUSES)[number]

export interface ContactAssessment {
  studentId: string
  studentNumber: string | null
  status: ContactStatus
  reason: string
  /** Master rows with this exact number (0 when none or when there is no number). */
  masterRows: number
  /** Program codes of the masters the number was found in. */
  masterPrograms: string[]
  phone: 'valid' | 'shared' | 'invalid_or_ambiguous' | 'missing' | 'conflicting'
  /** The email/phone a later contact apply could fill — private output only. */
  email: string | null
  phoneNormalized: string | null
}

export interface ContactStudent {
  studentId: string
  studentNumber: string | null
}

/**
 * Classifies one student. Precedence: no number → no master row → several
 * different valid emails → no valid email (invalid, else missing) → the email
 * is shared with another student number → ready.
 */
export function assessContact(
  student: ContactStudent,
  rowsByNumber: ReadonlyMap<string, readonly ContactImportRow[]>,
  sharedEmails: ReadonlySet<string>,
  sharedPhones: ReadonlySet<string>,
): ContactAssessment {
  const base = { studentId: student.studentId, studentNumber: student.studentNumber }
  if (student.studentNumber === null) {
    return { ...base, status: 'MISSING_STUDENT_NUMBER', reason: 'no student number; contacts are joined on the exact number only', masterRows: 0, masterPrograms: [], phone: 'missing', email: null, phoneNormalized: null }
  }

  const rows = rowsByNumber.get(student.studentNumber) ?? []
  const masterPrograms = [...new Set(rows.map((row) => row.programCode))].sort()

  const phones = [...new Set(rows.filter((row) => row.phoneStatus === 'valid_nanp' || row.phoneStatus === 'international_explicit').map((row) => row.phoneNormalized as string))]
  const phone: ContactAssessment['phone'] =
    phones.length > 1
      ? 'conflicting'
      : phones.length === 1
        ? sharedPhones.has(phones[0])
          ? 'shared'
          : 'valid'
        : rows.some((row) => row.phoneStatus === 'invalid' || row.phoneStatus === 'ambiguous')
          ? 'invalid_or_ambiguous'
          : 'missing'
  const phoneNormalized = phones.length === 1 ? phones[0] : null

  if (rows.length === 0) {
    return { ...base, status: 'CONTACT_MISSING', reason: 'the number is in no contact master', masterRows: 0, masterPrograms, phone, email: null, phoneNormalized }
  }

  const emails = [...new Set(rows.filter((row) => row.emailStatus === 'valid').map((row) => row.emailNormalized as string))]
  if (emails.length > 1) {
    return { ...base, status: 'CONTACT_AMBIGUOUS', reason: `${emails.length} different valid emails for one number`, masterRows: rows.length, masterPrograms, phone, email: null, phoneNormalized }
  }
  if (emails.length === 0) {
    const invalid = rows.some((row) => row.emailStatus === 'invalid')
    return {
      ...base,
      status: invalid ? 'CONTACT_INVALID' : 'CONTACT_MISSING',
      reason: invalid ? 'the master states an email that is not a valid address' : 'the master row states no email',
      masterRows: rows.length,
      masterPrograms,
      phone,
      email: null,
      phoneNormalized,
    }
  }
  if (sharedEmails.has(emails[0])) {
    return { ...base, status: 'CONTACT_SHARED_REVIEW', reason: 'the email is also stated for another student number', masterRows: rows.length, masterPrograms, phone, email: emails[0], phoneNormalized }
  }
  return { ...base, status: 'CONTACT_READY', reason: 'exactly one valid, unshared email for the exact number', masterRows: rows.length, masterPrograms, phone, email: emails[0], phoneNormalized }
}

export function assessContacts(
  students: readonly ContactStudent[],
  masterRows: readonly ContactImportRow[],
  shared: readonly SharedContact[],
): ContactAssessment[] {
  const rowsByNumber = new Map<string, ContactImportRow[]>()
  for (const row of masterRows) {
    if (row.studentNumber === null) continue
    rowsByNumber.set(row.studentNumber, [...(rowsByNumber.get(row.studentNumber) ?? []), row])
  }
  const sharedEmails = new Set(shared.filter((entry) => entry.kind === 'email').map((entry) => entry.value))
  const sharedPhones = new Set(shared.filter((entry) => entry.kind === 'phone').map((entry) => entry.value))
  return students
    .map((student) => assessContact(student, rowsByNumber, sharedEmails, sharedPhones))
    .sort((a, b) => a.studentId.localeCompare(b.studentId))
}
