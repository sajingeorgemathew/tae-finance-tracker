/**
 * FINANCE-CUTOVER-05A — narrowed, NON-DESTRUCTIVE first live launch:
 * PSW June, August and September 2026 only (`LAUNCH_SCOPE` in config.mts).
 *
 *   npm run finance:cutover:launch                                   dry run (the default)
 *   npm run finance:cutover:launch -- --as-of=2026-11-02             readiness as of a date
 *   npm run finance:cutover:launch -- --probe-sql                    dry run + prove the apply statement parses (no DML runs)
 *   npm run finance:cutover:launch -- --verify-restore               dry run + verify every restore chunk on pg_temp copies
 *   npm run finance:cutover:launch -- --apply --plan-hash=<sha256>   the scoped apply
 *
 * Same machinery as `cutover.mts` — workbook parsing, exact-number students,
 * cell payments, the private backup and staged restore, the gates, the single
 * atomic DO block — with a scope: only the superseded hosted June/August
 * batch tables (records, installments, payments, column layout) are
 * replaced; September is new; every other hosted row, and every hosted
 * student, is retained by id. Nothing is ever emailed or receipted.
 *
 * Output: `.private/finance-cutover-05a/launch-jas/` (the full plan's files
 * beside it are left alone). Exit codes as in `cutover.mts`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { isStagingStop, stageWorkbooks } from '../finance-contact/pipeline.mts'
import { DEFAULT_SCOPE_CONFIG } from '../finance-contact/scope.mts'

import { sha256Of, verifyBackupFiles, type HostedBackup } from './backup.mts'
import { backupPaths, ensureBackup } from './backup-step.mts'
import { BACKUP_FILE, EXPECTED_WORKBOOK_SHA256, LAUNCH_EXPECTED_BASELINE, LAUNCH_SCOPE, PRIVATE_DIR, RESTORE_DIR, RESTORE_FILE, TARGET_COHORTS, TICKET, type BackupTable, type TargetScope } from './config.mts'
import { assessContacts, type ContactAssessment } from './contacts.mts'
import { conserveCohorts } from './conservation.mts'
import { resolveCutoverWorkbook } from './cutover.mts'
import { reconcileDatedPayments } from './dated-payments.mts'
import { evaluateGates, parseArguments } from './gates.mts'
import { executeLinkedSqlFile, linkedProjectRef, readStateFingerprint, runLinkedQuery, type BackupRow } from './hosted.mts'
import { parseCutoverWorkbook, studentRows } from './parse.mts'
import { buildCutoverPlan, cutoverPlanHash, type CutoverPlan } from './plan.mts'
import { assessCollections, mapBatchSchedules, receiptNumberingByProgram, type CollectionAssessment } from './readiness.mts'
import { buildRestoreArtifacts, MAX_REQUEST_BYTES, RESTORE_VERIFY_MARKER } from './restore.mts'
import { PROBE_MARKER, renderApplySql, renderColumnCheckSql, renderProbeSql } from './sql.mts'
import { buildTargetDataset, hostedBatchesOfCohort, targetHash, type TargetDataset } from './target.mts'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_DIR = path.join(REPO_ROOT, PRIVATE_DIR, LAUNCH_SCOPE.privateSubdir)

export const SCOPE: TargetScope = { id: LAUNCH_SCOPE.id, cohortIds: [...LAUNCH_SCOPE.cohortIds], preserveOutsideScope: true }

const round = (value: number): number => Math.round(value * 100) / 100
const money = (value: number): string => `$${value.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Contact class names as the launch brief spells them. */
function launchContactClass(status: string): string {
  if (status === 'CONTACT_INVALID') return 'INVALID_CONTACT'
  if (status === 'CONTACT_AMBIGUOUS') return 'CONTACT_SHARED_REVIEW'
  return status
}

