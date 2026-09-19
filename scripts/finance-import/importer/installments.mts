/**
 * Scheduled installments — the plan, never the money.
 *
 * Only the scheduled side of a table produces installments. On a PSW batch
 * sheet that is the INSTALLMENT FEE STRUCTURE section; the ACTUAL section
 * carries identically-named columns holding money that arrived, and those are
 * not installments and do not become payments here either (Tracker Master is
 * the payment source). Reading the same month name from both sides is how an
 * import doubles a student's money, so the two are never combined.
 *
 * Two further rules:
 *
 *  * **A blank schedule cell creates nothing.** It means no instalment was
 *    scheduled for that month, not an instalment of zero.
 *  * **No date is invented.** The month columns name a month and never a year,
 *    and a schedule that runs from October to February spans two of them. There
 *    is no safe year to write, so `installment_month` is left null and the
 *    month label is preserved instead. Deriving the year from the batch start
 *    date would look like fact once stored.
 */

import { installmentSourceKey } from './source-keys.mts'

import type { SourceColumn, SourceTable } from './source-tables.mts'

/** Canonical month names, indexed by month number, for the default note. */
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

export type InstallmentType = 'enrollment' | 'monthly' | 'other'

export interface PlannedInstallment {
  sourceKey: string
  /** Source key of the batch-specific finance record this belongs to. */
  financeRecordSourceKey: string
  installmentType: InstallmentType
  /** Always null: see the module comment on why no year is invented. */
  installmentMonth: null
  /** The month the heading names, kept as a number so the label is not lost. */
  monthNumber: number | null
  scheduledAmount: number | null
  /** `installments.default_note`. */
  defaultNote: string
  /** `installments.legacy_column_name` — the heading exactly as stored. */
  legacyColumnName: string
  /** `installments.legacy_value_text` — the cell as the workbook displays it. */
  legacyValueText: string | null
  sequenceNumber: number
  legacySourceSheet: string
  legacySourceRow: number
  /** Which section of the table the value came from. */
  section: string
  legacyRawJson: Record<string, unknown>
}

/** The note an installment column gets when nothing overrides it. */
export function defaultNoteFor(
  type: InstallmentType,
  header: string,
  monthNumber: number | null,
): string {
  if (type === 'enrollment') return 'Enrolment fee'
  if (type === 'monthly' && monthNumber !== null) {
    return `${MONTH_NAMES[monthNumber - 1]} installment`
  }

  // Ordinal headings such as "1st Installment" keep their ordinal and are
  // lower-cased into the house style rather than reworded.
  const ordinal = /^\s*(\d+(?:st|nd|rd|th))\s+installment\s*$/i.exec(header)
  if (ordinal) return `${ordinal[1].toLowerCase()} installment`

  return header.trim()
}

/** Columns that carry a scheduled figure, and the type each maps to. */
export interface ScheduleColumn {
  column: SourceColumn
  type: InstallmentType
  sequenceNumber: number
}

export interface ScheduleColumnResult {
  columns: ScheduleColumn[]
  /**
   * Columns inside the schedule that are deliberately not installments: the
   * section's own Total Fee, and the unheaded formula columns that reconcile
   * it. Reported so the exclusion is visible rather than silent.
   */
  excluded: { letter: string; header: string | null; reason: string }[]
}

/** Roles that carry money on a table with no schedule section of its own. */
const MONETARY_ROLES = new Set([
  'total_fee',
  'enrollment_fee',
  'installment_ordinal',
  'late_fees',
  'month',
  'total_paid',
  'balance',
  'outstanding',
])

/**
 * Picks the columns of a table that describe a scheduled plan.
 *
 * **A normalized installment requires an explicitly detected schedule section.**
 * On a PSW batch table that is the INSTALLMENT FEE STRUCTURE section, found by
 * the sheet's own banner or by its heading row opening a second table.
 *
 * A table with no such section produces no installments at all, however its
 * columns are named. The ELCE roster is exactly this case: its `1st Installment`
 * and `2nd Installment` columns sit *inside* the range that sheet's `Total Paid`
 * sums, which is the same evidence that marks the PSW ACTUAL section as money
 * received. A column called "Installment" is not a schedule; a schedule section
 * is. Those values are preserved in the finance record's `legacy_raw_json`
 * instead, and no payment is created from them either — Tracker Master remains
 * the transaction source.
 */
