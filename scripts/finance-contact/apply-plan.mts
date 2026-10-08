/**
 * FINANCE-CONTACT-04B2 — the apply plan: pure, deterministic, program-generic.
 *
 * Takes the 04B1 row assessments (one per staged source row, already matched
 * to hosted students by exact student number) and reduces them to one
 * `ContactApplyCandidate` per UNIQUE hosted student, with a field-level
 * decision for email and for phone. Then it tallies the plan without a name,
 * number or contact value in the tally, and hashes the canonical plan so a
 * live apply can be tied to exactly the plan a reviewer saw.
 *
 * What this module never does: create a student, touch a name, batch, session
 * or finance row, or propose a value for a field that is not NULL. A hosted
 * value that differs from the source is a hold, never an overwrite. There is
 * no Supabase client here — the RPC arguments it produces are executed by the
 * CLI, and only in `--apply` mode.
 */

import { createHash } from 'node:crypto'

import type { ContactImportRow } from './canonical.mts'
import { normalizeEmail, normalizePhone } from './normalize.mts'
import type { HostedStudentLike, RowAssessment, SharedContact } from './reconcile.mts'
import type { ScopeConfig } from './scope.mts'

export const TICKET = 'FINANCE-CONTACT-04B2'
export const PLAN_VERSION = 1
export const SOURCE_TYPE = 'master_contact_import'
/** Bumped whenever the stored form of a field changes; recorded in every audit row. */
export const NORMALIZATION_RULE = 'contact-normalization/1'
export const NORMALIZATION_RULE_TEXT =
  'email: trimmed and lower-cased, spelling and domain untouched; phone: NANP only, stored as +1XXXXXXXXXX; anything ambiguous, invalid or non-NANP is held'

// -----------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------

export type FieldAction = 'fill' | 'hold' | 'none'

export type FieldReason =
  /** Hosted NULL, source valid, agreeing, not shared: write it. */
  | 'SAFE_FILL'
  /** Hosted already carries the source value (after a previous apply, or entered by hand). */
  | 'ALREADY_MATCHES'
  /** Hosted carries a different, non-NULL value. Never overwritten. */
  | 'HELD_CONTACT_DIFFERENCE'
  /** The value is shared by another student number in the masters (04B1 §7.2). */
  | 'HELD_SHARED_CONTACT'
  /** Rows for this student state different values. */
  | 'HELD_SOURCE_CONFLICT'
  | 'HELD_INVALID_EMAIL'
  | 'HELD_INVALID_PHONE'
  | 'HELD_AMBIGUOUS_PHONE'
  /** Written with an explicit non-1 country code; outside the approved NANP rule. */
  | 'HELD_NON_NANP_PHONE'
  /** The source states nothing for this field. */
  | 'NO_SOURCE_VALUE'

export type DeferralCategory =
  /** Exact number, no hosted student: belongs to the later roster/enrollment ticket. */
  | 'DEFERRED_NEW_STUDENT'
  /** No student number at all: never matched by name, email or phone. */
  | 'DEFERRED_MISSING_IDENTITY'
  /** The number matches more than one hosted row. */
  | 'HELD_DUPLICATE_HOSTED_NUMBER'

export type EvidenceFlag =
  | 'NAME_DIFFERENCE'
  | 'SESSION_DIFFERENCE'
  | 'INTAKE_DIFFERENCE'
  | 'HOSTED_UNASSIGNED'
  | 'REPEATED_SOURCE_NUMBER'
  | 'STUDENT_NUMBER_NOT_DIGITS'

// -----------------------------------------------------------------------------
// Shapes
// -----------------------------------------------------------------------------

/** Where a proposed value came from. Private plan / audit provenance only. */
export interface SourceEvidence {
  stagedRowId: string
  programCode: string
  workbook: string
  workbookSha256: string
  sheet: string
  table: string | null
  row: number
  studentNumber: string | null
  emailRaw: string | null
  emailNormalized: string | null
  emailStatus: ContactImportRow['emailStatus']
  phoneRaw: string | null
  phoneNormalized: string | null
  phoneStatus: ContactImportRow['phoneStatus']
  intakeLabel: string | null
  session: string | null
}

