# FINANCE-GRID-03 — the Finance Tracker grid

The first staff-facing finance screen, built on the historical data imported by
[FINANCE-IMPORT-02-APPLY.md](FINANCE-IMPORT-02-APPLY.md). It follows
[FINANCE-DATA-01.md](FINANCE-DATA-01.md) for the schema and
[FINANCE-IMPORT-02-ANALYSIS.md](FINANCE-IMPORT-02-ANALYSIS.md) for what the
source workbook actually contains.

## Privacy

This document contains no student names, no student numbers, no amounts
attributable to a person, and no remarks. Column headings, batch names and
aggregate rules only.

> **Superseded in part by [FINANCE-GRID-03C](FINANCE-GRID-03C-USABILITY.md).**
> The batch selector (§4), the quick filters (§2 step 5), the column groups
> (§5), the URL parameters (§13) and the selection helper (§12) were replaced
> by intake grouping, Payment Status, the operational column layout and
> `?intake=` state. The data rules — §6–§10, §14–§16 — are unchanged and still
> govern each underlying batch.

---

## 1. Purpose

Senior staff have run this programme's finances from an Excel workbook for
years. Before any write workflow is built — payment entry, receipts, reminders —
the imported data has to be shown back to them in a form they recognise and
trust. If the web screen cannot reproduce what the workbook said, nothing built
on top of it will be believed.

So this ticket is **read-only on purpose**. It proves the import is legible. It
defines no server action, imports none, and has no mutation path of any kind.

## 2. User workflow

1. Open `/finance`. It lands on a sensible PSW batch (§4).
2. Switch program and batch from the two selectors.
3. Scan the grid: identity, the historical actual figures, the scheduled
   installment plan, receipt and reminder state — all on one row, as in Excel.
4. Search by student number or name to narrow the batch.
5. Use a quick filter (balance due, settled, balance not recorded, legacy
   receipt not sent) where the batch's own data supports it.
6. Click a student to open the details drawer: the workbook snapshot and the
   imported transactions, side by side and labelled as two different things.
7. Tick rows to build a selection. The receipt and reminder actions on that
   selection are visibly disabled and say why.

## 3. Route

`/finance` — a Server Component, `dynamic = 'force-dynamic'`.

`requireUser('/finance')` runs before any query and revalidates the JWT with the
Supabase auth server. `src/proxy.ts` also redirects unauthenticated requests,
but that is an optimistic convenience; the page's own gate is the real one.
Verified: an unauthenticated `GET /finance` returns `307 → /login?redirectTo=%2Ffinance`.

URL state: `?program=`, `?batch=`, `?q=`, `?filter=`.

## 4. Batch selection

All 23 imported batches are listed — 22 PSW and 1 ECEA — under their stored
`batches.name`. The worksheet name is never used as the batch name; several
sheets carry two batches (a Morning and an Evening table), and the two are
selectable independently.

**Six PSW batches have no `start_date`.** Their sheet titles say "December 2025"
or "March 26" and never state a full date, and the importer refused to invent
one. They are listed with the marker `· no start date` rather than being given
a plausible date.

Ordering, and the default:

1. batches with a `start_date`, most recent first;
2. then batches without one — they cannot be placed on the timeline;
3. Morning before Evening, when the name says which;
4. then by name, then by id.

Steps 3 and 4 are the documented deterministic fallback. They are not
decoration: every PSW batch is one half of a same-day Morning/Evening pair, so
the most recent date **always** ties, and a date alone can never pick a winner.

The default is the first batch under that ordering, and the page states which
rule it used — for example *"Opened on the most recent batch with a recorded
start date (2026-07-29). 2 batches share that start date; the morning cohort is
shown first."* For a program where nothing records a date, it says so and adds
that **workbook tab order is not chronological and was not used**.

A stale or unknown `?batch=` falls back to the default with an explanation
rather than rendering an empty screen — staff share links with each other.

### 4.1 The unassigned records (an addition to the ticket)

22 finance records carry `batch_id = NULL`. Tracker Master's own Batch column is
a date serial, and a date cannot distinguish the Morning cohort from the
Evening one, so where a student appeared in more than one batch table the
importer refused to guess and left the record unassigned. These hold real
payments.

