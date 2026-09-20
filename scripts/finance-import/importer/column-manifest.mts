/**
 * The batch column manifest — FINANCE-COLUMN-MANIFEST-03A.
 *
 * ## Why this exists
 *
 * The historical import preserved every populated cell of every batch row in
 * `student_finance_records.legacy_raw_json`, and omitted blank cells rather
 * than storing nulls — a blank is not a value, and the omission is what keeps
 * "nothing was entered" distinct from "zero was entered". The cost is that a
 * column *every* student in a batch left empty leaves no trace in any row, so
 * a grid that rebuilds its columns from row data cannot show it. Twenty-one
 * such columns exist in the workbook: eight month columns, six Late Fees, the
 * ELCE roster's Balance, four REMARKS and two Payer.
 *
 * This module describes **column structure**, separately from student values.
 * A manifest row says "this column existed in this batch table, here, headed
 * like this". Whether a student has a value in it remains the row's business.
 * That split is the whole design: the manifest restores the shape of the
 * table without writing a single placeholder into a student's record.
 *
 * ## What it produces
 *
 * For every batch table the import mapped, one manifest row per column of the
 * table's finance sections:
 *
 *  * `actual` — the ACTUAL FEE STRUCTURE span of a split PSW table, in full
 *    (headed or not, money or not), or the money-headed columns of a flat
 *    roster such as ELCE, where no split exists and identity columns sit
 *    beside the figures;
 *  * `installment` — the columns of the INSTALLMENT FEE STRUCTURE section
 *    that the import treats as a scheduled instalment, with the same sequence
 *    numbers the normalized `installments` rows carry.
 *
 * Nothing about a student is read except *whether* a cell is blank, and that
 * only to report which columns the row-union approach had lost. No name,
 * number, amount or remark enters a manifest row, the rendered SQL, or the
 * dry-run output — `findUnexpectedArtifactLiterals` enforces that as a
 * whitelist over every string literal the artifact contains.
 *
 * ## Determinism
 *
 * Every row's id is the importer's RFC 4122 v5 UUID over a source key built
 * from the workbook hash, sheet, table key, section and column letter — the
 * same primitive every imported entity uses (`deterministic-ids.mts`). The
 * batch a row points at is the deterministic batch id the import created, and
 * that id must *also* be found on the hosted `batches` row whose `code` is the
 * table's `sheet!tableKey`. Both must agree, or the table is unmatched.
 *
 * Pure: no I/O, no clock, no client.
 */

import { batchFinanceColumnSourceKey, batchSourceKey } from './source-keys.mts'
import { entityId } from './deterministic-ids.mts'
import { scheduleColumns } from './installments.mts'

import type { ColumnRole } from '../lib/headers.mts'
import type { SourceColumn, SourceTable } from './source-tables.mts'
import type { SupportedBatchTable } from './batch-tables.mts'

// -----------------------------------------------------------------------------
// Vocabularies — mirrored by the CHECK constraints in the schema migration
// -----------------------------------------------------------------------------

export const MANIFEST_SECTIONS = ['actual', 'installment'] as const
export type ManifestSection = (typeof MANIFEST_SECTIONS)[number]

/**
 * Semantic roles. Metadata only: the source header is always kept verbatim,
 * and a role is never used to rewrite it. "Marc" stays "Marc" even where it
 * is plainly March, and resolves to `other` because the importer's exact
 * header matching does not recognise it — inventing the month here would be
 * inventing meaning the workbook did not state.
 */
export const MANIFEST_ROLES = [
  'student_number',
  'student_name',
  'enrollment',
  'month',
  'late_fees',
  'total_fee',
  'total_paid',
  'balance',
  'discount',
  'installment',
  'remarks',
  'payer',
  'other',
] as const
export type ManifestRole = (typeof MANIFEST_ROLES)[number]

export const MANIFEST_VALUE_KINDS = ['money', 'text'] as const
export type ManifestValueKind = (typeof MANIFEST_VALUE_KINDS)[number]

export const LEGACY_ORIGIN = 'legacy_workbook'

/** Importer roles → manifest roles. Anything unlisted is `other`. */
const ROLE_MAP: Partial<Record<ColumnRole, ManifestRole>> = {
  student_id: 'student_number',
  first_name: 'student_name',
  middle_name: 'student_name',
  last_name: 'student_name',
  student_name: 'student_name',
  enrollment_fee: 'enrollment',
  month: 'month',
  late_fees: 'late_fees',
  total_fee: 'total_fee',
  total_paid: 'total_paid',
  outstanding: 'balance',
  balance: 'balance',
  discount: 'discount',
  installment_ordinal: 'installment',
  remarks: 'remarks',
  payer: 'payer',
}

