/**
 * Student identity — exact student number, and nothing else.
 *
 * One exact student number is one student. Names never decide identity: there
 * is no fuzzy matching, no initial matching and no nickname handling anywhere
 * in this file, because a wrong merge here silently combines two people's money
 * into one record.
 *
 * The two consequences the workbook forces:
 *
 *  * **A number that carries two spellings is still one student.** The
 *    disagreement is recorded as a conflict and every spelling is preserved;
 *    the record is not split and the names are not reconciled.
 *  * **A row with no number is its own student.** Some Tracker Master rows and
 *    some batch-table rows name a student without numbering them. Each becomes
 *    a separate unresolved student keyed on its own source row, so two of them
 *    never merge on the strength of similar-looking names — and no student
 *    number is manufactured.
 */

import { nameComparisonForm } from '../lib/student-ids.mts'
import { studentSourceKey, unresolvedStudentSourceKey } from './source-keys.mts'

/** Where a name was seen. Tracker Master outranks a batch sheet for display. */
export type NameOrigin = 'tracker_master' | 'batch_table'

export interface StudentObservation {
  origin: NameOrigin
  sheetName: string
  /** Detected table key, for batch sheets. Null for Tracker Master. */
  tableKey: string | null
  /** 1-based source row. */
  row: number
  /**
   * Ordering rank for deterministic tie-breaks, normally the sheet's index in
   * the workbook. Two runs must resolve a tie the same way.
   */
  order: number
  studentNumber: string | null
  firstName: string | null
  middleName: string | null
  lastName: string | null
  fullName: string | null
}

export interface NameVariant {
  /** The name exactly as that source spells it. */
  value: string
  origin: NameOrigin
  sheetName: string
  row: number
}

export interface PlannedStudent {
  sourceKey: string
  /** `students.student_number`. Null for an unresolved student. */
  studentNumber: string | null
  /** `students.legacy_name` — the canonical display name. */
  legacyDisplayName: string | null
  /** How that name was chosen, for the record. */
  displayNameSource: string
  /** Set only where every source that states them agrees. Null otherwise. */
  firstName: string | null
  middleName: string | null
  lastName: string | null
  /** `students.legacy_source`. */
  legacySource: string
  /** Every spelling seen, preserved. Nothing is discarded or reconciled. */
  nameVariants: NameVariant[]
  /** True when one student number carries more than one distinct name. */
  hasNameConflict: boolean
  /**
   * True when the disagreeing spellings sit on the *same* sheet.
   *
   * This is the distinction that matters. A number spelled two ways within one
   * sheet is a genuine disagreement, written twice into the same column. A
   * number whose name differs only *between* sheets is mostly structural:
   * Tracker Master holds one name column and the batch sheets hold two or
   * three, so the two rarely reduce to the same string even for one person.
   */
  conflictWithinOneSheet: boolean
  /** True for a row that carried no student number at all. */
  unresolved: boolean
  /** Where an unresolved student came from. Null for a numbered student. */
  unresolvedOrigin: NameOrigin | null
  observations: StudentObservation[]
  /** `students.legacy_raw_json`: the source rows behind this student. */
  legacyRawJson: Record<string, unknown>
}

/** The name a batch-sheet row spells, assembled from whichever parts it has. */
export function batchSheetName(observation: StudentObservation): string | null {
  if (observation.fullName !== null && observation.fullName.trim() !== '') {
    return observation.fullName
  }

  const parts = [observation.firstName, observation.middleName, observation.lastName]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .map((part) => part.trim())

  return parts.length === 0 ? null : parts.join(' ')
}

/** The name an observation states, whatever shape its sheet stores it in. */
function observedName(observation: StudentObservation): string | null {
  if (observation.origin === 'tracker_master') {
    const full = observation.fullName
    return full !== null && full.trim() !== '' ? full : batchSheetName(observation)
  }
  return batchSheetName(observation)
}

/** Deterministic source order: sheet rank first, then row. */
function bySourceOrder(a: StudentObservation, b: StudentObservation): number {
  return a.order - b.order || a.row - b.row
}

/**
 * Chooses the canonical display name.
 *
 * Tracker Master first, then a batch sheet. Within either, the earliest source
 * row wins — an arbitrary rule, but a fixed one, so two runs agree. Every other
 * spelling survives in `nameVariants`; none is thrown away.
 */
