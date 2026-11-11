/**
 * FINANCE-CONTACT-05B — contact plan for the live launch cohorts (pure).
 *
 * The 05A narrowed launch put PSW June, August and September 2026 live. This
 * module reduces the 04B2 machinery to exactly those students:
 *
 *  * the launch students are resolved from HOSTED data — every student with a
 *    finance record in a hosted PSW batch whose cohort month is one of the
 *    launch months — and cross-checked against `collection_mode = installment`;
 *  * master rows are joined by EXACT student number (the 04B1 engine's
 *    `normalizeStudentNumber`: surrounding whitespace only, no prefix or
 *    leading-zero folding), never by name, email or phone;
 *  * the field decisions are the 04B2 `buildApplyPlan` decisions unchanged, so
 *    a non-NULL hosted value is never proposed for overwrite;
 *  * each student gets one of six review statuses, decided on the email (the
 *    channel reminders and receipts go out on), with the phone reported beside.
 *
 * Nothing here talks to Supabase. The CLI (`launch-contact.mts`) supplies the
 * hosted rows and, only with `--apply --plan-hash=…`, executes the candidates
 * through `public.apply_student_contact_fill`.
 */

import { createHash } from 'node:crypto'

import type { CollectionAssessment } from '../finance-cutover/readiness.mts'

import {
  buildApplyPlan,
  canonicalJson,
  hasFill,
  NORMALIZATION_RULE,
  type ContactApplyCandidate,
  type FieldReason,
  type HostedBaseline,
  type PlanWorkbook,
} from './apply-plan.mts'
import type { ContactImportRow } from './canonical.mts'
import { normalizeStudentNumber } from './normalize.mts'
import type { HostedStudentLike, RowAssessment, SharedContact } from './reconcile.mts'
import type { ScopeConfig } from './scope.mts'

export const TICKET_05B = 'FINANCE-CONTACT-05B'
export const LAUNCH_PLAN_VERSION = 1

/**
 * Every master row is evidence for its exact number, whatever intake sheet it
 * sits on: the launch set is decided by hosted batches, not by the master's
 * dates. (The 04B1 default scope excludes September 2026, which is live now.)
 */
export const LAUNCH_CONTACT_SCOPE: ScopeConfig = {
  operationalCutoff: '0000-01-01',
  operationalEnd: null,
  excludedFutureIntakes: [],
}

export interface LaunchCohort {
  id: string
  label: string
  programShortCode: string
  yearMonth: string
}

/** The live launch, as 05A applied it. */
export const LAUNCH_COHORTS: readonly LaunchCohort[] = [
  { id: 'PSW-2026-06', label: 'PSW June 2026', programShortCode: 'PSW', yearMonth: '2026-06' },
  { id: 'PSW-2026-08', label: 'PSW August 2026', programShortCode: 'PSW', yearMonth: '2026-08' },
  { id: 'PSW-2026-09', label: 'PSW September 2026', programShortCode: 'PSW', yearMonth: '2026-09' },
]

/** Students per cohort the 05A apply created; any other count stops the run. */
export const EXPECTED_LAUNCH_STUDENTS: Readonly<Record<string, number>> = {
  'PSW-2026-06': 28,
  'PSW-2026-08': 18,
  'PSW-2026-09': 16,
}

export const LAUNCH_STATUSES = [
  'CONTACT_READY',
  'CONTACT_MISSING',
  'CONTACT_SHARED_REVIEW',
  'MISSING_STUDENT_NUMBER',
  'INVALID_CONTACT',
  'ALREADY_FILLED',
] as const

export type LaunchStatus = (typeof LAUNCH_STATUSES)[number]

// -----------------------------------------------------------------------------
// Launch scope
// -----------------------------------------------------------------------------

export interface LaunchProgramRow {
  id: string
  short_code: string
}

export interface LaunchBatchRow {
  id: string
  program_id: string
  name: string
  legacy_sheet_name: string | null
}

