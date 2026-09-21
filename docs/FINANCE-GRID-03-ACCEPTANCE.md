# FINANCE-GRID-03B — acceptance and historical reconciliation

QA record for [FINANCE-GRID-03](FINANCE-GRID-03.md) and
[FINANCE-COLUMN-MANIFEST-03A](FINANCE-COLUMN-MANIFEST-03A.md): does `/finance`
faithfully show the imported historical workbook, and can it stand in for
the spreadsheet?

## Privacy

This document contains no student names, no student numbers, no amounts
attributable to a person, and no remarks. Batch names, column headings and
aggregate counts only. The row-level reconciliation, the unassigned candidate
list and every screenshot live under `.private/finance-qa/`, which Git
ignores.

---

## 1. Scope and method

Two kinds of validation, run on 2026-09-21 against the hosted project
`hwekiiompxixybxclche` and workbook SHA-256
`62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2`
(re-hashed after every run: unchanged).

**A. Automated reconciliation** — `npm run finance:reconcile`
(`scripts/finance-qa/reconcile-grid.mts`). For each of the 23 imported batch
tables it parses the workbook with the importer's own table discovery, reads
the hosted rows through an authenticated admin session under Row Level
Security, builds the batch with the application's own `buildFinanceGrid`
using the exact column projections `load.ts` selects, and compares the two
cell by cell. Rows are joined on the importer's deterministic ids recomputed
from the workbook (hash, sheet, source row, table key); nothing is matched by
name or by a neighbouring number. Values are compared against the workbook
cells as preserved, never against totals recomputed from Tracker Master
payments. The comparator is unit-tested to fail on a blank rendered as
`$0.00`, a flipped sign, a lost value and a changed text or error cell.

**B. UI acceptance** — `npm run finance:ui-acceptance`
(`scripts/finance-qa/browser-acceptance.mts`). The Claude in Chrome extension
was not connected, so the installed Chrome was launched headless and driven
over the DevTools protocol against the local `next dev` server, signed in as
the admin with a one-time-token session (RLS enforced; the service role was
used only to mint the token). 79 scripted checks plus visual review of the
screenshots.

The service-role key was not used to read a single row in either method.

## 2. Hosted baseline (as read under RLS by the admin session)

| Table | Rows |
| --- | ---: |
| programs | 2 |
| batches | 23 |
| student_finance_records | 397 (22 with no batch) |
| students with a finance record | 385 |
| installments | 1,825 |
| payments | 1,013 |
| batch_finance_columns | 383 |

Identical to the counts recorded by FINANCE-IMPORT-02-APPLY and 03A. An
anonymous client with the publishable key sees 0 finance records and 0
manifest rows.

## 3. Reconciliation — all 23 batches

Source rows are the student rows of the workbook table (totals lines
excluded, as the import excluded them). Columns are counted as ACTUAL +
INSTALLMENT, grid-visible only.

