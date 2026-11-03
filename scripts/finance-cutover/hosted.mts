/**
 * Hosted reads for the cutover — and the one write path, kept separate.
 *
 * Two routes, each used for what it is good at:
 *
 *  * **Linked SQL** (`npx supabase db query --linked`) runs as the database
 *    owner through the Management API, so it sees every row whatever RLS says.
 *    It is the authority for the state fingerprint: a per-table count and an
 *    md5 over every row's full text. Runs are strictly sequential — parallel
 *    invocations race on the CLI's temporary login role.
 *  * The backup rows come through the same route, one table per query, as
 *    `json_agg` of the whole row. The project's REST host is not used at all:
 *    on the network this was built on it is DNS-filtered, and the owner route
 *    is the stronger one anyway — RLS cannot hide a row from it. The backup is
 *    still proved against the fingerprint (same count, same id set per table).
 *
 * Nothing in this module writes except `executeLinkedSqlFile`, which the
 * cutover CLI calls only after every apply gate has passed.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { BACKUP_TABLES, PRIVATE_DIR, type BackupTable } from './config.mts'

/** Tables whose rows carry `updated_at` as well as `created_at`. */
export const TABLES_WITH_UPDATED_AT: ReadonlySet<BackupTable> = new Set<BackupTable>([
  'programs',
  'batches',
  'students',
  'student_finance_records',
  'installments',
  'payments',
  'receipts',
  'batch_finance_columns',
])

export interface TableFingerprint {
  count: number
  /** md5 of the ids, comma-joined in id order. Comparable with a local backup. */
  idsMd5: string
  /** md5 of every row's full text (`t::text`), in id order. Any change to any column changes it. */
  rowsMd5: string
}

export interface StateFingerprint {
  tables: Record<BackupTable, TableFingerprint>
  studentsEmailNonNull: number
  studentsPhoneNonNull: number
}

/** The SQL expression for one table's fingerprint, shared by the dry run and the apply block. */
export function fingerprintExpression(table: BackupTable, schema: 'public' | 'pg_temp' = 'public'): string {
  return (
    `(select json_build_object(` +
    `'count', count(*), ` +
    `'idsMd5', coalesce(md5(string_agg(t.id::text, ',' order by t.id)), md5('')), ` +
    `'rowsMd5', coalesce(md5(string_agg(t::text, '|' order by t.id)), md5(''))` +
    `) from ${schema}.${table} t)`
  )
}

/** One SELECT returning the whole fingerprint as a single JSON value. */
export function fingerprintSql(): string {
  const parts = BACKUP_TABLES.map((table) => `'${table}', ${fingerprintExpression(table)}`)
  return (
    `select json_build_object(\n  'tables', json_build_object(\n    ${parts.join(',\n    ')}\n  ),\n` +
    `  'studentsEmailNonNull', (select count(*) from public.students where email is not null),\n` +
    `  'studentsPhoneNonNull', (select count(*) from public.students where phone is not null)\n` +
    `) as fingerprint;\n`
  )
}

/** md5 of ids exactly as `fingerprintExpression` computes `idsMd5`. */
export function idsMd5Of(ids: readonly string[]): string {
  return createHash('md5').update([...ids].sort().join(','), 'utf8').digest('hex')
}

/** The project the CLI is linked to (`supabase link`), e.g. `hwekiiompxixybxclche`. */
export function linkedProjectRef(repoRoot: string): string {
  return readFileSync(path.join(repoRoot, 'supabase', '.temp', 'project-ref'), 'utf8').trim()
}

export interface LinkedQueryResult {
  rows: Record<string, unknown>[]
}

function writeSqlFile(repoRoot: string, name: string, sql: string): string {
  const dir = path.join(repoRoot, PRIVATE_DIR, 'sql')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  writeFileSync(file, sql, 'utf8')
  return file
}

/**
 * The Supabase CLI the cutover talks through, pinned: `npx supabase` resolved
 * to 3.0.0 on 2026-11-02, and 3.x refuses any statement from an agent run
 * unless it is marked `--read-only` or consented with `--yes`.
 */
export const SUPABASE_CLI = 'supabase@3.0.0'

/**
 * `read-only`: the CLI runs the file in a read-only transaction (every
 * fingerprint, backup read, column check and raise-first probe).
 * `write`: the CLI's hosted-mutation consent is given with `--yes`. Only a
 * human-run `--apply --plan-hash=…` or `--verify-restore` reaches this.
 */
export type CliAccess = 'read-only' | 'write'

function runCli(repoRoot: string, file: string, access: CliAccess): { status: number | null; stdout: string; stderr: string } {
  const consent = access === 'read-only' ? '--read-only' : '--yes'
  const result = spawnSync('npx', ['--yes', SUPABASE_CLI, 'db', 'query', '--linked', consent, '-f', file, '--output-format', 'json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function parseCliRows(stdout: string): Record<string, unknown>[] {
  const start = stdout.indexOf('{')
  if (start === -1) throw new Error('linked query printed no JSON')
  const parsed = JSON.parse(stdout.slice(start)) as { rows?: Record<string, unknown>[] }
  return parsed.rows ?? []
}

/** Runs one read-only SELECT through the linked CLI and returns its rows. */
export function runLinkedQuery(repoRoot: string, name: string, sql: string): LinkedQueryResult {
  const file = writeSqlFile(repoRoot, name, sql)
  const { status, stdout, stderr } = runCli(repoRoot, file, 'read-only')
  if (status !== 0) {
    throw new Error(`linked query ${name} failed (exit ${status}): ${(stderr || stdout).slice(0, 2000)}`)
  }
  return { rows: parseCliRows(stdout) }
}

/** The live fingerprint of every backup table. Read-only. */
export function readStateFingerprint(repoRoot: string): StateFingerprint {
  const { rows } = runLinkedQuery(repoRoot, 'fingerprint.sql', fingerprintSql())
  const value = rows[0]?.fingerprint
  if (value === undefined || value === null) throw new Error('fingerprint query returned no row')
  const parsed = (typeof value === 'string' ? JSON.parse(value) : value) as StateFingerprint
  return parsed
}

/**
 * Executes a SQL file that writes. Only the cutover apply calls this, after
 * every gate has passed. Returns the raw CLI output so the caller can record
 * it; a non-zero exit is the transaction having rolled back.
 */
export function executeLinkedSqlFile(repoRoot: string, file: string, access: CliAccess): { ok: boolean; output: string } {
  const { status, stdout, stderr } = runCli(repoRoot, file, access)
  return { ok: status === 0, output: `${stdout}\n${stderr}`.trim() }
}

export type BackupRow = Record<string, unknown> & { id: string }

/** Every row of one table as Postgres renders it to JSON, ordered by id. */
export function readTableRows(repoRoot: string, table: BackupTable): BackupRow[] {
  const sql = `select coalesce(json_agg(t order by t.id), '[]'::json) as rows from public.${table} t;\n`
  const { rows } = runLinkedQuery(repoRoot, `backup-${table}.sql`, sql)
  const value = rows[0]?.rows
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(parsed)) throw new Error(`backup read of ${table} returned no array`)
  return parsed as BackupRow[]
}

/** Every row of every backup table, sequentially, through the owner route. */
export function readBackupRows(repoRoot: string): Record<BackupTable, BackupRow[]> {
  const out = {} as Record<BackupTable, BackupRow[]>
  for (const table of BACKUP_TABLES) out[table] = readTableRows(repoRoot, table)
  return out
}
