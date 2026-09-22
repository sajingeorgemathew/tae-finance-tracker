# components/finance

The Finance Tracker UI — the Excel-style grid, its filters, the summary strip
and the student details drawer. See `docs/FINANCE-GRID-03.md` for the grid and
`docs/FINANCE-GRID-03C-USABILITY.md` for the intake grouping, Payment Status
and the operational layout.

| File | Role |
| --- | --- |
| `finance-tracker.tsx` | Workspace. Owns search, the session and status filters, row selection and which row the drawer shows. |
| `finance-filter-bar.tsx` | Program, intake, session, search, the Payment Status quick filters and the secondary legacy Receipt filter, plus all URL-state handling. |
| `finance-grid.tsx` | The grid itself: grouped headers, frozen operational columns, row selection. |
| `finance-detail-drawer.tsx` | One student's placement (intake, real batch, session, status), snapshot, schedule and imported transactions. |
| `finance-summary-strip.tsx` | Intake-level status counts and historical totals. |
| `finance-cells.tsx` | Shared money, legacy-marker, payment-status, session, receipt and reminder cells — and the one status colour system. |

The grid is a plain `<table>` with a small explicit column model; grouped
headers and frozen columns are built by hand, and selection is the pure
`src/lib/finance/grid/selection.ts`. `@tanstack/react-table` and
`@tanstack/react-virtual` are installed and not used here: the largest intake
is 41 rows, and virtualising it would risk the sticky header and frozen
columns for no gain.

Everything here is read-only. No server action is imported by any of these
components, and the receipt and reminder controls are disabled rather than
wired to a placeholder handler.

The view model they render is built server-side in `src/lib/finance/grid/`; no
database row or `legacy_raw_json` payload reaches the browser.

Column *structure* — which ACTUAL and INSTALLMENT columns an intake has, their
order and headings — comes from the underlying batches' column manifests
(`batch_finance_columns`, FINANCE-COLUMN-MANIFEST-03A), unioned per intake by
`intake-grid.ts`. The grid renders every visible column whether or not any row
fills it, so a month nobody paid in is a column of em dashes, as it was in
Excel, and a column only one cohort's table has is blank for the other
cohort's rows. Headings right-align by the column's `valueKind`, never by
guessing from its key.

Frozen columns: the STUDENT trio (checkbox, Student #, Student name) at every
width; the STATUS trio (Session, Payment status, Balance) from 1280px up.
Their content is clamped to the declared widths so the sticky offsets stay
exact.
