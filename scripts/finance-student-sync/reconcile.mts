/**
 * FINANCE-STUDENT-SYNC-05B — current student list vs live finance students
 * (pure; no Supabase, no file system).
 *
 *   CURRENT FILE → MATCH (exact student number) → DIFFERENCES → REVIEW → SAFE APPLY
 *
 * Identity is the EXACT student number (surrounding whitespace only, no
 * prefix or leading-zero folding). A name never makes a match; it can only
 * stop one (`nameConsistency`). Batch and session are compared, never
 * written. Email and phone are the only fields a plan can propose, and only
 * into a NULL hosted field; a different non-NULL value is an explicit
 * approval item, never an automatic update. Nothing here can touch a finance
 * record, installment or payment — the plan has no shape for one.
 */

import { createHash } from 'node:crypto'

import { canonicalJson, NORMALIZATION_RULE } from '../finance-contact/apply-plan.mts'
import { parseTitleDate } from '../finance-contact/adapters/title-date.mts'
import { nameWords } from '../finance-contact/launch-plan.mts'
import { normalizeEmail, normalizePhone, normalizeStudentNumber } from '../finance-contact/normalize.mts'

import type { IncomingFile, IncomingRow } from './input.mts'

export const TICKET = 'FINANCE-STUDENT-SYNC-05B'
export const SYNC_PLAN_VERSION = 2

/** The only `students` columns a sync plan may ever write. */
export const WRITABLE_FIELDS = ['email', 'phone'] as const
export type WritableField = (typeof WRITABLE_FIELDS)[number]

export const CLASSIFICATIONS = [
  'NO_CHANGE',
  'SAFE_UPDATE',
  'NEW_STUDENT',
  'CONFLICT_REVIEW',
  'MISSING_STUDENT_NUMBER',
  'DUPLICATE_STUDENT_NUMBER',
  'MISSING_FROM_CURRENT_LIST',
  'INVALID_CONTACT',
  /** The row names an intake outside the sync scope; reported, never acted on. */
  'OUT_OF_SCOPE',
] as const
export type Classification = (typeof CLASSIFICATIONS)[number]

// -----------------------------------------------------------------------------
// Live side
// -----------------------------------------------------------------------------

export interface ScopeCohort {
  id: string
  label: string
  programShortCode: string
  /** The cohort month (the hosted sheet month). */
  yearMonth: string
}

/** One live student in a scoped cohort, as hosted holds it now. */
export interface LiveStudent {
  studentId: string
  studentNumber: string | null
  name: string | null
  /** Every hosted name part, for the identity cross-check. */
  nameParts: (string | null)[]
  email: string | null
  phone: string | null
  cohortId: string
  batchId: string
  batchName: string
  /** Months an incoming batch may name for this batch: cohort month, start-date month, batch-name month. */
  acceptedMonths: string[]
  session: 'Morning' | 'Evening' | null
}

/** Hosted students outside the scope, by number only (to flag a "new" number that exists elsewhere). */
export interface OutsideStudent {
  studentNumber: string
  label: string
}

// -----------------------------------------------------------------------------
// Rules
// -----------------------------------------------------------------------------

/** Optimal-string-alignment distance ≤ 1 (one substitution, insertion, deletion or adjacent swap). */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    const diffs: number[] = []
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diffs.push(i)
    if (diffs.length === 1) return true
    return diffs.length === 2 && diffs[1] === diffs[0] + 1 && a[diffs[0]] === b[diffs[1]] && a[diffs[1]] === b[diffs[0]]
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  for (let i = 0; i < long.length; i += 1) if (long.slice(0, i) + long.slice(i + 1) === short) return true
  return false
}

export type NameVerdict = 'SAME' | 'VARIANT' | 'CONFLICT' | 'INCOMING_MISSING' | 'LIVE_MISSING'

/**
 * Identity cross-check, never a matcher. Consistent when every word of the
 * shorter name appears in the longer one (exactly, or one typo away for words
 * of four letters or more): a missing middle name or a transposed letter is a
 * VARIANT; anything else — a different surname, a different person — is a
 * CONFLICT that stops every update for the row.
 */
