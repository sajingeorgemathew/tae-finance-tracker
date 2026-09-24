/**
 * ECEA master class list — source adapter.
 *
 * Verified structure (FINANCE-CONTACT-04B1): a *master* sheet whose title
 * states the program and the academic year and no cohort ("… Batch - 2025 &
 * 26"), plus subset sheets whose titles add a cohort ("… - Weekday Morning",
 * "… - Weekend Evening"). Each subset sheet holds two tables (Morning and
 * Evening) of the same heading layout. A per-row "WKND & WKD" column states
 * WD (weekday) or WN (weekend); START DATE and END DATE are per-row course
 * dates.
 *
 * The master is the authoritative contact source: structurally, it is the one
 * sheet stating no cohort, and every subset row should be a copy of a master
 * row. Subset sheets are parsed as *cross-check* rows only: never staged a
 * second time, and reconciled against the master so a discrepancy is reported
 * rather than duplicated or silently repaired.
 *
 * Headings mapped (allowlist): Student ID, First/Middle/Last Name, GRADUATED
 * (enrollment outcome), WKND & WKD (session), START DATE (per-row course
 * start), Contact No., Email. Ignored by name and never read: DOB, Status
 * (immigration), END DATE, Address.
 */

import * as XLSX from 'xlsx'

import type { WorkBook } from 'xlsx'

import { usesDate1904 } from '../../finance-import/lib/excel-values.mts'

import type { AllowedField, ContactImportRow, SourceSession } from '../canonical.mts'
import { scanSheet, type SheetScan, type TableTitle } from '../table-scan.mts'

import type { AdapterParseResult, AdapterRecognition, DiscoveredIntake, MasterContactSourceAdapter } from './adapter.mts'

export const ECEA_ADAPTER_ID = 'ecea-masterclass-list'
export const ECEA_PROGRAM_CODE = 'ECEA'

const TITLE = /^\s*Early Childhood Education Assistant\s*(?:\(ECEA\))?\s*Batch\s*[-–:]?\s*(.*)$/i
const COHORT_SUFFIX = /\s*[-–]\s*((?:Weekday|Weekend|Weekdays|Weekends)(?:\s+(?:Morning|Evening))?)\s*$/i

export const ECEA_HEADING_MAP: Readonly<Record<string, AllowedField>> = {
  'student id': 'studentNumber',
  'student number': 'studentNumber',
  'first name': 'firstName',
  'middle name': 'middleName',
  'last name': 'lastName',
  'graduated': 'sourceStatus',
  'wknd & wkd': 'session',
  'wkd & wknd': 'session',
  'session': 'session',
  'start date': 'sourceStartDate',
  'contact no.': 'phone',
  'contact no': 'phone',
  'contact number': 'phone',
  'phone': 'phone',
  'email': 'email',
  'email id': 'email',
}

/** The per-row cohort column: WD/WN as written, mapped to a word. Anything else is kept as text. */
export function eceaSessionValue(raw: string): SourceSession | null {
  const value = raw.trim().toUpperCase()
  if (value === '') return null
  if (value === 'WD' || value === 'WKD' || value === 'WEEKDAY') return 'Weekday'
  if (value === 'WN' || value === 'WKND' || value === 'WE' || value === 'WEEKEND') return 'Weekend'
  return raw.trim()
}

export function recognizeEceaTitle(text: string): TableTitle | null {
  const match = TITLE.exec(text)
  if (!match) return null
  let rest = match[1].trim()
  let session: SourceSession | null = null
  const cohort = COHORT_SUFFIX.exec(rest)
  if (cohort) {
    session = cohort[1].replace(/\s+/g, ' ')
    rest = rest.slice(0, cohort.index).trim()
  }
  return {
    text: text.trim(),
    intakeLabel: rest === '' ? null : rest,
    intakeDate: null,
    session,
  }
}

function firstCellText(workbook: WorkBook, sheetName: string): string | null {
  const sheet = workbook.Sheets[sheetName]
  const ref = sheet?.['!ref']
  if (!sheet || !ref) return null
  const range = XLSX.utils.decode_range(ref)
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: column })] as { v?: unknown } | undefined
    if (cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '') return String(cell.v)
  }
  return null
}

