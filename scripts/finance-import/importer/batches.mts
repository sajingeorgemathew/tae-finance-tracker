/**
 * Batch candidates — one per detected table, never one per sheet.
 *
 * Every dated PSW sheet holds a Morning table and an Evening table stacked
 * vertically. Treating a sheet as a batch would merge two cohorts into one, so
 * a batch candidate is created per detected table and carries the evidence of
 * which table it came from.
 *
 * ## Dates are read, never invented
 *
 * A `start_date` is produced only when the title states a day, a month and a
 * four-digit year. Titles such as "December", "March 26" and "January 026" do
 * not, and they get a null start date. The year is never taken from the
 * worksheet name: the sheet called `Aug 2026` holds tables titled
 * "29th JULY, 2026", which is exactly the case where trusting the sheet name
 * would write a wrong date into a real date column.
 *
 * The title itself is always preserved verbatim, whatever the date rule decides.
 */

import { CANONICAL_PROGRAMS } from './programs.mts'
import { batchSourceKey } from './source-keys.mts'

import type { SourceTable } from './source-tables.mts'

/** Month names, longest-first matching handled by the ordered scan below. */
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

export interface BatchDateReading {
  /** YYYY-MM-DD, or null when the title does not state an unambiguous date. */
  iso: string | null
  /** Why, in plain language. Reported for every batch, including the nulls. */
  reason: string
}

/**
 * Reads a start date out of a batch title, strictly.
 *
 * All three of day, month name and four-digit year must be present in the
 * title. Anything less is a null date with the reason recorded — a missing day
 * is not filled in with the first of the month, and a two- or three-digit year
 * is not expanded into a century.
 */
export function batchStartDateFromTitle(title: string | null): BatchDateReading {
  if (title === null) return { iso: null, reason: 'table has no title' }

  const lower = title.toLowerCase()

  const monthIndex = MONTHS.findIndex((month) => lower.includes(month))
  if (monthIndex === -1) {
    // Abbreviations are matched only after full names fail, so "march" is never
    // mistaken for "mar" inside another word.
    const abbreviated = MONTHS.findIndex((month) =>
      new RegExp(`\\b${month.slice(0, 3)}\\b`).test(lower),
    )
    if (abbreviated === -1) return { iso: null, reason: 'no month name in the title' }
    return {
      iso: null,
      reason: 'month is abbreviated in the title; not resolved to an unambiguous date',
    }
  }

  const yearMatch = /\b(\d{4})\b/.exec(title)
  if (!yearMatch) {
    const shortYear = /\b(\d{1,3})\s*$/.exec(title.trim())
    return {
      iso: null,
      reason:
        shortYear === null
          ? 'no year in the title'
          : `year in the title is ${JSON.stringify(shortYear[1])}, not four digits; left uninterpreted`,
    }
  }

  // The day is the number immediately before the month name, with or without an
  // ordinal suffix: "17th March", "18 August", "06th October".
  const dayMatch = new RegExp(
    `\\b(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s*,?\\s+${MONTHS[monthIndex]}\\b`,
    'i',
  ).exec(title)

  if (!dayMatch) {
    return { iso: null, reason: 'no day of the month in the title; no date assumed' }
  }

  const year = Number(yearMatch[1])
  const day = Number(dayMatch[1])
  const month = monthIndex + 1

  // A title could state a day that does not exist in that month. Round-tripping
  // through a real calendar catches it instead of emitting 2026-02-31.
  const candidate = new Date(Date.UTC(year, month - 1, day))
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return { iso: null, reason: `title states ${day}/${month}/${year}, which is not a real date` }
  }

  return {
    iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    reason: 'day, month and four-digit year all read from the title',
  }
}

/**
 * The human-readable part of a title, i.e. what follows the last " - ".
 *
 * "PSW Morning Batch - 29th JULY, 2026" gives "29th JULY, 2026". The source
 * spelling is kept exactly, commas and capitals included: this is a label for
 * people, derived deterministically, not a normalised date.
 */
