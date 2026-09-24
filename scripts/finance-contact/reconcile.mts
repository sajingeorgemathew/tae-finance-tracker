/**
 * The generic reconciliation engine — pure, program-independent, read-only.
 *
 * Takes canonical rows from any number of adapters and a snapshot of the
 * hosted students, programs, batches and finance records, and produces, per
 * staged row, one primary resolution category and any number of flags; plus
 * the workbook-level checks — duplicates, shared contacts, source conflicts,
 * master/subset cross-checks, intake cross-checks, the Unassigned-record
 * cross-check and source conservation.
 *
 * Identity is the exact student number and nothing else. Names, emails,
 * phones, intakes and months never link a source row to a hosted student;
 * where two rows share one of those, the fact is *reported* for review.
 *
 * Nothing here decides what to write. The categories describe what an apply
 * ticket *would* face; this module has no side effects and no Supabase
 * client.
 */

import {
  type ContactImportRow,
  type Flag,
  type IntakeCategory,
  type PrimaryCategory,
} from './canonical.mts'
import { nameComparisonKey, normalizeEmail, normalizePhone, normalizeStudentNumber } from './normalize.mts'
import type { SheetScan } from './table-scan.mts'

// -----------------------------------------------------------------------------
// Hosted shapes — the minimum the engine needs
// -----------------------------------------------------------------------------

export interface HostedStudentLike {
  id: string
  student_number: string | null
  first_name: string | null
  middle_name: string | null
  last_name: string | null
  display_name: string | null
  legacy_name: string | null
  email: string | null
  phone: string | null
}

export interface HostedProgramLike {
  id: string
  short_code: string
}

export interface HostedBatchLike {
  id: string
  program_id: string
  name: string
  legacy_sheet_name: string | null
  start_date: string | null
}

export interface HostedFinanceRecordLike {
  id: string
  student_id: string
  program_id: string
  batch_id: string | null
}

/** A hosted intake as the grid groups it: one or two batches from one sheet. */
export interface HostedIntakeLike {
  key: string
  programCode: string
  label: string
  /** `YYYY-MM-DD` when a batch records a start date. */
  startDate: string | null
  /** `YYYY-MM` the intake is dated or titled to. */
  yearMonth: string | null
  /**
   * `YYYY-MM` stated by the *sheet* the batches were imported from, when it
   * differs from the batch titles (the finance workbook's "Aug 2026" sheet
   * holds tables titled 29 July 2026). Weakest mapping evidence; labelled.
   */
  titleYearMonth: string | null
  batches: { id: string; name: string; session: 'Morning' | 'Evening' | null }[]
}

export interface HostedSnapshot {
  students: HostedStudentLike[]
  programs: HostedProgramLike[]
  batches: HostedBatchLike[]
  records: HostedFinanceRecordLike[]
  intakes: HostedIntakeLike[]
}

// -----------------------------------------------------------------------------
// Per-row assessment
// -----------------------------------------------------------------------------

export type FieldComparison =
  | 'unchanged'
  | 'fill'
  | 'difference'
  | 'source_missing'
  | 'source_invalid'
  | 'not_applicable'

export interface IntakeCrossCheck {
  category: IntakeCategory
  sourceIntakeLabel: string | null
  sourceIntakeDate: string | null
  sourceSession: string | null
  /** The hosted intake the source intake maps to, when it does. */
  mappedHostedIntakeKey: string | null
  mappedHostedIntakeLabel: string | null
  mappedBy: IntakeMapping['mappedBy'] | null
  /** The hosted batches the student's finance records point at. */
  hostedBatchNames: string[]
  hostedIntakeLabels: string[]
  /** Whether the record's batch session equals the source session; null when either is unstated. */
  sessionMatches: boolean | null
}

export interface RowAssessment {
  row: ContactImportRow
  primary: PrimaryCategory
  flags: Flag[]
  hostedStudentId: string | null
  hostedMatchCount: number
  hostedEmail: string | null
  hostedPhone: string | null
  hostedName: string | null
  emailComparison: FieldComparison
  phoneComparison: FieldComparison
  nameDiffers: boolean | null
  intake: IntakeCrossCheck
}

function hostedName(student: HostedStudentLike): string | null {
  const parts = [student.first_name, student.middle_name, student.last_name]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .map((part) => part.trim())
  if (parts.length > 0) return parts.join(' ')
  return student.display_name?.trim() || student.legacy_name?.trim() || null
}

function compareEmail(row: ContactImportRow, hosted: string | null): FieldComparison {
  if (row.emailStatus === 'missing') return 'source_missing'
  if (row.emailStatus === 'invalid') return 'source_invalid'
  const hostedNormalized = normalizeEmail(hosted)
  if (hostedNormalized.status === 'missing') return 'fill'
  const hostedKey = hostedNormalized.normalized ?? (hosted ?? '').trim().toLowerCase()
  return hostedKey === row.emailNormalized ? 'unchanged' : 'difference'
}

