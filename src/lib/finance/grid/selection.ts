/**
 * Row selection, keyed on `financeRecordId`.
 *
 * Kept as a plain record so a selection survives re-renders and cannot migrate
 * to a different student when rows re-order, and so "select all" can be
 * defined precisely: it acts on the rows *currently visible* after the intake,
 * session, status and search filters — never on rows a filter has hidden.
 *
 * Pure, so the rule is tested rather than assumed.
 */

export type RowSelection = Record<string, boolean>

/** Ids that are currently ticked. */
export function selectedIds(selection: RowSelection): string[] {
  return Object.keys(selection).filter((id) => selection[id])
}

/** Whether every visible row is ticked (false when nothing is visible). */
export function allVisibleSelected(selection: RowSelection, visibleIds: readonly string[]): boolean {
  return visibleIds.length > 0 && visibleIds.every((id) => selection[id] === true)
}

/** Whether some, but not all, visible rows are ticked. Drives the indeterminate state. */
export function someVisibleSelected(
  selection: RowSelection,
  visibleIds: readonly string[],
): boolean {
  return visibleIds.some((id) => selection[id] === true) && !allVisibleSelected(selection, visibleIds)
}

/**
 * Select-all-visible. Ticks exactly the visible rows, or unticks exactly them;
 * a row hidden by a filter is left as it was either way.
 */
export function toggleVisible(
  selection: RowSelection,
  visibleIds: readonly string[],
  select: boolean,
): RowSelection {
  const next: RowSelection = { ...selection }
  for (const id of visibleIds) {
    if (select) next[id] = true
    else delete next[id]
  }
  return next
}

export function toggleOne(selection: RowSelection, id: string): RowSelection {
  const next: RowSelection = { ...selection }
  if (next[id]) delete next[id]
  else next[id] = true
  return next
}
