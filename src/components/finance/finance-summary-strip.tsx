'use client'

import { StatusDot } from '@/components/finance/finance-cells'
import { displayMoney } from '@/lib/finance/grid/money'
import { PAYMENT_STATUSES, paymentStatusLabel } from '@/lib/finance/grid/payment-status'
import type { FinanceGridView } from '@/lib/finance/grid/types'
import { cn } from '@/lib/utils'

/**
 * Intake-level counts and totals, above the grid.
 *
 * The first row answers the operational questions: how many students, how
 * many in each cohort, and how many are Outstanding, Settled, Credit or
 * Unknown — the same derivation the row badges and the quick filter use.
 *
 * The second row is history. Every figure is a sum of *the underlying batches'
 * own imported snapshots* and nothing else. A combined intake sums both
 * batches' snapshots; each row appears once, so nothing is counted twice.
 * Normalized Tracker Master payments are deliberately excluded: they are
 * another view of the same historical money, and adding them in would state a
 * figure twice. Where students recorded no figure, the count of those students
 * is shown beside the total — a sum over 18 of 23 students is a different fact
 * from a sum over all 23 — and a column nobody filled in totals to a blank,
 * not `$0.00`.
 */

export function FinanceSummaryStrip({ view }: { view: FinanceGridView }) {
  const { totals, statusCounts, sessionCounts } = view
  const cohorts = sessionCounts.Morning + sessionCounts.Evening > 0

  // The Unassigned view's transaction figures (RECONCILE-04A): a count of
  // imported payments and how many records hold at least one. Real
  // normalized data, labelled as payments, never added to the historical
  // totals beside it.
  const importedPayments = view.rows.reduce((sum, row) => sum + row.paymentCount, 0)
  const recordsWithPayments = view.rows.filter((row) => row.paymentCount > 0).length
  const scope = view.unassigned
    ? 'these unassigned records'
    : view.batchConventions.length > 1
      ? `the ${view.batchConventions.length} underlying batches`
      : 'this batch'

  return (
    <section
      aria-label="Intake summary"
      className="rounded-md border border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <Stat
          label="Students"
          value={String(totals.students)}
          note={
            cohorts
              ? `Morning ${sessionCounts.Morning} · Evening ${sessionCounts.Evening}`
              : undefined
          }
        />

        {PAYMENT_STATUSES.map((status) => (
          <Stat
            key={status}
            label={paymentStatusLabel(status)}
            value={String(statusCounts[status])}
            dot={<StatusDot status={status} />}
            muted={statusCounts[status] === 0}
          />
        ))}

        <span className="hidden h-8 w-px self-center bg-zinc-200 sm:block dark:bg-zinc-800" aria-hidden="true" />

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

        {view.unassigned ? (
          <>
            <span className="hidden h-8 w-px self-center bg-zinc-200 sm:block dark:bg-zinc-800" aria-hidden="true" />
            <Stat
              label="Imported payments"
              value={String(importedPayments)}
              note={`on ${recordsWithPayments} of ${view.rows.length} records · ${view.rows.length - recordsWithPayments} with none`}
            />
          </>
        ) : null}
      </div>

      <div className="mt-2 space-y-0.5 border-t border-zinc-100 pt-1.5 text-[11px] text-zinc-500 dark:border-zinc-900">
        <p>
          Historical totals are summed from the imported workbook figures of {scope} only; a
          student with no figure is left out, not counted as zero. Payment Status reads each
          row&rsquo;s imported balance under its own batch&rsquo;s verified sign convention.
        </p>
        <p>{view.balanceConvention.note}</p>

        {view.unassigned ? (
          <p data-unassigned-note="">
            No batch snapshot exists for these records: the import found no batch sheet row for
            them, so there is no Total Paid, no Balance and no Actual or Installment fee
            structure to show, and none has been calculated. Total fees above is Tracker
            Master&rsquo;s Enrollment Total Fees where a row stated it. Their imported Tracker
            Master payments are listed per record under Imported transactions and in Details;
            a payments total is a transaction sum, not a balance.
          </p>
        ) : null}

        {/*
          Structure is stated once, here, rather than marked on every cell. A
          column the workbook layout lists and nobody filled in is a fact about
          the sheet, not about any student, and it contributes nothing to the
          totals above — not zero, nothing.
        */}
        {view.layoutSource === 'manifest' && view.blankStructuralColumns > 0 ? (
          <p>
            {view.blankStructuralColumns} column{view.blankStructuralColumns === 1 ? '' : 's'}{' '}
            from the workbook layout hold{view.blankStructuralColumns === 1 ? 's' : ''} no figure
            for any student shown. {view.blankStructuralColumns === 1 ? 'It is' : 'They are'}{' '}
            shown blank, as the workbook showed {view.blankStructuralColumns === 1 ? 'it' : 'them'}
            , and not as $0.00.
          </p>
        ) : null}

        {view.truncated ? (
          <p className="font-medium text-amber-700 dark:text-amber-400">
            This intake returned more rows than the page loads at once, so the figures above may
            not cover every student. Narrow the selection before reconciling.
          </p>
        ) : null}
      </div>
    </section>
  )
}

function Stat({
  label,
  value,
  note,
  missing = 0,
  negative = false,
  muted = false,
  dot,
}: {
  label: string
  value: string
  note?: string
  missing?: number
  negative?: boolean
  muted?: boolean
  dot?: React.ReactNode
}) {
  return (
    <div className={cn(muted && 'opacity-60')}>
      <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
        {dot}
        {label}
      </p>
      <p
        className={cn(
          'text-base leading-tight font-semibold tabular-nums',
          negative && 'text-red-700 dark:text-red-400',
        )}
      >
        {value}
      </p>
      {note ? <p className="text-[11px] text-zinc-400">{note}</p> : null}
      {missing > 0 ? (
        <p className="text-[11px] text-zinc-400">
          {missing} student{missing === 1 ? '' : 's'} recorded no figure
        </p>
      ) : null}
    </div>
  )
}