function comparePhone(row: ContactImportRow, hosted: string | null): FieldComparison {
  if (row.phoneStatus === 'missing') return 'source_missing'
  if (row.phoneStatus === 'invalid' || row.phoneStatus === 'ambiguous') return 'source_invalid'
  const hostedNormalized = normalizePhone(hosted)
  if (hostedNormalized.status === 'missing') return 'fill'
  const hostedKey = hostedNormalized.normalized ?? (hosted ?? '').replace(/[\s().-]/g, '')
  return hostedKey === row.phoneNormalized ? 'unchanged' : 'difference'
}

// -----------------------------------------------------------------------------
// Intake mapping
// -----------------------------------------------------------------------------

export interface IntakeMapping {
  intake: HostedIntakeLike
  mappedBy: 'start_date' | 'year_month' | 'sheet_title_month' | 'single_program_intake'
}

/**
 * Source intake -> hosted intake. Exact start date first; then the stated
 * month; then the month the hosted *sheet title* states (weakest, labelled);
 * then, for a source that dates no intake, the program's only hosted intake.
 * Anything else is unmapped — reported, never guessed.
 */
export function mapSourceIntake(
  programCode: string,
  intakeDate: string | null,
  hostedIntakes: readonly HostedIntakeLike[],
): IntakeMapping | null {
  const candidates = hostedIntakes.filter((intake) => intake.programCode === programCode)
  if (intakeDate !== null) {
    const byDate = candidates.filter((intake) => intake.startDate === intakeDate)
    if (byDate.length === 1) return { intake: byDate[0], mappedBy: 'start_date' }
    const month = intakeDate.slice(0, 7)
    const byMonth = candidates.filter((intake) => intake.yearMonth === month)
    if (byMonth.length === 1) return { intake: byMonth[0], mappedBy: 'year_month' }
    const byTitle = candidates.filter((intake) => intake.titleYearMonth === month)
    if (byTitle.length === 1) return { intake: byTitle[0], mappedBy: 'sheet_title_month' }
    return null
  }
  if (candidates.length === 1) return { intake: candidates[0], mappedBy: 'single_program_intake' }
  return null
}

function sessionOfBatchName(name: string): 'Morning' | 'Evening' | null {
  if (/\bmorning\b/i.test(name)) return 'Morning'
  if (/\bevening\b/i.test(name)) return 'Evening'
  return null
}

function crossCheckIntake(
  row: ContactImportRow,
  student: HostedStudentLike | null,
  hosted: HostedSnapshot,
  index: HostedIndex,
): IntakeCrossCheck {
  const base: IntakeCrossCheck = {
    category: 'NOT_APPLICABLE',
    sourceIntakeLabel: row.intakeLabel,
    sourceIntakeDate: row.intakeDate,
    sourceSession: row.session,
    mappedHostedIntakeKey: null,
    mappedHostedIntakeLabel: null,
    mappedBy: null,
    hostedBatchNames: [],
    hostedIntakeLabels: [],
    sessionMatches: null,
  }

  const mapping = mapSourceIntake(row.programCode, row.intakeDate, hosted.intakes)
  if (mapping) {
    base.mappedHostedIntakeKey = mapping.intake.key
    base.mappedHostedIntakeLabel = mapping.intake.label
    base.mappedBy = mapping.mappedBy
  }

  if (student === null) return base

  const program = index.programByCode.get(row.programCode)
  const records = (index.recordsByStudent.get(student.id) ?? []).filter(
    (record) => program === undefined || record.program_id === program.id,
  )
  if (records.length === 0) return { ...base, category: 'NO_FINANCE_RECORD' }

  const batchIds = records.map((record) => record.batch_id).filter((id): id is string => id !== null)
  if (batchIds.length === 0) return { ...base, category: 'HOSTED_UNASSIGNED' }

  const batches = batchIds.map((id) => index.batchById.get(id)).filter((batch): batch is HostedBatchLike => batch !== undefined)
  base.hostedBatchNames = batches.map((batch) => batch.name)
  base.hostedIntakeLabels = batches
    .map((batch) => index.intakeByBatchId.get(batch.id)?.label ?? batch.name)
    .filter((label, position, all) => all.indexOf(label) === position)

  if (mapping === null) return { ...base, category: 'SOURCE_INTAKE_NOT_MAPPED' }

  const inMapped = batches.filter((batch) => mapping.intake.batches.some((candidate) => candidate.id === batch.id))
  if (inMapped.length === 0) return { ...base, category: 'DIFFERENT_HOSTED_INTAKE' }

  const sourceSession = row.session === 'Morning' || row.session === 'Evening' ? row.session : null
  const batchSessions = inMapped.map((batch) => sessionOfBatchName(batch.name))
  const sessionMatches =
    sourceSession === null || batchSessions.every((session) => session === null)
      ? null
      : batchSessions.some((session) => session === sourceSession)

  return { ...base, category: 'MATCHES_HOSTED_INTAKE', sessionMatches }
}

