/**
 * Tracker Master — the long list of individual payments.
 *
 * One row looks like one payment, and the analysis sets out to test that
 * rather than assume it. The two behaviours worth knowing before any import is
 * designed are:
 *
 *  * Enrollment Total Fees is filled on some rows and blank on others. If it
 *    is filled only on a student's first row, it is a per-student fee stated
 *    once, not a per-payment value — which changes where it belongs in the
 *    schema entirely.
 *  * Balance Fees is a formula, `Enrollment Total Fees - Amount Paid`, on the
 *    same row. Where the fee is blank the formula yields the negative of the
 *    payment. That is what the workbook says, and it is preserved as it is.
 *
 * Nothing here recalculates a balance, fills a missing fee from another row,
 * or removes a duplicate.
 */

import { interpretDateCell, isBlank, numericValue, rawText, readCell } from '../lib/excel-values.mts'
import { profileColumn, dateLikeness } from '../lib/profile.mts'
import { nameComparisonForm, studentIdPrefix, studentIdStorage, studentIdText } from '../lib/student-ids.mts'
import { roleForHeader } from '../lib/headers.mts'

import type { SheetBlock } from '../lib/blocks.mts'
import type { ColumnProfile } from '../lib/profile.mts'
import type { ColumnRole } from '../lib/headers.mts'
import type { WorkSheet } from 'xlsx'

export interface TrackerMasterRow {
  row: number
  studentId: string | null
  /** Name kept only in private output. */
  studentName: string | null
  nameForm: string | null
  amount: number | null
  amountBlank: boolean
  paidDateRaw: string | number | null
  paidDateISO: string | null
  paymentNumber: number | null
  program: string | null
  paymentMethod: string | null
  receiptSent: string | null
  enrollmentTotalFee: number | null
  balanceFee: number | null
  balanceFormula: string | null
  /** True when every cell in the row is blank. */
  empty: boolean
}

export interface DuplicateGroup {
  signature: string
  rows: number[]
}

export interface TrackerMasterAnalysis {
  sheetName: string
  headerRow: number | null
  firstDataRow: number | null
  lastDataRow: number | null
  /** Every heading, verbatim, in column order. */
  headers: { letter: string; original: string; normalized: string; role: ColumnRole }[]
  columnProfiles: ColumnProfile[]

  totalRowsInSpan: number
  emptyRowCount: number
  transactionRowCount: number

  distinctStudentIdCount: number
  rowsMissingStudentId: number
  rowsMissingStudentName: number
  rowsMissingPaidDate: number
  rowsMissingAmount: number
  rowsWithZeroAmount: number
  rowsWithNegativeAmount: number

  studentIdStorageCounts: Record<string, number>
  studentIdPrefixCounts: Record<string, number>
  studentIdLengthCounts: Record<string, number>

  paymentNumberDistribution: Record<string, number>
  paymentNumberRestartsPerStudent: boolean

  programValues: Record<string, number>
  paymentMethodValues: Record<string, number>
  receiptSentValues: Record<string, number>

  batchDateBehaviour: ReturnType<typeof dateLikeness> & { distinctSerials: number; isoRange: [string, string] | null }
  paidDateBehaviour: ReturnType<typeof dateLikeness> & { isoRange: [string, string] | null }

  enrollmentTotalFee: {
    filledRows: number
    blankRows: number
    studentsWithAnyValue: number
    /** Students whose fee appears on their first row only. */
    studentsWithValueOnFirstRowOnly: number
    /** Students where a value appears on a later row as well as, or instead of, the first. */
    studentsWithValueOnLaterRows: number
    /** Students whose fee value is not the same on every row that states one. */
    studentsWithDisagreeingValues: number
    verdict: string
  }

