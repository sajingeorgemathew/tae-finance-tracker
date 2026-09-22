'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useTransition } from 'react'

import { StatusDot } from '@/components/finance/finance-cells'
import {
  RECEIPT_FILTERS,
  RECEIPT_GAP,
  SESSION_FILTERS,
  STATUS_FILTERS,
  receiptFilterLabel,
  sessionFilterLabel,
  type ReceiptCounts,
  type ReceiptFilter,
  type SessionFilter,
  type StatusFilter,
} from '@/lib/finance/grid/filters'
import { UNASSIGNED_INTAKE, type FinanceIntake } from '@/lib/finance/grid/intake'
import {
  paymentStatusLabel,
  type PaymentStatusCounts,
} from '@/lib/finance/grid/payment-status'
import type { FinanceGridView } from '@/lib/finance/grid/types'
import { cn } from '@/lib/utils'

/**
 * Program, intake, session, search, the Payment Status quick filters and the
 * secondary legacy Receipt filter.
 *
 * Two different kinds of control live here, and they update the URL in two
 * different ways on purpose:
 *
 * - **Program and intake** change *which rows exist*, so they navigate. The
 *   server reloads the intake and the grid re-renders from real data.
 * - **Session, status, receipt and search** narrow rows already on the screen, so they
 *   update the URL through `window.history.replaceState` — which Next.js wires
 *   into the router without a round trip. Switching Morning to Evening, or
 *   typing a student number, therefore filters instantly and still leaves a
 *   link a colleague can open.
 *
 * Everything lands in the URL either way, so a staff member can bookmark an
 * intake, refresh without losing their place, or paste the link into a message.
 */

export interface FilterBarProps {
  view: FinanceGridView
  search: string
  onSearchChange: (value: string) => void
  status: StatusFilter
  onStatusChange: (value: StatusFilter) => void
  session: SessionFilter
  onSessionChange: (value: SessionFilter) => void
  receipt: ReceiptFilter
  onReceiptChange: (value: ReceiptFilter) => void
  /** Status counts over the rows every other filter leaves, so each pill says what it would show. */
  statusCounts: PaymentStatusCounts
  /** Likewise for the historical receipt status. */
  receiptCounts: ReceiptCounts
  /** Rows currently visible, for the result count. */
  visibleRows: number
}

