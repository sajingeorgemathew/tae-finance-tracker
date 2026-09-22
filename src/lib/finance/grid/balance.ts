/**
 * Deciding, per batch, whether "Balance Due" can honestly be filtered on.
 *
 * `legacy_balance` is a snapshot of one workbook cell. On most batch sheets
 * that cell is an unheaded column holding `Total Paid − Total Fee`, and on
 * others it is a headed `Outstanding` or `Balance` column. Nothing guaranteed
 * those agree on which direction means "still owing", and the import
 * deliberately did not normalise them.
 *
 * So the sign convention is not assumed — it is *verified against the batch
 * being displayed*, every time. A batch qualifies only when at least one of its
 * records states all three figures and every such record satisfies
 * `balance = paid − fee`. Under that convention a negative balance is money
 * still owed and a positive one is an overpayment.
 *
 * When the batch cannot be verified — because no record states all three, or
 * because one of them disagrees — the filter is switched off and says why,
 * rather than quietly filtering on a guess. That is the ticket's instruction:
 * do not fake a status.
 *
 * Nothing here writes a balance back, and a record's displayed balance is
 * always its own stored snapshot, never a figure computed here.
 */

import { amountOf, type MoneyCell } from './money.ts'

/** Tolerance for the comparison, in dollars. Half a cent. */
const EPSILON = 0.005

/** Whether a batch's balances can be read as "negative means owing". */
export type BalanceConvention =
  /** Verified: every record stating all three has `balance = paid − fee`. */
  | 'paid_minus_fee'
  /** No record in the batch states fee, paid and balance together. */
  | 'unverifiable'
  /** At least one record contradicts the convention. */
  | 'inconsistent'

export interface BalanceConventionResult {
  convention: BalanceConvention
  /** Records that could be checked. */
  checked: number
  /** Of those, how many disagreed. */
  disagreeing: number
  /**
   * Whether the convention is verified, so a row's sign can be read as a
   * Payment Status. The quick filters are always offered (Unknown is a real
   * answer); this now only feeds the summary strip's wording.
   */
  filterable: boolean
  /** Staff-facing sentence. Never blames a value for being wrong. */
  note: string
}

export interface BalanceFigures {
  fee: MoneyCell
  paid: MoneyCell
  balance: MoneyCell
}

/**
 * Checks the batch's own records for a consistent balance convention.
 *
 * Deliberately whole-batch: one sheet's convention says nothing about another's,
 * and the grid only ever shows one batch at a time.
 */
export function resolveBalanceConvention(
  records: readonly BalanceFigures[],
): BalanceConventionResult {
  let checked = 0
  let disagreeing = 0

  for (const record of records) {
    const fee = amountOf(record.fee)
    const paid = amountOf(record.paid)
    const balance = amountOf(record.balance)
    if (fee === null || paid === null || balance === null) continue

    checked += 1
    if (Math.abs(paid - fee - balance) > EPSILON) disagreeing += 1
  }

  if (checked === 0) {
    return {
      convention: 'unverifiable',
      checked,
      disagreeing,
      filterable: false,
      note:
        'No student in this batch records a total fee, a total paid and a balance together, ' +
        'so which direction means "still owing" cannot be established from the batch itself. ' +
        'Every row here shows Payment Status Unknown; nothing has been calculated to fill it in.',
    }
  }

  if (disagreeing > 0) {
    return {
      convention: 'inconsistent',
      checked,
      disagreeing,
      filterable: false,
      note:
        `${disagreeing} of ${checked} students in this batch record a balance that does not ` +
        'follow the same arithmetic as the rest, so the historical figures are shown as recorded ' +
        'and every row here shows Payment Status Unknown.',
    }
  }

  return {
    convention: 'paid_minus_fee',
    checked,
    disagreeing,
    filterable: true,
    note:
      `Verified across ${checked} student${checked === 1 ? '' : 's'} in this batch: the recorded ` +
      'balance is total paid minus total fee, so a negative balance is money still owed.',
  }
}

/** Where one record sits, under a verified convention. */
export type BalanceState =
  /** Negative balance: money still owed. */
  | 'due'
  /** Exactly zero. */
  | 'settled'
  /** Positive balance: paid more than the recorded fee. */
  | 'credit'
  /** No balance figure was recorded, or the batch convention is unverified. */
  | 'unknown'

/**
 * A record's balance state.
 *
 * Returns `unknown` whenever the convention is unverified, so a row can never
 * be labelled "Balance due" on the strength of a sign nobody confirmed.
 */
export function balanceStateOf(
  balance: MoneyCell,
  convention: BalanceConvention,
): BalanceState {
  if (convention !== 'paid_minus_fee') return 'unknown'

  const amount = amountOf(balance)
  if (amount === null) return 'unknown'
  if (amount < -EPSILON) return 'due'
  if (amount > EPSILON) return 'credit'
  return 'settled'
}

/** Short staff-facing label for a balance state. */
export function balanceStateLabel(state: BalanceState): string {
  switch (state) {
    case 'due':
      return 'Balance due'
    case 'settled':
      return 'Settled'
    case 'credit':
      return 'Overpaid'
    case 'unknown':
      return 'Not recorded'
  }
}