export interface ContactApplyCandidate {
  /** The hosted UUID the write targets. */
  studentId: string
  /** The hosted row's student_number exactly as stored; the RPC re-checks it. */
  studentNumber: string
  programCodes: string[]

  expectedCurrentEmail: string | null
  expectedCurrentPhone: string | null

  proposedEmail: string | null
  proposedPhone: string | null

  emailAction: FieldAction
  emailReason: FieldReason
  phoneAction: FieldAction
  phoneReason: FieldReason

  sourceEvidence: SourceEvidence[]
  sourceWorkbookHashes: string[]
  evidenceFlags: EvidenceFlag[]
  reasons: string[]
}

export interface DeferredRow {
  stagedRowId: string
  programCode: string
  category: DeferralCategory
  studentNumber: string | null
  hostedMatchCount: number
}

export interface HostedBaseline {
  projectRef: string
  counts: Record<string, number>
  studentsWithEmail: number
  studentsWithPhone: number
}

export interface PlanWorkbook {
  fileName: string
  sha256: string
  adapterId: string | null
}

/** The counts the dry run prints. No name, number or value anywhere in it. */
export interface PlanAggregate {
  operationalSourceRows: number
  uniqueOperationalNumbers: number
  existingHostedMatchRows: number
  uniqueMatchedStudents: number
  uniqueTargetStudents: number
  emailFills: number
  phoneFills: number
  studentsReceivingBoth: number
  studentsReceivingEmailOnly: number
  studentsReceivingPhoneOnly: number
  sharedContactHolds: number
  sharedEmailHolds: number
  sharedPhoneHolds: number
  invalidEmailHolds: number
  invalidPhoneHolds: number
  ambiguousPhoneHolds: number
  nonNanpPhoneHolds: number
  sourceConflictHolds: number
  contactDifferenceHolds: number
  emailAlreadyMatching: number
  phoneAlreadyMatching: number
  newStudentDeferralRows: number
  newStudentDeferrals: number
  missingIdDeferrals: number
  duplicateHostedNumberHolds: number
  nameDifferenceFlags: number
  sessionDifferenceFlags: number
  intakeDifferenceFlags: number
  repeatedNumberCollapsedCandidates: number
  studentRowsCreated: 0
  studentRowsOverwritten: 0
  expectedAuditRows: number
}

export interface ApplyPlan {
  ticket: typeof TICKET
  planVersion: typeof PLAN_VERSION
  normalizationRule: typeof NORMALIZATION_RULE
  scope: ScopeConfig
  sourceWorkbooks: PlanWorkbook[]
  hostedBaseline: HostedBaseline
  candidates: ContactApplyCandidate[]
  deferred: DeferredRow[]
  aggregate: PlanAggregate
}

// -----------------------------------------------------------------------------
// Field decisions
// -----------------------------------------------------------------------------

interface FieldDecision {
  action: FieldAction
  reason: FieldReason
  value: string | null
}

function distinct(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))].sort()
}

function hostedEmailKey(hosted: string): string {
  return normalizeEmail(hosted).normalized ?? hosted.trim().toLowerCase()
}

function hostedPhoneKey(hosted: string): string {
  return normalizePhone(hosted).normalized ?? hosted.replace(/[\s().-]/g, '')
}

/**
 * Email for one hosted student, from every operational row that matched it.
 * Order of precedence: the hosted value first (idempotency and the
 * never-overwrite rule), then source problems, then the shared-contact hold.
 */
export function decideEmail(rows: readonly ContactImportRow[], hostedEmail: string | null, sharedRowIds: ReadonlySet<string>): FieldDecision {
  const values = distinct(rows.filter((row) => row.emailStatus === 'valid').map((row) => row.emailNormalized))
  const anyInvalid = rows.some((row) => row.emailStatus === 'invalid')

  if (hostedEmail !== null) {
    if (values.length === 1 && values[0] === hostedEmailKey(hostedEmail)) return { action: 'none', reason: 'ALREADY_MATCHES', value: null }
    if (values.length === 0 && !anyInvalid) return { action: 'none', reason: 'NO_SOURCE_VALUE', value: null }
    return { action: 'hold', reason: 'HELD_CONTACT_DIFFERENCE', value: null }
  }
  if (values.length > 1) return { action: 'hold', reason: 'HELD_SOURCE_CONFLICT', value: null }
  if (anyInvalid) return { action: 'hold', reason: 'HELD_INVALID_EMAIL', value: null }
  if (values.length === 0) return { action: 'none', reason: 'NO_SOURCE_VALUE', value: null }
  if (rows.some((row) => sharedRowIds.has(row.stagedRowId))) return { action: 'hold', reason: 'HELD_SHARED_CONTACT', value: null }
  return { action: 'fill', reason: 'SAFE_FILL', value: values[0] }
}

