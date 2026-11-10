/**
 * The apply gate: every condition a destructive cutover must meet, as one
 * pure function so each refusal is tested rather than trusted.
 *
 * The apply runs only when ALL of these hold:
 *
 *  * `--apply` was given, with `--plan-hash=<64 hex>`;
 *  * the workbook on disk is the approved replacement workbook;
 *  * the private backup exists, reads back, proves complete, and is the very
 *    backup the plan names;
 *  * the restore statement generated from that backup exists and is the one
 *    the plan names;
 *  * the live hosted fingerprint is the plan's pre-state AND its counts are the
 *    ticket's expected baseline;
 *  * the plan recomputed now hashes to the approved hash;
 *  * the plan has no blocking issue and no invariant violation.
 *
 * Anything else is a refusal, and a refusal writes nothing.
 */

import { BACKUP_TABLES, EXPECTED_BASELINE, EXPECTED_WORKBOOK_SHA256 } from './config.mts'

import type { StateFingerprint } from './hosted.mts'

export type GateRefusal =
  | 'PLAN_HASH_REQUIRED'
  | 'PLAN_HASH_MALFORMED'
  | 'STALE_SOURCE_HASH'
  | 'BACKUP_MISSING'
  | 'BACKUP_INVALID'
  | 'BACKUP_NOT_THE_PLANNED_BACKUP'
  | 'RESTORE_MISSING'
  | 'RESTORE_NOT_THE_PLANNED_RESTORE'
  | 'STALE_HOSTED_BASELINE'
  | 'PLAN_HASH_MISMATCH'
  | 'PLAN_HAS_BLOCKERS'

export interface GateInput {
  apply: boolean
  requestedPlanHash: string | null
  workbookSha256: string
  backup: { present: boolean; ok: boolean; sha256: string | null; problems: string[] }
  plannedBackupSha256: string
  /** sha256 of the restore statement on disk; null when it is missing. */
  restoreSha256: string | null
  plannedRestoreSha256: string
  liveFingerprint: StateFingerprint
  plannedPreState: StateFingerprint
  recomputedPlanHash: string
  blockers: string[]
  /** Row-count baseline to require; defaults to the 2026-10-21 ticket baseline. */
  expectedBaseline?: typeof EXPECTED_BASELINE
}

export interface GateResult {
  mode: 'dry_run' | 'apply'
  allowed: boolean
  refusals: { code: GateRefusal; detail: string }[]
}

export function baselineDifferences(live: StateFingerprint, baseline: typeof EXPECTED_BASELINE = EXPECTED_BASELINE): string[] {
  const out: string[] = []
  for (const table of BACKUP_TABLES) {
    if (live.tables[table]?.count !== baseline[table]) {
      out.push(`${table} is ${live.tables[table]?.count}, expected ${baseline[table]}`)
    }
  }
  if (live.studentsEmailNonNull !== baseline.students_email_non_null) out.push(`students.email non-NULL is ${live.studentsEmailNonNull}`)
  if (live.studentsPhoneNonNull !== baseline.students_phone_non_null) out.push(`students.phone non-NULL is ${live.studentsPhoneNonNull}`)
  return out
}

export function evaluateGates(input: GateInput): GateResult {
  if (!input.apply) return { mode: 'dry_run', allowed: false, refusals: [] }

  const refusals: GateResult['refusals'] = []
  const refuse = (code: GateRefusal, detail: string): void => {
    refusals.push({ code, detail })
  }

  if (input.requestedPlanHash === null) refuse('PLAN_HASH_REQUIRED', '--apply needs --plan-hash=<the reviewed cutover-plan sha256>')
  else if (!/^[0-9a-f]{64}$/.test(input.requestedPlanHash)) refuse('PLAN_HASH_MALFORMED', '--plan-hash must be 64 lower-case hex characters')

  if (input.workbookSha256 !== EXPECTED_WORKBOOK_SHA256) {
    refuse('STALE_SOURCE_HASH', `workbook sha256 ${input.workbookSha256} is not the approved ${EXPECTED_WORKBOOK_SHA256}`)
  }

  if (!input.backup.present) refuse('BACKUP_MISSING', 'no private hosted backup on disk')
  else if (!input.backup.ok) refuse('BACKUP_INVALID', input.backup.problems.join('; ') || 'backup did not verify')
  else if (input.backup.sha256 !== input.plannedBackupSha256) {
    refuse('BACKUP_NOT_THE_PLANNED_BACKUP', `backup sha256 ${input.backup.sha256} is not the plan's ${input.plannedBackupSha256}`)
  }

  if (input.restoreSha256 === null) refuse('RESTORE_MISSING', 'no restore statement on disk; regenerate it with a dry run before any apply')
  else if (input.restoreSha256 !== input.plannedRestoreSha256) {
    refuse('RESTORE_NOT_THE_PLANNED_RESTORE', `restore sha256 ${input.restoreSha256} is not the plan's ${input.plannedRestoreSha256}`)
  }

  // Both gates, always: the expected row counts, then the exact fingerprint
  // (count + id-set md5 + full-row md5 per table), which is strictly stronger.
  const baseline = baselineDifferences(input.liveFingerprint, input.expectedBaseline ?? EXPECTED_BASELINE)
  if (baseline.length > 0) refuse('STALE_HOSTED_BASELINE', `live counts differ from the expected baseline: ${baseline.join('; ')}`)
  else if (JSON.stringify(input.liveFingerprint) !== JSON.stringify(input.plannedPreState)) {
    refuse('STALE_HOSTED_BASELINE', 'live hosted rows differ from the plan\'s pre-state fingerprint (a row changed since the plan was made)')
  }

  if (input.requestedPlanHash !== null && input.requestedPlanHash !== input.recomputedPlanHash) {
    refuse('PLAN_HASH_MISMATCH', `the plan recomputed now hashes to ${input.recomputedPlanHash}`)
  }

  if (input.blockers.length > 0) refuse('PLAN_HAS_BLOCKERS', input.blockers.join('; '))

  return { mode: 'apply', allowed: refusals.length === 0, refusals }
}

export interface ParsedArguments {
  apply: boolean
  planHash: string | null
  refreshBackup: boolean
  probeSql: boolean
  verifyRestore: boolean
  asOf: string | null
  unknown: string[]
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const out: ParsedArguments = { apply: false, planHash: null, refreshBackup: false, probeSql: false, verifyRestore: false, asOf: null, unknown: [] }
  for (const arg of argv) {
    if (arg === '--apply') out.apply = true
    else if (arg === '--dry-run') out.apply = false
    else if (arg === '--refresh-backup') out.refreshBackup = true
    else if (arg === '--probe-sql') out.probeSql = true
    else if (arg === '--verify-restore') out.verifyRestore = true
    else if (arg.startsWith('--plan-hash=')) out.planHash = arg.slice('--plan-hash='.length).trim().toLowerCase()
    else if (arg.startsWith('--as-of=')) out.asOf = arg.slice('--as-of='.length).trim()
    else out.unknown.push(arg)
  }
  return out
}
