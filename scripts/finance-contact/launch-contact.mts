/**
 * FINANCE-CONTACT-05B — contact fill for the live launch cohorts
 * (PSW June, August, September 2026).
 *
 * SUPERSEDED (2026-11-10) by FINANCE-STUDENT-SYNC-05B: `--apply` is always
 * refused (`supersededRefusal`). Current student data goes through
 * `npm run finance:student-sync`; this dry run is kept as a cross-check only.
 *
 *   npm run finance:contact-launch                                   dry run (the default)
 *   npm run finance:contact-launch -- --as-of=2026-11-10             owing figures as of a date
 *   npm run finance:contact-launch -- --apply --plan-hash=<sha256>   the reviewed apply
 *
 * A NEW plan against post-cutover hosted data; the 04B2 220-student plan is
 * never read or reused. Same staging, engine, field decisions, RPC and gate as
 * 04B2 (`contact-apply.mts`), narrowed to the hosted launch students:
 *
 *  * hosted reads go through the admin's own RLS-enforced session;
 *  * master rows join by exact student number only;
 *  * each write is one `public.apply_student_contact_fill` call (fills NULL
 *    fields only, raises STALE_TARGET otherwise, writes its audit row in the
 *    same transaction);
 *  * `--apply` rebuilds the plan from live sources and hosted state and refuses
 *    unless its hash equals the reviewed one.
 *
 * Owing amounts reuse the 05A collection rule (scheduled through the as-of
 * month minus paid toward the schedule) on hosted rows. They are reported,
 * not hashed: a payment recorded between review and apply changes the
 * payments count, which already changes the hash.
 *
 * Private output (PII): `.private/finance-contact/contact-05b-*`.
 * Exit codes as in `contact-apply.mts`.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { BACKUP_TABLES, type BackupTable } from '../finance-cutover/config.mts'
import type { BackupRow } from '../finance-cutover/hosted.mts'
import { assessCollections, mapBatchSchedules, type CollectionAssessment } from '../finance-cutover/readiness.mts'
import { INSERT_TABLES, type TargetDataset } from '../finance-cutover/target.mts'
import { selectAll } from '../finance-qa/hosted-reads.mts'
import { openHostedSession, type HostedSession } from '../finance-qa/hosted-session.mts'

import { parseTitleDate } from './adapters/title-date.mts'
import { executeApply, hasFill, type RpcArguments, type RpcResult } from './apply-plan.mts'
import { parseArguments as parseApplyArguments, postApplyChecks, resolveApplyGate, RPC_NAME } from './contact-apply.mts'
import {
  buildLaunchContactPlan,
  LAUNCH_CONTACT_SCOPE,
  LAUNCH_COHORTS,
  LAUNCH_STATUSES,
  launchPlanHash,
  owingSummary,
  resolveLaunchScope,
  TICKET_05B,
  type LaunchContactPlan,
  type LaunchRecordRow,
} from './launch-plan.mts'
import { contactCounts, INTEGRITY_TABLES, integrityCounts, isStagingStop, readHosted, snapshotFromReads, stageWorkbooks } from './pipeline.mts'
import { classifyRows, findHostedDuplicateNumbers } from './reconcile.mts'
import { hashReferenceFile } from './sources.mts'

const PRIVATE_DIR = path.join('.private', 'finance-contact')

/** Plans this CLI produced that were reviewed and then superseded. Never apply. */
export const SUPERSEDED_PLAN_HASHES = ['a2a5a09633dbdc0d78eead1da679362ecd885ec771f8836da915e38521080fec'] as const

/**
 * FINANCE-STUDENT-SYNC-05B superseded this ticket: the old PSW master is not
 * authoritative, so an apply is refused before anything is read or written,
 * whatever hash is given. The dry run stays as a cross-check report.
 */
export function supersededRefusal(mode: 'dry-run' | 'apply' | 'refuse'): string | null {
  if (mode !== 'apply') return null
  return (
    `REFUSED: ${TICKET_05B} is superseded by FINANCE-STUDENT-SYNC-05B; its plans (${SUPERSEDED_PLAN_HASHES.join(', ')}) must never be applied. ` +
    'Use npm run finance:student-sync with a current student file. Nothing was read or written.'
  )
}
const PLAN_FILE = 'contact-05b-plan.json'
const REPORT_FILE = 'contact-05b-dry-run.json'
const RESULT_FILE = 'contact-05b-apply-result.json'

