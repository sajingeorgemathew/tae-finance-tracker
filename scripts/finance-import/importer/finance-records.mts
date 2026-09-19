/**
 * Student finance records — one per student per detected batch table.
 *
 * The legacy summary fields are *snapshots*, copied from a single source cell
 * each. Nothing here adds up a row, reconciles a total against the payments, or
 * derives a balance from a fee and a paid figure. Where the workbook leaves a
 * cell blank the field is null, never zero: "no figure was recorded" and "the
 * figure was zero" are different facts about a student's account and the
 * difference has to survive the import.
 *
 * Totals lines are excluded here rather than downstream. Nineteen of the
 * twenty-two batch tables end with a row that has money on it and no student;
 * its Total Paid cell sums *down* the column instead of across the row. It is
 * not a student, and it must not become one.
 */

import { financeRecordSourceKey, unassignedFinanceRecordSourceKey } from './source-keys.mts'
import { rowCellsForRawJson } from './source-tables.mts'

import type { SourceCell, SourceColumn, SourceRow, SourceTable } from './source-tables.mts'

/**
 * Which column supplies which legacy summary field, and how that was decided.
 *
 * Resolved per table from that table's own headings. Column positions differ
 * between sheets — the actual section starts at F on some and G on others — so
 * nothing may be resolved by position.
 */
export interface SummaryColumns {
  totalFee: SourceColumn | null
  totalPaid: SourceColumn | null
  balance: SourceColumn | null
  /** One line per field explaining the choice, including the nulls. */
  evidence: string[]
}

/** The sections a batch table's own figures live in, for a table of either shape. */
const OWN_SECTIONS = new Set(['actual', 'flat'])

function single<T>(candidates: T[]): T | null {
  return candidates.length === 1 ? candidates[0] : null
}

/**
 * Finds the balance column when the workbook never gave it a heading.
 *
 * On most batch sheets the outstanding column exists but its header was never
 * typed. It is identified by what its formula does — Total Paid minus Total Fee
 * on the same row — and not by its position, so a sheet that lays its columns
 * out differently still resolves correctly, and a sheet where the formula is
 * something else resolves to nothing rather than to the wrong column.
 */
function findUnheadedBalanceColumn(
  table: SourceTable,
  totalPaid: SourceColumn | null,
  totalFee: SourceColumn | null,
): { column: SourceColumn | null; note: string } {
  if (totalPaid === null || totalFee === null) {
    return { column: null, note: 'no Total Paid/Total Fee pair to recognise a balance formula by' }
  }

  const shape = new RegExp(`^${totalPaid.letter}\\d+\\s*-\\s*${totalFee.letter}\\d+$`, 'i')

  const candidates = table.columns.filter((column) => {
    if (column.header !== null) return false
    if (!OWN_SECTIONS.has(column.section)) return false
    return table.rows.some((row) => {
      const formula = row.cellByColumn.get(column.column)?.formula
      return typeof formula === 'string' && shape.test(formula.trim())
    })
  })

  if (candidates.length === 0) {
    return { column: null, note: 'no unheaded column holds a Total Paid − Total Fee formula' }
  }
  if (candidates.length > 1) {
    return {
      column: null,
      note:
        `${candidates.length} unheaded columns hold a Total Paid − Total Fee formula ` +
        `(${candidates.map((column) => column.letter).join(', ')}); left unresolved rather than guessed`,
    }
  }

  return {
    column: candidates[0],
    note:
      `column ${candidates[0].letter} has no heading but holds ` +
      `${totalPaid.letter}n−${totalFee.letter}n, the sheet's own outstanding formula`,
  }
}

/**
 * Resolves the three legacy summary columns for one table.
 *
 * Every field that cannot be resolved unambiguously resolves to null with a
 * reason, rather than to the nearest plausible column.
 */
export function resolveSummaryColumns(table: SourceTable): SummaryColumns {
  const own = table.columns.filter((column) => OWN_SECTIONS.has(column.section))
  const evidence: string[] = []

  const feeCandidates = own.filter((column) => column.role === 'total_fee')
  const totalFee = single(feeCandidates)
  evidence.push(
    totalFee
      ? `legacy_total_fee from ${totalFee.letter} (${JSON.stringify(totalFee.header)})`
      : `legacy_total_fee unresolved: ${feeCandidates.length} candidate total-fee columns in this table's own section`,
  )

  const paidCandidates = own.filter((column) => column.role === 'total_paid')
  const totalPaid = single(paidCandidates)
  evidence.push(
    totalPaid
      ? `legacy_total_paid from ${totalPaid.letter} (${JSON.stringify(totalPaid.header)})`
      : `legacy_total_paid unresolved: ${paidCandidates.length} candidate total-paid columns`,
  )

  const headedBalance = own.filter(
    (column) => column.role === 'outstanding' || column.role === 'balance',
  )

  let balance = single(headedBalance)
  if (balance) {
    evidence.push(`legacy_balance from ${balance.letter} (${JSON.stringify(balance.header)})`)
  } else if (headedBalance.length > 1) {
    balance = null
    evidence.push(
      `legacy_balance unresolved: ${headedBalance.length} headed balance columns in this table`,
    )
  } else {
    const found = findUnheadedBalanceColumn(table, totalPaid, totalFee)
    balance = found.column
    evidence.push(
      found.column
        ? `legacy_balance from ${found.column.letter}: ${found.note}`
        : `legacy_balance unresolved: ${found.note}`,
    )
  }

  return { totalFee, totalPaid, balance, evidence }
}

