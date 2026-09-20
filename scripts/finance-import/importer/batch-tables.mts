/**
 * Finding the batch tables the import supports, sheet by sheet.
 *
 * This is the table-discovery half of `plan.mts`, lifted out so that tooling
 * which needs the *shape* of every imported batch table — the column manifest
 * generator — can walk the workbook with exactly the same block detection,
 * classification and program resolution the import used, without dragging in
 * the student, payment and installment planners it does not need.
 *
 * The rules are the import's rules, unchanged:
 *
 *  * a sheet is not a batch — every detected block is its own table;
 *  * only `psw_batch` and `other_program_batch` sheets hold batch tables;
 *  * a table whose program is deferred (French) or unresolved is reported,
 *    not silently dropped.
 *
 * Pure with respect to the workbook: it reads the parsed `WorkBook` it is
 * handed and touches no file and no database.
 */

import * as XLSX from 'xlsx'

import { classifySheet } from '../lib/classify.mts'
import { findBlocks } from '../lib/blocks.mts'
import { resolveSheetProgram } from './programs.mts'
import { buildSourceTable } from './source-tables.mts'

import type { SourceTable } from './source-tables.mts'
import type { WorkBook } from 'xlsx'

/** One batch table the import maps, with the program it is filed under. */
export interface SupportedBatchTable {
  table: SourceTable
  /** Canonical `programs.short_code`, e.g. `PSW` or `ECEA`. */
  programShortCode: string
  /** The workbook's own label, e.g. `ELCE`. Preserved, never rewritten. */
  sourceProgramLabel: string
}

/** A detected batch table the import does not map, and why. */
export interface SkippedBatchTable {
  sheetName: string
  tableKey: string
  title: string | null
  status: 'deferred' | 'unresolved'
  reason: string
}

export interface BatchTableDiscovery {
  supported: SupportedBatchTable[]
  skipped: SkippedBatchTable[]
  /** Sheets that hold no batch table at all: Tracker Master, Summary, … */
  otherSheets: { sheetName: string; classification: string }[]
}

/**
 * Walks every sheet and returns the batch tables the import supports, in
 * workbook order — sheet order first, then table order within the sheet.
 */
export function discoverBatchTables(workbook: WorkBook): BatchTableDiscovery {
  const supported: SupportedBatchTable[] = []
  const skipped: SkippedBatchTable[] = []
  const otherSheets: BatchTableDiscovery['otherSheets'] = []

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const ref = sheet['!ref']
    const blocks = ref ? findBlocks(sheet, XLSX.utils.decode_range(ref)) : []
    const { classification } = classifySheet(sheetName, blocks)

    if (classification !== 'psw_batch' && classification !== 'other_program_batch') {
      otherSheets.push({ sheetName, classification })
      continue
    }

    const kind = classification === 'psw_batch' ? 'psw_batch' : 'cohort_roster'

    for (const block of blocks) {
      const table = buildSourceTable(sheetName, sheet, block, kind)
      const program = resolveSheetProgram(sheetName, block.title)

      if (program.status === 'mapped') {
        supported.push({
          table,
          programShortCode: program.shortCode,
          sourceProgramLabel: program.sourceLabel,
        })
        continue
      }

      skipped.push({
        sheetName,
        tableKey: table.key,
        title: table.title,
        status: program.status === 'deferred' ? 'deferred' : 'unresolved',
        reason:
          program.status === 'deferred'
            ? program.reason
            : `no canonical program could be resolved for this table (${program.status})`,
      })
    }
  }

  return { supported, skipped, otherSheets }
}
