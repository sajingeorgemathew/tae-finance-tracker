/**
 * Restoring the pre-cutover hosted dataset from the private backup.
 *
 * Generated from `hosted-backup.json` alone — never from the workbook — so it
 * restores exactly what was backed up: every row of the twelve finance tables
 * with its id, relationships, values and its own `created_at`/`updated_at`.
 * Inserts do not fire the `updated_at` triggers (they are BEFORE UPDATE), so
 * the timestamps come back as they were. The audit log is append-only: its
 * backed-up rows are re-inserted if missing, nothing in it is deleted, and the
 * restore adds one row saying it ran.
 *
 * **Why it is staged.** The Management API refuses a request body above
 * roughly 2.5 MB (measured: 2.5 MB accepted, 3 MB rejected with 413), and the
 * backup is several times that. So the restore is three steps, run in order:
 *
 *  1. *Stage* (several files, each under the ceiling): load the backup rows
 *     into `cutover_05a_restore.restore_rows`, a private table no API role can
 *     reach. Idempotent; touches no finance table.
 *  2. *Swap* (one small DO block = one transaction): refuses unless the session
 *     confirms the backup hash and receipts/deliveries are as backed up; proves
 *     the staging table holds exactly the backup's rows (count and id set per
 *     table); replaces the twelve finance tables from it, children deleted
 *     first and parents inserted first; then requires the full-row fingerprint
 *     of every table to equal the backup's. Any difference rolls it all back.
 *  3. *Cleanup*: drop the staging schema.
 *
 * **Verification** never touches a live row and creates nothing on hosted:
 * each staged chunk is also rendered as a check that inserts it into a
 * temporary copy of its real table (structure, checks and keys copied from
 * `public`) through the same `jsonb_populate_recordset` path, requires every
 * restored row to equal its backed-up row column for column, and then always
 * raises so the transaction rolls back. `localRestoreChecks` proves the rest
 * offline: coverage, ids and the backup's own referential integrity.
 */

import { createHash } from 'node:crypto'

import { BACKUP_TABLES, TICKET, type BackupTable } from './config.mts'
import { fingerprintExpression, idsMd5Of } from './hosted.mts'
import { insertColumnsOf, safeDollarTag } from './sql.mts'

import type { HostedBackup } from './backup.mts'

/** A safe ceiling for one Management API request body. */
export const MAX_REQUEST_BYTES = 2_400_000

/** Chunks are kept well under the ceiling to leave room for the SQL around them. */
const CHUNK_PAYLOAD_BYTES = 1_800_000

export const STAGING_SCHEMA = 'cutover_05a_restore'
export const STAGING_TABLE = `${STAGING_SCHEMA}.restore_rows`

/** Children first. The audit log is never deleted from. */
export const RESTORE_DELETE_ORDER = [
  'receipt_deliveries',
  'receipts',
  'reminder_deliveries',
  'payments',
  'installments',
  'student_finance_records',
  'batch_finance_columns',
  'batches',
  'students',
  'import_exceptions',
  'import_batches',
  'programs',
] as const satisfies readonly BackupTable[]

/** Parents first. */
export const RESTORE_INSERT_ORDER = [
  'programs',
  'batches',
  'students',
  'student_finance_records',
  'installments',
  'payments',
  'receipts',
  'receipt_deliveries',
  'reminder_deliveries',
  'import_batches',
  'import_exceptions',
  'batch_finance_columns',
  'audit_log',
] as const satisfies readonly BackupTable[]

const ACTIVITY_TABLES = ['receipts', 'receipt_deliveries', 'reminder_deliveries'] as const