export interface LaunchCohortSummary {
  cohortId: string
  label: string
  batches: { name: string; records: number }[]
  sourceStudentRows: number
  namedRows: number
  missingStudentNumbers: number
  students: number
  financeRecords: number
  installments: number
  installmentAmount: number
  payments: number
  paymentAmount: number
  statedFees: number
  statedTotalPaid: number
  sheetTotalsRowTotalPaid: number | null
  paymentsEqualCells: boolean
  contacts: Record<string, number>
  collections: {
    throughMonth: string
    current: number
    owing: number
    amountDue: number
    ahead: number
    aheadAmount: number
    cannotDetermine: number
    owingContactReady: number
    owingContactReadyAmount: number
    owingContactMissing: number
    owingContactMissingAmount: number
    remainingBalance: number
  }
  resolutions: Record<string, number>
}

export function summarizeLaunch(input: {
  target: TargetDataset
  hosted: Record<BackupTable, BackupRow[]>
  parsedTables: ReturnType<typeof parseCutoverWorkbook>['tables']
  contacts: readonly ContactAssessment[]
  collections: readonly CollectionAssessment[]
  conservation: ReturnType<typeof conserveCohorts>
  asOf: string
}): LaunchCohortSummary[] {
  const { target, contacts, collections, conservation } = input
  const contactByStudent = new Map(contacts.map((contact) => [contact.studentId, contact]))
  const collectionByRecord = new Map(collections.map((entry) => [entry.financeRecordId, entry]))
  const recordById = new Map(target.inserts.student_finance_records.map((row) => [row.id, row]))
  const batchById = new Map(target.inserts.batches.map((row) => [row.id, row]))
  const installmentsByRecord = new Map<string, number[]>()
  for (const row of target.inserts.installments) installmentsByRecord.set(String(row.student_finance_record_id), [...(installmentsByRecord.get(String(row.student_finance_record_id)) ?? []), Number(row.scheduled_amount ?? 0)])
  const paymentsByRecord = new Map<string, number[]>()
  for (const row of target.inserts.payments) paymentsByRecord.set(String(row.student_finance_record_id), [...(paymentsByRecord.get(String(row.student_finance_record_id)) ?? []), Number(row.amount)])

  return target.cohorts.map((cohort): LaunchCohortSummary => {
    const links = target.links.filter((link) => link.cohortId === cohort.id)
    const tables = input.parsedTables.filter((table) => table.cohort?.id === cohort.id)
    const rows = tables.flatMap((table) => studentRows(table))
    const conserved = conservation.find((entry) => entry.cohortId === cohort.id)
    const contactCounts: Record<string, number> = {}
    const resolutions: Record<string, number> = {}
    for (const link of links) {
      const status = launchContactClass(contactByStudent.get(link.studentId)?.status ?? 'UNKNOWN')
      contactCounts[status] = (contactCounts[status] ?? 0) + 1
      resolutions[link.resolution] = (resolutions[link.resolution] ?? 0) + 1
    }
    const entries = links.map((link) => collectionByRecord.get(link.financeRecordId) as CollectionAssessment)
    const owing = entries.filter((entry) => entry.status === 'AMOUNT_DUE_THROUGH_MONTH')
    const ahead = entries.filter((entry) => entry.status === 'CREDIT_AHEAD')
    const sumDue = (list: readonly CollectionAssessment[]): number => round(list.reduce((total, entry) => total + (entry.amountDue ?? 0), 0))
    const remaining = round(
      links.reduce((total, link) => {
        const scheduled = (installmentsByRecord.get(link.financeRecordId) ?? []).reduce((a, b) => a + b, 0)
        const paid = (paymentsByRecord.get(link.financeRecordId) ?? []).reduce((a, b) => a + b, 0)
        const fee = recordById.get(link.financeRecordId)?.legacy_total_fee
        const basis = scheduled > 0 ? scheduled : typeof fee === 'number' ? fee : 0
        return total + Math.max(0, basis - paid)
      }, 0),
    )
    const batchRecords = new Map<string, number>()
    for (const link of links) batchRecords.set(link.batchId, (batchRecords.get(link.batchId) ?? 0) + 1)
    return {
      cohortId: cohort.id,
      label: cohort.label,
      batches: cohort.batchIds.map((id) => ({ name: String(batchById.get(id)?.name ?? id), records: batchRecords.get(id) ?? 0 })),
      sourceStudentRows: rows.length,
      namedRows: rows.filter((row) => row.named).length,
      missingStudentNumbers: rows.filter((row) => row.studentNumber === null).length,
      students: new Set(links.map((link) => link.studentId)).size,
      financeRecords: links.length,
      installments: links.reduce((total, link) => total + (installmentsByRecord.get(link.financeRecordId)?.length ?? 0), 0),
      installmentAmount: round(links.reduce((total, link) => total + (installmentsByRecord.get(link.financeRecordId) ?? []).reduce((a, b) => a + b, 0), 0)),
      payments: links.reduce((total, link) => total + (paymentsByRecord.get(link.financeRecordId)?.length ?? 0), 0),
      paymentAmount: round(links.reduce((total, link) => total + (paymentsByRecord.get(link.financeRecordId) ?? []).reduce((a, b) => a + b, 0), 0)),
      statedFees: conserved?.statedFees ?? 0,
      statedTotalPaid: conserved?.statedTotalPaid ?? 0,
      sheetTotalsRowTotalPaid: conserved?.sheetTotalsRowTotalPaid ?? null,
      paymentsEqualCells: conserved !== undefined && conserved.paymentCellsAmount === conserved.paymentAmount,
      contacts: Object.fromEntries(Object.entries(contactCounts).sort(([a], [b]) => a.localeCompare(b))),
      collections: {
        throughMonth: input.asOf.slice(0, 7),
        current: entries.filter((entry) => entry.status === 'CURRENT').length,
        owing: owing.length,
        amountDue: sumDue(owing),
        ahead: ahead.length,
        aheadAmount: round(-ahead.reduce((total, entry) => total + (entry.amountDue ?? 0), 0)) || 0,
        cannotDetermine: entries.filter((entry) => entry.status === 'CANNOT_DETERMINE').length,
        owingContactReady: owing.filter((entry) => entry.contactReady).length,
        owingContactReadyAmount: sumDue(owing.filter((entry) => entry.contactReady)),
        owingContactMissing: owing.filter((entry) => !entry.contactReady).length,
        owingContactMissingAmount: sumDue(owing.filter((entry) => !entry.contactReady)),
        remainingBalance: remaining,
      },
      resolutions,
    }
  })
}

