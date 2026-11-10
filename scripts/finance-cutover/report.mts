/**
 * The cutover's aggregate report. Counts, totals and hashes only — no name,
 * student number, email or phone — so it is safe to paste into a review. The
 * row-level detail lives in the private analysis JSON beside it.
 */

import { BACKUP_TABLES, TARGET_COHORTS, type BackupTable } from './config.mts'
import { CONTACT_STATUSES, type ContactAssessment } from './contacts.mts'
import { studentRows, type ParsedWorkbook } from './parse.mts'
import { DELETE_ORDER, type CutoverPlan } from './plan.mts'
import type { BatchScheduleMapping, CollectionAssessment, ReceiptAssessment } from './readiness.mts'

import type { CohortConservation } from './conservation.mts'
import type { DatedPaymentReconciliation } from './dated-payments.mts'
import type { BackupRow, StateFingerprint } from './hosted.mts'
import type { TargetDataset } from './target.mts'

const round = (value: number): number => Math.round(value * 100) / 100
const money = (value: number | null): string => (value === null ? '—' : `$${round(value).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)

function tally<T extends string>(values: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}

export interface CutoverAnalysis {
  ticket: string
  asOf: string
  workbook: { fileName: string; relativePath: string; sha256: string }
  masters: { fileName: string; sha256: string; program: string }[]
  sheets: {
    sheetName: string
    tables: { title: string | null; tableKey: string; cohortId: string; batchName: string; startDate: string | null; yearMonth: string | null; yearMonthEvidence: string; rowClasses: Record<string, number>; namedRows: number; numberedRows: number; studentRows: number; redactedColumns: string[] }[]
  }[]
  unrecognizedSheets: ParsedWorkbook['unrecognizedSheets']
  outOfScopeTables: number
  namedRowsByCohort: Record<string, number>
  namedRowsTotal: number
  march: {
    batches: { id: string; name: string; session: string | null; records: number; payments: number; paymentAmount: number }[]
    students: number
    financeRecords: number
    installments: number
    payments: number
    batchFinanceColumns: number
    statedFees: number
    statedTotalPaid: number
    statedBalance: number
    paymentAmount: number
    installmentAmount: number
    paymentDateRange: [string | null, string | null]
    otherRecordsOfMarchStudents: number
  }
  hosted: { live: Record<string, number>; expected: Record<string, number>; matchesExpected: boolean }
  target: {
    students: number
    studentsByResolution: Record<string, number>
    workbookStudentRowsSharingANumber: number
    financeRecords: number
    installments: number
    payments: number
    batches: number
    programs: number
    batchFinanceColumns: number
    importExceptions: number
    importExceptionsByReason: Record<string, number>
  }
  counts: CutoverPlan['counts']
  removedBatches: CutoverPlan['removedBatches']
  removedUnassignedRecords: number
  removedPaymentsOfTargetStudents: number
  /** Dated hosted payments of target students that the cutover removes, by the student's target cohort. */
  removedPaymentsOfTargetStudentsByCohort: Record<string, { payments: number; amount: number; dated: number; fromUnassignedRecords: number }>
  contacts: {
    byStatus: Record<string, number>
    byStatusByCohort: Record<string, Record<string, number>>
    workbookNamedRowsWithExactMasterMatch: number
    phone: Record<string, number>
  }
  conservation: CohortConservation[]
  collections: {
    asOf: string
    throughMonth: string
    modes: Record<string, number>
    byCohort: Record<
      string,
      {
        mode: string
        records: number
        calculable: number
        contactReady: number
        calculableAndContactReady: number
        statuses: Record<string, number>
        reminderWarranted: number
        reminderWarrantedContactReady: number
        reminderAmount: number
        lateFeesPaidNotApplied: number
        cannotDetermine: Record<string, number>
        flags: Record<string, number>
      }
    >
  }
  scheduleMappings: BatchScheduleMapping[]
  receipts: {
    total: number
    eligible: number
    historicalNotEligible: number
    byCohort: Record<string, { total: number; eligible: number }>
    historicalGaps: Record<string, number>
    numbering: { shortCode: string; configured: boolean }[]
  }
  restore: { file: string; sha256: string; verified: boolean | null }
  datedPayments: Record<string, { payments: number; amount: number; byCohort: Record<string, number>; preserved: number; historicalReceiptCapable: number }>
  issues: TargetDataset['issues']
  invariantViolations: string[]
  blockers: string[]
  hashes: { backup: string; target: string; plan: string; backupFile: string }
  sqlBytes: number
  applyCommand: string
}

export function buildAnalysis(input: {
  asOf: string
  workbook: CutoverAnalysis['workbook']
  masters: CutoverAnalysis['masters']
  parsed: ParsedWorkbook
  live: StateFingerprint
  expectedBaseline: Record<string, number>
  target: TargetDataset
  targetHash: string
  plan: CutoverPlan
  planHash: string
  backup: { file: string; sha256: string }
  contacts: readonly ContactAssessment[]
  conservation: CohortConservation[]
  mappings: readonly BatchScheduleMapping[]
  collections: readonly CollectionAssessment[]
  receipts: readonly ReceiptAssessment[]
  numbering: { shortCode: string; configured: boolean }[]
  restore: { file: string; sha256: string; verified: boolean | null }
  datedPayments: readonly DatedPaymentReconciliation[]
  hosted: Record<BackupTable, BackupRow[]>
  sqlBytes: number
  blockers: string[]
}): CutoverAnalysis {
  const { parsed, target, plan, hosted } = input

  // --- Sheets ---------------------------------------------------------------
  const sheetNames = [...new Set(parsed.tables.map((table) => table.sheetName))]
  const sheets = sheetNames.map((sheetName) => ({
    sheetName,
    tables: parsed.tables
      .filter((table) => table.sheetName === sheetName)
      .map((table) => ({
        title: table.table.title,
        tableKey: table.table.key,
        cohortId: table.cohort?.id ?? 'none',
        batchName: table.batchName,
        startDate: table.startDate,
        yearMonth: table.yearMonth,
        yearMonthEvidence: table.yearMonthEvidence,
        rowClasses: tally(table.rows.map((row) => row.rowClass)),
        namedRows: studentRows(table).filter((row) => row.named).length,
        numberedRows: studentRows(table).filter((row) => row.numbered).length,
        studentRows: studentRows(table).length,
        redactedColumns: table.redactedColumns.map((column) => `${column.letter} (${column.header})`),
      })),
  }))
  const namedRowsByCohort: Record<string, number> = {}
  for (const table of parsed.tables) {
    const id = table.cohort?.id ?? 'none'
    namedRowsByCohort[id] = (namedRowsByCohort[id] ?? 0) + studentRows(table).filter((row) => row.named).length
  }

  // --- March ----------------------------------------------------------------
  const marchCohort = TARGET_COHORTS.find((cohort) => cohort.source === 'hosted')
  const marchBatchIds = new Set(target.cohorts.find((cohort) => cohort.id === marchCohort?.id)?.batchIds ?? [])
  const marchRecords = hosted.student_finance_records.filter((row) => marchBatchIds.has(String(row.batch_id)))
  const marchRecordIds = new Set(marchRecords.map((row) => row.id))
  const marchPayments = hosted.payments.filter((row) => marchRecordIds.has(String(row.student_finance_record_id)))
  const marchInstallments = hosted.installments.filter((row) => marchRecordIds.has(String(row.student_finance_record_id)))
  const marchStudents = new Set(marchRecords.map((row) => String(row.student_id)))
  const dates = marchPayments.map((row) => row.payment_date as string | null).filter((value): value is string => value !== null).sort()
  const sumOf = (rows: readonly Record<string, unknown>[], column: string): number => round(rows.reduce((total, row) => total + (row[column] === null ? 0 : Number(row[column])), 0))

  const march: CutoverAnalysis['march'] = {
    batches: hosted.batches
      .filter((batch) => marchBatchIds.has(batch.id))
      .map((batch) => {
        const records = marchRecords.filter((row) => row.batch_id === batch.id)
        const ids = new Set(records.map((row) => row.id))
        const payments = marchPayments.filter((row) => ids.has(String(row.student_finance_record_id)))
        const name = String(batch.name)
        return { id: batch.id, name, session: /morning/i.test(name) ? 'Morning' : /evening/i.test(name) ? 'Evening' : null, records: records.length, payments: payments.length, paymentAmount: sumOf(payments, 'amount') }
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    students: marchStudents.size,
    financeRecords: marchRecords.length,
    installments: marchInstallments.length,
    payments: marchPayments.length,
    batchFinanceColumns: hosted.batch_finance_columns.filter((row) => marchBatchIds.has(String(row.batch_id))).length,
    statedFees: sumOf(marchRecords, 'legacy_total_fee'),
    statedTotalPaid: sumOf(marchRecords, 'legacy_total_paid'),
    statedBalance: sumOf(marchRecords, 'legacy_balance'),
    paymentAmount: sumOf(marchPayments, 'amount'),
    installmentAmount: sumOf(marchInstallments, 'scheduled_amount'),
    paymentDateRange: [dates[0] ?? null, dates[dates.length - 1] ?? null],
    otherRecordsOfMarchStudents: hosted.student_finance_records.filter((row) => marchStudents.has(String(row.student_id)) && !marchRecordIds.has(row.id)).length,
  }

  // --- Hosted vs expected ---------------------------------------------------
  const live: Record<string, number> = Object.fromEntries(BACKUP_TABLES.map((table) => [table, input.live.tables[table].count]))
  live.students_email_non_null = input.live.studentsEmailNonNull
  live.students_phone_non_null = input.live.studentsPhoneNonNull
  const matchesExpected = Object.entries(input.expectedBaseline).every(([key, value]) => live[key] === value)

  // --- Target ---------------------------------------------------------------
  const targetStudentIds = new Set(target.links.map((link) => link.studentId))
  const resolutionByStudent = new Map<string, string>()
  for (const link of target.links) resolutionByStudent.set(link.studentId, link.resolution)
  const workbookNumbers = target.links.filter((link) => link.origin === 'workbook' && link.studentNumber !== null).map((link) => link.studentNumber as string)
  const repeated = Object.values(tally(workbookNumbers)).filter((count) => count > 1).reduce((total, count) => total + count, 0)

  // --- Removed --------------------------------------------------------------
  const deletedRecords = new Set(plan.deletes.student_finance_records)
  const removedUnassignedRecords = hosted.student_finance_records.filter((row) => deletedRecords.has(row.id) && row.batch_id === null).length
  const deletedPayments = new Set(plan.deletes.payments)
  const hostedRecordById = new Map(hosted.student_finance_records.map((row) => [row.id, row]))
  const cohortOfStudent = new Map<string, string>()
  for (const link of target.links) cohortOfStudent.set(link.studentId, link.cohortId)
  const removedPaymentsOfTargetStudentsByCohort: CutoverAnalysis['removedPaymentsOfTargetStudentsByCohort'] = {}
  let removedPaymentsOfTargetStudents = 0
  for (const payment of hosted.payments) {
    if (!deletedPayments.has(payment.id)) continue
    const record = hostedRecordById.get(String(payment.student_finance_record_id))
    if (record === undefined || !targetStudentIds.has(String(record.student_id))) continue
    removedPaymentsOfTargetStudents += 1
    const cohort = cohortOfStudent.get(String(record.student_id)) ?? 'unknown'
    const entry = (removedPaymentsOfTargetStudentsByCohort[cohort] ??= { payments: 0, amount: 0, dated: 0, fromUnassignedRecords: 0 })
    entry.payments += 1
    entry.amount = round(entry.amount + Number(payment.amount))
    if (payment.payment_date !== null) entry.dated += 1
    if (record.batch_id === null) entry.fromUnassignedRecords += 1
  }

  // --- Contacts -------------------------------------------------------------
  const contactByStudent = new Map(input.contacts.map((contact) => [contact.studentId, contact]))
  const byStatusByCohort: Record<string, Record<string, number>> = {}
  for (const cohort of target.cohorts) {
    const students = [...new Set(target.links.filter((link) => link.cohortId === cohort.id).map((link) => link.studentId))]
    byStatusByCohort[cohort.id] = tally(students.map((id) => contactByStudent.get(id)?.status ?? 'UNKNOWN'))
  }
  const workbookNamedLinks = target.links.filter((link) => link.origin === 'workbook' && link.named)
  const matched = workbookNamedLinks.filter((link) => (contactByStudent.get(link.studentId)?.masterRows ?? 0) > 0).length

  // --- Collections ----------------------------------------------------------
  const byCohort: CutoverAnalysis['collections']['byCohort'] = {}
  for (const entry of input.collections) {
    const summary = (byCohort[entry.cohortId] ??= {
      mode: entry.mode,
      records: 0,
      calculable: 0,
      contactReady: 0,
      calculableAndContactReady: 0,
      statuses: {},
      reminderWarranted: 0,
      reminderWarrantedContactReady: 0,
      reminderAmount: 0,
      lateFeesPaidNotApplied: 0,
      cannotDetermine: {},
      flags: {},
    })
    summary.records += 1
    if (entry.calculable) summary.calculable += 1
    if (entry.contactReady) summary.contactReady += 1
    if (entry.calculable && entry.contactReady) summary.calculableAndContactReady += 1
    summary.statuses[entry.status] = (summary.statuses[entry.status] ?? 0) + 1
    if (entry.reminderKind !== null) {
      summary.reminderWarranted += 1
      if (entry.contactReady) summary.reminderWarrantedContactReady += 1
      summary.reminderAmount = round(summary.reminderAmount + (entry.amountDue ?? entry.balanceOutstanding ?? 0))
    }
    if ((entry.lateFeesPaid ?? 0) > 0) summary.lateFeesPaidNotApplied = round(summary.lateFeesPaidNotApplied + (entry.lateFeesPaid ?? 0))
    if (entry.status === 'CANNOT_DETERMINE') {
      const reason = entry.reason.replace(/\([^)]*\)/g, '(…)')
      summary.cannotDetermine[reason] = (summary.cannotDetermine[reason] ?? 0) + 1
    }
    for (const flag of entry.flags) summary.flags[flag] = (summary.flags[flag] ?? 0) + 1
  }

  // --- Receipts -------------------------------------------------------------
  const receiptsByCohort: Record<string, { total: number; eligible: number }> = {}
  const gaps: Record<string, number> = {}
  for (const receipt of input.receipts) {
    receiptsByCohort[receipt.cohortId] ??= { total: 0, eligible: 0 }
    receiptsByCohort[receipt.cohortId].total += 1
    if (receipt.eligible) receiptsByCohort[receipt.cohortId].eligible += 1
    for (const gap of receipt.historicalGaps) gaps[gap] = (gaps[gap] ?? 0) + 1
  }

  return {
    ticket: plan.ticket,
    asOf: input.asOf,
    workbook: input.workbook,
    masters: input.masters,
    sheets,
    unrecognizedSheets: parsed.unrecognizedSheets,
    outOfScopeTables: parsed.outOfScopeTables.length,
    namedRowsByCohort,
    namedRowsTotal: Object.values(namedRowsByCohort).reduce((total, value) => total + value, 0),
    march,
    hosted: { live, expected: input.expectedBaseline, matchesExpected },
    target: {
      students: targetStudentIds.size,
      studentsByResolution: tally([...targetStudentIds].map((id) => resolutionByStudent.get(id) ?? 'unknown')),
      workbookStudentRowsSharingANumber: repeated,
      financeRecords: target.links.length,
      installments: target.retained.installments.length + target.inserts.installments.length,
      payments: target.retained.payments.length + target.inserts.payments.length,
      batches: target.retained.batches.length + target.inserts.batches.length,
      programs: target.retained.programs.length + target.inserts.programs.length,
      batchFinanceColumns: target.retained.batch_finance_columns.length + target.inserts.batch_finance_columns.length,
      importExceptions: target.inserts.import_exceptions.length,
      importExceptionsByReason: tally(target.inserts.import_exceptions.map((row) => String(row.reason))),
    },
    counts: plan.counts,
    removedBatches: plan.removedBatches,
    removedUnassignedRecords,
    removedPaymentsOfTargetStudents,
    removedPaymentsOfTargetStudentsByCohort,
    contacts: {
      byStatus: { ...Object.fromEntries(CONTACT_STATUSES.map((status) => [status, 0])), ...tally(input.contacts.map((contact) => contact.status)) },
      byStatusByCohort,
      workbookNamedRowsWithExactMasterMatch: matched,
      phone: tally(input.contacts.map((contact) => contact.phone)),
    },
    conservation: input.conservation,
    collections: {
      asOf: input.asOf,
      throughMonth: input.asOf.slice(0, 7),
      modes: tally(input.collections.map((entry) => entry.mode)),
      byCohort,
    },
    scheduleMappings: [...input.mappings],
    receipts: {
      total: input.receipts.length,
      eligible: input.receipts.filter((receipt) => receipt.eligible).length,
      historicalNotEligible: input.receipts.filter((receipt) => receipt.ineligibility.includes('HISTORICAL_PAYMENT')).length,
      byCohort: receiptsByCohort,
      historicalGaps: gaps,
      numbering: input.numbering,
    },
    restore: input.restore,
    datedPayments: summarizeDatedPayments(input.datedPayments),
    issues: target.issues,
    invariantViolations: plan.invariantViolations,
    blockers: input.blockers,
    hashes: { backup: input.backup.sha256, target: input.targetHash, plan: input.planHash, backupFile: input.backup.file },
    sqlBytes: input.sqlBytes,
    applyCommand: `npm run finance:cutover -- --apply --plan-hash=${input.planHash}`,
  }
}

function summarizeDatedPayments(entries: readonly DatedPaymentReconciliation[]): CutoverAnalysis['datedPayments'] {
  const out: CutoverAnalysis['datedPayments'] = {}
  for (const entry of entries) {
    const summary = (out[entry.class] ??= { payments: 0, amount: 0, byCohort: {}, preserved: 0, historicalReceiptCapable: 0 })
    summary.payments += 1
    summary.amount = round(summary.amount + entry.amount)
    summary.byCohort[entry.targetCohortId] = (summary.byCohort[entry.targetCohortId] ?? 0) + 1
    if (entry.preserve) summary.preserved += 1
    if (entry.historicalReceiptCapable) summary.historicalReceiptCapable += 1
  }
  return out
}

function table(headers: string[], rows: (string | number)[][]): string {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n')
}

export function renderAggregate(analysis: CutoverAnalysis): string {
  const out: string[] = []
  const counts = analysis.counts
  out.push(`# ${analysis.ticket} — dry run aggregate (no PII)`, '')
  out.push(`Workbook \`${analysis.workbook.relativePath}\` sha256 \`${analysis.workbook.sha256}\`. Readiness as of ${analysis.asOf}.`, '')
  out.push('## Sheets', '')
  out.push(
    table(
      ['Sheet', 'Table', 'Cohort', 'Batch name', 'Start', 'Rows by class', 'Named', 'Numbered'],
      analysis.sheets.flatMap((sheet) =>
        sheet.tables.map((entry) => [sheet.sheetName, entry.tableKey, entry.cohortId, entry.batchName, entry.startDate ?? '—', Object.entries(entry.rowClasses).map(([key, value]) => `${key} ${value}`).join(', '), entry.namedRows, entry.numberedRows]),
      ),
    ),
    '',
  )
  out.push(`Named rows: ${Object.entries(analysis.namedRowsByCohort).map(([key, value]) => `${key} ${value}`).join(' · ')} · total ${analysis.namedRowsTotal}.`, '')
  out.push('## March 2026 (preserved from hosted)', '')
  out.push(table(['Batch', 'Session', 'Records', 'Payments', 'Payment amount'], analysis.march.batches.map((batch) => [batch.name, batch.session ?? '—', batch.records, batch.payments, money(batch.paymentAmount)])), '')
  out.push(
    `Students ${analysis.march.students} · records ${analysis.march.financeRecords} · installments ${analysis.march.installments} (${money(analysis.march.installmentAmount)}) · payments ${analysis.march.payments} (${money(analysis.march.paymentAmount)}, dated ${analysis.march.paymentDateRange.join(' → ')}) · column layout ${analysis.march.batchFinanceColumns} · stated fees ${money(analysis.march.statedFees)} · stated Total Paid ${money(analysis.march.statedTotalPaid)} · stated balance ${money(analysis.march.statedBalance)} · other records of March students ${analysis.march.otherRecordsOfMarchStudents}.`,
    '',
  )
  out.push('## CURRENT → DELETE → INSERT → TARGET', '')
  out.push(
    table(
      ['Table', 'Current', 'Delete', 'Retained', 'Insert', 'Apply audit', 'Target'],
      BACKUP_TABLES.map((name) => [name, counts.current[name], counts.delete[name], counts.retained[name], counts.insert[name], counts.applyAudit[name], counts.target[name]]),
    ),
    '',
  )
  out.push(`Delete order: ${DELETE_ORDER.join(' → ')}. Removed batches: ${analysis.removedBatches.length}; removed unassigned records: ${analysis.removedUnassignedRecords}; removed payments that belonged to a target student: ${analysis.removedPaymentsOfTargetStudents}.`, '')
  out.push(
    `Hosted payments of target students removed with their old records: ${Object.entries(analysis.removedPaymentsOfTargetStudentsByCohort).map(([cohort, value]) => `${cohort} ${value.payments} (${value.dated} dated, ${money(value.amount)}, ${value.fromUnassignedRecords} from unassigned records)`).join('; ') || 'none'}. They remain in the backup only.`,
    '',
  )
  out.push(`Hosted live counts ${analysis.hosted.matchesExpected ? 'match' : 'DO NOT match'} the ticket baseline.`, '')
  out.push('## Target', '')
  out.push(
    `Students ${analysis.target.students} (${Object.entries(analysis.target.studentsByResolution).map(([key, value]) => `${key} ${value}`).join(', ')}) · finance records ${analysis.target.financeRecords} · installments ${analysis.target.installments} · payments ${analysis.target.payments} · batches ${analysis.target.batches} · programs ${analysis.target.programs} · column layout ${analysis.target.batchFinanceColumns} · import exceptions ${analysis.target.importExceptions} (${Object.entries(analysis.target.importExceptionsByReason).map(([key, value]) => `${key} ${value}`).join(', ')}).`,
    '',
  )
  out.push('## Contacts (exact student number only)', '')
  out.push(table(['Status', 'Students'], Object.entries(analysis.contacts.byStatus).map(([key, value]) => [key, value])), '')
  out.push(`Workbook named rows with an exact master match: ${analysis.contacts.workbookNamedRowsWithExactMasterMatch} of ${analysis.namedRowsTotal}. Phone: ${Object.entries(analysis.contacts.phone).map(([key, value]) => `${key} ${value}`).join(', ')}.`, '')
  out.push(table(['Cohort', ...CONTACT_STATUSES], Object.entries(analysis.contacts.byStatusByCohort).map(([cohort, value]) => [cohort, ...CONTACT_STATUSES.map((status) => value[status] ?? 0)])), '')
  out.push('## Financial conservation', '')
  out.push(
    table(
      ['Cohort', 'Records', 'Stated fees (nulls)', 'Row Total Paid', 'Sheet totals-row Total Paid', 'Payments', 'Payment cells', 'Installments', 'Conserved', 'Inconsistencies'],
      analysis.conservation.map((entry) => [
        entry.cohortId,
        entry.studentRecords,
        `${money(entry.statedFees)} (${entry.statedFeeNulls})`,
        money(entry.statedTotalPaid),
        money(entry.sheetTotalsRowTotalPaid),
        `${entry.payments} / ${money(entry.paymentAmount)}`,
        money(entry.paymentCellsAmount),
        `${entry.installments} / ${money(entry.installmentAmount)}`,
        entry.conserved ? 'yes' : 'NO',
        entry.inconsistencies.map((item) => `${item.code} ${item.count}`).join('; ') || '—',
      ]),
    ),
    '',
  )
  const c = analysis.collections
  out.push(`## Collection readiness (scheduled through ${c.throughMonth}; as of ${c.asOf}; nothing sent)`, '')
  out.push(`Records by mode: ${Object.entries(c.modes).map(([key, value]) => `${key} ${value}`).join(', ')}.`, '')
  out.push(
    table(
      ['Cohort', 'Mode', 'Records', 'Calculable', 'Contact-ready', 'Calculable + contact-ready', 'Statuses', 'Reminder warranted (contact-ready)', 'Amount'],
      Object.entries(c.byCohort)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cohort, value]) => [
          cohort,
          value.mode,
          value.records,
          value.calculable,
          value.contactReady,
          value.calculableAndContactReady,
          Object.entries(value.statuses).map(([key, count]) => `${key} ${count}`).join(', '),
          `${value.reminderWarranted} (${value.reminderWarrantedContactReady})`,
          money(value.reminderAmount),
        ]),
    ),
    '',
  )
  for (const [cohort, value] of Object.entries(c.byCohort).sort(([a], [b]) => a.localeCompare(b))) {
    const notes = [
      ...Object.entries(value.cannotDetermine).map(([reason, count]) => `${count}× cannot determine: ${reason}`),
      ...Object.entries(value.flags).map(([flag, count]) => `${flag} ${count}`),
      ...(value.lateFeesPaidNotApplied > 0 ? [`late fees paid, not applied to the schedule: ${money(value.lateFeesPaidNotApplied)}`] : []),
    ]
    if (notes.length > 0) out.push(`- ${cohort}: ${notes.join('; ')}`)
  }
  out.push('')
  out.push('## Schedule month mapping (installment mode, validated per column)', '')
  out.push(
    table(
      ['Batch', 'Start', 'Columns → month', 'Deterministic'],
      analysis.scheduleMappings.map((mapping) => [
        mapping.batchName,
        mapping.startDate ?? '—',
        mapping.columns.map((column) => `${column.header.trim()} → ${column.yearMonth ?? '?'}`).join(', '),
        mapping.deterministic ? 'yes' : `NO: ${mapping.reasons.join('; ')}`,
      ]),
    ),
    '',
  )
  out.push('## Dated hosted payments of target students (reconciled)', '')
  out.push(
    table(
      ['Class', 'Payments', 'Amount', 'By target cohort', 'Preserved', 'Historical-receipt capable'],
      Object.entries(analysis.datedPayments).map(([klass, value]) => [klass, value.payments, money(value.amount), Object.entries(value.byCohort).map(([key, count]) => `${key} ${count}`).join(', '), value.preserved, value.historicalReceiptCapable]),
    ),
    '',
  )
  const r = analysis.receipts
  out.push('## Receipt readiness', '')
  out.push(`Payments carried by the cutover ${r.total} · deliberately NOT receipt-eligible (historical) ${r.historicalNotEligible} · eligible ${r.eligible}. Historical gaps: ${Object.entries(r.historicalGaps).map(([key, value]) => `${key} ${value}`).join(', ')}.`, '')
  out.push(table(['Cohort', 'Payments', 'Eligible'], Object.entries(r.byCohort).map(([key, value]) => [key, value.total, value.eligible])), '')
  out.push(`Receipt numbering configured: ${r.numbering.filter((entry) => entry.configured).map((entry) => entry.shortCode).join(', ') || 'none'}; not configured: ${r.numbering.filter((entry) => !entry.configured).map((entry) => entry.shortCode).join(', ') || 'none'}.`, '')
  out.push('## Issues', '')
  out.push(analysis.issues.length === 0 ? 'None.' : table(['Code', 'Blocking', 'Count', 'Detail'], analysis.issues.map((issue) => [issue.code, issue.blocking ? 'yes' : 'no', issue.count, issue.detail])), '')
  out.push(`Plan invariant violations: ${analysis.invariantViolations.length === 0 ? 'none' : analysis.invariantViolations.join('; ')}.`, '')
  out.push(`Blockers: ${analysis.blockers.length === 0 ? 'none' : analysis.blockers.join('; ')}.`, '')
  out.push('## Hashes', '')
  out.push(`- backup \`${analysis.hashes.backupFile}\` sha256 \`${analysis.hashes.backup}\``)
  out.push(`- restore \`${analysis.restore.file}\` sha256 \`${analysis.restore.sha256}\`${analysis.restore.verified === null ? '' : analysis.restore.verified ? ' (verified on pg_temp copies)' : ' (VERIFICATION FAILED)'}`)
  out.push(`- target dataset sha256 \`${analysis.hashes.target}\``)
  out.push(`- cutover plan sha256 \`${analysis.hashes.plan}\``)
  out.push(`- apply statement: ${analysis.sqlBytes} bytes, one DO block`)
  out.push(`- the command that WOULD apply: \`${analysis.applyCommand}\``, '')
  return `${out.join('\n')}\n`
}
