/**
 * A synthetic hosted state for the cutover tests, shaped like the backup.
 *
 * It holds one of each case the plan must get right: a March 2026 batch to
 * preserve, an old April batch whose numbered student re-appears in the
 * workbook (re-used by exact number), a look-alike with the same name and a
 * different number, a number-less look-alike, a student only on a 2025 batch
 * (deleted), an unassigned record, and import history that must survive.
 */

import { idsMd5Of } from './hosted.mts'

import type { BackupTable } from './config.mts'
import type { BackupRow, StateFingerprint } from './hosted.mts'

export type HostedFixture = Record<BackupTable, BackupRow[]>

export const IDS = {
  psw: '00000000-0000-4000-8000-000000000001',
  ecea: '00000000-0000-4000-8000-000000000002',
  marchMorning: '00000000-0000-4000-8000-0000000000a1',
  marchEvening: '00000000-0000-4000-8000-0000000000a2',
  oldApril: '00000000-0000-4000-8000-0000000000b1',
  old2025: '00000000-0000-4000-8000-0000000000b2',
  oldEcea: '00000000-0000-4000-8000-0000000000b3',
  marchStudent: '00000000-0000-4000-8000-0000000000c1',
  /** Hosted 999901: re-used by exact number by the April and August rows. */
  reusedStudent: '00000000-0000-4000-8000-0000000000c2',
  /** Hosted 999950 spelled like the workbook's 999902. Never matched. */
  lookalike: '00000000-0000-4000-8000-0000000000c3',
  /** Hosted, no number, spelled like the June number-less row. Never matched. */
  unnumberedLookalike: '00000000-0000-4000-8000-0000000000c4',
  /** Only on the 2025 batch: deleted. */
  historicalOnly: '00000000-0000-4000-8000-0000000000c5',
  marchRecord: '00000000-0000-4000-8000-0000000000d1',
  oldAprilRecord: '00000000-0000-4000-8000-0000000000d2',
  historicalRecord: '00000000-0000-4000-8000-0000000000d3',
  unassignedRecord: '00000000-0000-4000-8000-0000000000d4',
  lookalikeRecord: '00000000-0000-4000-8000-0000000000d5',
  unnumberedRecord: '00000000-0000-4000-8000-0000000000d6',
  marchInstallment: '00000000-0000-4000-8000-0000000000e1',
  oldInstallment: '00000000-0000-4000-8000-0000000000e2',
  marchPayment: '00000000-0000-4000-8000-0000000000f1',
  oldPayment: '00000000-0000-4000-8000-0000000000f2',
  unassignedPayment: '00000000-0000-4000-8000-0000000000f3',
  marchColumn: '00000000-0000-4000-8000-0000000000a9',
  oldColumn: '00000000-0000-4000-8000-0000000000b9',
  importBatch: '00000000-0000-4000-8000-000000000ab1',
  importException: '00000000-0000-4000-8000-000000000ab2',
} as const

function student(id: string, number: string | null, first: string, last: string): BackupRow {
  return {
    id,
    student_number: number,
    first_name: first,
    middle_name: null,
    last_name: last,
    display_name: `${first} ${last}`,
    legacy_name: `${first} ${last}`,
    email: null,
    phone: null,
    active: true,
    legacy_source: 'fixture',
    legacy_raw_json: null,
  }
}

function record(id: string, studentId: string, programId: string, batchId: string | null, fee: number | null, paid: number | null): BackupRow {
  return {
    id,
    student_id: studentId,
    program_id: programId,
    batch_id: batchId,
    legacy_total_fee: fee,
    legacy_total_paid: paid,
    legacy_balance: paid === null || fee === null ? null : paid - fee,
    current_total_fee: null,
    currency: 'CAD',
    status: 'active',
    legacy_source_sheet: null,
    legacy_source_row: null,
    legacy_raw_json: null,
  }
}

function installment(id: string, recordId: string, sequence: number, type: string, column: string, amount: number): BackupRow {
  return { id, student_finance_record_id: recordId, sequence_number: sequence, installment_type: type, installment_month: null, due_date: null, scheduled_amount: amount, legacy_column_name: column }
}

/** Excel serial of the first of a month, as Tracker Master's batch cell stores it. */
export function monthSerial(yearMonth: string): number {
  return Math.round((Date.UTC(Number(yearMonth.slice(0, 4)), Number(yearMonth.slice(5, 7)) - 1, 1) - Date.UTC(1899, 11, 30)) / 86_400_000)
}

export function payment(
  id: string,
  recordId: string,
  amount: number,
  date: string,
  method: string,
  tracker: { paymentNo?: string; routing?: string; batchMonth?: string } = {},
): BackupRow {
  return {
    id,
    student_finance_record_id: recordId,
    installment_id: null,
    source: 'legacy_import',
    amount,
    payment_date: date,
    payment_method: method,
    voided_at: null,
    legacy_source_sheet: 'Tracker Master',
    legacy_source_row: 10,
    legacy_raw_json: {
      payment_no: tracker.paymentNo ?? null,
      routing: tracker.routing === undefined ? null : { outcome: tracker.routing },
      batch: tracker.batchMonth === undefined ? null : { raw_value: monthSerial(tracker.batchMonth), formatted_text: tracker.batchMonth },
    },
  }
}