export function manifestRoleFor(role: ColumnRole): ManifestRole {
  return ROLE_MAP[role] ?? 'other'
}

/**
 * Importer roles whose cells are text, not currency, even when the column sits
 * inside the ACTUAL money span. A REMARKS column full of blanks today must not
 * become a currency column the day somebody types a remark into it.
 */
const TEXT_ROLES: ReadonlySet<ColumnRole> = new Set<ColumnRole>([
  'remarks',
  'payer',
  'student_id',
  'first_name',
  'middle_name',
  'last_name',
  'student_name',
  'serial_number',
  'graduated',
  'start_date',
  'date_yyyymmdd',
  'schedule_type',
  'payment_number',
  'batch',
  'paid_date',
  'payment_method',
  'receipt_sent',
  'program',
])

/**
 * The value kind of a column in a finance section.
 *
 * Within the ACTUAL span everything is money unless its heading names a text
 * role — that is the same reading GRID-03 already applies, made explicit and
 * stored. An unheaded column in the span is money: on every PSW sheet it is
 * the outstanding formula, and "Column Q" is how the grid names it.
 */
export function manifestValueKindFor(role: ColumnRole): ManifestValueKind {
  return TEXT_ROLES.has(role) ? 'text' : 'money'
}

/**
 * Roles that admit a column of a *flat* table (no ACTUAL/INSTALLMENT split)
 * into the manifest's `actual` section. A flat table keeps identity, dates
 * and text beside its figures, and only the figures belong in a money group.
 * This is the same rule GRID-03's `headerNamesMoney` applies from the other
 * side, expressed in importer roles.
 */
const FLAT_MONEY_ROLES: ReadonlySet<ColumnRole> = new Set<ColumnRole>([
  'total_fee',
  'enrollment_fee',
  'installment_ordinal',
  'late_fees',
  'month',
  'total_paid',
  'balance',
  'outstanding',
  'discount',
  'amount_paid',
])

// -----------------------------------------------------------------------------
// Planned rows
// -----------------------------------------------------------------------------

export interface PlannedManifestColumn {
  /** Deterministic v5 UUID: the row's primary key. */
  id: string
  sourceKey: string
  /** Deterministic id of the batch the import created for this table. */
  batchId: string
  /** `batches.code` of that batch: `sheet!tableKey`. Joined on in the migration. */
  batchCode: string
  programShortCode: string
  legacySheetName: string
  legacyTableKey: string
  section: ManifestSection
  sourceColumnLetter: string
  /** Exactly as the workbook stores it, trailing spaces included. Null when unheaded. */
  sourceHeader: string | null
  /** True when the heading was borrowed from an earlier table on the same sheet. */
  sourceHeaderInherited: boolean
  columnKey: string
  normalizedRole: ManifestRole
  valueKind: ManifestValueKind
  displayOrder: number
  isGridVisible: boolean
  displayEvenIfBlank: boolean
  origin: typeof LEGACY_ORIGIN
  sourceWorkbookHash: string
  /**
   * Audit only, never written to the database: every student row of the
   * table left this cell blank, so the row-union approach could not show it.
   */
  allBlankInSource: boolean
}

/** A cell counts as blank exactly when `rowCellsForRawJson` would omit it. */
function isOmittedAsBlank(table: SourceTable, column: SourceColumn): boolean {
  return table.rows
    .filter((row) => row.kind === 'student')
    .every((row) => {
      const cell = row.cellByColumn.get(column.column)
      return !cell || (cell.isBlank && cell.formula === null && !cell.isError)
    })
}

/** `actual:G`, `installment:V` — stable, source-derived, unique per batch+section. */
export function manifestColumnKey(section: ManifestSection, letter: string): string {
  return `${section}:${letter}`
}

/**
 * Plans the manifest rows of one batch table.
 *
 * `actual` takes the ACTUAL span whole on a split table — that is the shape
 * staff saw, unheaded reconciliation columns and blank REMARKS included — and
 * only money-headed columns on a flat one. `installment` takes exactly the
 * columns `scheduleColumns` treats as instalments, numbered as it numbers
 * them, so `display_order` equals the `sequence_number` on the normalized
 * rows and the grid can line the two up without guessing.
 */