| Batch | Program | Source rows | Grid rows | Matched | Missing | Extra | Source cols (A+I) | Grid cols (A+I) | Column mismatches | Value mismatches | Blank/zero mismatches | Schedule mismatches | Status |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 17th March 2025 - Morning | PSW | 13 | 13 | 13 | 0 | 0 | 12+6 | 12+6 | 0 | 0 | 0 | 0 | PASS |
| 17th March 2025 - Evening | PSW | 11 | 11 | 11 | 0 | 0 | 12+6 | 12+6 | 0 | 0 | 0 | 0 | PASS |
| 12th May 2025 - Morning | PSW | 11 | 11 | 11 | 0 | 0 | 12+6 | 12+6 | 0 | 0 | 0 | 0 | PASS |
| 12th May 2025 - Evening | PSW | 14 | 14 | 14 | 0 | 0 | 12+6 | 12+6 | 0 | 0 | 0 | 0 | PASS |
| 2nd July 2025 - Morning | PSW | 15 | 15 | 15 | 0 | 0 | 11+6 | 11+6 | 0 | 0 | 0 | 0 | PASS |
| 2nd July 2025 - Evening | PSW | 12 | 12 | 12 | 0 | 0 | 11+6 | 11+6 | 0 | 0 | 0 | 0 | PASS |
| 18th August 2025 - Morning | PSW | 14 | 14 | 14 | 0 | 0 | 11+6 | 11+6 | 0 | 0 | 0 | 0 | PASS |
| 18 August 2025 - Evening | PSW | 24 | 24 | 24 | 0 | 0 | 11+6 | 11+6 | 0 | 0 | 0 | 0 | PASS |
| 06th October 2025 - Morning | PSW | 18 | 18 | 18 | 0 | 0 | 11+6 | 11+6 | 0 | 0 | 0 | 0 | PASS |
| 06th October 2025 - Evening | PSW | 12 | 12 | 12 | 0 | 0 | 11+6 | 11+6 | 0 | 0 | 0 | 0 | PASS |
| December 2025 - Morning | PSW | 17 | 17 | 17 | 0 | 0 | 11+6 | 11+6 | 0 | 0 | 0 | 0 | PASS |
| December - Evening | PSW | 14 | 14 | 14 | 0 | 0 | 11+6 | 11+6 | 0 | 0 | 0 | 0 | PASS |
| January 2026 - Morning | PSW | 20 | 20 | 20 | 0 | 0 | 11+6 | 11+6 | 0 | 0 | 0 | 0 | PASS |
| January 026 - Evening | PSW | 19 | 19 | 19 | 0 | 0 | 11+6 | 11+6 | 0 | 0 | 0 | 0 | PASS |
| March 26 - Morning | PSW | 15 | 15 | 15 | 0 | 0 | 11+6 | 11+6 | 0 | 0 | 0 | 0 | PASS |
| March 26 - Evening | PSW | 10 | 10 | 10 | 0 | 0 | 11+6 | 11+6 | 0 | 0 | 0 | 0 | PASS |
| 27th April 2026 - Morning | PSW | 15 | 15 | 15 | 0 | 0 | 11+6 | 11+6 | 0 | 0 | 0 | 0 | PASS |
| 27th April 2026 - Evening | PSW | 26 | 26 | 26 | 0 | 0 | 11+6 | 11+6 | 0 | 0 | 0 | 0 | PASS |
| 1st June, 2026 - Morning | PSW | 14 | 14 | 14 | 0 | 0 | 10+6 | 10+6 | 0 | 0 | 0 | 0 | PASS |
| 1st June 2026 - Evening | PSW | 14 | 14 | 14 | 0 | 0 | 10+6 | 10+6 | 0 | 0 | 0 | 0 | PASS |
| 29th JULY, 2026 - Morning | PSW | 6 | 6 | 6 | 0 | 0 | 8+6 | 8+6 | 0 | 0 | 0 | 0 | PASS |
| 29th JULY 2026 - Evening | PSW | 11 | 11 | 11 | 0 | 0 | 8+6 | 8+6 | 0 | 0 | 0 | 0 | PASS |
| ELCE 25 & 26 | ECEA | 50 | 50 | 50 | 0 | 0 | 7+0 | 7+0 | 0 | 0 | 0 | 0 | PASS |

**23 / 23 PASS. 0 REVIEW.**

What each PASS covered, per batch: batch identity (deterministic id, code,
legacy sheet name, program, stored name); every source student row present
exactly once in the grid and no extra row; student number exact or exactly
absent; display-name source; the ACTUAL column list, order and headings;
hidden text columns absent from the money grid; all-blank manifest columns
present and blank; the INSTALLMENT column list, order and headings; Total
Fee, Total Paid and Balance against the batch sheet's own snapshot cell;
every ACTUAL cell; every scheduled cell; the receipt status; the drawer's
payments against the hosted payments and against the workbook's Tracker
Master rows; the summary-strip totals and missing counts; the hosted manifest
rows field by field; and the ECEA-specific rules.

### Totals across all batches

