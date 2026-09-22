/**
 * Combining the grids of an intake's underlying batches into one view.
 *
 * FINANCE-GRID-03C. A PSW intake is one Morning batch and one Evening batch,
 * each with its own manifest, its own finance records and its own verified
 * balance convention. Each is built on its own by `buildFinanceGrid` — exactly
 * as GRID-03 built it — and only then are the two placed side by side here.
 * Nothing about a row changes when its batch joins an intake: same cells, same
 * snapshot, same status, same `batchId`.
 *
 * ## The column union
 *
 * Both batches sit on the same sheet, so their column letters usually agree.
 * A column is the *same* column in both when its section, source key and
 * heading agree (heading compared case-insensitively with whitespace
 * collapsed, so "Late fees" and "Late Fees" are one column). Where the same
 * letter carries a different heading — the workbook has "Mar" in one table
 * and "Marc" in the other, and "Late Fees" against "Feb" — they are two
 * columns, shown side by side, each labelled as its own table headed it.
 * Nothing is renamed to force a match.
 *
 * A column present in one batch and not the other stays in the grid. A row
 * from the batch that lacks it has no such cell, and renders blank: the
 * workbook never had a cell there for that student, and "no cell" is not
 * `$0.00`.
 *
 * Order is a merge of the two batches' own orders — Morning's sequence first,
 * with Evening's extra columns inserted after the column that precedes them in
 * Evening — so the combined grid reads left to right the way each sheet did.
 *
 * ## Totals
 *
 * Every row appears once, so summing the combined rows' snapshots is the sum
 * of the two batches' snapshots with nothing counted twice. Missing figures
 * stay missing.
 */

import type { BalanceConventionResult } from './balance.ts'
import type { Session } from './intake.ts'
import { normalizeHeader } from './legacy-cells.ts'
import { BLANK_MONEY, type MoneyCell } from './money.ts'
import { countPaymentStatuses } from './payment-status.ts'
import type {
  BatchConventionSummary,
  FinanceColumn,
  FinanceGridRow,
  LayoutSource,
} from './types.ts'
import { summarize, type BuiltGrid } from './view-model.ts'

export interface BatchGridPart {
  batchId: string
  batchName: string
  session: Session | null
  grid: BuiltGrid
}

export interface CombinedGrid extends BuiltGrid {
  batchConventions: BatchConventionSummary[]
  statusCounts: ReturnType<typeof countPaymentStatuses>
  sessionCounts: Record<Session, number>
}

// -----------------------------------------------------------------------------
// Column identity
// -----------------------------------------------------------------------------

/** What makes two columns from two batches the same column. */
function identityOf(column: FinanceColumn): string {
  return `${column.section}|${column.key}|${normalizeHeader(column.label)}`
}

function keySlug(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'x'
}

interface UnionEntry {
  /** The key rows are re-mapped to. The source key when unambiguous. */
  key: string
  /** The key as the batch's own manifest had it — the letter position. */
  sourceKey: string
  column: FinanceColumn
  sessions: Session[]
}

/**
 * Unions one section's columns across the parts, in merged source order.
 *
 * Returns the union and, per part, the map from that part's own column keys
 * to the union keys its cells must be re-keyed under.
 */
export function unionColumns(
  lists: readonly { session: Session | null; columns: readonly FinanceColumn[] }[],
): { columns: FinanceColumn[]; remap: Map<string, string>[] } {
  // 1. Which identities each source key carries across all parts. A key that
  //    carries exactly one identity keeps its key; one that carries several
  //    (same letter, different heading) gets a heading-qualified key each.
  const identitiesByKey = new Map<string, Set<string>>()
  for (const list of lists) {
    for (const column of list.columns) {
      const set = identitiesByKey.get(column.key) ?? new Set<string>()
      set.add(identityOf(column))
      identitiesByKey.set(column.key, set)
    }
  }
  const unionKeyOf = (column: FinanceColumn): string =>
    (identitiesByKey.get(column.key)?.size ?? 0) > 1
      ? `${column.key}~${keySlug(normalizeHeader(column.label))}`
      : column.key

  // 2. Merge, preserving each list's own order.
  const merged: UnionEntry[] = []
  const remap: Map<string, string>[] = []

  for (const list of lists) {
    const map = new Map<string, string>()
    let insertAt = 0
    for (const column of list.columns) {
      const key = unionKeyOf(column)
      map.set(column.key, key)

      const existing = merged.findIndex((entry) => entry.key === key)
      if (existing >= 0) {
        if (list.session !== null && !merged[existing].sessions.includes(list.session)) {
          merged[existing].sessions.push(list.session)
        }
        insertAt = existing + 1
        continue
      }

      // The same letter headed differently in the other table sits at the
      // same sheet position, so the new column goes directly after it — the
      // two readings of one column stay side by side, earlier table first.
      let sibling = -1
      for (let index = merged.length - 1; index >= 0; index -= 1) {
        if (merged[index].sourceKey === column.key) {
          sibling = index
          break
        }
      }
      if (sibling >= 0) insertAt = Math.max(insertAt, sibling + 1)

      merged.splice(insertAt, 0, {
        key,
        sourceKey: column.key,
        column,
        sessions: list.session === null ? [] : [list.session],
      })
      insertAt += 1
    }
    remap.push(map)
  }

  return {
    columns: merged.map((entry) => ({
      ...entry.column,
      key: entry.key,
      sessions: entry.sessions,
      // The other headings at this source position, in merged order, so the
      // grid can say "the Evening table heads this position 'Marc'".
      conflictingHeadings: merged
        .filter((other) => other !== entry && other.sourceKey === entry.sourceKey)
        .map((other) => other.column.label),
    })),
    remap,
  }
}

