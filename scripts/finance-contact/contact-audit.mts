/**
 * FINANCE-CONTACT-04B1 — the read-only contact import audit (dry run).
 *
 *   npm run finance:contact-audit
 *   npm run finance:contact-audit -- --cutoff=2025-12-01 --end=2026-08-31
 *   npm run finance:contact-audit -- --offline        (parse and scope only)
 *
 * What it does, in order:
 *
 *   1. fingerprints every workbook under `reference/` and lets the adapter
 *      registry identify the contact masters by structure;
 *   2. parses each master into canonical rows through its adapter;
 *   3. applies the operational scope (configuration, not code);
 *   4. normalizes comparison values for student number, email, phone, name;
 *   5. reads hosted students, programs, batches and finance records under an
 *      authenticated admin session with Row Level Security enforced;
 *   6. matches on the exact student number only;
 *   7. classifies every staged row — one primary category, any flags;
 *   8. checks duplicates, shared contacts and source conflicts, and
 *      cross-checks the ECEA master against its subset sheets;
 *   9. cross-checks the 22 Unassigned finance records against the masters;
 *  10. writes row-level output (PII) only under `.private/finance-contact/`;
 *  11. prints an aggregate with counts only;
 *  12. exits non-zero when conservation or an integrity invariant fails.
 *
 * It writes nothing to Supabase: there is no insert, update, upsert, delete
 * or rpc-with-side-effect anywhere below, and the hosted row counts are
 * verified identical before and after. It never modifies `reference/`: the
 * workbooks are hashed before and after.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { groupBatchesIntoIntakes, sessionOfBatchName, type IntakeBatch } from '../../src/lib/finance/grid/intake.ts'

import { countRows, selectAll, type HostedBatch, type HostedProgram } from '../finance-qa/hosted-reads.mts'
import { openHostedSession, type HostedSession } from '../finance-qa/hosted-session.mts'

import type { AdapterParseResult, MasterContactSourceAdapter } from './adapters/adapter.mts'
import { ADAPTERS } from './adapters/registry.mts'
import { parseTitleDate } from './adapters/title-date.mts'
import type { ContactImportRow, Flag, IntakeCategory, PrimaryCategory } from './canonical.mts'
import {
  classifyRows,
  conserveSource,
  crossCheckSubsets,
  crossCheckUnassigned,
  findDuplicateSourceNumbers,
  findHostedDuplicateNumbers,
  findSharedContacts,
  findSourceConflicts,
  hostedStudentsAbsentFromMasters,
  tally,
  type DuplicateGroup,
  type HostedAbsentFromMasters,
  type HostedDuplicateNumber,
  type HostedIntakeLike,
  type HostedSnapshot,
  type HostedStudentLike,
  type RowAssessment,
  type SourceConflict,
  type SourceConservation,
  type SubsetCrossCheck,
  type UnassignedCrossCheck,
  type UnassignedRecordLike,
} from './reconcile.mts'
import { applyScope, DEFAULT_SCOPE_CONFIG, type ScopeConfig, type ScopeCounts } from './scope.mts'
import { discoverContactWorkbooks, hashReferenceFile, type ContactWorkbookFingerprint, type DiscoveredWorkbook } from './sources.mts'

const PRIVATE_DIR = path.join('.private', 'finance-contact')

const ADAPTER_BY_ID = new Map<string, MasterContactSourceAdapter>(ADAPTERS.map((adapter) => [adapter.id, adapter]))

/** The tables whose counts must be identical before and after. */
const INTEGRITY_TABLES = [
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
] as const

// -----------------------------------------------------------------------------
// Arguments
// -----------------------------------------------------------------------------

interface Args {
  offline: boolean
  config: ScopeConfig
}

function parseArgs(argv: readonly string[]): Args {
  const config: ScopeConfig = {
    ...DEFAULT_SCOPE_CONFIG,
    excludedFutureIntakes: [...DEFAULT_SCOPE_CONFIG.excludedFutureIntakes],
  }
  let offline = false
  for (const arg of argv) {
    if (arg === '--offline') offline = true
    else if (arg.startsWith('--cutoff=')) config.operationalCutoff = arg.slice('--cutoff='.length)
    else if (arg.startsWith('--end=')) {
      const value = arg.slice('--end='.length)
      config.operationalEnd = value === '' || value === 'none' ? null : value
    } else if (arg === '--include-excluded-intakes') config.excludedFutureIntakes = []
    else throw new Error(`unknown argument ${arg}`)
  }
  for (const date of [config.operationalCutoff, config.operationalEnd]) {
    if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`not an ISO date: ${date}`)
  }
  return { offline, config }
}

