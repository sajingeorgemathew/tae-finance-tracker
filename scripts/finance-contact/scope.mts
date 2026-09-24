/**
 * Operational scope — configuration, not business logic.
 *
 * The project owner does not need contact completeness for students whose
 * intake started before December 2025, and does not want the newest, not yet
 * running intake imported. Both are *dates in a config object*, so a later
 * ticket enables the next intake by moving `operationalEnd` (or removing the
 * explicit exclusion) without touching a parser or the engine.
 *
 * A row's scope date is the field its adapter names (`intakeDate` for a
 * source whose tables are intakes, `sourceStartDate` for a source that dates
 * each row); the other is a fallback. A row with no date at all is kept in
 * scope and flagged, so it is reviewed rather than dropped.
 */

import type { ContactImportRow, ScopeExclusion } from './canonical.mts'

export interface ExcludedIntake {
  programCode: string
  /** ISO date the source states for the intake. */
  intakeDate: string
  note: string
}

export interface ScopeConfig {
  /** Inclusive: an intake/start date on or after this is operational. */
  operationalCutoff: string
  /** Inclusive: an intake/start date after this is an upcoming intake, not yet operational. Null = no upper bound. */
  operationalEnd: string | null
  /** Intakes excluded by explicit decision, whatever the bounds say. */
  excludedFutureIntakes: ExcludedIntake[]
}

/**
 * The 04B1 scope, as discovered from the PSW master: intakes from 1 Dec 2025
 * through August 2026 are the established roster; the September 2026 sheet is
 * the upcoming intake the owner has not approved for import.
 */
export const DEFAULT_SCOPE_CONFIG: ScopeConfig = {
  operationalCutoff: '2025-12-01',
  operationalEnd: '2026-08-31',
  excludedFutureIntakes: [
    {
      programCode: 'PSW',
      intakeDate: '2026-09-28',
      note: 'upcoming intake; the owner has not approved importing it yet (FINANCE-CONTACT-04B1 §6)',
    },
  ],
}

export type ScopeDateField = 'intakeDate' | 'sourceStartDate'

export interface ScopeDecision {
  inOperationalScope: boolean
  exclusionReason: ScopeExclusion | null
  /** The date the decision was made on, or null when the row states none. */
  scopeDate: string | null
  dateUnknown: boolean
}

export function decideScope(
  row: Pick<ContactImportRow, 'programCode' | 'intakeDate' | 'sourceStartDate'>,
  primaryField: ScopeDateField,
  config: ScopeConfig,
): ScopeDecision {
  const fallback: ScopeDateField = primaryField === 'intakeDate' ? 'sourceStartDate' : 'intakeDate'
  const scopeDate = row[primaryField] ?? row[fallback] ?? null

  if (scopeDate === null) {
    return { inOperationalScope: true, exclusionReason: null, scopeDate: null, dateUnknown: true }
  }

  const explicitlyExcluded = config.excludedFutureIntakes.some(
    (intake) => intake.programCode === row.programCode && intake.intakeDate === (row.intakeDate ?? scopeDate),
  )
  if (explicitlyExcluded) {
    return { inOperationalScope: false, exclusionReason: 'OUT_OF_SCOPE_FUTURE', scopeDate, dateUnknown: false }
  }
  if (scopeDate < config.operationalCutoff) {
    return { inOperationalScope: false, exclusionReason: 'OUT_OF_SCOPE_HISTORICAL', scopeDate, dateUnknown: false }
  }
  if (config.operationalEnd !== null && scopeDate > config.operationalEnd) {
    return { inOperationalScope: false, exclusionReason: 'OUT_OF_SCOPE_FUTURE', scopeDate, dateUnknown: false }
  }
  return { inOperationalScope: true, exclusionReason: null, scopeDate, dateUnknown: false }
}

export interface ScopeCounts {
  operational: number
  historical: number
  future: number
  dateUnknown: number
}

/** Applies the scope to every row in place and returns the tally. */
export function applyScope(
  rows: ContactImportRow[],
  primaryField: ScopeDateField,
  config: ScopeConfig,
): { counts: ScopeCounts; dateUnknownRowIds: string[] } {
  const counts: ScopeCounts = { operational: 0, historical: 0, future: 0, dateUnknown: 0 }
  const dateUnknownRowIds: string[] = []
  for (const row of rows) {
    const decision = decideScope(row, primaryField, config)
    row.inOperationalScope = decision.inOperationalScope
    row.exclusionReason = decision.exclusionReason
    if (decision.dateUnknown) {
      counts.dateUnknown += 1
      dateUnknownRowIds.push(row.stagedRowId)
    }
    if (decision.exclusionReason === 'OUT_OF_SCOPE_HISTORICAL') counts.historical += 1
    else if (decision.exclusionReason === 'OUT_OF_SCOPE_FUTURE') counts.future += 1
    else counts.operational += 1
  }
  return { counts, dateUnknownRowIds }
}
