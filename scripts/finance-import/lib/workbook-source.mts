/**
 * Locating, fingerprinting and opening the source workbook — read-only.
 *
 * Nothing in this module (or anything it is used by) may write to
 * `reference/`. The workbook is opened from a Buffer read with `fs.readFileSync`
 * rather than `XLSX.readFile`, so there is no file handle that could ever be
 * written back through, and the SHA-256 is taken over that exact buffer.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import * as XLSX from 'xlsx'

import type { WorkBook } from 'xlsx'

/** Where source-of-truth inputs live, relative to the repository root. */
export const REFERENCE_DIR = 'reference'

/**
 * Extensions that count as a workbook candidate.
 *
 * The real file is `finance-tracker.xlsx.xlsx` — a doubled extension that came
 * in with the file and is preserved deliberately. Discovery is by extension so
 * that name is never hard-coded: `path.extname` sees only the final `.xlsx`,
 * which is what makes the doubled name a non-issue here.
 */
const WORKBOOK_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xls'])

/** Temporary files Excel leaves behind while a workbook is open. */
const LOCK_FILE_PREFIX = '~$'

export interface WorkbookFingerprint {
  /** Path relative to the repository root, with forward slashes. */
  relativePath: string
  fileName: string
  sizeBytes: number
  sha256: string
  /** File mtime, for spotting a workbook swapped between runs. */
  modifiedAt: string
  analyzedAt: string
}

export interface WorkbookSource {
  fingerprint: WorkbookFingerprint
  workbook: WorkBook
}

export class WorkbookDiscoveryError extends Error {
  readonly candidates: string[]

  constructor(message: string, candidates: string[]) {
    super(message)
    this.name = 'WorkbookDiscoveryError'
    this.candidates = candidates
  }
}

/**
 * Every workbook candidate in `reference/`, sorted for stable output.
 *
 * Exported so the caller can report all candidates when discovery is
 * ambiguous, rather than silently picking one.
 */
export function findWorkbookCandidates(repoRoot: string): string[] {
  const dir = path.join(repoRoot, REFERENCE_DIR)
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(LOCK_FILE_PREFIX))
    .filter((name) => WORKBOOK_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Resolves the single finance workbook.
 *
 * Throws when there is not exactly one candidate: guessing between two
 * workbooks would mean an analysis (and later an import) silently bound to the
 * wrong source file.
 */
export function resolveWorkbookPath(repoRoot: string): string {
  const candidates = findWorkbookCandidates(repoRoot)

  if (candidates.length === 0) {
    throw new WorkbookDiscoveryError(
      `No workbook found in ${REFERENCE_DIR}/. Expected exactly one file with a workbook extension.`,
      candidates,
    )
  }

  if (candidates.length > 1) {
    throw new WorkbookDiscoveryError(
      `Expected exactly one workbook in ${REFERENCE_DIR}/, found ${candidates.length}. ` +
        `Refusing to guess which one is the finance workbook.`,
      candidates,
    )
  }

  return path.join(repoRoot, REFERENCE_DIR, candidates[0])
}

/**
 * Reads and parses the workbook without touching it.
 *
 * `cellFormulas` and `cellNF` are on because formulas and number formats are
 * part of what is being analyzed. `cellDates` is deliberately OFF: date cells
 * must arrive as the raw Excel serial so the analysis can record what the
 * workbook actually stores and interpret it separately.
 */
export function openWorkbook(repoRoot: string, analyzedAt: Date): WorkbookSource {
  const absolutePath = resolveWorkbookPath(repoRoot)
  const buffer = readFileSync(absolutePath)
  const stats = statSync(absolutePath)

  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellFormula: true,
    cellNF: true,
    cellText: true,
    cellDates: false,
    sheetStubs: true,
    dense: false,
  })

  return {
    fingerprint: {
      relativePath: path.relative(repoRoot, absolutePath).split(path.sep).join('/'),
      fileName: path.basename(absolutePath),
      sizeBytes: stats.size,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      modifiedAt: stats.mtime.toISOString(),
      analyzedAt: analyzedAt.toISOString(),
    },
    workbook,
  }
}

/** SHA-256 of the workbook on disk right now. Used to prove it was not modified. */
export function hashWorkbookOnDisk(repoRoot: string): string {
  return createHash('sha256').update(readFileSync(resolveWorkbookPath(repoRoot))).digest('hex')
}
