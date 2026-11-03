/**
 * Collection and receipt readiness after the cutover — analysis only; nothing
 * is sent and no receipt is created.
 *
 * Every finance record is read under its cohort's approved collection mode
 * (`config.mts`):
 *
 *  * **installment** (PSW April–September). The amount due is
 *    the *cumulative scheduled amount through the current calendar month*
 *    minus the paid amount that the schedule covers. No due day is
 *    inferred: "scheduled through October 2026", never "due 1 October". The
 *    year of each named month is inferred only from the batch start date and
 *    the chronological order of the schedule columns, and only where that is
 *    deterministic; the mapping is validated column by column and a batch
 *    whose mapping is not deterministic is CANNOT_DETERMINE. Remaining
 *    tuition is never "due".
 *  * **legacy_balance** (PSW March). The old payment rows are an
 *    incomplete ledger and are not used to compute what was paid. The basis
 *    is the preserved balance snapshot (`legacy_balance`, Total Paid − Total
 *    Fee on the sheet), so a reminder is account/balance worded.
 *  * **balance** (ECEA). Stated fee minus recorded payments;
 *    no installment dates are manufactured.
 *  * **configuration_incomplete** (French). Blocked/manual: no
 *    automatic reminder, no receipt.
 *
 * Receipts: every payment the cutover carries is historical — the workbook's
 * undated cell payments and March's incomplete ledger alike — and none is
 * eligible for retroactive receipt generation. The rule for *new* payments is
 * stated as a function so the next ticket can adopt it.
 */

import { TARGET_COHORTS, type BackupTable, type CollectionMode } from './config.mts'

import type { ContactAssessment } from './contacts.mts'
import type { BackupRow } from './hosted.mts'
import type { TargetDataset } from './target.mts'

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

const round = (value: number): number => Math.round(value * 100) / 100

export function monthNumberOf(label: string | null): number | null {
  if (label === null) return null
  const lower = label.trim().toLowerCase().replace(/\.$/, '')
  const index = MONTHS.findIndex((month) => lower === month || (lower.length >= 3 && month.startsWith(lower)))
  return index === -1 ? null : index + 1
}

function yearMonthOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

function monthsBetween(from: string, to: string): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7))
}

export interface MonthMapping {
  /** `YYYY-MM` per monthly column, in schedule order; null when not deterministic. */
  months: string[] | null
  deterministic: boolean
  reasons: string[]
}

/**
 * Places each named month of a schedule in a year, from the batch start month
 * and the column order alone.
 *
 * The first month is the first occurrence on or after the start month; each
 * later month is the next occurrence after the one before it. That is only
 * deterministic when every heading names a month, no month repeats back to
 * back (which would mean a twelve-month jump nobody wrote down), and the
 * whole schedule ends within twelve months of the start.
 */
export function mapScheduleMonths(startYearMonth: string | null, monthNumbers: readonly (number | null)[]): MonthMapping {
  const reasons: string[] = []
  if (startYearMonth === null) return { months: null, deterministic: false, reasons: ['the batch has no start date'] }
  if (monthNumbers.some((month) => month === null)) return { months: null, deterministic: false, reasons: ['a schedule column does not name a month'] }

  const startYear = Number(startYearMonth.slice(0, 4))
  const startMonth = Number(startYearMonth.slice(5, 7))
  const months: string[] = []
  let year = startYear
  let previous: number | null = null
  for (const month of monthNumbers as number[]) {
    if (previous === null) {
      if (month < startMonth) year += 1
    } else if (month === previous) {
      reasons.push(`month ${month} repeats back to back; the year between them is not stated`)
    } else if (month < previous) {
      year += 1
    }
    months.push(yearMonthOf(year, month))
    previous = month
  }
  const last = months[months.length - 1]
  if (last !== undefined && monthsBetween(startYearMonth, last) > 12) {
    reasons.push(`the schedule ends ${monthsBetween(startYearMonth, last)} months after the start; another year boundary cannot be ruled out`)
  }
  return reasons.length === 0 ? { months, deterministic: true, reasons } : { months: null, deterministic: false, reasons }
}

export interface ScheduleColumnMapping {
  sequence: number
  type: string
  header: string
  /** `YYYY-MM`; the enrolment item maps to the start month. Null when the batch is not deterministic. */
  yearMonth: string | null
}