// -----------------------------------------------------------------------------
// Indexes
// -----------------------------------------------------------------------------

interface HostedIndex {
  studentsByNumber: Map<string, HostedStudentLike[]>
  programByCode: Map<string, HostedProgramLike>
  batchById: Map<string, HostedBatchLike>
  recordsByStudent: Map<string, HostedFinanceRecordLike[]>
  intakeByBatchId: Map<string, HostedIntakeLike>
}

function indexHosted(hosted: HostedSnapshot): HostedIndex {
  const studentsByNumber = new Map<string, HostedStudentLike[]>()
  for (const student of hosted.students) {
    const number = normalizeStudentNumber(student.student_number)
    if (number === null) continue
    const list = studentsByNumber.get(number) ?? []
    list.push(student)
    studentsByNumber.set(number, list)
  }
  const recordsByStudent = new Map<string, HostedFinanceRecordLike[]>()
  for (const record of hosted.records) {
    const list = recordsByStudent.get(record.student_id) ?? []
    list.push(record)
    recordsByStudent.set(record.student_id, list)
  }
  const intakeByBatchId = new Map<string, HostedIntakeLike>()
  for (const intake of hosted.intakes) for (const batch of intake.batches) intakeByBatchId.set(batch.id, intake)
  return {
    studentsByNumber,
    programByCode: new Map(hosted.programs.map((program) => [program.short_code, program])),
    batchById: new Map(hosted.batches.map((batch) => [batch.id, batch])),
    recordsByStudent,
    intakeByBatchId,
  }
}

// -----------------------------------------------------------------------------
// Duplicates, shared contacts, conflicts
// -----------------------------------------------------------------------------

export type DuplicateExplanation =
  /** Same table lists the number twice. */
  | 'source_duplication_within_table'
  /** Different tables, every staged field identical: the row was copied. */
  | 'identical_rows_across_tables'
  /** Different intakes, same person by contact: a re-enrollment or transfer candidate. */
  | 'repeat_or_transfer_candidate'
  /** Different intakes and the contact or name differs: cannot say. */
  | 'unresolved_ambiguity'

export interface DuplicateGroup {
  programCode: string
  studentNumber: string
  rowIds: string[]
  /** `sheet / table / session` per row, for the private report. */
  locations: string[]
  distinctIntakes: number
  sameEmail: boolean
  samePhone: boolean
  sameName: boolean
  explanation: DuplicateExplanation
  /** True when the rows disagree on a contact value — an apply could not pick. */
  conflictingContact: boolean
}

export interface SharedContact {
  kind: 'email' | 'phone'
  /** The normalized value. Private report only. */
  value: string
  studentNumbers: string[]
  rowIds: string[]
}

export interface SourceConflict {
  programCode: string
  studentNumber: string
  field: 'email' | 'phone' | 'name' | 'session'
  sourceA: { rowId: string; location: string; value: string | null }
  sourceB: { rowId: string; location: string; value: string | null }
  /** Which side the workbook's structure ranks first, when it does. */
  structurallyPrimary: 'A' | 'B' | 'none'
  note: string
}

function locationOf(row: ContactImportRow): string {
  return `${row.sourceSheet} / ${row.sourceTable ?? '(untitled table)'} / ${row.session ?? 'session not stated'} / row ${row.sourceRow}`
}

function distinct(values: readonly (string | null)[]): number {
  return new Set(values).size
}

