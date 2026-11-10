/**
 * FINANCE-CUTOVER-05A — the active-cohort cutover.
 *
 *   npm run finance:cutover                                   dry run (the default)
 *   npm run finance:cutover -- --refresh-backup               dry run, re-capturing the backup
 *   npm run finance:cutover -- --as-of=2026-10-21             readiness as of a date
 *   npm run finance:cutover -- --probe-sql                    dry run + prove the apply statement parses (no DML runs)
 *   npm run finance:cutover -- --verify-restore               dry run + verify every restore chunk on pg_temp copies (always rolled back)
 *   npm run finance:cutover -- --apply --plan-hash=<sha256>   the destructive cutover
 *
 * The dry run reads the replacement workbook, fingerprints the hosted
 * database through linked SQL, captures (or re-uses) and verifies the private
 * backup, builds the target dataset and the cutover plan, renders the single
 * atomic apply statement, and writes everything under
 * `.private/finance-cutover-05a/`. It writes nothing to Supabase and proves it
 * by fingerprinting every table again at the end.
 *
 * The apply rebuilds all of that from the then-current inputs and runs only if
 * every gate in `gates.mts` passes; the SQL itself re-checks the pre-state
 * inside the transaction and rolls back on any mismatch.
 *
 * Exit codes: 0 ok · 1 error · 2 source not usable · 3 workbook changed during
 * the run · 4 hosted changed during a dry run · 5 apply refused (nothing
 * written) · 6 apply rolled back (nothing written) · 7 apply committed but the
 * post-state does not verify.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import * as XLSX from 'xlsx'

import { findWorkbookCandidates, REFERENCE_DIR } from '../finance-import/lib/workbook-source.mts'
import { identifyWorkbook } from '../finance-contact/adapters/registry.mts'
import { isStagingStop, stageWorkbooks } from '../finance-contact/pipeline.mts'
import { DEFAULT_SCOPE_CONFIG } from '../finance-contact/scope.mts'

import { sha256Of, verifyBackupFiles, type HostedBackup } from './backup.mts'
import { backupPaths, ensureBackup } from './backup-step.mts'
import {
  AGGREGATE_FILE,
  ANALYSIS_FILE,
  BACKUP_FILE,
  BALANCE_POPULATION_FILE,
  DATED_PAYMENTS_FILE,
  EXPECTED_BASELINE,
  EXPECTED_WORKBOOK_SHA256,
  PLAN_FILE,
  PRIVATE_DIR,
  RESTORE_DIR,
  RESTORE_FILE,
  SQL_FILE,
  TARGET_FILE,
  TICKET,
} from './config.mts'
import { assessContacts } from './contacts.mts'
import { conserveCohorts } from './conservation.mts'
import { reconcileDatedPayments } from './dated-payments.mts'
import { baselineDifferences, evaluateGates, parseArguments } from './gates.mts'
import { executeLinkedSqlFile, linkedProjectRef, readStateFingerprint, runLinkedQuery, type StateFingerprint } from './hosted.mts'
import { parseCutoverWorkbook, recognizeCutoverWorkbook } from './parse.mts'
import { buildCutoverPlan, cutoverPlanHash } from './plan.mts'
import { assessCollections, assessReceipts, mapBatchSchedules, receiptNumberingByProgram, type CollectionAssessment } from './readiness.mts'
import { buildRestoreArtifacts, MAX_REQUEST_BYTES, RESTORE_VERIFY_MARKER } from './restore.mts'
import { buildAnalysis, renderAggregate } from './report.mts'
import { PROBE_MARKER, renderApplySql, renderColumnCheckSql, renderProbeSql } from './sql.mts'
import { buildTargetDataset, targetHash } from './target.mts'

import type { WorkBook } from 'xlsx'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface CutoverWorkbook {
  fileName: string
  relativePath: string
  sha256: string
  workbook: WorkBook
}

/**
 * Finds the cutover workbook among `reference/` by structure: exactly one file
 * must be recognised (cohort sheets, no Tracker Master) and not be claimed by
 * a contact-master adapter — the PSW master also holds Morning/Evening tables.
 * Filenames are never consulted.
 */