export interface BatchScheduleMapping {
  batchId: string
  batchName: string
  cohortId: string
  startDate: string | null
  columns: ScheduleColumnMapping[]
  deterministic: boolean
  reasons: string[]
}

interface Context {
  records: Map<string, Record<string, unknown>>
  batches: Map<string, Record<string, unknown>>
  installmentsByRecord: Map<string, Record<string, unknown>[]>
  paymentsByRecord: Map<string, Record<string, unknown>[]>
  programsByCode: Map<string, Record<string, unknown>>
  students: Map<string, Record<string, unknown>>
}

function contextOf(target: TargetDataset, hosted: Record<BackupTable, BackupRow[]>): Context {
  const records = new Map<string, Record<string, unknown>>()
  for (const row of hosted.student_finance_records) records.set(row.id, row)
  for (const row of target.inserts.student_finance_records) records.set(row.id, row)
  const batches = new Map<string, Record<string, unknown>>()
  for (const row of hosted.batches) batches.set(row.id, row)
  for (const row of target.inserts.batches) batches.set(row.id, row)
  const group = (rows: readonly Record<string, unknown>[]): Map<string, Record<string, unknown>[]> => {
    const out = new Map<string, Record<string, unknown>[]>()
    for (const row of rows) {
      const key = String(row.student_finance_record_id)
      out.set(key, [...(out.get(key) ?? []), row])
    }
    return out
  }
  const retainedInstallments = new Set(target.retained.installments)
  const retainedPayments = new Set(target.retained.payments)
  const programsByCode = new Map<string, Record<string, unknown>>()
  for (const row of [...hosted.programs, ...target.inserts.programs]) programsByCode.set(String(row.short_code), row)
  const students = new Map<string, Record<string, unknown>>()
  for (const row of [...hosted.students, ...target.inserts.students]) students.set(row.id, row)
  return {
    records,
    batches,
    installmentsByRecord: group([...hosted.installments.filter((row) => retainedInstallments.has(row.id)), ...target.inserts.installments]),
    paymentsByRecord: group([...hosted.payments.filter((row) => retainedPayments.has(row.id)), ...target.inserts.payments]),
    programsByCode,
    students,
  }
}

/** The schedule-column → month mapping of every `installment` batch, validated. */
export function mapBatchSchedules(target: TargetDataset, hosted: Record<BackupTable, BackupRow[]>): BatchScheduleMapping[] {
  const context = contextOf(target, hosted)
  const out: BatchScheduleMapping[] = []
  for (const cohort of target.cohorts) {
    const declared = TARGET_COHORTS.find((entry) => entry.id === cohort.id)
    if (declared?.collectionMode !== 'installment') continue
    for (const batchId of cohort.batchIds) {
      const batch = context.batches.get(batchId) as Record<string, unknown>
      const startDate = (batch.start_date as string | null) ?? null
      const reasons: string[] = []
      const bySequence = new Map<number, Set<string>>()
      for (const link of target.links.filter((entry) => entry.batchId === batchId)) {
        for (const row of context.installmentsByRecord.get(link.financeRecordId) ?? []) {
          const key = Number(row.sequence_number)
          bySequence.set(key, (bySequence.get(key) ?? new Set()).add(`${row.installment_type}\u0000${row.legacy_column_name}`))
        }
      }
      const sequences = [...bySequence.keys()].sort((a, b) => a - b)
      const columns: ScheduleColumnMapping[] = sequences.map((sequence) => {
        const variants = [...(bySequence.get(sequence) as Set<string>)]
        if (variants.length > 1) reasons.push(`schedule position ${sequence} carries ${variants.length} different headings across rows`)
        const [type, header] = variants[0].split('\u0000')
        return { sequence, type, header, yearMonth: null }
      })
      const monthly = columns.filter((column) => column.type === 'monthly')
      const mapping = mapScheduleMonths(startDate?.slice(0, 7) ?? null, monthly.map((column) => monthNumberOf(column.header)))
      reasons.push(...mapping.reasons)
      const deterministic = reasons.length === 0 && mapping.deterministic
      if (deterministic) {
        monthly.forEach((column, index) => {
          column.yearMonth = (mapping.months as string[])[index]
        })
        for (const column of columns) if (column.type === 'enrollment') column.yearMonth = (startDate as string).slice(0, 7)
        const other = columns.filter((column) => column.type !== 'monthly' && column.type !== 'enrollment')
        if (other.length > 0) reasons.push(`${other.length} schedule column(s) are neither a month nor the enrolment fee`)
      }
      out.push({ batchId, batchName: String(batch.name), cohortId: cohort.id, startDate, columns, deterministic: deterministic && reasons.length === 0, reasons })
    }
  }
  return out.sort((a, b) => a.cohortId.localeCompare(b.cohortId) || a.batchName.localeCompare(b.batchName))
}

