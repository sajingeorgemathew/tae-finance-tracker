/**
 * Reconciling the dated hosted payments the cutover would remove from a
 * student who stays in the target.
 *
 * The historical import took payments from Tracker Master (dated
 * transactions); the replacement workbook states money only as ACTUAL cells.
 * When a target student's old dated payment is deleted with its old record,
 * one question decides what happens to it: is that money already in the
 * target, or is it money the target would lose?
 *
 * Classes:
 *
 *  * REPRESENTED_IN_NEW_WORKBOOK — the money is already in the student's
 *    target record; keeping the hosted row would count it twice.
 *  * NOT_REPRESENTED_IN_NEW_WORKBOOK — money toward the target enrollment
 *    that its record does not hold; it must survive the cutover.
 *  * PRIOR_ENROLLMENT_NOT_TARGET_MONEY — money of an earlier enrollment of the
 *    same student, in a cohort the cutover retires. It is neither in the new
 *    workbook nor owed to or paid toward the target enrollment, so attaching
 *    it to the target record would misstate that record; it leaves with its
 *    cohort, like every other historical cohort's payment, and stays in the
 *    backup.
 *  * AMBIGUOUS — none of the above can be shown. Blocks the cutover.
 *
 * Which enrollment a payment belongs to is decided from exact evidence only,
 * in this order: the historical import's own routing to a single batch table;
 * the Tracker Master batch cell (a month) against each enrollment's cohort
 * month; a student with exactly one enrollment. Within the enrollment, the
 * payment is represented when the ACTUAL cell at its position in the
 * student's payment order (Tracker Master `Payment No`, cells in column
 * order) holds that amount, or holds at least that amount while the
 * student's payments to that enrollment all fit inside the record's ACTUAL
 * total. A prior-enrollment payment counts as represented only through the
 * net-fee identity: the student's stated total fee minus the target record's
 * fee equals exactly what was paid to the prior enrollment. Two amounts that
 * merely happen to be equal never decide anything on their own.
 */

import { serialToISODate } from '../finance-import/lib/excel-values.mts'

import { cohortMonthOf } from './parse.mts'

import { TARGET_COHORTS, type BackupTable } from './config.mts'
import type { BackupRow } from './hosted.mts'
import type { TargetDataset, TargetRecordLink } from './target.mts'

export type DatedPaymentClass =
  | 'REPRESENTED_IN_NEW_WORKBOOK'
  | 'NOT_REPRESENTED_IN_NEW_WORKBOOK'
  | 'PRIOR_ENROLLMENT_NOT_TARGET_MONEY'
  | 'AMBIGUOUS'

export interface DatedPaymentReconciliation {
  paymentId: string
  studentId: string
  studentNumber: string | null
  targetFinanceRecordId: string
  targetCohortId: string
  amount: number
  paymentDate: string | null
  paymentMethod: string | null
  paymentNo: string | null
  batchHint: string | null
  legacySourceSheet: string | null
  legacySourceRow: number | null
  routing: string | null
  hostedRecordId: string
  hostedRecordBatch: string | null
  class: DatedPaymentClass
  /** The enrollment the money belongs to: the target record, or the prior record's batch name. */
  enrollment: string
  evidence: string[]
  /** True only for NOT_REPRESENTED_IN_NEW_WORKBOOK. */
  preserve: boolean
  /** Section 5 of the brief: whether a later, explicit decision could give it a historical receipt. */
  historicalReceiptCapable: boolean
}

const round = (value: number): number => Math.round(value * 100) / 100

interface Enrollment {
  key: string
  label: string
  /** `YYYY-MM` of the cohort, null for a roster with no month. */
  yearMonth: string | null
  sheet: string | null
  /** The target record this enrollment is, or null for a retired one. */
  link: TargetRecordLink | null
  hostedRecordIds: string[]
}

function batchHintMonth(raw: Record<string, unknown> | null): string | null {
  const batch = raw?.batch as { raw_value?: unknown } | undefined
  if (typeof batch?.raw_value !== 'number') return null
  return serialToISODate(batch.raw_value)?.slice(0, 7) ?? null
}