export function batchLabelFromTitle(title: string): string {
  const parts = title.split(/\s+-\s+/)
  const tail = parts.length > 1 ? parts[parts.length - 1] : title
  return tail.trim()
}

/**
 * The name the application would show for a batch.
 *
 * Deterministic: same title and same session always give the same name. The
 * session suffix is appended only when the workbook's own title names it, and
 * only when the label does not already carry it.
 */
export function proposedBatchName(table: SourceTable): string {
  const label = table.title === null ? table.sheetName : batchLabelFromTitle(table.title)

  if (table.session === null) return label
  if (new RegExp(`\\b${table.session}\\b`, 'i').test(label)) return label

  return `${label} - ${table.session}`
}

export interface BatchCandidate {
  /** Deterministic key: workbook hash + sheet + detected table key. */
  sourceKey: string
  /** Canonical `programs.short_code` this batch is filed under. */
  programShortCode: string
  /** The workbook's own program label, preserved. `ELCE` stays `ELCE`. */
  sourceProgramLabel: string
  /** Proposed `batches.name`. */
  name: string
  /** Proposed `batches.code`: the deterministic source-table key. */
  code: string
  /** `batches.legacy_sheet_name`: the exact source worksheet name. */
  legacySheetName: string
  /** `batches.start_date`, or null where the title does not state one. */
  startDate: string | null
  startDateReason: string
  /** The table title exactly as the workbook stores it. Never rewritten. */
  sourceTitle: string | null
  sourceTitleRow: number | null
  sourceHeaderRow: number | null
  sourceFirstDataRow: number | null
  sourceLastDataRow: number | null
  /** The detected table's key within its sheet. */
  sourceTableKey: string
  session: 'Morning' | 'Evening' | null
  sessionEvidence: string
}

/**
 * Builds the batch candidate for one detected table.
 *
 * Nothing about the table's contents is consulted: a batch exists because the
 * workbook holds a table, whether or not any student row in it survives
 * validation.
 */
export function buildBatchCandidate(
  workbookHash: string,
  table: SourceTable,
  programShortCode: string,
  sourceProgramLabel: string,
): BatchCandidate {
  const date = batchStartDateFromTitle(table.title)

  return {
    sourceKey: batchSourceKey(workbookHash, table.sheetName, table.key),
    programShortCode,
    sourceProgramLabel,
    name: proposedBatchName(table),
    code: `${table.sheetName}!${table.key}`,
    legacySheetName: table.sheetName,
    startDate: date.iso,
    startDateReason: date.reason,
    sourceTitle: table.title,
    sourceTitleRow: table.titleRow,
    sourceHeaderRow: table.headerRow,
    sourceFirstDataRow: table.firstDataRow,
    sourceLastDataRow: table.lastDataRow,
    sourceTableKey: table.key,
    session: table.session,
    sessionEvidence:
      table.session === null
        ? 'the table title does not name a session; none appended'
        : `the table title names the ${table.session} session`,
  }
}

/**
 * Names that would collide inside one program.
 *
 * `batches` is constrained unique on (program_id, name), so a collision would
 * fail the apply. It is checked here, in the dry run, where it is cheap.
 */
export function findBatchNameCollisions(
  candidates: readonly BatchCandidate[],
): { programShortCode: string; name: string; sourceKeys: string[] }[] {
  const seen = new Map<string, BatchCandidate[]>()

  for (const candidate of candidates) {
    const key = `${candidate.programShortCode}\u0000${candidate.name}`
    seen.set(key, [...(seen.get(key) ?? []), candidate])
  }

  return [...seen.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      programShortCode: group[0].programShortCode,
      name: group[0].name,
      sourceKeys: group.map((candidate) => candidate.sourceKey),
    }))
}

/** True when the short code names a program the database is configured for. */
export function isConfiguredProgram(shortCode: string): boolean {
  return Object.prototype.hasOwnProperty.call(CANONICAL_PROGRAMS, shortCode)
}