export function nameConsistency(live: readonly (string | null)[], incoming: string | null): NameVerdict {
  const incomingWords = [...nameWords(incoming)]
  const liveWords = [...nameWords(...live)]
  if (incomingWords.length === 0) return 'INCOMING_MISSING'
  if (liveWords.length === 0) return 'LIVE_MISSING'
  const [shorter, longer] = incomingWords.length <= liveWords.length ? [incomingWords, liveWords] : [liveWords, incomingWords]
  const matches = (word: string) => longer.some((other) => other === word || (word.length >= 4 && other.length >= 4 && withinOneEdit(word, other)))
  if (!shorter.every(matches)) return 'CONFLICT'
  const same = incomingWords.length === liveWords.length && incomingWords.every((word) => liveWords.includes(word))
  return same ? 'SAME' : 'VARIANT'
}

/** Year-month an incoming Batch / Intake cell names, or null. Accepts "June 2026", "1st June, 2026", "2026-06-01". */
export function incomingMonth(batchRaw: string | null): string | null {
  if (batchRaw === null) return null
  const iso = /^(\d{4})-(\d{2})(?:-\d{2})?/.exec(batchRaw.trim())
  if (iso) return `${iso[1]}-${iso[2]}`
  return parseTitleDate(batchRaw).yearMonth
}

export function incomingSession(sessionRaw: string | null, batchRaw: string | null): 'Morning' | 'Evening' | null {
  for (const text of [sessionRaw, batchRaw]) {
    if (text === null) continue
    if (/\b(morning|am|day)\b/i.test(text)) return 'Morning'
    if (/\b(evening|pm|night)\b/i.test(text)) return 'Evening'
  }
  return null
}

export type FieldAction =
  /** Incoming states nothing: never clears a hosted value. */
  | 'NONE'
  | 'SAME'
  /** Hosted NULL, incoming valid and unshared: the only automatic write. */
  | 'FILL'
  /** Hosted non-NULL and different: shown, never written without an explicit approval. */
  | 'CHANGE_NEEDS_APPROVAL'
  | 'INVALID'
  /** The value is also given for another student number. */
  | 'SHARED'

export interface FieldDecision {
  field: WritableField
  action: FieldAction
  current: string | null
  incoming: string | null
  note: string | null
}

function decideField(field: WritableField, current: string | null, row: IncomingRow, sharedValues: ReadonlySet<string>): FieldDecision {
  const value = field === 'email' ? row.email : row.phone
  const base = { field, current, incoming: value.raw === null ? null : (value.normalized ?? value.raw.trim()) }
  if (value.status === 'missing') return { ...base, action: 'NONE', note: null }
  if (field === 'email' ? value.status !== 'valid' : value.status !== 'valid_nanp') {
    return { ...base, action: 'INVALID', note: field === 'email' ? 'not shaped like an email address' : `phone ${value.status}${'note' in value && value.note ? `: ${value.note}` : ''}` }
  }
  const normalized = value.normalized as string
  const currentKey = current === null ? null : field === 'email' ? (normalizeEmail(current).normalized ?? current.trim().toLowerCase()) : (normalizePhone(current).normalized ?? current)
  if (currentKey === normalized) return { ...base, action: 'SAME', note: null }
  if (sharedValues.has(`${field}:${normalized}`)) return { ...base, action: 'SHARED', note: `this ${field} is also given for another student number` }
  if (current !== null) return { ...base, action: 'CHANGE_NEEDS_APPROVAL', note: `hosted ${field} is set and differs; explicit approval required` }
  return { ...base, action: 'FILL', note: null }
}

// -----------------------------------------------------------------------------
// Field-level review status (all six fields)
// -----------------------------------------------------------------------------

/** Every field the sync compares. Only email and phone are ever written, and only into NULL. */
export const SYNC_FIELDS = ['studentNumber', 'name', 'email', 'phone', 'batch', 'session'] as const
export type SyncField = (typeof SYNC_FIELDS)[number]

