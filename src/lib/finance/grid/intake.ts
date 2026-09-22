/**
 * Intakes — the UI-level grouping of a Morning and an Evening batch.
 *
 * FINANCE-GRID-03C. Staff do not think of "29th JULY, 2026 - Morning" and
 * "29th JULY 2026 - Evening" as two things to choose between: they are one
 * intake with two cohorts. The database keeps them as two `batches` rows, with
 * their own ids, names, manifests and finance records, and nothing here changes
 * that. An intake is a *view* over one or two real batches, and every row the
 * grid shows still knows exactly which real batch it belongs to.
 *
 * ## The grouping rule — deterministic, never a name match
 *
 * Two batches form one intake when, and only when:
 *
 *   1. they belong to the same program, and
 *   2. they were imported from the same workbook sheet — the same
 *      `batches.legacy_sheet_name` — and
 *   3. each states a different session in its name (one Morning, one Evening).
 *
 * The sheet is the source of truth here: every PSW sheet in the workbook holds
 * exactly one Morning table and one Evening table, and the importer recorded
 * the sheet on each batch. That is a fact the import wrote down, not a guess
 * made by comparing titles — so "18th August 2025 - Morning" and "18 August
 * 2025 - Evening" (different spellings) group correctly, and two batches whose
 * names merely look alike never do.
 *
 * A group that breaks rule 3 — two Morning tables on one sheet, or a third
 * table — is not merged. Each batch becomes its own intake, because the sheet
 * alone cannot say which pair belongs together.
 *
 * ECEA's single roster sheet holds one batch, so it is an intake of one.
 * The unassigned records are not a batch and never join an intake.
 *
 * ## Labels and dates
 *
 * Nothing is fabricated. A dated intake is labelled from its real `start_date`
 * ("29 Jul 2026"). An undated intake is labelled from the month and year its
 * sheet title states ("December 2025"), and says so; the day is unknown and is
 * not invented. A title that states no month at all keeps its own wording
 * ("ELCE 25 & 26").
 *
 * Ordering is most recent first. A dated intake sorts on its date; a
 * month-titled intake sorts on the month its title states — a real fact from
 * the source, used at the precision the source gives it. An intake with
 * neither sorts last, by label. No day is ever invented to make a sort come
 * out.
 */

import { format, isValid, parseISO } from 'date-fns'

/** The two cohorts a PSW intake runs. Stated by the batch name; never inferred. */
export type Session = 'Morning' | 'Evening'

export const SESSIONS: readonly Session[] = ['Morning', 'Evening']

/**
 * The value of `?intake=` that means "the records the import could not tie to
 * a single batch". Not a batch, not an intake: 22 finance records carry
 * `batch_id = NULL` because Tracker Master's own Batch cell is a month, and a
 * month cannot tell a Morning cohort from an Evening one. The importer refused
 * to guess, so the grid offers them as their own clearly-labelled view rather
 * than leaving real money unreachable.
 */
export const UNASSIGNED_INTAKE = 'unassigned'

/** The session a batch name states, if it states one. Never inferred from anything else. */
export function sessionOfBatchName(name: string): Session | null {
  if (/\bmorning\b/i.test(name)) return 'Morning'
  if (/\bevening\b/i.test(name)) return 'Evening'
  return null
}

/** A batch as the loader reads it — what the grouping rule needs, and nothing more. */
export interface IntakeBatch {
  id: string
  programId: string
  programShortCode: string
  /** The stored `batches.name`, exactly. Never rewritten. */
  name: string
  /** Null for the six batches whose title never stated a full date. */
  startDate: string | null
  /** `batches.legacy_sheet_name` — the grouping key. */
  legacySheetName: string | null
  session: Session | null
  /** Students with a finance record in this batch. */
  studentCount: number
}

/** How precisely the source dates this intake. Shown to staff; never upgraded. */
export type IntakeDatePrecision =
  /** At least one underlying batch records a `start_date`. */
  | 'day'
  /** No start date; the sheet title states a month and a year. */
  | 'month'
  /** Neither. The intake is labelled by its source title alone. */
  | 'none'

export interface FinanceIntake {
  /**
   * The URL-safe key: the start date (`2026-07-29`) for a dated intake, the
   * stated month (`2025-12`) for a month-titled one, otherwise a slug of the
   * source title. Unique within a program.
   */
  key: string
  programId: string
  programShortCode: string
  /** `29 Jul 2026`, `December 2025`, `ELCE 25 & 26`. */
  displayName: string
  /** The sheet title (or batch name) the label was derived from. */
  sourceTitle: string
  /** The real batches behind the view. The write workflows will need these. */
  underlyingBatchIds: string[]
  /** Morning first, then Evening, then anything unsessioned by name. */
  batches: IntakeBatch[]
  /** Sessions any underlying batch states. Empty for ECEA. */
  availableSessions: Session[]
  latestStartDate: string | null
  datePrecision: IntakeDatePrecision
  studentCount: number
}

