import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { buildManifest, serializeBackup, verifyBackupFiles, type HostedBackup } from './backup.mts'
import { EXPECTED_BASELINE, EXPECTED_WORKBOOK_SHA256 } from './config.mts'
import { cutoverWorkbook } from './fixtures.mts'
import { evaluateGates, parseArguments, type GateInput } from './gates.mts'
import { fingerprintOf, hostedFixture } from './hosted-fixtures.mts'
import { parseCutoverWorkbook } from './parse.mts'
import { buildCutoverPlan, cutoverPlanHash } from './plan.mts'
import {
  buildRestoreArtifacts,
  localRestoreChecks,
  MAX_REQUEST_BYTES,
  planRestoreChunks,
  RESTORE_CONFIRM_SETTING,
  RESTORE_DELETE_ORDER,
  RESTORE_INSERT_ORDER,
  RESTORE_VERIFY_MARKER,
  STAGING_TABLE,
} from './restore.mts'
import { PROBE_MARKER, renderApplySql, renderProbeSql, safeDollarTag } from './sql.mts'
import { buildTargetDataset, targetHash } from './target.mts'

import type { StateFingerprint } from './hosted.mts'

/**
 * FINANCE-CUTOVER-05A — the destructive path: its gate, the statement it
 * would run, and the backup it depends on. Nothing here touches a database.
 */

const PLAN_HASH = 'c'.repeat(64)
const BACKUP_SHA = 'd'.repeat(64)
const RESTORE_SHA = '9'.repeat(64)

/** A live fingerprint whose counts are exactly the ticket's baseline. */
function baselineFingerprint(): StateFingerprint {
  const tables = Object.fromEntries(
    Object.entries(EXPECTED_BASELINE)
      .filter(([key]) => !key.startsWith('students_'))
      .map(([table, count]) => [table, { count, idsMd5: `ids-${table}`, rowsMd5: `rows-${table}` }]),
  ) as StateFingerprint['tables']
  return { tables, studentsEmailNonNull: 0, studentsPhoneNonNull: 0 }
}

function passingInput(overrides: Partial<GateInput> = {}): GateInput {
  const live = baselineFingerprint()
  return {
    apply: true,
    requestedPlanHash: PLAN_HASH,
    workbookSha256: EXPECTED_WORKBOOK_SHA256,
    backup: { present: true, ok: true, sha256: BACKUP_SHA, problems: [] },
    plannedBackupSha256: BACKUP_SHA,
    restoreSha256: RESTORE_SHA,
    plannedRestoreSha256: RESTORE_SHA,
    liveFingerprint: live,
    plannedPreState: live,
    recomputedPlanHash: PLAN_HASH,
    blockers: [],
    ...overrides,
  }
}

const codes = (input: GateInput): string[] => evaluateGates(input).refusals.map((refusal) => refusal.code)

