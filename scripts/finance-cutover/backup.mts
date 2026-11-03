/**
 * The private hosted backup — written before any deletion is even proposed.
 *
 * The backup holds every row of every finance table with its ids and
 * timestamps, enough to rebuild the hosted operational data exactly. It lives
 * under `.private/finance-cutover-05a/` (ignored by Git) and is never sent
 * anywhere.
 *
 * A backup is only trusted once it is proved: the file's SHA-256 matches its
 * manifest, it parses, and every table holds the same count and the same id
 * set as the linked-SQL fingerprint of the hosted database taken at capture
 * time. The cutover plan pins the backup's SHA-256, so an apply cannot run
 * against a backup other than the one reviewed.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

import { BACKUP_TABLES, TICKET, type BackupTable } from './config.mts'
import { idsMd5Of, type BackupRow, type StateFingerprint } from './hosted.mts'

export interface HostedBackup {
  ticket: string
  capturedAt: string
  projectRef: string
  /** How the rows were read, for the reader of the file. */
  readRoute: string
  fingerprint: StateFingerprint
  tables: Record<BackupTable, BackupRow[]>
}

export interface BackupManifest {
  ticket: string
  file: string
  sha256: string
  bytes: number
  capturedAt: string
  projectRef: string
  tables: Record<BackupTable, { rows: number; idsMd5: string; hostedCount: number; hostedIdsMd5: string; hostedRowsMd5: string }>
  verified: boolean
}

export function sha256Of(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Serialises a backup. Rows are already in id order; the text is what gets hashed. */
export function serializeBackup(backup: HostedBackup): string {
  return `${JSON.stringify(backup, null, 1)}\n`
}

/**
 * Proves a backup against the fingerprint it was captured with.
 *
 * Returns the problems found; an empty list means the backup is complete for
 * every table the cutover touches.
 */
export function checkBackupAgainstFingerprint(backup: HostedBackup, fingerprint: StateFingerprint): string[] {
  const problems: string[] = []
  for (const table of BACKUP_TABLES) {
    const rows = backup.tables[table]
    const hosted = fingerprint.tables[table]
    if (!Array.isArray(rows)) {
      problems.push(`${table}: missing from the backup`)
      continue
    }
    if (!hosted) {
      problems.push(`${table}: missing from the hosted fingerprint`)
      continue
    }
    if (rows.length !== hosted.count) {
      problems.push(`${table}: backup holds ${rows.length} rows, hosted holds ${hosted.count}`)
    }
    const local = idsMd5Of(rows.map((row) => row.id))
    if (local !== hosted.idsMd5) {
      problems.push(`${table}: backup id set differs from the hosted id set`)
    }
    if (new Set(rows.map((row) => row.id)).size !== rows.length) {
      problems.push(`${table}: duplicate ids in the backup`)
    }
  }
  return problems
}

export function buildManifest(backup: HostedBackup, file: string, text: string): BackupManifest {
  const tables = {} as BackupManifest['tables']
  for (const table of BACKUP_TABLES) {
    const rows = backup.tables[table]
    const hosted = backup.fingerprint.tables[table]
    tables[table] = {
      rows: rows.length,
      idsMd5: idsMd5Of(rows.map((row) => row.id)),
      hostedCount: hosted.count,
      hostedIdsMd5: hosted.idsMd5,
      hostedRowsMd5: hosted.rowsMd5,
    }
  }
  return {
    ticket: TICKET,
    file,
    sha256: sha256Of(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    capturedAt: backup.capturedAt,
    projectRef: backup.projectRef,
    tables,
    verified: checkBackupAgainstFingerprint(backup, backup.fingerprint).length === 0,
  }
}

export interface BackupVerification {
  ok: boolean
  problems: string[]
  backup: HostedBackup | null
  manifest: BackupManifest | null
  sha256: string | null
}

/**
 * Reads a backup and its manifest back from disk and proves them.
 *
 * This is the read-back the ticket asks for, and the same check the apply
 * runs: missing files, a hash mismatch, unparseable JSON or an incomplete
 * table all fail it.
 */
export function verifyBackupFiles(backupPath: string, manifestPath: string): BackupVerification {
  const fail = (problems: string[]): BackupVerification => ({ ok: false, problems, backup: null, manifest: null, sha256: null })

  if (!existsSync(backupPath)) return fail([`backup file not found: ${backupPath}`])
  if (!existsSync(manifestPath)) return fail([`backup manifest not found: ${manifestPath}`])

  const text = readFileSync(backupPath, 'utf8')
  const sha256 = sha256Of(text)

  let manifest: BackupManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
  } catch (error) {
    return fail([`backup manifest does not parse: ${(error as Error).message}`])
  }

  let backup: HostedBackup
  try {
    backup = JSON.parse(text) as HostedBackup
  } catch (error) {
    return fail([`backup does not parse: ${(error as Error).message}`])
  }

  const problems: string[] = []
  if (manifest.sha256 !== sha256) problems.push(`backup sha256 ${sha256} does not match its manifest (${manifest.sha256})`)
  problems.push(...checkBackupAgainstFingerprint(backup, backup.fingerprint))
  for (const table of BACKUP_TABLES) {
    const expected = manifest.tables?.[table]
    if (!expected) {
      problems.push(`${table}: missing from the manifest`)
      continue
    }
    if (expected.rows !== backup.tables[table]?.length) problems.push(`${table}: manifest says ${expected.rows} rows`)
  }

  return { ok: problems.length === 0, problems, backup, manifest, sha256 }
}