export function hostedFixture(): HostedFixture {
  return {
    programs: [
      { id: IDS.psw, name: 'NACC Personal Support Worker', short_code: 'PSW', student_number_prefix: '125', receipt_course_code: '12500', receipt_course_suffix: '25', active: true },
      { id: IDS.ecea, name: 'Early Childhood Education Assistant', short_code: 'ECEA', student_number_prefix: '121', receipt_course_code: '12100', receipt_course_suffix: '21', active: true },
    ],
    batches: [
      { id: IDS.marchMorning, program_id: IDS.psw, name: 'March 26 - Morning', code: 'March 2026!title@1', start_date: null, legacy_sheet_name: 'March 2026' },
      { id: IDS.marchEvening, program_id: IDS.psw, name: 'March 26 - Evening', code: 'March 2026!title@21', start_date: null, legacy_sheet_name: 'March 2026' },
      { id: IDS.oldApril, program_id: IDS.psw, name: '27th April 2026 - Morning', code: '27 April 26!title@3', start_date: '2026-04-27', legacy_sheet_name: '27 April 26' },
      { id: IDS.old2025, program_id: IDS.psw, name: '17th March 2025 - Morning', code: '17th March 2025!title@1', start_date: '2025-03-17', legacy_sheet_name: '17th March 2025' },
      { id: IDS.oldEcea, program_id: IDS.ecea, name: 'ELCE 25 & 26', code: 'ELCE 25 & 26!header@3', start_date: null, legacy_sheet_name: 'ELCE 25 & 26' },
    ],
    students: [
      student(IDS.marchStudent, '999800', 'March', 'Fixture'),
      student(IDS.reusedStudent, '999901', 'Asha', 'Fixture'),
      student(IDS.lookalike, '999950', 'Bo', 'Fixture'),
      student(IDS.unnumberedLookalike, null, 'Ed', 'Fixture'),
      student(IDS.historicalOnly, '999700', 'Hist', 'Fixture'),
    ],
    student_finance_records: [
      record(IDS.marchRecord, IDS.marchStudent, IDS.psw, IDS.marchMorning, 5365, 1765),
      record(IDS.oldAprilRecord, IDS.reusedStudent, IDS.psw, IDS.oldApril, 5365, 865),
      record(IDS.historicalRecord, IDS.historicalOnly, IDS.psw, IDS.old2025, 5000, 5000),
      record(IDS.unassignedRecord, IDS.reusedStudent, IDS.psw, null, null, null),
      record(IDS.lookalikeRecord, IDS.lookalike, IDS.psw, IDS.oldApril, 5365, 0),
      record(IDS.unnumberedRecord, IDS.unnumberedLookalike, IDS.psw, IDS.oldApril, 5365, 0),
    ],
    installments: [
      installment(IDS.marchInstallment, IDS.marchRecord, 1, 'enrollment', 'Enroll. Fee', 865),
      installment(IDS.oldInstallment, IDS.oldAprilRecord, 1, 'enrollment', 'Enroll. Fee', 865),
    ],
    payments: [
      payment(IDS.marchPayment, IDS.marchRecord, 1765, '2026-03-02', 'Etransfer'),
      // The April deposit, routed to the April table: the workbook's Enroll. Fee cell holds it.
      payment(IDS.oldPayment, IDS.oldAprilRecord, 865, '2026-03-20', 'Etransfer', { paymentNo: '1', routing: 'unique_batch', batchMonth: '2026-04' }),
      // Second payment of the same enrollment, left unassigned by the old import; fits the May cell.
      payment(IDS.unassignedPayment, IDS.unassignedRecord, 100, '2026-01-05', 'Cash', { paymentNo: '2', routing: 'ambiguous_batch', batchMonth: '2026-04' }),
    ],
    receipts: [],
    receipt_deliveries: [],
    reminder_deliveries: [],
    import_batches: [{ id: IDS.importBatch }],
    import_exceptions: [{ id: IDS.importException, import_batch_id: IDS.importBatch }],
    batch_finance_columns: [
      { id: IDS.marchColumn, batch_id: IDS.marchMorning },
      { id: IDS.oldColumn, batch_id: IDS.oldApril },
    ],
    audit_log: [],
  }
}

/** A fingerprint consistent with a hosted fixture. Row md5s are stand-ins. */
export function fingerprintOf(hosted: HostedFixture): StateFingerprint {
  const tables = Object.fromEntries(
    Object.entries(hosted).map(([table, rows]) => [table, { count: rows.length, idsMd5: idsMd5Of(rows.map((row) => row.id)), rowsMd5: `rows-${table}-${rows.length}` }]),
  ) as StateFingerprint['tables']
  return {
    tables,
    studentsEmailNonNull: hosted.students.filter((row) => row.email !== null).length,
    studentsPhoneNonNull: hosted.students.filter((row) => row.phone !== null).length,
  }
}