| Measure | Count |
| --- | ---: |
| Source student rows / grid rows / matched by deterministic id | 375 / 375 / 375 |
| Plus unassigned records (no batch sheet behind them) | 22 → 397 |
| ACTUAL cells compared | 3,895 |
| — blanks preserved as blank | 1,363 |
| — recorded zeros preserved as `$0.00` | 171 |
| — negatives preserved as negative | 133 |
| — positive amounts matched | 2,228 |
| — text cells / error cells in ACTUAL money columns | 0 / 0 |
| ACTUAL value mismatches | **0** |
| Blank-vs-zero mismatches | **0** |
| Sign mismatches | **0** |
| Total Fee / Total Paid / Balance snapshot mismatches | **0** |
| — negative balances preserved / recorded `$0.00` Total Paid | 132 / 5 |
| Scheduled cells compared (blank) | 1,950 (125) |
| Schedule mismatches | **0** |
| Receipt status mismatches | **0** |
| Drawer payments: grid / hosted / workbook-planned | 972 / 972 / 972 |
| Rows with any payment mismatch | **0** |
| Manifest field mismatches, hosted vs workbook-derived | **0** |

Balance source per batch, as the import resolved it: a headed `Outstanding`
column (1 batch), a headed `Balance` column (ECEA), and the unheaded
`Total Paid − Total Fee` formula column on the other 21. The grid's displayed
balance equals that cell in every row, and no row's balance equals a Tracker
Master `Balance Fees` figure in place of it — the payments query does not
even select that field. Balance convention: 22 batches verified
`paid − fee`, ECEA unverifiable (no student records all three figures).

