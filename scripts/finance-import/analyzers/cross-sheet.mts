/**
 * Student numbers across the whole workbook.
 *
 * The only identity link treated as reliable is an exact student number. Names
 * are compared exactly, in a trimmed and case-folded form, and only to *raise*
 * cases for review — no fuzzy matching, no merging, no deciding that two
 * spellings are one person.
 *
 * A student number appearing on a batch sheet but never in Tracker Master is
 * not an error to correct. It is a student with no payments recorded in the
 * transaction list, and the import has to keep both facts.
 */

import { isBlank, readCell } from '../lib/excel-values.mts'
import { roleForHeader } from '../lib/headers.mts'
import { nameComparisonForm, studentIdPrefix, studentIdText, hasLeadingZero } from '../lib/student-ids.mts'

import type { SheetBlock } from '../lib/blocks.mts'
import type { WorkSheet } from 'xlsx'

export interface StudentIdOccurrence {
  sheetName: string
  blockTitle: string | null
  row: number
  studentId: string | null
  nameForm: string | null
}

export interface CrossSheetAnalysis {
  totalOccurrences: number
  occurrencesWithoutId: number

  distinctStudentIdCount: number
  prefixCounts: Record<string, number>
  lengthCounts: Record<string, number>
  idsWithLeadingZero: string[]
  idsWithNonDigitCharacters: string[]

  /** Student numbers used on more than one sheet. */
  idsOnMultipleSheets: number
  idsInTrackerMasterOnly: number
  idsInBatchSheetsOnly: number
  idsInBoth: number

  /**
   * One student number carrying two name spellings *on the same sheet*.
   *
   * This is the count that means a genuine disagreement, because both
   * spellings were written into the same column of the same table.
   */
  sameIdDifferentNameWithinASheet: number
  /**
   * One student number whose name differs between sheets.
   *
   * Largely structural rather than a conflict: Tracker Master records a single
   * "Student Name", while the batch sheets split the name across two or three
   * columns, so the two sources rarely reduce to the same string even for the
   * same person. Counted, and deliberately not treated as evidence of anything
   * on its own.
   */
  sameIdDifferentNameAcrossSheets: number
  sameIdDifferentNameCount: number
  sameNameDifferentIdCount: number

  /** Private output only: the cases behind the counts above. */
  detail: {
    sameIdDifferentName: { studentId: string; nameForms: string[]; where: string[] }[]
    sameNameDifferentId: { nameForm: string; studentIds: string[]; where: string[] }[]
    idsInBatchSheetsOnly: { studentId: string; where: string[] }[]
    idsInTrackerMasterOnly: string[]
  }
}

/** Collects every student-number occurrence in one block. */
export function collectOccurrences(
  sheetName: string,
  sheet: WorkSheet,
  block: SheetBlock,
): StudentIdOccurrence[] {
  const idHeader = block.headers.find((header) => header.normalized === 'student id') ?? null
  const nameHeaders = block.headers.filter((header) =>
    ['first_name', 'middle_name', 'last_name', 'student_name'].includes(
      roleForHeader(header.original),
    ),
  )

  const occurrences: StudentIdOccurrence[] = []

  for (let row = block.firstDataRow ?? 0; row <= (block.lastDataRow ?? -1); row += 1) {
    const idCell = idHeader === null ? null : readCell(sheet, row - 1, idHeader.column)
    const studentId = studentIdText(idCell)

    const nameParts = nameHeaders.map((header) => {
      const cell = readCell(sheet, row - 1, header.column)
      return isBlank(cell) ? null : ((cell?.value as string | number | undefined) ?? null)
    })

    const nameForm = nameComparisonForm(
      ...nameParts.map((part) => (part === null ? null : String(part))),
    )

    if (studentId === null && nameForm === '') continue

    occurrences.push({
      sheetName,
      blockTitle: block.title,
      row,
      studentId,
      nameForm: nameForm === '' ? null : nameForm,
    })
  }

  return occurrences
}