export type CollectionStatus =
  | 'CURRENT'
  | 'AMOUNT_DUE_THROUGH_MONTH'
  | 'CREDIT_AHEAD'
  | 'BALANCE_OUTSTANDING'
  | 'BALANCE_SETTLED'
  | 'BALANCE_CREDIT'
  | 'CANNOT_DETERMINE'
  | 'BLOCKED_MANUAL'

export type ReminderKind = 'AMOUNT_DUE_THROUGH_MONTH' | 'LEGACY_BALANCE_REMINDER' | 'BALANCE_REMINDER'

export interface CollectionAssessment {
  financeRecordId: string
  studentId: string
  cohortId: string
  mode: CollectionMode
  status: CollectionStatus
  /** True when the mode's figure could be computed for this record. */
  calculable: boolean
  /** The reminder a later ticket could send, when one is warranted. Nothing is sent. */
  reminderKind: ReminderKind | null
  contactStatus: string
  contactReady: boolean
  flags: string[]
  reason: string
  /** "Scheduled through" month, for `installment` records. */
  throughMonth: string | null
  scheduledThroughMonth: number | null
  paidApplied: number | null
  /** Paid under a Late Fees column: real money, but not toward the schedule. */
  lateFeesPaid: number | null
  amountDue: number | null
  balanceOutstanding: number | null
}