/** Phone, same precedence. Only `valid_nanp` can fill; every other status is a named hold. */
export function decidePhone(rows: readonly ContactImportRow[], hostedPhone: string | null, sharedRowIds: ReadonlySet<string>): FieldDecision {
  const values = distinct(rows.filter((row) => row.phoneStatus === 'valid_nanp').map((row) => row.phoneNormalized))
  const statuses = new Set(rows.map((row) => row.phoneStatus))
  const anyProblem = statuses.has('invalid') || statuses.has('ambiguous') || statuses.has('international_explicit')

  if (hostedPhone !== null) {
    if (values.length === 1 && values[0] === hostedPhoneKey(hostedPhone)) return { action: 'none', reason: 'ALREADY_MATCHES', value: null }
    if (values.length === 0 && !anyProblem) return { action: 'none', reason: 'NO_SOURCE_VALUE', value: null }
    return { action: 'hold', reason: 'HELD_CONTACT_DIFFERENCE', value: null }
  }
  if (values.length > 1) return { action: 'hold', reason: 'HELD_SOURCE_CONFLICT', value: null }
  if (statuses.has('invalid')) return { action: 'hold', reason: 'HELD_INVALID_PHONE', value: null }
  if (statuses.has('ambiguous')) return { action: 'hold', reason: 'HELD_AMBIGUOUS_PHONE', value: null }
  if (statuses.has('international_explicit')) return { action: 'hold', reason: 'HELD_NON_NANP_PHONE', value: null }
  if (values.length === 0) return { action: 'none', reason: 'NO_SOURCE_VALUE', value: null }
  if (rows.some((row) => sharedRowIds.has(row.stagedRowId))) return { action: 'hold', reason: 'HELD_SHARED_CONTACT', value: null }
  return { action: 'fill', reason: 'SAFE_FILL', value: values[0] }
}

// -----------------------------------------------------------------------------
// Plan
// -----------------------------------------------------------------------------

export interface BuildPlanInput {
  /** Every assessment, all scopes; only operational rows enter the plan. */
  assessments: readonly RowAssessment[]
  shared: readonly SharedContact[]
  hostedStudents: readonly HostedStudentLike[]
  workbooks: readonly PlanWorkbook[]
  baseline: HostedBaseline
  scope: ScopeConfig
}

function evidenceOf(row: ContactImportRow, sha256ByWorkbook: ReadonlyMap<string, string>): SourceEvidence {
  return {
    stagedRowId: row.stagedRowId,
    programCode: row.programCode,
    workbook: row.sourceWorkbook,
    workbookSha256: sha256ByWorkbook.get(row.sourceWorkbook) ?? '',
    sheet: row.sourceSheet,
    table: row.sourceTable,
    row: row.sourceRow,
    studentNumber: row.studentNumber,
    emailRaw: row.emailRaw,
    emailNormalized: row.emailNormalized,
    emailStatus: row.emailStatus,
    phoneRaw: row.phoneRaw,
    phoneNormalized: row.phoneNormalized,
    phoneStatus: row.phoneStatus,
    intakeLabel: row.intakeLabel,
    session: row.session,
  }
}

