/**
 * The staging pipeline and hosted reads the contact CLIs share.
 *
 * `contact-audit.mts` (04B1, read-only) and `contact-apply.mts` (04B2) must
 * see exactly the same staged rows, the same scope, the same duplicate and
 * shared-contact evidence and the same hosted snapshot — otherwise the plan
 * one produces could differ from the audit the other reports. Both therefore
 * call the functions below and never re-implement a step.
 *
 * Nothing here writes: every hosted access is a paged `select` or a `count`
 * under the caller's own RLS-enforced session.
 */

import { groupBatchesIntoIntakes, sessionOfBatchName, type IntakeBatch } from '../../src/lib/finance/grid/intake.ts'

import { countRows, selectAll, type HostedBatch, type HostedProgram } from '../finance-qa/hosted-reads.mts'
import type { HostedSession } from '../finance-qa/hosted-session.mts'

import type { AdapterParseResult, MasterContactSourceAdapter } from './adapters/adapter.mts'
import { ADAPTERS } from './adapters/registry.mts'
import { parseTitleDate } from './adapters/title-date.mts'
import type { ContactImportRow } from './canonical.mts'
import {
  conserveSource,
  crossCheckSubsets,
  findDuplicateSourceNumbers,
  findSharedContacts,
  findSourceConflicts,
  type DuplicateGroup,
  type HostedIntakeLike,
  type HostedSnapshot,
  type HostedStudentLike,
  type SharedContact,
  type SourceConflict,
  type SourceConservation,
  type SubsetCrossCheck,
} from './reconcile.mts'
import { applyScope, type ScopeConfig, type ScopeCounts } from './scope.mts'
import { discoverContactWorkbooks, type ContactWorkbookFingerprint, type DiscoveredWorkbook } from './sources.mts'

const ADAPTER_BY_ID = new Map<string, MasterContactSourceAdapter>(ADAPTERS.map((adapter) => [adapter.id, adapter]))

/** The tables whose counts must be identical before and after a read-only run. */
export const INTEGRITY_TABLES = [
  'programs',
  'batches',
  'students',
  'student_finance_records',
  'installments',
  'payments',
  'receipts',
  'receipt_deliveries',
  'reminder_deliveries',
  'import_batches',
  'import_exceptions',
  'audit_log',
  'batch_finance_columns',
] as const

export type IntegrityTable = (typeof INTEGRITY_TABLES)[number]

// -----------------------------------------------------------------------------
// Staging: discover, parse, scope, duplicates, shared contacts
// -----------------------------------------------------------------------------

export interface WorkbookReport {
  fingerprint: ContactWorkbookFingerprint
  adapterId: string | null
  recognition: { adapterId: string; recognized: boolean; reason: string }[]
  parse: AdapterParseResult | null
  scope: ScopeCounts | null
  conservation: SourceConservation | null
  duplicates: DuplicateGroup[]
  conflicts: SourceConflict[]
  subsetCrossCheck: SubsetCrossCheck | null
}

export interface StagingStop {
  /** Exit code the CLIs use for this stop. */
  code: 2
  message: string
}

export interface Staging {
  discovered: DiscoveredWorkbook[]
  reports: WorkbookReport[]
  /** Every staged (primary) row of every recognized master, all scopes. */
  allRows: ContactImportRow[]
  dateUnknownRowIds: Set<string>
  duplicates: DuplicateGroup[]
  shared: SharedContact[]
}

/**
 * Discovers the workbooks under `reference/`, parses each recognized master
 * through its adapter, applies the scope and computes the workbook-level
 * evidence. Returns a stop instead of a staging when the sources are not
 * usable (no master, two masters for one program, two adapters claiming one
 * workbook).
 */
