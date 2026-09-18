/**
 * FINANCE-IMPORT-02 Phase A — workbook analysis.
 *
 * Reads the historical finance workbook and writes:
 *
 *   .private/finance-import-analysis/*.json   full detail, Git-ignored
 *   docs/FINANCE-IMPORT-02-ANALYSIS.md        sanitised, committable
 *
 * This script writes no database rows of any kind. It opens the workbook from
 * a read-only buffer, never writes to `reference/`, and re-hashes the file
 * afterwards to prove it was not touched.
 *
 * Console output is aggregate only. No student name, student number or
 * individual amount is ever logged — that detail exists solely in the private
 * JSON. See PRIVACY in docs/FINANCE-IMPORT-02-ANALYSIS.md.
 *
 *   npm run finance:analyze
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import * as XLSX from 'xlsx'

import { analyzeAcrossSheets, collectOccurrences } from './analyzers/cross-sheet.mts'
import { analyzeBatchLinkage } from './analyzers/batch-linkage.mts'
import { analyzeBatchBlock } from './analyzers/psw-batch.mts'
import { analyzeRosterSheet } from './analyzers/roster.mts'
import { analyzeSummary } from './analyzers/summary.mts'
import { analyzeTrackerMaster } from './analyzers/tracker-master.mts'
import { inventorySheet } from './analyzers/inventory.mts'
import { classifySheet } from './lib/classify.mts'
import { findBlocks } from './lib/blocks.mts'
import { hashWorkbookOnDisk, openWorkbook, WorkbookDiscoveryError, findWorkbookCandidates } from './lib/workbook-source.mts'
import { numericValue, readCell, usesDate1904 } from './lib/excel-values.mts'
import { buildImportPlan } from './import-plan.mts'
import { renderReport } from './report.mts'

import type { BatchLinkageAnalysis } from './analyzers/batch-linkage.mts'
import type { StudentIdOccurrence } from './analyzers/cross-sheet.mts'
import type { BatchBlockAnalysis } from './analyzers/psw-batch.mts'
import type { RosterAnalysis } from './analyzers/roster.mts'
import type { SheetBlock } from './lib/blocks.mts'
import type { SheetInventoryEntry } from './analyzers/inventory.mts'
import type { SummaryAnalysis } from './analyzers/summary.mts'
import type { TrackerMasterAnalysis } from './analyzers/tracker-master.mts'

const PRIVATE_DIR = path.join('.private', 'finance-import-analysis')
const REPORT_PATH = path.join('docs', 'FINANCE-IMPORT-02-ANALYSIS.md')

export interface WorkbookAnalysis {
  fingerprint: ReturnType<typeof openWorkbook>['fingerprint']
  date1904: boolean
  sheetCount: number
  inventory: SheetInventoryEntry[]
  trackerMaster: TrackerMasterAnalysis | null
  batchBlocks: BatchBlockAnalysis[]
  rosters: RosterAnalysis[]
  summary: SummaryAnalysis | null
  crossSheet: ReturnType<typeof analyzeAcrossSheets>
  batchLinkage: BatchLinkageAnalysis
}

function writeJson(repoRoot: string, name: string, data: unknown): string {
  const target = path.join(repoRoot, PRIVATE_DIR, name)
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  return path.join(PRIVATE_DIR, name).split(path.sep).join('/')
}

export function analyzeWorkbook(repoRoot: string, analyzedAt: Date): WorkbookAnalysis {
  const { fingerprint, workbook } = openWorkbook(repoRoot, analyzedAt)
  const date1904 = usesDate1904(workbook)

  const inventory: SheetInventoryEntry[] = []
  const batchBlocks: BatchBlockAnalysis[] = []
  const rosters: RosterAnalysis[] = []
  const occurrences: StudentIdOccurrence[] = []

  let trackerMaster: TrackerMasterAnalysis | null = null
  let trackerMasterSheetName = ''
  let trackerMasterBlock: SheetBlock | null = null
  let summary: SummaryAnalysis | null = null

  // Summary is compared against Tracker Master, so it is analysed last.
  const deferred: { index: number; name: string }[] = []

  workbook.SheetNames.forEach((name, index) => {
    const sheet = workbook.Sheets[name]
    const ref = sheet['!ref']
    const blocks = ref ? findBlocks(sheet, XLSX.utils.decode_range(ref)) : []
    const { classification, evidence } = classifySheet(name, blocks)

    inventory.push(inventorySheet(workbook, index, name, sheet, blocks, classification, evidence))

    for (const block of blocks) occurrences.push(...collectOccurrences(name, sheet, block))

    switch (classification) {
      case 'transaction_master':
        trackerMasterSheetName = name
        trackerMasterBlock = blocks[0]
        trackerMaster = analyzeTrackerMaster(name, sheet, blocks[0], date1904)
        break
      case 'psw_batch':
        for (const block of blocks) batchBlocks.push(analyzeBatchBlock(name, sheet, block, date1904))
        break
      case 'other_program_batch':
        rosters.push(analyzeRosterSheet(name, sheet, blocks[0], date1904))
        break
      case 'summary':
        deferred.push({ index, name })
        break
      default:
        break
    }
  })

  // Per-student payment totals from Tracker Master, used only to test whether
  // Summary carries anything that is not already recorded there.
  const trackerTotals = new Map<string, number>()
  if (trackerMaster) {
    const master = trackerMaster as TrackerMasterAnalysis
    const sheet = workbook.Sheets[master.sheetName]
    const idColumn = master.headers.find((header) => header.normalized === 'student id')
    const amountColumn = master.headers.find((header) => header.normalized === 'amount paid')

    if (idColumn && amountColumn) {
      const idIndex = XLSX.utils.decode_col(idColumn.letter)
      const amountIndex = XLSX.utils.decode_col(amountColumn.letter)
      for (let row = master.firstDataRow ?? 0; row <= (master.lastDataRow ?? -1); row += 1) {
        const id = readCell(sheet, row - 1, idIndex)
        const amount = numericValue(readCell(sheet, row - 1, amountIndex))
        const key = id?.text ?? (id?.value === undefined ? null : String(id.value))
        if (key === null || amount === null) continue
        trackerTotals.set(key.trim(), (trackerTotals.get(key.trim()) ?? 0) + amount)
      }
    }
  }

  for (const { name } of deferred) {
    const sheet = workbook.Sheets[name]
    const ref = sheet['!ref']
    const blocks = ref ? findBlocks(sheet, XLSX.utils.decode_range(ref)) : []
    if (blocks.length === 0) continue
    summary = analyzeSummary(name, sheet, blocks[0], date1904, trackerTotals)
  }

  // Can a Tracker Master payment be tied to a batch table? Evidence only.
  const trackerBlock = trackerMasterBlock as SheetBlock | null
  const batchColumn =
    trackerBlock?.headers.find((header) => header.normalized === 'batch')?.column ?? null

  const batchLinkage = analyzeBatchLinkage(
    trackerMasterSheetName === '' ? null : workbook.Sheets[trackerMasterSheetName],
    trackerBlock,
    batchColumn,
    batchBlocks,
    date1904,
  )

  return {
    fingerprint,
    date1904,
    sheetCount: workbook.SheetNames.length,
    inventory,
    trackerMaster,
    batchBlocks,
    rosters,
    summary,
    crossSheet: analyzeAcrossSheets(occurrences, trackerMasterSheetName),
    batchLinkage,
  }
}

function main(): void {
  const repoRoot = process.cwd()
  const analyzedAt = new Date()

  console.log('FINANCE-IMPORT-02 Phase A — workbook analysis')
  console.log('No database writes. The workbook is opened read-only.\n')

  const analysis = analyzeWorkbook(repoRoot, analyzedAt)
  const plan = buildImportPlan(analysis)

  mkdirSync(path.join(repoRoot, PRIVATE_DIR), { recursive: true })

  const written: string[] = [
    writeJson(repoRoot, 'workbook-manifest.json', {
      ...analysis.fingerprint,
      date1904: analysis.date1904,
      sheetCount: analysis.sheetCount,
      sheetNames: analysis.inventory.map((entry) => entry.name),
    }),
    writeJson(repoRoot, 'sheet-inventory.json', analysis.inventory),
    writeJson(repoRoot, 'tracker-master-analysis.json', analysis.trackerMaster),
    writeJson(repoRoot, 'sheet-mappings.json', {
      pswBatchBlocks: analysis.batchBlocks,
      rosters: analysis.rosters,
      summary: analysis.summary,
    }),
    writeJson(repoRoot, 'student-id-analysis.json', analysis.crossSheet),
    writeJson(repoRoot, 'batch-linkage-analysis.json', analysis.batchLinkage),
    writeJson(repoRoot, 'formula-analysis.json', {
      perSheet: analysis.inventory.map((entry) => ({
        sheet: entry.name,
        formulaCount: entry.formulaCount,
        errorCount: entry.errorCount,
        errorCells: entry.errorCells,
      })),
      batchBlockFormulaColumns: analysis.batchBlocks.map((block) => ({
        sheet: block.sheetName,
        title: block.title,
        totalPaidEvidence: block.totalPaidEvidence,
        formulaCount: block.formulaCount,
        errorCells: block.errorCells,
      })),
    }),
    writeJson(repoRoot, 'duplicate-analysis.json', analysis.trackerMaster?.duplicates ?? null),
    writeJson(repoRoot, 'import-plan.json', plan),
  ]

  const reportPath = path.join(repoRoot, REPORT_PATH)
  writeFileSync(reportPath, renderReport(analysis, plan), 'utf8')

  // --- Aggregate console summary. No row-level detail. ------------------------
  const master = analysis.trackerMaster

  console.log(`Workbook      ${analysis.fingerprint.fileName}`)
  console.log(`SHA-256       ${analysis.fingerprint.sha256}`)
  console.log(`Size          ${analysis.fingerprint.sizeBytes} bytes`)
  console.log(`Sheets        ${analysis.sheetCount}`)
  console.log('')

  for (const entry of analysis.inventory) {
    console.log(
      `  ${entry.name.padEnd(18)} ${String(entry.classification).padEnd(21)} ` +
        `blocks=${entry.blockCount} rows=${entry.declaredRowCount} formulas=${entry.formulaCount} errors=${entry.errorCount}`,
    )
  }

  console.log('')
  if (master) {
    console.log(`Analyzed ${master.transactionRowCount} transaction rows`)
    console.log(`Distinct student numbers in the transaction list: ${master.distinctStudentIdCount}`)
    console.log(`Rows with no student number: ${master.rowsMissingStudentId}`)
    console.log(`Rows with no paid date: ${master.rowsMissingPaidDate}`)
    console.log(`Exact duplicate row groups: ${master.duplicates.exactDuplicateRowGroups}`)
    console.log(
      `Potential duplicate candidate groups (student + amount + date): ` +
        `${master.duplicates.looseSignatureGroups} covering ${master.duplicates.looseSignatureRowCount} rows`,
    )
  }
  console.log(
    `Tracker Master Batch values matching a batch table date: ` +
      `${analysis.batchLinkage.valuesMatchingATitleDate} of ${analysis.batchLinkage.distinctTrackerBatchValues}`,
  )
  console.log(`PSW batch tables analyzed: ${analysis.batchBlocks.length}`)
  console.log(`Distinct student numbers workbook-wide: ${analysis.crossSheet.distinctStudentIdCount}`)

  const hashAfter = hashWorkbookOnDisk(repoRoot)
  const unchanged = hashAfter === analysis.fingerprint.sha256
  console.log('')
  console.log(`Workbook unchanged after analysis: ${unchanged ? 'yes' : 'NO'}`)

  console.log('')
  console.log('Private analysis (Git-ignored):')
  for (const file of written) console.log(`  ${file}`)
  console.log(`Sanitised report: ${REPORT_PATH.split(path.sep).join('/')}`)

  if (!unchanged) {
    console.error('\nThe workbook hash changed during analysis. This must not happen.')
    process.exitCode = 1
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    if (error instanceof WorkbookDiscoveryError) {
      console.error(error.message)
      const candidates = findWorkbookCandidates(process.cwd())
      if (candidates.length > 0) {
        console.error('Candidates found:')
        for (const candidate of candidates) console.error(`  reference/${candidate}`)
      }
      process.exit(1)
    }
    throw error
  }
}