export function buildApplyPlan(input: BuildPlanInput): ApplyPlan {
  const operational = input.assessments.filter((item) => item.row.exclusionReason === null)
  const sharedEmailRowIds = new Set(input.shared.filter((item) => item.kind === 'email').flatMap((item) => item.rowIds))
  const sharedPhoneRowIds = new Set(input.shared.filter((item) => item.kind === 'phone').flatMap((item) => item.rowIds))
  const sha256ByWorkbook = new Map(input.workbooks.map((workbook) => [workbook.fileName, workbook.sha256]))
  const hostedById = new Map(input.hostedStudents.map((student) => [student.id, student]))

  const deferred: DeferredRow[] = []
  const byStudent = new Map<string, RowAssessment[]>()
  for (const item of operational) {
    const base = { stagedRowId: item.row.stagedRowId, programCode: item.row.programCode, studentNumber: item.row.studentNumber, hostedMatchCount: item.hostedMatchCount }
    if (item.row.studentNumber === null) deferred.push({ ...base, category: 'DEFERRED_MISSING_IDENTITY' })
    else if (item.hostedMatchCount === 0) deferred.push({ ...base, category: 'DEFERRED_NEW_STUDENT' })
    else if (item.hostedMatchCount > 1 || item.hostedStudentId === null) deferred.push({ ...base, category: 'HELD_DUPLICATE_HOSTED_NUMBER' })
    else {
      const list = byStudent.get(item.hostedStudentId) ?? []
      list.push(item)
      byStudent.set(item.hostedStudentId, list)
    }
  }
  deferred.sort((a, b) => a.stagedRowId.localeCompare(b.stagedRowId))

  const candidates: ContactApplyCandidate[] = []
  for (const [studentId, items] of byStudent) {
    const hosted = hostedById.get(studentId)
    if (!hosted) throw new Error(`assessment points at a hosted student the snapshot does not hold: ${studentId}`)
    items.sort((a, b) => a.row.stagedRowId.localeCompare(b.row.stagedRowId))
    const rows = items.map((item) => item.row)

    const email = decideEmail(rows, hosted.email, sharedEmailRowIds)
    const phone = decidePhone(rows, hosted.phone, sharedPhoneRowIds)

    const flags = new Set<EvidenceFlag>()
    if (items.some((item) => item.nameDiffers === true)) flags.add('NAME_DIFFERENCE')
    if (items.some((item) => item.intake.sessionMatches === false)) flags.add('SESSION_DIFFERENCE')
    if (items.some((item) => item.intake.category === 'DIFFERENT_HOSTED_INTAKE')) flags.add('INTAKE_DIFFERENCE')
    if (items.some((item) => item.intake.category === 'HOSTED_UNASSIGNED')) flags.add('HOSTED_UNASSIGNED')
    if (items.length > 1) flags.add('REPEATED_SOURCE_NUMBER')
    if (items.some((item) => item.flags.includes('STUDENT_NUMBER_NOT_DIGITS'))) flags.add('STUDENT_NUMBER_NOT_DIGITS')
    const evidenceFlags = [...flags].sort()

    candidates.push({
      studentId,
      studentNumber: hosted.student_number ?? '',
      programCodes: [...new Set(rows.map((row) => row.programCode))].sort(),
      expectedCurrentEmail: hosted.email,
      expectedCurrentPhone: hosted.phone,
      proposedEmail: email.action === 'fill' ? email.value : null,
      proposedPhone: phone.action === 'fill' ? phone.value : null,
      emailAction: email.action,
      emailReason: email.reason,
      phoneAction: phone.action,
      phoneReason: phone.reason,
      sourceEvidence: rows.map((row) => evidenceOf(row, sha256ByWorkbook)),
      sourceWorkbookHashes: [...new Set(rows.map((row) => sha256ByWorkbook.get(row.sourceWorkbook) ?? ''))].sort(),
      evidenceFlags,
      reasons: [`email:${email.reason}`, `phone:${phone.reason}`, ...evidenceFlags],
    })
  }
  candidates.sort((a, b) => a.studentId.localeCompare(b.studentId))

  const plan: ApplyPlan = {
    ticket: TICKET,
    planVersion: PLAN_VERSION,
    normalizationRule: NORMALIZATION_RULE,
    scope: input.scope,
    sourceWorkbooks: [...input.workbooks].sort((a, b) => a.fileName.localeCompare(b.fileName)),
    hostedBaseline: input.baseline,
    candidates,
    deferred,
    aggregate: aggregatePlan(operational, candidates, deferred),
  }
  return plan
}