export function findDuplicateSourceNumbers(rows: readonly ContactImportRow[]): DuplicateGroup[] {
  const byNumber = new Map<string, ContactImportRow[]>()
  for (const row of rows) {
    if (row.studentNumber === null) continue
    const key = `${row.programCode}\u0000${row.studentNumber}`
    const list = byNumber.get(key) ?? []
    list.push(row)
    byNumber.set(key, list)
  }

  const groups: DuplicateGroup[] = []
  for (const list of byNumber.values()) {
    if (list.length < 2) continue
    const tables = new Set(list.map((row) => `${row.sourceSheet}\u0000${row.sourceTable ?? ''}`))
    const intakes = new Set(list.map((row) => row.intakeDate ?? row.intakeLabel ?? row.sourceSheet))
    const sameEmail = distinct(list.map((row) => row.emailNormalized)) === 1
    const samePhone = distinct(list.map((row) => row.phoneNormalized)) === 1
    const sameName = distinct(list.map((row) => nameComparisonKey(row.displayName))) === 1
    const identical = sameEmail && samePhone && sameName && distinct(list.map((row) => row.session)) === 1

    let explanation: DuplicateExplanation
    if (tables.size === 1) explanation = 'source_duplication_within_table'
    else if (identical && intakes.size === 1) explanation = 'identical_rows_across_tables'
    else if (sameEmail && samePhone) explanation = 'repeat_or_transfer_candidate'
    else explanation = 'unresolved_ambiguity'

    groups.push({
      programCode: list[0].programCode,
      studentNumber: list[0].studentNumber as string,
      rowIds: list.map((row) => row.stagedRowId),
      locations: list.map(locationOf),
      distinctIntakes: intakes.size,
      sameEmail,
      samePhone,
      sameName,
      explanation,
      conflictingContact: !sameEmail || !samePhone,
    })
  }
  return groups.sort((a, b) => a.studentNumber.localeCompare(b.studentNumber))
}

export function findSharedContacts(rows: readonly ContactImportRow[]): SharedContact[] {
  const out: SharedContact[] = []
  for (const kind of ['email', 'phone'] as const) {
    const byValue = new Map<string, ContactImportRow[]>()
    for (const row of rows) {
      const value = kind === 'email' ? row.emailNormalized : row.phoneNormalized
      if (value === null || row.studentNumber === null) continue
      const list = byValue.get(value) ?? []
      list.push(row)
      byValue.set(value, list)
    }
    for (const [value, list] of byValue) {
      const numbers = [...new Set(list.map((row) => `${row.programCode}:${row.studentNumber}`))]
      if (numbers.length < 2) continue
      out.push({ kind, value, studentNumbers: numbers.sort(), rowIds: list.map((row) => row.stagedRowId) })
    }
  }
  return out
}

/**
 * Conflicts between rows that state the same student number but different
 * values. `primaryRows` outrank `secondaryRows` structurally (a master sheet
 * over its subsets); within one list nothing outranks anything.
 */
export function findSourceConflicts(
  primaryRows: readonly ContactImportRow[],
  secondaryRows: readonly ContactImportRow[] = [],
): SourceConflict[] {
  const all = [
    ...primaryRows.map((row) => ({ row, rank: 'primary' as const })),
    ...secondaryRows.map((row) => ({ row, rank: 'secondary' as const })),
  ]
  const byNumber = new Map<string, typeof all>()
  for (const entry of all) {
    if (entry.row.studentNumber === null) continue
    const key = `${entry.row.programCode}\u0000${entry.row.studentNumber}`
    const list = byNumber.get(key) ?? []
    list.push(entry)
    byNumber.set(key, list)
  }

  const conflicts: SourceConflict[] = []
  const fields: { field: SourceConflict['field']; value: (row: ContactImportRow) => string | null }[] = [
    { field: 'email', value: (row) => row.emailNormalized ?? row.emailRaw?.trim() ?? null },
    { field: 'phone', value: (row) => row.phoneNormalized ?? row.phoneRaw?.trim() ?? null },
    { field: 'name', value: (row) => nameComparisonKey(row.displayName) },
  ]

  for (const list of byNumber.values()) {
    if (list.length < 2) continue
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]
        const b = list[j]
        for (const { field, value } of fields) {
          const valueA = value(a.row)
          const valueB = value(b.row)
          if (valueA === null || valueB === null || valueA === valueB) continue
          const structurallyPrimary =
            a.rank === b.rank ? 'none' : a.rank === 'primary' ? 'A' : 'B'
          conflicts.push({
            programCode: a.row.programCode,
            studentNumber: a.row.studentNumber as string,
            field,
            sourceA: { rowId: a.row.stagedRowId, location: locationOf(a.row), value: field === 'name' ? a.row.displayName : valueA },
            sourceB: { rowId: b.row.stagedRowId, location: locationOf(b.row), value: field === 'name' ? b.row.displayName : valueB },
            structurallyPrimary,
            note:
              structurallyPrimary === 'none'
                ? 'both rows sit in tables of equal standing; no precedence is provable from the workbook'
                : 'the master sheet is structurally primary; the subset sheet is a copy',
          })
        }
      }
    }
  }
  return conflicts
}

// -----------------------------------------------------------------------------
// Master / subset cross-check
// -----------------------------------------------------------------------------

export interface SubsetCrossCheck {
  programCode: string
  masterNumbers: number
  subsetRows: number
  distinctSubsetNumbers: number
  /** Numbers on the master and in no subset. */
  masterOnly: string[]
  /** Numbers in a subset and not on the master. */
  subsetOnly: string[]
  /** Numbers listed in more than one subset table. */
  inSeveralSubsets: string[]
  /** Numbers whose master session disagrees with the subset sheet that lists them. */
  sessionMismatch: { studentNumber: string; masterSession: string | null; subsetSessions: string[] }[]
  /** Contact/name disagreements between master and subset rows for one number. */
  conflicts: SourceConflict[]
}

