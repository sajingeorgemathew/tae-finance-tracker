/**
 * PSW master class list — source adapter.
 *
 * Verified structure (FINANCE-CONTACT-04B1): one worksheet per intake, named
 * informally ("Dec 1st", "Jan 12th"). Each sheet holds a *Morning* table and
 * an *Evening* table, each introduced by a merged title cell
 * "PSW Morning Batch - <date>" / "PSW Evening Batch - <date>" followed by a
 * heading row. Between the tables sits a three-line colour legend
 * (Withdrawal / Enrollment Pending / Other Reason); newer sheets end with
 * pre-numbered empty rows. One early sheet's Evening table has no title cell.
 *
 * Morning and Evening rows are staged separately. They may be shown as one
 * intake later; here their provenance stays exact.
 *
 * Headings mapped (allowlist): Student ID, First Name, Middle Name, Last Name,
 * Contact No., Email, GRADUATED (as the enrollment outcome). Everything else
 * — Password, the date-of-birth column, WP/Status (immigration), Address, the
 * document columns, the PLACEMENT block (VENUE / START DATE / FINISH DATE /
 * STATUS), Doc Status — is ignored by name and never read. The START DATE
 * column here is a *placement* date, not an intake date, so it is not mapped;
 * the intake date comes from the table title.
 *
 * The workbook's colour legend implies row fills carry a status. Cell fills
 * are not readable with the community SheetJS build, so no status is derived
 * from colour; only the GRADUATED text is staged.
 */

import * as XLSX from 'xlsx'

import type { WorkBook } from 'xlsx'

import { usesDate1904 } from '../../finance-import/lib/excel-values.mts'

import type { AllowedField, SourceSession } from '../canonical.mts'
import { scanSheet, type SheetScan, type TableTitle } from '../table-scan.mts'

import type { AdapterParseResult, AdapterRecognition, DiscoveredIntake, MasterContactSourceAdapter } from './adapter.mts'
import { parseTitleDate } from './title-date.mts'

export const PSW_ADAPTER_ID = 'psw-masterclass-list'

const TITLE = /^\s*PSW\s+(Morning|Evening)\s+Batch\s*[-–:]?\s*(.*)$/i

/** Normalized heading -> canonical field. Nothing outside this map is read. */
export const PSW_HEADING_MAP: Readonly<Record<string, AllowedField>> = {
  'student id': 'studentNumber',
  'student number': 'studentNumber',
  'first name': 'firstName',
  'middle name': 'middleName',
  'last name': 'lastName',
  'contact no.': 'phone',
  'contact no': 'phone',
  'contact number': 'phone',
  'phone': 'phone',
  'email': 'email',
  'email id': 'email',
  'graduated': 'sourceStatus',
}

export function recognizePswTitle(text: string): TableTitle | null {
  const match = TITLE.exec(text)
  if (!match) return null
  const session = (match[1][0].toUpperCase() + match[1].slice(1).toLowerCase()) as SourceSession
  const rest = match[2].trim()
  const date = parseTitleDate(rest)
  return {
    text: text.trim(),
    intakeLabel: rest === '' ? null : rest,
    intakeDate: date.isoDate,
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

export function recognizePsw(workbook: WorkBook): AdapterRecognition {
  const matched = workbook.SheetNames.filter((name) => {
    const text = firstCellText(workbook, name)
    return text !== null && TITLE.test(text)
  })
  return {
    recognized: matched.length > 0 && matched.length === workbook.SheetNames.length,
    reason:
      matched.length === 0
        ? 'no sheet opens with a "PSW <Morning|Evening> Batch" title'
        : matched.length === workbook.SheetNames.length
          ? `${matched.length} of ${workbook.SheetNames.length} sheets open with a "PSW <Morning|Evening> Batch" title`
          : `only ${matched.length} of ${workbook.SheetNames.length} sheets open with a PSW batch title`,
    matchedSheets: matched,
  }
}

export function parsePsw(workbook: WorkBook, workbookName: string): AdapterParseResult {
  const date1904 = usesDate1904(workbook)
  const sheets: SheetScan[] = []
  const intakes: DiscoveredIntake[] = []
  const notes: string[] = []

  for (const sheetName of workbook.SheetNames) {
    const scan = scanSheet(workbook.Sheets[sheetName], sheetName, {
      workbookName,
      programCode: PSW_PROGRAM_CODE,
      recognizeTitle: recognizePswTitle,
      headingMap: PSW_HEADING_MAP,
      date1904,
    })

    // A table with no title cell inherits the sheet's intake — the date the
    // other table on the same sheet states — but no session: the source did
    // not say, and the position of a table is not a statement.
    const sheetIntake = scan.tables.find((table) => table.title !== null)?.title ?? null
    for (const table of scan.tables) {
      if (table.title === null) {
        notes.push(
          `${sheetName}: table at row ${table.headerRow} has no title cell; intake inherited from the sheet, session not stated`,
        )
        for (const row of table.rows) {
          row.intakeLabel = sheetIntake?.intakeLabel ?? null
          row.intakeDate = sheetIntake?.intakeDate ?? null
          row.session = null
        }
      } else if (table.title.intakeDate === null) {
        notes.push(`${sheetName}: title "${table.title.text}" states no full date`)
      }
      intakes.push({
        programCode: PSW_PROGRAM_CODE,
        sheetName,
        tableTitle: table.title?.text ?? null,
        intakeLabel: table.title?.intakeLabel ?? sheetIntake?.intakeLabel ?? null,
        intakeDate: table.title?.intakeDate ?? sheetIntake?.intakeDate ?? null,
        session: table.title?.session ?? null,
        studentRows: table.rows.length,
        role: 'primary',
      })
    }
    if (scan.tables.length !== 2) {
      notes.push(`${sheetName}: ${scan.tables.length} roster table(s) found (2 expected)`)
    }
    sheets.push(scan)
  }

  const ignored = new Set<string>()
  const sensitive = new Set<string>()
  for (const scan of sheets) {
    for (const heading of scan.ignoredHeadings) ignored.add(heading)
    for (const heading of scan.sensitiveHeadings) sensitive.add(heading)
  }

  return {
    adapterId: PSW_ADAPTER_ID,
    programCode: PSW_PROGRAM_CODE,
    workbookName,
    sheets,
    rows: sheets.flatMap((scan) => scan.tables.flatMap((table) => table.rows)),
    crossCheckRows: [],
    intakes,
    ignoredHeadings: [...ignored].sort(),
    sensitiveHeadings: [...sensitive].sort(),
    notes,
  }
}

export const PSW_PROGRAM_CODE = 'PSW'

export const pswAdapter: MasterContactSourceAdapter = {
  id: PSW_ADAPTER_ID,
  programCode: PSW_PROGRAM_CODE,
  scopeDateField: 'intakeDate',
  recognize: recognizePsw,
  parse: parsePsw,
}