export function planTableManifest(
  workbookHash: string,
  entry: SupportedBatchTable,
): PlannedManifestColumn[] {
  const { table, programShortCode } = entry
  const batchId = entityId(batchSourceKey(workbookHash, table.sheetName, table.key))
  const batchCode = `${table.sheetName}!${table.key}`

  const base = (
    column: SourceColumn,
    section: ManifestSection,
    displayOrder: number,
    valueKind: ManifestValueKind,
  ): PlannedManifestColumn => {
    const sourceKey = batchFinanceColumnSourceKey(
      workbookHash,
      table.sheetName,
      table.key,
      section,
      column.letter,
    )
    return {
      id: entityId(sourceKey),
      sourceKey,
      batchId,
      batchCode,
      programShortCode,
      legacySheetName: table.sheetName,
      legacyTableKey: table.key,
      section,
      sourceColumnLetter: column.letter,
      sourceHeader: column.header,
      sourceHeaderInherited: column.inherited,
      columnKey: manifestColumnKey(section, column.letter),
      normalizedRole: manifestRoleFor(column.role),
      valueKind,
      displayOrder,
      // A text column is real structure but not a figure: it is kept for the
      // detail and editing surfaces later tickets build, and hidden from the
      // money grid so a column of blank remarks cannot read as a fee.
      isGridVisible: valueKind === 'money',
      displayEvenIfBlank: true,
      origin: LEGACY_ORIGIN,
      sourceWorkbookHash: workbookHash,
      allBlankInSource: isOmittedAsBlank(table, column),
    }
  }

  const split = table.columns.some(
    (column) => column.section === 'actual' || column.section === 'installment',
  )

  const actualColumns = split
    ? table.columns.filter((column) => column.section === 'actual')
    : table.columns.filter(
        (column) => column.section === 'flat' && FLAT_MONEY_ROLES.has(column.role),
      )

  const actual = actualColumns
    .slice()
    .sort((a, b) => a.column - b.column)
    .map((column, index) => base(column, 'actual', index + 1, manifestValueKindFor(column.role)))

  const installment = scheduleColumns(table).columns.map((scheduled) =>
    base(scheduled.column, 'installment', scheduled.sequenceNumber, 'money'),
  )

  return [...actual, ...installment]
}

// -----------------------------------------------------------------------------
// Matching workbook tables to hosted batches
// -----------------------------------------------------------------------------

/** What the generator reads back from hosted `batches`. Nothing about a student. */
export interface HostedBatchIdentity {
  id: string
  code: string | null
  legacySheetName: string | null
  programShortCode: string | null
}

export type BatchMatch =
  | { status: 'matched'; batchId: string; batchCode: string }
  | { status: 'unmatched'; batchCode: string; reason: string }
  | { status: 'ambiguous'; batchCode: string; reason: string }

export interface TableMatch {
  sheetName: string
  tableKey: string
  title: string | null
  programShortCode: string
  match: BatchMatch
}

/**
 * Resolves the hosted batch for one table, or refuses.
 *
 * Exact identity only. The deterministic batch id *and* the batch code must
 * both point at the same hosted row, and that row must carry the same sheet
 * name and program. A candidate that agrees on some of those and not others
 * is reported as ambiguous, never taken. Nothing is matched on a name, a
 * title or a date: two batches share every date, and titles are typed by hand.
 */
export function matchTableToBatch(
  workbookHash: string,
  entry: SupportedBatchTable,
  hosted: readonly HostedBatchIdentity[],
): TableMatch {
  const { table } = entry
  const expectedId = entityId(batchSourceKey(workbookHash, table.sheetName, table.key))
  const batchCode = `${table.sheetName}!${table.key}`

  const candidates = hosted.filter((batch) => batch.id === expectedId || batch.code === batchCode)

  const describe = {
    sheetName: table.sheetName,
    tableKey: table.key,
    title: table.title,
    programShortCode: entry.programShortCode,
  }

  if (candidates.length === 0) {
    return {
      ...describe,
      match: {
        status: 'unmatched',
        batchCode,
        reason: "no hosted batch carries this table's deterministic id or its source code",
      },
    }
  }

  if (candidates.length > 1) {
    return {
      ...describe,
      match: {
        status: 'ambiguous',
        batchCode,
        reason: `${candidates.length} hosted batches claim this table by id or code; refusing to choose`,
      },
    }
  }

  const [candidate] = candidates
  const disagreements: string[] = []
  if (candidate.id !== expectedId) disagreements.push('deterministic id')
  if (candidate.code !== batchCode) disagreements.push('batch code')
  if (candidate.legacySheetName !== table.sheetName) disagreements.push('legacy sheet name')
  if (candidate.programShortCode !== entry.programShortCode) disagreements.push('program')

  if (disagreements.length > 0) {
    return {
      ...describe,
      match: {
        status: 'ambiguous',
        batchCode,
        reason: `one hosted batch is a partial match; it disagrees on ${disagreements.join(', ')}`,
      },
    }
  }

  return { ...describe, match: { status: 'matched', batchId: candidate.id, batchCode } }
}

