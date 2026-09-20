'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useTransition } from 'react'

import { GRID_FILTERS, gridFilterLabel, type GridFilter } from '@/lib/finance/grid/filters'
import { UNASSIGNED_BATCH } from '@/lib/finance/grid/select-batch'
import type { BatchOption, FinanceGridView } from '@/lib/finance/grid/types'
import { cn } from '@/lib/utils'

/**
 * Program, batch, search and the quick filters.
 *
 * Two different kinds of control live here, and they update the URL in two
 * different ways on purpose:
 *
 * - **Program and batch** change *which rows exist*, so they navigate. The
 *   server reloads the batch and the grid re-renders from real data.
 * - **Search and the quick filters** narrow rows already on the screen, so they
 *   update the URL through `window.history.replaceState` — which Next.js wires
 *   into the router without a round trip. Typing a student number therefore
 *   filters instantly and still leaves a link a colleague can open.
 *
 * Everything lands in the URL either way, so a staff member can bookmark a
 * batch, refresh without losing their place, or paste the link into a message.
 */

export interface FilterBarProps {
  view: FinanceGridView
  search: string
  onSearchChange: (value: string) => void
  filter: GridFilter
  onFilterChange: (value: GridFilter) => void
  /** Rows currently visible, for the result count. */
  visibleRows: number
}

export function FinanceFilterBar({
  view,
  search,
  onSearchChange,
  filter,
  onFilterChange,
  visibleRows,
}: FilterBarProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  const navigate = useCallback(
    (changes: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString())
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) params.delete(key)
        else params.set(key, value)
      }
      startTransition(() => router.push(`/finance?${params.toString()}`, { scroll: false }))
    },
    [router, searchParams],
  )

  useUrlMirror({ q: search || null, filter: filter === 'all' ? null : filter })

  const batches = [...view.batches]
  const balanceFiltersEnabled = view.balanceConvention.filterable

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Program" htmlFor="finance-program">
          <select
            id="finance-program"
            className={SELECT_CLASS}
            value={view.selectedProgram?.shortCode ?? ''}
            onChange={(event) =>
              // Changing program invalidates the batch: its batches belong to
              // the old one. Dropping it lets the server pick this program's
              // default rather than landing on an empty grid.
              navigate({ program: event.target.value, batch: null })
            }
          >
            {view.programs.map((program) => (
              <option key={program.id} value={program.shortCode}>
                {program.shortCode} — {program.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Batch" htmlFor="finance-batch">
          <select
            id="finance-batch"
            className={cn(SELECT_CLASS, 'min-w-72')}
            value={view.unassigned ? UNASSIGNED_BATCH : (view.selectedBatch?.id ?? '')}
            onChange={(event) => navigate({ batch: event.target.value })}
          >
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batchLabel(batch)}
              </option>
            ))}
            {view.unassignedCount > 0 ? (
              <option value={UNASSIGNED_BATCH}>
                Unassigned — no batch ({view.unassignedCount})
              </option>
            ) : null}
          </select>
        </Field>

        <Field label="Search student" htmlFor="finance-search">
          <input
            id="finance-search"
            type="search"
            inputMode="search"
            autoComplete="off"
            placeholder="Student number or name"
            className={cn(SELECT_CLASS, 'w-64')}
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </Field>

        <div className="ml-auto flex items-end gap-2">
          <button
            type="button"
            disabled
            title="Exporting the finance grid arrives in a later ticket."
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-400 disabled:cursor-not-allowed dark:border-zinc-700 dark:text-zinc-600"
          >
            Export
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="sr-only" id="finance-filter-label">
          Filter rows
        </span>
        <div role="group" aria-labelledby="finance-filter-label" className="flex flex-wrap gap-2">
          {GRID_FILTERS.map((option) => {
            const disabled = isBalanceFilter(option) && !balanceFiltersEnabled
            return (
              <button
                key={option}
                type="button"
                aria-pressed={filter === option}
                disabled={disabled}
                title={disabled ? view.balanceConvention.note : undefined}
                onClick={() => onFilterChange(option)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  filter === option
                    ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                    : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900',
                  disabled && 'cursor-not-allowed opacity-40 hover:bg-white dark:hover:bg-zinc-950',
                )}
              >
                {gridFilterLabel(option)}
              </button>
            )
          })}

          {/*
            Reminders have never been sent from this system, so there is nothing
            to filter on. Shown disabled rather than omitted, so the control is
            discoverable and its absence is explained instead of implied.
          */}
          <button
            type="button"
            disabled
            title="No reminders have been sent yet. This filter arrives with the reminder workflow."
            className="cursor-not-allowed rounded-full border border-dashed border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-400 dark:border-zinc-700 dark:text-zinc-600"
          >
            Reminder needed
          </button>
        </div>

        <span className="ml-auto text-xs text-zinc-500" aria-live="polite">
          {isPending ? 'Loading…' : `${visibleRows} of ${view.rows.length} shown`}
        </span>
      </div>
    </div>
  )
}

const SELECT_CLASS =
  'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100'

function isBalanceFilter(filter: GridFilter): boolean {
  return filter === 'balance_due' || filter === 'settled'
}

/** A batch's line in the selector: its imported name, and how many students. */
function batchLabel(batch: BatchOption): string {
  const count = `${batch.studentCount} student${batch.studentCount === 1 ? '' : 's'}`
  // No date is fabricated for the six batches whose title never stated one.
  return batch.startDate === null
    ? `${batch.name} — ${count} · no start date`
    : `${batch.name} — ${count}`
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor={htmlFor}
        className="block text-xs font-medium text-zinc-600 dark:text-zinc-400"
      >
        {label}
      </label>
      {children}
    </div>
  )
}

/**
 * Mirrors client-side state into the URL without navigating.
 *
 * `window.history.replaceState` is integrated with the Next.js router, so the
 * address bar and `useSearchParams` stay in step while the server is left
 * alone. Debounced, because otherwise every keystroke writes a history entry.
 *
 * Only a student number or name the user deliberately typed reaches the URL.
 * Nothing else about a student is put there, and nothing is written to local
 * storage.
 */
function useUrlMirror(values: Record<string, string | null>) {
  const serialized = JSON.stringify(values)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const parsed = JSON.parse(serialized) as Record<string, string | null>

    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const params = new URLSearchParams(window.location.search)
      for (const [key, value] of Object.entries(parsed)) {
        if (value === null || value === '') params.delete(key)
        else params.set(key, value)
      }
      const query = params.toString()
      window.history.replaceState(null, '', query === '' ? window.location.pathname : `?${query}`)
    }, 300)

    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [serialized])
}