Display names: 154 rows show the batch sheet's spelling exactly, 31 show it
with doubled inner spaces collapsed, 190 show the Tracker Master spelling
(the import's documented preference), 0 show a name from nowhere.

Unresolved students: 4 rows in batch grids and 3 in the unassigned view read
"No student number" — 7, as the import recorded. None carries a fabricated
identifier.

## 4. Column manifest

| Check | Result |
| --- | --- |
| Workbook-derived rows / hosted rows | 383 / 383, every id matched, 0 extra, 0 missing |
| ACTUAL / INSTALLMENT | 251 / 132 in both |
| All-blank visible money columns restored | 15 — 8 month, 6 Late Fees, 1 ECEA Balance |
| Hidden text columns | 6 — 4 REMARKS, 2 Payer; 0 of them money-kind; none shown in the grid |
| Source headings preserved verbatim, hosted = workbook | 383 / 383 |
| Display order equals sheet order, every batch and section | yes |
| `npm run finance:manifest -- --check` | committed migration is current |

The 15 restored columns, as rendered blank: March (17th March 2025 Morning
and Evening); Late Fees (March 26 Evening); October and Late Fees (27th
April 2026 Morning; 1st June 2026 Morning and Evening; 29th JULY 2026 Morning
and Evening); October (27th April 2026 Evening); Balance (ELCE 25 & 26). No
manifest column produced a value: every cell in them compared as blank.

## 5. UI acceptance

79 / 79 scripted checks, after one fix (§9). Representative batches rendered
and reviewed: 17th March 2025 Morning and Evening, 2nd July 2025 Morning,
06th October 2025 Evening, January 2026 Morning, 27th April 2026 Morning,
1st June 2026 Morning and Evening, 29th JULY 2026 Morning and Evening,
ELCE 25 & 26, and Unassigned — no batch.

### Workflow

| Step | Result |
| --- | --- |
| Open `/finance` | lands on PSW · 29th JULY, 2026 - Morning; the note states the rule and the Morning tie-break |
| Program selector | PSW ↔ ECEA; ECEA opens on ELCE 25 & 26 with the "no start date" note |
| Batch selector | 22 PSW batches + Unassigned (23 options); 6 marked `· no start date`, none given a date |
| Morning / Evening independently | 29th JULY 2026 Morning (6) and Evening (11) render different rosters |
| Search by student number | narrows to exactly that row; a neighbouring number is not matched; `q=` mirrored into the URL |
| Search by name | partial, case-insensitive substring |
| Clear search | every row returns, `q=` dropped from the URL |
| Empty search | "No matching students" empty state, count reads `0 of N shown` |
| Horizontal scrolling | grid is 1,877px wide in a 1,550px container; scrollbar usable |
| Sticky header | header row stays at the top of the container while the page scrolls |
| Sticky identity columns | checkbox, Student # and Student name (and their Identity banner) stay at the left; frozen region pixel-identical before and after scrolling (after §9) |
| Select one / two / all visible / clear | selection bar counts 1, 2, then all rows; select-all is indeterminate on a partial selection; Clear empties it |
| Receipt and Reminder actions | disabled on the bar and on every row, each with an explanatory tooltip |
| Details drawer | opens from the name and from View details, takes focus, has no editable field; Escape and Close both close it |
| Transaction history | date, amount, method and legacy receipt text per payment; count equals the row's tooltip |
| Refresh with URL params | batch, search term and quick filter all restored |
| Back / forward | batch selection follows history both ways |
| Stale `?batch=` | falls back to the default with "The requested batch is not available…" |
| ECEA | 50 rows, no installment group, ordinal fee columns in the actual group |
| Unassigned | 22 rows, Identity and Status groups only, labelled "Unassigned — no batch (22)" |
| Console | 0 application errors across the session |

### Visual

Compact rows (32px at 13px type), Student # and name legible, money
right-aligned with tabular figures, grouped banners readable, ACTUAL and
INSTALLMENT visually separated by their banners, blanks rendered as a muted
em dash distinct from `$0.00` in full ink, negatives in red, long headings
kept on one line, row hover highlight, no card layout at any width. The
drawer is modal and covers the right of the grid; the selectors, search and
the Close button stay visible.

Confusing behaviour noted, not changed: none blocking. Two observations for
later tickets — the drawer's transaction table has no Payment No. column,
and the Unassigned view shows the same person twice where two Tracker
Master rows named them without a number (correct under the import's
no-merge rule, but staff will ask).

## 6. Known edge cases

| Case | Observed |
| --- | --- |
| A. Historical negative values | 133 ACTUAL cells and 132 balances negative; shown as `-$…` in red, never sign-flipped |
| B. Recorded `$0.00` | 171 ACTUAL cells and 5 Total Paid values; shown as `$0.00`, distinct from blanks |
| C. All-blank restored month column | October on 27th April 2026 Morning: header present, every cell blank |
| D. All-blank Late Fees column | Late Fees on the same batch: header present, every cell blank; strip says "2 columns … hold no figure" |
| E. ECEA Balance | header visible, all 50 cells blank, batch total blank with "50 students recorded no figure", Balance Due and Settled disabled with the reason |
| F. Unresolved student | "No student number" in italics with the Legacy marker; drawer says "No student number · PSW · No batch" |
| G. Unheaded numeric column | "Column Q" (06th October 2025 Evening), "Column M" (29th JULY 2026), etc. |
| H. Source typo | "Marc" shown verbatim on 06th October 2025 Evening |
| I. Legacy marker | 55 flags on batch rows: balance not recorded 20, fee or paid not recorded 31, no student number 4; tooltip opens "Historical workbook information is displayed as originally recorded." |

## 7. Transaction drawer

All 972 payments tied to batch records were reconciled in the view model:
count per record, dates, amounts, payment-method spelling (untrimmed against
hosted; the drawer trims for display only) and the workbook's receipt-sent
text agree between the drawer entries, the hosted `payments` rows and the
workbook's Tracker Master rows, joined on the payment's deterministic id. In
the browser, one row from each of 17th March 2025 Morning, 2nd July 2025
Morning and January 2026 Morning was opened and its table matched the
tooltip's payment count. The 29th JULY 2026 batches, and both 1st June 2026
batches, have no Tracker Master payment tied to any row — the import's
routing outcome, which the drawer states in words. No method was normalised
and no receipt number exists anywhere.

## 8. Historical receipt status

Over the 1,013 hosted payments the workbook's receipt values are YES 1,005,
NO 4, blank 4. Derived per record and compared against the grid:

| Rule | Records | Grid matches |
| --- | ---: | --- |
| all YES → Sent | 241 | yes |
| YES and NO → Mixed | 2 | yes |
| all NO → Not sent | 0 | no live example; the rule is covered by the unit test only |
| no stated value (1 all-blank record + 153 with no payments) → Unknown | 154 | yes |

The four NO values all sit on the two Mixed records. `receipts` still holds
zero rows; every label reads "Legacy receipt: …" and nothing was created.

## 9. Fix made (safe UI bug)

**Frozen-column bleed.** With the grid scrolled sideways, a one-pixel
vertical sliver of the scrolled cells showed through between the frozen
Student # and Student name columns (visible as stray glyph fragments beside
each name). Cause: the table used collapsed borders, where a border is shared
between two cells and neither cell's background paints under it, so the
scrolled content underneath became visible in that seam. Fix in
`src/components/finance/finance-grid.tsx`: `border-separate border-spacing-0`
on the table, and the row border moved from `<tr>` (which only renders in
the collapsed model) to each cell. The pixel comparison of the frozen region
before and after scrolling went from different to identical; row height went
from 31px to 32px because each cell now owns its bottom border. No data
behaviour changed.

