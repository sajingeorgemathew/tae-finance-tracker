/**
 * FINANCE-STUDENT-SYNC-05B — compare a CURRENT student list with the live
 * finance students and write a reviewable dry run. Writes nothing to Supabase.
 *
 *   npm run finance:student-sync                                  dry run on the one file in reference/current-students/
 *   npm run finance:student-sync -- --source=<file.csv|.xlsx>     dry run on a given file
 *   npm run finance:student-sync -- --sheet="Sheet1"              pick the sheet of an .xlsx
 *   npm run finance:student-sync -- --scope=psw-live-2026         pick the scope (config.mts)
 *   npm run finance:student-sync -- --cross-check-master          add the old PSW master as a warning column only
 *   npm run finance:student-sync -- --export-template             write a template pre-filled with the live students
 *
 * `--apply` is refused in this ticket. The plan hash printed is the review
 * artifact the later apply ticket will require (see docs in README).
 *
 * Hosted reads use the admin's own RLS-enforced session, select/count only;
 * the integrity counts are taken before and after to prove nothing changed.
 * Output (PII, Git-ignored): `.private/finance-student-sync/`.
 *
 * Exit codes: 0 ok · 1 error · 2 input or scope not usable · 4 hosted changed
 * during the run · 5 refused.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { sessionOfBatchName } from '../../src/lib/finance/grid/intake.ts'
import { parseTitleDate } from '../finance-contact/adapters/title-date.mts'
import { LAUNCH_CONTACT_SCOPE, resolveLaunchScope } from '../finance-contact/launch-plan.mts'
import { joinNameParts, normalizeStudentNumber } from '../finance-contact/normalize.mts'
import { contactCounts, INTEGRITY_TABLES, integrityCounts, isStagingStop, stageWorkbooks } from '../finance-contact/pipeline.mts'
import { selectAll } from '../finance-qa/hosted-reads.mts'
import { openHostedSession } from '../finance-qa/hosted-session.mts'

import { DEFAULT_SCOPE_ID, DEFAULT_SOURCE_DIR, PRIVATE_DIR, SYNC_SCOPES, type SyncScope } from './config.mts'
import { InputError, readStudentFile, TEMPLATE_HEADINGS } from './input.mts'
import { buildSyncPlan, nameConsistency, syncPlanHash, type ComparisonRow, type LiveStudent, type OutsideStudent } from './reconcile.mts'
import { renderPreviewCsv, renderSummary } from './report.mts'

interface Args {
  source: string | null
  sheet: string | undefined
  scope: string
  crossCheckMaster: boolean
  exportTemplate: boolean
  apply: boolean
  unknown: string[]
}

export function parseSyncArguments(argv: readonly string[]): Args {
  const out: Args = { source: null, sheet: undefined, scope: DEFAULT_SCOPE_ID, crossCheckMaster: false, exportTemplate: false, apply: false, unknown: [] }
  for (const arg of argv) {
    if (arg.startsWith('--source=')) out.source = arg.slice('--source='.length)
    else if (arg.startsWith('--sheet=')) out.sheet = arg.slice('--sheet='.length)
    else if (arg.startsWith('--scope=')) out.scope = arg.slice('--scope='.length)
    else if (arg === '--cross-check-master') out.crossCheckMaster = true
    else if (arg === '--export-template') out.exportTemplate = true
    else if (arg === '--apply' || arg.startsWith('--plan-hash=')) out.apply = true
    else out.unknown.push(arg)
  }
  return out
}

/** `--apply` has no implementation in this ticket; refusing is the whole gate. */
export function syncApplyRefusal(args: Args): string | null {
  if (args.unknown.length > 0) return `unknown argument(s): ${args.unknown.join(' ')}`
  if (args.apply) return 'REFUSED: FINANCE-STUDENT-SYNC-05B is dry-run only; the apply is designed but not enabled. Nothing was read or written.'
  return null
}

function resolveSource(repoRoot: string, given: string | null): string {
  if (given !== null) return path.resolve(repoRoot, given)
  const dir = path.join(repoRoot, DEFAULT_SOURCE_DIR)
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => /\.(csv|xlsx|xls)$/i.test(name) && !name.startsWith('~$')) : []
  if (files.length !== 1) {
    throw new InputError(
      files.length === 0
        ? `no current student file: put ONE .csv/.xlsx in ${DEFAULT_SOURCE_DIR}/ or pass --source=<file>`
        : `${files.length} files in ${DEFAULT_SOURCE_DIR}/ (${files.join(', ')}); keep exactly one or pass --source=<file>`,
    )
  }
  return path.join(dir, files[0])
}

interface HostedStudentRow {
  id: string
  student_number: string | null
  first_name: string | null
  middle_name: string | null
  last_name: string | null
  display_name: string | null
  legacy_name: string | null
  email: string | null
  phone: string | null
}

interface HostedBatchRow {
  id: string
  program_id: string
  name: string
  legacy_sheet_name: string | null
  start_date: string | null
}