export function crossCheckSubsets(
  masterRows: readonly ContactImportRow[],
  subsetRows: readonly ContactImportRow[],
  programCode: string,
): SubsetCrossCheck {
  const master = new Map<string, ContactImportRow>()
  for (const row of masterRows) if (row.studentNumber !== null && !master.has(row.studentNumber)) master.set(row.studentNumber, row)
  const subsets = new Map<string, ContactImportRow[]>()
  for (const row of subsetRows) {
    if (row.studentNumber === null) continue
    const list = subsets.get(row.studentNumber) ?? []
    list.push(row)
    subsets.set(row.studentNumber, list)
  }

  const sessionMismatch: SubsetCrossCheck['sessionMismatch'] = []
  for (const [number, rows] of subsets) {
    const masterRow = master.get(number)
    if (!masterRow) continue
    const masterSession = masterRow.session
    // A subset table's title states "Weekday …" or "Weekend …"; compare the
    // cohort word only, since the master's column states no time of day.
    const subsetCohorts = rows.map((row) => (row.sourceTable ?? '').match(/weekday|weekend/i)?.[0] ?? row.session ?? '')
    const disagree = subsetCohorts.some(
      (cohort) => masterSession !== null && cohort !== '' && cohort.toLowerCase() !== String(masterSession).toLowerCase(),
    )
    if (disagree) sessionMismatch.push({ studentNumber: number, masterSession, subsetSessions: subsetCohorts })
  }

  return {
    programCode,
    masterNumbers: master.size,
    subsetRows: subsetRows.length,
    distinctSubsetNumbers: subsets.size,
    masterOnly: [...master.keys()].filter((number) => !subsets.has(number)).sort(),
    subsetOnly: [...subsets.keys()].filter((number) => !master.has(number)).sort(),
    inSeveralSubsets: [...subsets.entries()].filter(([, rows]) => rows.length > 1).map(([number]) => number).sort(),
    sessionMismatch,
    conflicts: findSourceConflicts(masterRows, subsetRows).filter(
      (conflict) => conflict.structurallyPrimary !== 'none',
    ),
  }
}

// -----------------------------------------------------------------------------
// Row classification
// -----------------------------------------------------------------------------

export interface ClassifyOptions {
  hosted: HostedSnapshot
  /** Duplicate groups, so a row in a conflicting group is held for review. */
  duplicates: readonly DuplicateGroup[]
  shared: readonly SharedContact[]
  /** Row ids whose scope date was unknown. */
  dateUnknownRowIds: ReadonlySet<string>
}

