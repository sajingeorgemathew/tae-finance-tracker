/**
 * Financial conservation: does the target hold exactly what the source says?
 *
 * For every cohort the source totals are compared with the target, figure by
 * figure, and every difference is either explained by a named row class or
 * reported as an inconsistency. Nothing is "fixed" to make an equation pass:
 * a balance that disagrees with its own fee and payments stays as stated and
 * is counted here instead.
 *
 * Workbook cohorts are compared against the sheet's own totals row: for each
 * totalled column, the totals formula's row range is taken from the formula
 * itself, so a total that silently stops a row short (it happens) shows up as
 * rows outside the range rather than as a mystery.
 *
 * March is compared against the hosted rows it is preserved from.
 */

import { parseSimpleSumRange } from '../finance-import/lib/formulas.mts'

import { studentRows, type ParsedTable } from './parse.mts'
import { paymentColumnsOf, type TargetDataset } from './target.mts'

import type { BackupTable } from './config.mts'
import type { BackupRow } from './hosted.mts'

const round = (value: number): number => Math.round(value * 100) / 100
const sum = (values: readonly (number | null | undefined)[]): number => round(values.reduce<number>((total, value) => total + (typeof value === 'number' ? value : 0), 0))

export interface ColumnConservation {
  sheet: string
  tableKey: string
  letter: string
  header: string | null
  /** The figure the totals row states. */
  sheetTotal: number | null
  coversRows: { first: number; last: number } | null
  /** Sum of the column over student rows inside the totals formula's range. */
  studentRowsInRange: number
  /** Sum over placeholder seats inside the range (a template fee for an unfilled seat). */
  placeholderRowsInRange: number
  /** Sum over student rows the totals formula does not cover. */
  studentRowsOutsideRange: number
  /** sheetTotal − (studentRowsInRange + placeholderRowsInRange). Zero when the formula is a plain SUM. */
  unexplained: number
}

export interface CohortConservation {
  cohortId: string
  label: string
  source: 'workbook' | 'hosted'
  studentRecords: number
  namedRows: number
  numberedRows: number
  rowClasses: Record<string, number>
  statedFees: number
  statedFeeNulls: number
  statedTotalPaid: number
  statedBalance: number
  payments: number
  paymentAmount: number
  /** Sum of the money-received cells over student rows, which the payments must equal. */
  paymentCellsAmount: number | null
  /** The Total Paid figure(s) the sheet's own totals rows state, summed over the cohort's tables. */
  sheetTotalsRowTotalPaid: number | null
  /** Money-received columns that hold student values but have no figure on the totals row. */
  columnsMissingFromTotalsRow: { sheet: string; tableKey: string; letter: string; header: string | null; studentRowsAmount: number }[]
  installments: number
  installmentAmount: number
  columns: ColumnConservation[]
  inconsistencies: { code: string; count: number; detail: string }[]
  conserved: boolean
}

function columnConservation(table: ParsedTable): ColumnConservation[] {
  const byRow = new Map(table.rows.map((row) => [row.row, row]))
  return table.sourceTotals
    .filter((total) => total.value !== null && total.coversRows !== null)
    .map((total) => {
      const range = total.coversRows as { first: number; last: number }
      const column = table.table.columns.find((candidate) => candidate.letter === total.letter)
      const valueAt = (row: number): number => {
        const cell = byRow.get(row)?.source.cellByColumn.get(column?.column ?? -1)
        return cell?.numeric ?? 0
      }
      let inRange = 0
      let placeholders = 0
      let outside = 0
      for (const row of table.rows) {
        const value = valueAt(row.row)
        const within = row.row >= range.first && row.row <= range.last
        if (row.rowClass === 'student') {
          if (within) inRange += value
          else outside += value
        } else if (within && row.rowClass === 'placeholder_seat') {
          placeholders += value
        }
      }
      return {
        sheet: table.sheetName,
        tableKey: table.table.key,
        letter: total.letter,
        header: total.header,
        sheetTotal: total.value,
        coversRows: range,
        studentRowsInRange: round(inRange),
        placeholderRowsInRange: round(placeholders),
        studentRowsOutsideRange: round(outside),
        unexplained: round((total.value ?? 0) - inRange - placeholders),
      }
    })
}