// -----------------------------------------------------------------------------
// Title reading — month and year only, exactly as written
// -----------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/**
 * `'Dec 2025'` -> `{ month: 12, year: 2025 }`; `'ELCE 25 & 26'` -> null.
 *
 * Only a bare month followed by a four-digit year is accepted. A two-digit
 * year ("March 26") is not expanded, because deciding which century it means
 * is exactly the kind of inference the importer refused to make.
 */
export function parseMonthTitle(title: string | null): { month: number; year: number } | null {
  if (title === null) return null
  const match = /^\s*([A-Za-z]+)\.?\s+(\d{4})\s*$/.exec(title)
  if (!match) return null
  const month = MONTHS[match[1].toLowerCase()]
  if (month === undefined) return null
  return { month, year: Number(match[2]) }
}

/** `2026-07-29` -> `29 Jul 2026`. Falls back to the ISO text if it will not parse. */
export function formatIntakeDate(isoDate: string): string {
  const parsed = parseISO(isoDate)
  return isValid(parsed) ? format(parsed, 'd MMM yyyy') : isoDate
}

function slugOf(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'intake' : slug
}

// -----------------------------------------------------------------------------
// Grouping
// -----------------------------------------------------------------------------

function sessionRank(session: Session | null): number {
  return session === 'Morning' ? 0 : session === 'Evening' ? 1 : 2
}

/** Morning before Evening, then by name, then id — stable whatever the input order. */
export function compareBatchesWithinIntake(a: IntakeBatch, b: IntakeBatch): number {
  return (
    sessionRank(a.session) - sessionRank(b.session) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  )
}

/**
 * Whether a set of batches from one sheet may be shown as one intake.
 *
 * At most two, and each stating a different session. Anything else is left
 * as separate intakes: the sheet alone cannot say which of three tables pair.
 */
function isPairable(group: readonly IntakeBatch[]): boolean {
  if (group.length === 1) return true
  if (group.length > 2) return false
  const sessions = group.map((batch) => batch.session)
  return sessions.every((session) => session !== null) && sessions[0] !== sessions[1]
}

interface DraftIntake extends Omit<FinanceIntake, 'key'> {
  /** What the intake sorts on. Empty when the source states no date at all. */
  sortKey: string
  /** The key before uniqueness within the program is enforced. */
  baseKey: string
}

function buildIntake(group: readonly IntakeBatch[]): DraftIntake {
  const batches = [...group].sort(compareBatchesWithinIntake)
  const first = batches[0]

  const dates = batches
    .map((batch) => batch.startDate)
    .filter((date): date is string => date !== null)
  const latestStartDate = dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : null

  const sourceTitle = first.legacySheetName ?? first.name
  const stated = latestStartDate === null ? parseMonthTitle(sourceTitle) : null

  let datePrecision: IntakeDatePrecision
  let displayName: string
  let baseKey: string
  let sortKey: string

  if (latestStartDate !== null) {
    datePrecision = 'day'
    displayName = formatIntakeDate(latestStartDate)
    baseKey = latestStartDate
    sortKey = latestStartDate
  } else if (stated !== null) {
    datePrecision = 'month'
    displayName = `${MONTH_NAMES[stated.month - 1]} ${stated.year}`
    baseKey = `${stated.year}-${String(stated.month).padStart(2, '0')}`
    sortKey = baseKey
  } else {
    datePrecision = 'none'
    displayName = sourceTitle.trim()
    baseKey = slugOf(sourceTitle)
    sortKey = ''
  }

  const availableSessions = SESSIONS.filter((session) =>
    batches.some((batch) => batch.session === session),
  )

  return {
    programId: first.programId,
    programShortCode: first.programShortCode,
    displayName,
    sourceTitle,
    underlyingBatchIds: batches.map((batch) => batch.id),
    batches,
    availableSessions,
    latestStartDate,
    datePrecision,
    studentCount: batches.reduce((sum, batch) => sum + batch.studentCount, 0),
    sortKey,
    baseKey,
  }
}

/**
 * Most recent first. A dated intake and a month-titled one compare on what
 * the source states; an intake stating neither sorts after everything that
 * states something. Ties break on label, then on the first batch id.
 */
function compareIntakes(a: DraftIntake, b: DraftIntake): number {
  if (a.sortKey !== b.sortKey) {
    if (a.sortKey === '') return 1
    if (b.sortKey === '') return -1
    return a.sortKey < b.sortKey ? 1 : -1
  }
  return (
    a.displayName.localeCompare(b.displayName) ||
    a.underlyingBatchIds[0].localeCompare(b.underlyingBatchIds[0])
  )
}