const money = (value: number): string => `$${value.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

function splitArguments(argv: readonly string[]): { asOf: string; rest: string[]; error: string | null } {
  let asOf = new Date().toISOString().slice(0, 10)
  const rest: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('--as-of=')) asOf = arg.slice('--as-of='.length)
    else rest.push(arg)
  }
  return { asOf, rest, error: /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? null : `--as-of must be YYYY-MM-DD, got ${asOf}` }
}

/** Every hosted row the owing rule needs, shaped as the 05A readiness code expects. */
async function readFinanceRows(session: HostedSession, recordIds: ReadonlySet<string>): Promise<Record<BackupTable, BackupRow[]>> {
  const out = Object.fromEntries(BACKUP_TABLES.map((table) => [table, [] as BackupRow[]])) as Record<BackupTable, BackupRow[]>
  out.programs = await selectAll<BackupRow>(session.client, 'programs', '*', 'id')
  out.batches = await selectAll<BackupRow>(session.client, 'batches', '*', 'id')
  out.students = await selectAll<BackupRow>(session.client, 'students', 'id, student_number', 'id')
  out.student_finance_records = (await selectAll<BackupRow>(session.client, 'student_finance_records', '*', 'id')).filter((row) => recordIds.has(row.id))
  out.installments = (await selectAll<BackupRow>(session.client, 'installments', '*', 'id')).filter((row) => recordIds.has(String(row.student_finance_record_id)))
  out.payments = (await selectAll<BackupRow>(session.client, 'payments', '*', 'id')).filter((row) => recordIds.has(String(row.student_finance_record_id)))
  return out
}

/** The 05A collection figures for the launch records, from hosted rows only. */
function launchCollections(plan: LaunchContactPlan, hosted: Record<BackupTable, BackupRow[]>, asOf: string): CollectionAssessment[] {
  const target: TargetDataset = {
    ticket: TICKET_05B,
    workbook: { fileName: '(hosted)', sha256: '' },
    supersededWorkbookSha256: '',
    retained: Object.fromEntries(BACKUP_TABLES.map((table) => [table, hosted[table].map((row) => row.id)])) as Record<BackupTable, string[]>,
    inserts: Object.fromEntries(INSERT_TABLES.map((table) => [table, []])) as unknown as TargetDataset['inserts'],
    cohorts: LAUNCH_COHORTS.map((cohort) => ({
      id: cohort.id,
      label: cohort.label,
      source: 'hosted' as const,
      programShortCode: cohort.programShortCode,
      batchIds: plan.launch.batchIdsByCohort[cohort.id] ?? [],
    })),
    links: plan.students.map((student) => {
      const record = hosted.student_finance_records.find((row) => row.id === student.financeRecordId) as BackupRow
      return {
        financeRecordId: student.financeRecordId,
        studentId: student.studentId,
        studentNumber: null,
        cohortId: student.cohortId,
        programShortCode: 'PSW',
        batchId: String(record.batch_id),
        origin: 'hosted' as const,
        sheet: null,
        row: null,
        named: true,
        resolution: 'hosted_by_number' as const,
        collectionMode: record.collection_mode as TargetDataset['links'][number]['collectionMode'],
      }
    }),
    issues: [],
  }
  const mappings = mapBatchSchedules(target, hosted)
  const undetermined = mappings.filter((mapping) => !mapping.deterministic)
  if (undetermined.length > 0) {
    throw new Error(`batch month mapping not deterministic: ${undetermined.map((m) => `${m.batchName}: ${m.reasons.join('; ')}`).join(' | ')}`)
  }
  return assessCollections({ target, hosted, contacts: [], asOf, mappings })
}

async function main(): Promise<number> {
  const repoRoot = repoRootFromHere()
  const split = splitArguments(process.argv.slice(2))
  if (split.error) {
    console.error(split.error)
    return 5
  }
  const parsed = parseApplyArguments(split.rest)
  const gate = resolveApplyGate(parsed)
  console.log(`${TICKET_05B} — launch cohorts ${LAUNCH_COHORTS.map((cohort) => cohort.label).join(', ')}`)
  console.log(`mode:     ${gate.mode} — ${gate.reason}; owing as of ${split.asOf}`)
  if (gate.mode === 'refuse') return 5
  const superseded = supersededRefusal(gate.mode)
  if (superseded !== null) {
    console.error(superseded)
    return 5
  }

  const privateDir = path.join(repoRoot, PRIVATE_DIR)
  mkdirSync(privateDir, { recursive: true })
  const written: string[] = []
  const write = (name: string, value: unknown): void => {
    writeFileSync(path.join(privateDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    written.push(`${PRIVATE_DIR.split(path.sep).join('/')}/${name}`)
  }

  // --- Sources (every master, open scope: rows are evidence for their exact number)
  const staging = stageWorkbooks(repoRoot, LAUNCH_CONTACT_SCOPE, (line) => console.log(line))
  if (isStagingStop(staging)) {
    console.error(staging.message)
    return staging.code
  }
  if (!staging.reports.every((report) => report.conservation === null || report.conservation.conserved)) {
    console.error('STOP: source conservation failed; run npm run finance:contact-audit')
    return 2
  }
  if (!staging.discovered.some((item) => item.identification.adapter?.programCode === 'PSW')) {
    console.error('STOP: the PSW contact master is not under reference/')
    return 2
  }

  // --- Hosted (authenticated, RLS) -------------------------------------------
  const session = await openHostedSession(repoRoot)
  const finish = async (code: number): Promise<number> => {
    await session.signOut()
    for (const file of written) console.log(`wrote ${file} (Git-ignored, contains PII)`)
    return code
  }
  console.log(`hosted:   project ${session.projectRef}, app role ${session.appRole ?? 'unknown'} (RLS enforced)`)
  const countsBefore = await integrityCounts(session)
  const contactsBefore = await contactCounts(session)
  console.log(`before:   ${JSON.stringify(countsBefore)}`)
  console.log(`contacts: ${JSON.stringify(contactsBefore)}`)
  const reads = await readHosted(session)
  const records = await selectAll<LaunchRecordRow>(session.client, 'student_finance_records', 'id, student_id, batch_id, collection_mode', 'id')
  const scope = resolveLaunchScope({
    programs: reads.programs,
    batches: reads.batches,
    records,
    cohortMonthOf: (text) => parseTitleDate(text).yearMonth,
  })
  if (scope.problems.length > 0) {
    console.error('STOP: the hosted launch scope is not what 05A applied:')
    for (const problem of scope.problems) console.error(`  - ${problem}`)
    return finish(2)
  }

  // --- Plan ------------------------------------------------------------------
  const hosted = snapshotFromReads(reads)
  const assessments = classifyRows(staging.allRows, {
    hosted,
    duplicates: staging.duplicates,
    shared: staging.shared,
    dateUnknownRowIds: staging.dateUnknownRowIds,
  })
  const plan = buildLaunchContactPlan({
    scope,
    assessments,
    allRows: staging.allRows,
    shared: staging.shared,
    hostedStudents: hosted.students,
    workbooks: staging.discovered.map((item) => ({
      fileName: item.fingerprint.fileName,
      sha256: item.fingerprint.sha256,
      adapterId: item.identification.adapter?.id ?? null,
    })),
    baseline: {
      projectRef: session.projectRef,
      counts: countsBefore,
      studentsWithEmail: contactsBefore.studentsWithEmail,
      studentsWithPhone: contactsBefore.studentsWithPhone,
    },
  })
  const hash = launchPlanHash(plan)
  const launchIds = new Set(plan.launch.studentIds)
  const hostedDuplicates = findHostedDuplicateNumbers(hosted.students)
  const launchDuplicates = hostedDuplicates.filter((group) => group.studentIds.some((id) => launchIds.has(id)))

  // --- Owing (report only) -----------------------------------------------------
  const financeRows = await readFinanceRows(session, new Set(plan.students.map((student) => student.financeRecordId)))
  const collections = launchCollections(plan, financeRows, split.asOf)
  const owing = owingSummary(plan.students, collections)

  // --- Report ----------------------------------------------------------------
  const a = plan.aggregate
  console.log('')
  console.log(`launch students: ${a.launchStudents} (${LAUNCH_COHORTS.map((c) => `${c.label} ${plan.students.filter((s) => s.cohortId === c.id).length}`).join(', ')})`)
  console.log('')
  console.log(`| Cohort | ${LAUNCH_STATUSES.join(' | ')} | email fills | phone fills |`)
  console.log(`| --- |${LAUNCH_STATUSES.map(() => ' ---: |').join('')} ---: | ---: |`)
  for (const cohort of LAUNCH_COHORTS) {
    const counts = a.byCohort[cohort.id]
    const inCohort = plan.students.filter((s) => s.cohortId === cohort.id)
    console.log(`| ${cohort.label} | ${LAUNCH_STATUSES.map((status) => counts?.[status] ?? 0).join(' | ')} | ${inCohort.filter((s) => s.emailFill).length} | ${inCohort.filter((s) => s.phoneFill).length} |`)
  }
  console.log(`| Total | ${LAUNCH_STATUSES.map((status) => a.byStatus[status]).join(' | ')} | ${a.emailFills} | ${a.phoneFills} |`)
  console.log('')
  for (const [key, value] of Object.entries(a)) {
    if (key !== 'byCohort' && key !== 'byStatus') console.log(`${key}: ${value}`)
  }
  console.log(`launch students on a hosted duplicate number: ${launchDuplicates.length} (all hosted: ${hostedDuplicates.length})`)
  console.log('')
  console.log(`owing through ${split.asOf.slice(0, 7)}: ${owing.owing} students, ${money(owing.owingAmount)}`)
  console.log(`  gain usable email: ${owing.gainEmail} (${money(owing.gainEmailAmount)})`)
  console.log(`  still without email after apply: ${owing.stillWithoutEmail} (${money(owing.stillWithoutEmailAmount)})`)
  console.log(`  already had email: ${owing.alreadyHaveEmail} (${money(owing.alreadyHaveEmailAmount)})`)
  console.log(`  by status: ${JSON.stringify(owing.byStatus)}`)
  console.log(`  collections not determinable: ${owing.cannotDetermine}`)

  write(PLAN_FILE, { generatedAt: new Date().toISOString(), planHash: hash, plan })
  write(REPORT_FILE, { generatedAt: new Date().toISOString(), planHash: hash, asOf: split.asOf, owing, collections })

  const workbooksUnchanged = staging.discovered.every((item) => hashReferenceFile(repoRoot, item.fingerprint.fileName) === item.fingerprint.sha256)
  if (!workbooksUnchanged) {
    console.error('REFERENCE WORKBOOK MODIFIED during the run')
    return finish(3)
  }

  if (gate.mode === 'dry-run') {
    const countsAfter = await integrityCounts(session)
    const contactsAfter = await contactCounts(session)
    const unchanged =
      INTEGRITY_TABLES.every((table) => countsBefore[table] === countsAfter[table]) &&
      contactsAfter.studentsWithEmail === contactsBefore.studentsWithEmail &&
      contactsAfter.studentsWithPhone === contactsBefore.studentsWithPhone
    console.log('')
    console.log(`after:    ${JSON.stringify(countsAfter)} · ${JSON.stringify(contactsAfter)} · unchanged: ${unchanged ? 'yes' : 'NO'}`)
    console.log('')
    console.log(`plan hash: ${hash}`)
    console.log('dry run only — nothing was written. To apply this exact plan after review:')
    console.log(`  npm run finance:contact-launch -- --apply --plan-hash=${hash}`)
    if (!unchanged) {
      console.error('HOSTED COUNTS CHANGED during the dry run')
      return finish(4)
    }
    return finish(0)
  }

  // --- Apply gate ---------------------------------------------------------------
  if (parsed.planHash !== hash) {
    console.error(`REFUSED: plan hash given ${parsed.planHash} ≠ the plan the current sources and hosted state produce (${hash}).`)
    console.error('Nothing was written. Review the fresh dry run and re-run with its hash.')
    return finish(5)
  }
  if (launchDuplicates.length > 0) {
    console.error(`REFUSED: ${launchDuplicates.length} launch student number(s) are held by more than one hosted row.`)
    return finish(5)
  }
  const outside = plan.candidates.filter((candidate) => hasFill(candidate) && !launchIds.has(candidate.studentId))
  if (outside.length > 0) {
    console.error(`REFUSED: ${outside.length} candidate(s) target a student outside the launch cohorts.`)
    return finish(5)
  }
  if (plan.candidates.filter(hasFill).length === 0) {
    console.log('nothing to apply: no launch student has a safe fill. No write was made.')
    return finish(0)
  }

  console.log('')
  console.log(`applying ${plan.candidates.filter(hasFill).length} candidate(s) through ${RPC_NAME} as ${session.appRole ?? 'unknown'} …`)
  const call = async (args: RpcArguments): Promise<RpcResult> => {
    const { data, error } = await session.client.rpc(RPC_NAME, args)
    if (error) return { ok: false, message: error.message ?? '', code: error.code ?? null, details: error.details ?? null }
    return { ok: true, data }
  }
  const execution = await executeApply(plan, hash, call, TICKET_05B)
  const countsAfter = await integrityCounts(session)
  const contactsAfter = await contactCounts(session)
  const checks = postApplyChecks({ counts: countsBefore, contacts: contactsBefore }, { counts: countsAfter, contacts: contactsAfter }, execution)
  write(RESULT_FILE, { completedAt: new Date().toISOString(), planHash: hash, execution, countsBefore, countsAfter, contactsBefore, contactsAfter, checks })

  console.log(`applied ${execution.applied} · stale ${execution.stale} · failed ${execution.failed}` + (execution.abortedBecause ? ` · aborted: ${execution.abortedBecause}` : ''))
  console.log(`fields written: email ${execution.emailFieldsWritten}, phone ${execution.phoneFieldsWritten}`)
  console.log('| Invariant | Expected | Actual | |')
  console.log('| --- | ---: | ---: | --- |')
  for (const check of checks) console.log(`| ${check.name} | ${check.expected} | ${check.actual} | ${check.ok ? 'ok' : 'FAIL'} |`)
  const clean = checks.every((check) => check.ok) && execution.stale === 0 && execution.failed === 0 && execution.abortedBecause === null
  if (!clean) console.error(`${TICKET_05B}: apply finished with problems; see ${PRIVATE_DIR}/${RESULT_FILE}`)
  return finish(clean ? 0 : 6)
}

const isEntryPoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isEntryPoint) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