function rekeyCells(
  cells: Record<string, MoneyCell>,
  map: ReadonlyMap<string, string>,
  unionKeys: readonly string[],
): Record<string, MoneyCell> {
  const out: Record<string, MoneyCell> = {}
  // Every union column gets a cell, blank unless this row's own batch had one.
  for (const key of unionKeys) out[key] = BLANK_MONEY
  for (const [key, cell] of Object.entries(cells)) {
    const target = map.get(key)
    if (target !== undefined) out[target] = cell
  }
  return out
}

// -----------------------------------------------------------------------------
// Convention summary
// -----------------------------------------------------------------------------

function sessionWord(session: Session | null, batchName: string): string {
  return session ?? batchName
}

/**
 * The intake-level reading of per-batch conventions.
 *
 * A single batch keeps its own result verbatim. Two batches are reported
 * separately in the note — each cohort's rows are read under their own
 * batch's verified convention, and the note says so rather than pretending
 * one verification covered both.
 */
function combineConventions(parts: readonly BatchGridPart[]): BalanceConventionResult {
  if (parts.length === 1) return parts[0].grid.balanceConvention

  const results = parts.map((part) => part.grid.balanceConvention)
  const checked = results.reduce((sum, result) => sum + result.checked, 0)
  const disagreeing = results.reduce((sum, result) => sum + result.disagreeing, 0)

  const allVerified = results.every((result) => result.convention === 'paid_minus_fee')
  const anyInconsistent = results.some((result) => result.convention === 'inconsistent')

  const perCohort = parts
    .map((part) => {
      const result = part.grid.balanceConvention
      const label = sessionWord(part.session, part.batchName)
      switch (result.convention) {
        case 'paid_minus_fee':
          return `${label}: verified across ${result.checked} student${result.checked === 1 ? '' : 's'}`
        case 'unverifiable':
          return `${label}: no student records all three figures, so its rows show Unknown`
        case 'inconsistent':
          return `${label}: ${result.disagreeing} of ${result.checked} disagree, so its rows show Unknown`
      }
    })
    .join('; ')

  if (allVerified) {
    return {
      convention: 'paid_minus_fee',
      checked,
      disagreeing,
      filterable: true,
      note:
        `Balance sign convention verified separately for each cohort (${perCohort}): ` +
        'the recorded balance is total paid minus total fee, so a negative balance is money still owed.',
    }
  }

  return {
    convention: anyInconsistent ? 'inconsistent' : 'unverifiable',
    checked,
    disagreeing,
    filterable: results.some((result) => result.filterable),
    note: `Balance sign convention is checked per cohort (${perCohort}). Rows without a verified convention show Payment Status Unknown.`,
  }
}

// -----------------------------------------------------------------------------
// Combining
// -----------------------------------------------------------------------------

/**
 * Places the parts' grids side by side as one intake grid.
 *
 * Parts are taken in the order given — the intake orders them Morning first —
 * and each part's rows keep their own workbook order within it.
 */
export function combineBatchGrids(parts: readonly BatchGridPart[]): CombinedGrid {
  const actual = unionColumns(
    parts.map((part) => ({ session: part.session, columns: part.grid.columns })),
  )
  const scheduled = unionColumns(
    parts.map((part) => ({ session: part.session, columns: part.grid.scheduledColumns })),
  )
  const actualKeys = actual.columns.map((column) => column.key)
  const scheduledKeys = scheduled.columns.map((column) => column.key)

  const rows: FinanceGridRow[] = []
  parts.forEach((part, index) => {
    for (const row of part.grid.rows) {
      rows.push({
        ...row,
        actualCells: rekeyCells(row.actualCells, actual.remap[index], actualKeys),
        scheduledCells: rekeyCells(row.scheduledCells, scheduled.remap[index], scheduledKeys),
      })
    }
  })

  const allBlank = (column: FinanceColumn): boolean =>
    rows.every((row) => {
      const cell =
        column.section === 'actual' ? row.actualCells[column.key] : row.scheduledCells[column.key]
      return cell === undefined || cell.kind === 'blank'
    })

  const columns = [...actual.columns, ...scheduled.columns]
  const blankStructuralColumns = columns.filter(
    (column) => column.origin === 'manifest' && allBlank(column),
  ).length

  const layoutSource: LayoutSource = columns.some((column) => column.origin === 'manifest')
    ? 'manifest'
    : columns.length > 0
      ? 'derived'
      : 'none'

  const sessionCounts: Record<Session, number> = { Morning: 0, Evening: 0 }
  for (const row of rows) if (row.session !== null) sessionCounts[row.session] += 1

  return {
    columns: actual.columns,
    scheduledColumns: scheduled.columns,
    layoutSource,
    blankStructuralColumns,
    rows,
    totals: summarize(rows),
    balanceConvention: combineConventions(parts),
    batchConventions: parts.map((part) => ({
      batchId: part.batchId,
      batchName: part.batchName,
      session: part.session,
      students: part.grid.rows.length,
      result: part.grid.balanceConvention,
    })),
    statusCounts: countPaymentStatuses(rows),
    sessionCounts,
  }
}