  balanceFees: {
    formulaRows: number
    literalRows: number
    blankRows: number
    negativeRows: number
    zeroRows: number
    distinctFormulaShapes: string[]
    /** Rows whose balance does not equal fee minus amount on that row. */
    rowsWhereBalanceIsNotFeeMinusAmount: number
    verdict: string
  }

  duplicates: {
    exactDuplicateRowGroups: number
    exactDuplicateRowCount: number
    /** Student number + amount + paid date + payment number, as the ticket specifies. */
    signatureDuplicateGroups: number
    signatureDuplicateRowCount: number
    /**
     * Student number + amount + paid date, without the payment number.
     *
     * Payment No increments per student, so including it makes the signature
     * very nearly a primary key and hides the candidates worth looking at.
     * This looser signature is the one that actually finds anything.
     */
    looseSignatureGroups: number
    looseSignatureRowCount: number
    largestLooseGroupSize: number
    /** Private output only. */
    exactGroups: DuplicateGroup[]
    signatureGroups: DuplicateGroup[]
    looseGroups: DuplicateGroup[]
  }

  /** Cases a human should look at. Counts here, detail in private output. */
  identityFindings: {
    sameIdDifferentNameCount: number
    sameNameDifferentIdCount: number
    sameIdDifferentName: { studentId: string; nameForms: number; rows: number[] }[]
    sameNameDifferentId: { nameForm: string; studentIds: string[]; rows: number[] }[]
  }
}