export function aggregatePlan(operational: readonly RowAssessment[], candidates: readonly ContactApplyCandidate[], deferred: readonly DeferredRow[]): PlanAggregate {
  const fills = (field: 'email' | 'phone') => candidates.filter((c) => (field === 'email' ? c.emailAction : c.phoneAction) === 'fill')
  const reason = (field: 'email' | 'phone', value: FieldReason) => candidates.filter((c) => (field === 'email' ? c.emailReason : c.phoneReason) === value).length
  const emailFill = new Set(fills('email').map((c) => c.studentId))
  const phoneFill = new Set(fills('phone').map((c) => c.studentId))
  const any = new Set([...emailFill, ...phoneFill])
  const both = [...emailFill].filter((id) => phoneFill.has(id)).length
  const sharedStudents = new Set(
    candidates.filter((c) => c.emailReason === 'HELD_SHARED_CONTACT' || c.phoneReason === 'HELD_SHARED_CONTACT').map((c) => c.studentId),
  )
  const newStudentRows = deferred.filter((item) => item.category === 'DEFERRED_NEW_STUDENT')

  return {
    operationalSourceRows: operational.length,
    uniqueOperationalNumbers: new Set(
      operational.filter((item) => item.row.studentNumber !== null).map((item) => `${item.row.programCode}:${item.row.studentNumber}`),
    ).size,
    existingHostedMatchRows: operational.filter((item) => item.hostedMatchCount === 1).length,
    uniqueMatchedStudents: candidates.length,
    uniqueTargetStudents: any.size,
    emailFills: emailFill.size,
    phoneFills: phoneFill.size,
    studentsReceivingBoth: both,
    studentsReceivingEmailOnly: emailFill.size - both,
    studentsReceivingPhoneOnly: phoneFill.size - both,
    sharedContactHolds: sharedStudents.size,
    sharedEmailHolds: reason('email', 'HELD_SHARED_CONTACT'),
    sharedPhoneHolds: reason('phone', 'HELD_SHARED_CONTACT'),
    invalidEmailHolds: reason('email', 'HELD_INVALID_EMAIL'),
    invalidPhoneHolds: reason('phone', 'HELD_INVALID_PHONE'),
    ambiguousPhoneHolds: reason('phone', 'HELD_AMBIGUOUS_PHONE'),
    nonNanpPhoneHolds: reason('phone', 'HELD_NON_NANP_PHONE'),
    sourceConflictHolds: candidates.filter((c) => c.emailReason === 'HELD_SOURCE_CONFLICT' || c.phoneReason === 'HELD_SOURCE_CONFLICT').length,
    contactDifferenceHolds: candidates.filter((c) => c.emailReason === 'HELD_CONTACT_DIFFERENCE' || c.phoneReason === 'HELD_CONTACT_DIFFERENCE').length,
    emailAlreadyMatching: reason('email', 'ALREADY_MATCHES'),
    phoneAlreadyMatching: reason('phone', 'ALREADY_MATCHES'),
    newStudentDeferralRows: newStudentRows.length,
    newStudentDeferrals: new Set(newStudentRows.map((item) => `${item.programCode}:${item.studentNumber}`)).size,
    missingIdDeferrals: deferred.filter((item) => item.category === 'DEFERRED_MISSING_IDENTITY').length,
    duplicateHostedNumberHolds: deferred.filter((item) => item.category === 'HELD_DUPLICATE_HOSTED_NUMBER').length,
    nameDifferenceFlags: candidates.filter((c) => c.evidenceFlags.includes('NAME_DIFFERENCE')).length,
    sessionDifferenceFlags: candidates.filter((c) => c.evidenceFlags.includes('SESSION_DIFFERENCE')).length,
    intakeDifferenceFlags: candidates.filter((c) => c.evidenceFlags.includes('INTAKE_DIFFERENCE')).length,
    repeatedNumberCollapsedCandidates: candidates.filter((c) => c.evidenceFlags.includes('REPEATED_SOURCE_NUMBER')).length,
    studentRowsCreated: 0,
    studentRowsOverwritten: 0,
    expectedAuditRows: any.size,
  }
}

// -----------------------------------------------------------------------------
// Canonical form and hash
// -----------------------------------------------------------------------------

/** JSON with object keys sorted at every level; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

/** SHA-256 of the canonical plan. Two runs over the same sources and hosted state produce the same hash. */
export function planHash(plan: ApplyPlan): string {
  return createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex')
}

// -----------------------------------------------------------------------------
// RPC arguments and execution (no client here; the CLI supplies the call)
// -----------------------------------------------------------------------------