export function scheduleColumns(table: SourceTable): ScheduleColumnResult {
  if (!table.hasInstallmentSection) {
    return {
      columns: [],
      excluded: table.columns
        .filter((column) => column.header !== null && MONETARY_ROLES.has(column.role))
        .map((column) => ({
          letter: column.letter,
          header: column.header,
          reason:
            'this table has no explicitly detected INSTALLMENT FEE STRUCTURE section, so it ' +
            'produces no normalized installments; the value is preserved in the finance ' +
            "record's legacy_raw_json",
        })),
    }
  }

  const inSection = table.columns.filter((column) => column.section === 'installment')

  const columns: ScheduleColumn[] = []
  const excluded: ScheduleColumnResult['excluded'] = []
  let sequenceNumber = 0

  for (const column of inSection) {
    if (column.header === null) {
      excluded.push({
        letter: column.letter,
        header: null,
        reason: 'no heading; an unheaded schedule column is not treated as an instalment',
      })
      continue
    }

    switch (column.role) {
      case 'enrollment_fee':
        sequenceNumber += 1
        columns.push({ column, type: 'enrollment', sequenceNumber })
        break
      case 'month':
        sequenceNumber += 1
        columns.push({ column, type: 'monthly', sequenceNumber })
        break
      case 'installment_ordinal':
      case 'late_fees':
        sequenceNumber += 1
        columns.push({ column, type: 'other', sequenceNumber })
        break
      case 'total_fee':
        excluded.push({
          letter: column.letter,
          header: column.header,
          reason:
            'the total of the scheduled plan, not an instalment in it; ' +
            'creating one would double the plan',
        })
        break
      default:
        excluded.push({
          letter: column.letter,
          header: column.header,
          reason: `heading maps to role ${JSON.stringify(column.role)}, which is not a scheduled instalment`,
        })
        break
    }
  }

  return { columns, excluded }
}

export interface InstallmentPlanResult {
  installments: PlannedInstallment[]
  excludedColumns: ScheduleColumnResult['excluded']
  /** Schedule cells skipped because they hold a spreadsheet error. */
  errorCellsSkipped: { sheetName: string; row: number; letter: string; error: string }[]
  /** Blank schedule cells, counted so "no instalment created" is visible. */
  blankCellCount: number
}

/**
 * Plans the installments for one batch table.
 *
 * `financeRecordKeyFor` maps a source row to the batch-specific finance record
 * planned for it, and returns null for a row that produced none (a totals line,
 * or a row with no student number). An installment is never created without the
 * record it hangs off.
 */
export function planInstallments(
  workbookHash: string,
  table: SourceTable,
  financeRecordKeyFor: (row: number) => string | null,
): InstallmentPlanResult {
  const { columns, excluded } = scheduleColumns(table)

  // The only section that yields installments. A table without one returns no
  // columns above, so this label always describes a real detected section.
  const section = 'INSTALLMENT FEE STRUCTURE'

  const installments: PlannedInstallment[] = []
  const errorCellsSkipped: InstallmentPlanResult['errorCellsSkipped'] = []
  let blankCellCount = 0

  for (const row of table.rows) {
    if (row.kind !== 'student') continue

    const financeRecordKey = financeRecordKeyFor(row.row)
    if (financeRecordKey === null) continue

    for (const scheduled of columns) {
      const cell = row.cellByColumn.get(scheduled.column.column)

      if (!cell || cell.isBlank) {
        blankCellCount += 1
        continue
      }

      if (cell.isError) {
        errorCellsSkipped.push({
          sheetName: table.sheetName,
          row: row.row,
          letter: cell.letter,
          error: cell.text ?? String(cell.rawValue),
        })
        continue
      }

      const header = scheduled.column.header as string
      const sourceKey = installmentSourceKey(
        workbookHash,
        table.sheetName,
        row.row,
        cell.letter,
        section,
      )

      installments.push({
        sourceKey,
        financeRecordSourceKey: financeRecordKey,
        installmentType: scheduled.type,
        installmentMonth: null,
        monthNumber: scheduled.column.month,
        scheduledAmount: cell.numeric,
        defaultNote: defaultNoteFor(scheduled.type, header, scheduled.column.month),
        legacyColumnName: header,
        legacyValueText: cell.text ?? (cell.rawValue === null ? null : String(cell.rawValue)),
        sequenceNumber: scheduled.sequenceNumber,
        legacySourceSheet: table.sheetName,
        legacySourceRow: row.row,
        section,
        legacyRawJson: {
          source_key: sourceKey,
          sheet: table.sheetName,
          block_title: table.title,
          table_key: table.key,
          section,
          row: row.row,
          column: cell.letter,
          header,
          cell_type: cell.cellType,
          raw_value: cell.rawValue,
          formatted_text: cell.text,
          formula: cell.formula,
          installment_month_note:
            scheduled.type === 'monthly'
              ? 'month named by the heading; no year is stated by the workbook, so installment_month is null'
              : 'not a calendar month; installment_month is null by design',
        },
      })
    }
  }

  return { installments, excludedColumns: excluded, errorCellsSkipped, blankCellCount }
}