export function resolveCutoverWorkbook(repoRoot: string): CutoverWorkbook | { stop: string } {
  const recognized: CutoverWorkbook[] = []
  for (const fileName of findWorkbookCandidates(repoRoot)) {
    const absolute = path.join(repoRoot, REFERENCE_DIR, fileName)
    const buffer = readFileSync(absolute)
    const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellNF: true, cellText: true, cellDates: false, sheetStubs: true, dense: false })
    if (identifyWorkbook(workbook).adapter !== null) continue
    if (!recognizeCutoverWorkbook(workbook).recognized) continue
    recognized.push({
      fileName,
      relativePath: `${REFERENCE_DIR}/${fileName}`,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      workbook,
    })
  }
  if (recognized.length !== 1) {
    return { stop: `expected exactly one cutover workbook under ${REFERENCE_DIR}/, found ${recognized.length}` }
  }
  return recognized[0]
}

function hashFile(repoRoot: string, relativePath: string): string {
  return createHash('sha256').update(readFileSync(path.join(repoRoot, relativePath))).digest('hex')
}

/** sha256 of the restore manifest when it and every file it lists are on disk unchanged; null otherwise. */
function restoreOnDisk(privateDir: string): string | null {
  const manifestPath = path.join(privateDir, RESTORE_FILE)
  if (!existsSync(manifestPath)) return null
  const text = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(text) as { files: { file: string; sha256: string }[] }
  for (const entry of manifest.files) {
    const file = path.join(privateDir, RESTORE_DIR, entry.file)
    if (!existsSync(file) || sha256Of(readFileSync(file, 'utf8')) !== entry.sha256) return null
  }
  return sha256Of(text)
}

