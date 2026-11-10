/**
 * Capturing (or re-using) the private hosted backup — read-only against hosted.
 *
 * An existing backup is re-used only when it still proves out *and* the live
 * hosted fingerprint is byte-for-byte the one it was captured against; that
 * keeps the backup hash, and therefore the plan hash, stable across dry runs
 * of an unchanged database. Otherwise a fresh backup is written and the old
 * pair is kept beside it under a timestamped name, never overwritten.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  buildManifest,
  checkBackupAgainstFingerprint,
  serializeBackup,
  verifyBackupFiles,
  type BackupVerification,
  type HostedBackup,
} from './backup.mts'
import { BACKUP_FILE, BACKUP_MANIFEST_FILE, PRIVATE_DIR, TICKET } from './config.mts'
import { readBackupRows, type StateFingerprint } from './hosted.mts'

export function backupPaths(repoRoot: string): { dir: string; backup: string; manifest: string } {
  const dir = path.join(repoRoot, PRIVATE_DIR)
  return { dir, backup: path.join(dir, BACKUP_FILE), manifest: path.join(dir, BACKUP_MANIFEST_FILE) }
}

export function sameFingerprint(a: StateFingerprint, b: StateFingerprint): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface EnsuredBackup {
  verification: BackupVerification
  created: boolean
  archivedPrevious: string | null
}

export function ensureBackup(
  repoRoot: string,
  projectRef: string,
  live: StateFingerprint,
  options: { refresh: boolean; now: Date; log: (line: string) => void },
): EnsuredBackup {
  const paths = backupPaths(repoRoot)
  mkdirSync(paths.dir, { recursive: true })

  if (!options.refresh && existsSync(paths.backup)) {
    const existing = verifyBackupFiles(paths.backup, paths.manifest)
    if (existing.ok && existing.backup && sameFingerprint(existing.backup.fingerprint, live)) {
      options.log(`backup: re-using ${BACKUP_FILE} (verified; hosted unchanged since ${existing.backup.capturedAt})`)
      return { verification: existing, created: false, archivedPrevious: null }
    }
    options.log(`backup: existing ${BACKUP_FILE} is ${existing.ok ? 'stale against the live fingerprint' : 'not verifiable'}; capturing afresh`)
  }

  let archivedPrevious: string | null = null
  if (existsSync(paths.backup)) {
    const stamp = options.now.toISOString().replace(/[:.]/g, '-')
    archivedPrevious = `${paths.backup}.${stamp}.previous`
    renameSync(paths.backup, archivedPrevious)
    if (existsSync(paths.manifest)) renameSync(paths.manifest, `${paths.manifest}.${stamp}.previous`)
  }

  const tables = readBackupRows(repoRoot)
  const backup: HostedBackup = {
    ticket: TICKET,
    capturedAt: options.now.toISOString(),
    projectRef,
    readRoute:
      'linked SQL as the database owner: json_agg of every row per table, ordered by id; proved against the count and id-set md5 per table',
    fingerprint: live,
    tables,
  }

  const problems = checkBackupAgainstFingerprint(backup, live)
  if (problems.length > 0) {
    throw new Error(`backup is incomplete against the hosted fingerprint: ${problems.join('; ')}`)
  }

  const text = serializeBackup(backup)
  writeFileSync(paths.backup, text, 'utf8')
  writeFileSync(paths.manifest, `${JSON.stringify(buildManifest(backup, BACKUP_FILE, text), null, 2)}\n`, 'utf8')

  const verification = verifyBackupFiles(paths.backup, paths.manifest)
  if (!verification.ok) throw new Error(`backup did not verify on read-back: ${verification.problems.join('; ')}`)
  options.log(`backup: wrote ${BACKUP_FILE} (${verification.manifest?.bytes} bytes, sha256 ${verification.sha256}); read back and verified`)
  return { verification, created: true, archivedPrevious }
}