function chooseDisplayName(observations: readonly StudentObservation[]): {
  name: string | null
  source: string
} {
  const ordered = [...observations].sort(bySourceOrder)

  const fromMaster = ordered.find(
    (observation) => observation.origin === 'tracker_master' && observedName(observation) !== null,
  )
  if (fromMaster) {
    return {
      name: observedName(fromMaster),
      source: `Tracker Master row ${fromMaster.row}`,
    }
  }

  const fromBatch = ordered.find((observation) => observedName(observation) !== null)
  if (fromBatch) {
    return {
      name: observedName(fromBatch),
      source: `${fromBatch.sheetName} row ${fromBatch.row}`,
    }
  }

  return { name: null, source: 'no name stated by any source row' }
}

/**
 * The name parts, but only where the sources agree.
 *
 * Where two sheets split a name differently — and 184 student numbers in this
 * workbook are spelled differently between sheets — the parts are left null
 * rather than one sheet's split being picked over another's. The full name
 * still reaches `legacy_name`, and every variant is preserved, so nothing is
 * lost by declining to choose.
 */
function agreedNameParts(observations: readonly StudentObservation[]): {
  firstName: string | null
  middleName: string | null
  lastName: string | null
} {
  const stated = observations.filter(
    (observation) =>
      observation.firstName !== null ||
      observation.middleName !== null ||
      observation.lastName !== null,
  )

  if (stated.length === 0) return { firstName: null, middleName: null, lastName: null }

  const forms = new Set(
    stated.map((observation) =>
      [
        nameComparisonForm(observation.firstName),
        nameComparisonForm(observation.middleName),
        nameComparisonForm(observation.lastName),
      ].join('\u0000'),
    ),
  )

  if (forms.size !== 1) return { firstName: null, middleName: null, lastName: null }

  const first = [...stated].sort(bySourceOrder)[0]
  return {
    firstName: first.firstName,
    middleName: first.middleName,
    lastName: first.lastName,
  }
}

function nameVariantsOf(observations: readonly StudentObservation[]): NameVariant[] {
  const seen = new Map<string, NameVariant>()

  for (const observation of [...observations].sort(bySourceOrder)) {
    const value = observedName(observation)
    if (value === null) continue
    const key = `${observation.origin}\u0000${observation.sheetName}\u0000${value}`
    if (seen.has(key)) continue
    seen.set(key, {
      value,
      origin: observation.origin,
      sheetName: observation.sheetName,
      row: observation.row,
    })
  }

  return [...seen.values()]
}

/** Distinct names under one student number, compared exactly after folding. */
function distinctNameForms(observations: readonly StudentObservation[]): number {
  const forms = new Set<string>()
  for (const observation of observations) {
    const value = observedName(observation)
    if (value === null) continue
    forms.add(nameComparisonForm(value))
  }
  return forms.size
}

/** True when a single sheet spells one student number two different ways. */
function conflictsWithinOneSheet(observations: readonly StudentObservation[]): boolean {
  const formsBySheet = new Map<string, Set<string>>()

  for (const observation of observations) {
    const value = observedName(observation)
    if (value === null) continue
    const forms = formsBySheet.get(observation.sheetName) ?? new Set<string>()
    forms.add(nameComparisonForm(value))
    formsBySheet.set(observation.sheetName, forms)
  }

  return [...formsBySheet.values()].some((forms) => forms.size > 1)
}

/**
 * The source rows behind a student, for `students.legacy_raw_json`.
 *
 * Holds every spelling seen and where each came from. One student number is one
 * student, so the spellings that lost the display-name tie-break have nowhere
 * else to go — and they are the evidence a reviewer needs to settle a conflict.
 */
function legacyRawJsonFor(
  sourceKey: string,
  studentNumber: string | null,
  display: { name: string | null; source: string },
  variants: readonly NameVariant[],
  observations: readonly StudentObservation[],
): Record<string, unknown> {
  return {
    source_key: sourceKey,
    student_number: studentNumber,
    canonical_display_name: display.name,
    canonical_display_name_source: display.source,
    name_variants: variants,
    source_rows: observations.map((observation) => ({
      origin: observation.origin,
      sheet: observation.sheetName,
      table_key: observation.tableKey,
      row: observation.row,
      first_name: observation.firstName,
      middle_name: observation.middleName,
      last_name: observation.lastName,
      full_name: observation.fullName,
    })),
    note: 'alternate spellings are preserved, never reconciled; identity is the exact student number',
  }
}