export const FIELD_STATUSES = ['SAFE_CONTACT_UPDATE', 'IDENTITY_REVIEW_REQUIRED', 'NO_CHANGE'] as const
export type FieldStatus = (typeof FIELD_STATUSES)[number]

export interface FieldChange {
  field: SyncField
  current: string | null
  incoming: string | null
  status: FieldStatus
  note: string | null
}

const noChange = (field: SyncField, current: string | null, incoming: string | null, note: string | null = null): FieldChange => ({ field, current, incoming, status: 'NO_CHANGE', note })
const review = (field: SyncField, current: string | null, incoming: string | null, note: string): FieldChange => ({ field, current, incoming, status: 'IDENTITY_REVIEW_REQUIRED', note })

/**
 * Email/phone: a FILL is SAFE_CONTACT_UPDATE only while the identity is
 * confirmed; any other difference is review; invalid or blank incoming values
 * change nothing.
 */
export function contactFieldChange(decision: FieldDecision, identityConfirmed: boolean): FieldChange {
  const { field, current, incoming } = decision
  switch (decision.action) {
    case 'FILL':
      return identityConfirmed
        ? { field, current, incoming, status: 'SAFE_CONTACT_UPDATE', note: 'hosted NULL; fill through the safe NULL-fill RPC' }
        : review(field, current, incoming, 'held: the identity of this row is not confirmed')
    case 'CHANGE_NEEDS_APPROVAL':
    case 'SHARED':
      return review(field, current, incoming, decision.note as string)
    case 'INVALID':
      return noChange(field, current, incoming, `incoming value invalid (${decision.note}); not used`)
    case 'SAME':
      return noChange(field, current, incoming)
    case 'NONE':
      return noChange(field, current, incoming, 'not given; never clears a value')
  }
}

// -----------------------------------------------------------------------------
// Plan
// -----------------------------------------------------------------------------

export interface ComparisonRow {
  side: 'incoming' | 'live'
  rowRef: string | null
  studentId: string | null
  studentNumber: string | null
  currentName: string | null
  incomingName: string | null
  currentEmail: string | null
  incomingEmail: string | null
  currentPhone: string | null
  incomingPhone: string | null
  currentBatch: string | null
  incomingBatch: string | null
  classification: Classification
  reasons: string[]
  warnings: string[]
  /** One entry per compared field; empty for a row that matched no live student and suggests none. */
  fields: FieldChange[]
}

/** A field the eventual apply may write without further approval. Email/phone into NULL only. */
export interface SafeContactChange {
  studentId: string
  studentNumber: string
  field: WritableField
  /** Compare-and-swap: the field must still be NULL when the write runs. */
  expectedCurrent: null
  newValue: string
  rowRef: string
}

/** Anything a person must decide. Never written by the sync. */
export interface ReviewItem {
  studentId: string | null
  studentNumber: string | null
  rowRef: string | null
  field: SyncField
  current: string | null
  incoming: string | null
  note: string
}

export interface SyncSummary {
  liveScopedStudents: number
  incomingRows: number
  exactMatches: number
  byClassification: Record<Classification, number>
  fieldStatus: Record<SyncField, Record<FieldStatus, number>>
  safeContactUpdates: { email: number; phone: number }
  reviewItems: number
  proposedNumberChanges: number
}

export interface SyncPlan {
  ticket: typeof TICKET
  planVersion: typeof SYNC_PLAN_VERSION
  normalizationRule: typeof NORMALIZATION_RULE
  scope: { id: string; cohorts: ScopeCohort[]; batchIds: string[] }
  source: { fileName: string; sha256: string; sheet: string; headerRow: number; mapped: IncomingFile['header']['mapped'] }
  hostedBaseline: {
    projectRef: string
    counts: Record<string, number>
    studentsWithEmail: number
    studentsWithPhone: number
    /** Every scoped student's identity and current contact, as read. */
    liveStudents: { studentId: string; studentNumber: string | null; name: string | null; email: string | null; phone: string | null; batchId: string }[]
  }
  rows: ComparisonRow[]
  /** The only writes the eventual safe apply may perform. */
  safeChanges: SafeContactChange[]
  /** Identity changes and contact overwrites: listed for a person to decide; never written by the sync. */
  reviewItems: ReviewItem[]
  summary: SyncSummary
}