export interface LaunchRecordRow {
  id: string
  student_id: string
  batch_id: string | null
  collection_mode: string | null
}

export interface LaunchMember {
  studentId: string
  cohortId: string
  financeRecordId: string
  batchId: string
}

export interface LaunchScope {
  members: LaunchMember[]
  batchIdsByCohort: Record<string, string[]>
  problems: string[]
}

/**
 * Resolves the launch students from hosted rows. `cohortMonthOf` is the 05A
 * month parser (sheet title → year-month), passed in so this stays pure.
 */
export function resolveLaunchScope(input: {
  programs: readonly LaunchProgramRow[]
  batches: readonly LaunchBatchRow[]
  records: readonly LaunchRecordRow[]
  cohortMonthOf: (text: string) => string | null
  cohorts?: readonly LaunchCohort[]
  expected?: Readonly<Record<string, number>>
}): LaunchScope {
  const cohorts = input.cohorts ?? LAUNCH_COHORTS
  const expected = input.expected ?? EXPECTED_LAUNCH_STUDENTS
  const problems: string[] = []
  const batchIdsByCohort: Record<string, string[]> = {}
  const cohortByBatch = new Map<string, string>()
  const monthOfBatch = new Map<string, string | null>()
  for (const batch of input.batches) {
    // The sheet name is the cohort (as 05A and the grid group it): the August
    // 2026 sheet's batches are named and dated 29 July. The batch name is only
    // a fallback when the sheet name does not parse (two-digit year, "28 Sept 26").
    const fromSheet = batch.legacy_sheet_name === null ? null : input.cohortMonthOf(batch.legacy_sheet_name)
    monthOfBatch.set(batch.id, fromSheet ?? input.cohortMonthOf(batch.name))
  }
  for (const cohort of cohorts) {
    const programId = input.programs.find((program) => program.short_code === cohort.programShortCode)?.id
    if (programId === undefined) problems.push(`program ${cohort.programShortCode} is not on hosted`)
    const ids = input.batches
      .filter((batch) => batch.program_id === programId && monthOfBatch.get(batch.id) === cohort.yearMonth)
      .map((batch) => batch.id)
      .sort()
    if (ids.length === 0) problems.push(`${cohort.label}: no hosted batch`)
    batchIdsByCohort[cohort.id] = ids
    for (const id of ids) cohortByBatch.set(id, cohort.id)
  }

  const members: LaunchMember[] = []
  for (const record of input.records) {
    if (record.batch_id === null) continue
    const cohortId = cohortByBatch.get(record.batch_id)
    if (cohortId === undefined) continue
    members.push({ studentId: record.student_id, cohortId, financeRecordId: record.id, batchId: record.batch_id })
    if (record.collection_mode !== 'installment') problems.push(`launch record ${record.id} has collection_mode ${record.collection_mode ?? 'NULL'}, expected installment`)
  }
  members.sort((a, b) => a.cohortId.localeCompare(b.cohortId) || a.studentId.localeCompare(b.studentId))

  const launchRecordIds = new Set(members.map((member) => member.financeRecordId))
  const installmentOutside = input.records.filter((record) => record.collection_mode === 'installment' && !launchRecordIds.has(record.id)).length
  if (installmentOutside > 0) problems.push(`${installmentOutside} installment-mode record(s) sit outside the launch batches`)

  const studentCounts = new Map<string, number>()
  for (const member of members) studentCounts.set(member.studentId, (studentCounts.get(member.studentId) ?? 0) + 1)
  const twice = [...studentCounts.values()].filter((count) => count > 1).length
  if (twice > 0) problems.push(`${twice} student(s) hold more than one launch finance record`)

  for (const cohort of cohorts) {
    const actual = new Set(members.filter((member) => member.cohortId === cohort.id).map((member) => member.studentId)).size
    const want = expected[cohort.id]
    if (want !== undefined && actual !== want) problems.push(`${cohort.label}: ${actual} students on hosted, expected ${want}`)
  }
  return { members, batchIdsByCohort, problems }
}

