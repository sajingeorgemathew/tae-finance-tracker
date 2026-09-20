# components/finance

The Finance Tracker UI — the Excel-style grid, its filters, the summary strip
and the student details drawer. See `docs/FINANCE-GRID-03.md`.

| File | Role |
| --- | --- |
| `finance-tracker.tsx` | Workspace. Owns search, active filter, row selection and which row the drawer shows. |
| `finance-filter-bar.tsx` | Program, batch, search and the quick filters, plus all URL-state handling. |
| `finance-grid.tsx` | The grid itself: grouped headers, frozen identity columns, row selection. |
| `finance-detail-drawer.tsx` | One student's snapshot, schedule and imported transactions. |
| `finance-summary-strip.tsx` | Batch-level historical totals. |
| `finance-cells.tsx` | Shared money, legacy-marker, receipt and reminder cells. |

Built on `@tanstack/react-table` v9, registering only `rowSelectionFeature`.
`@tanstack/react-virtual` is installed and deliberately unused: the largest
batch is 26 students, and virtualising it would risk the sticky header and
frozen columns for no gain. See §5 of the ticket doc.

Everything here is read-only. No server action is imported by any of these
components, and the receipt and reminder controls are disabled rather than
wired to a placeholder handler.

The view model they render is built server-side in `src/lib/finance/grid/`; no
database row or `legacy_raw_json` payload reaches the browser.

Column *structure* — which ACTUAL and INSTALLMENT columns a batch has, their
order and headings — comes from the batch's column manifest
(`batch_finance_columns`, FINANCE-COLUMN-MANIFEST-03A). The grid renders every
visible manifest column whether or not any row fills it, so a month nobody paid
in is a column of em dashes, as it was in Excel. Headings right-align by the
column's `valueKind`, never by guessing from its key. The summary strip states
once how many such structural blank columns the batch has.