// -----------------------------------------------------------------------------
// Hosted reads — authenticated, RLS, read-only
// -----------------------------------------------------------------------------

interface HostedStudentRow extends HostedStudentLike {
  active: boolean
}

interface HostedRecordRow {
  id: string
  student_id: string
  program_id: string
  batch_id: string | null
}

interface HostedReads {
  programs: HostedProgram[]
  batches: HostedBatch[]
  students: HostedStudentRow[]
  records: HostedRecordRow[]
}

async function readHosted(session: HostedSession): Promise<HostedReads> {
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

async function integrityCounts(session: HostedSession): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of INTEGRITY_TABLES) out[table] = await countRows(session.client, table)
  return out
}

/** Hosted batches grouped exactly as the grid groups them, reduced to what the engine needs. */
function hostedIntakes(reads: HostedReads): HostedIntakeLike[] {
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

// -----------------------------------------------------------------------------
// Aggregate (no PII) and private outputs
// -----------------------------------------------------------------------------

interface WorkbookReport {
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

interface Aggregate {
  ticket: 'FINANCE-CONTACT-04B1'
  runAt: string
  mode: 'hosted' | 'offline'
  scope: ScopeConfig
  workbooks: {
    fileName: string
    sizeBytes: number
    sha256: string
    sha256After: string
    unchanged: boolean
    sheetNames: string[]
    adapterId: string | null
    recognition: { adapterId: string; recognized: boolean; reason: string }[]
    ignoredHeadings: string[]
    sensitiveHeadings: string[]
    notes: string[]
    intakes: { sheet: string; title: string | null; intakeDate: string | null; session: string | null; studentRows: number; role: string }[]
    conservation: Omit<SourceConservation, 'sheets'> & { sheets: SourceConservation['sheets'] }
    scope: ScopeCounts
    duplicateGroups: number
    duplicateExplanations: Record<string, number>
    conflicts: number
    conflictFields: Record<string, number>
    subsetCrossCheck: null | {
      masterNumbers: number
      subsetRows: number
      distinctSubsetNumbers: number
      masterOnly: number
      subsetOnly: number
      inSeveralSubsets: number
      sessionMismatch: number
      conflicts: number
    }
  }[]
  staged: {
    total: number
    operational: number
    primaryByProgram: Record<string, Record<string, number>>
    primary: Record<string, number>
    operationalPrimary: Record<string, number>
    flags: Record<string, number>
    operationalFlags: Record<string, number>
    intakeCategories: Record<string, number>
    operationalIntakeCategories: Record<string, number>
    sessionMismatches: number
    exactHostedMatches: number
    operationalExactHostedMatches: number
    operationalStudentsNotInApp: number
    distinctNewStudentsToCreate: Record<string, number>
    sharedEmails: number
    sharedPhones: number
    hostedDuplicateNumbers: number
    hostedAbsentFromMasters: Record<string, number>
  } | null
  unassigned: {
    records: number
    numbered: number
    numberless: number
    numberedFoundInSource: number
    numberedProvidingEmail: number
    numberedProvidingPhone: number
    batchEvidence: Record<string, number>
    numberlessSameNameTextRows: number
  } | null
  hosted: {
    projectRef: string
    appRole: string | null
    countsBefore: Record<string, number>
    countsAfter: Record<string, number>
    countsUnchanged: boolean
  } | null
  conservationOk: boolean
  workbooksUnchanged: boolean
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = Array.isArray(value) ? value.join(' | ') : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv<T>(rows: readonly T[], columns: readonly [string, (row: T) => unknown][]): string {
  const lines = [columns.map(([name]) => csvCell(name)).join(',')]
  for (const row of rows) lines.push(columns.map(([, pick]) => csvCell(pick(row))).join(','))
  return lines.join('\n')
}

const ROW_COLUMNS: [string, (row: ContactImportRow) => unknown][] = [
  ['staged_row_id', (r) => r.stagedRowId],
  ['program', (r) => r.programCode],
  ['workbook', (r) => r.sourceWorkbook],
  ['sheet', (r) => r.sourceSheet],
  ['table', (r) => r.sourceTable],
  ['row', (r) => r.sourceRow],
  ['student_number', (r) => r.studentNumber],
  ['first_name', (r) => r.firstName],
  ['middle_name', (r) => r.middleName],
  ['last_name', (r) => r.lastName],
  ['display_name', (r) => r.displayName],
  ['email_raw', (r) => r.emailRaw],
  ['email_normalized', (r) => r.emailNormalized],
  ['email_status', (r) => r.emailStatus],
  ['phone_raw', (r) => r.phoneRaw],
  ['phone_normalized', (r) => r.phoneNormalized],
  ['phone_status', (r) => r.phoneStatus],
  ['intake_label', (r) => r.intakeLabel],
  ['intake_date', (r) => r.intakeDate],
  ['session', (r) => r.session],
  ['source_start_date', (r) => r.sourceStartDate],
  ['source_status', (r) => r.sourceStatus],
  ['in_operational_scope', (r) => r.inOperationalScope],
  ['exclusion_reason', (r) => r.exclusionReason],
]

const ASSESSMENT_COLUMNS: [string, (a: RowAssessment) => unknown][] = [
  ['staged_row_id', (a) => a.row.stagedRowId],
  ['program', (a) => a.row.programCode],
  ['sheet', (a) => a.row.sourceSheet],
  ['table', (a) => a.row.sourceTable],
  ['row', (a) => a.row.sourceRow],
  ['student_number', (a) => a.row.studentNumber],
  ['source_name', (a) => a.row.displayName],
  ['hosted_name', (a) => a.hostedName],
  ['name_differs', (a) => a.nameDiffers],
  ['source_email', (a) => a.row.emailNormalized ?? a.row.emailRaw],
  ['hosted_email', (a) => a.hostedEmail],
  ['email_comparison', (a) => a.emailComparison],
  ['source_phone', (a) => a.row.phoneNormalized ?? a.row.phoneRaw],
  ['hosted_phone', (a) => a.hostedPhone],
  ['phone_comparison', (a) => a.phoneComparison],
  ['hosted_student_id', (a) => a.hostedStudentId],
  ['hosted_match_count', (a) => a.hostedMatchCount],
  ['in_operational_scope', (a) => a.row.inOperationalScope],
  ['primary', (a) => a.primary],
  ['flags', (a) => a.flags],
  ['source_intake', (a) => a.intake.sourceIntakeDate ?? a.intake.sourceIntakeLabel],
  ['source_session', (a) => a.intake.sourceSession],
  ['mapped_hosted_intake', (a) => a.intake.mappedHostedIntakeLabel],
  ['mapped_by', (a) => a.intake.mappedBy],
  ['hosted_batches', (a) => a.intake.hostedBatchNames],
  ['intake_category', (a) => a.intake.category],
  ['session_matches', (a) => a.intake.sessionMatches],
]

const CONFLICT_COLUMNS: [string, (c: SourceConflict) => unknown][] = [
  ['program', (c) => c.programCode],
  ['student_number', (c) => c.studentNumber],
  ['field', (c) => c.field],
  ['source_a', (c) => c.sourceA.location],
  ['value_a', (c) => c.sourceA.value],
  ['source_b', (c) => c.sourceB.location],
  ['value_b', (c) => c.sourceB.value],
  ['structurally_primary', (c) => c.structurallyPrimary],
  ['note', (c) => c.note],
]

function pct(part: number, whole: number): string {
  return whole === 0 ? '–' : `${((part / whole) * 100).toFixed(1)}%`
}

function table(rows: readonly (readonly [string, string | number])[]): string {
  return ['| | |', '| --- | ---: |', ...rows.map(([label, value]) => `| ${label} | ${value} |`)].join('\n')
}

function tallyTable(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
  return entries.length === 0 ? '_none_' : table(entries)
}

function renderAggregate(aggregate: Aggregate): string {
  const out: string[] = []
  out.push('# FINANCE-CONTACT-04B1 — contact import audit (dry run, no writes)')
  out.push('')
  out.push(`Run: ${aggregate.runAt} · mode: ${aggregate.mode}`)
  out.push(
    `Scope: operational from ${aggregate.scope.operationalCutoff} to ${aggregate.scope.operationalEnd ?? '(open)'}; ` +
      `explicitly excluded: ${aggregate.scope.excludedFutureIntakes.map((intake) => `${intake.programCode} ${intake.intakeDate}`).join(', ') || 'none'}`,
  )
  out.push('')
  out.push('## Source workbooks')
  for (const workbook of aggregate.workbooks) {
    out.push('')
    out.push(`### ${workbook.fileName}`)
    out.push(
      table([
        ['size (bytes)', workbook.sizeBytes],
        ['sha256', workbook.sha256],
        ['unchanged after run', workbook.unchanged ? 'yes' : 'NO'],
        ['sheets', workbook.sheetNames.join(' · ')],
        ['adapter', workbook.adapterId ?? 'none (not a contact master)'],
      ]),
    )
    for (const verdict of workbook.recognition) out.push(`- ${verdict.adapterId}: ${verdict.recognized ? 'recognized' : 'not recognized'} — ${verdict.reason}`)
    if (workbook.adapterId === null) continue
    out.push('')
    out.push(`Ignored headings (never read): ${workbook.ignoredHeadings.join(', ') || 'none'}`)
    out.push(`Of which sensitive: ${workbook.sensitiveHeadings.join(', ') || 'none'}`)
    if (workbook.notes.length > 0) {
      out.push('')
      for (const note of workbook.notes) out.push(`- note: ${note}`)
    }
    out.push('')
    out.push('Discovered roster tables:')
    out.push('')
    out.push('| Sheet | Table title | Intake date | Session | Student rows | Role |')
    out.push('| --- | --- | --- | --- | ---: | --- |')
    for (const intake of workbook.intakes) {
      out.push(`| ${intake.sheet} | ${intake.title ?? '(no title cell)'} | ${intake.intakeDate ?? '–'} | ${intake.session ?? '–'} | ${intake.studentRows} | ${intake.role} |`)
    }
    out.push('')
    out.push('Per-sheet conservation (every row of the used range has one kind):')
    out.push('')
    out.push('| Sheet | Range rows | Title | Header | Student | Placeholder | Legend | Blank | Other | Conserved |')
    out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
    for (const sheet of workbook.conservation.sheets) {
      out.push(
        `| ${sheet.sheetName} | ${sheet.rangeRows} | ${sheet.title} | ${sheet.header} | ${sheet.student} | ${sheet.placeholder} | ${sheet.legend} | ${sheet.blank} | ${sheet.other} | ${sheet.conserved ? 'yes' : 'NO'} |`,
      )
    }
    const c = workbook.conservation
    out.push('')
    out.push(
      table([
        ['discovered student rows', c.discoveredStudentRows],
        ['staged (primary) rows', c.stagedRows],
        ['cross-check (subset) rows', c.crossCheckRows],
        ['operational', c.operational],
        ['historical exclusions', c.historical],
        ['future exclusions', c.future],
        ['unaccounted', c.unaccounted],
        ['conserved', c.conserved ? 'yes' : 'NO'],
      ]),
    )
    out.push('')
    out.push(
      table([
        ['duplicate student-number groups in source', workbook.duplicateGroups],
        ['duplicate explanations', Object.entries(workbook.duplicateExplanations).map(([k, v]) => `${k}: ${v}`).join('; ') || 'none'],
        ['source conflicts (same number, different value)', workbook.conflicts],
        ['conflict fields', Object.entries(workbook.conflictFields).map(([k, v]) => `${k}: ${v}`).join('; ') || 'none'],
      ]),
    )
    if (workbook.subsetCrossCheck) {
      const s = workbook.subsetCrossCheck
      out.push('')
      out.push('Master versus subset sheets:')
      out.push(
        table([
          ['distinct numbers on master', s.masterNumbers],
          ['subset rows', s.subsetRows],
          ['distinct numbers across subsets', s.distinctSubsetNumbers],
          ['on master, in no subset', s.masterOnly],
          ['in a subset, not on master', s.subsetOnly],
          ['listed in several subset tables', s.inSeveralSubsets],
          ['master/subset session mismatch', s.sessionMismatch],
          ['master/subset value conflicts', s.conflicts],
        ]),
      )
    }
  }

  if (aggregate.staged) {
    const s = aggregate.staged
    out.push('')
    out.push('## Hosted reconciliation (exact student number only)')
    out.push('')
    out.push(
      table([
        ['staged rows (all scopes)', s.total],
        ['operational rows', s.operational],
        ['exact hosted matches (all scopes)', s.exactHostedMatches],
        ['exact hosted matches (operational)', s.operationalExactHostedMatches],
        ['operational rows with no hosted student', s.operationalStudentsNotInApp],
        ['distinct new students an apply would create', Object.entries(s.distinctNewStudentsToCreate).map(([k, v]) => `${k}: ${v}`).join('; ') || '0'],
        ['emails shared by several student numbers', s.sharedEmails],
        ['phones shared by several student numbers', s.sharedPhones],
        ['hosted student numbers held by more than one hosted row', s.hostedDuplicateNumbers],
        ['hosted students in the window absent from the masters', Object.entries(s.hostedAbsentFromMasters).map(([k, v]) => `${k}: ${v}`).join('; ') || '0'],
        ['session disagreements among intake matches', s.sessionMismatches],
      ]),
    )
    out.push('')
    out.push('Primary category, operational rows:')
    out.push('')
    out.push(tallyTable(s.operationalPrimary))
    out.push('')
    out.push('Primary category, all staged rows:')
    out.push('')
    out.push(tallyTable(s.primary))
    out.push('')
    out.push('Primary category by program (all staged rows):')
    out.push('')
    for (const [program, counts] of Object.entries(s.primaryByProgram)) {
      out.push(`${program}: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
    }
    out.push('')
    out.push('Flags, operational rows:')
    out.push('')
    out.push(tallyTable(s.operationalFlags))
    out.push('')
    out.push('Intake cross-check, operational rows:')
    out.push('')
    out.push(tallyTable(s.operationalIntakeCategories))
  }

  if (aggregate.unassigned) {
    const u = aggregate.unassigned
    out.push('')
    out.push('## Unassigned finance records versus the masters')
    out.push('')
    out.push(
      table([
        ['unassigned records', u.records],
        ['with a student number (exact-number check)', u.numbered],
        ['without a student number (never matched by name)', u.numberless],
        ['numbered records found in a master', u.numberedFoundInSource],
        ['… providing a valid email', u.numberedProvidingEmail],
        ['… providing a valid phone', u.numberedProvidingPhone],
        ['batch evidence', Object.entries(u.batchEvidence).map(([k, v]) => `${k}: ${v}`).join('; ') || 'none'],
        ['number-less records: source rows with identical name text (informational only)', u.numberlessSameNameTextRows],
      ]),
    )
  }

  if (aggregate.hosted) {
    const h = aggregate.hosted
    out.push('')
    out.push('## Hosted integrity')
    out.push('')
    out.push(`Project ${h.projectRef}, session role ${h.appRole ?? 'unknown'} (RLS enforced; no service-role read).`)
    out.push('')
    out.push('| Table | Before | After |')
    out.push('| --- | ---: | ---: |')
    for (const tableName of INTEGRITY_TABLES) out.push(`| ${tableName} | ${h.countsBefore[tableName]} | ${h.countsAfter[tableName]} |`)
    out.push('')
    out.push(`Counts unchanged: ${h.countsUnchanged ? 'yes' : 'NO'}`)
  }

  out.push('')
  out.push(`Source conservation: ${aggregate.conservationOk ? 'PASS' : 'FAIL'} · workbooks unchanged: ${aggregate.workbooksUnchanged ? 'yes' : 'NO'}`)
  out.push(`Coverage note: ${pct(aggregate.staged?.operationalExactHostedMatches ?? 0, aggregate.staged?.operational ?? 0)} of operational rows match a hosted student exactly.`)
  return out.join('\n')
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

async function main(): Promise<number> {
  const repoRoot = repoRootFromHere()
  const now = new Date()
  const args = parseArgs(process.argv.slice(2))

  // --- 1. Sources ------------------------------------------------------------
  const discovered: DiscoveredWorkbook[] = discoverContactWorkbooks(repoRoot)
  console.log(`reference/: ${discovered.length} workbook(s)`)
  for (const item of discovered) {
    console.log(
      `  ${item.fingerprint.fileName} · ${item.fingerprint.sizeBytes} bytes · sha256 ${item.fingerprint.sha256} · ` +
        `${item.fingerprint.sheetNames.length} sheets · adapter: ${item.identification.adapter?.id ?? 'none'}`,
    )
    if (item.identification.conflict) {
      console.error(`STOP: ${item.identification.conflict.join(' and ')} both claim ${item.fingerprint.fileName}`)
      return 2
    }
  }
  const masters = discovered.filter((item) => item.identification.adapter !== null)
  if (masters.length === 0) {
    console.error('STOP: no contact master workbook was recognized under reference/')
    return 2
  }
  const claimedPrograms = masters.map((item) => (item.identification.adapter as MasterContactSourceAdapter).programCode)
  if (new Set(claimedPrograms).size !== claimedPrograms.length) {
    console.error('STOP: two workbooks were recognized for the same program; refusing to guess which is current')
    return 2
  }

  // --- 2–4. Parse, scope, normalize (normalization happens in the adapters) ---
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
    const scope = applyScope(parse.rows, adapter.scopeDateField, args.config)
    applyScope(parse.crossCheckRows, adapter.scopeDateField, args.config)
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
    console.log(
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
  const duplicates = reports.flatMap((report) => report.duplicates)
  const shared = findSharedContacts(allRows)

  // --- 5. Hosted -------------------------------------------------------------
  let session: HostedSession | null = null
  let hosted: HostedSnapshot | null = null
  let countsBefore: Record<string, number> = {}
  let reads: HostedReads | null = null
  if (!args.offline) {
    session = await openHostedSession(repoRoot)
    console.log(`hosted:   project ${session.projectRef}, app role ${session.appRole ?? 'unknown'} (RLS enforced)`)
    countsBefore = await integrityCounts(session)
    console.log(`before:   ${JSON.stringify(countsBefore)}`)
    reads = await readHosted(session)
    hosted = {
      students: reads.students,
      programs: reads.programs,
      batches: reads.batches,
      records: reads.records,
      intakes: hostedIntakes(reads),
    }
  }

  // --- 6–9. Classify, cross-check ---------------------------------------------
  let assessments: RowAssessment[] = []
  let hostedDuplicates: HostedDuplicateNumber[] = []
  let absent: HostedAbsentFromMasters[] = []
  let unassigned: UnassignedCrossCheck[] = []
  if (hosted && reads) {
    assessments = classifyRows(allRows, { hosted, duplicates, shared, dateUnknownRowIds })
    hostedDuplicates = findHostedDuplicateNumbers(hosted.students)
    absent = hostedStudentsAbsentFromMasters(
      hosted,
      allRows.filter((row) => row.exclusionReason === null),
      { from: args.config.operationalCutoff, to: args.config.operationalEnd },
    )
    const studentById = new Map(reads.students.map((student) => [student.id, student]))
    const programById = new Map(reads.programs.map((program) => [program.id, program]))
    const unassignedRecords: UnassignedRecordLike[] = reads.records
      .filter((record) => record.batch_id === null)
      .map((record) => {
        const student = studentById.get(record.student_id)
        const names = student
          ? [
              student.display_name,
              student.legacy_name,
              [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' ') || null,
            ].filter((name): name is string => typeof name === 'string' && name.trim() !== '')
          : []
        return {
          financeRecordId: record.id,
          programCode: programById.get(record.program_id)?.short_code ?? 'unknown',
          studentId: record.student_id,
          studentNumber: student?.student_number?.trim() || null,
          studentNames: names,
        }
      })
    unassigned = crossCheckUnassigned(unassignedRecords, allRows, hosted)
  }

  // --- Integrity after every read ----------------------------------------------
  let countsAfter: Record<string, number> = {}
  if (session) {
    countsAfter = await integrityCounts(session)
    await session.signOut()
  }
  const hashesAfter = new Map(discovered.map((item) => [item.fingerprint.fileName, hashReferenceFile(repoRoot, item.fingerprint.fileName)]))

  // --- Aggregate ---------------------------------------------------------------
  const operational = assessments.filter((item) => item.row.exclusionReason === null)
  const primaryByProgram: Record<string, Record<string, number>> = {}
  for (const program of new Set(assessments.map((item) => item.row.programCode))) {
    primaryByProgram[program] = tally(assessments.filter((item) => item.row.programCode === program).map((item) => item.primary as PrimaryCategory))
  }
  const newStudents: Record<string, number> = {}
  for (const program of new Set(operational.map((item) => item.row.programCode))) {
    newStudents[program] = new Set(
      operational
        .filter((item) => item.row.programCode === program && item.primary === 'STUDENT_NOT_IN_APP')
        .map((item) => item.row.studentNumber as string),
    ).size
  }
  const absentByProgram = tally(absent.map((item) => item.programCode))
  const numbered = unassigned.filter((item) => item.identityMode === 'exact_student_number')
  const numberless = unassigned.filter((item) => item.identityMode === 'no_student_number')

  const aggregate: Aggregate = {
    ticket: 'FINANCE-CONTACT-04B1',
    runAt: now.toISOString(),
    mode: args.offline ? 'offline' : 'hosted',
    scope: args.config,
    workbooks: reports.map((report) => ({
      fileName: report.fingerprint.fileName,
      sizeBytes: report.fingerprint.sizeBytes,
      sha256: report.fingerprint.sha256,
      sha256After: hashesAfter.get(report.fingerprint.fileName) ?? '',
      unchanged: hashesAfter.get(report.fingerprint.fileName) === report.fingerprint.sha256,
      sheetNames: report.fingerprint.sheetNames,
      adapterId: report.adapterId,
      recognition: report.recognition,
      ignoredHeadings: report.parse?.ignoredHeadings ?? [],
      sensitiveHeadings: report.parse?.sensitiveHeadings ?? [],
      notes: report.parse?.notes ?? [],
      intakes: (report.parse?.intakes ?? []).map((intake) => ({
        sheet: intake.sheetName,
        title: intake.tableTitle,
        intakeDate: intake.intakeDate,
        session: intake.session,
        studentRows: intake.studentRows,
        role: intake.role,
      })),
      conservation: report.conservation ?? {
        programCode: '',
        workbookName: report.fingerprint.fileName,
        sheets: [],
        discoveredStudentRows: 0,
        stagedRows: 0,
        crossCheckRows: 0,
        operational: 0,
        historical: 0,
        future: 0,
        unaccounted: 0,
        conserved: true,
      },
      scope: report.scope ?? { operational: 0, historical: 0, future: 0, dateUnknown: 0 },
      duplicateGroups: report.duplicates.length,
      duplicateExplanations: tally(report.duplicates.map((group) => group.explanation)),
      conflicts: report.conflicts.length,
      conflictFields: tally(report.conflicts.map((conflict) => conflict.field)),
      subsetCrossCheck: report.subsetCrossCheck
        ? {
            masterNumbers: report.subsetCrossCheck.masterNumbers,
            subsetRows: report.subsetCrossCheck.subsetRows,
            distinctSubsetNumbers: report.subsetCrossCheck.distinctSubsetNumbers,
            masterOnly: report.subsetCrossCheck.masterOnly.length,
            subsetOnly: report.subsetCrossCheck.subsetOnly.length,
            inSeveralSubsets: report.subsetCrossCheck.inSeveralSubsets.length,
            sessionMismatch: report.subsetCrossCheck.sessionMismatch.length,
            conflicts: report.subsetCrossCheck.conflicts.length,
          }
        : null,
    })),
    staged: hosted
      ? {
          total: assessments.length,
          operational: operational.length,
          primaryByProgram,
          primary: tally(assessments.map((item) => item.primary as PrimaryCategory)),
          operationalPrimary: tally(operational.map((item) => item.primary as PrimaryCategory)),
          flags: tally(assessments.flatMap((item) => item.flags as Flag[])),
          operationalFlags: tally(operational.flatMap((item) => item.flags as Flag[])),
          intakeCategories: tally(assessments.map((item) => item.intake.category as IntakeCategory)),
          operationalIntakeCategories: tally(operational.map((item) => item.intake.category as IntakeCategory)),
          sessionMismatches: operational.filter((item) => item.intake.sessionMatches === false).length,
          exactHostedMatches: assessments.filter((item) => item.hostedMatchCount === 1).length,
          operationalExactHostedMatches: operational.filter((item) => item.hostedMatchCount === 1).length,
          operationalStudentsNotInApp: operational.filter((item) => item.primary === 'STUDENT_NOT_IN_APP').length,
          distinctNewStudentsToCreate: newStudents,
          sharedEmails: shared.filter((item) => item.kind === 'email').length,
          sharedPhones: shared.filter((item) => item.kind === 'phone').length,
          hostedDuplicateNumbers: hostedDuplicates.length,
          hostedAbsentFromMasters: absentByProgram,
        }
      : null,
    unassigned: hosted
      ? {
          records: unassigned.length,
          numbered: numbered.length,
          numberless: numberless.length,
          numberedFoundInSource: numbered.filter((item) => item.sourceRowIds.length > 0).length,
          numberedProvidingEmail: numbered.filter((item) => item.providesEmail).length,
          numberedProvidingPhone: numbered.filter((item) => item.providesPhone).length,
          batchEvidence: tally(numbered.map((item) => item.batchEvidence)),
          numberlessSameNameTextRows: numberless.reduce((sum, item) => sum + item.sameNameTextRows, 0),
        }
      : null,
    hosted: session
      ? {
          projectRef: session.projectRef,
          appRole: session.appRole,
          countsBefore,
          countsAfter,
          countsUnchanged: INTEGRITY_TABLES.every((tableName) => countsBefore[tableName] === countsAfter[tableName]),
        }
      : null,
    conservationOk: reports.every((report) => report.conservation === null || report.conservation.conserved),
    workbooksUnchanged: discovered.every((item) => hashesAfter.get(item.fingerprint.fileName) === item.fingerprint.sha256),
  }

  // --- 10–11. Outputs ------------------------------------------------------------
  const privateDir = path.join(repoRoot, PRIVATE_DIR)
  mkdirSync(privateDir, { recursive: true })
  const write = (name: string, value: unknown): string => {
    writeFileSync(path.join(privateDir, name), `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`, 'utf8')
    return `${PRIVATE_DIR.split(path.sep).join('/')}/${name}`
  }

  const written: string[] = []
  written.push(
    write('contact-audit.json', {
      aggregate,
      hostedDuplicateNumbers: hostedDuplicates,
      hostedAbsentFromMasters: absent,
      duplicates,
      sharedContacts: shared,
      conflicts: reports.flatMap((report) => report.conflicts),
      subsetCrossChecks: reports.map((report) => report.subsetCrossCheck).filter(Boolean),
      unassigned,
      rows: assessments.length > 0 ? assessments : allRows.map((row) => ({ row })),
    }),
  )
  if (assessments.length > 0) written.push(write('contact-audit.csv', toCsv(assessments, ASSESSMENT_COLUMNS)))
  for (const report of reports) {
    if (!report.parse) continue
    const stem = report.parse.programCode.toLowerCase()
    written.push(write(`${stem}-source-rows.csv`, toCsv([...report.parse.rows, ...report.parse.crossCheckRows], ROW_COLUMNS)))
  }
  written.push(write('conflicts.csv', toCsv(reports.flatMap((report) => report.conflicts), CONFLICT_COLUMNS)))
  if (unassigned.length > 0) {
    written.push(
      write(
        'unassigned-cross-check.csv',
        toCsv(unassigned, [
          ['finance_record_id', (u) => u.financeRecordId],
          ['program', (u) => u.programCode],
          ['student_number', (u) => u.studentNumber],
          ['identity_mode', (u) => u.identityMode],
          ['source_rows', (u) => u.sourceLocations],
          ['provides_email', (u) => u.providesEmail],
          ['provides_phone', (u) => u.providesPhone],
          ['source_intakes', (u) => u.sourceIntakes],
          ['source_sessions', (u) => u.sourceSessions],
          ['mapped_hosted_intakes', (u) => u.mappedHostedIntakeLabels],
          ['candidate_batches', (u) => u.candidateBatchNames],
          ['batch_evidence', (u) => u.batchEvidence],
          ['same_name_text_rows', (u) => u.sameNameTextRows],
        ]),
      ),
    )
  }
  const aggregateText = renderAggregate(aggregate)
  written.push(write('contact-audit-aggregate.md', aggregateText))

  console.log('')
  console.log(aggregateText)
  console.log('')
  for (const file of written) console.log(`wrote ${file} (Git-ignored)`)

  // --- 12. Exit --------------------------------------------------------------------
  if (!aggregate.workbooksUnchanged) {
    console.error('REFERENCE WORKBOOK MODIFIED during the audit')
    return 3
  }
  if (aggregate.hosted && !aggregate.hosted.countsUnchanged) {
    console.error('HOSTED COUNTS CHANGED during the audit')
    return 4
  }
  if (!aggregate.conservationOk) {
    console.error('SOURCE CONSERVATION FAILED')
    return 1
  }
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