export function classifyRows(rows: readonly ContactImportRow[], options: ClassifyOptions): RowAssessment[] {
  const index = indexHosted(options.hosted)
  const conflictingDuplicateRowIds = new Set(
    options.duplicates.filter((group) => group.conflictingContact).flatMap((group) => group.rowIds),
  )
  const duplicateRowIds = new Set(options.duplicates.flatMap((group) => group.rowIds))
  const sharedEmailRowIds = new Set(options.shared.filter((item) => item.kind === 'email').flatMap((item) => item.rowIds))
  const sharedPhoneRowIds = new Set(options.shared.filter((item) => item.kind === 'phone').flatMap((item) => item.rowIds))

  return rows.map((row) => {
    const flags: Flag[] = []
    const matches = row.studentNumber === null ? [] : (index.studentsByNumber.get(row.studentNumber) ?? [])
    const student = matches.length === 1 ? matches[0] : null

    if (row.studentNumber === null) flags.push('MISSING_STUDENT_NUMBER')
    else if (!/^\d+$/.test(row.studentNumber)) flags.push('STUDENT_NUMBER_NOT_DIGITS')
    if (matches.length > 1) flags.push('DUPLICATE_HOSTED_STUDENT_NUMBER')
    if (row.studentNumber !== null && matches.length === 0) flags.push('STUDENT_NOT_IN_APP')
    if (duplicateRowIds.has(row.stagedRowId)) flags.push('DUPLICATE_SOURCE_STUDENT_NUMBER')
    if (conflictingDuplicateRowIds.has(row.stagedRowId)) flags.push('DUPLICATE_SOURCE_CONFLICTING_CONTACT')
    if (sharedEmailRowIds.has(row.stagedRowId)) flags.push('SHARED_SOURCE_EMAIL')
    if (sharedPhoneRowIds.has(row.stagedRowId)) flags.push('SHARED_SOURCE_PHONE')
    if (options.dateUnknownRowIds.has(row.stagedRowId)) flags.push('SCOPE_DATE_UNKNOWN')

    if (row.emailStatus === 'missing') flags.push('SOURCE_MISSING_EMAIL')
    if (row.emailStatus === 'invalid') flags.push('SOURCE_INVALID_EMAIL')
    if (row.phoneStatus === 'missing') flags.push('SOURCE_MISSING_PHONE')
    if (row.phoneStatus === 'invalid') flags.push('SOURCE_INVALID_PHONE')
    if (row.phoneStatus === 'ambiguous') flags.push('SOURCE_AMBIGUOUS_PHONE')

    let emailComparison: FieldComparison = 'not_applicable'
    let phoneComparison: FieldComparison = 'not_applicable'
    let nameDiffers: boolean | null = null
    let hostedNameValue: string | null = null

    if (student !== null) {
      emailComparison = compareEmail(row, student.email)
      phoneComparison = comparePhone(row, student.phone)
      hostedNameValue = hostedName(student)
      const sourceKey = nameComparisonKey(row.displayName)
      const hostedKey = nameComparisonKey(hostedNameValue)
      nameDiffers = sourceKey !== null && hostedKey !== null ? sourceKey !== hostedKey : null
      if (nameDiffers === true) flags.push('NAME_DIFFERENCE')
      if (emailComparison === 'difference') flags.push('EMAIL_DIFFERENCE')
      if (phoneComparison === 'difference') flags.push('PHONE_DIFFERENCE')
      if (emailComparison === 'fill') flags.push('SAFE_EMAIL_FILL')
      if (phoneComparison === 'fill') flags.push('SAFE_PHONE_FILL')
      if (emailComparison === 'difference' || phoneComparison === 'difference') flags.push('CONTACT_DIFFERENCE')
      else if (emailComparison === 'fill' || phoneComparison === 'fill') flags.push('SAFE_CONTACT_FILL')
      else if (emailComparison === 'unchanged' && phoneComparison === 'unchanged') flags.push('EXACT_UNCHANGED')
    }

    if (row.exclusionReason !== null) flags.push(row.exclusionReason)

    const primary = decidePrimary(row, matches.length, conflictingDuplicateRowIds.has(row.stagedRowId), emailComparison, phoneComparison)

    return {
      row,
      primary,
      flags,
      hostedStudentId: student?.id ?? null,
      hostedMatchCount: matches.length,
      hostedEmail: student?.email ?? null,
      hostedPhone: student?.phone ?? null,
      hostedName: hostedNameValue,
      emailComparison,
      phoneComparison,
      nameDiffers,
      intake: crossCheckIntake(row, student, options.hosted, index),
    }
  })
}

/**
 * One primary category per row, in the order an apply would have to respect:
 * scope first, then identity problems, then what the contact comparison says.
 */
export function decidePrimary(
  row: ContactImportRow,
  hostedMatchCount: number,
  conflictingDuplicate: boolean,
  emailComparison: FieldComparison,
  phoneComparison: FieldComparison,
): PrimaryCategory {
  if (row.exclusionReason !== null) return row.exclusionReason
  if (row.studentNumber === null) return 'MISSING_STUDENT_NUMBER'
  if (hostedMatchCount > 1) return 'DUPLICATE_HOSTED_STUDENT_NUMBER'
  if (hostedMatchCount === 0) return 'STUDENT_NOT_IN_APP'
  if (conflictingDuplicate) return 'DUPLICATE_SOURCE_STUDENT_NUMBER'
  const comparisons = [emailComparison, phoneComparison]
  if (comparisons.includes('difference')) return 'CONTACT_DIFFERENCE'
  if (comparisons.includes('fill')) return 'SAFE_CONTACT_FILL'
  if (comparisons.includes('source_invalid')) return 'SOURCE_INVALID_CONTACT'
  if (comparisons.includes('source_missing')) return 'SOURCE_MISSING_CONTACT'
  return 'EXACT_UNCHANGED'
}

// -----------------------------------------------------------------------------
// Hosted-side checks
// -----------------------------------------------------------------------------

export interface HostedDuplicateNumber {
  studentNumber: string
  studentIds: string[]
}

export function findHostedDuplicateNumbers(students: readonly HostedStudentLike[]): HostedDuplicateNumber[] {
  const byNumber = new Map<string, string[]>()
  for (const student of students) {
    const number = normalizeStudentNumber(student.student_number)
    if (number === null) continue
    const list = byNumber.get(number) ?? []
    list.push(student.id)
    byNumber.set(number, list)
  }
  return [...byNumber.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([studentNumber, studentIds]) => ({ studentNumber, studentIds }))
    .sort((a, b) => a.studentNumber.localeCompare(b.studentNumber))
}