A batch-scoped grid would make them permanently unreachable. They are therefore
offered as a clearly-labelled extra entry, **Unassigned — no batch**, filtered
on `batch_id IS NULL` for the selected program. It is not presented as a batch
and is never the default. This is the one thing in the screen that goes beyond
the ticket's wording, and it is flagged for review.

## 5. Grid structure

A real `<table>`, with grouped header banners:

| Group | Columns |
| --- | --- |
| Identity | selection checkbox, Student #, Student name |
| Actual fee structure (as recorded) | derived per batch — §6 |
| Installment fee structure (scheduled) | derived per batch — §7 |
| Status | Receipt, Reminder, Actions |

Built with `@tanstack/react-table` v9 (`useTable`, `tableFeatures`), registering
**only** `rowSelectionFeature`. Sorting, filtering and pagination features are
deliberately not registered: this is a historical view ordered the way the
workbook orders it, and an unregistered feature cannot reorder history by
accident.

`@tanstack/react-virtual` is installed and is **not** used. The largest batch
holds 26 students. Virtualising that buys nothing and risks the sticky header
and frozen columns, which are what make the grid readable. Correctness and
familiar table behaviour over premature virtualization, as the ticket asks.

Excel-like behaviour: sticky header, frozen Identity columns (including their
group banner, so it does not slide away on horizontal scroll), horizontal
scrolling, compact rows, right-aligned tabular-figure money, row hover. Not
card-based at any width — on a narrow screen it scrolls sideways and keeps the
table mental model.

Row order is `legacy_source_row`, so the screen reads down the sheet.

## 6. Historical actual columns — from the batch column manifest

The batch sheets' ACTUAL section was **not** imported as payments — Tracker
Master is the transaction source and importing both would count the same money
twice. Those cells survive only inside
`student_finance_records.legacy_raw_json`. The *values* come from there. The
*columns* come from the batch's column manifest, `batch_finance_columns`,
introduced by [FINANCE-COLUMN-MANIFEST-03A](FINANCE-COLUMN-MANIFEST-03A.md).

- A column exists because the manifest lists it for the batch: every column
  of the ACTUAL span of a split table, and the money-headed columns of a flat
  table (the ECEA roster), which keeps Start Date and Payee out of the money
  group. It exists whether or not any student has a value in it.
- Ordering is the manifest's `display_order`, which is spreadsheet position.
- Headings are the manifest's `source_header`, verbatim and trimmed — "Marc"
  stays "Marc". An unheaded column is labelled `Column M` rather than given a
  heading the workbook never had.
- REMARKS and Payer columns are in the manifest as `text` and hidden from the
  money grid.
- No universal month list is imposed. A batch that never had a March column
  does not get one; a batch that had one nobody paid in gets a column of em
  dashes.
- A cell is blank when the student's preserved row has no value for that
  letter. It is never `$0.00`. A recorded zero is `$0.00`.
- Safety net: a letter present in a row's cells that the manifest does not
  describe is appended as a derived column, so a value cannot be hidden by an
  incomplete manifest. A batch with no manifest at all, and the unassigned
  view, fall back to the union-of-cells derivation and say so.

The limitation this section previously recorded — that a column every student
left blank could not be recovered from row data — is resolved by the manifest.
Twenty-one such columns existed; the fifteen money ones (eight months, six
Late Fees, ECEA Balance) are displayed again, blank.

## 7. Scheduled installment group

Columns from the manifest's `installment` section; values from normalized
`installments` only — never from an ACTUAL cell.

- Labels are the manifest's `source_header` (the workbook heading). Where a
  batch has no installment manifest, the derived fallback labels from
  `legacy_column_name`, then `custom_note`, then `default_note`.
- Order is the manifest's `display_order`, which equals the installment's
  `sequence_number` — the importer assigned both by walking the INSTALLMENT
  FEE STRUCTURE section left to right. Source order, not calendar or
  alphabetical order. An installment is placed under the column at its
  sequence only when its own heading agrees; otherwise it gets a derived
  column rather than a wrong one.
- A blank source cell produced no installment row at all, so the cell is blank
  here. It is never rendered as `$0.00`, and no installment row is created to
  fill a manifest column.
- No month is turned into a date. The workbook states no year, so
  `installment_month` is null by design and stays that way.