export function FinanceFilterBar({
  view,
  search,
  onSearchChange,
  status,
  onStatusChange,
  session,
  onSessionChange,
  receipt,
  onReceiptChange,
  statusCounts,
  receiptCounts,
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

  // The address bar always names the program and intake on screen, even on
  // the default landing, so a copied link opens exactly this view.
  useUrlMirror({
    program: view.selectedProgram?.shortCode ?? null,
    intake: view.unassigned ? UNASSIGNED_INTAKE : (view.selectedIntake?.key ?? null),
    q: search || null,
    status: status === 'all' ? null : status,
    session: session === 'all' ? null : session,
    receipt: receipt === 'all' ? null : receipt,
    // The GRID-03 `filter=` is resolved into `status` / `receipt` above and
    // is dropped, so the address bar shows only the current form.
    filter: null,
  })

  const intake = view.selectedIntake
  const sessionsAvailable = !view.unassigned && (intake?.availableSessions.length ?? 0) > 1
  const allCount = statusCounts.outstanding + statusCounts.settled + statusCounts.credit + statusCounts.unknown
  const allReceipts = receiptCounts.sent + receiptCounts.mixed + receiptCounts.not_sent + receiptCounts.unknown
  const receiptOptions: readonly ReceiptFilter[] =
    receipt === RECEIPT_GAP ? [...RECEIPT_FILTERS, RECEIPT_GAP] : RECEIPT_FILTERS

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Program" htmlFor="finance-program">
          <select
            id="finance-program"
            className={SELECT_CLASS}
            value={view.selectedProgram?.shortCode ?? ''}
            onChange={(event) =>
              // Changing program invalidates the intake and everything that
              // narrowed it: the intakes belong to the old program. Dropping
              // them lets the server pick this program's default.
              navigate({
                program: event.target.value,
                intake: null,
                batch: null,
                session: null,
                q: null,
              })
            }
          >
            {view.programs.map((program) => (
              <option key={program.id} value={program.shortCode}>
                {program.shortCode} — {program.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Intake" htmlFor="finance-intake">
          <select
            id="finance-intake"
            className={cn(SELECT_CLASS, 'min-w-72')}
            value={view.unassigned ? UNASSIGNED_INTAKE : (intake?.key ?? '')}
            onChange={(event) =>
              navigate({ intake: event.target.value, batch: null, session: null, q: null })
            }
          >
            {view.intakes.map((option) => (
              <option key={option.key} value={option.key}>
                {intakeLabel(option)}
              </option>
            ))}
            {view.unassignedCount > 0 ? (
              <option value={UNASSIGNED_INTAKE}>
                Unassigned — no batch ({view.unassignedCount})
              </option>
            ) : null}
          </select>
        </Field>

        {sessionsAvailable ? (
          <Field label="Session" htmlFor="finance-session">
            <div
              id="finance-session"
              role="group"
              aria-label="Session"
              className="inline-flex rounded-md border border-zinc-300 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-950"
            >
              {SESSION_FILTERS.map((option) => {
                const count =
                  option === 'all'
                    ? view.sessionCounts.Morning + view.sessionCounts.Evening
                    : option === 'morning'
                      ? view.sessionCounts.Morning
                      : view.sessionCounts.Evening
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={session === option}
                    onClick={() => onSessionChange(option)}
                    className={cn(
                      'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                      session === option
                        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                        : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900',
                    )}
                  >
                    {sessionFilterLabel(option)}{' '}
                    <span
                      className={cn(
                        'tabular-nums',
                        session === option ? 'opacity-70' : 'text-zinc-400 dark:text-zinc-500',
                      )}
                    >
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>
          </Field>
        ) : null}

        <Field label="Search student" htmlFor="finance-search">
          <input
            id="finance-search"
            type="search"
            inputMode="search"
            autoComplete="off"
            placeholder="Student number or name"
            className={cn(SELECT_CLASS, 'w-60')}
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
        <span className="sr-only" id="finance-status-label">
          Payment status
        </span>
        <div
          role="group"
          aria-labelledby="finance-status-label"
          className="flex flex-wrap gap-1.5"
        >
          {STATUS_FILTERS.map((option) => {
            const count = option === 'all' ? allCount : statusCounts[option]
            const active = status === option
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                data-status-filter={option}
                onClick={() => onStatusChange(option)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                  active
                    ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                    : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900',
                )}
              >
                {option === 'all' ? null : <StatusDot status={option} />}
                {option === 'all' ? 'All' : paymentStatusLabel(option)}{' '}
                <span className={cn('tabular-nums', active ? 'opacity-70' : 'text-zinc-400 dark:text-zinc-500')}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        {/*
          Secondary, and deliberately quieter than Payment Status: this is the
          workbook's own receipt record, not a payment status and not a
          receipt this system issued. "Sent" here never blocks the receipt
          workflow from issuing a real one later.
        */}
        <span className="sr-only" id="finance-receipt-label">
          Legacy receipt status
        </span>
        <div
          role="group"
          aria-labelledby="finance-receipt-label"
          title="Historical workbook receipt status. Not a payment status, and no receipt has been issued by this system."
          className="flex flex-wrap items-center gap-1.5 border-l border-zinc-200 pl-3 dark:border-zinc-800"
        >
          <span className="text-[11px] text-zinc-500">
            Receipt <span className="text-zinc-400 uppercase dark:text-zinc-500">legacy</span>
          </span>
          {/*
            The GRID-03 "Legacy receipt not sent" link meant Not sent *or*
            Mixed. That is honoured as a compatibility value which appears as
            a pill only while it is active; choosing any normal pill drops it.
          */}
          {receiptOptions.map((option) => {
            const count =
              option === 'all'
                ? allReceipts
                : option === RECEIPT_GAP
                  ? receiptCounts.not_sent + receiptCounts.mixed
                  : receiptCounts[option]
            const active = receipt === option
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                data-receipt-filter={option}
                title={
                  option === RECEIPT_GAP
                    ? 'From an older link: rows whose historical receipt status is Not sent or Mixed.'
                    : undefined
                }
                onClick={() => onReceiptChange(option)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
                  active
                    ? 'border-zinc-700 bg-zinc-700 text-white dark:border-zinc-300 dark:bg-zinc-300 dark:text-zinc-900'
                    : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900',
                )}
              >
                {receiptFilterLabel(option)}{' '}
                <span className={cn('tabular-nums', active ? 'opacity-70' : 'text-zinc-400 dark:text-zinc-500')}>
                  {count}
                </span>
              </button>
            )
          })}
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

/**
 * An intake's line in the selector.
 *
 * The label the grouping derived, the student count, and which cohorts it
 * holds. An intake with no recorded start date says so rather than being
 * given one — the label already shows only what the source stated.
 */
export function intakeLabel(intake: FinanceIntake): string {
  const count = `${intake.studentCount} student${intake.studentCount === 1 ? '' : 's'}`
  const cohorts =
    intake.availableSessions.length === 2
      ? 'Morning + Evening'
      : intake.availableSessions.length === 1
        ? `${intake.availableSessions[0]} only`
        : null
  const dating = intake.datePrecision === 'day' ? null : 'no start date recorded'

  return [`${intake.displayName} — ${count}`, cohorts, dating].filter(Boolean).join(' · ')
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
