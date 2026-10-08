/**
 * FINANCE-CONTACT-04B2 — the safe existing-student contact apply.
 *
 *   npm run finance:contact-apply                          dry run (the default)
 *   npm run finance:contact-apply -- --dry-run             dry run, explicitly
 *   npm run finance:contact-apply -- --apply --plan-hash=<sha256>
 *
 * The dry run stages the masters exactly as the 04B1 audit does, reads the
 * hosted students under an authenticated RLS-enforced session, builds one
 * apply candidate per unique hosted student, writes the row-level plan (PII)
 * under `.private/finance-contact/`, and prints the plan hash and aggregate
 * counts only. It writes nothing to Supabase and proves it by counting every
 * integrity table before and after.
 *
 * The live apply needs `--apply` AND the exact hash of the plan the current
 * sources and hosted state produce. It rebuilds the plan first; if a workbook
 * changed, a hosted count changed, a candidate's current contact changed or
 * the plan hash simply differs, it refuses and writes nothing. Each write
 * goes through `public.apply_student_contact_fill`, which updates the student
 * and inserts the audit row in one transaction and fails (STALE_TARGET) if
 * the field is no longer NULL. The caller is the admin's own session, never
 * the service role.
 *
 * Exit codes: 0 ok · 1 error · 2 sources not usable · 3 reference workbook
 * modified during the run · 4 hosted counts changed during a dry run · 5 apply
 * refused (nothing written) · 6 apply ran but a candidate failed or an
 * invariant did not hold (see the private result file).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { openHostedSession, type HostedSession } from '../finance-qa/hosted-session.mts'

import {
  buildApplyPlan,
  executeApply,
  hasFill,
  planHash,
  renderPlanAggregate,
  TICKET,
  type ApplyExecution,
  type ApplyPlan,
  type RpcArguments,
  type RpcResult,
} from './apply-plan.mts'
import {
  contactCounts,
  INTEGRITY_TABLES,
  integrityCounts,
  isStagingStop,
  readHosted,
  snapshotFromReads,
  stageWorkbooks,
  type ContactCounts,
} from './pipeline.mts'
import { classifyRows, findHostedDuplicateNumbers } from './reconcile.mts'
import { DEFAULT_SCOPE_CONFIG } from './scope.mts'
import { hashReferenceFile } from './sources.mts'

const PRIVATE_DIR = path.join('.private', 'finance-contact')
export const PLAN_FILE = 'contact-04b2-plan.json'
export const PLAN_AGGREGATE_FILE = 'contact-04b2-plan-aggregate.md'
export const RESULT_FILE = 'contact-04b2-apply-result.json'
export const RPC_NAME = 'apply_student_contact_fill'

// -----------------------------------------------------------------------------
// Arguments and the apply gate
// -----------------------------------------------------------------------------

export interface ParsedArguments {
  apply: boolean
  dryRun: boolean
  planHash: string | null
  unknown: string[]
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const out: ParsedArguments = { apply: false, dryRun: false, planHash: null, unknown: [] }
  for (const arg of argv) {
    if (arg === '--apply') out.apply = true
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg.startsWith('--plan-hash=')) out.planHash = arg.slice('--plan-hash='.length).trim().toLowerCase()
    else out.unknown.push(arg)
  }
  return out
}

export interface ApplyGate {
  mode: 'dry-run' | 'apply' | 'refuse'
  reason: string
}

/**
 * Dry run unless `--apply` and a well-formed `--plan-hash` are both present.
 * `--apply` without a hash is refused outright rather than silently demoted:
 * the hash is the reviewer's signature on one specific plan.
 */
export function resolveApplyGate(parsed: ParsedArguments): ApplyGate {
  if (parsed.unknown.length > 0) return { mode: 'refuse', reason: `unknown argument(s): ${parsed.unknown.join(' ')}` }
  if (parsed.apply && parsed.dryRun) return { mode: 'refuse', reason: '--apply and --dry-run contradict each other' }
  if (!parsed.apply) {
    if (parsed.planHash !== null) return { mode: 'dry-run', reason: '--plan-hash without --apply: dry run; the hash is ignored' }
    return { mode: 'dry-run', reason: 'dry run (the default)' }
  }
  if (parsed.planHash === null) return { mode: 'refuse', reason: '--apply requires --plan-hash=<sha256 of the reviewed plan>' }
  if (!/^[0-9a-f]{64}$/.test(parsed.planHash)) return { mode: 'refuse', reason: '--plan-hash must be the 64-hex-character sha256 of the reviewed plan' }
  return { mode: 'apply', reason: '--apply and --plan-hash both present' }
}

