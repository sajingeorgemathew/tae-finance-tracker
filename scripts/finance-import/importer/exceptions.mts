/**
 * Import exceptions — the third option for a row that cannot be normalized.
 *
 * A source row that will not fit the schema has three possible fates, and two
 * of them are unacceptable: inventing a value so it fits, or dropping it. An
 * exception is the third. The row is preserved exactly as the workbook holds
 * it, with the reason it could not become a normalized record.
 *
 * The case this ships for: one Tracker Master row records a payment with no
 * amount. `payments.amount` is NOT NULL and no zero may be invented, so the row
 * becomes an exception rather than a payment. The money is not asserted and the
 * history is not lost.
 *
 * This is also what lets READY_FOR_APPLY be true honestly. "No silent dropping"
 * is satisfied by a row having *a destination* — either a normalized entity or
 * a deliberate exception — not by every row becoming a payment.
 */

import { importExceptionSourceKey } from './source-keys.mts'

/** Reasons a row is preserved rather than normalized. */
export type ExceptionReason =
  /** The source states no amount and `payments.amount` is NOT NULL. */
  | 'missing_amount'
  /** No canonical program could be resolved, and none may be guessed. */
  | 'unresolved_program'
  /** The row belongs to a program deferred by an approved rule. */
  | 'deferred_program_configuration'
  /** A scheduled-installment cell holds a spreadsheet error. */
  | 'installment_error_cell'

/** The entity the row would have become, had it been normalizable. */
export type ExceptionEntityType = 'payment' | 'student' | 'installment' | 'student_finance_record'

export interface PlannedImportException {
  /** Deterministic key, in its own key space. */
  sourceKey: string
  sourceFilename: string
  sourceSheet: string
  sourceRow: number | null
  sourceColumn: string | null
  entityType: ExceptionEntityType
  reason: ExceptionReason
  /** The source row, verbatim. NOT NULL in the schema, and never empty here. */
  legacyRawJson: Record<string, unknown>
}

export interface BuildExceptionInput {
  workbookHash: string
  sourceFilename: string
  sourceSheet: string
  sourceRow: number | null
  sourceColumn?: string | null
  entityType: ExceptionEntityType
  reason: ExceptionReason
  /** Why this row could not be normalized, in plain language. */
  note: string
  /** The preserved source data. */
  legacyRawJson: Record<string, unknown>
  /** The key the entity would have had, recorded for traceability. */
  wouldBeEntitySourceKey?: string | null
}

/**
 * Builds one planned exception.
 *
 * The preserved payload always carries the reason, the note and the source
 * location alongside the row itself, so the record explains itself without
 * anyone having to re-open the workbook to understand it.
 */
export function buildImportException(input: BuildExceptionInput): PlannedImportException {
  const sourceColumn = input.sourceColumn ?? null

  const sourceKey = importExceptionSourceKey(
    input.workbookHash,
    input.entityType,
    input.sourceSheet,
    input.sourceRow,
    sourceColumn,
  )

  return {
    sourceKey,
    sourceFilename: input.sourceFilename,
    sourceSheet: input.sourceSheet,
    sourceRow: input.sourceRow,
    sourceColumn,
    entityType: input.entityType,
    reason: input.reason,
    legacyRawJson: {
      source_key: sourceKey,
      reason: input.reason,
      note: input.note,
      entity_type: input.entityType,
      sheet: input.sourceSheet,
      row: input.sourceRow,
      column: sourceColumn,
      would_be_entity_source_key: input.wouldBeEntitySourceKey ?? null,
      preserved_because:
        'the row could not become a normalized record without inventing a value; ' +
        'it is preserved here rather than dropped',
      source: input.legacyRawJson,
    },
  }
}

/** Exception counts by reason, for the report. */
export function tallyExceptionReasons(
  exceptions: readonly PlannedImportException[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const exception of exceptions) {
    counts[exception.reason] = (counts[exception.reason] ?? 0) + 1
  }
  return counts
}