function write(file: string, content: string): string {
  mkdirSync(OUT_DIR, { recursive: true })
  const target = path.join(OUT_DIR, file)
  writeFileSync(target, content, 'utf8')
  return target
}

function restoreOnDisk(dir: string): string | null {
  const manifestPath = path.join(dir, RESTORE_FILE)
  if (!existsSync(manifestPath)) return null
  const text = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(text) as { files: { file: string; sha256: string }[] }
  for (const entry of manifest.files) {
    const file = path.join(dir, RESTORE_DIR, entry.file)
    if (!existsSync(file) || sha256Of(readFileSync(file, 'utf8')) !== entry.sha256) return null
  }
  return sha256Of(text)
}

function todayIso(now: Date): string {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

export async function main(argv: readonly string[]): Promise<number> {
  const log = (line: string): void => console.log(line)
  const args = parseArguments(argv)
  if (args.unknown.length > 0) {
    console.error(`unknown argument(s): ${args.unknown.join(' ')}`)
    return 1
  }
  const now = new Date()
  const asOf = args.asOf ?? todayIso(now)
  log(`${TICKET} narrowed launch ${SCOPE.id} — ${args.apply ? 'APPLY requested' : 'dry run (writes nothing to Supabase)'}; readiness as of ${asOf}`)

  const resolved = resolveCutoverWorkbook(REPO_ROOT)
  if ('stop' in resolved) {
    console.error(`STOP: ${resolved.stop}`)
    return 2
  }
  if (resolved.sha256 !== EXPECTED_WORKBOOK_SHA256) {
    console.error(`STOP: ${resolved.relativePath} is not the approved replacement workbook (${resolved.sha256})`)
    return 2
  }
  const parsed = parseCutoverWorkbook(resolved.workbook)
  const staging = stageWorkbooks(REPO_ROOT, DEFAULT_SCOPE_CONFIG)
  if (isStagingStop(staging)) {
    console.error(staging.message)
    return 2
  }

  // --- Hosted + backup (read-only) --------------------------------------------
  const live = readStateFingerprint(REPO_ROOT)
  log(`hosted: ${Object.entries(live.tables).map(([table, value]) => `${table}=${value.count}`).join(' ')} email≠NULL=${live.studentsEmailNonNull} phone≠NULL=${live.studentsPhoneNonNull}`)
  const paths = backupPaths(REPO_ROOT)
  let backupSha: string
  let backupDocument: HostedBackup
  if (args.apply) {
    const verification = verifyBackupFiles(paths.backup, paths.manifest)
    if (!verification.ok || verification.backup === null || verification.sha256 === null) {
      console.error(`REFUSED BACKUP_INVALID: ${verification.problems.join('; ')}`)
      console.error('nothing was written')
      return 5
    }
    backupSha = verification.sha256
    backupDocument = verification.backup
  } else {
    const ensured = ensureBackup(REPO_ROOT, linkedProjectRef(REPO_ROOT), live, { refresh: args.refreshBackup, now, log })
    backupSha = ensured.verification.sha256 as string
    backupDocument = ensured.verification.backup as HostedBackup
  }
  const hosted = backupDocument.tables

  // --- Restore: a full restore of the backup, staged (restore.mts) -----------
  const restore = buildRestoreArtifacts(backupDocument, backupSha)
  if (restore.localProblems.length > 0) {
    console.error(`STOP: the restore does not prove out offline: ${restore.localProblems.join('; ')}`)
    return 1
  }
  const restoreDir = path.join(OUT_DIR, RESTORE_DIR)
  if (!args.apply) {
    rmSync(restoreDir, { recursive: true, force: true })
    mkdirSync(path.join(restoreDir, 'verify'), { recursive: true })
    for (const entry of restore.files) writeFileSync(path.join(restoreDir, entry.file), entry.sql, 'utf8')
    for (const entry of restore.verifyFiles) writeFileSync(path.join(restoreDir, 'verify', entry.file), entry.sql, 'utf8')
    write(RESTORE_FILE, restore.manifest)
  }
  let restoreVerified: boolean | null = null
  if (args.verifyRestore) {
    restoreVerified = true
    for (const entry of restore.verifyFiles) {
      const result = executeLinkedSqlFile(REPO_ROOT, path.join(restoreDir, 'verify', entry.file), 'write')
      const passed = !result.ok && result.output.includes(RESTORE_VERIFY_MARKER)
      log(`  restore verification ${entry.file}: ${passed ? 'ok' : 'FAILED'}`)
      if (!passed) {
        restoreVerified = false
        break
      }
    }
    if (!restoreVerified) return 1
  }

  // --- Scoped target and plan -----------------------------------------------
  const target = buildTargetDataset({ parsed, workbook: { fileName: resolved.fileName, sha256: resolved.sha256 }, hosted, scope: SCOPE })
  const tHash = targetHash(target)
  const numbering = receiptNumberingByProgram(target, hosted)
  const receiptNumbered = new Set(numbering.filter((entry) => entry.configured).map((entry) => entry.shortCode))
  const plan: CutoverPlan = buildCutoverPlan({
    hosted,
    fingerprint: live,
    backup: { file: BACKUP_FILE, sha256: backupSha },
    restore: { file: `${LAUNCH_SCOPE.privateSubdir}/${RESTORE_FILE}`, sha256: restore.manifestSha256 },
    target,
    targetHash: tHash,
    receiptNumbered,
    scope: SCOPE,
  })
  const pHash = cutoverPlanHash(plan)
  const blockers = [...target.issues.filter((issue) => issue.blocking).map((issue) => `${issue.code}: ${issue.detail}`), ...plan.invariantViolations]
  // Non-destructive outside the scope: nothing but the replaced tables may go.
  if (plan.deletes.students.length > 0) blockers.push(`the narrowed plan would delete ${plan.deletes.students.length} student(s)`)
  const replacedBatchIds = new Set(TARGET_COHORTS.filter((cohort) => SCOPE.cohortIds.includes(cohort.id)).flatMap((cohort) => hostedBatchesOfCohort(hosted, cohort).map((batch) => batch.id)))
  const strayBatch = plan.deletes.batches.filter((id) => !replacedBatchIds.has(id))
  if (strayBatch.length > 0) blockers.push(`${strayBatch.length} batch delete(s) outside the launch cohorts`)

  const sql = renderApplySql(plan, pHash, target).replace(/FINANCE-CUTOVER-05A apply\./, `FINANCE-CUTOVER-05A narrowed launch ${SCOPE.id} apply.`)
  if (Buffer.byteLength(sql, 'utf8') > MAX_REQUEST_BYTES) blockers.push(`the apply statement is ${Buffer.byteLength(sql, 'utf8')} bytes, over the request ceiling`)

  if (args.probeSql) {
    const missing = runLinkedQuery(REPO_ROOT, 'column-check.sql', renderColumnCheckSql(target)).rows[0]?.missing
    log(`column check: ${JSON.stringify(missing)} missing`)
    const probe = executeLinkedSqlFile(REPO_ROOT, write('launch-probe.sql', renderProbeSql(sql)), 'write')
    const passed = !probe.ok && probe.output.includes(PROBE_MARKER)
    log(`probe: ${passed ? 'payload accepted and parsed; raised before any statement ran' : `UNEXPECTED: ${probe.output.slice(0, 600)}`}`)
    if (!passed) return 1
  }

  if (args.apply) {
    const verification = verifyBackupFiles(paths.backup, paths.manifest)
    const gate = evaluateGates({
      apply: true,
      requestedPlanHash: args.planHash,
      workbookSha256: resolved.sha256,
      backup: { present: verification.backup !== null, ok: verification.ok, sha256: verification.sha256, problems: verification.problems },
      plannedBackupSha256: plan.backup.sha256,
      restoreSha256: restoreOnDisk(OUT_DIR),
      plannedRestoreSha256: plan.restore.sha256,
      liveFingerprint: live,
      plannedPreState: plan.preState,
      recomputedPlanHash: pHash,
      blockers,
      expectedBaseline: LAUNCH_EXPECTED_BASELINE,
    })
    if (!gate.allowed) {
      for (const refusal of gate.refusals) console.error(`REFUSED ${refusal.code}: ${refusal.detail}`)
      console.error('nothing was written')
      return 5
    }
    const file = write(`launch-apply-${pHash.slice(0, 12)}.sql`, sql)
    log(`apply: executing ${path.relative(REPO_ROOT, file)} as one transaction`)
    const result = executeLinkedSqlFile(REPO_ROOT, file, 'write')
    write(`launch-apply-${pHash.slice(0, 12)}.log`, result.output)
    if (!result.ok) {
      console.error('apply: the statement failed and rolled back; nothing was written. See the private log.')
      return 6
    }
    const after = readStateFingerprint(REPO_ROOT)
    const mismatches = Object.entries(plan.expectedPost).filter(([key, expected]) => {
      const actual = key in after.tables ? after.tables[key as keyof typeof after.tables].count : (after as unknown as Record<string, number>)[key]
      return actual !== expected
    })
    if (mismatches.length > 0) {
      console.error(`apply committed but the post-state does not verify: ${mismatches.map(([key]) => key).join(', ')}`)
      return 7
    }
    log('apply: committed; post-state verified against the plan')
    return 0
  }

  // --- Readiness -------------------------------------------------------------
  const studentById = new Map<string, Record<string, unknown>>()
  for (const row of hosted.students) studentById.set(row.id, row)
  for (const row of target.inserts.students) studentById.set(row.id, row)
  const targetStudentIds = [...new Set(target.links.map((link) => link.studentId))]
  const contacts = assessContacts(
    targetStudentIds.map((studentId) => ({ studentId, studentNumber: (studentById.get(studentId)?.student_number as string | null) ?? null })),
    staging.allRows,
    staging.shared,
  )
  const conservation = conserveCohorts({ parsedTables: parsed.tables.filter((table) => table.cohort !== null && SCOPE.cohortIds.includes(table.cohort.id)), target, hosted })
  const mappings = mapBatchSchedules(target, hosted)
  const collections = assessCollections({ target, hosted, contacts, asOf, mappings })
  const cohorts = summarizeLaunch({ target, hosted, parsedTables: parsed.tables, contacts, collections, conservation, asOf })

  // Every dated hosted payment of a launch student: on a replaced record (deleted
  // by the plan, classified) or on a record the launch keeps (untouched).
  const targetStudents = new Set(targetStudentIds)
  const recordById = new Map(hosted.student_finance_records.map((row) => [row.id, row]))
  const deleted = new Set(plan.deletes.payments)
  const datedIds = hosted.payments
    .filter((row) => row.payment_date !== null && targetStudents.has(String(recordById.get(String(row.student_finance_record_id))?.student_id)))
    .map((row) => row.id)
  const dated = reconcileDatedPayments({ target, hosted, deletedPaymentIds: datedIds, receiptNumbered }).map((entry) => ({
    ...entry,
    onReplacedRecord: deleted.has(entry.paymentId),
    hostedRecordBatch: entry.hostedRecordBatch ?? 'unassigned (no batch)',
  }))
  const datedSummary: Record<string, { payments: number; amount: number }> = {}
  for (const entry of dated) {
    const key = `${entry.onReplacedRecord ? 'replaced-record' : 'kept-record'}:${entry.class}`
    const slot = (datedSummary[key] ??= { payments: 0, amount: 0 })
    slot.payments += 1
    slot.amount = round(slot.amount + entry.amount)
  }

  const studentsWithOtherEnrollments = targetStudentIds.filter((id) =>
    hosted.student_finance_records.some((row) => String(row.student_id) === id && !deleted.has(row.id) && plan.deletes.student_finance_records.indexOf(row.id) === -1),
  ).length
  const orphanedStudents = hosted.students.filter(
    (student) =>
      !targetStudents.has(student.id) &&
      hosted.student_finance_records.some((row) => String(row.student_id) === student.id) &&
      hosted.student_finance_records.filter((row) => String(row.student_id) === student.id).every((row) => plan.deletes.student_finance_records.includes(row.id)),
  ).length

  const totals = {
    students: cohorts.reduce((a, c) => a + c.students, 0),
    financeRecords: cohorts.reduce((a, c) => a + c.financeRecords, 0),
    installments: cohorts.reduce((a, c) => a + c.installments, 0),
    payments: cohorts.reduce((a, c) => a + c.payments, 0),
    paymentAmount: round(cohorts.reduce((a, c) => a + c.paymentAmount, 0)),
    owing: cohorts.reduce((a, c) => a + c.collections.owing, 0),
    amountDue: round(cohorts.reduce((a, c) => a + c.collections.amountDue, 0)),
    owingContactReady: cohorts.reduce((a, c) => a + c.collections.owingContactReady, 0),
    owingContactReadyAmount: round(cohorts.reduce((a, c) => a + c.collections.owingContactReadyAmount, 0)),
    owingContactMissing: cohorts.reduce((a, c) => a + c.collections.owingContactMissing, 0),
    owingContactMissingAmount: round(cohorts.reduce((a, c) => a + c.collections.owingContactMissingAmount, 0)),
  }
  const receiptEligibleHistorical = target.inserts.payments.filter((row) => row.source !== 'legacy_import').length

  const analysis = {
    ticket: TICKET,
    scope: SCOPE,
    asOf,
    workbook: { file: resolved.relativePath, sha256: resolved.sha256 },
    backup: { sha256: backupSha, capturedAt: (backupDocument as unknown as { capturedAt?: string }).capturedAt ?? null },
    restore: { manifestSha256: restore.manifestSha256, files: restore.files.length, verified: restoreVerified },
    targetSha256: tHash,
    planSha256: pHash,
    counts: plan.counts,
    expectedPost: plan.expectedPost,
    expectedCollectionModes: plan.expectedCollectionModes,
    removedBatches: plan.removedBatches,
    cohorts,
    totals,
    datedPayments: datedSummary,
    studentsWithOtherKeptEnrollments: studentsWithOtherEnrollments,
    hostedStudentsLeftWithoutRecord: orphanedStudents,
    issues: target.issues,
    receiptNumbering: numbering,
    historicalPaymentsReceiptEligible: receiptEligibleHistorical,
    mappings: mappings.map((mapping) => ({ batch: mapping.batchName, start: mapping.startDate, deterministic: mapping.deterministic, columns: mapping.columns.map((column) => `${column.header}→${column.yearMonth}`) })),
    sqlBytes: Buffer.byteLength(sql, 'utf8'),
    blockers,
  }

  write('launch-target.json', `${JSON.stringify({ targetSha256: tHash, ...target }, null, 1)}\n`)
  write('launch-plan.json', `${JSON.stringify({ planSha256: pHash, ...plan }, null, 1)}\n`)
  write('launch-analysis.json', `${JSON.stringify({ ...analysis, contactsDetail: contacts, collectionsDetail: collections, datedPaymentsDetail: dated }, null, 1)}\n`)
  write('launch-apply.sql', sql)

  const after = readStateFingerprint(REPO_ROOT)
  if (JSON.stringify(after) !== JSON.stringify(live)) {
    console.error('STOP: the hosted fingerprint changed during the dry run; the plan is already stale')
    return 4
  }

  log('')
  log(`backup sha256 ${backupSha} · restore manifest ${restore.manifestSha256} (${restore.files.length} files)${restoreVerified === null ? '' : restoreVerified ? ' verified' : ' NOT verified'}`)
  log(`target sha256 ${tHash}`)
  log(`plan sha256   ${pHash}`)
  log(`apply statement ${analysis.sqlBytes} bytes`)
  log('')
  log('table | current | delete | insert | target')
  for (const table of Object.keys(plan.counts.current) as BackupTable[]) {
    log(`${table} | ${plan.counts.current[table]} | ${plan.counts.delete[table]} | ${plan.counts.insert[table]} | ${plan.counts.target[table]}`)
  }
  log(`removed batches: ${plan.removedBatches.map((batch) => `${batch.name} (${batch.records})`).join('; ')}`)
  log(`collection modes after: ${JSON.stringify(plan.expectedCollectionModes)}`)
  log('')
  for (const cohort of cohorts) {
    const c = cohort.collections
    log(`${cohort.label}: source rows ${cohort.sourceStudentRows} (named ${cohort.namedRows}, no number ${cohort.missingStudentNumbers}) · students ${cohort.students} · records ${cohort.financeRecords} · installments ${cohort.installments} (${money(cohort.installmentAmount)}) · payments ${cohort.payments} (${money(cohort.paymentAmount)}; cells equal: ${cohort.paymentsEqualCells})`)
    log(`  fees ${money(cohort.statedFees)} · row Total Paid ${money(cohort.statedTotalPaid)} · totals-row Total Paid ${cohort.sheetTotalsRowTotalPaid === null ? '—' : money(cohort.sheetTotalsRowTotalPaid)} · batches ${cohort.batches.map((b) => `${b.name}=${b.records}`).join(', ')}`)
    log(`  contacts ${JSON.stringify(cohort.contacts)} · resolution ${JSON.stringify(cohort.resolutions)}`)
    log(`  through ${c.throughMonth}: current ${c.current} · owing ${c.owing} (${money(c.amountDue)}) · ahead ${c.ahead} (${money(c.aheadAmount)}) · cannot determine ${c.cannotDetermine} · owing+ready ${c.owingContactReady} (${money(c.owingContactReadyAmount)}) · owing+missing ${c.owingContactMissing} (${money(c.owingContactMissingAmount)}) · remaining ${money(c.remainingBalance)}`)
  }
  log(`TOTAL: ${JSON.stringify(totals)}`)
  log(`dated hosted payments of launch students: ${JSON.stringify(datedSummary)}`)
  log(`launch students with another kept hosted enrollment: ${studentsWithOtherEnrollments} · hosted students left with no record: ${orphanedStudents}`)
  log(`issues: ${target.issues.map((issue) => `${issue.code}×${issue.count}${issue.blocking ? ' BLOCKING' : ''}`).join(', ')}`)
  log(`blockers: ${blockers.length === 0 ? 'none' : blockers.join(' | ')}`)
  return blockers.length === 0 ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error))
      process.exit(1)
    },
  )
}
