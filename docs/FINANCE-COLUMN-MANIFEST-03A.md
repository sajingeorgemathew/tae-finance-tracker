# FINANCE-COLUMN-MANIFEST-03A — the batch column manifest

Completes [FINANCE-GRID-03](FINANCE-GRID-03.md) by giving every historical
batch a persistent column layout, so the grid shows the columns the workbook
showed — including the ones every student left blank — without touching a
single historical value.

## Privacy

This document contains no student names, no student numbers, no amounts
attributable to a person, and no remarks. Batch codes, sheet names, column
letters, column headings and aggregate counts only. The same is true of the
generated migration, and a test enforces it.

---

## 1. Purpose

The GRID-03 grid rebuilt each batch's ACTUAL columns from the union of cells
across its rows, because the import stored only populated cells. A column that
every student in a batch left empty therefore vanished from the screen, though
it sat visibly in Excel. That was documented as a known limitation. This ticket
removes it — for the layout only. No value is corrected, recalculated,
normalised or rewritten.

## 2. The audit finding

Re-derived here with the importer's own parser (`npm run finance:manifest`):

| Measure | Count |
| --- | --- |
| Batch tables in the workbook the import mapped | 23 |
| ACTUAL-section displayable columns | 251 |
| INSTALLMENT schedule columns | 132 |
| Structural finance columns, total | 383 |
| ACTUAL columns blank in every student row (lost by the row-union grid) | 21 |
| — of which financially meaningful: 8 month, 6 Late Fees, 1 ECEA Balance | 15 |
| — of which non-money text: 4 REMARKS, 2 Payer | 6 |
| INSTALLMENT columns blank in every student row | 0 |
| Batches affected | 14 |
| Batches clean | 9 |

The counts match the ticket's audit exactly. Nothing was hard-coded: the
generator derives them from the workbook, and the integration test asserts
them.

The 15 restored money columns:

| Batch | Column | Heading |
| --- | --- | --- |
| 17th March 2025 - Morning | I | March |
| 17th March 2025 - Evening | I | March |
| March 26 - Evening | O | Late Fees |
| 27th April 2026 - Morning | M, N | October, Late Fees |
| 27th April 2026 - Evening | M | October |
| 1st June 2026 - Morning | L, M | October, Late Fees |
| 1st June 2026 - Evening | L, M | October, Late Fees |
| 29th JULY 2026 - Morning | J, K | October, Late Fees |
| 29th JULY 2026 - Evening | J, K | October, Late Fees |
| ELCE 25 & 26 | P | Balance |

The 6 hidden text columns: REMARKS (column R) on both 17th March 2025 tables
and both 12th May 2025 tables; Payer (column H) on both January 2026 tables.

## 3. The core rule: structure is not a value

Two separate facts, from two separate places:

| Fact | Source |
| --- | --- |
| "This column existed in this batch" | `batch_finance_columns` |
| "This student had this value in it" | `student_finance_records.legacy_raw_json`, `installments` |

Where they meet with no value, the cell is blank — an em dash — exactly as the
workbook showed it. It is **never** `$0.00`. A recorded zero is still `$0.00`
and a negative figure stays negative. No null placeholder is written into any
student row to make the shape come out, and no `legacy_raw_json` is modified.

## 4. Schema

`supabase/migrations/20260920120000_batch_finance_columns.sql` creates
`public.batch_finance_columns`:

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | uuid PK | Deterministic v5 UUID for historical rows (§7) |
| `batch_id` | uuid → `batches` | `on delete cascade`: a layout belongs to its batch |
| `section` | text, check | `actual` or `installment` |
| `source_column_letter` | text, nullable | Spreadsheet letter; null for application-defined columns |
| `source_header` | text, nullable | The heading **verbatim**, trailing spaces and typos included; null when unheaded |
| `source_header_inherited` | boolean | The source table borrowed the heading from an earlier table on the sheet |
| `column_key` | text | Stable identity within batch + section; the grid's cell key (`actual:G`) |
| `normalized_role` | text, check | Semantic metadata only: `student_number`, `student_name`, `enrollment`, `month`, `late_fees`, `total_fee`, `total_paid`, `balance`, `discount`, `installment`, `remarks`, `payer`, `other` |
| `value_kind` | text, check | `money` or `text` |
| `display_order` | integer | Position in the section; equals `installments.sequence_number` for the installment section |
| `is_grid_visible` | boolean | Whether the main grid shows it |
| `display_even_if_blank` | boolean | Whether an all-blank column is still rendered |
| `origin` | text, check | `legacy_workbook` or `application` |
| `legacy_sheet_name`, `legacy_table_key`, `source_workbook_hash` | text | Provenance for historical rows; layout metadata only |
| `created_at`, `updated_at` | timestamptz | `updated_at` maintained by the existing `set_updated_at` trigger |