function tally(values: (string | null)[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) {
    const key = value === null ? '(blank)' : value
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export function analyzeTrackerMaster(
  sheetName: string,
  sheet: WorkSheet,
  block: SheetBlock,
  date1904: boolean,
): TrackerMasterAnalysis {
  // Columns are found by their exact heading rather than by role: Tracker
  // Master carries two remark columns that share one role, and both the fee and
  // the balance column would otherwise collide with headings elsewhere.
  const byNormalized = (normalized: string): number | null =>
    block.headers.find((header) => header.normalized === normalized)?.column ?? null

  const columns = {
    paymentNumber: byNormalized('payment no'),
    batch: byNormalized('batch'),
    studentId: byNormalized('student id'),
    studentName: byNormalized('student name'),
    amount: byNormalized('amount paid'),
    paidDate: byNormalized('paid date'),
    paymentMethod: byNormalized('mode of payment'),
    receiptSent: byNormalized('receipt sent'),
    enrollmentTotalFee: byNormalized('enrollment total fees'),
    program: byNormalized('program'),
    balance: byNormalized('balance fees'),
  }

  const first = block.firstDataRow ?? 0
  const last = block.lastDataRow ?? -1
  const allRows: number[] = []
  for (let row = first; row <= last; row += 1) allRows.push(row)

  const rows: TrackerMasterRow[] = allRows.map((row) => {
    const cellAt = (column: number | null) =>
      column === null ? null : readCell(sheet, row - 1, column)

    const idCell = cellAt(columns.studentId)
    const amountCell = cellAt(columns.amount)
    const paidDateCell = cellAt(columns.paidDate)
    const balanceCell = cellAt(columns.balance)
    const nameText = rawText(cellAt(columns.studentName))

    const paidDate = interpretDateCell(paidDateCell, date1904)

    const empty = block.headers.every((header) => isBlank(readCell(sheet, row - 1, header.column)))

    return {
      row,
      studentId: studentIdText(idCell),
      studentName: nameText,
      nameForm: nameText === null ? null : nameComparisonForm(nameText),
      amount: numericValue(amountCell),
      amountBlank: isBlank(amountCell),
      paidDateRaw: paidDate.raw,
      paidDateISO: paidDate.iso,
      paymentNumber: numericValue(cellAt(columns.paymentNumber)),
      program: rawText(cellAt(columns.program)),
      paymentMethod: rawText(cellAt(columns.paymentMethod)),
      receiptSent: rawText(cellAt(columns.receiptSent)),
      enrollmentTotalFee: numericValue(cellAt(columns.enrollmentTotalFee)),
      balanceFee: numericValue(balanceCell),
      balanceFormula: balanceCell?.formula ?? null,
      empty,
    }
  })

  const dataRows = rows.filter((row) => !row.empty)

  // --- Enrollment Total Fees: is it stated once per student? ------------------
  const byStudent = new Map<string, TrackerMasterRow[]>()
  for (const row of dataRows) {
    if (row.studentId === null) continue
    const existing = byStudent.get(row.studentId)
    if (existing) existing.push(row)
    else byStudent.set(row.studentId, [row])
  }

  let studentsWithAnyValue = 0
  let studentsWithValueOnFirstRowOnly = 0
  let studentsWithValueOnLaterRows = 0
  let studentsWithDisagreeingValues = 0

  for (const studentRows of byStudent.values()) {
    const ordered = [...studentRows].sort((a, b) => a.row - b.row)
    const withValue = ordered.filter((row) => row.enrollmentTotalFee !== null)
    if (withValue.length === 0) continue

    studentsWithAnyValue += 1

    const onlyFirst = withValue.length === 1 && withValue[0].row === ordered[0].row
    if (onlyFirst) studentsWithValueOnFirstRowOnly += 1
    else studentsWithValueOnLaterRows += 1

    const distinctValues = new Set(withValue.map((row) => row.enrollmentTotalFee))
    if (distinctValues.size > 1) studentsWithDisagreeingValues += 1
  }

  // --- Balance Fees behaviour ------------------------------------------------
  let balanceFormulaRows = 0
  let balanceLiteralRows = 0
  let balanceBlankRows = 0
  let balanceNegative = 0
  let balanceZero = 0
  let balanceNotFeeMinusAmount = 0
  const formulaShapes = new Set<string>()

  for (const row of dataRows) {
    if (row.balanceFormula !== null) {
      balanceFormulaRows += 1
      // Reduce A1 references to a shape so a column-wide pattern is visible.
      formulaShapes.add(row.balanceFormula.replace(/\d+/g, 'n'))
    } else if (row.balanceFee !== null) {
      balanceLiteralRows += 1
    } else {
      balanceBlankRows += 1
      continue
    }

    if (row.balanceFee !== null && row.balanceFee < 0) balanceNegative += 1
    if (row.balanceFee === 0) balanceZero += 1

    const fee = row.enrollmentTotalFee ?? 0
    const amount = row.amount ?? 0
    if (row.balanceFee !== null && Math.abs(row.balanceFee - (fee - amount)) > 0.005) {
      balanceNotFeeMinusAmount += 1
    }
  }

  // --- Duplicates ------------------------------------------------------------
  const exactKeyed = new Map<string, number[]>()
  const signatureKeyed = new Map<string, number[]>()
  const looseKeyed = new Map<string, number[]>()

  for (const row of dataRows) {
    const wholeRow = block.headers
      .map((header) => {
        const cell = readCell(sheet, row.row - 1, header.column)
        return `${cell?.type ?? 'z'}:${rawText(cell) ?? ''}`
      })
      .join('')

    const loose = [
      row.studentId ?? '',
      row.amount === null ? '' : String(row.amount),
      row.paidDateRaw === null ? '' : String(row.paidDateRaw),
    ].join('')

    const signature = `${loose}${row.paymentNumber === null ? '' : String(row.paymentNumber)}`

    exactKeyed.set(wholeRow, [...(exactKeyed.get(wholeRow) ?? []), row.row])
    signatureKeyed.set(signature, [...(signatureKeyed.get(signature) ?? []), row.row])

    // A row with no student number and no amount would collide with every other
    // such row, which says nothing. Only signatures with content are compared.
    if (row.studentId !== null && row.amount !== null) {
      looseKeyed.set(loose, [...(looseKeyed.get(loose) ?? []), row.row])
    }
  }

  const exactGroups: DuplicateGroup[] = [...exactKeyed.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([signature, group]) => ({ signature, rows: group }))

  const signatureGroups: DuplicateGroup[] = [...signatureKeyed.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([signature, group]) => ({ signature, rows: group }))

  const looseGroups: DuplicateGroup[] = [...looseKeyed.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([signature, group]) => ({ signature, rows: group }))

  // --- Identity findings -----------------------------------------------------
  const namesById = new Map<string, Map<string, number[]>>()
  const idsByName = new Map<string, Map<string, number[]>>()

  for (const row of dataRows) {
    if (row.studentId !== null && row.nameForm !== null) {
      const names = namesById.get(row.studentId) ?? new Map<string, number[]>()
      names.set(row.nameForm, [...(names.get(row.nameForm) ?? []), row.row])
      namesById.set(row.studentId, names)

      const ids = idsByName.get(row.nameForm) ?? new Map<string, number[]>()
      ids.set(row.studentId, [...(ids.get(row.studentId) ?? []), row.row])
      idsByName.set(row.nameForm, ids)
    }
  }

  const sameIdDifferentName = [...namesById.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([studentId, names]) => ({
      studentId,
      nameForms: names.size,
      rows: [...names.values()].flat().sort((a, b) => a - b),
    }))

  const sameNameDifferentId = [...idsByName.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([nameForm, ids]) => ({
      nameForm,
      studentIds: [...ids.keys()],
      rows: [...ids.values()].flat().sort((a, b) => a - b),
    }))

  // --- Payment numbering -----------------------------------------------------
  const paymentNumberDistribution = tally(
    dataRows.map((row) => (row.paymentNumber === null ? null : String(row.paymentNumber))),
  )

  const restarts = [...byStudent.values()].filter((studentRows) => {
    const numbers = studentRows
      .map((row) => row.paymentNumber)
      .filter((value): value is number => value !== null)
    return numbers.length > 0 && Math.min(...numbers) === 1
  }).length

  // --- Column profiles -------------------------------------------------------
  const columnProfiles = block.headers.map((header) =>
    profileColumn(sheet, header.column, allRows, header.original, date1904),
  )

  const batchProfile = columnProfiles.find((profile) => profile.column === columns.batch) ?? null
  const paidDateProfile = columnProfiles.find((profile) => profile.column === columns.paidDate) ?? null

  const isoRangeOf = (values: (string | null)[]): [string, string] | null => {
    const sorted = values.filter((value): value is string => value !== null).sort()
    return sorted.length === 0 ? null : [sorted[0], sorted[sorted.length - 1]]
  }

  const batchISOs = allRows.map(
    (row) => interpretDateCell(columns.batch === null ? null : readCell(sheet, row - 1, columns.batch), date1904).iso,
  )

  // Distinct *serials*, not distinct formatted text: a number format such as
  // "mmm yyyy" renders two different days identically, which would undercount.
  const distinctBatchSerials = new Set(
    allRows
      .map((row) => (columns.batch === null ? null : numericValue(readCell(sheet, row - 1, columns.batch))))
      .filter((value): value is number => value !== null),
  ).size

  const idTexts = dataRows.map((row) => row.studentId)

  return {
    sheetName,
    headerRow: block.headerRow,
    firstDataRow: block.firstDataRow,
    lastDataRow: block.lastDataRow,
    headers: block.headers.map((header) => ({
      letter: header.letter,
      original: header.original,
      normalized: header.normalized,
      role: roleForHeader(header.original),
    })),
    columnProfiles,

    totalRowsInSpan: allRows.length,
    emptyRowCount: rows.length - dataRows.length,
    transactionRowCount: dataRows.length,

    distinctStudentIdCount: new Set(idTexts.filter((id): id is string => id !== null)).size,
    rowsMissingStudentId: dataRows.filter((row) => row.studentId === null).length,
    rowsMissingStudentName: dataRows.filter((row) => row.studentName === null).length,
    rowsMissingPaidDate: dataRows.filter((row) => row.paidDateRaw === null).length,
    rowsMissingAmount: dataRows.filter((row) => row.amountBlank).length,
    rowsWithZeroAmount: dataRows.filter((row) => row.amount === 0).length,
    rowsWithNegativeAmount: dataRows.filter((row) => row.amount !== null && row.amount < 0).length,

    studentIdStorageCounts: tally(
      allRows.map((row) =>
        studentIdStorage(columns.studentId === null ? null : readCell(sheet, row - 1, columns.studentId)),
      ),
    ),
    studentIdPrefixCounts: tally(idTexts.map((id) => studentIdPrefix(id))),
    studentIdLengthCounts: tally(idTexts.map((id) => (id === null ? null : String(id.length)))),

    paymentNumberDistribution,
    paymentNumberRestartsPerStudent: restarts > byStudent.size / 2,

    programValues: tally(dataRows.map((row) => row.program)),
    paymentMethodValues: tally(dataRows.map((row) => row.paymentMethod)),
    receiptSentValues: tally(dataRows.map((row) => row.receiptSent)),

    batchDateBehaviour: {
      ...(batchProfile
        ? dateLikeness(batchProfile)
        : { serialLikeRatio: 0, verdict: 'not-dates' as const }),
      distinctSerials: distinctBatchSerials,
      isoRange: isoRangeOf(batchISOs),
    },
    paidDateBehaviour: {
      ...(paidDateProfile
        ? dateLikeness(paidDateProfile)
        : { serialLikeRatio: 0, verdict: 'not-dates' as const }),
      isoRange: isoRangeOf(dataRows.map((row) => row.paidDateISO)),
    },

    enrollmentTotalFee: {
      filledRows: dataRows.filter((row) => row.enrollmentTotalFee !== null).length,
      blankRows: dataRows.filter((row) => row.enrollmentTotalFee === null).length,
      studentsWithAnyValue,
      studentsWithValueOnFirstRowOnly,
      studentsWithValueOnLaterRows,
      studentsWithDisagreeingValues,
      verdict:
        studentsWithAnyValue === 0
          ? 'no values present'
          : studentsWithValueOnFirstRowOnly / studentsWithAnyValue >= 0.9
            ? 'stated once, on the student’s first transaction row'
            : 'stated on more than one row for a significant number of students',
    },

    balanceFees: {
      formulaRows: balanceFormulaRows,
      literalRows: balanceLiteralRows,
      blankRows: balanceBlankRows,
      negativeRows: balanceNegative,
      zeroRows: balanceZero,
      distinctFormulaShapes: [...formulaShapes],
      rowsWhereBalanceIsNotFeeMinusAmount: balanceNotFeeMinusAmount,
      verdict:
        formulaShapes.size === 1
          ? 'a single row-local formula shape across the column'
          : `${formulaShapes.size} distinct formula shapes`,
    },

    duplicates: {
      exactDuplicateRowGroups: exactGroups.length,
      exactDuplicateRowCount: exactGroups.reduce((sum, group) => sum + group.rows.length, 0),
      signatureDuplicateGroups: signatureGroups.length,
      signatureDuplicateRowCount: signatureGroups.reduce((sum, group) => sum + group.rows.length, 0),
      looseSignatureGroups: looseGroups.length,
      looseSignatureRowCount: looseGroups.reduce((sum, group) => sum + group.rows.length, 0),
      largestLooseGroupSize: looseGroups.reduce((max, group) => Math.max(max, group.rows.length), 0),
      exactGroups,
      signatureGroups,
      looseGroups,
    },

    identityFindings: {
      sameIdDifferentNameCount: sameIdDifferentName.length,
      sameNameDifferentIdCount: sameNameDifferentId.length,
      sameIdDifferentName,
      sameNameDifferentId,
    },
  }
}