function legacySourceOf(observations: readonly StudentObservation[]): string {
  const sheets = [...new Set([...observations].sort(bySourceOrder).map((o) => o.sheetName))]
  return sheets.join(', ')
}

export interface StudentPlan {
  /** One per exact student number, in first-seen order. */
  students: PlannedStudent[]
  /** One per source row that carried no student number. */
  unresolvedStudents: PlannedStudent[]
  /** Student numbers carrying more than one distinct name. */
  nameConflicts: {
    studentNumber: string
    distinctNames: number
    /** True for a disagreement inside one sheet, which is the serious kind. */
    withinOneSheet: boolean
    variants: NameVariant[]
  }[]
}

/**
 * Plans one student per exact student number, plus one per number-less row.
 *
 * Observations may arrive in any order; the result does not depend on it.
 * Everything is sorted by (source rank, row) before any choice is made.
 */
export function planStudents(
  workbookHash: string,
  observations: readonly StudentObservation[],
): StudentPlan {
  const byNumber = new Map<string, StudentObservation[]>()
  const withoutNumber: StudentObservation[] = []

  for (const observation of observations) {
    if (observation.studentNumber === null) {
      withoutNumber.push(observation)
      continue
    }
    const existing = byNumber.get(observation.studentNumber)
    if (existing) existing.push(observation)
    else byNumber.set(observation.studentNumber, [observation])
  }

  const students: PlannedStudent[] = [...byNumber.entries()]
    .sort((a, b) => {
      const first = [...a[1]].sort(bySourceOrder)[0]
      const second = [...b[1]].sort(bySourceOrder)[0]
      return bySourceOrder(first, second) || a[0].localeCompare(b[0])
    })
    .map(([studentNumber, group]) => {
      const display = chooseDisplayName(group)
      const parts = agreedNameParts(group)
      const sourceKey = studentSourceKey(workbookHash, studentNumber)
      const variants = nameVariantsOf(group)
      const observations = [...group].sort(bySourceOrder)

      return {
        sourceKey,
        studentNumber,
        legacyDisplayName: display.name,
        displayNameSource: display.source,
        ...parts,
        legacySource: legacySourceOf(group),
        nameVariants: variants,
        hasNameConflict: distinctNameForms(group) > 1,
        conflictWithinOneSheet: conflictsWithinOneSheet(group),
        unresolved: false,
        unresolvedOrigin: null,
        observations,
        legacyRawJson: legacyRawJsonFor(sourceKey, studentNumber, display, variants, observations),
      }
    })

  // Each number-less row is its own student. They are never compared to each
  // other and never compared to a numbered student.
  const unresolvedStudents: PlannedStudent[] = [...withoutNumber]
    .sort(bySourceOrder)
    .map((observation) => {
      const display = chooseDisplayName([observation])
      const sourceKey = unresolvedStudentSourceKey(
        workbookHash,
        observation.sheetName,
        observation.tableKey,
        observation.row,
      )
      const variants = nameVariantsOf([observation])

      const where =
        observation.tableKey === null
          ? `${observation.sheetName} row ${observation.row}`
          : `${observation.sheetName} (${observation.tableKey}) row ${observation.row}`

      return {
        sourceKey,
        studentNumber: null,
        legacyDisplayName: display.name,
        displayNameSource: display.source,
        ...agreedNameParts([observation]),
        legacySource: `${where} (no student number in source)`,
        nameVariants: variants,
        hasNameConflict: false,
        conflictWithinOneSheet: false,
        unresolved: true,
        unresolvedOrigin: observation.origin,
        observations: [observation],
        legacyRawJson: legacyRawJsonFor(sourceKey, null, display, variants, [observation]),
      }
    })

  const nameConflicts = students
    .filter((student) => student.hasNameConflict)
    .map((student) => ({
      studentNumber: student.studentNumber as string,
      distinctNames: distinctNameForms(student.observations),
      withinOneSheet: student.conflictWithinOneSheet,
      variants: student.nameVariants,
    }))

  return { students, unresolvedStudents, nameConflicts }
}