/** ACTUAL / flat money cells of a target record, in column order. */
function moneyCells(record: Record<string, unknown>): { letter: string; header: string; amount: number }[] {
  const cells = ((record.legacy_raw_json as { cells?: Record<string, Record<string, unknown>> } | null)?.cells ?? {}) as Record<string, Record<string, unknown>>
  return Object.entries(cells)
    .filter(([, cell]) => typeof cell.raw_value === 'number' && cell.formula === null && (cell.section === 'actual' || cell.section === 'flat'))
    .map(([letter, cell]) => ({ letter, header: String(cell.header ?? '').trim(), amount: cell.raw_value as number }))
    .filter((cell) => !/total|balance|^sr|student|yyyy/i.test(cell.header))
    .sort((a, b) => a.letter.length - b.letter.length || a.letter.localeCompare(b.letter))
}

export function reconcileDatedPayments(input: {
  target: TargetDataset
  hosted: Record<BackupTable, BackupRow[]>
  deletedPaymentIds: readonly string[]
  /** Short codes whose receipt numbering is configured. */
  receiptNumbered: ReadonlySet<string>
}): DatedPaymentReconciliation[] {
  const { target, hosted } = input
  const deleted = new Set(input.deletedPaymentIds)
  const recordById = new Map(hosted.student_finance_records.map((row) => [row.id, row]))
  const batchById = new Map(hosted.batches.map((row) => [row.id, row]))
  const studentById = new Map(hosted.students.map((row) => [row.id, row]))
  const insertedRecordById = new Map(target.inserts.student_finance_records.map((row) => [row.id, row]))
  const linksByStudent = new Map<string, TargetRecordLink[]>()
  for (const link of target.links) linksByStudent.set(link.studentId, [...(linksByStudent.get(link.studentId) ?? []), link])
  const paymentsByRecord = new Map<string, BackupRow[]>()
  for (const payment of hosted.payments) {
    const key = String(payment.student_finance_record_id)
    paymentsByRecord.set(key, [...(paymentsByRecord.get(key) ?? []), payment])
  }

  const out: DatedPaymentReconciliation[] = []
  for (const payment of hosted.payments) {
    if (!deleted.has(payment.id)) continue
    const hostedRecord = recordById.get(String(payment.student_finance_record_id)) as BackupRow
    const studentId = String(hostedRecord.student_id)
    const links = linksByStudent.get(studentId) ?? []
    if (links.length === 0) continue
    const raw = (payment.legacy_raw_json ?? null) as Record<string, unknown> | null
    const evidence: string[] = []
    const base = {
      paymentId: payment.id,
      studentId,
      studentNumber: (studentById.get(studentId)?.student_number as string | null) ?? null,
      targetFinanceRecordId: links[0].financeRecordId,
      targetCohortId: links[0].cohortId,
      amount: Number(payment.amount),
      paymentDate: (payment.payment_date as string | null) ?? null,
      paymentMethod: (payment.payment_method as string | null) ?? null,
      paymentNo: raw?.payment_no === undefined || raw?.payment_no === null ? null : String(raw.payment_no),
      batchHint: ((raw?.batch as { formatted_text?: string } | undefined)?.formatted_text as string | undefined) ?? null,
      legacySourceSheet: (payment.legacy_source_sheet as string | null) ?? null,
      legacySourceRow: (payment.legacy_source_row as number | null) ?? null,
      routing: ((raw?.routing as { outcome?: string } | undefined)?.outcome as string | undefined) ?? null,
      hostedRecordId: hostedRecord.id,
      hostedRecordBatch: hostedRecord.batch_id === null ? null : String(batchById.get(String(hostedRecord.batch_id))?.name ?? ''),
    }
    const finish = (klass: DatedPaymentClass, enrollment: string): void => {
      const program = links[0].programShortCode
      out.push({
        ...base,
        class: klass,
        enrollment,
        evidence,
        preserve: klass === 'NOT_REPRESENTED_IN_NEW_WORKBOOK',
        historicalReceiptCapable:
          klass === 'NOT_REPRESENTED_IN_NEW_WORKBOOK' && base.studentNumber !== null && base.amount > 0 && base.paymentDate !== null && input.receiptNumbered.has(program),
      })
    }

    // --- The student's enrollments: each target record, then each retired batch record --
    const enrollments: Enrollment[] = links.map((link) => ({
      key: link.financeRecordId,
      label: `target ${link.cohortId}`,
      yearMonth: TARGET_COHORTS.find((cohort) => cohort.id === link.cohortId)?.yearMonth ?? null,
      sheet: link.sheet,
      link,
      hostedRecordIds: [],
    }))
    for (const record of hosted.student_finance_records) {
      if (String(record.student_id) !== studentId || record.batch_id === null) continue
      const batch = batchById.get(String(record.batch_id)) as BackupRow
      const sheet = (batch.legacy_sheet_name as string | null) ?? null
      const sameSheet = enrollments.find((enrollment) => enrollment.link !== null && sheet !== null && enrollment.sheet === sheet)
      if (sameSheet) {
        sameSheet.hostedRecordIds.push(record.id)
        continue
      }
      enrollments.push({
        key: record.id,
        label: String(batch.name),
        yearMonth: cohortMonthOf(sheet ?? String(batch.name), String(batch.name)).yearMonth,
        sheet,
        link: null,
        hostedRecordIds: [record.id],
      })
    }

    let owner: Enrollment | null = null
    const hint = batchHintMonth(raw)
    if (base.routing === 'unique_batch' && hostedRecord.batch_id !== null) {
      owner = enrollments.find((enrollment) => enrollment.hostedRecordIds.includes(hostedRecord.id)) ?? null
      if (owner) evidence.push(`the historical import routed it to exactly one batch table (${base.hostedRecordBatch}), the ${owner.link !== null ? "target record's own sheet" : 'prior enrollment'}`)
    }
    if (owner === null && hint !== null) {
      const byMonth = enrollments.filter((enrollment) => enrollment.yearMonth === hint)
      if (byMonth.length === 1) {
        owner = byMonth[0]
        evidence.push(`its Tracker Master batch cell (${base.batchHint}) names ${hint}, the month of ${owner.label}`)
      }
    }
    if (owner === null && enrollments.length === 1) {
      owner = enrollments[0]
      evidence.push('the student has exactly one enrollment (hosted and target), so the money can only belong to it')
    }
    if (owner === null) {
      evidence.push(`no exact evidence ties it to one of the student's ${enrollments.length} enrollments`)
      finish('AMBIGUOUS', 'unknown')
      continue
    }

    // --- Payments of the student to that same enrollment, in payment order --
    const studentPayments = hosted.student_finance_records
      .filter((record) => String(record.student_id) === studentId)
      .flatMap((record) => paymentsByRecord.get(record.id) ?? [])
    const belongsToOwner = (candidate: BackupRow): boolean => {
      const candidateRaw = (candidate.legacy_raw_json ?? null) as Record<string, unknown> | null
      const candidateRecord = recordById.get(String(candidate.student_finance_record_id)) as BackupRow
      const routedHere = (candidateRaw?.routing as { outcome?: string } | undefined)?.outcome === 'unique_batch' && owner?.hostedRecordIds.includes(candidateRecord.id)
      const hinted = batchHintMonth(candidateRaw)
      if (routedHere) return true
      if (hinted !== null && enrollments.filter((enrollment) => enrollment.yearMonth === hinted).length === 1) return enrollments.find((enrollment) => enrollment.yearMonth === hinted) === owner
      return enrollments.length === 1
    }
    const ownerPayments = studentPayments.filter(belongsToOwner)
    const ownerTotal = round(ownerPayments.reduce((total, row) => total + Number(row.amount), 0))

    if (owner.link === null) {
      // Money of an earlier enrollment. Represented only through the net-fee identity.
      const statedTotalFees = hosted.student_finance_records
        .filter((record) => String(record.student_id) === studentId && record.batch_id === null && record.legacy_total_fee !== null)
        .map((record) => Number(record.legacy_total_fee))
      // The identity must single out exactly one of the student's target records.
      const netFeeLinks =
        statedTotalFees.length !== 1
          ? []
          : links.filter((candidate) => {
              const fee = insertedRecordById.get(candidate.financeRecordId)?.legacy_total_fee
              return fee !== null && fee !== undefined && round(statedTotalFees[0] - Number(fee)) === ownerTotal
            })
      if (netFeeLinks.length === 1) {
        const netLink = netFeeLinks[0]
        base.targetFinanceRecordId = netLink.financeRecordId
        base.targetCohortId = netLink.cohortId
        const targetFee = Number(insertedRecordById.get(netLink.financeRecordId)?.legacy_total_fee)
        evidence.push(
          `the student's stated total fee (${statedTotalFees[0]}) minus the ${netLink.cohortId} record's fee (${targetFee}) equals exactly the ${ownerTotal} paid to ${owner.label}: ` +
            'the target fee is already net of it, so keeping the row would count it twice',
        )
        finish('REPRESENTED_IN_NEW_WORKBOOK', owner.label)
      } else {
        const priorPaid = owner.hostedRecordIds.map((id) => recordById.get(id)?.legacy_total_paid).find((value) => value !== null && value !== undefined)
        evidence.push(
          `it is money of ${owner.label}, an enrollment the cutover retires; the student paid ${ownerTotal} to it` +
            (priorPaid === undefined ? '' : ` (that record states Total Paid ${priorPaid})`) +
            `; it is not paid toward the student's target enrollment, whose record is self-contained`,
        )
        finish('PRIOR_ENROLLMENT_NOT_TARGET_MONEY', owner.label)
      }
      continue
    }

    // --- Money of a target enrollment: is it in that target record's cells? --
    const link = owner.link
    base.targetFinanceRecordId = link.financeRecordId
    base.targetCohortId = link.cohortId
    const targetRecord = insertedRecordById.get(link.financeRecordId)
    if (!targetRecord) {
      evidence.push('the owning target record is a retained hosted record, not a workbook record')
      finish('AMBIGUOUS', `target ${link.cohortId}`)
      continue
    }
    const cells = moneyCells(targetRecord)
    const cellTotal = round(cells.reduce((total, cell) => total + cell.amount, 0))
    const position = base.paymentNo === null ? null : Number(base.paymentNo)
    const cell = position !== null && Number.isInteger(position) && position >= 1 ? cells[position - 1] : undefined
    if (cell !== undefined && round(cell.amount) === round(base.amount)) {
      evidence.push(`payment no ${base.paymentNo} of this enrollment and money cell #${position} of the target record (${cell.header}) both hold ${base.amount}`)
      finish('REPRESENTED_IN_NEW_WORKBOOK', `target ${link.cohortId}`)
      continue
    }
    if (cell !== undefined && cell.amount >= base.amount && ownerTotal <= cellTotal) {
      evidence.push(
        `payment no ${base.paymentNo} (${base.amount}) fits in money cell #${position} of the target record (${cell.header} ${cell.amount}), ` +
          `and the student's payments to this enrollment (${ownerTotal}) fit in the record's ACTUAL total (${cellTotal})`,
      )
      finish('REPRESENTED_IN_NEW_WORKBOOK', `target ${link.cohortId}`)
      continue
    }
    if (ownerTotal > cellTotal) {
      evidence.push(`the student's payments to this enrollment (${ownerTotal}) exceed the target record's ACTUAL total (${cellTotal}); the record does not hold this money`)
      finish('NOT_REPRESENTED_IN_NEW_WORKBOOK', `target ${link.cohortId}`)
      continue
    }
    evidence.push('the payment fits the record\'s total but matches no cell at its position')
    finish('AMBIGUOUS', `target ${link.cohortId}`)
  }
  return out.sort((a, b) => a.paymentId.localeCompare(b.paymentId))
}
