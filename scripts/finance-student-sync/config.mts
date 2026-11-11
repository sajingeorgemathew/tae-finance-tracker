/**
 * FINANCE-STUDENT-SYNC-05B — which live cohorts a sync may look at.
 *
 * Program- and batch-generic: a scope is a list of (program, cohort month)
 * pairs, resolved against hosted batches by their sheet month (batch name as
 * fallback). Adding a cohort or a program later is a new entry here, not new
 * code. Students outside the chosen scope are never compared or written.
 */

import type { ScopeCohort } from './reconcile.mts'

export interface SyncScope {
  id: string
  cohorts: ScopeCohort[]
  /** Students per cohort the run must find on hosted, or it stops. Omit to skip the check. */
  expectedStudents?: Record<string, number>
}

export const SYNC_SCOPES: Readonly<Record<string, SyncScope>> = {
  'psw-live-2026': {
    id: 'psw-live-2026',
    cohorts: [
      { id: 'PSW-2026-06', label: 'PSW June 2026', programShortCode: 'PSW', yearMonth: '2026-06' },
      { id: 'PSW-2026-08', label: 'PSW August 2026', programShortCode: 'PSW', yearMonth: '2026-08' },
      { id: 'PSW-2026-09', label: 'PSW September 2026', programShortCode: 'PSW', yearMonth: '2026-09' },
    ],
    expectedStudents: { 'PSW-2026-06': 28, 'PSW-2026-08': 18, 'PSW-2026-09': 16 },
  },
}

export const DEFAULT_SCOPE_ID = 'psw-live-2026'

/** Drop the current student file here (Git-ignored), or pass --source=<path>. */
export const DEFAULT_SOURCE_DIR = 'reference/current-students'

export const PRIVATE_DIR = '.private/finance-student-sync'
