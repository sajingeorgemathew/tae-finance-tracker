/**
 * Choosing which batch the tracker opens on, and in what order they are listed.
 *
 * Six of the twenty-two PSW batches have no `start_date`: their sheet titles
 * say "December 2025" or "March 26" and never state a full date, and the
 * importer refused to invent one. So ordering cannot simply be by date, and the
 * position of a sheet in the workbook is not evidence of when its batch ran —
 * the tabs are not in chronological order.
 *
 * The rule, applied in this order and documented in docs/FINANCE-GRID-03.md:
 *
 *   1. batches with a `start_date`, most recent first;
 *   2. then batches without one, which cannot be placed on the timeline;
 *   3. Morning before Evening, when the name says which — the two halves of a
 *      day are a pair, and staff read the morning cohort first;
 *   4. then by name, then by id.
 *
 * Steps 3 and 4 exist so the result is deterministic. A date alone does not
 * pick a winner: every batch is one of a same-day Morning/Evening pair, so the
 * most recent date always ties.
 */

import type { BatchOption } from './types.ts'

/**
 * The value of `?batch=` that means "the records the import could not tie to a
 * single batch".
 *
 * Not a batch id and not a batch: 22 finance records carry `batch_id = NULL`
 * because Tracker Master's own Batch column is a date serial and a date cannot
 * tell the Morning cohort from the Evening one. The importer refused to guess,
 * so the grid offers them as their own clearly-labelled view rather than
 * leaving real money unreachable.
 */
export const UNASSIGNED_BATCH = 'unassigned'

/** The session a batch name states, if it states one. Never inferred. */
function sessionRank(name: string): number {
  if (/\bmorning\b/i.test(name)) return 0
  if (/\bevening\b/i.test(name)) return 1
  return 2
}

/**
 * Batch list order: most recent datable batch first, undatable ones after.
 *
 * Undatable batches sort last rather than being guessed into the sequence. They
 * are still listed, still selectable, and still show their imported name.
 */
export function compareBatches(a: BatchOption, b: BatchOption): number {
  if (a.startDate !== b.startDate) {
    if (a.startDate === null) return 1
    if (b.startDate === null) return -1
    return a.startDate < b.startDate ? 1 : -1
  }

  return (
    sessionRank(a.name) - sessionRank(b.name) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  )
}

export interface DefaultBatchResult {
  batch: BatchOption | null
  /** How the choice was reached, shown in the UI and recorded in the docs. */
  note: string
}

/**
 * The batch to open on for a given program scope.
 *
 * Prefers the most recent batch that states a start date. Only if no batch in
 * scope states one does it fall back to the name/id ordering above — and it
 * says so, rather than presenting a guess as a choice.
 */
export function chooseDefaultBatch(batches: readonly BatchOption[]): DefaultBatchResult {
  if (batches.length === 0) {
    return { batch: null, note: 'No batches are available for this program.' }
  }

  const ordered = [...batches].sort(compareBatches)
  const datable = ordered.filter((batch) => batch.startDate !== null)

  if (datable.length > 0) {
    const chosen = datable[0]
    const sameDate = datable.filter((batch) => batch.startDate === chosen.startDate)
    const tieBreak =
      sameDate.length > 1
        ? ` ${sameDate.length} batches share that start date; the morning cohort is shown first.`
        : ''

    return {
      batch: chosen,
      note: `Opened on the most recent batch with a recorded start date (${chosen.startDate}).${tieBreak}`,
    }
  }

  return {
    batch: ordered[0],
    note:
      'No batch in this program records a start date, so the first batch by name is shown. ' +
      'Workbook tab order is not chronological and was not used.',
  }
}

/**
 * Resolves the batch a request asked for.
 *
 * An unknown or stale id is not an error and does not empty the screen: staff
 * follow each other's bookmarked links, and a batch id that no longer resolves
 * should land them on a working default with an explanation, not a blank page.
 */
export function resolveRequestedBatch(
  batches: readonly BatchOption[],
  requestedId: string | null,
): DefaultBatchResult {
  if (requestedId !== null) {
    const requested = batches.find((batch) => batch.id === requestedId)
    if (requested) {
      return { batch: requested, note: 'Showing the batch named in the link.' }
    }
  }

  const fallback = chooseDefaultBatch(batches)
  if (requestedId !== null && fallback.batch !== null) {
    return {
      batch: fallback.batch,
      note: `The requested batch is not available for this program. ${fallback.note}`,
    }
  }

  return fallback
}