function readPreviousHash(file: string, key: string): string | null {
  if (!existsSync(file)) return null
  try {
    const value = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/** The reminder populations, frozen for 05B to verify against. Private: record ids and amounts. */
function balancePopulation(collections: readonly CollectionAssessment[], asOf: string): Record<string, unknown> {
  const reminders = collections
    .filter((entry) => entry.reminderKind !== null)
    .map((entry) => ({
      financeRecordId: entry.financeRecordId,
      cohortId: entry.cohortId,
      mode: entry.mode,
      reminderKind: entry.reminderKind,
      amount: entry.amountDue ?? entry.balanceOutstanding,
      contactReady: entry.contactReady,
    }))
  const body = { ticket: TICKET, asOf, reminders }
  return { ...body, sha256: sha256Of(JSON.stringify(body)) }
}

function todayIso(now: Date): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

function writePrivate(repoRoot: string, file: string, content: string): string {
  const dir = path.join(repoRoot, PRIVATE_DIR)
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, file)
  writeFileSync(target, content, 'utf8')
  return target
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
  log(`${TICKET} — ${args.apply ? 'APPLY requested' : 'dry run (writes nothing to Supabase)'}; readiness as of ${asOf}`)

  // --- Sources ----------------------------------------------------------------
  const resolved = resolveCutoverWorkbook(REPO_ROOT)
  if ('stop' in resolved) {
    console.error(`STOP: ${resolved.stop}`)
    return 2
  }
  log(`workbook: ${resolved.relativePath} · sha256 ${resolved.sha256}${resolved.sha256 === EXPECTED_WORKBOOK_SHA256 ? ' (approved)' : ' (NOT the approved workbook)'}`)
  if (resolved.sha256 !== EXPECTED_WORKBOOK_SHA256 && !args.apply) {
    console.error(`STOP: the workbook is not the approved replacement (${EXPECTED_WORKBOOK_SHA256}); a plan against it would be meaningless`)
    return 2
  }
  const parsed = parseCutoverWorkbook(resolved.workbook)

  const staging = stageWorkbooks(REPO_ROOT, DEFAULT_SCOPE_CONFIG)
  if (isStagingStop(staging)) {
    console.error(staging.message)
    return 2
  }
  const masters = staging.reports.filter((report) => report.adapterId !== null).map((report) => ({ fileName: report.fingerprint.fileName, sha256: report.fingerprint.sha256, program: report.adapterId as string }))

  // --- Hosted -----------------------------------------------------------------
  const live: StateFingerprint = readStateFingerprint(REPO_ROOT)
  log(`hosted: ${Object.entries(live.tables).map(([table, value]) => `${table}=${value.count}`).join(' ')} email≠NULL=${live.studentsEmailNonNull} phone≠NULL=${live.studentsPhoneNonNull}`)

  const paths = backupPaths(REPO_ROOT)
  let backupSha: string
  let backupDocument: HostedBackup
  if (args.apply) {
    // The apply never captures a backup: it must use the one that was reviewed.
    const verification = verifyBackupFiles(paths.backup, paths.manifest)
    if (!verification.ok || verification.backup === null || verification.sha256 === null) {
      const code = verification.problems.some((problem) => problem.includes('not found')) ? 'BACKUP_MISSING' : 'BACKUP_INVALID'
      console.error(`REFUSED ${code}: ${verification.problems.join('; ')}`)
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

  // --- Restore (from the backup alone; staged, see restore.mts) -------------
  const restore = buildRestoreArtifacts(backupDocument, backupSha)
  if (restore.localProblems.length > 0) {
    console.error(`STOP: the restore does not prove out offline: ${restore.localProblems.join('; ')}`)
    return 1
  }
  const restoreSha = restore.manifestSha256
  const restoreDir = path.join(REPO_ROOT, PRIVATE_DIR, RESTORE_DIR)
  if (!args.apply) {
    rmSync(restoreDir, { recursive: true, force: true })
    mkdirSync(path.join(restoreDir, 'verify'), { recursive: true })
    for (const entry of restore.files) writeFileSync(path.join(restoreDir, entry.file), entry.sql, 'utf8')
    for (const entry of restore.verifyFiles) writeFileSync(path.join(restoreDir, 'verify', entry.file), entry.sql, 'utf8')
    writePrivate(REPO_ROOT, RESTORE_FILE, restore.manifest)
    log(
      `restore: ${PRIVATE_DIR}/${RESTORE_FILE} · sha256 ${restoreSha} · ${restore.files.length} files ` +
        `(${restore.files.filter((entry) => entry.step === 'stage').length} stage, 1 swap, 1 cleanup; largest ${Math.max(...restore.files.map((entry) => entry.bytes))} bytes)`,
    )
  }
  let restoreVerified: boolean | null = null
  if (args.verifyRestore) {
    restoreVerified = true
    for (const entry of restore.verifyFiles) {
      const result = executeLinkedSqlFile(REPO_ROOT, path.join(restoreDir, 'verify', entry.file), 'write')
      const passed = !result.ok && result.output.includes(RESTORE_VERIFY_MARKER)
      const message = /RESTORE_VERIFY_(OK|FAILED)[^"\n\\]*/.exec(result.output)?.[0] ?? result.output.slice(0, 400)
      log(`  restore verification ${entry.file}: ${passed ? 'ok' : 'FAILED'} — ${message}`)
      if (!passed) {
        restoreVerified = false
        break
      }
    }
    log(`restore verification (pg_temp copies and a raise-first swap probe; always rolled back): ${restoreVerified ? 'PASSED' : 'FAILED'}`)
    if (!restoreVerified) return 1
  }

  // --- Target, analysis, plan -----------------------------------------------
  const target = buildTargetDataset({ parsed, workbook: { fileName: resolved.fileName, sha256: resolved.sha256 }, hosted })
  const tHash = targetHash(target)
  const targetStudentIds = [...new Set(target.links.map((link) => link.studentId))]
  const studentById = new Map<string, Record<string, unknown>>()
  for (const row of hosted.students) studentById.set(row.id, row)
  for (const row of target.inserts.students) studentById.set(row.id, row)
  const contacts = assessContacts(
    targetStudentIds.map((studentId) => ({ studentId, studentNumber: (studentById.get(studentId)?.student_number as string | null) ?? null })),
    staging.allRows,
    staging.shared,
  )
  const conservation = conserveCohorts({ parsedTables: parsed.tables, target, hosted })
  const mappings = mapBatchSchedules(target, hosted)
  const collections = assessCollections({ target, hosted, contacts, asOf, mappings })
  const receipts = assessReceipts({ target, hosted })
  const numbering = receiptNumberingByProgram(target, hosted)

  const plan = buildCutoverPlan({
    hosted,
    fingerprint: live,
    backup: { file: BACKUP_FILE, sha256: backupSha },
    restore: { file: RESTORE_FILE, sha256: restoreSha },
    target,
    targetHash: tHash,
    receiptNumbered: new Set(numbering.filter((entry) => entry.configured).map((entry) => entry.shortCode)),
  })
  const datedPayments = reconcileDatedPayments({
    target,
    hosted,
    deletedPaymentIds: plan.deletes.payments,
    receiptNumbered: new Set(numbering.filter((entry) => entry.configured).map((entry) => entry.shortCode)),
  })
  const pHash = cutoverPlanHash(plan)
  const blockers = [
    ...target.issues.filter((issue) => issue.blocking).map((issue) => `${issue.code}: ${issue.detail}`),
    ...plan.invariantViolations,
  ]

  const sql = renderApplySql(plan, pHash, target)
  if (Buffer.byteLength(sql, 'utf8') > MAX_REQUEST_BYTES) {
    blockers.push(`the apply statement is ${Buffer.byteLength(sql, 'utf8')} bytes, over the ${MAX_REQUEST_BYTES}-byte request ceiling`)
  }

  if (args.probeSql) {
    const missing = runLinkedQuery(REPO_ROOT, 'column-check.sql', renderColumnCheckSql(target)).rows[0]?.missing
    log(`column check: ${JSON.stringify(missing)} missing`)
    const probeFile = writePrivate(REPO_ROOT, 'cutover-probe.sql', renderProbeSql(sql))
    const probe = executeLinkedSqlFile(REPO_ROOT, probeFile, 'write')
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
      restoreSha256: restoreOnDisk(path.join(REPO_ROOT, PRIVATE_DIR)),
      plannedRestoreSha256: plan.restore.sha256,
      liveFingerprint: live,
      plannedPreState: plan.preState,
      recomputedPlanHash: pHash,
      blockers,
    })
    if (!gate.allowed) {
      for (const refusal of gate.refusals) console.error(`REFUSED ${refusal.code}: ${refusal.detail}`)
      console.error('nothing was written')
      return 5
    }
    const file = writePrivate(REPO_ROOT, `cutover-apply-${pHash.slice(0, 12)}.sql`, sql)
    log(`apply: executing ${path.relative(REPO_ROOT, file)} as one transaction`)
    const result = executeLinkedSqlFile(REPO_ROOT, file, 'write')
    writePrivate(REPO_ROOT, `cutover-apply-${pHash.slice(0, 12)}.log`, result.output)
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

  // --- Dry-run outputs (private) --------------------------------------------
  const analysis = buildAnalysis({
    asOf,
    workbook: { fileName: resolved.fileName, relativePath: resolved.relativePath, sha256: resolved.sha256 },
    masters,
    parsed,
    live,
    expectedBaseline: EXPECTED_BASELINE,
    target,
    targetHash: tHash,
    plan,
    planHash: pHash,
    backup: { file: path.relative(REPO_ROOT, paths.backup).split(path.sep).join('/'), sha256: backupSha },
    contacts,
    conservation,
    mappings,
    collections,
    receipts,
    numbering,
    restore: { file: `${PRIVATE_DIR}/${RESTORE_FILE}`, sha256: restoreSha, verified: restoreVerified },
    datedPayments,
    hosted,
    sqlBytes: Buffer.byteLength(sql, 'utf8'),
    blockers,
  })

  const previousPlanHash = readPreviousHash(path.join(REPO_ROOT, PRIVATE_DIR, PLAN_FILE), 'planSha256')
  const previousTargetHash = readPreviousHash(path.join(REPO_ROOT, PRIVATE_DIR, TARGET_FILE), 'targetSha256')
  writePrivate(REPO_ROOT, TARGET_FILE, `${JSON.stringify({ targetSha256: tHash, ...target }, null, 1)}\n`)
  writePrivate(REPO_ROOT, PLAN_FILE, `${JSON.stringify({ planSha256: pHash, ...plan }, null, 1)}\n`)
  writePrivate(REPO_ROOT, ANALYSIS_FILE, `${JSON.stringify({ ...analysis, contactsDetail: contacts, collectionsDetail: collections, receiptsDetail: receipts }, null, 1)}\n`)
  writePrivate(REPO_ROOT, SQL_FILE, sql)
  const aggregate = renderAggregate(analysis)
  writePrivate(REPO_ROOT, AGGREGATE_FILE, aggregate)
  writePrivate(REPO_ROOT, DATED_PAYMENTS_FILE, `${JSON.stringify({ ticket: TICKET, planSha256: pHash, payments: datedPayments }, null, 1)}
`)
  writePrivate(REPO_ROOT, BALANCE_POPULATION_FILE, `${JSON.stringify(balancePopulation(collections, asOf), null, 1)}\n`)

  // --- Prove the run was read-only ------------------------------------------
  const after = readStateFingerprint(REPO_ROOT)
  if (JSON.stringify(after) !== JSON.stringify(live)) {
    console.error('STOP: the hosted fingerprint changed during the dry run; the plan is already stale')
    return 4
  }
  if (hashFile(REPO_ROOT, resolved.relativePath) !== resolved.sha256) {
    console.error('STOP: the workbook changed on disk during the run')
    return 3
  }

  console.log(aggregate)
  const reread = verifyBackupFiles(paths.backup, paths.manifest)
  const check = (ok: boolean, line: string): void => log(`  [${ok ? 'ok' : 'FAIL'}] ${line}`)
  log('safety check:')
  check(reread.ok && reread.sha256 === backupSha, `backup parses and verifies; sha256 ${reread.sha256}`)
  check(
    restoreOnDisk(path.join(REPO_ROOT, PRIVATE_DIR)) === restoreSha,
    `restore manifest and every restore file on disk match; manifest sha256 ${restoreSha}${restoreVerified === null ? ' (verification not run this time)' : ' (verified on pg_temp copies)'}`,
  )
  check(
    previousTargetHash === null || previousTargetHash === tHash,
    `target dataset sha256 ${tHash}${previousTargetHash === null ? '' : previousTargetHash === tHash ? ' (same as previous run)' : ` (changed from ${previousTargetHash})`}`,
  )
  check(
    previousPlanHash === null || previousPlanHash === pHash,
    `cutover plan sha256 ${pHash}${previousPlanHash === null ? '' : previousPlanHash === pHash ? ' (same as previous run)' : ` (changed from ${previousPlanHash})`}`,
  )
  check(resolved.sha256 === EXPECTED_WORKBOOK_SHA256, `finance workbook sha256 unchanged (${resolved.sha256})`)
  check(
    JSON.stringify(after) === JSON.stringify(plan.preState) && JSON.stringify(after) === JSON.stringify(backupDocument.fingerprint),
    'live hosted fingerprint equals the planned pre-state and the backup fingerprint',
  )
  check(after.studentsEmailNonNull === 0 && after.studentsPhoneNonNull === 0 && after.tables.audit_log.count === 0, 'no contact apply has occurred (email/phone non-NULL 0, audit_log 0)')
  check(baselineDifferences(after).length === 0, 'no destructive cutover has occurred (live counts equal the pre-cutover baseline)')
  return 0
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