export function recognizeEcea(workbook: WorkBook): AdapterRecognition {
  const matched = workbook.SheetNames.filter((name) => {
    const text = firstCellText(workbook, name)
    return text !== null && TITLE.test(text)
  })
  return {
    recognized: matched.length > 0 && matched.length === workbook.SheetNames.length,
    reason:
      matched.length === 0
        ? 'no sheet opens with an "Early Childhood Education Assistant … Batch" title'
        : matched.length === workbook.SheetNames.length
          ? `${matched.length} of ${workbook.SheetNames.length} sheets open with an ECEA batch title`
          : `only ${matched.length} of ${workbook.SheetNames.length} sheets open with an ECEA batch title`,
    matchedSheets: matched,
  }
}

/** Whether every table on the sheet states no cohort in its title — the master's shape. */
function isMasterShaped(scan: SheetScan): boolean {
  return scan.tables.length > 0 && scan.tables.every((table) => table.title !== null && table.title.session === null)
}

export function parseEcea(workbook: WorkBook, workbookName: string): AdapterParseResult {
  const date1904 = usesDate1904(workbook)
  const sheets: SheetScan[] = []
  const notes: string[] = []

  for (const sheetName of workbook.SheetNames) {
    sheets.push(
      scanSheet(workbook.Sheets[sheetName], sheetName, {
        workbookName,
        programCode: ECEA_PROGRAM_CODE,
        recognizeTitle: recognizeEceaTitle,
        headingMap: ECEA_HEADING_MAP,
        sessionValue: eceaSessionValue,
        date1904,
      }),
    )
  }

  // The master: the sheet(s) whose titles state no cohort. Exactly one is the
  // structure this adapter is written for; anything else is reported, and
  // the largest candidate is used so the run still produces evidence.
  const masterCandidates = sheets.filter(isMasterShaped)
  let master: SheetScan | null = null
  if (masterCandidates.length === 1) {
    master = masterCandidates[0]
  } else if (masterCandidates.length > 1) {
    master = [...masterCandidates].sort((a, b) => b.counts.student - a.counts.student)[0]
    notes.push(
      `${masterCandidates.length} sheets are master-shaped (${masterCandidates.map((scan) => scan.sheetName).join(', ')}); using the largest, ${master.sheetName}`,
    )
  } else {
    notes.push('no master-shaped sheet (a title stating no cohort) was found; nothing is staged, every sheet is cross-check only')
  }

  const rows: ContactImportRow[] = master ? master.tables.flatMap((table) => table.rows) : []
  const crossCheckRows: ContactImportRow[] = sheets
    .filter((scan) => scan !== master)
    .flatMap((scan) => scan.tables.flatMap((table) => table.rows))

  const intakes: DiscoveredIntake[] = []
  for (const scan of sheets) {
    for (const table of scan.tables) {
      intakes.push({
        programCode: ECEA_PROGRAM_CODE,
        sheetName: scan.sheetName,
        tableTitle: table.title?.text ?? null,
        intakeLabel: table.title?.intakeLabel ?? null,
        intakeDate: null,
        session: table.title?.session ?? null,
        studentRows: table.rows.length,
        role: scan === master ? 'primary' : 'cross_check',
      })
      if (table.title === null) notes.push(`${scan.sheetName}: table at row ${table.headerRow} has no title cell`)
    }
  }

  const ignored = new Set<string>()
  const sensitive = new Set<string>()
  for (const scan of sheets) {
    for (const heading of scan.ignoredHeadings) ignored.add(heading)
    for (const heading of scan.sensitiveHeadings) sensitive.add(heading)
  }

  return {
    adapterId: ECEA_ADAPTER_ID,
    programCode: ECEA_PROGRAM_CODE,
    workbookName,
    sheets,
    rows,
    crossCheckRows,
    intakes,
    ignoredHeadings: [...ignored].sort(),
    sensitiveHeadings: [...sensitive].sort(),
    notes,
  }
}

export const eceaAdapter: MasterContactSourceAdapter = {
  id: ECEA_ADAPTER_ID,
  programCode: ECEA_PROGRAM_CODE,
  scopeDateField: 'sourceStartDate',
  recognize: recognizeEcea,
  parse: parseEcea,
}