// -----------------------------------------------------------------------------
// Private files
// -----------------------------------------------------------------------------

interface StoredPlan {
  generatedAt: string
  planHash: string
  plan: ApplyPlan
}

function readStoredPlan(privateDir: string): StoredPlan | null {
  const file = path.join(privateDir, PLAN_FILE)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredPlan>
    if (typeof parsed.planHash !== 'string' || !parsed.plan) return null
    return parsed as StoredPlan
  } catch {
    return null
  }
}

/** Explains, without a value, why a given hash no longer matches the live plan. */
export function explainHashMismatch(given: string, live: ApplyPlan, liveHash: string, stored: StoredPlan | null): string[] {
  const reasons: string[] = [`plan hash given ${given} ≠ live plan hash ${liveHash}`]
  if (stored === null) return [...reasons, 'no previously written plan file to compare against']
  if (stored.planHash !== given) reasons.push(`the stored plan file carries hash ${stored.planHash}, not the hash given`)
  const storedWorkbooks = new Map(stored.plan.sourceWorkbooks.map((workbook) => [workbook.fileName, workbook.sha256]))
  for (const workbook of live.sourceWorkbooks) {
    const before = storedWorkbooks.get(workbook.fileName)
    if (before === undefined) reasons.push(`workbook ${workbook.fileName} was not in the stored plan`)
    else if (before !== workbook.sha256) reasons.push(`workbook ${workbook.fileName} changed (sha256 differs)`)
  }
  for (const fileName of storedWorkbooks.keys()) {
    if (!live.sourceWorkbooks.some((workbook) => workbook.fileName === fileName)) reasons.push(`workbook ${fileName} is no longer under reference/`)
  }
  for (const [table, count] of Object.entries(live.hostedBaseline.counts)) {
    const before = stored.plan.hostedBaseline.counts[table]
    if (before !== count) reasons.push(`hosted ${table} count changed: ${before ?? 'absent'} → ${count}`)
  }
  if (stored.plan.hostedBaseline.studentsWithEmail !== live.hostedBaseline.studentsWithEmail) {
    reasons.push(`students with non-NULL email changed: ${stored.plan.hostedBaseline.studentsWithEmail} → ${live.hostedBaseline.studentsWithEmail}`)
  }
  if (stored.plan.hostedBaseline.studentsWithPhone !== live.hostedBaseline.studentsWithPhone) {
    reasons.push(`students with non-NULL phone changed: ${stored.plan.hostedBaseline.studentsWithPhone} → ${live.hostedBaseline.studentsWithPhone}`)
  }
  const storedById = new Map(stored.plan.candidates.map((candidate) => [candidate.studentId, candidate]))
  let changedCandidates = 0
  for (const candidate of live.candidates) {
    const before = storedById.get(candidate.studentId)
    if (
      !before ||
      before.emailAction !== candidate.emailAction ||
      before.phoneAction !== candidate.phoneAction ||
      before.proposedEmail !== candidate.proposedEmail ||
      before.proposedPhone !== candidate.proposedPhone ||
      before.expectedCurrentEmail !== candidate.expectedCurrentEmail ||
      before.expectedCurrentPhone !== candidate.expectedCurrentPhone
    ) {
      changedCandidates += 1
    }
  }
  if (changedCandidates > 0 || stored.plan.candidates.length !== live.candidates.length) {
    reasons.push(`${changedCandidates} candidate(s) differ from the stored plan (stored ${stored.plan.candidates.length}, live ${live.candidates.length}); re-plan and re-review`)
  }
  if (reasons.length === 1) reasons.push('sources, hosted baseline and candidates look unchanged; the hash was probably typed from an older run')
  return reasons
}

