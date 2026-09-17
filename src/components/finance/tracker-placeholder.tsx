import { Card } from '@/components/ui/card'

/**
 * Placeholder filter controls for the future finance grid.
 *
 * Disabled on purpose: the option lists come from real batch/program data that
 * this ticket does not import. Nothing here is wired up, and no sample student
 * or sample batch is invented.
 */
const FILTERS = [
  { label: 'Batch', placeholder: 'All batches' },
  { label: 'Program', placeholder: 'All programs' },
  { label: 'Balance Due', placeholder: 'Any balance' },
  { label: 'Receipt Status', placeholder: 'Any receipt status' },
  { label: 'Reminder Status', placeholder: 'Any reminder status' },
] as const

export function TrackerFilters() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {FILTERS.map((filter) => (
        <div key={filter.label} className="space-y-1">
          <label
            htmlFor={`filter-${filter.label.toLowerCase().replace(/\s+/g, '-')}`}
            className="block text-xs font-medium text-zinc-600 dark:text-zinc-400"
          >
            {filter.label}
          </label>
          <select
            id={`filter-${filter.label.toLowerCase().replace(/\s+/g, '-')}`}
            disabled
            aria-describedby="tracker-filters-note"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option>{filter.placeholder}</option>
          </select>
        </div>
      ))}
    </div>
  )
}

/** Where the virtualised, Excel-style grid will be mounted. */
export function TrackerGridPlaceholder() {
  return (
    <Card className="mt-4 border-dashed">
      <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Excel-style finance grid
        </p>
        <p className="max-w-md text-sm text-zinc-500">
          The batch tracker grid will render here once the finance schema exists and the
          historical workbook has been imported. No data is loaded yet.
        </p>
      </div>
    </Card>
  )
}