/**
 * Groups batches into intakes, most recent first.
 *
 * Pure and deterministic: the same batches in any order give the same intakes
 * in the same order with the same keys. Keys are unique within a program; on
 * the rare collision (two dated intakes sharing a day) the source title is
 * appended so neither link is ambiguous.
 */
export function groupBatchesIntoIntakes(batches: readonly IntakeBatch[]): FinanceIntake[] {
  const groups = new Map<string, IntakeBatch[]>()
  for (const batch of batches) {
    // The sheet is the grouping key. A batch with no recorded sheet — one
    // created some other way — can only ever be an intake of its own.
    const groupKey =
      batch.legacySheetName === null
        ? `${batch.programId}\u0000batch:${batch.id}`
        : `${batch.programId}\u0000sheet:${batch.legacySheetName}`
    const group = groups.get(groupKey)
    if (group) group.push(batch)
    else groups.set(groupKey, [batch])
  }

  const drafts: DraftIntake[] = []
  for (const group of groups.values()) {
    if (isPairable(group)) drafts.push(buildIntake(group))
    else for (const batch of group) drafts.push(buildIntake([batch]))
  }

  drafts.sort(compareIntakes)

  // Unique keys within a program.
  const seen = new Map<string, number>()
  return drafts.map((draft) => {
    const scope = `${draft.programId}\u0000${draft.baseKey}`
    const count = seen.get(scope) ?? 0
    seen.set(scope, count + 1)
    const key =
      count === 0 ? draft.baseKey : `${draft.baseKey}-${slugOf(draft.sourceTitle)}-${count}`
    const { sortKey: _sortKey, baseKey: _baseKey, ...intake } = draft
    void _sortKey
    void _baseKey
    return { key, ...intake }
  })
}

// -----------------------------------------------------------------------------
// Selection
// -----------------------------------------------------------------------------

export interface IntakeSelection {
  intake: FinanceIntake | null
  /** How the choice was reached, shown to staff. */
  note: string
}

function describeCohorts(intake: FinanceIntake): string {
  if (intake.availableSessions.length === 2) return ' It combines the Morning and Evening cohorts.'
  return ''
}

/**
 * The intake to open on: the first in the documented order.
 *
 * Says which rule it used, because "most recent" means something different for
 * an intake that states a day and one that states only a month.
 */
export function chooseDefaultIntake(intakes: readonly FinanceIntake[]): IntakeSelection {
  const first = intakes[0]
  if (!first) return { intake: null, note: 'No batches are available for this program.' }

  switch (first.datePrecision) {
    case 'day':
      return {
        intake: first,
        note: `Opened on the most recent intake with a recorded start date (${first.latestStartDate}).${describeCohorts(first)}`,
      }
    case 'month':
      return {
        intake: first,
        note:
          `Opened on the most recent intake. Its source title states only a month (${first.displayName}), ` +
          `so no exact start date is shown.${describeCohorts(first)}`,
      }
    case 'none':
      return {
        intake: first,
        note:
          'No intake in this program records a start date or a dated title, so the first by name is shown. ' +
          'Workbook tab order is not chronological and was not used.',
      }
  }
}

/**
 * Resolves the intake a link asked for.
 *
 * A stale or unknown key is not an error and does not empty the screen: staff
 * follow each other's bookmarks, and a key that no longer resolves should land
 * them on a working default with an explanation.
 */
export function resolveRequestedIntake(
  intakes: readonly FinanceIntake[],
  requestedKey: string | null,
): IntakeSelection {
  if (requestedKey !== null) {
    const requested = intakes.find((intake) => intake.key === requestedKey)
    if (requested) return { intake: requested, note: 'Showing the intake named in the link.' }
  }

  const fallback = chooseDefaultIntake(intakes)
  if (requestedKey !== null && fallback.intake !== null) {
    return {
      intake: fallback.intake,
      note: `The requested intake is not available for this program. ${fallback.note}`,
    }
  }
  return fallback
}

/**
 * Maps an old `?batch=<uuid>` link to the intake that now shows that batch,
 * and the session that narrows the grid to exactly the rows the old link
 * showed. Null when the id is not a known batch.
 */
export function intakeForBatch(
  intakes: readonly FinanceIntake[],
  batchId: string,
): { intake: FinanceIntake; session: Session | null } | null {
  for (const intake of intakes) {
    const batch = intake.batches.find((candidate) => candidate.id === batchId)
    if (batch) return { intake, session: batch.session }
  }
  return null
}