/** Every foreign key between the backed-up tables. */
export const REFERENCES: { child: BackupTable; column: string; parent: BackupTable; nullable: boolean }[] = [
  { child: 'batches', column: 'program_id', parent: 'programs', nullable: false },
  { child: 'student_finance_records', column: 'student_id', parent: 'students', nullable: false },
  { child: 'student_finance_records', column: 'program_id', parent: 'programs', nullable: false },
  { child: 'student_finance_records', column: 'batch_id', parent: 'batches', nullable: true },
  { child: 'installments', column: 'student_finance_record_id', parent: 'student_finance_records', nullable: false },
  { child: 'payments', column: 'student_finance_record_id', parent: 'student_finance_records', nullable: false },
  { child: 'payments', column: 'installment_id', parent: 'installments', nullable: true },
  { child: 'receipts', column: 'payment_id', parent: 'payments', nullable: false },
  { child: 'receipts', column: 'student_finance_record_id', parent: 'student_finance_records', nullable: false },
  { child: 'receipt_deliveries', column: 'receipt_id', parent: 'receipts', nullable: false },
  { child: 'reminder_deliveries', column: 'student_finance_record_id', parent: 'student_finance_records', nullable: false },
  { child: 'import_exceptions', column: 'import_batch_id', parent: 'import_batches', nullable: true },
  { child: 'batch_finance_columns', column: 'batch_id', parent: 'batches', nullable: false },
]

export const RESTORE_VERIFY_MARKER = 'RESTORE_VERIFY_OK'
export const RESTORE_CONFIRM_SETTING = 'finance.cutover_05a_restore'

function quoteJson(value: unknown, base: string): string {
  const text = JSON.stringify(value)
  const tag = safeDollarTag(text, base)
  return `$${tag}$${text}$${tag}$::jsonb`
}

