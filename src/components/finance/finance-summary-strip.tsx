'use client'

import { displayMoney } from '@/lib/finance/grid/money'
import type { FinanceGridView } from '@/lib/finance/grid/types'
import { cn } from '@/lib/utils'

/**
 * Batch-level totals, above the grid.
 *
 * Every figure is a sum of *this batch's own imported snapshots* and nothing
 * else. Normalized Tracker Master payments are deliberately excluded: they are
 * another view of the same historical money, and adding them in would state a
 * figure twice. That is the same reason the import refused to write the batch
 * sheets' ACTUAL cells as payments.
 *
 * Where students recorded no figure, the count of those students is shown
 * beside the total. A sum over 18 of 23 students is a different fact from a sum
 * over all 23, and staff reconciling a batch need to know which one they have.
 */

export function FinanceSummaryStrip({ view }: { view: FinanceGridView }) {
  const { totals } = view

  return (
    <section
      aria-label="Historical totals for the selected batch"
      className="rounded-md border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <Stat label="Students in batch" value={String(totals.students)} />
        <Stat
          label="Historical total fees"
          value={displayMoney(totals.totalFees)}
          missing={totals.feesMissing}
        />
        <Stat
          label="Historical total paid"
          value={displayMoney(totals.totalPaid)}
          missing={totals.paidMissing}
        />
        <Stat
          label="Historical balance"
          value={displayMoney(totals.balance)}
          missing={totals.balanceMissing}
          negative={totals.balance.kind === 'amount' && totals.balance.amount < 0}
        />

        <p className="ml-auto max-w-md text-right text-xs text-zinc-500">
          Historical totals, summed from this batch&rsquo;s imported workbook figures only.
        </p>
      </div>

      <p className="mt-3 border-t border-zinc-100 pt-2 text-xs text-zinc-500 dark:border-zinc-900">
        {view.balanceConvention.note}
      </p>

      {view.truncated ? (
        <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">
          This batch returned more rows than the page loads at once, so the figures above may not
          cover every student. Narrow the selection before reconciling.
        </p>
      ) : null}
    </section>
  )
}

function Stat({
  label,
  value,
  missing = 0,
  negative = false,
}: {
  label: string
  value: string
  missing?: number
  negative?: boolean
}) {
  return (
    <div>
      <p className="text-xs text-zinc-500">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-lg font-semibold tabular-nums',
          negative && 'text-red-700 dark:text-red-400',
        )}
      >
        {value}
      </p>
      {missing > 0 ? (
        <p className="text-[11px] text-zinc-400">
          {missing} student{missing === 1 ? '' : 's'} recorded no figure
        </p>
      ) : null}
    </div>
  )
}
