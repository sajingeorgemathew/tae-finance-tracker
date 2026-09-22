# lib/finance

Server-side finance data access. Every module that reaches the database imports
`server-only` and uses the request-scoped Supabase client, so reads run with the
signed-in user's own privileges and Row Level Security is the authorization
boundary. Nothing here touches the service-role key.

The exception is `grid/`, which is mostly *pure*: it turns rows into a view
model and carries no `server-only` import, so the same rules run in the builder,
in a Client Component and in a test. Only `grid/load.ts` queries.

| Module | Contents |
| --- | --- |
| `query.ts` | Shared paging, search escaping and error handling. Driver errors are logged, never returned. |
| `programs.ts` | Program configuration reads. Programs are admin-write; no write helper exists yet. |
| `batches.ts` | Batch reads, including lookup by legacy worksheet name. |
| `students.ts` | Student reads, search, and `studentDisplayName()`. |
| `finance-records.ts` | Finance records with student/program/batch attached, plus a head count. |
| `notes.ts` | Pure note resolution: `effectiveNote()` and `defaultNoteFor()`. No database access. |
| `grid/` | The Finance Tracker view model — see below and `docs/FINANCE-GRID-03.md`. |

### `grid/`

| Module | Contents |
| --- | --- |
| `load.ts` | The only module here that queries. Seven bounded requests per render for any intake (six for Unassigned) — records and manifests for every underlying batch in one `in (...)` each; no query per batch or per student. Maps old `?batch=` links to their intake. |
| `intake.ts` | Groups a Morning and an Evening batch into one intake on their shared `legacy_sheet_name` — deterministic, never a name match. Labels, keys, ordering, default and stale-link resolution. See `docs/FINANCE-GRID-03C-USABILITY.md`. |
| `intake-grid.ts` | Places the underlying batches' grids side by side: unions the manifests in source order, re-keys cells, leaves a cell blank where a row's own table had no such column, sums snapshots once, and reports per-batch conventions and status counts. |
| `view-model.ts` | Builds one batch's grid from plain row shapes. Pure, and the single place the historical-vs-normalized rules live. Column *structure* comes from the manifest; cell *values* from the rows. Rows carry their real `batchId`, `session` and `paymentStatus`. |
| `payment-status.ts` | Outstanding / Settled / Credit / Unknown, derived once from the imported balance under the batch's verified sign convention. Never from payments, `fee − paid` or Tracker Master's Balance Fees. |
| `selection.ts` | Row selection keyed on `financeRecordId`; select-all acts on the visible rows only. Pure. |
| `manifest.ts` | Resolves `batch_finance_columns` rows into columns: label from the verbatim heading, role and kind as metadata, hidden columns kept for accounting and dropped before the browser. See `docs/FINANCE-COLUMN-MANIFEST-03A.md`. |
| `legacy-cells.ts` | Reads a record's preserved `legacy_raw_json` cells by column letter, and derives columns from row data where a batch has no manifest. |
| `money.ts` | `MoneyCell` and CAD formatting. A blank is never `$0.00`. |
| `balance.ts` | Verifies a batch's balance sign convention before any balance filter is offered. |
| `receipt-status.ts` | Historical receipt status from the workbook's own `Receipt Sent` values. |
| `filters.ts` | Display-only session, Payment Status, legacy receipt and search filters, and the mapping of GRID-03 `?filter=` values. Pure, client-safe. |
| `student-name.ts` | The one name-resolution chain, re-exported by `students.ts`. |
| `types.ts` | The view model — the only finance shape a browser ever sees. |

Two rules this directory exists to enforce:

1. **Legacy values are never recomputed.** `legacy_*` columns are what the
   workbook said. A calculated figure is a separate, separately-labelled number.
2. **Notes resolve to `custom_note ?? default_note`.** Read them through
   `effectiveNote()`; never render `custom_note` directly.
3. **A column exists because the manifest says so; a cell has a value because
   the row says so.** Where the two meet with no value, the cell is blank and
   never `$0.00`. No placeholder is written back to make the shape come out.

Not here yet, by ticket scope: receipt numbering and PDF generation
(FINANCE-RECEIPTS), workbook import (FINANCE-IMPORT-02), email delivery, and any
generic CRUD surface. Write paths arrive with the screens that need them.