export function conserveCohorts(input: {
  parsedTables: readonly ParsedTable[]
  target: TargetDataset
  hosted: Record<BackupTable, BackupRow[]>
}): CohortConservation[] {
  const { parsedTables, target, hosted } = input
  const out: CohortConservation[] = []

  const recordsById = new Map<string, Record<string, unknown>>()
  for (const row of hosted.student_finance_records) recordsById.set(row.id, row)
  for (const row of target.inserts.student_finance_records) recordsById.set(row.id, row)
  const paymentsByRecord = new Map<string, Record<string, unknown>[]>()
  const retainedPayments = new Set(target.retained.payments)
  for (const row of [...hosted.payments.filter((payment) => retainedPayments.has(payment.id)), ...target.inserts.payments]) {
    const key = String(row.student_finance_record_id)
    paymentsByRecord.set(key, [...(paymentsByRecord.get(key) ?? []), row])
  }
  const installmentsByRecord = new Map<string, Record<string, unknown>[]>()
  const retainedInstallments = new Set(target.retained.installments)
  for (const row of [...hosted.installments.filter((installment) => retainedInstallments.has(installment.id)), ...target.inserts.installments]) {
    const key = String(row.student_finance_record_id)
    installmentsByRecord.set(key, [...(installmentsByRecord.get(key) ?? []), row])
  }

  for (const cohort of target.cohorts) {
    const links = target.links.filter((link) => link.cohortId === cohort.id)
    const records = links.map((link) => recordsById.get(link.financeRecordId) as Record<string, unknown>)
    const payments = links.flatMap((link) => paymentsByRecord.get(link.financeRecordId) ?? [])
    const installments = links.flatMap((link) => installmentsByRecord.get(link.financeRecordId) ?? [])
    const tables = parsedTables.filter((table) => table.cohort?.id === cohort.id)
    const inconsistencies: CohortConservation['inconsistencies'] = []
    const note = (code: string, count: number, detail: string): void => {
      if (count > 0) inconsistencies.push({ code, count, detail })
    }

    const rowClasses: Record<string, number> = {}
    for (const table of tables) for (const row of table.rows) rowClasses[row.rowClass] = (rowClasses[row.rowClass] ?? 0) + 1

    let paymentCellsAmount: number | null = null
    let sheetTotalsRowTotalPaid: number | null = null
    const columnsMissingFromTotalsRow: CohortConservation['columnsMissingFromTotalsRow'] = []
    const columns: ColumnConservation[] = []
    if (cohort.source === 'workbook') {
      paymentCellsAmount = 0
      for (const table of tables) {
        const paymentColumns = paymentColumnsOf(table.table)
        for (const row of studentRows(table)) {
          for (const column of paymentColumns) {
            const cell = row.source.cellByColumn.get(column.column)
            if (cell?.numeric !== null && cell?.numeric !== undefined && cell.numeric > 0) paymentCellsAmount += cell.numeric
          }
        }
        columns.push(...columnConservation(table))
      }
      paymentCellsAmount = round(paymentCellsAmount)

      sheetTotalsRowTotalPaid = 0
      for (const table of tables) {
        const paidColumn = table.table.columns.find((column) => column.role === 'total_paid')
        const stated = table.sourceTotals.find((total) => total.letter === paidColumn?.letter)?.value
        sheetTotalsRowTotalPaid += stated ?? 0
        const totalled = new Set(table.sourceTotals.filter((total) => total.value !== null).map((total) => total.letter))
        for (const column of paymentColumnsOf(table.table)) {
          if (totalled.has(column.letter)) continue
          const amount = studentRows(table).reduce((total, row) => total + (row.source.cellByColumn.get(column.column)?.numeric ?? 0), 0)
          if (amount !== 0) {
            columnsMissingFromTotalsRow.push({ sheet: table.sheetName, tableKey: table.table.key, letter: column.letter, header: column.header, studentRowsAmount: round(amount) })
          }
        }
      }
      sheetTotalsRowTotalPaid = round(sheetTotalsRowTotalPaid)
      note(
        'TOTALS_ROW_MISSING_PAYMENT_COLUMN',
        columnsMissingFromTotalsRow.length,
        "a money-received column holds student payments but the totals row states no figure for it, so the sheet's grand Total Paid leaves that money out",
      )

      note('TOTALS_FORMULA_EXCLUDES_STUDENT_ROWS', columns.filter((column) => column.studentRowsOutsideRange !== 0).length, 'a totals-row SUM stops short of a student row that holds a value in that column')
      note('TOTALS_INCLUDE_PLACEHOLDER_SEATS', columns.filter((column) => column.placeholderRowsInRange !== 0).length, 'a totals-row SUM includes the template fee of an unfilled seat')
      note('TOTALS_UNEXPLAINED', columns.filter((column) => column.unexplained !== 0).length, 'a totals-row figure differs from the rows it covers')
      for (const table of tables) {
        const paidColumn = table.table.columns.find((column) => column.role === 'total_paid')
        const totalsPaidCell = table.sourceTotals.find((total) => total.letter === paidColumn?.letter)
        const paymentColumns = paymentColumnsOf(table.table)
        const range = totalsPaidCell?.formula ? parseSimpleSumRange(totalsPaidCell.formula) : null
        if (range !== null) {
          const outside = paymentColumns.filter((column) => column.column < range.firstColumn || column.column > range.lastColumn)
          note(
            'TOTAL_PAID_TOTAL_OMITS_PAYMENT_COLUMN',
            outside.length,
            `the totals-row Total Paid formula (${totalsPaidCell?.formula}) leaves out money-received column(s) ${outside.map((column) => column.letter).join(', ')}`,
          )
        }
      }
    }

    // Per record: the payments against the row's own Total Paid, and the fee against the schedule.
    let paymentsVsTotalPaid = 0
    let totalPaidMissing = 0
    let scheduleVsFee = 0
    let balanceVsFeeAndPaid = 0
    for (const link of links) {
      const record = recordsById.get(link.financeRecordId) as Record<string, unknown>
      const paid = sum((paymentsByRecord.get(link.financeRecordId) ?? []).filter((payment) => payment.voided_at === null || payment.voided_at === undefined).map((payment) => Number(payment.amount)))
      const statedPaid = record.legacy_total_paid === null ? null : Number(record.legacy_total_paid)
      if (statedPaid === null) totalPaidMissing += paid > 0 ? 1 : 0
      else if (round(statedPaid) !== paid) paymentsVsTotalPaid += 1
      const scheduled = installmentsByRecord.get(link.financeRecordId) ?? []
      const fee = record.legacy_total_fee === null ? null : Number(record.legacy_total_fee)
      if (scheduled.length > 0 && fee !== null && sum(scheduled.map((row) => Number(row.scheduled_amount))) !== round(fee)) scheduleVsFee += 1
      const balance = record.legacy_balance === null ? null : Number(record.legacy_balance)
      if (balance !== null && fee !== null && statedPaid !== null && round(statedPaid - fee) !== round(balance)) balanceVsFeeAndPaid += 1
    }
    note('PAYMENTS_DIFFER_FROM_STATED_TOTAL_PAID', paymentsVsTotalPaid, 'the payments on file do not add up to the row\'s stated Total Paid')
    note('PAYMENTS_WITHOUT_STATED_TOTAL_PAID', totalPaidMissing, 'the row has money in its payment cells but states no Total Paid')
    note('SCHEDULE_TOTAL_DIFFERS_FROM_FEE', scheduleVsFee, 'the installment schedule does not add up to the stated total fee (the schedule is a template, not individualised)')
    note('BALANCE_DIFFERS_FROM_PAID_MINUS_FEE', balanceVsFeeAndPaid, 'the stated balance is not Total Paid − Total Fee')

    const statedFees = sum(records.map((record) => (record.legacy_total_fee === null ? null : Number(record.legacy_total_fee))))
    const paymentAmount = sum(payments.map((payment) => Number(payment.amount)))

    const conserved =
      cohort.source === 'hosted'
        ? true
        : paymentCellsAmount === paymentAmount && columns.every((column) => column.unexplained === 0)

    out.push({
      cohortId: cohort.id,
      label: cohort.label,
      source: cohort.source,
      studentRecords: records.length,
      namedRows: links.filter((link) => link.named).length,
      numberedRows: links.filter((link) => link.studentNumber !== null).length,
      rowClasses,
      statedFees,
      statedFeeNulls: records.filter((record) => record.legacy_total_fee === null).length,
      statedTotalPaid: sum(records.map((record) => (record.legacy_total_paid === null ? null : Number(record.legacy_total_paid)))),
      statedBalance: sum(records.map((record) => (record.legacy_balance === null ? null : Number(record.legacy_balance)))),
      payments: payments.length,
      paymentAmount,
      paymentCellsAmount,
      sheetTotalsRowTotalPaid,
      columnsMissingFromTotalsRow,
      installments: installments.length,
      installmentAmount: sum(installments.map((row) => Number(row.scheduled_amount))),
      columns,
      inconsistencies,
      conserved,
    })
  }
  return out
}
