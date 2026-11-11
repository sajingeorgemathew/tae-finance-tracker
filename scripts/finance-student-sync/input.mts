/**
 * FINANCE-STUDENT-SYNC-05B — reading a CURRENT student list (CSV or XLSX).
 *
 * The file is whatever the office exports today; nothing here is tied to the
 * old PSW master's layout. One sheet (the first, or `--sheet=`), one header
 * row (found within the first 20 rows by the Student Number heading), one
 * student per row below it.
 *
 * Columns are recognised by heading aliases (case, punctuation and spacing
 * ignored). Only the allowlisted columns are read; a sensitive heading
 * (password, date of birth, address, SIN, permit …, the 04B1 list) is never
 * read even if it would match an alias, and every other column is ignored
 * and named in the report. Cell text is taken as displayed, so a student
 * number keeps its leading zeros.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import * as XLSX from 'xlsx'

import { isSensitiveHeading, normalizeHeading } from '../finance-contact/canonical.mts'
import { joinNameParts, normalizeEmail, normalizePhone, normalizeStudentNumber, type NormalizedEmail, type NormalizedPhone } from '../finance-contact/normalize.mts'

export const INPUT_FIELDS = ['studentNumber', 'name', 'firstName', 'middleName', 'lastName', 'email', 'phone', 'batch', 'session', 'program'] as const
export type InputField = (typeof INPUT_FIELDS)[number]

/** Normalized headings accepted for each field. The first is the template's own heading. */
export const HEADING_ALIASES: Readonly<Record<InputField, readonly string[]>> = {
  studentNumber: ['student number', 'student no', 'student no.', 'student #', 'student id', 'student num', 'id number', 'student number #'],
  name: ['student name', 'name', 'full name', 'name of student', 'students name'],
  firstName: ['first name', 'given name', 'first'],
  middleName: ['middle name', 'middle'],
  lastName: ['last name', 'surname', 'family name', 'last'],
  email: ['email', 'email address', 'e mail', 'e mail address', 'student email', 'email id'],
  phone: ['phone', 'phone number', 'phone no', 'phone no.', 'mobile', 'mobile number', 'cell', 'cell number', 'contact number', 'contact no', 'telephone'],
  batch: ['batch', 'batch / intake', 'batch/intake', 'intake', 'cohort', 'intake date', 'batch name', 'start date'],
  session: ['session', 'shift', 'morning / evening', 'morning/evening', 'timing'],
  program: ['program', 'programme', 'course'],
}

export interface IncomingRow {
  /** `<file>#<sheet>!<row>` — 1-based spreadsheet row. */
  rowRef: string
  sourceRow: number
  studentNumberRaw: string | null
  studentNumber: string | null
  name: string | null
  email: NormalizedEmail
  phone: NormalizedPhone
  batchRaw: string | null
  sessionRaw: string | null
  programRaw: string | null
}

export interface HeaderReport {
  headerRow: number
  mapped: Partial<Record<InputField, string>>
  ignored: string[]
  sensitiveNotRead: string[]
}

export interface IncomingFile {
  fileName: string
  sha256: string
  sheet: string
  header: HeaderReport
  rows: IncomingRow[]
  /** Rows below the header with no value in any mapped column. */
  blankRows: number
}

export class InputError extends Error {}

function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/ /g, ' ').trim()
  return text === '' ? null : text
}

function fieldOfHeading(normalized: string): InputField | null {
  for (const field of INPUT_FIELDS) if (HEADING_ALIASES[field].includes(normalized)) return field
  return null
}

/** Maps a grid (rows of displayed cell text) to incoming rows. Pure. */
export function parseStudentGrid(grid: readonly (readonly unknown[])[], meta: { fileName: string; sheet: string }): Omit<IncomingFile, 'sha256'> {
  let headerIndex = -1
  for (let index = 0; index < Math.min(grid.length, 20); index += 1) {
    if (grid[index].some((cell) => fieldOfHeading(normalizeHeading(cellText(cell) ?? '')) === 'studentNumber')) {
      headerIndex = index
      break
    }
  }
  if (headerIndex === -1) throw new InputError(`no "Student Number" column heading in the first 20 rows of ${meta.fileName} / ${meta.sheet}`)

  const header = grid[headerIndex]
  const columnOf: Partial<Record<InputField, number>> = {}
  const mapped: Partial<Record<InputField, string>> = {}
  const ignored: string[] = []
  const sensitiveNotRead: string[] = []
  header.forEach((cell, column) => {
    const heading = cellText(cell)
    if (heading === null) return
    const normalized = normalizeHeading(heading)
    if (isSensitiveHeading(normalized)) {
      sensitiveNotRead.push(heading)
      return
    }
    const field = fieldOfHeading(normalized)
    if (field === null) {
      ignored.push(heading)
      return
    }
    if (columnOf[field] !== undefined) throw new InputError(`two columns map to ${field}: "${mapped[field]}" and "${heading}"`)
    columnOf[field] = column
    mapped[field] = heading
  })
  if (columnOf.name === undefined && columnOf.firstName === undefined && columnOf.lastName === undefined) {
    throw new InputError('no student name column (Student Name, or First Name / Last Name)')
  }

  const read = (row: readonly unknown[], field: InputField): string | null => {
    const column = columnOf[field]
    return column === undefined ? null : cellText(row[column])
  }
  const rows: IncomingRow[] = []
  let blankRows = 0
  for (let index = headerIndex + 1; index < grid.length; index += 1) {
    const row = grid[index]
    const values = Object.fromEntries(INPUT_FIELDS.map((field) => [field, read(row, field)])) as Record<InputField, string | null>
    if (Object.values(values).every((value) => value === null)) {
      blankRows += 1
      continue
    }
    const sourceRow = index + 1
    rows.push({
      rowRef: `${meta.fileName}#${meta.sheet}!${sourceRow}`,
      sourceRow,
      studentNumberRaw: values.studentNumber,
      studentNumber: normalizeStudentNumber(values.studentNumber),
      name: values.name ?? joinNameParts(values.firstName, values.middleName, values.lastName),
      email: normalizeEmail(values.email),
      phone: normalizePhone(values.phone),
      batchRaw: values.batch,
      sessionRaw: values.session,
      programRaw: values.program,
    })
  }
  return { fileName: meta.fileName, sheet: meta.sheet, header: { headerRow: headerIndex + 1, mapped, ignored, sensitiveNotRead }, rows, blankRows }
}

/** Reads a .csv / .xlsx / .xls file. CSV cells are kept as text (no number coercion). */
export function readStudentFile(filePath: string, sheetName?: string): IncomingFile {
  const bytes = readFileSync(filePath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const extension = path.extname(filePath).toLowerCase()
  if (!['.csv', '.xlsx', '.xls'].includes(extension)) throw new InputError(`unsupported file type ${extension}; use .csv or .xlsx`)
  const workbook = XLSX.read(bytes, { type: 'buffer', raw: extension === '.csv', cellDates: false })
  const sheet = sheetName ?? workbook.SheetNames[0]
  const worksheet = workbook.Sheets[sheet]
  if (!worksheet) throw new InputError(`sheet "${sheet}" not found; sheets: ${workbook.SheetNames.join(', ')}`)
  const grid = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: false, defval: null, blankrows: true })
  return { ...parseStudentGrid(grid, { fileName: path.basename(filePath), sheet }), sha256 }
}

/** The template's headings, in order. */
export const TEMPLATE_HEADINGS = ['Student Number', 'Student Name', 'Email', 'Phone', 'Batch / Intake', 'Session'] as const