**ECEA has zero normalized installments**, so the group is not rendered at all —
no empty banner implying columns failed to load. Its ordinal fee columns
(`Enrollment fees`, `1st Installment`, `2nd Installment`, `Late fees`) appear in
the historical actual section instead, which is where the workbook put them. No
installment structure is fabricated for it.

## 8. Historical-vs-normalized data rules

**The workbook snapshot wins, always.**

| Displayed value | Source |
| --- | --- |
| Total Fee | `legacy_total_fee` — the imported batch snapshot |
| Total Paid | `legacy_total_paid` — the imported batch snapshot |
| Balance | `legacy_balance` — the imported batch snapshot |
| Actual month/fee cells | preserved `legacy_raw_json` cells |
| Scheduled cells | normalized `installments` |
| Transaction history | normalized `payments`, in the drawer only |

Nothing is recalculated because the normalized payments add up differently.
They frequently will: a payment reached a batch record only where the student
appeared in exactly one batch table for that program, so a batch row can
legitimately show a Total Paid with no payments behind it in this system. That
is a routing outcome, and the drawer says so in those words rather than leaving
a staff member to conclude money is missing.

Tracker Master's **Balance Fees** is a row-local formula, not a student balance.
It was never mapped to `legacy_balance` by the import and is not read here — the
payments query does not even select it.

Money display is CAD throughout: `$865.00`, `$1,000.00`, `-$900.00`. Negatives
are shown as recorded and coloured, never hidden or sign-flipped. A blank
renders as an em dash and never as `$0.00`; a recorded zero renders as `$0.00`.
Formatting is hand-rolled rather than `Intl.NumberFormat`, so a figure looks
identical in a test, a server render and a browser across ICU versions.

## 9. Receipt historical status rule

`receipts` holds zero rows. That is a fact about this system, not about a
student, so the grid never says "Receipt not sent" on the strength of it.

Row status is derived from the `Receipt Sent` value preserved on each of that
record's payments (extracted by the query as `legacy_raw_json ->> 'receipt_sent'`).
The workbook holds `YES` ×1005, `NO` ×4 and blank ×5.

| Stated values | Status |
| --- | --- |
| all `YES` | Legacy receipt: **Sent** |
| both `YES` and `NO` | Legacy receipt: **Mixed** |
| all `NO` | Legacy receipt: **Not sent** |
| none stated, or no payments | Legacy receipt: **Unknown** |
| anything unrecognised | **Mixed** — never guessed in either direction |

Blanks are ignored when deciding, not counted against the student, and are
reported in the tooltip (`4 of 5 imported payments recorded a value; 1 left it
blank`). Every label is prefixed "Legacy receipt", so nothing reads as a claim
about a receipt this system issued. No receipt row, number or delivery is
created anywhere in this ticket.

## 10. Summary calculation rule

The strip sums **only the selected batch's own imported snapshots**:
`legacy_total_fee`, `legacy_total_paid`, `legacy_balance`. Normalized payments
are deliberately excluded — they are another view of the same historical money,
and adding them would state it twice.

Where students recorded no figure, the count is shown beside the total
(`3 students recorded no figure`), because a sum over 8 of 11 students is a
different fact from a sum over all 11. A column no student filled in totals to
a blank, not `$0.00`. The strip is labelled *"Historical totals, summed from
this batch's imported workbook figures only."*

If a query hits its row cap, the strip says the figures may not cover every
student rather than presenting a partial total as complete.

## 11. Details drawer

Opened by clicking a student name or **View details**. Escape closes it; focus
moves into the panel on open.

