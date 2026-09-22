/**
 * Display filtering for the finance grid.
 *
 * Every function here narrows what is *shown*. Nothing merges two students,
 * rewrites a name, or changes a stored value — a search that finds nothing
 * means the intake on screen holds no such row, not that the row is wrong.
 *
 * Three filters compose, in any order, on the rows already loaded:
 *
 *   - **session** — Morning, Evening, or all. Narrows a combined intake to one
 *     cohort without leaving the intake.
 *   - **status** — the Payment Status quick filter. It reads the very same
 *     `paymentStatus` the row badge shows; there is no second derivation.
 *   - **receipt** — the secondary filter on the *historical workbook* receipt
 *     status (`receipt-status.ts`). Not a payment status, and not a statement
 *     about any receipt this system issued.
 *   - **search** — student number or name, substring, case-insensitive.
 *
 * Pure and client-safe: the grid filters the rows it already has rather than
 * asking the server again, so typing in the search box does not re-query an
 * intake that is already loaded.
 */

import type { Session } from './intake.ts'
import { isPaymentStatus, type PaymentStatus } from './payment-status.ts'
import type { LegacyReceiptStatus } from './receipt-status.ts'
import type { FinanceGridRow } from './types.ts'

// -----------------------------------------------------------------------------
// Session
// -----------------------------------------------------------------------------

export type SessionFilter = 'all' | 'morning' | 'evening'

export const SESSION_FILTERS: readonly SessionFilter[] = ['all', 'morning', 'evening']

export function isSessionFilter(value: string | null | undefined): value is SessionFilter {
  return SESSION_FILTERS.includes(value as SessionFilter)
}

/** The URL form of a session, for the `?session=` parameter. */
export function sessionFilterOf(session: Session | null): SessionFilter {
  return session === 'Morning' ? 'morning' : session === 'Evening' ? 'evening' : 'all'
}

export function sessionFilterLabel(filter: SessionFilter): string {
  switch (filter) {
    case 'all':
      return 'All'
    case 'morning':
      return 'Morning'
    case 'evening':
      return 'Evening'
  }
}

export function matchesSession(row: FinanceGridRow, filter: SessionFilter): boolean {
  if (filter === 'all') return true
  return sessionFilterOf(row.session) === filter
}

// -----------------------------------------------------------------------------
// Payment status
// -----------------------------------------------------------------------------

export type StatusFilter = 'all' | PaymentStatus

export const STATUS_FILTERS: readonly StatusFilter[] = [
  'all',
  'outstanding',
  'settled',
  'credit',
  'unknown',
]

export function isStatusFilter(value: string | null | undefined): value is StatusFilter {
  return value === 'all' || isPaymentStatus(value)
}

/**
 * The GRID-03 `?filter=` values, mapped onto the status filter that means the
 * same thing, so an old bookmark still narrows the grid as it used to. The
 * legacy receipt filter is not a payment status: it maps to "all" here and to
 * the receipt filter's compatibility value in `receiptFilterFromLegacy`.
 */
export function statusFilterFromLegacy(value: string | null | undefined): StatusFilter | null {
  switch (value) {
    case 'balance_due':
      return 'outstanding'
    case 'settled':
      return 'settled'
    case 'no_balance':
      return 'unknown'
    case 'all':
    case 'legacy_receipt_gap':
      return 'all'
    default:
      return null
  }
}

/** Reads the row's own status. The badge reads the same field; nothing is re-derived. */
export function matchesStatus(row: FinanceGridRow, filter: StatusFilter): boolean {
  return filter === 'all' || row.paymentStatus === filter
}

// -----------------------------------------------------------------------------
// Legacy receipt status
// -----------------------------------------------------------------------------

/**
 * `gap` is the GRID-03 "Legacy receipt not sent" filter kept alive: it meant
 * *Not sent or Mixed* — every record whose workbook receipt values include a
 * "no" — and no single status expresses that. It is a legal `?receipt=` value
 * so an old link survives refresh and history, but it is not one of the
 * pills; it is shown only while it is the active filter.
 */
export const RECEIPT_GAP = 'gap' as const

export type ReceiptFilter = 'all' | LegacyReceiptStatus | typeof RECEIPT_GAP

/** The pills the filter bar always offers. `gap` is deliberately not among them. */
export const RECEIPT_FILTERS: readonly ReceiptFilter[] = [
  'all',
  'sent',
  'mixed',
  'not_sent',
  'unknown',
]

export function isReceiptFilter(value: string | null | undefined): value is ReceiptFilter {
  return value === RECEIPT_GAP || RECEIPT_FILTERS.includes(value as ReceiptFilter)
}

/** The GRID-03 `?filter=legacy_receipt_gap`, as the receipt filter that keeps its meaning. */
export function receiptFilterFromLegacy(value: string | null | undefined): ReceiptFilter | null {
  return value === 'legacy_receipt_gap' ? RECEIPT_GAP : null
}

export function receiptFilterLabel(filter: ReceiptFilter): string {
  switch (filter) {
    case 'all':
      return 'All'
    case 'sent':
      return 'Sent'
    case 'mixed':
      return 'Mixed'
    case 'not_sent':
      return 'Not sent'
    case 'unknown':
      return 'Unknown'
    case RECEIPT_GAP:
      return 'Not sent or Mixed'
  }
}

/** Reads the row's own historical receipt status, exactly as its Receipt cell shows it. */
export function matchesReceipt(row: FinanceGridRow, filter: ReceiptFilter): boolean {
  if (filter === 'all') return true
  if (filter === RECEIPT_GAP) return row.receiptStatus === 'not_sent' || row.receiptStatus === 'mixed'
  return row.receiptStatus === filter
}

export type ReceiptCounts = Record<LegacyReceiptStatus, number>

export function countReceiptStatuses(rows: readonly FinanceGridRow[]): ReceiptCounts {
  const counts: ReceiptCounts = { sent: 0, mixed: 0, not_sent: 0, unknown: 0 }
  for (const row of rows) counts[row.receiptStatus] += 1
  return counts
}

// -----------------------------------------------------------------------------
// Search
// -----------------------------------------------------------------------------

/**
 * Case-insensitive match on student number or name.
 *
 * Substring, not fuzzy: a staff member searching `125346` must not be shown
 * `125348` because it is close. Identity is never guessed at on this screen.
 */
export function matchesSearch(row: FinanceGridRow, term: string): boolean {
  const needle = term.trim().toLowerCase()
  if (needle === '') return true

  const number = row.studentNumber?.toLowerCase() ?? ''
  const name = row.studentName.toLowerCase()

  return number.includes(needle) || name.includes(needle)
}

// -----------------------------------------------------------------------------
// Together
// -----------------------------------------------------------------------------

export interface GridFilters {
  search?: string
  status?: StatusFilter
  session?: SessionFilter
  receipt?: ReceiptFilter
}

/** All four filters together, preserving the intake's row order. */
export function filterRows(
  rows: readonly FinanceGridRow[],
  options: GridFilters = {},
): FinanceGridRow[] {
  const search = options.search ?? ''
  const status = options.status ?? 'all'
  const session = options.session ?? 'all'
  const receipt = options.receipt ?? 'all'

  return rows.filter(
    (row) =>
      matchesSession(row, session) &&
      matchesStatus(row, status) &&
      matchesReceipt(row, receipt) &&
      matchesSearch(row, search),
  )
}