export interface BuildSyncInput {
  scope: { id: string; cohorts: ScopeCohort[] }
  file: IncomingFile
  live: readonly LiveStudent[]
  outside: readonly OutsideStudent[]
  baseline: Omit<SyncPlan['hostedBaseline'], 'liveStudents'>
}

function emptyCounts(): Record<Classification, number> {
  return Object.fromEntries(CLASSIFICATIONS.map((item) => [item, 0])) as Record<Classification, number>
}

/**
 * A live student whose name is consistent with an incoming row that did NOT
 * match by number: a candidate for a Student Number change (or a first
 * number). Suggestion only; names never make a match. A one-word incoming name
 * suggests nothing, and two or more candidates suggest nothing but a warning.
 */
function numberChangeCandidate(row: IncomingRow, month: string | null, live: readonly LiveStudent[]): { candidate: LiveStudent | null; ambiguous: number } {
  if (nameWords(row.name).size < 2) return { candidate: null, ambiguous: 0 }
  const hits = live.filter(
    (student) =>
      (row.studentNumber === null || normalizeStudentNumber(student.studentNumber) !== row.studentNumber) &&
      ['SAME', 'VARIANT'].includes(nameConsistency(student.nameParts, row.name)) &&
      (month === null || student.acceptedMonths.includes(month)),
  )
  return hits.length === 1 ? { candidate: hits[0], ambiguous: 0 } : { candidate: null, ambiguous: hits.length }
}