export interface HostedAbsentFromMasters {
  programCode: string
  studentId: string
  studentNumber: string | null
  hostedIntakeLabel: string
  batchName: string
}

/**
 * Hosted students whose finance record sits in a batch inside the operational
 * window and whose number no operational source row states. The masters may
 * simply not list them; this is the list to review, not a defect.
 */
export function hostedStudentsAbsentFromMasters(
  hosted: HostedSnapshot,
  operationalRows: readonly ContactImportRow[],
  window: { from: string; to: string | null },
): HostedAbsentFromMasters[] {
  const index = indexHosted(hosted)
  const sourceNumbers = new Set(
    operationalRows.filter((row) => row.studentNumber !== null).map((row) => `${row.programCode}\u0000${row.studentNumber}`),
  )
  const studentById = new Map(hosted.students.map((student) => [student.id, student]))
  const programById = new Map(hosted.programs.map((program) => [program.id, program]))

  const out: HostedAbsentFromMasters[] = []
  const seen = new Set<string>()
  for (const record of hosted.records) {
    if (record.batch_id === null) continue
    const intake = index.intakeByBatchId.get(record.batch_id)
    const batch = index.batchById.get(record.batch_id)
    if (!intake || !batch) continue
    const date = intake.startDate ?? (intake.yearMonth === null ? null : `${intake.yearMonth}-01`)
    if (date === null) continue
    if (date < window.from) continue
    if (window.to !== null && date > window.to) continue
    const program = programById.get(record.program_id)
    const student = studentById.get(record.student_id)
    if (!program || !student) continue
    const number = normalizeStudentNumber(student.student_number)
    const key = `${program.short_code}\u0000${number ?? `id:${student.id}`}`
    if (number !== null && sourceNumbers.has(key)) continue
    if (seen.has(`${record.student_id}\u0000${record.batch_id}`)) continue
    seen.add(`${record.student_id}\u0000${record.batch_id}`)
    out.push({
      programCode: program.short_code,
      studentId: student.id,
      studentNumber: number,
      hostedIntakeLabel: intake.label,
      batchName: batch.name,
    })
  }
  return out
}

// -----------------------------------------------------------------------------
// Unassigned cross-check
// -----------------------------------------------------------------------------

export interface UnassignedRecordLike {
  financeRecordId: string
  programCode: string
  studentId: string
  studentNumber: string | null
  /** Every spelling the app holds for the student, for the informational name check only. */
  studentNames: string[]
}

export type UnassignedBatchEvidence =
  /** One source intake, mapped to one hosted intake, session stated and matched to one batch. */
  | 'single_batch'
  /** Mapped to one hosted intake, but the session is unstated or the intake has one batch only. */
  | 'intake_only'
  /** Listed in more than one source intake. */
  | 'several_intakes'
  /** Listed, but the source intake maps to no hosted intake. */
  | 'intake_not_mapped'
  | 'not_in_source'

export interface UnassignedCrossCheck {
  financeRecordId: string
  programCode: string
  studentNumber: string | null
  identityMode: 'exact_student_number' | 'no_student_number'
  sourceRowIds: string[]
  sourceLocations: string[]
  providesEmail: boolean
  providesPhone: boolean
  sourceIntakes: string[]
  sourceSessions: string[]
  mappedHostedIntakeLabels: string[]
  candidateBatchNames: string[]
  batchEvidence: UnassignedBatchEvidence
  /** For a number-less record: source rows whose name text is exactly the same. Informational only. */
  sameNameTextRows: number
}

