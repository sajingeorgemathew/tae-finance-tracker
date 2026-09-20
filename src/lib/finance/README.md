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
| `load.ts` | The only module here that queries. Five bounded requests per render; no query per student. |
| `view-model.ts` | Builds the grid from plain row shapes. Pure, and the single place the historical-vs-normalized rules live. |
| `legacy-cells.ts` | Rebuilds a batch's historical columns from preserved `legacy_raw_json` cells. |
| `money.ts` | `MoneyCell` and CAD formatting. A blank is never `$0.00`. |
| `balance.ts` | Verifies a batch's balance sign convention before any balance filter is offered. |
| `receipt-status.ts` | Historical receipt status from the workbook's own `Receipt Sent` values. |
| `select-batch.ts` | Batch ordering and the documented default-batch rule. |
| `filters.ts` | Display-only search and quick filters. Pure, client-safe. |
| `student-name.ts` | The one name-resolution chain, re-exported by `students.ts`. |
| `types.ts` | The view model — the only finance shape a browser ever sees. |

Two rules this directory exists to enforce:

1. **Legacy values are never recomputed.** `legacy_*` columns are what the
   workbook said. A calculated figure is a separate, separately-labelled number.
2. **Notes resolve to `custom_note ?? default_note`.** Read them through
   `effectiveNote()`; never render `custom_note` directly.

Not here yet, by ticket scope: receipt numbering and PDF generation
(FINANCE-RECEIPTS), workbook import (FINANCE-IMPORT-02), email delivery, and any
generic CRUD surface. Write paths arrive with the screens that need them.