function csvLine(values: readonly (string | null)[]): string {
  return values.map((value) => (value === null ? '' : /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)).join(',')
}

async function main(): Promise<number> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const args = parseSyncArguments(process.argv.slice(2))
  const refusal = syncApplyRefusal(args)
  if (refusal !== null) {
    console.error(refusal)
    return 5
  }
  const scope: SyncScope | undefined = SYNC_SCOPES[args.scope]
  if (!scope) {
    console.error(`unknown scope ${args.scope}; known: ${Object.keys(SYNC_SCOPES).join(', ')}`)
    return 2
  }
  console.log(`FINANCE-STUDENT-SYNC-05B — dry run · scope ${scope.id}: ${scope.cohorts.map((c) => c.label).join(', ')}`)

  const file = args.exportTemplate ? null : readStudentFile(resolveSource(repoRoot, args.source), args.sheet)
  if (file) {
    console.log(`source:   ${file.fileName} · sheet "${file.sheet}" · header row ${file.header.headerRow} · ${file.rows.length} rows (${file.blankRows} blank skipped) · sha256 ${file.sha256}`)
    console.log(`columns:  ${Object.entries(file.header.mapped).map(([f, h]) => `${f} ← "${h}"`).join(', ')}`)
    if (file.header.ignored.length > 0) console.log(`ignored:  ${file.header.ignored.map((h) => `"${h}"`).join(', ')}`)
    if (file.header.sensitiveNotRead.length > 0) console.log(`NOT READ (sensitive): ${file.header.sensitiveNotRead.map((h) => `"${h}"`).join(', ')}`)
  }

  // --- Hosted (authenticated, RLS, read-only) -------------------------------
  const session = await openHostedSession(repoRoot)
  const written: string[] = []
  const finish = async (code: number): Promise<number> => {
    await session.signOut()
    for (const name of written) console.log(`wrote ${name} (Git-ignored, contains PII)`)
    return code
  }
  const outDir = path.join(repoRoot, PRIVATE_DIR)
  mkdirSync(outDir, { recursive: true })
  const write = (name: string, text: string): void => {
    writeFileSync(path.join(outDir, name), text, 'utf8')
    written.push(`${PRIVATE_DIR}/${name}`)
  }

  console.log(`hosted:   project ${session.projectRef}, app role ${session.appRole ?? 'unknown'} (RLS enforced, read-only)`)
  const countsBefore = await integrityCounts(session)
  const contactsBefore = await contactCounts(session)
  const programs = await selectAll<{ id: string; short_code: string }>(session.client, 'programs', 'id, short_code', 'id')
  const batches = await selectAll<HostedBatchRow>(session.client, 'batches', 'id, program_id, name, legacy_sheet_name, start_date', 'id')
  const students = await selectAll<HostedStudentRow>(session.client, 'students', 'id, student_number, first_name, middle_name, last_name, display_name, legacy_name, email, phone', 'id')
  const records = await selectAll<{ id: string; student_id: string; batch_id: string | null; collection_mode: string | null }>(
    session.client,
    'student_finance_records',
    'id, student_id, batch_id, collection_mode',
    'id',
  )

  const monthOf = (text: string | null): string | null => (text === null ? null : parseTitleDate(text).yearMonth)
  const resolved = resolveLaunchScope({ programs, batches, records, cohortMonthOf: (text) => monthOf(text), cohorts: scope.cohorts, expected: scope.expectedStudents ?? {} })
  // collection_mode is a 05A launch invariant, not part of a generic scope: keep only membership problems.
  const problems = resolved.problems.filter((problem) => !/collection_mode|installment-mode/.test(problem))
  if (problems.length > 0) {
    console.error('STOP: the hosted scope is not as configured:')
    for (const problem of problems) console.error(`  - ${problem}`)
    return finish(2)
  }

  const studentById = new Map(students.map((s) => [s.id, s]))
  const batchById = new Map(batches.map((b) => [b.id, b]))
  const cohortById = new Map(scope.cohorts.map((c) => [c.id, c]))
  const live: LiveStudent[] = resolved.members.map((member) => {
    const s = studentById.get(member.studentId) as HostedStudentRow
    const b = batchById.get(member.batchId) as HostedBatchRow
    const cohort = cohortById.get(member.cohortId)!
    const months = [cohort.yearMonth, b.start_date?.slice(0, 7) ?? null, monthOf(b.name)].filter((m): m is string => m !== null)
    return {
      studentId: s.id,
      studentNumber: s.student_number,
      name: s.legacy_name ?? s.display_name ?? joinNameParts(s.first_name, s.middle_name, s.last_name),
      nameParts: [s.first_name, s.middle_name, s.last_name, s.display_name, s.legacy_name],
      email: s.email,
      phone: s.phone,
      cohortId: member.cohortId,
      batchId: b.id,
      batchName: `${cohort.label} · ${b.name}`,
      acceptedMonths: [...new Set(months)].sort(),
      session: sessionOfBatchName(b.name),
    }
  })
  const scopedIds = new Set(live.map((s) => s.studentId))
  const labelOfStudent = new Map<string, string>()
  for (const record of records) {
    if (scopedIds.has(record.student_id)) continue
    const batch = record.batch_id === null ? null : batchById.get(record.batch_id)
    labelOfStudent.set(record.student_id, batch ? (batch.legacy_sheet_name ?? batch.name) : 'no batch')
  }
  const outside: OutsideStudent[] = students
    .filter((s) => !scopedIds.has(s.id) && normalizeStudentNumber(s.student_number) !== null)
    .map((s) => ({ studentNumber: normalizeStudentNumber(s.student_number) as string, label: labelOfStudent.get(s.id) ?? 'no finance record' }))
  console.log(`live:     ${live.length} scoped students (${scope.cohorts.map((c) => `${c.label} ${live.filter((s) => s.cohortId === c.id).length}`).join(', ')})`)

  // --- Template export -------------------------------------------------------------
  if (args.exportTemplate) {
    const lines = [csvLine([...TEMPLATE_HEADINGS])]
    for (const s of [...live].sort((a, b) => a.cohortId.localeCompare(b.cohortId) || (a.name ?? '').localeCompare(b.name ?? ''))) {
      lines.push(csvLine([s.studentNumber, s.name, s.email, s.phone, cohortById.get(s.cohortId)!.label, s.session]))
    }
    write('current-students-template.csv', `${lines.join('\r\n')}\r\n`)
    console.log('template: one row per live scoped student; fill or correct Email / Phone (and any missing Student Number), keep one row per student.')
    return finish(0)
  }

  // --- Plan --------------------------------------------------------------------------
  const plan = buildSyncPlan({
    scope: { id: scope.id, cohorts: scope.cohorts },
    file: file!,
    live,
    outside,
    baseline: { projectRef: session.projectRef, counts: countsBefore, studentsWithEmail: contactsBefore.studentsWithEmail, studentsWithPhone: contactsBefore.studentsWithPhone },
  })
  const hash = syncPlanHash(plan)

  // --- Optional: old master as a warning column only ----------------------------
  const masterNotes = new Map<ComparisonRow, string>()
  const extras: string[] = []
  if (args.crossCheckMaster) {
    const staging = stageWorkbooks(repoRoot, LAUNCH_CONTACT_SCOPE)
    if (isStagingStop(staging)) {
      console.error(`cross-check skipped: ${staging.message}`)
    } else {
      const masterRows = staging.allRows.filter((row) => row.programCode === 'PSW')
      let disagree = 0
      for (const row of plan.rows) {
        if (row.studentNumber === null) continue
        const hits = masterRows.filter((m) => m.studentNumber === row.studentNumber)
        if (hits.length === 0) {
          masterNotes.set(row, 'not in old master')
          continue
        }
        const notes: string[] = []
        const name = row.incomingName ?? row.currentName
        if (nameConsistency(hits.flatMap((m) => [m.firstName, m.middleName, m.lastName, m.displayName]), name) === 'CONFLICT') notes.push('old master gives this number to a different name')
        const email = row.incomingEmail
        if (email && hits.every((m) => m.emailNormalized !== email)) notes.push('email differs from old master')
        const phone = row.incomingPhone
        if (phone && hits.every((m) => m.phoneNormalized !== phone)) notes.push('phone differs from old master')
        if (notes.length > 0) disagree += 1
        masterNotes.set(row, notes.length > 0 ? notes.join('; ') : 'agrees with old master')
      }
      extras.push(`old-master cross-check: rows disagreeing (warning only) | ${disagree}`)
    }
  }

  // --- Output ------------------------------------------------------------------------
  const summary = renderSummary(plan, hash, extras)
  console.log('')
  console.log(summary)
  write('student-sync-plan.json', `${JSON.stringify({ generatedAt: new Date().toISOString(), planHash: hash, plan }, null, 2)}\n`)
  write(
    'student-sync-preview.csv',
    renderPreviewCsv(plan.rows, masterNotes.size > 0 ? { heading: 'Old Master Check (warning only)', valueOf: (row) => masterNotes.get(row) ?? null } : undefined),
  )
  write('student-sync-summary.md', `${summary}\n`)

  const countsAfter = await integrityCounts(session)
  const contactsAfter = await contactCounts(session)
  const unchanged =
    INTEGRITY_TABLES.every((table) => countsBefore[table] === countsAfter[table]) &&
    contactsAfter.studentsWithEmail === contactsBefore.studentsWithEmail &&
    contactsAfter.studentsWithPhone === contactsBefore.studentsWithPhone
  console.log('')
  console.log(`hosted unchanged during the run: ${unchanged ? 'yes' : 'NO'} (${INTEGRITY_TABLES.length} tables + contact counts)`)
  console.log(`plan hash: ${hash} — dry run only; nothing was written.`)
  return finish(unchanged ? 0 : 4)
}

const isEntryPoint = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isEntryPoint) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = error instanceof InputError ? 2 : 1
    })
}