function columnList(columns: readonly string[]): string {
  for (const column of columns) if (!/^[a-z_][a-z0-9_]*$/.test(column)) throw new Error(`unexpected column ${JSON.stringify(column)}`)
  return columns.join(', ')
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface RestoreChunk {
  table: BackupTable
  /** Position of the first row within its table (0-based), so chunk boundaries never matter. */
  firstSeq: number
  rows: Record<string, unknown>[]
}

/** Splits every non-empty table into chunks whose JSON stays under the payload size. Deterministic. */
export function planRestoreChunks(backup: HostedBackup, payloadBytes = CHUNK_PAYLOAD_BYTES): RestoreChunk[] {
  const chunks: RestoreChunk[] = []
  for (const table of RESTORE_INSERT_ORDER) {
    const rows = backup.tables[table]
    let current: RestoreChunk | null = null
    let size = 0
    rows.forEach((row, index) => {
      const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
      if (bytes > payloadBytes) throw new Error(`${table} row ${index} alone exceeds the chunk size`)
      if (current === null || size + bytes > payloadBytes) {
        current = { table, firstSeq: index, rows: [] }
        chunks.push(current)
        size = 0
      }
      current.rows.push(row)
      size += bytes
    })
  }
  return chunks
}

/** Offline proof: the chunks cover every row once, ids match the fingerprint, every reference resolves. */
export function localRestoreChecks(backup: HostedBackup, chunks: readonly RestoreChunk[]): string[] {
  const problems: string[] = []
  for (const table of BACKUP_TABLES) {
    const staged = chunks.filter((chunk) => chunk.table === table).flatMap((chunk) => chunk.rows)
    const expected = backup.fingerprint.tables[table]
    if (staged.length !== expected.count) problems.push(`${table}: ${staged.length} staged rows, backup fingerprint ${expected.count}`)
    if (idsMd5Of(staged.map((row) => String(row.id))) !== expected.idsMd5) problems.push(`${table}: staged id set differs from the backup fingerprint`)
  }
  for (const reference of REFERENCES) {
    const parents = new Set(backup.tables[reference.parent].map((row) => row.id))
    const dangling = backup.tables[reference.child].filter((row) => {
      const value = row[reference.column]
      if (value === null || value === undefined) return !reference.nullable
      return !parents.has(String(value))
    }).length
    if (dangling > 0) problems.push(`${reference.child}.${reference.column}: ${dangling} backed-up row(s) reference no ${reference.parent}`)
  }
  return problems
}

function header(backup: HostedBackup, backupSha256: string, what: string): string[] {
  return [
    `-- ${TICKET} restore of the pre-cutover hosted dataset — ${what}. GENERATED — do not edit by hand.`,
    `-- backup sha256: ${backupSha256} · captured ${backup.capturedAt} · project ${backup.projectRef}`,
  ]
}

export function renderStageSql(backup: HostedBackup, backupSha256: string, chunk: RestoreChunk, index: number, total: number): string {
  const rows = chunk.rows.map((row, offset) => ({ seq: chunk.firstSeq + offset, row }))
  return [
    ...header(backup, backupSha256, `stage ${index + 1} of ${total} (${chunk.table}, ${chunk.rows.length} rows); touches no finance table`),
    `create schema if not exists ${STAGING_SCHEMA};`,
    `revoke all on schema ${STAGING_SCHEMA} from public, anon, authenticated;`,
    `create table if not exists ${STAGING_TABLE} (tbl text not null, seq integer not null, row jsonb not null, primary key (tbl, seq));`,
    `revoke all on ${STAGING_TABLE} from public, anon, authenticated;`,
    `insert into ${STAGING_TABLE} (tbl, seq, row)`,
    `  select '${chunk.table}', (e->>'seq')::integer, e->'row' from jsonb_array_elements(${quoteJson(rows, 'rows')}) as e`,
    `  on conflict (tbl, seq) do update set row = excluded.row;`,
    '',
  ].join('\n')
}

export function renderSwapSql(backup: HostedBackup, backupSha256: string): string {
  const compared = BACKUP_TABLES.filter((table) => table !== 'audit_log')
  const expected = {
    tables: Object.fromEntries(compared.map((table) => [table, backup.fingerprint.tables[table]])),
    studentsEmailNonNull: backup.fingerprint.studentsEmailNonNull,
    studentsPhoneNonNull: backup.fingerprint.studentsPhoneNonNull,
  }
  const staged = (table: BackupTable): string => `(select coalesce(jsonb_agg(r.row order by r.seq), '[]'::jsonb) from ${STAGING_TABLE} r where r.tbl = '${table}')`

  const lines: string[] = [...header(backup, backupSha256, 'swap (one transaction)')]
  lines.push(`-- Run only after every stage file. The same session must first execute:  set ${RESTORE_CONFIRM_SETTING} = '${backupSha256}';`)
  lines.push(`do $restore$`)
  lines.push(`declare`)
  lines.push(`  v_expected jsonb := ${quoteJson(expected, 'expected')};`)
  lines.push(`  v_actual jsonb;`)
  lines.push(`  n bigint;`)
  lines.push(`  v_ids text;`)
  lines.push(`begin`)
  lines.push(`  if coalesce(current_setting('${RESTORE_CONFIRM_SETTING}', true), '') <> '${backupSha256}' then`)
  lines.push(`    raise exception 'RESTORE_NOT_CONFIRMED: set ${RESTORE_CONFIRM_SETTING} to the backup sha256 in this session first';`)
  lines.push(`  end if;`)
  for (const table of ACTIVITY_TABLES) {
    lines.push(`  select count(*) into n from public.${table};`)
    lines.push(`  if n <> ${backup.tables[table].length} then raise exception 'RESTORE_BLOCKED: public.${table} holds % rows, the backup ${backup.tables[table].length}; receipts or deliveries were made after the cutover', n; end if;`)
  }
  lines.push(``)
  lines.push(`  -- 1. the staging table must hold exactly the backup, table by table`)
  for (const table of BACKUP_TABLES) {
    const fingerprint = backup.fingerprint.tables[table]
    lines.push(`  select count(*), coalesce(md5(string_agg(r.row->>'id', ',' order by (r.row->>'id')::uuid)), md5('')) into n, v_ids from ${STAGING_TABLE} r where r.tbl = '${table}';`)
    lines.push(`  if n <> ${fingerprint.count} or v_ids <> '${fingerprint.idsMd5}' then raise exception 'RESTORE_STAGING_INCOMPLETE ${table}: % rows staged, expected ${fingerprint.count}', n; end if;`)
  }
  lines.push(``)
  lines.push(`  -- 2. clear the twelve finance tables, children first`)
  for (const table of RESTORE_DELETE_ORDER) lines.push(`  delete from public.${table} where true;`)
  lines.push(``)
  lines.push(`  -- 3. re-insert every backed-up row, parents first, with its own ids and timestamps`)
  for (const table of RESTORE_INSERT_ORDER) {
    const rows = backup.tables[table]
    if (rows.length === 0) continue
    const columns = columnList(insertColumnsOf(rows))
    const conflict = table === 'audit_log' ? ' on conflict (id) do nothing' : ''
    lines.push(`  insert into public.${table} (${columns})`)
    lines.push(`    select ${columns} from jsonb_populate_recordset(null::public.${table}, ${staged(table)})${conflict};`)
    if (conflict === '') {
      lines.push(`  get diagnostics n = row_count;`)
      lines.push(`  if n <> ${rows.length} then raise exception 'RESTORE_INSERT_COUNT ${table}: % rows, expected ${rows.length}', n; end if;`)
    }
  }
  lines.push(``)
  lines.push(`  -- 4. the result must be the backup, row for row (count, id set and full-row md5 per table)`)
  lines.push(
    `  v_actual := jsonb_build_object('tables', jsonb_build_object(${compared.map((table) => `'${table}', ${fingerprintExpression(table)}::jsonb`).join(', ')}), ` +
      `'studentsEmailNonNull', (select count(*) from public.students where email is not null), ` +
      `'studentsPhoneNonNull', (select count(*) from public.students where phone is not null));`,
  )
  lines.push(`  if v_actual is distinct from v_expected then`)
  lines.push(`    raise exception 'RESTORE_MISMATCH: restored state % differs from the backup %', v_actual, v_expected;`)
  lines.push(`  end if;`)
  lines.push(`  insert into public.audit_log (actor_user_id, entity_type, entity_id, action, metadata)`)
  lines.push(`    values (null, 'import_batches', null, 'finance_cutover_05a_restore', ${quoteJson({ ticket: TICKET, backup_sha256: backupSha256, captured_at: backup.capturedAt }, 'meta')});`)
  lines.push(`  raise notice 'pre-cutover dataset restored from backup ${backupSha256}';`)
  lines.push(`end`)
  lines.push(`$restore$;`)
  return `${lines.join('\n')}\n`
}

export function renderCleanupSql(backup: HostedBackup, backupSha256: string): string {
  return [...header(backup, backupSha256, 'cleanup (after a successful swap, or to abandon a staged restore)'), `drop schema if exists ${STAGING_SCHEMA} cascade;`, ''].join('\n')
}

/**
 * One chunk's verification: insert into a temporary copy of the real table,
 * require every row to equal its backed-up row column for column, roll back.
 */
export function renderChunkVerifySql(backup: HostedBackup, backupSha256: string, chunk: RestoreChunk, index: number, total: number): string {
  const columns = columnList(insertColumnsOf(chunk.rows))
  const lines: string[] = [...header(backup, backupSha256, `verification ${index + 1} of ${total} (${chunk.table}); pg_temp only, always rolled back`)]
  lines.push(`do $verify$`)
  lines.push(`declare`)
  lines.push(`  v_rows jsonb := ${quoteJson(chunk.rows, 'rows')};`)
  lines.push(`  n bigint;`)
  lines.push(`begin`)
  lines.push(`  create temporary table ${chunk.table} (like public.${chunk.table} including all) on commit drop;`)
  lines.push(`  insert into pg_temp.${chunk.table} (${columns})`)
  lines.push(`    select ${columns} from jsonb_populate_recordset(null::public.${chunk.table}, v_rows);`)
  lines.push(`  get diagnostics n = row_count;`)
  lines.push(`  if n <> ${chunk.rows.length} then raise exception 'RESTORE_VERIFY_FAILED ${chunk.table}: % rows inserted, expected ${chunk.rows.length}', n; end if;`)
  lines.push(`  select count(*) into n from jsonb_array_elements(v_rows) as s`)
  lines.push(`    left join pg_temp.${chunk.table} t on t.id = (s->>'id')::uuid`)
  lines.push(`    where t.id is null or to_jsonb(t) <> s;`)
  lines.push(`  if n <> 0 then raise exception 'RESTORE_VERIFY_FAILED ${chunk.table}: % row(s) do not restore to their backed-up values', n; end if;`)
  lines.push(`  raise exception '${RESTORE_VERIFY_MARKER} ${chunk.table} [${chunk.firstSeq}..${chunk.firstSeq + chunk.rows.length - 1}]: ${chunk.rows.length} rows restore exactly; rolled back';`)
  lines.push(`end`)
  lines.push(`$verify$;`)
  return `${lines.join('\n')}\n`
}

/** Raise-first rendering of the swap: proves it parses and compiles; runs nothing. */
export function renderSwapProbeSql(swapSql: string): string {
  const marker = '\nbegin\n'
  const at = swapSql.indexOf(marker)
  if (at === -1 || swapSql.indexOf(marker, at + 1) !== -1) throw new Error('swap statement does not have exactly one body')
  return `${swapSql.slice(0, at + marker.length)}  raise exception '${RESTORE_VERIFY_MARKER} swap: parsed and compiled; nothing ran';\n${swapSql.slice(at + marker.length)}`
}

export interface RestoreFile {
  order: number
  file: string
  step: 'stage' | 'swap' | 'cleanup'
  sql: string
  sha256: string
  bytes: number
}

export interface RestoreArtifacts {
  files: RestoreFile[]
  verifyFiles: { file: string; sql: string }[]
  chunks: RestoreChunk[]
  localProblems: string[]
  /** The manifest text; its sha256 is "the restore artifact hash". */
  manifest: string
  manifestSha256: string
}

export function buildRestoreArtifacts(backup: HostedBackup, backupSha256: string): RestoreArtifacts {
  const chunks = planRestoreChunks(backup)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const file = (order: number, name: string, step: RestoreFile['step'], sql: string): RestoreFile => {
    const bytes = Buffer.byteLength(sql, 'utf8')
    if (bytes > MAX_REQUEST_BYTES) throw new Error(`${name} is ${bytes} bytes, over the ${MAX_REQUEST_BYTES}-byte request ceiling`)
    return { order, file: name, step, sql, sha256: sha256(sql), bytes }
  }
  const files: RestoreFile[] = [
    ...chunks.map((chunk, index) => file(index + 1, `restore-pre-cutover-${pad(index + 1)}-stage-${chunk.table}.sql`, 'stage', renderStageSql(backup, backupSha256, chunk, index, chunks.length))),
  ]
  files.push(file(files.length + 1, `restore-pre-cutover-${pad(files.length + 1)}-swap.sql`, 'swap', renderSwapSql(backup, backupSha256)))
  files.push(file(files.length + 1, `restore-pre-cutover-${pad(files.length + 1)}-cleanup.sql`, 'cleanup', renderCleanupSql(backup, backupSha256)))
  const verifyFiles = chunks.map((chunk, index) => {
    const sql = renderChunkVerifySql(backup, backupSha256, chunk, index, chunks.length)
    if (Buffer.byteLength(sql, 'utf8') > MAX_REQUEST_BYTES) throw new Error(`verification ${index + 1} is over the request ceiling`)
    return { file: `restore-verify-${pad(index + 1)}-${chunk.table}.sql`, sql }
  })
  verifyFiles.push({ file: `restore-verify-${pad(chunks.length + 1)}-swap-probe.sql`, sql: renderSwapProbeSql(files[files.length - 2].sql) })

  const manifest = `${JSON.stringify(
    {
      ticket: TICKET,
      backupSha256,
      maxRequestBytes: MAX_REQUEST_BYTES,
      confirm: `set ${RESTORE_CONFIRM_SETTING} = '${backupSha256}';  -- in the swap's session`,
      files: files.map(({ order, file: name, step, sha256: hash, bytes }) => ({ order, file: name, step, sha256: hash, bytes })),
    },
    null,
    1,
  )}\n`
  return { files, verifyFiles, chunks, localProblems: localRestoreChecks(backup, chunks), manifest, manifestSha256: sha256(manifest) }
}