// -----------------------------------------------------------------------------
// The whole plan
// -----------------------------------------------------------------------------

export interface ManifestPlanCounts {
  sourceBatchTables: number
  matchedBatches: number
  ambiguousMappings: number
  unmatchedTables: number
  rows: number
  actualRows: number
  installmentRows: number
  /** Money columns, shown in the grid. */
  gridVisibleRows: number
  /** Text columns (REMARKS, Payer), kept but hidden from the money grid. */
  hiddenTextRows: number
  /** Visible columns every student in the batch left blank: what the grid had lost. */
  allBlankVisibleRows: number
  allBlankHiddenRows: number
  /** Installment columns every student left blank. Expected 0. */
  allBlankInstallmentRows: number
  batchesWithAllBlankColumns: number
  rowsByRole: Record<string, number>
  rowsByProgram: Record<string, number>
}

export interface RestoredColumn {
  batchCode: string
  programShortCode: string
  section: ManifestSection
  letter: string
  header: string | null
  role: ManifestRole
}

export interface ManifestPlan {
  workbookHash: string
  matches: TableMatch[]
  rows: PlannedManifestColumn[]
  /** Visible columns the row-union grid could not show, per batch. Layout only. */
  restoredColumns: RestoredColumn[]
  counts: ManifestPlanCounts
  /** Reasons the plan must not be written. Empty when it may. */
  blockers: string[]
}

/**
 * Plans the complete manifest for every supported table.
 *
 * Rows are only planned for matched tables — an unmatched or ambiguous table
 * is a blocker for the whole plan, not a gap in it, because a partial
 * manifest would leave some batches on the row-union fallback with no way to
 * tell which from the screen.
 */
export function planColumnManifest(
  workbookHash: string,
  tables: readonly SupportedBatchTable[],
  hosted: readonly HostedBatchIdentity[],
): ManifestPlan {
  const matches = tables.map((entry) => matchTableToBatch(workbookHash, entry, hosted))
  const blockers: string[] = []

  const rows: PlannedManifestColumn[] = []
  tables.forEach((entry, index) => {
    const match = matches[index].match
    if (match.status !== 'matched') {
      blockers.push(`${match.status}: ${match.batchCode} — ${match.reason}`)
      return
    }
    const planned = planTableManifest(workbookHash, entry)
    // The planner derives the batch id from the workbook; the match proved the
    // hosted row carries the same id. Assert it rather than trust it.
    for (const row of planned) {
      if (row.batchId !== match.batchId) {
        blockers.push(`internal: planned batch id differs from matched id for ${match.batchCode}`)
      }
    }
    rows.push(...planned)
  })

  const duplicateIds = findDuplicates(rows.map((row) => row.id))
  if (duplicateIds.length > 0) blockers.push(`duplicate manifest ids: ${duplicateIds.join(', ')}`)

  const duplicateKeys = findDuplicates(
    rows.map((row) => `${row.batchId}|${row.section}|${row.columnKey}`),
  )
  if (duplicateKeys.length > 0) blockers.push(`duplicate column keys: ${duplicateKeys.join(', ')}`)

  const rowsByRole: Record<string, number> = {}
  const rowsByProgram: Record<string, number> = {}
  for (const row of rows) {
    rowsByRole[row.normalizedRole] = (rowsByRole[row.normalizedRole] ?? 0) + 1
    rowsByProgram[row.programShortCode] = (rowsByProgram[row.programShortCode] ?? 0) + 1
  }

  const restoredColumns: RestoredColumn[] = rows
    .filter((row) => row.allBlankInSource && row.isGridVisible)
    .map((row) => ({
      batchCode: row.batchCode,
      programShortCode: row.programShortCode,
      section: row.section,
      letter: row.sourceColumnLetter,
      header: row.sourceHeader,
      role: row.normalizedRole,
    }))

  const counts: ManifestPlanCounts = {
    sourceBatchTables: tables.length,
    matchedBatches: matches.filter((entry) => entry.match.status === 'matched').length,
    ambiguousMappings: matches.filter((entry) => entry.match.status === 'ambiguous').length,
    unmatchedTables: matches.filter((entry) => entry.match.status === 'unmatched').length,
    rows: rows.length,
    actualRows: rows.filter((row) => row.section === 'actual').length,
    installmentRows: rows.filter((row) => row.section === 'installment').length,
    gridVisibleRows: rows.filter((row) => row.isGridVisible).length,
    hiddenTextRows: rows.filter((row) => !row.isGridVisible).length,
    allBlankVisibleRows: rows.filter((row) => row.allBlankInSource && row.isGridVisible).length,
    allBlankHiddenRows: rows.filter((row) => row.allBlankInSource && !row.isGridVisible).length,
    allBlankInstallmentRows: rows.filter(
      (row) => row.allBlankInSource && row.section === 'installment',
    ).length,
    batchesWithAllBlankColumns: new Set(
      rows.filter((row) => row.allBlankInSource).map((row) => row.batchId),
    ).size,
    rowsByRole,
    rowsByProgram,
  }

  return { workbookHash, matches, rows, restoredColumns, counts, blockers }
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates].sort()
}