export function stageWorkbooks(repoRoot: string, config: ScopeConfig, log: (line: string) => void = () => {}): Staging | StagingStop {
  const discovered = discoverContactWorkbooks(repoRoot)
  log(`reference/: ${discovered.length} workbook(s)`)
  for (const item of discovered) {
    log(
      `  ${item.fingerprint.fileName} · ${item.fingerprint.sizeBytes} bytes · sha256 ${item.fingerprint.sha256} · ` +
        `${item.fingerprint.sheetNames.length} sheets · adapter: ${item.identification.adapter?.id ?? 'none'}`,
    )
    if (item.identification.conflict) {
      return { code: 2, message: `STOP: ${item.identification.conflict.join(' and ')} both claim ${item.fingerprint.fileName}` }
    }
  }
  const masters = discovered.filter((item) => item.identification.adapter !== null)
  if (masters.length === 0) {
    return { code: 2, message: 'STOP: no contact master workbook was recognized under reference/' }
  }
  const claimedPrograms = masters.map((item) => (item.identification.adapter as MasterContactSourceAdapter).programCode)
  if (new Set(claimedPrograms).size !== claimedPrograms.length) {
    return { code: 2, message: 'STOP: two workbooks were recognized for the same program; refusing to guess which is current' }
  }

  const reports: WorkbookReport[] = []
  for (const item of discovered) {
    const adapter = item.identification.adapter
    const recognition = item.identification.verdicts.map((verdict) => ({
      adapterId: verdict.adapterId,
      recognized: verdict.recognition.recognized,
      reason: verdict.recognition.reason,
    }))
    if (adapter === null) {
      reports.push({ fingerprint: item.fingerprint, adapterId: null, recognition, parse: null, scope: null, conservation: null, duplicates: [], conflicts: [], subsetCrossCheck: null })
      continue
    }
    const parse = adapter.parse(item.workbook, item.fingerprint.fileName)
    const scope = applyScope(parse.rows, adapter.scopeDateField, config)
    applyScope(parse.crossCheckRows, adapter.scopeDateField, config)
    const conservation = conserveSource({
      programCode: adapter.programCode,
      workbookName: item.fingerprint.fileName,
      sheets: parse.sheets,
      rows: parse.rows,
      crossCheckRows: parse.crossCheckRows,
    })
    const duplicates = findDuplicateSourceNumbers(parse.rows)
    const subsetCrossCheck =
      parse.crossCheckRows.length > 0 ? crossCheckSubsets(parse.rows, parse.crossCheckRows, adapter.programCode) : null
    const conflicts = [...findSourceConflicts(parse.rows), ...(subsetCrossCheck?.conflicts ?? [])]
    reports.push({ fingerprint: item.fingerprint, adapterId: adapter.id, recognition, parse, scope: scope.counts, conservation, duplicates, conflicts, subsetCrossCheck })
    log(
      `parsed ${adapter.programCode}: ${parse.rows.length} staged rows, ${parse.crossCheckRows.length} cross-check rows; ` +
        `scope ${JSON.stringify(scope.counts)}; conservation ${conservation.conserved ? 'ok' : 'BROKEN'}`,
    )
  }

  const allRows: ContactImportRow[] = reports.flatMap((report) => report.parse?.rows ?? [])
  const dateUnknownRowIds = new Set<string>()
  for (const report of reports) {
    if (!report.parse) continue
    const adapter = ADAPTER_BY_ID.get(report.adapterId as string) as MasterContactSourceAdapter
    for (const row of report.parse.rows) {
      const field = adapter.scopeDateField
      const fallback = field === 'intakeDate' ? 'sourceStartDate' : 'intakeDate'
      if (row[field] === null && row[fallback] === null) dateUnknownRowIds.add(row.stagedRowId)
    }
  }

  return {
    discovered,
    reports,
    allRows,
    dateUnknownRowIds,
    duplicates: reports.flatMap((report) => report.duplicates),
    shared: findSharedContacts(allRows),
  }
}

export function isStagingStop(value: Staging | StagingStop): value is StagingStop {
  return 'code' in value
}

// -----------------------------------------------------------------------------
// Hosted reads — authenticated, RLS, read-only
// -----------------------------------------------------------------------------