export function crossCheckUnassigned(
  records: readonly UnassignedRecordLike[],
  rows: readonly ContactImportRow[],
  hosted: HostedSnapshot,
): UnassignedCrossCheck[] {
  const rowsByNumber = new Map<string, ContactImportRow[]>()
  for (const row of rows) {
    if (row.studentNumber === null) continue
    const key = `${row.programCode}\u0000${row.studentNumber}`
    const list = rowsByNumber.get(key) ?? []
    list.push(row)
    rowsByNumber.set(key, list)
  }
  const nameKeys = rows.map((row) => nameComparisonKey(row.displayName)).filter((key): key is string => key !== null)

  return records.map((record) => {
    if (record.studentNumber === null) {
      const keys = new Set(record.studentNames.map((name) => nameComparisonKey(name)).filter((key): key is string => key !== null))
      const sameNameTextRows = nameKeys.filter((key) => keys.has(key)).length
      return {
        financeRecordId: record.financeRecordId,
        programCode: record.programCode,
        studentNumber: null,
        identityMode: 'no_student_number',
        sourceRowIds: [],
        sourceLocations: [],
        providesEmail: false,
        providesPhone: false,
        sourceIntakes: [],
        sourceSessions: [],
        mappedHostedIntakeLabels: [],
        candidateBatchNames: [],
        batchEvidence: 'not_in_source',
        sameNameTextRows,
      }
    }

    const matched = rowsByNumber.get(`${record.programCode}\u0000${record.studentNumber}`) ?? []
    const intakes = [...new Set(matched.map((row) => row.intakeDate ?? row.intakeLabel ?? row.sourceSheet))]
    const sessions = [...new Set(matched.map((row) => row.session ?? 'not stated'))]
    const mappings = intakes
      .map((intake) => mapSourceIntake(record.programCode, /^\d{4}-\d{2}-\d{2}$/.test(intake) ? intake : null, hosted.intakes))
      .filter((mapping): mapping is IntakeMapping => mapping !== null)

    const candidateBatches = mappings.flatMap((mapping) =>
      mapping.intake.batches.filter((batch) => {
        const wanted = matched
          .filter((row) => (row.intakeDate ?? row.intakeLabel ?? row.sourceSheet) === (mapping.intake.startDate ?? '') || mapping.mappedBy !== 'start_date')
          .map((row) => row.session)
        if (wanted.every((session) => session === null)) return true
        return wanted.includes(batch.session)
      }),
    )

    let evidence: UnassignedBatchEvidence
    if (matched.length === 0) evidence = 'not_in_source'
    else if (intakes.length > 1) evidence = 'several_intakes'
    else if (mappings.length === 0) evidence = 'intake_not_mapped'
    else if (candidateBatches.length === 1) evidence = 'single_batch'
    else evidence = 'intake_only'

    return {
      financeRecordId: record.financeRecordId,
      programCode: record.programCode,
      studentNumber: record.studentNumber,
      identityMode: 'exact_student_number',
      sourceRowIds: matched.map((row) => row.stagedRowId),
      sourceLocations: matched.map(locationOf),
      providesEmail: matched.some((row) => row.emailStatus === 'valid'),
      providesPhone: matched.some((row) => row.phoneStatus === 'valid_nanp' || row.phoneStatus === 'international_explicit'),
      sourceIntakes: intakes,
      sourceSessions: sessions,
      mappedHostedIntakeLabels: [...new Set(mappings.map((mapping) => mapping.intake.label))],
      candidateBatchNames: [...new Set(candidateBatches.map((batch) => batch.name))],
      batchEvidence: evidence,
      sameNameTextRows: 0,
    }
  })
}

// -----------------------------------------------------------------------------
// Source conservation
// -----------------------------------------------------------------------------

export interface SheetConservation {
  sheetName: string
  rangeRows: number
  title: number
  header: number
  student: number
  placeholder: number
  legend: number
  blank: number
  other: number
  conserved: boolean
}

export interface SourceConservation {
  programCode: string
  workbookName: string
  sheets: SheetConservation[]
  discoveredStudentRows: number
  stagedRows: number
  crossCheckRows: number
  operational: number
  historical: number
  future: number
  /** Rows the scanner saw as student rows but neither staged nor kept for cross-check. */
  unaccounted: number
  conserved: boolean
}

export function conserveSource(input: {
  programCode: string
  workbookName: string
  sheets: readonly SheetScan[]
  rows: readonly ContactImportRow[]
  crossCheckRows: readonly ContactImportRow[]
}): SourceConservation {
  const sheets: SheetConservation[] = input.sheets.map((scan) => {
    const total = Object.values(scan.counts).reduce((sum, count) => sum + count, 0)
    return {
      sheetName: scan.sheetName,
      rangeRows: scan.rangeRows,
      ...scan.counts,
      conserved: total === scan.rangeRows,
    }
  })
  const discovered = sheets.reduce((sum, sheet) => sum + sheet.student, 0)
  const operational = input.rows.filter((row) => row.exclusionReason === null).length
  const historical = input.rows.filter((row) => row.exclusionReason === 'OUT_OF_SCOPE_HISTORICAL').length
  const future = input.rows.filter((row) => row.exclusionReason === 'OUT_OF_SCOPE_FUTURE').length
  const unaccounted = discovered - input.rows.length - input.crossCheckRows.length
  return {
    programCode: input.programCode,
    workbookName: input.workbookName,
    sheets,
    discoveredStudentRows: discovered,
    stagedRows: input.rows.length,
    crossCheckRows: input.crossCheckRows.length,
    operational,
    historical,
    future,
    unaccounted,
    conserved:
      sheets.every((sheet) => sheet.conserved) &&
      unaccounted === 0 &&
      operational + historical + future === input.rows.length,
  }
}

// -----------------------------------------------------------------------------
// Tallies
// -----------------------------------------------------------------------------

export function tally<T extends string>(values: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}