// -----------------------------------------------------------------------------
// The migration artifact
// -----------------------------------------------------------------------------

/** The columns the data migration writes, in the order the VALUES tuples list them. */
export const MANIFEST_INSERT_COLUMNS = [
  'id',
  'batch_id',
  'section',
  'source_column_letter',
  'source_header',
  'source_header_inherited',
  'column_key',
  'normalized_role',
  'value_kind',
  'display_order',
  'is_grid_visible',
  'display_even_if_blank',
  'origin',
  'legacy_sheet_name',
  'legacy_table_key',
  'source_workbook_hash',
] as const

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function sqlNullableString(value: string | null): string {
  return value === null ? 'null' : sqlString(value)
}

/** One VALUES tuple. `batch_code` is carried for the join and is not inserted. */
function tupleFor(row: PlannedManifestColumn): string {
  return [
    sqlString(row.id),
    sqlString(row.batchId),
    sqlString(row.batchCode),
    sqlString(row.section),
    sqlString(row.sourceColumnLetter),
    sqlNullableString(row.sourceHeader),
    row.sourceHeaderInherited ? 'true' : 'false',
    sqlString(row.columnKey),
    sqlString(row.normalizedRole),
    sqlString(row.valueKind),
    String(row.displayOrder),
    row.isGridVisible ? 'true' : 'false',
    row.displayEvenIfBlank ? 'true' : 'false',
    sqlString(row.origin),
    sqlString(row.legacySheetName),
    sqlString(row.legacyTableKey),
    sqlString(row.sourceWorkbookHash),
  ].join(', ')
}

/** Stable order for the artifact: program, batch code, section, display order. */
export function compareManifestRows(a: PlannedManifestColumn, b: PlannedManifestColumn): number {
  return (
    a.programShortCode.localeCompare(b.programShortCode) ||
    a.batchCode.localeCompare(b.batchCode) ||
    a.section.localeCompare(b.section) ||
    a.displayOrder - b.displayOrder ||
    a.sourceColumnLetter.localeCompare(b.sourceColumnLetter)
  )
}

export interface RenderOptions {
  /** How to regenerate, printed into the header so nobody edits it by hand. */
  regenerateCommand: string
}

/**
 * Renders the data migration.
 *
 * Rows are inserted through a join on `batches` by *both* id and code, so a
 * fresh environment that has not run the historical import inserts nothing
 * rather than failing on a foreign key — and a hosted environment whose
 * batches disagree with the workbook inserts nothing for the disagreeing
 * table, which the post-migration count check then catches. `on conflict do
 * nothing` on the deterministic id makes a re-run converge on one copy.
 */