// -----------------------------------------------------------------------------
// Per-student classification
// -----------------------------------------------------------------------------

export interface LaunchStudentAssessment {
  studentId: string
  cohortId: string
  financeRecordId: string
  status: LaunchStatus
  reason: string
  hasStudentNumber: boolean
  /** PSW master rows carrying this exact number. */
  exactMasterRows: number
  /** Other-program master rows with the same number (reported, never used). */
  otherProgramRows: number
  hostedNumberHolders: number
  hostedEmailPresent: boolean
  hostedPhonePresent: boolean
  emailReason: FieldReason | 'NO_MASTER_ROW' | 'NO_STUDENT_NUMBER' | 'DUPLICATE_HOSTED_NUMBER'
  phoneReason: FieldReason | 'NO_MASTER_ROW' | 'NO_STUDENT_NUMBER' | 'DUPLICATE_HOSTED_NUMBER'
  emailFill: boolean
  phoneFill: boolean
  evidenceFlags: string[]
}

const PHONE_INVALID: ReadonlySet<string> = new Set(['HELD_INVALID_PHONE', 'HELD_AMBIGUOUS_PHONE', 'HELD_NON_NANP_PHONE', 'HELD_SOURCE_CONFLICT'])

/**
 * Email decides the status (precedence top to bottom); the phone only decides
 * it when the master states no email at all.
 */
export function launchStatusOf(input: {
  hasStudentNumber: boolean
  exactMasterRows: number
  hostedNumberHolders: number
  hostedEmailPresent: boolean
  emailReason: string
  phoneReason: string
}): { status: LaunchStatus; reason: string } {
  if (!input.hasStudentNumber) return { status: 'MISSING_STUDENT_NUMBER', reason: 'hosted student has no student number; never matched by name' }
  if (input.hostedNumberHolders > 1) return { status: 'CONTACT_SHARED_REVIEW', reason: 'the student number is held by more than one hosted student' }
  if (input.exactMasterRows === 0) return { status: 'CONTACT_MISSING', reason: 'the exact student number is in no PSW master row' }
  if (input.emailReason === 'HELD_IDENTITY_CONFLICT') {
    return { status: 'CONTACT_SHARED_REVIEW', reason: 'identity conflict: the number matches but the master name shares no word with the hosted name; held' }
  }
  if (input.hostedEmailPresent) {
    return input.emailReason === 'ALREADY_MATCHES'
      ? { status: 'ALREADY_FILLED', reason: 'hosted email already equals the master email' }
      : { status: 'ALREADY_FILLED', reason: 'hosted email is already set (never overwritten)' }
  }
  switch (input.emailReason) {
    case 'SAFE_FILL':
      return { status: 'CONTACT_READY', reason: 'one valid, unshared master email for the exact number; hosted email NULL' }
    case 'HELD_SHARED_CONTACT':
      return { status: 'CONTACT_SHARED_REVIEW', reason: 'the master email is also stated for another student number' }
    case 'HELD_INVALID_EMAIL':
      return { status: 'INVALID_CONTACT', reason: 'the master email is not a valid address' }
    case 'HELD_SOURCE_CONFLICT':
      return { status: 'INVALID_CONTACT', reason: 'master rows for this number state different emails' }
    default:
      break
  }
  if (input.phoneReason === 'HELD_SHARED_CONTACT') return { status: 'CONTACT_SHARED_REVIEW', reason: 'no master email; the phone is shared with another student number' }
  if (PHONE_INVALID.has(input.phoneReason)) return { status: 'INVALID_CONTACT', reason: 'no master email; the phone is invalid, ambiguous, non-NANP or conflicting' }
  return { status: 'CONTACT_MISSING', reason: 'the master row states no email' }
}

// -----------------------------------------------------------------------------
// Identity veto
// -----------------------------------------------------------------------------