/** A money figure copied from one cell, with the provenance that justifies it. */
export interface LegacyFigure {
  /** The numeric value, or null for a blank, a non-numeric or an error cell. */
  value: number | null
  sourceColumnLetter: string | null
  sourceHeader: string | null
  /** The stored value untouched, so a serial or a formula result stays visible. */
  rawValue: string | number | boolean | null
  formula: string | null
  /** Why the value is null, when it is. */
  note: string | null
}

/**
 * Reads one legacy figure from one cell.
 *
 * A blank gives null, not zero. An error cell gives null and says so, rather
 * than contributing a number the workbook never held.
 */
export function readLegacyFigure(
  row: SourceRow,
  column: SourceColumn | null,
): LegacyFigure {
  if (column === null) {
    return {
      value: null,
      sourceColumnLetter: null,
      sourceHeader: null,
      rawValue: null,
      formula: null,
      note: 'no source column resolved for this field in this table',
    }
  }

  const cell: SourceCell | undefined = row.cellByColumn.get(column.column)

  const base = {
    sourceColumnLetter: column.letter,
    sourceHeader: column.header,
    rawValue: cell?.rawValue ?? null,
    formula: cell?.formula ?? null,
  }

  if (!cell || cell.isBlank) {
    return { ...base, value: null, note: 'source cell is blank; stored as null, not zero' }
  }
  if (cell.isError) {
    return { ...base, value: null, note: `source cell holds ${cell.text ?? 'an error'}` }
  }
  if (cell.numeric === null) {
    return { ...base, value: null, note: 'source cell is not a plain number; left null' }
  }

  return { ...base, value: cell.numeric, note: null }
}

export interface PlannedFinanceRecord {
  sourceKey: string
  /** Source key of the planned student this record belongs to. */
  studentSourceKey: string
  studentNumber: string | null
  programShortCode: string
  /** Source key of the planned batch, or null for an unassigned record. */
  batchSourceKey: string | null
  legacyTotalFee: LegacyFigure
  legacyTotalPaid: LegacyFigure
  legacyBalance: LegacyFigure
  legacySourceSheet: string | null
  legacySourceRow: number | null
  legacyRawJson: Record<string, unknown>
  /** 'batch' or 'unassigned', for the counts the report has to give. */
  kind: 'batch' | 'unassigned'
}

export interface BatchFinanceRecordResult {
  records: PlannedFinanceRecord[]
  /** Rows excluded because they are a table's trailing totals line. */
  totalsRowsExcluded: { sheetName: string; row: number; tableKey: string }[]
  /** Rows in the span that were neither a student nor a totals line. */
  otherRowsExcluded: { sheetName: string; row: number; tableKey: string }[]
  /**
   * Student rows with no student number, which get an unresolved student and a
   * batch-specific record rather than a manufactured number.
   */
  rowsWithoutStudentNumber: {
    sheetName: string
    row: number
    tableKey: string
    reason: string
  }[]
  /** Rows that could not be resolved to any student at all. Never silent. */
  rowsWithNoResolvableStudent: {
    sheetName: string
    row: number
    tableKey: string
    reason: string
  }[]
  summaryColumnEvidence: string[]
}

/**
 * Plans the finance records for one batch table.
 *
 * `studentKeyFor` takes the whole row rather than a student number, because a
 * row that states no number still names a student and still gets a record. The
 * caller resolves a numbered row to its student and a number-less one to the
 * unresolved student planned for that exact source row — no number is
 * manufactured and no row is matched to another by name.
 */