export interface RpcArguments {
  p_student_id: string
  p_email: string | null
  p_phone: string | null
  p_expected_student_number: string | null
  p_metadata: Record<string, unknown>
}

/** True when the candidate asks the RPC to write at least one field. */
export function hasFill(candidate: ContactApplyCandidate): boolean {
  return candidate.emailAction === 'fill' || candidate.phoneAction === 'fill'
}

/** Provenance stored in `audit_log.metadata`. Raw source values only for the fields being filled. */
export function rpcArgumentsFor(candidate: ContactApplyCandidate, hash: string): RpcArguments {
  const fields = [candidate.emailAction === 'fill' ? 'email' : null, candidate.phoneAction === 'fill' ? 'phone' : null].filter(Boolean)
  return {
    p_student_id: candidate.studentId,
    p_email: candidate.emailAction === 'fill' ? candidate.proposedEmail : null,
    p_phone: candidate.phoneAction === 'fill' ? candidate.proposedPhone : null,
    p_expected_student_number: candidate.studentNumber === '' ? null : candidate.studentNumber,
    p_metadata: {
      ticket: TICKET,
      source_type: SOURCE_TYPE,
      plan_version: PLAN_VERSION,
      plan_hash: hash,
      normalization_rule: NORMALIZATION_RULE,
      program_codes: candidate.programCodes,
      requested_fields: fields,
      evidence_flags: candidate.evidenceFlags,
      sources: candidate.sourceEvidence.map((evidence) => ({
        staged_row_id: evidence.stagedRowId,
        program_code: evidence.programCode,
        workbook: evidence.workbook,
        workbook_sha256: evidence.workbookSha256,
        sheet: evidence.sheet,
        table: evidence.table,
        row: evidence.row,
        ...(candidate.emailAction === 'fill' ? { email_raw: evidence.emailRaw } : {}),
        ...(candidate.phoneAction === 'fill' ? { phone_raw: evidence.phoneRaw } : {}),
      })),
    },
  }
}

export type RpcResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string; code: string | null; details: string | null }

export type CandidateOutcomeStatus = 'applied' | 'STALE_TARGET' | 'FAILED'

export interface CandidateOutcome {
  studentId: string
  fields: ('email' | 'phone')[]
  status: CandidateOutcomeStatus
  message: string | null
  auditLogId: string | null
}

export interface ApplyExecution {
  outcomes: CandidateOutcome[]
  /** Set when the run stopped early because the caller is not allowed to write at all. */
  abortedBecause: string | null
  applied: number
  stale: number
  failed: number
  emailFieldsWritten: number
  phoneFieldsWritten: number
}

/** Codes the RPC raises that mean "no point continuing": every later call would fail the same way. */
const ABORTING_CODES = ['NOT_AUTHENTICATED', 'NOT_AUTHORISED']

/**
 * Runs the plan candidate by candidate, in plan order, through `call`.
 * A stale target is recorded and skipped, never retried and never claimed.
 */
export async function executeApply(
  plan: ApplyPlan,
  hash: string,
  call: (args: RpcArguments) => Promise<RpcResult>,
): Promise<ApplyExecution> {
  const outcomes: CandidateOutcome[] = []
  let abortedBecause: string | null = null

  for (const candidate of plan.candidates) {
    if (!hasFill(candidate)) continue
    const args = rpcArgumentsFor(candidate, hash)
    const fields = (args.p_metadata.requested_fields as ('email' | 'phone')[]) ?? []
    const result = await call(args)
    if (result.ok) {
      const data = (result.data ?? {}) as { audit_log_id?: unknown }
      outcomes.push({ studentId: candidate.studentId, fields, status: 'applied', message: null, auditLogId: typeof data.audit_log_id === 'string' ? data.audit_log_id : null })
      continue
    }
    const code = ABORTING_CODES.find((item) => result.message.startsWith(item))
    if (result.message.startsWith('STALE_TARGET')) {
      outcomes.push({ studentId: candidate.studentId, fields, status: 'STALE_TARGET', message: result.details ?? result.message, auditLogId: null })
      continue
    }
    outcomes.push({ studentId: candidate.studentId, fields, status: 'FAILED', message: result.message, auditLogId: null })
    if (code) {
      abortedBecause = code
      break
    }
  }

  const applied = outcomes.filter((item) => item.status === 'applied')
  return {
    outcomes,
    abortedBecause,
    applied: applied.length,
    stale: outcomes.filter((item) => item.status === 'STALE_TARGET').length,
    failed: outcomes.filter((item) => item.status === 'FAILED').length,
    emailFieldsWritten: applied.filter((item) => item.fields.includes('email')).length,
    phoneFieldsWritten: applied.filter((item) => item.fields.includes('phone')).length,
  }
}