/** Upper-case letter runs of two or more characters. */
export function nameWords(...parts: readonly (string | null | undefined)[]): Set<string> {
  const out = new Set<string>()
  for (const part of parts) {
    for (const word of (part ?? '').toUpperCase().split(/[^A-Z]+/)) if (word.length >= 2) out.add(word)
  }
  return out
}

/**
 * True when the hosted student and every master row matched to it by exact
 * number share no name word at all. A veto only: it can stop a fill, it never
 * makes a match. Missing names on either side are not a conflict.
 */
export function identityConflict(
  hosted: Pick<HostedStudentLike, 'first_name' | 'middle_name' | 'last_name' | 'display_name' | 'legacy_name'>,
  masterRows: readonly Pick<ContactImportRow, 'firstName' | 'middleName' | 'lastName' | 'displayName'>[],
): boolean {
  const hostedWords = nameWords(hosted.first_name, hosted.middle_name, hosted.last_name, hosted.display_name, hosted.legacy_name)
  const masterWords = nameWords(...masterRows.flatMap((row) => [row.firstName, row.middleName, row.lastName, row.displayName]))
  if (hostedWords.size === 0 || masterWords.size === 0) return false
  return ![...hostedWords].some((word) => masterWords.has(word))
}

export function holdForIdentity(candidate: ContactApplyCandidate): ContactApplyCandidate {
  const evidenceFlags = [...new Set([...candidate.evidenceFlags, 'IDENTITY_CONFLICT' as const])].sort()
  return {
    ...candidate,
    proposedEmail: null,
    proposedPhone: null,
    emailAction: candidate.emailAction === 'none' ? 'none' : 'hold',
    emailReason: candidate.emailAction === 'none' ? candidate.emailReason : 'HELD_IDENTITY_CONFLICT',
    phoneAction: candidate.phoneAction === 'none' ? 'none' : 'hold',
    phoneReason: candidate.phoneAction === 'none' ? candidate.phoneReason : 'HELD_IDENTITY_CONFLICT',
    evidenceFlags,
    reasons: [...candidate.reasons.filter((reason) => !reason.startsWith('email:') && !reason.startsWith('phone:')),
      `email:${candidate.emailAction === 'none' ? candidate.emailReason : 'HELD_IDENTITY_CONFLICT'}`,
      `phone:${candidate.phoneAction === 'none' ? candidate.phoneReason : 'HELD_IDENTITY_CONFLICT'}`,
      'IDENTITY_CONFLICT'],
  }
}

// -----------------------------------------------------------------------------
// Plan
// -----------------------------------------------------------------------------

export interface LaunchPlanAggregate {
  launchStudents: number
  byCohort: Record<string, Record<LaunchStatus, number>>
  byStatus: Record<LaunchStatus, number>
  exactNumberMatches: number
  emailFills: number
  phoneFills: number
  both: number
  emailOnly: number
  phoneOnly: number
  missingFromMaster: number
  sharedReview: number
  sharedEmailHolds: number
  sharedPhoneHolds: number
  missingStudentNumber: number
  invalidEmail: number
  invalidPhone: number
  ambiguousOrNonNanpPhone: number
  sourceConflicts: number
  identityConflicts: number
  alreadyFilledStudents: number
  hostedEmailPresent: number
  hostedPhonePresent: number
  numberAlsoInOtherProgramMaster: number
  nameDifferenceFlags: number
  intakeDifferenceFlags: number
  repeatedNumberFlags: number
  expectedAuditRows: number
  expectedEmailNonNullAfter: number
  expectedPhoneNonNullAfter: number
  studentRowsCreated: 0
  nonNullFieldsOverwritten: 0
}