export function assessCollections(input: {
  target: TargetDataset
  hosted: Record<BackupTable, BackupRow[]>
  contacts: readonly ContactAssessment[]
  asOf: string
  mappings: readonly BatchScheduleMapping[]
}): CollectionAssessment[] {
  const { target, hosted, contacts, asOf, mappings } = input
  const context = contextOf(target, hosted)
  const throughMonth = asOf.slice(0, 7)
  const contactByStudent = new Map(contacts.map((contact) => [contact.studentId, contact]))
  const mappingByBatch = new Map(mappings.map((mapping) => [mapping.batchId, mapping]))

  return target.links
    .map((link): CollectionAssessment => {
      const record = context.records.get(link.financeRecordId) as Record<string, unknown>
      const contact = contactByStudent.get(link.studentId)
      const contactReady = contact?.status === 'CONTACT_READY'
      const payments = (context.paymentsByRecord.get(link.financeRecordId) ?? []).filter((row) => row.voided_at === null || row.voided_at === undefined)
      const number = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))
      const fee = number(record.legacy_total_fee)
      const statedPaid = number(record.legacy_total_paid)
      const base = {
        financeRecordId: link.financeRecordId,
        studentId: link.studentId,
        cohortId: link.cohortId,
        mode: link.collectionMode,
        contactStatus: contact?.status ?? 'UNKNOWN',
        contactReady,
        throughMonth: null,
        scheduledThroughMonth: null,
        paidApplied: null,
        lateFeesPaid: null,
        amountDue: null,
        balanceOutstanding: null,
      }
      const cannot = (reason: string, flags: string[] = []): CollectionAssessment => ({ ...base, status: 'CANNOT_DETERMINE', calculable: false, reminderKind: null, flags, reason })

      switch (link.collectionMode) {
        case 'configuration_incomplete': {
          const flags = ['FINANCE_CONFIGURATION_INCOMPLETE', ...(contactReady ? [] : ['CONTACT_INCOMPLETE'])]
          return { ...base, status: 'BLOCKED_MANUAL', calculable: false, reminderKind: null, flags, reason: 'program finance setup incomplete: no automatic reminder and no receipt' }
        }

        case 'legacy_balance': {
          // Balance = Total Paid − Total Fee on the sheet, so an amount owed is negative.
          const balance = number(record.legacy_balance)
          if (balance === null) return cannot('no preserved balance snapshot', ['LEGACY_LEDGER_INCOMPLETE'])
          const outstanding = round(-balance)
          const status: CollectionStatus = outstanding > 0 ? 'BALANCE_OUTSTANDING' : outstanding < 0 ? 'BALANCE_CREDIT' : 'BALANCE_SETTLED'
          return {
            ...base,
            status,
            calculable: true,
            reminderKind: outstanding > 0 ? 'LEGACY_BALANCE_REMINDER' : null,
            flags: ['LEGACY_LEDGER_INCOMPLETE'],
            reason: 'preserved balance snapshot; the old payment rows are historical evidence, not a complete ledger',
            balanceOutstanding: outstanding,
          }
        }

        case 'balance': {
          if (fee === null) return cannot('no stated fee to measure a balance against')
          const paid = round(payments.reduce((total, row) => total + Number(row.amount), 0))
          const outstanding = round(fee - paid)
          const status: CollectionStatus = outstanding > 0 ? 'BALANCE_OUTSTANDING' : outstanding < 0 ? 'BALANCE_CREDIT' : 'BALANCE_SETTLED'
          return {
            ...base,
            status,
            calculable: true,
            reminderKind: outstanding > 0 ? 'BALANCE_REMINDER' : null,
            flags: [],
            reason: 'stated fee minus recorded payments',
            paidApplied: paid,
            balanceOutstanding: outstanding,
          }
        }

        case 'installment': {
          const schedule = context.installmentsByRecord.get(link.financeRecordId) ?? []
          if (schedule.length === 0) return cannot('this row has no installment schedule in the source', ['NO_SCHEDULE'])
          const mapping = mappingByBatch.get(link.batchId)
          if (!mapping?.deterministic) return cannot(`the batch's month mapping is not deterministic: ${mapping?.reasons.join('; ') ?? 'not mapped'}`)
          const monthBySequence = new Map(mapping.columns.map((column) => [column.sequence, column.yearMonth]))
          let scheduled = 0
          for (const row of schedule) {
            const month = monthBySequence.get(Number(row.sequence_number))
            if (month === undefined || month === null) return cannot(`schedule position ${row.sequence_number} has no mapped month`)
            if (month <= throughMonth) scheduled += Number(row.scheduled_amount ?? 0)
          }
          const isLateFee = (row: Record<string, unknown>): boolean => (row.legacy_raw_json as { column_role?: string } | null)?.column_role === 'late_fees'
          const total = round(payments.reduce((sum, row) => sum + Number(row.amount), 0))
          if (statedPaid !== null && round(statedPaid) !== total) {
            return cannot(`payments (${total}) do not equal the row's stated Total Paid (${statedPaid})`)
          }
          const lateFees = round(payments.filter(isLateFee).reduce((sum, row) => sum + Number(row.amount), 0))
          const applied = round(total - lateFees)
          const due = round(round(scheduled) - applied)
          const status: CollectionStatus = due > 0 ? 'AMOUNT_DUE_THROUGH_MONTH' : due < 0 ? 'CREDIT_AHEAD' : 'CURRENT'
          return {
            ...base,
            status,
            calculable: true,
            reminderKind: due > 0 ? 'AMOUNT_DUE_THROUGH_MONTH' : null,
            flags: lateFees > 0 ? ['LATE_FEES_PAID_NOT_APPLIED'] : [],
            reason: `scheduled through ${throughMonth} minus paid toward the schedule`,
            throughMonth,
            scheduledThroughMonth: round(scheduled),
            paidApplied: applied,
            lateFeesPaid: lateFees,
            amountDue: due,
          }
        }
      }
    })
    .sort((a, b) => a.financeRecordId.localeCompare(b.financeRecordId))
}

// -----------------------------------------------------------------------------
// Receipts
// -----------------------------------------------------------------------------

export const RECEIPT_REQUIREMENTS = [
  'IDENTIFIABLE_STUDENT',
  'FINANCE_RECORD',
  'PAYMENT_AMOUNT',
  'PAYMENT_DATE',
  'PROGRAM_RECEIPT_NUMBERING',
] as const

export type ReceiptRequirement = (typeof RECEIPT_REQUIREMENTS)[number]

/** Why a payment is not receipt-eligible. HISTORICAL_PAYMENT wins: no retroactive receipts. */
export type ReceiptIneligibility = 'HISTORICAL_PAYMENT' | `MISSING_${ReceiptRequirement}`