No other fix was made. No historical data, import logic, schema or manifest
was touched.

## 10. Summary strip

For every batch the strip's Historical total fees, total paid and balance
equal the sums of that batch's own `legacy_*` snapshot values, and the
"N students recorded no figure" counts equal the number of blank snapshots
— missing values are excluded, not treated as zero. No figure is derived
from Tracker Master. ECEA's balance total is blank with "50 students recorded
no figure". The `truncated` warning never appeared (no query hit its cap).

## 11. Unassigned audit (aggregate)

| Measure | Count |
| --- | ---: |
| Unassigned finance records | 22 |
| Students represented | 22 (no student appears twice) |
| Payments attached | 41 (1 record has none: its only Tracker Master row is the missing-amount import exception) |
| Numbered / unresolved students | 19 / 3 |
| Program | PSW 22, ECEA 0 |
| Import reason: ambiguous batch / batch not found / missing student id | 5 / 14 / 3 |
| Human-assignable — the student appears in two batch tables for the program and a person can choose | 5 |
| Month hint only — in no batch table, but Tracker Master's Batch cell names a month that matches a batch pair | 14 |
| Genuinely uncertain — no student number at all | 3 |

Tracker Master's Batch cell holds text of the form `Aug-25`: a month and a
year, never a day, so at best it points at a pair and can never tell Morning
from Evening. The month match is deliberately loose in the reviewer's favour:
it accepts a start date in that month and year, or an undated batch whose
name states the month with a year ending in the same digits or no year at
all — which is how the one `Dec-26` record matched only "December - Evening".
That is a hint to show a person, not evidence. In the grid these 22 rows have no ACTUAL or INSTALLMENT
columns (there is no batch sheet behind them), receipt status Sent 20 /
Unknown 2, and 7 carry the "fee or paid not recorded" marker. Row-level
candidates are in `.private/finance-qa/unassigned-audit.json`. Nothing was
assigned.

## 12. What FINANCE-RECONCILE-04 needs

Design input only; none of this is implemented.

1. **Assign a finance record to a batch**, from the Unassigned view, for the
   5 records with candidate tables: show the candidate batches side by side
   with the Tracker Master month hint, require an explicit choice, and refuse
   to auto-pick.
2. **Move a finance record between batches** — the same action applied to a
   record that already has a batch, for corrections found later.
3. **Resolve a student number** for the 7 unresolved students (3 here, 4 on
   batch rows): attach the record to an existing numbered student only on an
   exact identity proven by a person, never by name similarity; the
   duplicate no-number rows in the Unassigned view are the first test case.
4. **Merge only on proven identity**: two records may merge only when a human
   confirms the same student number, and the merge must keep both snapshots
   visible rather than summing them.
5. **Keep unassigned** as a first-class, recorded decision for the 3
   genuinely uncertain records (and any the reviewer declines), so the queue
   empties honestly.
6. **Audit-log every correction**: who, when, from what to what, and the
   evidence cited, with the original `batch_id`, student link and snapshot
   preserved — the historical figures themselves are never edited by these
   actions.
7. Surface the month hint as a hint (14 records), never as a default.

## 13. Security

