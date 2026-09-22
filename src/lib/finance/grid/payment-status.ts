/**
 * Payment Status — the operational reading of a historical balance.
 *
 * FINANCE-GRID-03C. The grid's first job is to answer "who owes money?", and a
 * column of signed figures does not answer it at a glance. Payment Status is
 * the one-word translation, and it is derived in exactly one place — here —
 * from exactly one input: the record's imported `legacy_balance`, read under
 * the sign convention GRID-03 verifies for the batch the record belongs to.
 *
 *   balance < 0  →  Outstanding   (money still owed)
 *   balance = 0  →  Settled       (nothing owed; deliberately not "Paid")
 *   balance > 0  →  Credit        (paid more than the recorded fee)
 *   no reliable balance  →  Unknown
 *
 * Unknown is a real answer. It covers a blank balance, an unparseable one, and
 * every row of a batch whose convention could not be verified — which is all
 * fifty ECEA students. Nothing here computes `fee − paid` to fill that in, and
 * Tracker Master's row-local `Balance Fees` is never read: the loader does not
 * even select it.
 *
 * Receipt status is a different question and lives in `receipt-status.ts`.
 *
 * The row badge and the quick filters both read the status this module
 * derives; neither has a rule of its own.
 */

import { balanceStateOf, type BalanceConvention, type BalanceState } from './balance.ts'
import type { MoneyCell } from './money.ts'

export type PaymentStatus = 'outstanding' | 'settled' | 'credit' | 'unknown'

/** In the order the quick filters and the summary strip show them. */
export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'outstanding',
  'settled',
  'credit',
  'unknown',
]

export function isPaymentStatus(value: string | null | undefined): value is PaymentStatus {
  return PAYMENT_STATUSES.includes(value as PaymentStatus)
}

/** The one mapping from a verified balance state to an operational status. */
export function paymentStatusFromBalanceState(state: BalanceState): PaymentStatus {
  switch (state) {
    case 'due':
      return 'outstanding'
    case 'settled':
      return 'settled'
    case 'credit':
      return 'credit'
    case 'unknown':
      return 'unknown'
  }
}

/** Status straight from a balance and its batch's convention. */
export function paymentStatusOf(balance: MoneyCell, convention: BalanceConvention): PaymentStatus {
  return paymentStatusFromBalanceState(balanceStateOf(balance, convention))
}

export function paymentStatusLabel(status: PaymentStatus): string {
  switch (status) {
    case 'outstanding':
      return 'Outstanding'
    case 'settled':
      return 'Settled'
    case 'credit':
      return 'Credit'
    case 'unknown':
      return 'Unknown'
  }
}

/**
 * Tooltip wording. Names the source, so the status reads as a fact about the
 * imported figure and never as a judgement this system made on its own.
 */
export function paymentStatusExplanation(status: PaymentStatus): string {
  switch (status) {
    case 'outstanding':
      return 'The imported batch balance is negative: money is still owed, under the sign convention verified for this batch.'
    case 'settled':
      return 'The imported batch balance is exactly zero: nothing is owed.'
    case 'credit':
      return 'The imported batch balance is positive: more was paid than the recorded fee.'
    case 'unknown':
      return 'No reliable balance is recorded for this student, so no payment status is claimed. Nothing has been calculated to fill it in.'
  }
}

export type PaymentStatusCounts = Record<PaymentStatus, number>

export function countPaymentStatuses(
  rows: readonly { paymentStatus: PaymentStatus }[],
): PaymentStatusCounts {
  const counts: PaymentStatusCounts = { outstanding: 0, settled: 0, credit: 0, unknown: 0 }
  for (const row of rows) counts[row.paymentStatus] += 1
  return counts
}