describe('the apply gate', () => {
  it('is a dry run without --apply, whatever else is given', () => {
    const args = parseArguments([`--plan-hash=${PLAN_HASH}`])
    assert.equal(args.apply, false)
    const result = evaluateGates(passingInput({ apply: args.apply }))
    assert.equal(result.mode, 'dry_run')
    assert.equal(result.allowed, false)
  })

  it('allows the apply only when every condition holds', () => {
    assert.deepEqual(evaluateGates(passingInput()), { mode: 'apply', allowed: true, refusals: [] })
  })

  it('refuses --apply without a plan hash, or with a malformed one', () => {
    assert.ok(codes(passingInput({ requestedPlanHash: null })).includes('PLAN_HASH_REQUIRED'))
    assert.ok(codes(passingInput({ requestedPlanHash: 'abc' })).includes('PLAN_HASH_MALFORMED'))
    assert.equal(parseArguments(['--apply', `--plan-hash=${PLAN_HASH.toUpperCase()}`]).planHash, PLAN_HASH)
  })

  it('refuses a stale source workbook hash', () => {
    assert.deepEqual(codes(passingInput({ workbookSha256: 'e'.repeat(64) })), ['STALE_SOURCE_HASH'])
  })

  it('refuses a stale hosted baseline: a count moved', () => {
    const live = baselineFingerprint()
    live.tables.payments = { ...live.tables.payments, count: live.tables.payments.count + 1 }
    assert.deepEqual(codes(passingInput({ liveFingerprint: live })), ['STALE_HOSTED_BASELINE'])
  })

  it('refuses a stale hosted baseline: same counts, a row changed', () => {
    const live = baselineFingerprint()
    live.tables.students = { ...live.tables.students, rowsMd5: 'changed' }
    assert.deepEqual(codes(passingInput({ liveFingerprint: live })), ['STALE_HOSTED_BASELINE'])
  })

  it('refuses a contact written since the plan', () => {
    assert.deepEqual(codes(passingInput({ liveFingerprint: { ...baselineFingerprint(), studentsEmailNonNull: 1 } })), ['STALE_HOSTED_BASELINE'])
  })

  it('refuses a missing backup', () => {
    assert.deepEqual(codes(passingInput({ backup: { present: false, ok: false, sha256: null, problems: ['backup file not found'] } })), ['BACKUP_MISSING'])
  })

  it('refuses an invalid backup, or one that is not the planned backup', () => {
    assert.deepEqual(codes(passingInput({ backup: { present: true, ok: false, sha256: BACKUP_SHA, problems: ['payments: id set differs'] } })), ['BACKUP_INVALID'])
    assert.deepEqual(codes(passingInput({ backup: { present: true, ok: true, sha256: 'f'.repeat(64), problems: [] } })), ['BACKUP_NOT_THE_PLANNED_BACKUP'])
  })

  it('refuses a plan hash that is not the plan recomputed now', () => {
    assert.deepEqual(codes(passingInput({ recomputedPlanHash: 'f'.repeat(64) })), ['PLAN_HASH_MISMATCH'])
  })

  it('refuses without the restore statement, or with one that is not the planned restore', () => {
    assert.deepEqual(codes(passingInput({ restoreSha256: null })), ['RESTORE_MISSING'])
    assert.deepEqual(codes(passingInput({ restoreSha256: '8'.repeat(64) })), ['RESTORE_NOT_THE_PLANNED_RESTORE'])
  })

  it('refuses a plan with a blocking issue', () => {
    assert.deepEqual(codes(passingInput({ blockers: ['HOSTED_DUPLICATE_STUDENT_NUMBER'] })), ['PLAN_HAS_BLOCKERS'])
  })

  it('rejects unknown arguments rather than ignoring them', () => {
    assert.deepEqual(parseArguments(['--force']).unknown, ['--force'])
  })
})

describe('the apply statement', () => {
  const hosted = hostedFixture()
  const target = buildTargetDataset({ parsed: parseCutoverWorkbook(cutoverWorkbook()), workbook: { fileName: 'fixture.xlsx', sha256: 'a'.repeat(64) }, hosted })
  const plan = buildCutoverPlan({ hosted, fingerprint: fingerprintOf(hosted), backup: { file: 'b.json', sha256: BACKUP_SHA }, restore: { file: 'r.sql', sha256: RESTORE_SHA }, target, targetHash: targetHash(target), receiptNumbered: new Set(['PSW', 'ECEA']) })
  const hash = cutoverPlanHash(plan)
  const sql = renderApplySql(plan, hash, target)

  it('is one DO block that checks the pre-state before anything else', () => {
    assert.equal(sql.match(/^do \$cutover\$/gm)?.length, 1)
    const body = sql.slice(sql.indexOf('\nbegin\n'))
    assert.ok(body.indexOf('STALE_PRESTATE') < body.indexOf('delete from'))
  })

  it('deletes in foreign-key order and inserts parents first, each count-checked', () => {
    const order = [...sql.matchAll(/^ {2}(delete from|insert into) public\.([a-z_]+)/gm)].map((match) => `${match[1].split(' ')[0]}:${match[2]}`)
    assert.deepEqual(order, [
      'delete:payments', 'delete:installments', 'delete:student_finance_records', 'delete:batch_finance_columns', 'delete:batches', 'delete:students',
      'insert:programs', 'insert:batches', 'insert:students', 'insert:student_finance_records', 'insert:installments', 'insert:payments',
      'insert:batch_finance_columns', 'insert:import_batches', 'insert:import_exceptions', 'insert:audit_log',
    ])
    assert.equal(sql.match(/DELETE_COUNT/g)?.length, 6)
  })

  it('ends with a post-state gate', () => {
    assert.ok(sql.indexOf('POST_STATE_MISMATCH') > sql.lastIndexOf('insert into public.audit_log'))
  })

  it('picks a dollar-quote tag that never occurs in the payload', () => {
    assert.equal(safeDollarTag('abc', 'data'), 'data')
    assert.equal(safeDollarTag('x $data$ y', 'data'), 'data1')
    assert.equal(safeDollarTag('x $data$ $data1$', 'data'), 'data2')
  })

  it('probes by raising before the first statement of the body', () => {
    const probe = renderProbeSql(sql)
    const body = probe.slice(probe.indexOf('\nbegin\n') + '\nbegin\n'.length)
    assert.ok(body.startsWith(`  raise exception '${PROBE_MARKER}`))
    assert.ok(body.indexOf(PROBE_MARKER) < body.indexOf('delete from'))
  })
})

