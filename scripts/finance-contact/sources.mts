/**
 * Discovering and fingerprinting the contact master workbooks — read-only.
 *
 * Every workbook under `reference/` is opened from a Buffer (never through a
 * file handle that could write back), fingerprinted, and offered to the
 * adapter registry. Identification is by structure: the finance workbook and
 * anything else no adapter recognizes is listed as "not a contact master".
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import * as XLSX from 'xlsx'

import type { WorkBook } from 'xlsx'

import { findWorkbookCandidates, REFERENCE_DIR } from '../finance-import/lib/workbook-source.mts'

import type { MasterContactSourceAdapter } from './adapters/adapter.mts'
import { ADAPTERS, identifyWorkbook, type WorkbookIdentification } from './adapters/registry.mts'

export interface ContactWorkbookFingerprint {
  fileName: string
  relativePath: string
  sizeBytes: number
  sha256: string
  modifiedAt: string
  sheetNames: string[]
}

export interface DiscoveredWorkbook {
  fingerprint: ContactWorkbookFingerprint
  workbook: WorkBook
  identification: WorkbookIdentification
}

/** Opens one workbook read-only: parsed from a buffer, hashed over the same bytes. */
export function openReferenceWorkbook(repoRoot: string, fileName: string): { fingerprint: ContactWorkbookFingerprint; workbook: WorkBook } {
  const absolutePath = path.join(repoRoot, REFERENCE_DIR, fileName)
  const buffer = readFileSync(absolutePath)
  const stats = statSync(absolutePath)
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellFormula: false,
    cellNF: true,
    cellText: true,
    cellDates: false,
    sheetStubs: false,
    dense: false,
  })
  return {
    fingerprint: {
      fileName,
      relativePath: `${REFERENCE_DIR}/${fileName}`,
      sizeBytes: stats.size,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      modifiedAt: stats.mtime.toISOString(),
      sheetNames: [...workbook.SheetNames],
    },
    workbook,
  }
}

/** Every workbook in `reference/`, opened and offered to the adapters. */
export function discoverContactWorkbooks(
  repoRoot: string,
  adapters: readonly MasterContactSourceAdapter[] = ADAPTERS,
): DiscoveredWorkbook[] {
  return findWorkbookCandidates(repoRoot).map((fileName) => {
    const opened = openReferenceWorkbook(repoRoot, fileName)
    return { ...opened, identification: identifyWorkbook(opened.workbook, adapters) }
  })
}

/** SHA-256 of a reference file right now, to prove the run left it untouched. */
export function hashReferenceFile(repoRoot: string, fileName: string): string {
  return createHash('sha256').update(readFileSync(path.join(repoRoot, REFERENCE_DIR, fileName))).digest('hex')
}