export interface LaunchContactPlan {
  ticket: typeof TICKET_05B
  planVersion: typeof LAUNCH_PLAN_VERSION
  normalizationRule: typeof NORMALIZATION_RULE
  launch: { cohorts: LaunchCohort[]; batchIdsByCohort: Record<string, string[]>; studentIds: string[] }
  sourceWorkbooks: PlanWorkbook[]
  /** The master whose rows are evidence. Shared-contact detection still spans every master. */
  evidenceProgram: 'PSW'
  hostedBaseline: HostedBaseline
  students: LaunchStudentAssessment[]
  /** 04B2 candidates, launch students only; the apply executes these. */
  candidates: ContactApplyCandidate[]
  aggregate: LaunchPlanAggregate
}

export interface BuildLaunchPlanInput {
  scope: LaunchScope
  /** Assessments of every staged row (all masters, open scope). */
  assessments: readonly RowAssessment[]
  allRows: readonly ContactImportRow[]
  shared: readonly SharedContact[]
  hostedStudents: readonly HostedStudentLike[]
  workbooks: readonly PlanWorkbook[]
  baseline: HostedBaseline
}

function emptyStatusCounts(): Record<LaunchStatus, number> {
  return Object.fromEntries(LAUNCH_STATUSES.map((status) => [status, 0])) as Record<LaunchStatus, number>
}

export function buildLaunchContactPlan(input: BuildLaunchPlanInput): LaunchContactPlan {
  const launchIds = new Set(input.scope.members.map((member) => member.studentId))
  const hostedById = new Map(input.hostedStudents.map((student) => [student.id, student]))
  const holdersByNumber = new Map<string, number>()
  for (const student of input.hostedStudents) {
    const number = normalizeStudentNumber(student.student_number)
    if (number !== null) holdersByNumber.set(number, (holdersByNumber.get(number) ?? 0) + 1)
  }

  // 04B2 decisions on the PSW rows that matched exactly one launch student.
  const launchAssessments = input.assessments.filter(
    (item) =>
      item.row.programCode === 'PSW' &&
      item.row.exclusionReason === null &&
      item.hostedMatchCount === 1 &&
      item.hostedStudentId !== null &&
      launchIds.has(item.hostedStudentId),
  )
  const base = buildApplyPlan({
    assessments: launchAssessments,
    shared: input.shared,
    hostedStudents: input.hostedStudents,
    workbooks: input.workbooks,
    baseline: input.baseline,
    scope: LAUNCH_CONTACT_SCOPE,
  })
  const rowById = new Map(input.allRows.map((row) => [row.stagedRowId, row]))
  const vetoed = base.candidates.map((candidate) => {
    const hosted = hostedById.get(candidate.studentId)
    const masterRows = candidate.sourceEvidence.map((evidence) => rowById.get(evidence.stagedRowId)).filter((row) => row !== undefined)
    if (!hosted || !identityConflict(hosted, masterRows)) return candidate
    return holdForIdentity(candidate)
  })
  const candidateById = new Map(vetoed.map((candidate) => [candidate.studentId, candidate]))

  const rowsByNumber = new Map<string, ContactImportRow[]>()
  for (const row of input.allRows) {
    if (row.studentNumber === null) continue
    rowsByNumber.set(row.studentNumber, [...(rowsByNumber.get(row.studentNumber) ?? []), row])
  }

  const students: LaunchStudentAssessment[] = input.scope.members.map((member) => {
    const hosted = hostedById.get(member.studentId)
    if (!hosted) throw new Error(`launch record points at a student the snapshot does not hold: ${member.studentId}`)
    const number = normalizeStudentNumber(hosted.student_number)
    const rows = number === null ? [] : (rowsByNumber.get(number) ?? [])
    const pswRows = rows.filter((row) => row.programCode === 'PSW').length
    const otherRows = rows.length - pswRows
    const holders = number === null ? 0 : (holdersByNumber.get(number) ?? 0)
    const candidate = candidateById.get(member.studentId)
    const emailReason =
      number === null ? 'NO_STUDENT_NUMBER' : holders > 1 ? 'DUPLICATE_HOSTED_NUMBER' : candidate ? candidate.emailReason : 'NO_MASTER_ROW'
    const phoneReason =
      number === null ? 'NO_STUDENT_NUMBER' : holders > 1 ? 'DUPLICATE_HOSTED_NUMBER' : candidate ? candidate.phoneReason : 'NO_MASTER_ROW'
    if (candidate === undefined && number !== null && holders === 1 && pswRows > 0) {
      throw new Error(`launch student ${member.studentId} has PSW master rows but no 04B2 candidate`)
    }
    const { status, reason } = launchStatusOf({
      hasStudentNumber: number !== null,
      exactMasterRows: pswRows,
      hostedNumberHolders: holders,
      hostedEmailPresent: hosted.email !== null,
      emailReason,
      phoneReason,
    })
    return {
      studentId: member.studentId,
      cohortId: member.cohortId,
      financeRecordId: member.financeRecordId,
      status,
      reason,
      hasStudentNumber: number !== null,
      exactMasterRows: pswRows,
      otherProgramRows: otherRows,
      hostedNumberHolders: holders,
      hostedEmailPresent: hosted.email !== null,
      hostedPhonePresent: hosted.phone !== null,
      emailReason,
      phoneReason,
      emailFill: candidate?.emailAction === 'fill',
      phoneFill: candidate?.phoneAction === 'fill',
      evidenceFlags: candidate?.evidenceFlags ?? [],
    }
  })

  const candidates = vetoed.filter((candidate) => launchIds.has(candidate.studentId))
  const plan: LaunchContactPlan = {
    ticket: TICKET_05B,
    planVersion: LAUNCH_PLAN_VERSION,
    normalizationRule: NORMALIZATION_RULE,
    launch: {
      cohorts: [...LAUNCH_COHORTS],
      batchIdsByCohort: input.scope.batchIdsByCohort,
      studentIds: [...launchIds].sort(),
    },
    sourceWorkbooks: [...input.workbooks].sort((a, b) => a.fileName.localeCompare(b.fileName)),
    evidenceProgram: 'PSW',
    hostedBaseline: input.baseline,
    students,
    candidates,
    aggregate: aggregateLaunch(students, candidates, input.baseline),
  }
  return plan
}