describe('backup read-back', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cutover-backup-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const hosted = hostedFixture()
  const backup: HostedBackup = { ticket: 'T', capturedAt: '2026-10-21T00:00:00.000Z', projectRef: 'ref', readRoute: 'fixture', fingerprint: fingerprintOf(hosted), tables: hosted }
  const backupPath = path.join(dir, 'b.json')
  const manifestPath = path.join(dir, 'm.json')
  const text = serializeBackup(backup)
  writeFileSync(backupPath, text)
  writeFileSync(manifestPath, JSON.stringify(buildManifest(backup, 'b.json', text)))

  it('verifies a complete backup against its manifest and fingerprint', () => {
    const result = verifyBackupFiles(backupPath, manifestPath)
    assert.equal(result.ok, true, result.problems.join('; '))
    assert.equal(result.backup?.tables.payments.length, 3)
  })

  it('refuses a missing backup file', () => {
    assert.equal(verifyBackupFiles(path.join(dir, 'none.json'), manifestPath).ok, false)
  })

  it('refuses a backup whose bytes changed after the manifest was written', () => {
    writeFileSync(path.join(dir, 'tampered.json'), readFileSync(backupPath, 'utf8').replace('Etransfer', 'Cheque'))
    const result = verifyBackupFiles(path.join(dir, 'tampered.json'), manifestPath)
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((problem) => problem.includes('sha256')))
  })

  it('refuses a backup missing a row the fingerprint counted', () => {
    const short: HostedBackup = { ...backup, tables: { ...hosted, payments: hosted.payments.slice(1) } }
    const shortText = serializeBackup(short)
    writeFileSync(path.join(dir, 'short.json'), shortText)
    writeFileSync(path.join(dir, 'short-m.json'), JSON.stringify(buildManifest(short, 'short.json', shortText)))
    const result = verifyBackupFiles(path.join(dir, 'short.json'), path.join(dir, 'short-m.json'))
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((problem) => problem.startsWith('payments')))
  })
})