export function renderManifestMigration(plan: ManifestPlan, options: RenderOptions): string {
  if (plan.blockers.length > 0) {
    throw new Error(`refusing to render a blocked plan: ${plan.blockers.join('; ')}`)
  }

  const rows = plan.rows.slice().sort(compareManifestRows)
  const { counts } = plan

  const header = [
    '-- =============================================================================',
    '-- FINANCE-COLUMN-MANIFEST-03A — historical batch column layout (data)',
    '-- Toronto Academy of Education finance tracker',
    '-- =============================================================================',
    '--',
    '-- GENERATED FILE. Do not edit by hand. Regenerate with:',
    `--   ${options.regenerateCommand}`,
    '--',
    `-- Source workbook SHA-256: ${plan.workbookHash}`,
    `-- Batch tables: ${counts.sourceBatchTables}; rows: ${counts.rows} ` +
      `(actual ${counts.actualRows}, installment ${counts.installmentRows}; ` +
      `grid-visible ${counts.gridVisibleRows}, hidden text ${counts.hiddenTextRows})`,
    '--',
    '-- Layout metadata only: batch codes, sheet names, table keys, column letters',
    "-- and the workbook's own column headings. No student, amount or remark.",
    '--',
    '-- Each row joins to its batch by deterministic id AND by batches.code, so an',
    '-- environment without the historical import inserts nothing instead of',
    '-- failing, and a batch that disagrees with the workbook receives no layout.',
    '-- The deterministic id makes a re-run converge: on conflict do nothing.',
    '-- =============================================================================',
    '',
  ]

  const valueColumns = [
    'id',
    'batch_id',
    'batch_code',
    'section',
    'source_column_letter',
    'source_header',
    'source_header_inherited',
    'column_key',
    'normalized_role',
    'value_kind',
    'display_order',
    'is_grid_visible',
    'display_even_if_blank',
    'origin',
    'legacy_sheet_name',
    'legacy_table_key',
    'source_workbook_hash',
  ]

  const select = [
    'select',
    '  v.id::uuid,',
    '  v.batch_id::uuid,',
    '  v.section,',
    '  v.source_column_letter,',
    '  v.source_header,',
    '  v.source_header_inherited,',
    '  v.column_key,',
    '  v.normalized_role,',
    '  v.value_kind,',
    '  v.display_order,',
    '  v.is_grid_visible,',
    '  v.display_even_if_blank,',
    '  v.origin,',
    '  v.legacy_sheet_name,',
    '  v.legacy_table_key,',
    '  v.source_workbook_hash',
  ]

  const body = [
    `insert into public.batch_finance_columns (${MANIFEST_INSERT_COLUMNS.join(', ')})`,
    ...select,
    'from (values',
    rows.map((row) => `  (${tupleFor(row)})`).join(',\n'),
    `) as v(${valueColumns.join(', ')})`,
    'join public.batches b on b.id = v.batch_id::uuid and b.code = v.batch_code',
    'on conflict (id) do nothing;',
    '',
  ]

  return [...header, ...body].join('\n')
}

/**
 * The whitelist: every string literal in the artifact must be one of these.
 *
 * Computed from the plan itself, so the check is not "does this look like a
 * name" — which would be guessing — but "is this exactly a value the layout
 * is allowed to contain". A student number, a name or an amount cannot be in
 * the set, because nothing that builds the set reads one.
 */
export function allowedArtifactLiterals(plan: ManifestPlan): Set<string> {
  const allowed = new Set<string>([plan.workbookHash, LEGACY_ORIGIN])
  for (const value of MANIFEST_SECTIONS) allowed.add(value)
  for (const value of MANIFEST_ROLES) allowed.add(value)
  for (const value of MANIFEST_VALUE_KINDS) allowed.add(value)
  for (const row of plan.rows) {
    allowed.add(row.id)
    allowed.add(row.batchId)
    allowed.add(row.batchCode)
    allowed.add(row.sourceColumnLetter)
    if (row.sourceHeader !== null) allowed.add(row.sourceHeader)
    allowed.add(row.columnKey)
    allowed.add(row.legacySheetName)
    allowed.add(row.legacyTableKey)
  }
  return allowed
}

/**
 * Finds string literals in the artifact that the layout does not account for.
 *
 * Returns the offending literals (unescaped) rather than throwing, so a test
 * can name them and the generator can refuse to write.
 */
export function findUnexpectedArtifactLiterals(sql: string, plan: ManifestPlan): string[] {
  const allowed = allowedArtifactLiterals(plan)
  const offenders = new Set<string>()

  // Only the VALUES block carries data; the header is prose about the layout.
  const start = sql.indexOf('from (values')
  const end = sql.indexOf(') as v(')
  const block = start === -1 || end === -1 ? sql : sql.slice(start, end)

  for (const match of block.matchAll(/'((?:[^']|'')*)'/g)) {
    const literal = match[1].replace(/''/g, "'")
    if (!allowed.has(literal)) offenders.add(literal)
  }

  return [...offenders].sort()
}