Constraints and indexes:

- `unique (batch_id, section, column_key)` — the identity rule for every row.
- partial `unique (batch_id, section, source_column_letter) where source_column_letter is not null`
  — the historical identity rule: one row per batch, section and source
  letter, so a regenerated layout cannot double a column. Headings are not
  part of any uniqueness rule because they repeat ("Total Fee" is in both
  sections of every PSW table).
- `(batch_id, section, display_order)` — the read path.
- A provenance check: a `legacy_workbook` row must carry a letter, sheet, table
  key and workbook hash; an `application` row must not carry a workbook hash.

### Historical vs operational

The application is meant to replace the spreadsheet, and staff will eventually
manage batches and their columns here. `origin` is what tells a workbook-defined
column from an application-defined one, and the nullable `source_column_letter`
and `legacy_*` fields are what let an application column exist without a
spreadsheet behind it. No editing UI is built in this ticket; the shape simply
does not preclude one.

## 5. Roles and headings are separate

`source_header` is displayed. `normalized_role` is metadata. The two are never
reconciled: the 6th October 2025 Evening table heads column N "Marc", which is
plainly March, and the grid shows "Marc". Its role is `other`, because the
importer's exact header matching does not recognise it and inventing the month
here would be inventing meaning the workbook did not state.

An unheaded column keeps its GRID-03 fallback label (`Column Q`). Its role is
`other` and its kind is `money` — on every PSW sheet it holds the outstanding
formula, and nothing more specific is asserted.

## 6. Value kind, visibility, and REMARKS / Payer

Within the ACTUAL span every column is `money` unless its heading names a text
role. REMARKS and Payer are `text` and `is_grid_visible = false`: they are
preserved in the manifest — their existence is real historical structure — and
kept out of the money grid, so a column of blank remarks cannot read as a fee,
and a remark typed into it one day cannot be formatted as currency. Later
tickets (details drawer, payment editor, student finance editor) may surface
them; nothing here does.

For the ELCE roster, which has no ACTUAL/INSTALLMENT split, only money-headed
columns enter the manifest's `actual` section (the same rule GRID-03 already
applied to flat tables), so Start Date, YYYY/MM/DD, Payee and WKD/WKND stay out.

## 7. Manifest generation and deterministic identity

`scripts/finance-import/generate-column-manifest.mts` (`npm run finance:manifest`):

1. Opens the workbook read-only from a buffer and refuses any file whose
   SHA-256 is not the approved import hash.
2. Walks every sheet with the importer's own block detection, classification
   and program resolution (`importer/batch-tables.mts`, lifted from the
   import planner so the two cannot diverge), yielding 23 supported tables and
   1 deferred (French).
3. Reads hosted `batches` (id, code, legacy sheet name, program) — nothing
   about a student — through the read-only Supabase module.
4. Matches each table to exactly one hosted batch (§8) and refuses on any
   ambiguity or gap; a blocked plan writes no migration.
5. Plans one row per structural column (`importer/column-manifest.mts`, pure),
   renders the data migration, and runs the privacy whitelist over it (§11).
6. Writes `.private/finance-import-analysis/column-manifest-plan.json`
   (Git-ignored) always; the migration only with `--write-migration`; and with
   `--check` compares the committed migration to the regenerated one.
7. Re-hashes the workbook and fails if it moved.

Every manifest row's id is the importer's RFC 4122 v5 UUID over a new source
key — workbook hash, sheet, table key, section, column letter
(`batchFinanceColumnSourceKey`) — in the same namespace every imported entity
uses. No second ID scheme was introduced. The derivation is pinned by a test:
changing it would re-key every row, and the test fails rather than letting that
happen quietly.

## 8. Deterministic batch matching

A table matches a hosted batch only when **all** of the following agree on one
row: the deterministic batch id the import created
(`entityId(batchSourceKey(hash, sheet, tableKey))`), `batches.code`
(`sheet!tableKey`), `batches.legacy_sheet_name`, and the program. A candidate
that agrees on some and not others is *ambiguous* and refused; no candidate is
*unmatched* and refused. Nothing is matched on a name, a title, a date or a
worksheet — every PSW sheet holds two batches, and two batches share every
date.

Result against the hosted project: 23 tables, 23 matched, 0 ambiguous,
0 unmatched.

The data migration repeats the check: rows are inserted through a join on
`batches` by id **and** code, so an environment that has not run the
historical import inserts nothing rather than failing on a foreign key, and a
batch that disagrees with the workbook receives no layout — which the
post-migration count check then catches.

## 9. Dry-run result