export function aggregateLaunch(
  students: readonly LaunchStudentAssessment[],
  candidates: readonly ContactApplyCandidate[],
  baseline: HostedBaseline,
): LaunchPlanAggregate {
  const byCohort: Record<string, Record<LaunchStatus, number>> = {}
  const byStatus = emptyStatusCounts()
  for (const student of students) {
    byCohort[student.cohortId] ??= emptyStatusCounts()
    byCohort[student.cohortId][student.status] += 1
    byStatus[student.status] += 1
  }
  const emailFills = students.filter((s) => s.emailFill).length
  const phoneFills = students.filter((s) => s.phoneFill).length
  const both = students.filter((s) => s.emailFill && s.phoneFill).length
  const reason = (field: 'emailReason' | 'phoneReason', value: string) => students.filter((s) => s[field] === value).length
  return {
    launchStudents: students.length,
    byCohort,
    byStatus,
    exactNumberMatches: students.filter((s) => s.exactMasterRows > 0).length,
    emailFills,
    phoneFills,
    both,
    emailOnly: emailFills - both,
    phoneOnly: phoneFills - both,
    missingFromMaster: students.filter((s) => s.hasStudentNumber && s.exactMasterRows === 0).length,
    sharedReview: byStatus.CONTACT_SHARED_REVIEW,
    sharedEmailHolds: reason('emailReason', 'HELD_SHARED_CONTACT'),
    sharedPhoneHolds: reason('phoneReason', 'HELD_SHARED_CONTACT'),
    missingStudentNumber: byStatus.MISSING_STUDENT_NUMBER,
    invalidEmail: reason('emailReason', 'HELD_INVALID_EMAIL'),
    invalidPhone: reason('phoneReason', 'HELD_INVALID_PHONE'),
    ambiguousOrNonNanpPhone: reason('phoneReason', 'HELD_AMBIGUOUS_PHONE') + reason('phoneReason', 'HELD_NON_NANP_PHONE'),
    sourceConflicts: students.filter((s) => s.emailReason === 'HELD_SOURCE_CONFLICT' || s.phoneReason === 'HELD_SOURCE_CONFLICT').length,
    identityConflicts: students.filter((s) => s.evidenceFlags.includes('IDENTITY_CONFLICT')).length,
    alreadyFilledStudents: byStatus.ALREADY_FILLED,
    hostedEmailPresent: students.filter((s) => s.hostedEmailPresent).length,
    hostedPhonePresent: students.filter((s) => s.hostedPhonePresent).length,
    numberAlsoInOtherProgramMaster: students.filter((s) => s.otherProgramRows > 0).length,
    nameDifferenceFlags: students.filter((s) => s.evidenceFlags.includes('NAME_DIFFERENCE')).length,
    intakeDifferenceFlags: students.filter((s) => s.evidenceFlags.includes('INTAKE_DIFFERENCE')).length,
    repeatedNumberFlags: students.filter((s) => s.evidenceFlags.includes('REPEATED_SOURCE_NUMBER')).length,
    expectedAuditRows: candidates.filter(hasFill).length,
    expectedEmailNonNullAfter: baseline.studentsWithEmail + emailFills,
    expectedPhoneNonNullAfter: baseline.studentsWithPhone + phoneFills,
    studentRowsCreated: 0,
    nonNullFieldsOverwritten: 0,
  }
}