// -----------------------------------------------------------------------------
// Rendering (aggregate only)
// -----------------------------------------------------------------------------

export function renderPlanAggregate(plan: ApplyPlan, hash: string): string {
  const a = plan.aggregate
  const row = (label: string, value: string | number) => `| ${label} | ${value} |`
  return [
    `# ${TICKET} — contact apply plan`,
    '',
    `Plan hash: \`${hash}\``,
    `Normalization rule: ${NORMALIZATION_RULE} — ${NORMALIZATION_RULE_TEXT}`,
    `Scope: operational from ${plan.scope.operationalCutoff} to ${plan.scope.operationalEnd ?? '(open)'}; ` +
      `explicitly excluded: ${plan.scope.excludedFutureIntakes.map((intake) => `${intake.programCode} ${intake.intakeDate}`).join(', ') || 'none'}`,
    '',
    '## Source workbooks',
    '',
    '| Workbook | sha256 | Adapter |',
    '| --- | --- | --- |',
    ...plan.sourceWorkbooks.map((workbook) => `| ${workbook.fileName} | ${workbook.sha256} | ${workbook.adapterId ?? 'none (not a contact master)'} |`),
    '',
    '## Hosted baseline',
    '',
    `Project ${plan.hostedBaseline.projectRef}`,
    '',
    '| Table | Count |',
    '| --- | ---: |',
    ...Object.entries(plan.hostedBaseline.counts).map(([table, count]) => row(table, count)),
    row('students with non-NULL email', plan.hostedBaseline.studentsWithEmail),
    row('students with non-NULL phone', plan.hostedBaseline.studentsWithPhone),
    '',
    '## Plan (aggregate only)',
    '',
    '| | |',
    '| --- | ---: |',
    row('operational source rows', a.operationalSourceRows),
    row('unique operational numbers', a.uniqueOperationalNumbers),
    row('existing hosted matches (rows)', a.existingHostedMatchRows),
    row('unique matched existing students', a.uniqueMatchedStudents),
    row('unique target students (any fill)', a.uniqueTargetStudents),
    row('email fills', a.emailFills),
    row('phone fills', a.phoneFills),
    row('students receiving both', a.studentsReceivingBoth),
    row('students receiving email only', a.studentsReceivingEmailOnly),
    row('students receiving phone only', a.studentsReceivingPhoneOnly),
    row('shared-contact holds (students)', a.sharedContactHolds),
    row('… email held as shared', a.sharedEmailHolds),
    row('… phone held as shared', a.sharedPhoneHolds),
    row('invalid-email holds', a.invalidEmailHolds),
    row('invalid-phone holds', a.invalidPhoneHolds),
    row('ambiguous-phone holds', a.ambiguousPhoneHolds),
    row('non-NANP phone holds', a.nonNanpPhoneHolds),
    row('source-conflict holds', a.sourceConflictHolds),
    row('contact-difference holds (hosted non-NULL, differs)', a.contactDifferenceHolds),
    row('email already matching hosted', a.emailAlreadyMatching),
    row('phone already matching hosted', a.phoneAlreadyMatching),
    row('new-student deferrals (rows / distinct numbers)', `${a.newStudentDeferralRows} / ${a.newStudentDeferrals}`),
    row('missing-ID deferrals', a.missingIdDeferrals),
    row('duplicate-hosted-number holds', a.duplicateHostedNumberHolds),
    row('name-difference flags', a.nameDifferenceFlags),
    row('session-difference flags', a.sessionDifferenceFlags),
    row('intake-difference flags', a.intakeDifferenceFlags),
    row('repeated-number collapsed candidates', a.repeatedNumberCollapsedCandidates),
    row('student rows that would be created', a.studentRowsCreated),
    row('student rows that would be overwritten', a.studentRowsOverwritten),
    row('expected audit_log rows after apply', a.expectedAuditRows),
  ].join('\n')
}