```
workbook SHA-256:                 62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2
source batch tables:              23
hosted batches matched:           23
ambiguous mappings:               0
unmatched supported tables:       0
manifest rows:                    383
  ACTUAL section rows:            251
  INSTALLMENT section rows:       132
  grid-visible (money) rows:      377
  hidden text rows:               6
  all-blank but visible rows:     15
  all-blank hidden rows:          6
  all-blank installment rows:     0
  batches with all-blank columns: 14
rows by program:                  PSW 376, ECEA 7
rows by role:                     month 234, enrollment 45, total_fee 23, total_paid 23,
                                  other 23, late_fees 20, remarks 4, discount 4,
                                  balance 3, payer 2, installment 2
```

No discrepancy from the 251 / 132 / 383 audit baseline.

## 10. Migration strategy

Two sequential files, after `20260918130000_import_exceptions.sql`:

| File | Written by | Contents |
| --- | --- | --- |
| `20260920120000_batch_finance_columns.sql` | hand | table, constraints, indexes, trigger, RLS, policies, grants |
| `20260920120100_batch_finance_columns_legacy_manifest.sql` | generator | 383 historical rows, `insert … select … join batches … on conflict (id) do nothing` |

Separated because they have different authors and different lifecycles: the
schema is reviewed prose; the data file is a generated artifact that is
regenerated in place and verified by `--check` and by a test. The application
never reads the workbook — a fresh environment runs the two migrations after
the historical import and gets the same 383 rows under the same ids.

No already-applied migration is modified. `db reset --linked` is never run.

## 11. Privacy

The generated migration and the private plan carry batch codes, sheet names,
table keys, column letters, the workbook's headings, the vocabularies and the
ids — nothing else. This is enforced as a **whitelist**, not a heuristic:
`findUnexpectedArtifactLiterals` extracts every string literal in the VALUES
block and refuses any that is not exactly one of those values. The generator
will not write a file that fails it, and tests check both the fixture-built
artifact (with known names, numbers and amounts that must not appear) and the
committed one.

## 12. RLS

| Role | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| admin | yes | yes | yes | no policy |
| finance | yes | no | no | no policy |
| viewer | yes | no | no | no policy |
| anon | no | no | no | no |

Reads use `can_read_finance()`, as every finance table does — anyone who may
read the grid may read its layout. Writes are `is_admin()` only: a layout
change alters what every staff member sees for every student in a batch. The
historical rows are inserted by migration, which runs as the database owner and
is outside these policies. `/finance` rendering remains read-only and uses the
request-scoped client; the service-role key is not referenced by any grid code.

The matrix above is the *policy* matrix. At the grant level the hosted project's
default privileges give `anon` and `authenticated` the same table grants on
this table as on every other finance table; RLS is the gate, and with no policy
naming `anon` an anonymous read returns zero rows and an anonymous insert is
refused by policy (both verified against the hosted project, §16).

## 13. Grid integration and query strategy

`loadFinanceGrid` now issues **seven** bounded requests per render, regardless
of batch size:

1. programs; 2. batches; 3. one `batch_id` column across all finance records
   (the per-batch tally);
4. the selected batch's finance records with students embedded, **and**
5. the selected batch's manifest rows — issued together with `Promise.all`;
6. installments and 7. payments for those record ids, together.

One manifest query per selected batch; none per student. The unassigned view
has no batch and skips step 5. The manifest select projects only the layout
fields; `source_workbook_hash`, `legacy_sheet_name` and `legacy_table_key`
never leave the database. The public `FinanceColumn` type carries key, label,
section, role, value kind, order, an `unheaded` flag and an `origin` — and a
test asserts no raw manifest field or letter is serialised.

In the view model (`src/lib/finance/grid/view-model.ts`):

- **ACTUAL**: the manifest's `actual` rows define the group — every column,
  in `display_order`, hidden ones included so their letters are accounted for.
  As a safety net, any letter present in a row's preserved cells that the
  manifest does not describe is appended as a `derived` column, so a value can
  never be hidden by a manifest that happens not to mention it. With this
  workbook that never occurs; a test proves the behaviour.
- **INSTALLMENT**: the manifest's `installment` rows define the group.
  Normalized installments are placed under the column whose `display_order`
  equals their `sequence_number` — the importer assigned both by the same
  left-to-right walk — and the installment's own `legacy_column_name` must
  agree with the column heading. One that disagrees gets a derived column of
  its own rather than a wrong one. No installment row is created, and a
  column with no installment in it is blank.
- **Visibility**: hidden columns are dropped after cells are computed, and
  their cells are dropped with them. `display_even_if_blank = false` columns
  (none historically) are omitted when nobody fills them.
- **Fallback**: a batch with no manifest rows, and the unassigned view, use
  the previous union-of-cells derivation and report `layoutSource: 'derived'`.