export function planBatchFinanceRecords(
  workbookHash: string,
  table: SourceTable,
  programShortCode: string,
  batchSourceKey: string,
  studentKeyFor: (row: SourceRow) => string | null,
): BatchFinanceRecordResult {
  const columns = resolveSummaryColumns(table)

  const records: PlannedFinanceRecord[] = []
  const totalsRowsExcluded: BatchFinanceRecordResult['totalsRowsExcluded'] = []
  const otherRowsExcluded: BatchFinanceRecordResult['otherRowsExcluded'] = []
  const rowsWithoutStudentNumber: BatchFinanceRecordResult['rowsWithoutStudentNumber'] = []
  const rowsWithNoResolvableStudent: BatchFinanceRecordResult['rowsWithNoResolvableStudent'] = []

  for (const row of table.rows) {
    if (row.kind === 'totals') {
      totalsRowsExcluded.push({ sheetName: table.sheetName, row: row.row, tableKey: table.key })
      continue
    }
    if (row.kind === 'other') {
      otherRowsExcluded.push({ sheetName: table.sheetName, row: row.row, tableKey: table.key })
      continue
    }

    // A row that names a student but states no number still gets a record. It
    // hangs off an unresolved student keyed on this exact source row, so it is
    // never merged with another number-less row on the strength of its name,
    // and its finance snapshot is not thrown away.
    if (row.studentNumber === null) {
      rowsWithoutStudentNumber.push({
        sheetName: table.sheetName,
        row: row.row,
        tableKey: table.key,
        reason:
          row.studentNumberRejected ??
          'row names a student but states no student number; an unresolved student is planned for this exact row',
      })
    }

    const studentKey = studentKeyFor(row)
    if (studentKey === null) {
      rowsWithNoResolvableStudent.push({
        sheetName: table.sheetName,
        row: row.row,
        tableKey: table.key,
        reason:
          row.studentNumber === null
            ? 'no unresolved student was planned for this row'
            : 'student number is not in the planned student set',
      })
      continue
    }

    const sourceKey = financeRecordSourceKey(
      workbookHash,
      table.sheetName,
      row.row,
      table.key,
    )

    records.push({
      sourceKey,
      studentSourceKey: studentKey,
      studentNumber: row.studentNumber,
      programShortCode,
      batchSourceKey,
      legacyTotalFee: readLegacyFigure(row, columns.totalFee),
      legacyTotalPaid: readLegacyFigure(row, columns.totalPaid),
      legacyBalance: readLegacyFigure(row, columns.balance),
      legacySourceSheet: table.sheetName,
      legacySourceRow: row.row,
      legacyRawJson: {
        source_key: sourceKey,
        sheet: table.sheetName,
        block_title: table.title,
        table_key: table.key,
        session: table.session,
        row: row.row,
        program_source_label: table.kind === 'cohort_roster' ? 'ELCE' : 'PSW',
        cells: rowCellsForRawJson(table, row),
      },
      kind: 'batch',
    })
  }

  return {
    records,
    totalsRowsExcluded,
    otherRowsExcluded,
    rowsWithoutStudentNumber,
    rowsWithNoResolvableStudent,
    summaryColumnEvidence: columns.evidence,
  }
}

/**
 * A Tracker Master "Enrollment Total Fees" value considered for an unassigned
 * record, with the conflict rule applied.
 *
 * The workbook states this figure once, on a student's first transaction row,
 * and leaves it blank on the other 782. A blank is "not restated here", not
 * zero, and is never filled in from another row. Where two rows state values
 * that disagree, neither is chosen: the conflict is reported and the field
 * stays null.
 */
export function resolveUnassignedTotalFee(
  values: readonly { row: number; value: number }[],
): { value: number | null; note: string; conflicting: number[] } {
  if (values.length === 0) {
    return { value: null, note: 'no Tracker Master row states an Enrollment Total Fees value', conflicting: [] }
  }

  const distinct = [...new Set(values.map((entry) => entry.value))]

  if (distinct.length > 1) {
    return {
      value: null,
      conflicting: distinct,
      note:
        `Tracker Master states ${distinct.length} different Enrollment Total Fees values for this ` +
        'student and program; left null rather than choosing one',
    }
  }

  return {
    value: distinct[0],
    conflicting: [],
    note: `stated on Tracker Master row(s) ${values.map((entry) => entry.row).join(', ')}`,
  }
}

/**
 * Plans the unassigned record a payment falls back to.
 *
 * One per (student, canonical program), reused by every payment that could not
 * be tied to exactly one batch table. `batch_id` is null — deliberately, and
 * not as a placeholder to be filled in later by a guess.
 */
export function planUnassignedFinanceRecord(
  workbookHash: string,
  studentSourceKey: string,
  studentNumber: string | null,
  programShortCode: string,
  totalFee: { value: number | null; note: string; conflicting: number[] },
  reason: string,
): PlannedFinanceRecord {
  const sourceKey = unassignedFinanceRecordSourceKey(
    workbookHash,
    studentSourceKey,
    programShortCode,
  )

  const blank: LegacyFigure = {
    value: null,
    sourceColumnLetter: null,
    sourceHeader: null,
    rawValue: null,
    formula: null,
    note: 'not available on an unassigned record: no batch-sheet row supplies it',
  }

  return {
    sourceKey,
    studentSourceKey,
    studentNumber,
    programShortCode,
    batchSourceKey: null,
    legacyTotalFee: {
      value: totalFee.value,
      sourceColumnLetter: null,
      sourceHeader: 'Enrollment Total Fees',
      rawValue: totalFee.value,
      formula: null,
      note: totalFee.note,
    },
    legacyTotalPaid: blank,
    // Tracker Master's Balance Fees is a row-local formula, not a student
    // balance, and is deliberately not mapped here. It survives in each
    // payment's legacy_raw_json instead.
    legacyBalance: {
      ...blank,
      note: 'Tracker Master Balance Fees is a row-local formula and is never mapped to a finance-record balance',
    },
    legacySourceSheet: null,
    legacySourceRow: null,
    legacyRawJson: {
      source_key: sourceKey,
      unassigned_reason: reason,
      program_short_code: programShortCode,
      student_number: studentNumber,
      legacy_total_fee_note: totalFee.note,
      conflicting_total_fee_values: totalFee.conflicting,
    },
    kind: 'unassigned',
  }
}