| Check | Result |
| --- | --- |
| Unauthenticated `/finance` | `307 → /login?redirectTo=%2Ffinance` (curl and headless Chrome) |
| Anonymous REST read of finance records / manifest | 0 rows / 0 rows |
| Authenticated admin | app role `admin`; reads every row through RLS |
| Request-scoped client | every `src/lib/finance/*` module imports `createClient` from `@/lib/supabase/server`; `createServiceRoleClient` is referenced nowhere outside its definition |
| Service-role key in the production bundle | 0 chunks under `.next/static` contain the key value or the variable name; 0 server chunks contain the value (read from the environment at runtime) |
| Raw legacy JSON reaching the client | 0 static chunks mention `legacy_raw_json`; the served `/finance` HTML contains none of `legacy_raw_json`, `raw_value`, `source_key`, `formatted_text`, `service_role` |
| Private reconciliation outputs tracked by Git | none; `.private/` and the reference files are ignored |

## 14. Query strategy and performance

Measured by running the real `loadFinanceGrid` under Node with a stub for
`next/headers` (`scripts/finance-qa/loader-request-count.mts`) and counting
REST requests:

| View | Rows | REST requests |
| --- | ---: | ---: |
| 29th JULY, 2026 - Morning (smallest) | 6 | 7 |
| 27th April 2026 - Evening (largest PSW) | 26 | 7 |
| ELCE 25 & 26 | 50 | 7 |
| Unassigned — no batch | 22 | 6 (no manifest query) |

No request per student anywhere; one manifest query per batch; installments
and payments by a single `in (...)` each; the per-batch tally is one column
across all records. Drawer data is the batch's payments, already loaded and
bounded by the 2,000 cap, which no batch approaches (the largest holds 116).
The 50-row ECEA grid scrolls without virtualisation and needs none.

## 15. Quality gates

| Gate | Result |
| --- | --- |
| `npm test` | 475 tests, 126 suites, 0 failures (461 before; 14 added for the reconciliation comparator) |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run build` | passes; `/finance` dynamic |

## 16. Git and privacy

Working tree after this ticket: `package.json` (two npm scripts),
`scripts/README.md`, `src/components/finance/finance-grid.tsx` (§9) modified;
`scripts/finance-qa/` added. Not tracked, and ignored: `.env.local`,
`.private/**` (row-level reports, screenshots), `reference/finance-tracker.xlsx.xlsx`,
`reference/receipt-template.pdf.pdf`. Nothing committed, nothing pushed.

## 17. Remaining blocker before GRID-03 merge

None found by this QA. Two decisions are still open from GRID-03 §18 and are
not blockers: whether the Unassigned entry stays in the batch selector, and
whether the receipt workflow backfills `receipts` for historical YES values.

## 18. Owner acceptance checklist

Work through these in the running application, signed in as yourself. Keep
the workbook open beside it.

- [ ] Open `/finance`. It should land on PSW · 29th JULY, 2026 - Morning and say why.
- [ ] Switch the batch to 29th JULY 2026 - Evening. Different students, different totals.
- [ ] Pick a batch you know well and compare one row, cell by cell, with the workbook row — Total Fee, each month, Total Paid, Balance.
- [ ] Find a cell the workbook left empty. The grid shows a dash, not $0.00. Find a workbook 0 (January 2026 - Morning has several). The grid shows $0.00.
- [ ] Find a negative balance. It is red and negative, not hidden.
- [ ] Open 27th April 2026 - Morning. October and Late Fees are present and entirely blank, and the strip says so.
- [ ] Open 06th October 2025 - Evening. The heading "Marc" and "Column Q" appear as the sheet had them.
- [ ] Search a student by number, then by part of a name, then clear. Try a number that does not exist.
- [ ] Scroll the grid sideways: Student # and name stay put with nothing showing through them; the header stays put when you scroll down.
- [ ] Click a student name. Check the drawer's Total fee / Total paid / Balance against the grid row, then read the imported transactions and confirm one payment against Tracker Master.
- [ ] Tick a few rows, then Select all, then Clear. Receipt and Reminder stay greyed out with a tooltip.
- [ ] Switch to ECEA. No installment group; Balance is a blank column; Balance due / Settled are disabled.
- [ ] Choose Unassigned — no batch. 22 rows, three with "No student number". Nothing here should look like a batch.
- [ ] Refresh the page with a search and filter in the address bar. Both survive.
- [ ] Sign out; visit `/finance` again. You are sent to the login page.
