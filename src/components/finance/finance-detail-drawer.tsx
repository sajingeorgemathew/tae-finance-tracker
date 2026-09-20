'use client'

import { useEffect, useRef } from 'react'

import { LegacyBadge, Money, ReceiptBadge } from '@/components/finance/finance-cells'
import { balanceStateLabel } from '@/lib/finance/grid/balance'
import { displayMoney } from '@/lib/finance/grid/money'
import { legacyReceiptExplanation } from '@/lib/finance/grid/receipt-status'
import { NO_STUDENT_NUMBER } from '@/lib/finance/grid/student-name'
import type { FinanceColumn, FinanceGridRow } from '@/lib/finance/grid/types'

/**
 * One student's finance record, opened from the grid.
 *
 * The drawer is where the two sources are shown side by side and *labelled as
 * two sources*, which the grid has no room to do:
 *
 * - the **historical snapshot** the batch workbook recorded, and
 * - the **imported transactions** Tracker Master holds.
 *
 * They frequently disagree, and the drawer says so plainly instead of picking a
 * winner. A payment reached this batch record only when the student appeared in
 * exactly one batch table for the program — so a snapshot showing money paid
 * with no transactions behind it is a routing outcome, not a missing payment.
 *
 * Read-only throughout. No field is editable, nothing can be voided, and no
 * receipt can be generated or sent from here.
 */

export interface DetailDrawerProps {
  row: FinanceGridRow | null
  scheduledColumns: readonly FinanceColumn[]
  onClose: () => void
}

export function FinanceDetailDrawer({ row, scheduledColumns, onClose }: DetailDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null)

  // Escape closes, and focus moves into the panel when it opens, so the drawer
  // is usable without a mouse.
  useEffect(() => {
    if (row === null) return

    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [row, onClose])

  if (row === null) return null

  const scheduled = scheduledColumns
    .map((column) => ({ column, cell: row.scheduledCells[column.key] }))
    .filter((entry) => entry.cell !== undefined && entry.cell.kind !== 'blank')

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-zinc-900/20 dark:bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="finance-drawer-title"
        className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
      >
        <header className="flex items-start gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <div className="min-w-0 flex-1">
            <h2 id="finance-drawer-title" className="flex items-center text-base font-semibold">
              <span className="truncate">{row.studentName}</span>
              <LegacyBadge flags={row.legacyFlags} />
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              {row.studentNumber === null ? (
                <span className="italic">{NO_STUDENT_NUMBER}</span>
              ) : (
                <span className="tabular-nums">Student #{row.studentNumber}</span>
              )}
              {' · '}
              {row.programShortCode}
              {row.batchName === null ? ' · No batch' : ` · ${row.batchName}`}
            </p>
          </div>

          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Close
          </button>
        </header>

        <div className="space-y-6 px-5 py-5">
          <Section
            title="Historical snapshot"
            note="Copied from the batch workbook as recorded. Never recalculated."
          >
            <dl className="grid grid-cols-3 gap-3">
              <Figure label="Total fee" value={displayMoney(row.legacyTotalFee)} />
              <Figure label="Total paid" value={displayMoney(row.legacyTotalPaid)} />
              <Figure
                label="Balance"
                value={displayMoney(row.legacyBalance)}
                caption={balanceStateLabel(row.balanceState)}
                negative={row.legacyBalance.kind === 'amount' && row.legacyBalance.amount < 0}
              />
            </dl>
          </Section>

          {scheduled.length > 0 ? (
            <Section
              title="Scheduled installments"
              note="From the workbook's INSTALLMENT FEE STRUCTURE section. A month with no scheduled figure is absent, not zero."
            >
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {scheduled.map(({ column, cell }) => (
                  <li key={column.key} className="flex items-center justify-between py-1.5">
                    <span className="text-zinc-600 dark:text-zinc-400">{column.label}</span>
                    <Money cell={cell} className="w-32" />
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section
            title="Imported transactions"
            note="Tracker Master payments tied to this record. This is the transaction history, and it is not the same figure as the workbook's Total Paid above."
          >
            {row.payments.length === 0 ? (
              <p className="text-zinc-500">
                No imported payment is tied to this record. A payment reached a batch record only
                where the workbook identified one batch unambiguously; others were kept on an
                unassigned record rather than guessed into a cohort.
              </p>
            ) : (
              <>
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
                      <th scope="col" className="py-1 pr-3 font-medium">
                        Date
                      </th>
                      <th scope="col" className="py-1 pr-4 text-right font-medium">
                        Amount
                      </th>
                      <th scope="col" className="py-1 pr-3 font-medium">
                        Method
                      </th>
                      <th scope="col" className="py-1 font-medium">
                        Receipt (legacy)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.payments.map((payment) => (
                      <tr
                        key={payment.id}
                        className="border-b border-zinc-100 align-top last:border-b-0 dark:border-zinc-900"
                      >
                        <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">
                          {payment.date ?? (
                            <span className="text-zinc-400 italic">No readable date</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-4">
                          <Money cell={payment.amount} />
                        </td>
                        <td className="py-1.5 pr-3">
                          {payment.method ?? <span className="text-zinc-400">—</span>}
                        </td>
                        <td className="py-1.5 text-zinc-600 dark:text-zinc-400">
                          {payment.legacyReceiptSent ?? <span className="text-zinc-400">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <p className="mt-2 text-xs text-zinc-500">
                  {row.paymentCount} imported payment{row.paymentCount === 1 ? '' : 's'}, totalling{' '}
                  <span className="tabular-nums">{displayMoney(row.paymentTotal)}</span>.
                </p>

                {row.payments.some((payment) => payment.note !== null) ? (
                  <ul className="mt-3 space-y-1 text-xs text-zinc-500">
                    {row.payments
                      .filter((payment) => payment.note !== null)
                      .map((payment) => (
                        <li key={`${payment.id}-note`}>
                          <span className="tabular-nums">{payment.date ?? '—'}</span>:{' '}
                          {payment.note}
                        </li>
                      ))}
                  </ul>
                ) : null}
              </>
            )}
          </Section>

          <Section title="Receipts" note="No receipt has been issued by this system.">
            <div className="flex items-start gap-3">
              <ReceiptBadge summary={row.receiptSummary} />
              <p className="flex-1 text-zinc-600 dark:text-zinc-400">
                {legacyReceiptExplanation(row.receiptSummary)}
              </p>
            </div>
          </Section>

          <Section title="Reminders" note="No reminder has been sent by this system.">
            <p className="text-zinc-600 dark:text-zinc-400">
              Nothing is overdue here — no reminder has been attempted for any student yet.
            </p>
          </Section>
        </div>
      </aside>
    </div>
  )
}

function Section({
  title,
  note,
  children,
}: {
  title: string
  note: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2 text-sm">
      <div>
        <h3 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">{title}</h3>
        <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-600">{note}</p>
      </div>
      {children}
    </section>
  )
}

function Figure({
  label,
  value,
  caption,
  negative = false,
}: {
  label: string
  value: string
  caption?: string
  negative?: boolean
}) {
  return (
    <div className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd
        className={
          negative
            ? 'mt-0.5 font-medium tabular-nums text-red-700 dark:text-red-400'
            : 'mt-0.5 font-medium tabular-nums'
        }
      >
        {value}
      </dd>
      {caption ? <p className="mt-0.5 text-[11px] text-zinc-400">{caption}</p> : null}
    </div>
  )
}