export function buildSyncPlan(input: BuildSyncInput): SyncPlan {
  const { file, live } = input
  const scopeMonths = new Set(input.scope.cohorts.map((cohort) => cohort.yearMonth))

  const liveByNumber = new Map<string, LiveStudent[]>()
  for (const student of live) {
    const number = normalizeStudentNumber(student.studentNumber)
    if (number !== null) liveByNumber.set(number, [...(liveByNumber.get(number) ?? []), student])
  }
  const outsideNumbers = new Map<string, string[]>()
  for (const student of input.outside) outsideNumbers.set(student.studentNumber, [...(outsideNumbers.get(student.studentNumber) ?? []), student.label])

  const incomingByNumber = new Map<string, IncomingRow[]>()
  for (const row of file.rows) if (row.studentNumber !== null) incomingByNumber.set(row.studentNumber, [...(incomingByNumber.get(row.studentNumber) ?? []), row])

  // A contact value is "shared" when the incoming list gives it to two rows,
  // or a live student with a different number already holds it.
  const holders = new Map<string, Set<string>>()
  const hold = (key: string, number: string) => holders.set(key, (holders.get(key) ?? new Set()).add(number))
  for (const row of file.rows) {
    const number = row.studentNumber ?? `row:${row.rowRef}`
    if (row.email.normalized) hold(`email:${row.email.normalized}`, number)
    if (row.phone.normalized) hold(`phone:${row.phone.normalized}`, number)
  }
  for (const student of live) {
    const number = normalizeStudentNumber(student.studentNumber) ?? `live:${student.studentId}`
    const email = student.email === null ? null : normalizeEmail(student.email).normalized
    const phone = student.phone === null ? null : normalizePhone(student.phone).normalized
    if (email) hold(`email:${email}`, number)
    if (phone) hold(`phone:${phone}`, number)
  }
  const sharedValues = new Set([...holders].filter(([, numbers]) => numbers.size > 1).map(([key]) => key))

  const rows: ComparisonRow[] = []
  const matchedLiveIds = new Set<string>()
  const suggestedFor = new Map<string, string[]>()

  for (const row of file.rows) {
    const reasons: string[] = []
    const warnings: string[] = []
    const month = incomingMonth(row.batchRaw)
    const session = incomingSession(row.sessionRaw, row.batchRaw)
    const base = {
      side: 'incoming' as const,
      rowRef: row.rowRef,
      studentNumber: row.studentNumber,
      incomingName: row.name,
      incomingEmail: row.email.normalized ?? row.email.raw,
      incomingPhone: row.phone.normalized ?? row.phone.raw,
      incomingBatch: [row.batchRaw, row.sessionRaw].filter(Boolean).join(' · ') || null,
    }
    const unmatched = (classification: Classification, fields: FieldChange[] = [], student: LiveStudent | null = null): ComparisonRow => ({
      ...base,
      studentId: student?.studentId ?? null,
      currentName: student?.name ?? null,
      currentEmail: student?.email ?? null,
      currentPhone: student?.phone ?? null,
      currentBatch: student?.batchName ?? null,
      classification,
      reasons,
      warnings,
      fields,
    })
    const suggest = (): LiveStudent | null => {
      const { candidate, ambiguous } = numberChangeCandidate(row, month, live)
      if (ambiguous > 1) warnings.push(`name is consistent with ${ambiguous} live students; no number change suggested`)
      if (candidate === null) return null
      suggestedFor.set(candidate.studentId, [...(suggestedFor.get(candidate.studentId) ?? []), row.rowRef])
      return candidate
    }

    if (row.studentNumber === null) {
      reasons.push('no student number; never matched by name')
      const candidate = suggest()
      if (candidate) warnings.push(`name is consistent with live student ${candidate.studentNumber ?? '(no number)'} in ${candidate.cohortId} (manual check)`)
      rows.push(unmatched('MISSING_STUDENT_NUMBER'))
      continue
    }
    const incomingDuplicates = incomingByNumber.get(row.studentNumber) ?? []
    const liveMatches = liveByNumber.get(row.studentNumber) ?? []
    if (incomingDuplicates.length > 1 || liveMatches.length > 1) {
      if (incomingDuplicates.length > 1) reasons.push(`the number appears on ${incomingDuplicates.length} rows of the current list`)
      if (liveMatches.length > 1) reasons.push(`the number is held by ${liveMatches.length} live students`)
      for (const student of liveMatches) matchedLiveIds.add(student.studentId)
      rows.push(unmatched('DUPLICATE_STUDENT_NUMBER'))
      continue
    }

    if (liveMatches.length === 0) {
      const elsewhere = outsideNumbers.get(row.studentNumber)
      if (elsewhere) warnings.push(`the number exists on hosted outside the scope (${elsewhere.join(', ')})`)
      if (month !== null && !scopeMonths.has(month)) {
        reasons.push(`intake ${month} is outside the sync scope`)
        rows.push(unmatched('OUT_OF_SCOPE'))
        continue
      }
      const candidate = suggest()
      if (candidate) {
        const from = candidate.studentNumber
        reasons.push(
          from === null
            ? `possible first Student Number for live student "${candidate.name}" (no number on hosted); manual review`
            : `possible Student Number change ${from} → ${row.studentNumber} for live student "${candidate.name}"; manual review`,
        )
        const fields = [review('studentNumber', from, row.studentNumber, 'Student Number changes always require manual review')]
        if (nameConsistency(candidate.nameParts, row.name) !== 'SAME') fields.push(review('name', candidate.name, row.name, 'name differs; manual review'))
        rows.push(unmatched('CONFLICT_REVIEW', fields, candidate))
        continue
      }
      reasons.push('the number is not a live student in the scoped cohorts')
      if (month === null) warnings.push(row.batchRaw === null ? 'no batch/intake given' : `batch/intake "${row.batchRaw}" not recognised`)
      rows.push(unmatched('NEW_STUDENT'))
      continue
    }

    // Exact match to one live scoped student.
    const student = liveMatches[0]
    matchedLiveIds.add(student.studentId)
    const fields: FieldChange[] = [noChange('studentNumber', student.studentNumber, row.studentNumber, 'exact match')]
    let identityConfirmed = true

    const verdict = nameConsistency(student.nameParts, row.name)
    if (verdict === 'SAME') fields.push(noChange('name', student.name, row.name))
    else if (verdict === 'VARIANT') fields.push(review('name', student.name, row.name, 'name differs in form (middle name / spelling); same person per the cross-check; name changes always require manual review'))
    else if (verdict === 'CONFLICT') {
      identityConfirmed = false
      reasons.push('student number matches but the names materially conflict')
      fields.push(review('name', student.name, row.name, 'names materially conflict: possible wrong number'))
    } else {
      identityConfirmed = false
      reasons.push(verdict === 'INCOMING_MISSING' ? 'no incoming name to cross-check the identity' : 'the live student has no name to cross-check')
      fields.push(noChange('name', student.name, row.name, 'cannot cross-check'))
    }

    const liveMonth = input.scope.cohorts.find((cohort) => cohort.id === student.cohortId)?.yearMonth ?? null
    if (month === null) fields.push(noChange('batch', student.batchName, row.batchRaw, row.batchRaw === null ? 'not given' : 'not recognised; not compared'))
    else if (student.acceptedMonths.includes(month)) fields.push(noChange('batch', student.batchName, row.batchRaw))
    else {
      identityConfirmed = false
      reasons.push(`incoming intake ${month} differs from the live cohort ${student.cohortId}`)
      fields.push(review('batch', student.batchName, row.batchRaw, `batch/intake change (${liveMonth} → ${month}) requires manual review; finance records are never moved automatically`))
    }
    if (session === null || student.session === null) fields.push(noChange('session', student.session, row.sessionRaw, session === null ? 'not given' : 'live batch has no session'))
    else if (session === student.session) fields.push(noChange('session', student.session, session))
    else {
      identityConfirmed = false
      reasons.push(`incoming session ${session} differs from the live ${student.session} batch`)
      fields.push(review('session', student.session, session, 'session change requires manual review; finance records are never moved automatically'))
    }

    const contactDecisions = WRITABLE_FIELDS.map((field) => decideField(field, field === 'email' ? student.email : student.phone, row, sharedValues))
    for (const decision of contactDecisions) fields.push(contactFieldChange(decision, identityConfirmed))
    for (const decision of contactDecisions) {
      if (decision.action === 'CHANGE_NEEDS_APPROVAL' || decision.action === 'SHARED' || decision.action === 'INVALID') reasons.push(`${decision.field}: ${decision.note}`)
    }

    const statuses = new Set(fields.map((f) => f.status))
    const anyInvalid = contactDecisions.some((d) => d.action === 'INVALID')
    const classification: Classification =
      !identityConfirmed || statuses.has('IDENTITY_REVIEW_REQUIRED')
        ? 'CONFLICT_REVIEW'
        : anyInvalid
          ? 'INVALID_CONTACT'
          : statuses.has('SAFE_CONTACT_UPDATE')
            ? 'SAFE_UPDATE'
            : 'NO_CHANGE'
    const safe = fields.filter((f) => f.status === 'SAFE_CONTACT_UPDATE').map((f) => f.field)
    if (safe.length > 0) reasons.unshift(`safe: fill ${safe.join(' + ')} (hosted NULL)`)
    if (classification === 'CONFLICT_REVIEW' && identityConfirmed) reasons.push(`review: ${fields.filter((f) => f.status === 'IDENTITY_REVIEW_REQUIRED').map((f) => f.field).join(', ')}`)
    if (classification === 'NO_CHANGE') reasons.push('identity consistent; nothing to change')
    rows.push({
      ...base,
      studentId: student.studentId,
      currentName: student.name,
      currentEmail: student.email,
      currentPhone: student.phone,
      currentBatch: student.batchName,
      classification,
      reasons,
      warnings,
      fields,
    })
  }

  for (const student of live) {
    if (matchedLiveIds.has(student.studentId)) continue
    const hasNumber = normalizeStudentNumber(student.studentNumber) !== null
    const suggestions = suggestedFor.get(student.studentId) ?? []
    rows.push({
      side: 'live',
      rowRef: null,
      studentId: student.studentId,
      studentNumber: student.studentNumber,
      currentName: student.name,
      incomingName: null,
      currentEmail: student.email,
      incomingEmail: null,
      currentPhone: student.phone,
      incomingPhone: null,
      currentBatch: student.batchName,
      incomingBatch: null,
      classification: hasNumber ? 'MISSING_FROM_CURRENT_LIST' : 'MISSING_STUDENT_NUMBER',
      reasons: [
        hasNumber
          ? 'live student absent from the current list by number; NOT treated as withdrawn: nothing is changed or deleted'
          : 'live student has no student number on hosted; it cannot be matched until one is recorded (manual review)',
        ...(suggestions.length > 0 ? [`possibly listed under another number: ${suggestions.join(', ')} (see that row)`] : []),
      ],
      warnings: [],
      fields: [],
    })
  }

  const safeChanges: SafeContactChange[] = rows.flatMap((row) =>
    row.fields
      .filter((f) => f.status === 'SAFE_CONTACT_UPDATE')
      .map((f) => {
        if (!(WRITABLE_FIELDS as readonly string[]).includes(f.field)) throw new Error(`safe change on a non-writable field: ${f.field}`)
        return {
          studentId: row.studentId as string,
          studentNumber: row.studentNumber as string,
          field: f.field as WritableField,
          expectedCurrent: null,
          newValue: f.incoming as string,
          rowRef: row.rowRef as string,
        }
      }),
  )
  const reviewItems: ReviewItem[] = rows.flatMap((row) =>
    row.fields
      .filter((f) => f.status === 'IDENTITY_REVIEW_REQUIRED')
      .map((f) => ({ studentId: row.studentId, studentNumber: row.studentNumber, rowRef: row.rowRef, field: f.field, current: f.current, incoming: f.incoming, note: f.note as string })),
  )

  const byClassification = emptyCounts()
  for (const row of rows) byClassification[row.classification] += 1
  const allFields = rows.flatMap((r) => r.fields)
  const fieldStatus = Object.fromEntries(
    SYNC_FIELDS.map((field) => [field, Object.fromEntries(FIELD_STATUSES.map((status) => [status, allFields.filter((f) => f.field === field && f.status === status).length]))]),
  ) as SyncSummary['fieldStatus']
  const summary: SyncSummary = {
    liveScopedStudents: live.length,
    incomingRows: file.rows.length,
    exactMatches: file.rows.filter(
      (row) => row.studentNumber !== null && (liveByNumber.get(row.studentNumber)?.length ?? 0) === 1 && (incomingByNumber.get(row.studentNumber)?.length ?? 0) === 1,
    ).length,
    byClassification,
    fieldStatus,
    safeContactUpdates: { email: safeChanges.filter((c) => c.field === 'email').length, phone: safeChanges.filter((c) => c.field === 'phone').length },
    reviewItems: reviewItems.length,
    proposedNumberChanges: reviewItems.filter((item) => item.field === 'studentNumber').length,
  }

  return {
    ticket: TICKET,
    planVersion: SYNC_PLAN_VERSION,
    normalizationRule: NORMALIZATION_RULE,
    scope: { id: input.scope.id, cohorts: input.scope.cohorts, batchIds: [...new Set(live.map((s) => s.batchId))].sort() },
    source: { fileName: file.fileName, sha256: file.sha256, sheet: file.sheet, headerRow: file.header.headerRow, mapped: file.header.mapped },
    hostedBaseline: {
      ...input.baseline,
      liveStudents: [...live]
        .map((s) => ({ studentId: s.studentId, studentNumber: s.studentNumber, name: s.name, email: s.email, phone: s.phone, batchId: s.batchId }))
        .sort((a, b) => a.studentId.localeCompare(b.studentId)),
    },
    rows,
    safeChanges,
    reviewItems,
    summary,
  }
}

export function syncPlanHash(plan: SyncPlan): string {
  return createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex')
}