- **Summary**: `blankStructuralColumns` counts visible manifest columns with
  no value in any row. The summary strip states it once ("2 columns from this
  batch's workbook layout hold no figure for any student…"). The totals are
  unchanged: a structural blank contributes nothing, not zero.

The grid component right-aligns headings by the column's `valueKind`, not by
guessing from its key.

## 14. ECEA Balance

The ELCE roster's Balance column (P) is blank for all 50 students, so
`legacy_balance` is null for every ECEA record. The manifest restores the
column structurally; every cell shows an em dash. It is **not** calculated,
Tracker Master's Balance Fees is **not** used, `fee − paid` is **not**
manufactured, no ECEA installment is created, the batch balance total stays
blank with "50 students recorded no figure", and the Balance Due / Settled
filters stay disabled — filter logic depends on reliable row data, not on a
heading existing. The visible blank column is what explains the data state.

## 15. Known limitations

1. **Manifest coverage is the 23 imported batches.** A batch created any
   other way has no rows here and renders on the derived fallback, which the
   view model reports.
2. **Sheet identity columns are not in the manifest.** Sr. No., Student ID,
   names, Graduated, Start Date, Payee/WKD/WKND on the roster — the identity
   group is fixed and those columns are not finance columns. The schedule
   section's own Total Fee and unheaded formula columns are likewise not
   manifest rows: they are not installments, and the 132 count is the
   importer's own.
3. **Roles are the importer's exact-match vocabulary.** "Marc" is `other`.
   Widening the vocabulary is a migration and a deliberate decision.
4. **No editing.** Batch reconciliation, layout editing, payment or finance
   editing, receipts, reminders, export — all later tickets. The 22
   unassigned records are untouched and still offered as *Unassigned — no
   batch (22)*.
5. **RLS role coverage.** The hosted project has one profile (admin). Viewer
   and finance reads are verified by policy definition, not by a live session
   of that role.

## 16. Verification

Carried out against the hosted project on 2026-09-20 after `supabase db push`
applied `20260920120000` and `20260920120100` (both listed by
`supabase migration list --linked`). Catalog and count checks ran through
`supabase db query --linked`; the render checks ran through a real
authenticated admin session obtained with a one-time token, the same technique
the import's RLS verification uses, never the service role.

| Check | Result |
| --- | --- |
| Table, 18 columns, 9 check constraints, FK `on delete cascade`, PK, unique `(batch_id, section, column_key)` | present as written |
| Partial unique index on source letter; `(batch_id, section, display_order)` index; `set_updated_at` trigger | present |
| `rowsecurity` true; policies select/insert/update to `authenticated`; no delete policy | as designed |
| Anonymous read / anonymous insert | 0 rows / refused by policy |
| Authenticated admin read (no service role) | app role `admin`, 383 manifest rows, 397 finance records |
| Manifest rows: total / actual / installment / visible / hidden text | 383 / 251 / 132 / 377 / 6 |
| Rows by program / by role | PSW 376, ECEA 7 / exactly the §9 vocabulary counts |
| Batches covered / without layout / orphan rows | 23 / 0 / 0 |
| Duplicates on key, letter, or display order; non-contiguous orders; key≠letter | 0 / 0 / 0 / 0 / 0 |
| Every row carries the approved workbook hash and `legacy_workbook` origin | 383 / 383 |
| Hosted rows vs committed migration, field by field | 383 matched, 0 mismatched, 0 missing, 0 extra |
| Installment columns vs normalized installments | 132 columns, 132 distinct batch+sequence pairs, 1,825 installments all placed, 0 heading disagreements |
| Historical counts unchanged | batches 23, students 385, finance records 397 (22 unassigned), installments 1,825, payments 1,013, import batches 1, import exceptions 1 |
| `npm run finance:manifest -- --check` | committed migration is current; workbook hash unchanged |
| Rendered PSW 17th March 2025 Morning | March column present and blank for all 13; REMARKS not shown; "1 column … holds no figure" |
| Rendered PSW 27 April 26 Morning | October and Late Fees present and blank for all 15; "2 columns … hold no figure" |
| Rendered PSW 6th Oct 2025 Evening | heading "Marc" verbatim; unheaded column labelled by letter |
| Rendered PSW Jan 2026 Morning | Payer not shown; recorded `$0.00` Total Paid values still shown |
| Rendered ECEA | Balance column present and blank for all 50; no installment group; "50 students recorded no figure" |
| Rendered Unassigned | 22 rows on the derived fallback, no structural columns |
| Unauthenticated `/finance` | `307 → /login?redirectTo=%2Ffinance` |
| tests / lint / typecheck / build | 461 pass / clean / clean / pass |