describe('the staged restore', () => {
  const hosted = hostedFixture()
  const backup: HostedBackup = { ticket: 'T', capturedAt: '2026-10-21T00:00:00.000Z', projectRef: 'ref', readRoute: 'fixture', fingerprint: fingerprintOf(hosted), tables: hosted }
  const artifacts = buildRestoreArtifacts(backup, BACKUP_SHA)
  const swap = artifacts.files.find((file) => file.step === 'swap')?.sql ?? ''
  const statements = (sql: string, verb: string): string[] => [...sql.matchAll(new RegExp(`^ {2}${verb} (?:from|into) (?:public|pg_temp)\\.([a-z_]+)`, 'gm'))].map((match) => match[1])

  it('orders stage files, then one swap, then cleanup, every file under the request ceiling', () => {
    assert.deepEqual([...new Set(artifacts.files.map((file) => file.step))], ['stage', 'swap', 'cleanup'])
    assert.deepEqual(artifacts.files.map((file) => file.order), artifacts.files.map((_, index) => index + 1))
    assert.ok(artifacts.files.every((file) => file.bytes <= MAX_REQUEST_BYTES))
  })

  it('chunks big tables without losing or repeating a row', () => {
    const chunks = planRestoreChunks(backup, 700)
    assert.ok(chunks.filter((chunk) => chunk.table === 'payments').length > 1, 'small chunk size forces several payment chunks')
    assert.deepEqual(localRestoreChecks(backup, chunks), [])
    assert.ok(localRestoreChecks(backup, chunks.slice(1)).length > 0, 'a missing chunk is caught')
  })

  it('proves the backup\'s own references offline', () => {
    assert.deepEqual(artifacts.localProblems, [])
    const broken: HostedBackup = { ...backup, tables: { ...hosted, payments: [{ ...hosted.payments[0], student_finance_record_id: '00000000-0000-4000-8000-00000000dead' }] } }
    broken.fingerprint = fingerprintOf(broken.tables)
    assert.ok(localRestoreChecks(broken, planRestoreChunks(broken)).some((problem) => problem.startsWith('payments.student_finance_record_id')))
  })

  it('stages into a private table and never touches a finance table', () => {
    for (const file of artifacts.files.filter((entry) => entry.step === 'stage')) {
      assert.equal(/(delete from|insert into) public\./.test(file.sql), false)
      assert.ok(file.sql.includes(`insert into ${STAGING_TABLE}`))
      assert.ok(file.sql.includes('revoke all on schema cutover_05a_restore from public, anon, authenticated'))
    }
  })

  it('swaps in one DO block that refuses without the confirmed backup hash or with post-cutover receipts', () => {
    assert.equal(swap.match(/^do \$restore\$/gm)?.length, 1)
    const body = swap.slice(swap.indexOf('\nbegin\n'))
    assert.ok(body.indexOf(RESTORE_CONFIRM_SETTING) < body.indexOf('delete from'))
    assert.ok(body.includes(`<> '${BACKUP_SHA}'`))
    for (const table of ['receipts', 'receipt_deliveries', 'reminder_deliveries']) assert.ok(swap.includes(`RESTORE_BLOCKED: public.${table}`))
  })

  it('proves the staging table holds exactly the backup before deleting anything', () => {
    assert.ok(swap.indexOf('RESTORE_STAGING_INCOMPLETE') < swap.indexOf('delete from'))
  })

  it('clears children before parents, never the audit log, re-inserts parents first, then compares to the backup', () => {
    assert.deepEqual(statements(swap, 'delete'), [...RESTORE_DELETE_ORDER])
    assert.deepEqual(
      statements(swap, 'insert').filter((table) => table !== 'audit_log'),
      RESTORE_INSERT_ORDER.filter((table) => hosted[table].length > 0 && table !== 'audit_log'),
    )
    assert.ok(swap.indexOf('RESTORE_MISMATCH') > swap.lastIndexOf('jsonb_populate_recordset'))
  })

  it('restores ids and the original timestamps', () => {
    const stamped = hostedFixture()
    stamped.programs = stamped.programs.map((row) => ({ ...row, created_at: '2026-09-17T21:30:50.15787+00:00', updated_at: '2026-09-17T21:30:50.15787+00:00' }))
    const sql = buildRestoreArtifacts({ ...backup, tables: stamped }, BACKUP_SHA).files.find((file) => file.step === 'swap')?.sql ?? ''
    assert.match(sql, /insert into public\.programs \([^)]*created_at[^)]*\bid\b[^)]*updated_at[^)]*\)/)
  })

  it('verifies each chunk on pg_temp only, column for column, and always rolls back', () => {
    assert.equal(artifacts.verifyFiles.length, artifacts.chunks.length + 1)
    for (const file of artifacts.verifyFiles.slice(0, -1)) {
      assert.equal(/(delete from|insert into) public\./.test(file.sql), false, file.file)
      assert.ok(file.sql.includes(`raise exception '${RESTORE_VERIFY_MARKER}`), file.file)
    }
    assert.ok(artifacts.verifyFiles[0].sql.includes('to_jsonb(t) <> s'))
    const probe = artifacts.verifyFiles[artifacts.verifyFiles.length - 1].sql
    const body = probe.slice(probe.indexOf('\nbegin\n') + '\nbegin\n'.length)
    assert.ok(body.startsWith(`  raise exception '${RESTORE_VERIFY_MARKER} swap`))
  })

  it('hashes the manifest deterministically', () => {
    assert.equal(buildRestoreArtifacts(backup, BACKUP_SHA).manifestSha256, artifacts.manifestSha256)
  })
})