export interface ReceiptPaymentLike {
  source: unknown
  amount: unknown
  payment_date: unknown
  voided_at?: unknown
}

export interface ReceiptProgramLike {
  student_number_prefix: unknown
  receipt_course_code: unknown
  receipt_course_suffix: unknown
}

export function programHasReceiptNumbering(program: ReceiptProgramLike | undefined): boolean {
  return program !== undefined && program.student_number_prefix !== null && program.receipt_course_code !== null && program.receipt_course_suffix !== null
}

/**
 * The receipt-eligibility rule for payments recorded after the cutover.
 *
 * A payment the cutover carried over (`source = 'legacy_import'`) is never
 * eligible: no retroactive receipts, whatever it holds. Otherwise eligibility
 * needs an identifiable student, a finance record, an amount, a payment date
 * and the program's receipt numbering. The payment method is optional and is
 * never invented.
 */
export function receiptIneligibility(input: {
  payment: ReceiptPaymentLike
  hasStudent: boolean
  hasFinanceRecord: boolean
  program: ReceiptProgramLike | undefined
}): ReceiptIneligibility[] {
  const { payment } = input
  if (payment.source === 'legacy_import') return ['HISTORICAL_PAYMENT']
  const out: ReceiptIneligibility[] = []
  if (!input.hasStudent) out.push('MISSING_IDENTIFIABLE_STUDENT')
  if (!input.hasFinanceRecord) out.push('MISSING_FINANCE_RECORD')
  if (payment.amount === null || payment.amount === undefined || Number(payment.amount) <= 0) out.push('MISSING_PAYMENT_AMOUNT')
  if (payment.payment_date === null || payment.payment_date === undefined) out.push('MISSING_PAYMENT_DATE')
  if (!programHasReceiptNumbering(input.program)) out.push('MISSING_PROGRAM_RECEIPT_NUMBERING')
  return out
}

export interface ReceiptAssessment {
  paymentId: string
  cohortId: string
  programShortCode: string
  eligible: boolean
  ineligibility: ReceiptIneligibility[]
  /** What else the historical payment lacks — reported, never repaired. */
  historicalGaps: string[]
}

export function assessReceipts(input: { target: TargetDataset; hosted: Record<BackupTable, BackupRow[]> }): ReceiptAssessment[] {
  const { target, hosted } = input
  const context = contextOf(target, hosted)
  const linkByRecord = new Map(target.links.map((link) => [link.financeRecordId, link]))
  const retained = new Set(target.retained.payments)
  const payments = [...hosted.payments.filter((row) => retained.has(row.id)), ...target.inserts.payments]
  return payments
    .map((payment): ReceiptAssessment => {
      const link = linkByRecord.get(String(payment.student_finance_record_id))
      const ineligibility = receiptIneligibility({
        payment: payment as unknown as ReceiptPaymentLike,
        hasStudent: link !== undefined && context.students.has(link.studentId),
        hasFinanceRecord: link !== undefined,
        program: link ? (context.programsByCode.get(link.programShortCode) as unknown as ReceiptProgramLike | undefined) : undefined,
      })
      const gaps: string[] = []
      if (payment.payment_date === null || payment.payment_date === undefined) gaps.push('NO_PAYMENT_DATE')
      if (payment.payment_method === null || payment.payment_method === undefined) gaps.push('NO_PAYMENT_METHOD')
      if (link?.collectionMode === 'legacy_balance') gaps.push('LEGACY_LEDGER_INCOMPLETE')
      return {
        paymentId: payment.id,
        cohortId: link?.cohortId ?? 'unknown',
        programShortCode: link?.programShortCode ?? 'unknown',
        eligible: ineligibility.length === 0,
        ineligibility,
        historicalGaps: gaps,
      }
    })
    .sort((a, b) => a.paymentId.localeCompare(b.paymentId))
}

/** Per program: is receipt numbering configured for future payments? */
export function receiptNumberingByProgram(target: TargetDataset, hosted: Record<BackupTable, BackupRow[]>): { shortCode: string; configured: boolean }[] {
  return [...hosted.programs, ...target.inserts.programs]
    .map((program) => ({ shortCode: String(program.short_code), configured: programHasReceiptNumbering(program as unknown as ReceiptProgramLike) }))
    .sort((a, b) => a.shortCode.localeCompare(b.shortCode))
}