export function analyzeAcrossSheets(
  occurrences: readonly StudentIdOccurrence[],
  trackerMasterSheetName: string,
): CrossSheetAnalysis {
  const where = (occurrence: StudentIdOccurrence) =>
    `${occurrence.sheetName}!r${occurrence.row}${occurrence.blockTitle ? ` (${occurrence.blockTitle})` : ''}`

  const withId = occurrences.filter(
    (occurrence): occurrence is StudentIdOccurrence & { studentId: string } =>
      occurrence.studentId !== null,
  )

  const sheetsById = new Map<string, Set<string>>()
  const namesById = new Map<string, Map<string, string[]>>()
  /** Name forms per student number, per sheet, to tell a conflict from a format difference. */
  const namesByIdAndSheet = new Map<string, Map<string, Set<string>>>()
  const idsByName = new Map<string, Map<string, string[]>>()

  const prefixCounts: Record<string, number> = {}
  const lengthCounts: Record<string, number> = {}

  for (const occurrence of withId) {
    const { studentId } = occurrence

    const sheets = sheetsById.get(studentId) ?? new Set<string>()
    sheets.add(occurrence.sheetName)
    sheetsById.set(studentId, sheets)

    if (occurrence.nameForm !== null) {
      const perSheet = namesByIdAndSheet.get(studentId) ?? new Map<string, Set<string>>()
      const formsOnSheet = perSheet.get(occurrence.sheetName) ?? new Set<string>()
      formsOnSheet.add(occurrence.nameForm)
      perSheet.set(occurrence.sheetName, formsOnSheet)
      namesByIdAndSheet.set(studentId, perSheet)

      const names = namesById.get(studentId) ?? new Map<string, string[]>()
      names.set(occurrence.nameForm, [...(names.get(occurrence.nameForm) ?? []), where(occurrence)])
      namesById.set(studentId, names)

      const ids = idsByName.get(occurrence.nameForm) ?? new Map<string, string[]>()
      ids.set(studentId, [...(ids.get(studentId) ?? []), where(occurrence)])
      idsByName.set(occurrence.nameForm, ids)
    }
  }

  for (const studentId of sheetsById.keys()) {
    const prefix = studentIdPrefix(studentId) ?? '(no prefix)'
    prefixCounts[prefix] = (prefixCounts[prefix] ?? 0) + 1
    const length = String(studentId.length)
    lengthCounts[length] = (lengthCounts[length] ?? 0) + 1
  }

  const inTracker = new Set<string>()
  const inBatches = new Set<string>()
  for (const occurrence of withId) {
    if (occurrence.sheetName === trackerMasterSheetName) inTracker.add(occurrence.studentId)
    else inBatches.add(occurrence.studentId)
  }

  const trackerOnly = [...inTracker].filter((id) => !inBatches.has(id))
  const batchesOnly = [...inBatches].filter((id) => !inTracker.has(id))
  const both = [...inTracker].filter((id) => inBatches.has(id))

  const sameIdDifferentName = [...namesById.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([studentId, names]) => ({
      studentId,
      nameForms: [...names.keys()],
      where: [...names.values()].flat(),
    }))

  const sameNameDifferentId = [...idsByName.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([nameForm, ids]) => ({
      nameForm,
      studentIds: [...ids.keys()],
      where: [...ids.values()].flat(),
    }))

  const allIds = [...sheetsById.keys()]

  const withinASheet = [...namesByIdAndSheet.values()].filter((perSheet) =>
    [...perSheet.values()].some((forms) => forms.size > 1),
  ).length

  return {
    totalOccurrences: occurrences.length,
    occurrencesWithoutId: occurrences.length - withId.length,
    distinctStudentIdCount: allIds.length,
    prefixCounts,
    lengthCounts,
    idsWithLeadingZero: allIds.filter((id) => hasLeadingZero(id)),
    idsWithNonDigitCharacters: allIds.filter((id) => /\D/.test(id)),
    idsOnMultipleSheets: [...sheetsById.values()].filter((sheets) => sheets.size > 1).length,
    idsInTrackerMasterOnly: trackerOnly.length,
    idsInBatchSheetsOnly: batchesOnly.length,
    idsInBoth: both.length,
    sameIdDifferentNameWithinASheet: withinASheet,
    sameIdDifferentNameAcrossSheets: sameIdDifferentName.length - withinASheet,
    sameIdDifferentNameCount: sameIdDifferentName.length,
    sameNameDifferentIdCount: sameNameDifferentId.length,
    detail: {
      sameIdDifferentName,
      sameNameDifferentId,
      idsInBatchSheetsOnly: batchesOnly.map((studentId) => ({
        studentId,
        where: withId
          .filter((occurrence) => occurrence.studentId === studentId)
          .map((occurrence) => where(occurrence)),
      })),
      idsInTrackerMasterOnly: trackerOnly,
    },
  }
}
