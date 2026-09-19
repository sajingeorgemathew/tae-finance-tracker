/**
 * The post-apply operator verification, as data.
 *
 * Everything else in the apply report is rendered from what the importer
 * observed. These facts are not: they are ticket acceptance steps carried out
 * by hand after the apply — the app exercised against the imported data, the
 * duplicate-import refusal deliberately provoked, the repository validation
 * commands, and the workbook re-hashed afterwards.
 *
 * They live here as a committed, typed record rather than as prose appended to
 * the generated document, so that regenerating the report reproduces the whole
 * document instead of all but its last section. A hand-edited tail is the part
 * that silently goes stale, and it is the part a reviewer is most likely to
 * trust.
 *
 * Same privacy rule as the report itself: aggregates, routes, commands and
 * hashes only. No person appears here.
 */

/** One route exercised against the imported data. */
export interface RouteObservation {
  route: string
  result: string
}

/** One repository validation command and what it reported. */
export interface ValidationObservation {
  command: string
  result: string
}

export interface OperatorVerification {
  /** When these observations were made, ISO-8601 UTC. */
  recordedAt: string
  /** The routes exercised, and what each returned. */
  routes: RouteObservation[]
  /** Notes about the route table that are not per-route facts. */
  routeNotes: string[]
  /** Validation commands run against the repository, and their results. */
  validation: ValidationObservation[]
  /** The deliberate second apply, and what the gate did with it. */
  duplicateRefusal: {
    exercised: boolean
    note: string
  }
  /** The workbook, re-hashed after everything above. */
  workbook: {
    sha256: string
    unchanged: boolean
    note: string
  }
}

export const APPLY_OPERATOR_VERIFICATION: OperatorVerification = {
  recordedAt: '2026-09-19T22:55:54.914Z',
  routes: [
    {
      route: '`/api/health`',
      result:
        '200 — `supabase: connected`; the body lists environment variable **names** and whether ' +
        'each is present, never a value',
    },
    {
      route: '`/dashboard`',
      result: '307 → `/login?redirectTo=%2Fdashboard` when unauthenticated; renders once signed in',
    },
    {
      route: '`/finance`',
      result: '307 → `/login?redirectTo=%2Ffinance` when unauthenticated; renders once signed in',
    },
    {
      route: '`/settings`',
      result: '307 → `/login?redirectTo=%2Fsettings` when unauthenticated; renders once signed in',
    },
  ],
  routeNotes: [
    'The routes were exercised unauthenticated against a development server reading the imported ' +
      'data. No route that mutates was requested, and the hosted row counts were read back ' +
      'afterwards and matched the totals above exactly.',
    '`/api/health` is development-only by design: it returns 404 under `next start`, which is the ' +
      'intended behaviour and not a regression. The 307 redirects are the correct unauthenticated ' +
      'result and are consistent with the Row Level Security checks above.',
    'No finance spreadsheet UI was built in this phase.',
  ],
  validation: [
    { command: '`npm test`', result: 'pass — 333 tests, 85 suites, 0 failures' },
    { command: '`npm run lint`', result: 'pass — no findings' },
    { command: '`npm run typecheck`', result: 'pass' },
    { command: '`npm run build`', result: 'pass — 7 routes compiled' },
  ],
  duplicateRefusal: {
    exercised: true,
    note:
      'The apply was deliberately re-run after completion. The gate stopped it on two independent ' +
      'checks — the operational tables are no longer empty, and a completed `import_batches` row ' +
      'exists for this workbook hash — and exited non-zero having written nothing. Row counts were ' +
      'unchanged afterwards. Re-confirmed read-only when this report was regenerated: exactly one ' +
      '`import_batches` row exists for this workbook hash, its status is `completed`, and a ' +
      'further apply must therefore refuse. The refusal was not provoked a second time, because ' +
      'the gate is the thing being trusted and re-running an apply to watch it stop is not free.',
  },
  workbook: {
    sha256: '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2',
    unchanged: true,
    note: 'The receipt PDF template was not opened or modified.',
  },
}