// -----------------------------------------------------------------------------
// Post-apply invariants
// -----------------------------------------------------------------------------

export interface PostApplyCheck {
  name: string
  expected: number
  actual: number
  ok: boolean
}

export function postApplyChecks(
  before: { counts: Record<string, number>; contacts: ContactCounts },
  after: { counts: Record<string, number>; contacts: ContactCounts },
  execution: ApplyExecution,
): PostApplyCheck[] {
  const checks: PostApplyCheck[] = []
  for (const table of INTEGRITY_TABLES) {
    const expected = table === 'audit_log' ? before.counts[table] + execution.applied : before.counts[table]
    checks.push({ name: `${table} count`, expected, actual: after.counts[table], ok: after.counts[table] === expected })
  }
  checks.push({
    name: 'students with non-NULL email',
    expected: before.contacts.studentsWithEmail + execution.emailFieldsWritten,
    actual: after.contacts.studentsWithEmail,
    ok: after.contacts.studentsWithEmail === before.contacts.studentsWithEmail + execution.emailFieldsWritten,
  })
  checks.push({
    name: 'students with non-NULL phone',
    expected: before.contacts.studentsWithPhone + execution.phoneFieldsWritten,
    actual: after.contacts.studentsWithPhone,
    ok: after.contacts.studentsWithPhone === before.contacts.studentsWithPhone + execution.phoneFieldsWritten,
  })
  return checks
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

async function main(): Promise<number> {
  const repoRoot = repoRootFromHere()
  const parsed = parseArguments(process.argv.slice(2))
  const gate = resolveApplyGate(parsed)
  console.log(`mode:     ${gate.mode} — ${gate.reason}`)
  if (gate.mode === 'refuse') return 5

  const config = DEFAULT_SCOPE_CONFIG
  const privateDir = path.join(repoRoot, PRIVATE_DIR)
  mkdirSync(privateDir, { recursive: true })
  const stored = readStoredPlan(privateDir)

  // --- Sources ---------------------------------------------------------------
  const staging = stageWorkbooks(repoRoot, config, (line) => console.log(line))
  if (isStagingStop(staging)) {
    console.error(staging.message)
    return staging.code
  }
  const { discovered, reports, allRows, dateUnknownRowIds, duplicates, shared } = staging
  if (!reports.every((report) => report.conservation === null || report.conservation.conserved)) {
    console.error('STOP: source conservation failed; run npm run finance:contact-audit')
    return 2
  }

  // --- Hosted (authenticated, RLS) -------------------------------------------
  const session: HostedSession = await openHostedSession(repoRoot)
  console.log(`hosted:   project ${session.projectRef}, app role ${session.appRole ?? 'unknown'} (RLS enforced)`)
  const countsBefore = await integrityCounts(session)
  const contactsBefore = await contactCounts(session)
  console.log(`before:   ${JSON.stringify(countsBefore)}`)
  console.log(`contacts: ${JSON.stringify(contactsBefore)}`)
  const reads = await readHosted(session)
  const hosted = snapshotFromReads(reads)

  // --- Plan ------------------------------------------------------------------
  const assessments = classifyRows(allRows, { hosted, duplicates, shared, dateUnknownRowIds })
  const hostedDuplicates = findHostedDuplicateNumbers(hosted.students)
  const plan = buildApplyPlan({
    assessments,
    shared,
    hostedStudents: hosted.students,
    workbooks: discovered.map((item) => ({
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
    scope: config,
  })
  const hash = planHash(plan)

  const write = (name: string, value: unknown): string => {
    writeFileSync(path.join(privateDir, name), `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`, 'utf8')
    return `${PRIVATE_DIR.split(path.sep).join('/')}/${name}`
  }
  const written: string[] = []
  written.push(write(PLAN_FILE, { generatedAt: new Date().toISOString(), planHash: hash, plan } satisfies StoredPlan))
  const aggregateText = renderPlanAggregate(plan, hash)
  written.push(write(PLAN_AGGREGATE_FILE, aggregateText))

  console.log('')
  console.log(aggregateText)
  console.log('')
  console.log(`hosted student numbers held by more than one hosted row: ${hostedDuplicates.length}`)
  console.log(`candidates with at least one fill: ${plan.candidates.filter(hasFill).length}`)

  // --- Dry run: prove nothing changed ------------------------------------------
  const finish = async (code: number): Promise<number> => {
    await session.signOut()
    for (const file of written) console.log(`wrote ${file} (Git-ignored)`)
    return code
  }

  const workbooksUnchanged = discovered.every((item) => hashReferenceFile(repoRoot, item.fingerprint.fileName) === item.fingerprint.sha256)
  if (!workbooksUnchanged) {
    console.error('REFERENCE WORKBOOK MODIFIED during the run')
    return finish(3)
  }

  if (gate.mode === 'dry-run') {
    const countsAfter = await integrityCounts(session)
    const unchanged = INTEGRITY_TABLES.every((table) => countsBefore[table] === countsAfter[table])
    console.log(`after:    ${JSON.stringify(countsAfter)} · unchanged: ${unchanged ? 'yes' : 'NO'}`)
    console.log('')
    console.log(`plan hash: ${hash}`)
    console.log('dry run only — nothing was written. To apply this exact plan after review:')
    console.log(`  npm run finance:contact-apply -- --apply --plan-hash=${hash}`)
    if (!unchanged) {
      console.error('HOSTED COUNTS CHANGED during the dry run')
      return finish(4)
    }
    return finish(0)
  }

  // --- Apply: gate on the exact plan ------------------------------------------
  const given = parsed.planHash as string
  if (given !== hash) {
    console.error('REFUSED: the plan hash given does not match the plan the current sources and hosted state produce.')
    for (const reason of explainHashMismatch(given, plan, hash, stored)) console.error(`  - ${reason}`)
    console.error('Nothing was written. Review the fresh plan and re-run with its hash.')
    return finish(5)
  }
  if (hostedDuplicates.length > 0) {
    console.error(`REFUSED: ${hostedDuplicates.length} hosted student number(s) are held by more than one row; resolve before any contact apply.`)
    return finish(5)
  }
  if (plan.candidates.filter(hasFill).length === 0) {
    console.log('nothing to apply: every candidate is already matching or held. No write was made.')
    return finish(0)
  }

  // --- Apply: execute, one RPC transaction per student ---------------------------
  console.log('')
  console.log(`applying ${plan.candidates.filter(hasFill).length} candidate(s) through ${RPC_NAME} as ${session.appRole ?? 'unknown'} …`)
  const call = async (args: RpcArguments): Promise<RpcResult> => {
    const { data, error } = await session.client.rpc(RPC_NAME, args)
    if (error) return { ok: false, message: error.message ?? '', code: error.code ?? null, details: error.details ?? null }
    return { ok: true, data }
  }
  const execution = await executeApply(plan, hash, call)

  const countsAfter = await integrityCounts(session)
  const contactsAfter = await contactCounts(session)
  const checks = postApplyChecks({ counts: countsBefore, contacts: contactsBefore }, { counts: countsAfter, contacts: contactsAfter }, execution)
  const invariantsHold = checks.every((check) => check.ok)

  written.push(
    write(RESULT_FILE, {
      completedAt: new Date().toISOString(),
      planHash: hash,
      execution,
      countsBefore,
      countsAfter,
      contactsBefore,
      contactsAfter,
      checks,
    }),
  )

  console.log('')
  console.log(`applied ${execution.applied} · stale ${execution.stale} · failed ${execution.failed}` + (execution.abortedBecause ? ` · aborted: ${execution.abortedBecause}` : ''))
  console.log(`fields written: email ${execution.emailFieldsWritten}, phone ${execution.phoneFieldsWritten}`)
  console.log('')
  console.log('| Invariant | Expected | Actual | |')
  console.log('| --- | ---: | ---: | --- |')
  for (const check of checks) console.log(`| ${check.name} | ${check.expected} | ${check.actual} | ${check.ok ? 'ok' : 'FAIL'} |`)

  const clean = invariantsHold && execution.stale === 0 && execution.failed === 0 && execution.abortedBecause === null
  if (!clean) console.error(`${TICKET}: apply finished with problems; see ${PRIVATE_DIR}/${RESULT_FILE}`)
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