/** SHA-256 of the canonical plan (key-sorted JSON), as 04B2 hashes its plan. */
export function launchPlanHash(plan: LaunchContactPlan): string {
  return createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex')
}

// -----------------------------------------------------------------------------
// Owing (report only; not part of the plan hash)
// -----------------------------------------------------------------------------

export interface OwingSummary {
  owing: number
  owingAmount: number
  gainEmail: number
  gainEmailAmount: number
  stillWithoutEmail: number
  stillWithoutEmailAmount: number
  alreadyHaveEmail: number
  alreadyHaveEmailAmount: number
  cannotDetermine: number
  byStatus: Record<string, { students: number; amount: number }>
}

const cents = (value: number): number => Math.round(value * 100) / 100

export function owingSummary(students: readonly LaunchStudentAssessment[], collections: readonly CollectionAssessment[]): OwingSummary {
  const byRecord = new Map(collections.map((entry) => [entry.financeRecordId, entry]))
  const owing = students
    .map((student) => ({ student, entry: byRecord.get(student.financeRecordId) }))
    .filter((item): item is { student: LaunchStudentAssessment; entry: CollectionAssessment } => item.entry?.status === 'AMOUNT_DUE_THROUGH_MONTH')
  const sum = (items: typeof owing) => cents(items.reduce((total, item) => total + (item.entry.amountDue ?? 0), 0))
  const gain = owing.filter((item) => item.student.emailFill)
  const have = owing.filter((item) => item.student.hostedEmailPresent)
  const still = owing.filter((item) => !item.student.emailFill && !item.student.hostedEmailPresent)
  const byStatus: Record<string, { students: number; amount: number }> = {}
  for (const item of owing) {
    const slot = (byStatus[item.student.status] ??= { students: 0, amount: 0 })
    slot.students += 1
    slot.amount = cents(slot.amount + (item.entry.amountDue ?? 0))
  }
  return {
    owing: owing.length,
    owingAmount: sum(owing),
    gainEmail: gain.length,
    gainEmailAmount: sum(gain),
    stillWithoutEmail: still.length,
    stillWithoutEmailAmount: sum(still),
    alreadyHaveEmail: have.length,
    alreadyHaveEmailAmount: sum(have),
    cannotDetermine: students.filter((student) => byRecord.get(student.financeRecordId)?.status === 'CANNOT_DETERMINE').length,
    byStatus,
  }
}