Shows: name, student number (or "No student number"), program, batch; the
historical snapshot (total fee, total paid, balance, with its balance state);
scheduled installments where they exist; the imported transactions (date,
amount, method, the workbook's own receipt-sent text, staff remarks); the
historical receipt summary; and the reminder state.

No raw JSON reaches it. A payment contributes six fields; its source keys,
routing notes, workbook formulas, row numbers and the Balance Fees cell stay on
the server. Nothing in the drawer is editable.

## 12. Row selection

Checkbox per row, plus select-all-visible with a correct indeterminate state,
keyed on `financeRecordId` so a selection cannot migrate to another student
when rows re-render. A floating bar appears with the count.

The **Receipt** and **Reminder** buttons on that bar, and on each row, are
`disabled` with an explanatory tooltip ("Receipt sending will be enabled in the
receipt workflow."). They are not wired to a no-op handler. This is groundwork
for the bulk workflows only.

## 13. URL state

| Param | Meaning | How it updates |
| --- | --- | --- |
| `program` | program short code, e.g. `PSW` | `router.push` — the rows change |
| `batch` | batch uuid, or `unassigned` | `router.push` — the rows change |
| `q` | search term | `window.history.replaceState` — no round trip |
| `filter` | active quick filter | `window.history.replaceState` |

Search and the quick filters narrow rows already on the screen, so they use the
native History API, which Next.js wires into the router. Typing filters
instantly, the address bar stays in step, and the server is not re-queried per
keystroke. Program and batch genuinely change which rows exist, so they
navigate; changing program also clears `batch`, because the old batch belongs to
the old program.

Only a student number or name the user deliberately typed reaches the URL.
Nothing is written to local or session storage.

## 14. Supabase query strategy

Seven requests per render, independent of batch size:

1. `programs` — active, ordered by short code.
2. `batches` — active.
3. `student_finance_records` → `batch_id, program_id` for every record, tallied
   in memory for the per-batch student counts. One request instead of 23
   `count` requests to fill one dropdown.
4. the selected batch's `student_finance_records`, with `students` embedded via
   PostgREST — not a lookup per row — and, in parallel,
5. the selected batch's `batch_finance_columns` (layout fields only; the
   workbook hash and legacy identifiers never leave the database). Skipped for
   the unassigned view, which has no batch.
6. and 7. `installments` and `payments` for those record ids, in parallel, each
   with a single `in (...)`.

No query is issued per student anywhere, and one manifest query serves the
whole batch. A batch of 30 costs the same round trips as a batch of 3.

The payments select projects one JSON key —
`legacy_receipt_sent:legacy_raw_json->>receipt_sent` — so the database extracts
it and the rest of the payload never crosses the wire.

Caps: 500 finance records, 500 manifest rows, 2000 installments, 2000 payments,
5000 tally rows.
Reaching one sets `truncated`, which the summary strip surfaces rather than
silently trimming rows off the bottom.

## 15. RLS and security

- The **request-scoped** Supabase client only, carrying the signed-in user's
  JWT. `SUPABASE_SERVICE_ROLE_KEY` is not imported, referenced or used anywhere
  in the finance grid — using it would make the policies decorative.
- Viewer, finance and admin can all read. There are no write operations in this
  ticket: no server action is defined or imported by the route.
- A caller without finance access sees an empty grid, not an error. Absence of
  rows is not proof a batch is empty.
- Database errors are logged server-side by `raiseQueryError` with code, message,
  details and hint, and the browser receives a fixed sentence. Postgres text
  names columns, constraints and policies and is never surfaced.
- `error.tsx` shows Next.js's `digest` correlation id and no error text.
- No raw `legacy_raw_json` is serialised into the page props. A test asserts
  this directly, by serialising a built view model and searching it for
  `source_key`, `legacy_raw_json` and `raw_value`.

## 16. Known legacy limitations

1. **Blank columns are recovered from the manifest, not from row data** (§6).
   Resolved by FINANCE-COLUMN-MANIFEST-03A for the 23 imported batches. A
   batch with no manifest rows falls back to the union of cells, which still
   cannot show a column every student left empty, and the view model reports
   `layoutSource: 'derived'` when that happens.
2. **Balance sign convention is verified, not assumed.** `legacy_balance` comes
   from a headed `Outstanding`/`Balance` column on some sheets and an unheaded
   `Total Paid − Total Fee` formula on others. The grid checks the displayed
   batch: if at least one record states fee, paid and balance together and every
   such record satisfies `balance = paid − fee`, a negative balance means money
   owed and the balance filters are enabled. If no record can be checked, or one
   disagrees, the filters are **disabled** and the strip explains why. This is
   why the ECEA batch — where no student records a balance at all — offers no
   balance filters.
3. **Batch snapshots and normalized payments disagree routinely** (§8), because
   of payment routing. Both are shown; neither is corrected.
4. **7 students carry no student number.** 4 appear in batch grids. They show
   "No student number". The importer's deterministic source key is never shown
   as a student number.
5. **1 import exception** (a Tracker Master row with no amount) is preserved in
   `import_exceptions` and is not surfaced by this screen.
6. **French is not imported** and does not appear as a program.
7. **The legacy marker is batch-relative.** A missing figure raises `⚠ Legacy`
   only when the rest of the batch records that figure. Where a whole batch
   leaves a column empty that is the shape of the sheet, stated once in the
   summary strip — a marker on every row would be no marker at all. A missing
   student number and a spreadsheet error cell always raise it.
8. **The marker never says a value is wrong.** Its tooltip opens "Historical
   workbook information is displayed as originally recorded."

## 17. What is intentionally read-only

Not built, by instruction: payment editing, new payment entry, voiding,
receipt generation, receipt numbering, receipt PDFs, receipt sending or
resending, batch receipt sending, reminder sending, email templates, Resend
configuration, automatic reminders, Excel export, backup automation.

The Export button and the Reminder-needed filter exist as disabled controls with
tooltips, so their absence is explained rather than implied.

No historical data was changed by this ticket. Hosted row counts are unchanged.

## 18. Next planned finance ticket

The receipt workflow: generating a receipt from a payment, allocating a
race-condition-safe receipt number per `ReceiptNumberParts`, rendering the PDF,
and sending through Resend — with the selection bar in §12 as its entry point.
Before that lands, two things in this ticket want a decision: whether the
unassigned records (§4.1) should stay in the batch selector, and whether the
receipt workflow should backfill `receipts` rows for historical payments marked
`YES` or leave them as legacy metadata.

## 19. Testing

`npm test` — 461 tests, 123 suites, 0 failures (401 after this ticket; the 60
added by FINANCE-COLUMN-MANIFEST-03A cover the manifest planner, the generator's
committed output, and the manifest-driven grid rules, and every earlier test
remains green).

The test runner now also matches `src/**/*.test.mts`. The view-model modules are
plain `.ts` with explicit `.ts` import extensions so Node's test runner can load
them directly, which `allowImportingTsExtensions` in `tsconfig.json` already
supports for the analysis scripts.

Covered: blank stays blank and never becomes `$0.00`; a negative legacy value
stays negative; dynamic month columns preserve source order and union across
rows; identity and installment cells are excluded from the actual group; a flat
(ECEA-shaped) table keeps only money headings; PSW scheduled installments are
separate from actual values; ECEA gets no fabricated installments; an unresolved
student shows no fabricated id; the four historical receipt statuses including
the "no payments → Unknown, not Not sent" case; Tracker Master figures never
overwrite the batch legacy balance; the balance convention is verified,
unverifiable and inconsistent cases; batch ordering and default-batch selection
including the undated fallback; search by name and by number, and that it does
not fuzzy-match a neighbouring student number; the legacy marker's
batch-relative rule; and that no raw legacy JSON appears in a serialised view
model.

## 20. Live validation

Carried out against hosted Supabase through a real authenticated browser
session (RLS enforced, no service role), reading only.

| Check | Result |
| --- | --- |
| Unauthenticated `/finance` | `307 → /login?redirectTo=%2Ffinance` |
| PSW batch renders | pass — 17th March 2025 - Morning, 13 students |
| Morning/Evening pair selectable independently | pass — 29th July 2026 Morning (6) and Evening (11) render different rosters and totals |
| ECEA batch renders | pass — 50 students, no installment group, ordinal columns in the actual section |
| Negative/odd historical values | pass — shown as recorded, e.g. batch balance `-$3,000.00`, row balances `-$2,000.00` and `-$1,000.00`; a recorded `$0.00` Total Paid sits beside em-dash blanks |
| Unresolved student row | pass — renders as "No student number" with the legacy marker, no crash |
| Detail drawer transactions | pass — dates, amounts, methods and legacy receipt values render |
| Balance filters disabled where unverifiable | pass — ECEA and the unassigned view |
| Console | no application errors (only a Chrome extension's own i18n warning) |
| Data changed | none — every request is a read |

`npm run lint`, `npm run typecheck` and `npm run build` all pass.