export interface HostedStudentRow extends HostedStudentLike {
  active: boolean
}

export interface HostedRecordRow {
  id: string
  student_id: string
  program_id: string
  batch_id: string | null
}

export interface HostedReads {
  programs: HostedProgram[]
  batches: HostedBatch[]
  students: HostedStudentRow[]
  records: HostedRecordRow[]
}

export async function readHosted(session: HostedSession): Promise<HostedReads> {
  const { client } = session
  const programs = await selectAll<HostedProgram>(client, 'programs', 'id, name, short_code', 'short_code')
  const batches = await selectAll<HostedBatch>(
    client,
    'batches',
    'id, program_id, name, code, legacy_sheet_name, start_date, active',
    'code',
  )
  const students = await selectAll<HostedStudentRow>(
    client,
    'students',
    'id, student_number, first_name, middle_name, last_name, display_name, legacy_name, email, phone, active',
    'id',
  )
  const records = await selectAll<HostedRecordRow>(
    client,
    'student_finance_records',
    'id, student_id, program_id, batch_id',
    'id',
  )
  return { programs, batches, students, records }
}

/** `count(*)` of every integrity table, in the fixed order of `INTEGRITY_TABLES`. */
export async function integrityCounts(session: HostedSession): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of INTEGRITY_TABLES) out[table] = await countRows(session.client, table)
  return out
}

export interface ContactCounts {
  studentsWithEmail: number
  studentsWithPhone: number
}

/** How many hosted students carry a non-NULL email / phone, under RLS, without reading a value. */
export async function contactCounts(session: HostedSession): Promise<ContactCounts> {
  const count = async (column: 'email' | 'phone'): Promise<number> => {
    const { count: value, error } = await session.client
      .from('students')
      .select('id', { count: 'exact', head: true })
      .not(column, 'is', null)
    if (error) throw new Error(`count students.${column}: ${error.message}`)
    return value ?? 0
  }
  return { studentsWithEmail: await count('email'), studentsWithPhone: await count('phone') }
}

/** Hosted batches grouped exactly as the grid groups them, reduced to what the engine needs. */
export function hostedIntakes(reads: HostedReads): HostedIntakeLike[] {
  const programById = new Map(reads.programs.map((program) => [program.id, program]))
  const studentCounts = new Map<string, number>()
  for (const record of reads.records) {
    if (record.batch_id === null) continue
    studentCounts.set(record.batch_id, (studentCounts.get(record.batch_id) ?? 0) + 1)
  }
  const intakeBatches: IntakeBatch[] = reads.batches.map((batch) => ({
    id: batch.id,
    programId: batch.program_id,
    programShortCode: programById.get(batch.program_id)?.short_code ?? 'unknown',
    name: batch.name,
    startDate: batch.start_date,
    legacySheetName: batch.legacy_sheet_name,
    session: sessionOfBatchName(batch.name),
    studentCount: studentCounts.get(batch.id) ?? 0,
  }))
  return groupBatchesIntoIntakes(intakeBatches).map((intake) => {
    const yearMonth =
      intake.datePrecision === 'day' && intake.latestStartDate !== null
        ? intake.latestStartDate.slice(0, 7)
        : intake.datePrecision === 'month'
          ? intake.key
          : null
    const titleMonth = parseTitleDate(intake.sourceTitle).yearMonth
    return {
      key: intake.key,
      programCode: intake.programShortCode,
      label: intake.displayName,
      startDate: intake.latestStartDate,
      yearMonth,
      titleYearMonth: titleMonth !== null && titleMonth !== yearMonth ? titleMonth : null,
      batches: intake.batches.map((batch) => ({ id: batch.id, name: batch.name, session: batch.session })),
    }
  })
}

/** The engine's snapshot shape from one set of hosted reads. */
export function snapshotFromReads(reads: HostedReads): HostedSnapshot {
  return {
    students: reads.students,
    programs: reads.programs,
    batches: reads.batches,
    records: reads.records,
    intakes: hostedIntakes(reads),
  }
}
