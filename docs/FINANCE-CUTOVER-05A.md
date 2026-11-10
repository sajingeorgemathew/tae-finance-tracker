# FINANCE-CUTOVER-05A — Active cohort cutover (first pass: plan only)

Branch `feature/finance-cutover-05a-active-cohorts`. Status: **final
preparation done — approved business decisions applied, the 19 dated payments
reconciled, `collection_mode` migration applied, restore generated and
verified — cutover NOT applied.** Nothing was deleted, imported, updated, emailed
or receipted on hosted. This document holds aggregates, rules and hashes only;
row-level detail is under `.private/finance-cutover-05a/` (Git-ignored).

## 1. What changes, and what does not

The operational dataset moves from the broad historical import
(FINANCE-IMPORT-02, 23 batches) to the launch cohorts:

| Cohort | Source | Batches |
| --- | --- | --- |
| PSW March 2026 | **hosted**, preserved by id | March 26 - Morning, March 26 - Evening |
| PSW April 2026 | replacement workbook | 27th April 2026 - Morning / Evening |
| PSW June 2026 | replacement workbook | 1st June, 2026 - Morning / 1st June 2026 - Evening |
| PSW August 2026 | replacement workbook (sheet `Aug 2026`, titles "29th July 2026") | 29th JULY, 2026 - Morning / 29th JULY 2026 - Evening |
| PSW September 2026 | replacement workbook | 28th Sept, 2026 - Morning / Evening |
| ECEA current roster | replacement workbook | ELCE 25 & 26 |
| French current roster | replacement workbook | French (new program) |

Unchanged: RLS, the audit log, the import history (`import_batches`,
`import_exceptions`), `public.apply_student_contact_fill` and its migration,
and every 04B2 module. One additive migration
(`20261021120000_finance_record_collection_mode.sql`, §9) adds a nullable
column and changes no value.

**FINANCE-IMPORT-02 is historical import infrastructure.** It imported the
superseded workbook (sha256 `62d53173…94b2`) and its tooling and tests are
kept as they are. **CUTOVER-05A establishes the new operational source
baseline** (sha256 `0d325279…2dfe`). The historical reconciliation
(`finance:reconcile`, `finance:manifest`) is bound to the superseded workbook
and now refuses explicitly ("0 of them carry a Tracker Master sheet"); it is
deliberately not adapted to accept the replacement. After the apply, the
primary acceptance check is the cutover's own post-state verification plus
the conservation figures in §6.

## 2. Sources

| Source | File | sha256 |
| --- | --- | --- |
| Finance workbook (replacement) | `reference/finance-tracker.xlsx.xlsx` | `0d32527990b140d7ab587ee53841e27df87fbff50da4b09b28a9e278376a2dfe` (= approved) |
| PSW contact master | `reference/PSW MASTERCLASS LIST- 2025 - 26 (6).xlsx` | `9130458b3c17ee14a6229c597816b12e7f55ed82f19cd7fcfc99a272fe249a29` |
| ECEA contact master | `reference/ELCE_MASTERCLASS_LIST_2025-26_New#.xlsx` | `f328cfbda08453a359def3ae69290ca79be9d51bc6647c161752eb341e7eccb8` |

The finance workbook is identified structurally — cohort sheets, no
`Tracker Master`, not claimed by a contact-master adapter (the PSW master also
holds Morning/Evening tables) — and then by exact hash.

### Sheets discovered

Six sheets, ten tables, all recognised, none out of scope:

| Sheet | Tables | Cohort month read from | Start date (title) |
| --- | --- | --- | --- |
| `27 April 26` | Morning, Evening | title (sheet name has a 2-digit year) | 2026-04-27 |
| `1st June 2026` | Morning, Evening | sheet name | 2026-06-01 |
| `Aug 2026` | Morning, Evening | sheet name (titles say 29th July) | 2026-07-29 |
| `28 Sept 26` | Morning, Evening | title | 2026-09-28 |
| `ELCE 25 & 26` | one flat roster | — (program roster) | — |
| `French` | one flat roster | — (program roster) | — |

The September start date is read with the contact adapters' title-date parser
(`parseTitleDate`), which accepts "Sept"; the historical importer's stricter
reader would have left September undated.

## 3. Parsing rules added for this workbook

The importer's block detection and table builder are reused unchanged. On top
of them (`scripts/finance-cutover/parse.mts`):

- **Totals rows** are recognised by a `SUM` running *down* their own column,
  not by "money and no name". That separates them from **placeholder seats**
  (a serial number and a typed template fee, nobody named — 6 rows) and
  **empty seats** (serial or `#REF!` and formula results only — 2 `#REF!` rows
  plus blank serials).
- Rows **below a table's totals row** are not part of it (8 rows under
  September Evening, 4 of which hold referral/first-name notes).
- A **number typed in a name column** is not a name: it is kept in provenance
  and preserved as an import exception, never stored as a name part (2 ECEA
  rows, 3 values).
- **Cells past the last heading** are captured and preserved as exceptions,
  never read as money (2 ECEA rows, 3 cells — vaccination notes).
- A column whose heading is sensitive (ECEA/French `YYYY/MM/DD`, a date of
  birth) is **left out of `legacy_raw_json` by name**, using the 04B1
  sensitive-heading list. (The historical import did store it.)
- Student numbers stay text, exactly as written; blanks stay null.

## 4. Source conservation (rows)

| Cohort | Named rows | Numbered | Student rows | Other rows in the table span |
| --- | --- | --- | --- | --- |
| PSW April 2026 | 41 | 41 | 41 | 2 totals |
| PSW June 2026 | 28 | 27 | 28 | 4 placeholder seats, 2 totals |
| PSW August 2026 | 18 | 17 | 18 | 1 `#REF!` seat, 2 totals |
| PSW September 2026 | 16 | 14 | 16 | 2 placeholder seats, 1 `#REF!` seat, 2 totals, 8 below the table |
| ECEA | 54 | 48 | 54 | 3 empty serials, 1 totals |
| French | 2 | 0 | 2 | 55 empty serials, 1 totals |
| **Total** | **159** | **147** | **159** | |

Every row of every table span is in exactly one class (tested).

## 5. March 2026 — preserved from hosted, in legacy mode

Two hosted batches on sheet `March 2026`; kept with their ids and every value.

| Batch | Records | Payments | Amount |
| --- | --- | --- | --- |
| March 26 - Morning | 15 | 16 | $17,046.00 |
| March 26 - Evening | 10 | 6 | $5,591.00 |

25 students · 25 finance records · 150 installments ($142,625.00) · 22
payments ($22,637.00, dated 2026-02-14 → 2026-03-25, method on all 22) · 34
column-layout rows · stated fees $147,586.00 · stated Total Paid $121,338.00 ·
stated balance −$26,248.00. No March student has any other record.

**Approved: legacy mode.** March's 22 payment rows came from the historical
Tracker Master, which ended in late March 2026: $22,637.00 against the sheet
snapshot's Total Paid of $121,338.00 (21 of 25 records disagree). They are
preserved exactly, as historical evidence, not as a complete ledger. March is
`legacy_balance` (`collection_mode`): collections use the preserved balance snapshot
(`legacy_balance`), the 22 rows are never used alone to state what was paid,
and none of them gets a retroactive receipt. New payments and their receipts
after the cutover are unaffected.

## 6. Target dataset and financial conservation

### Identity

- One person per **exact student number**; no match on name, email, phone or
  a near-identical number (tested with look-alikes).
- 132 workbook students match exactly one hosted student and **re-use that
  row and id** (names and contacts untouched; 2 are spelled differently in the
  workbook — the spelling stays in provenance). 15 numbered students are new
  (14 September, 1 August). 12 number-less rows each get their own new student
  keyed on the source row (June 1, August 1, September 2, ECEA 6, French 2).
- No student number appears twice in the target, so every student has one
  finance record; the schema would also allow one person in several cohorts.
- 4 hosted number-less students in the old April/June/August/ECEA tables are
  not carried over (they cannot be matched without names); their workbook
  counterparts are the new number-less rows above.

### Payments

The replacement workbook has no Tracker Master. Each non-blank cell in a
table's money-received columns (PSW: Enroll. Fee, the month columns, Late
Fees; ECEA: Enrollment fees, 1st/2nd Installment, Late fees; French:
Enrollment fees, 1st/2nd Installment, sept, oct) becomes **one payment** with
`payment_date` and `payment_method` NULL and the cell in `legacy_raw_json`.
These are exactly the cells each row's own Total Paid sums, and there is no
second payment source, so nothing is counted twice. Schedules stay
installments; installment month and due date stay NULL (no year is stated).

### Conservation by cohort

| Cohort | Records | Stated fees | Row Total Paid | Sheet totals-row Total Paid | Payments | Installments |
| --- | --- | --- | --- | --- | --- | --- |
| PSW March 2026 (hosted) | 25 | $147,586.00 | $121,338.00 | — | 22 / $22,637.00 | 150 / $142,625.00 |
| PSW April 2026 | 41 | $223,281.00 | $183,122.44 | $177,292.49 | 184 / $183,122.44 | 222 / $198,505.00 |
| PSW June 2026 | 28 | $156,732.00 | $89,526.25 | $88,566.25 | 95 / $89,526.25 | 168 / $150,220.00 |
| PSW August 2026 | 18 | $96,570.00 | $34,825.75 | $25,745.75 | 38 / $34,825.75 | 102 / $91,205.00 |
| PSW September 2026 | 16 | $85,840.00 | $15,215.00 | $15,215.00 | 16 / $15,215.00 | 90 / $80,475.00 |
| ECEA | 54 | $60,016.09 (22 rows state none) | $53,263.98 | $63,211.98 | 79 / $63,211.98 | 0 |
| French | 2 | none stated | none stated | $1,525.00 | 7 / $1,650.00 | 0 |

For every workbook cohort the payments equal the money-received cells
exactly, and every totals-row figure is explained by the rows it covers. The
differences against the sheets' own totals rows are source inconsistencies,
reported and **not corrected**:

- **Totals rows missing a column.** The totals row states no figure under a
  money column that holds payments (April's October and Late Fees, June's and
  August's October, French `oct`), so the sheet's grand Total Paid leaves that
  money out. With April's totals formulas stopping one row short (below), this
  explains April's $5,829.95 gap, June's $960.00 and August's $9,080.00.
- **Totals formulas that stop short** (April Evening: several `SUM`s end one
  row above the last student).
- **Totals that include placeholder seats** (June, September fees).
- **French `oct`** is left out of the totals-row Total Paid formula
  (`SUM(K:N)`), hence $1,525.00 vs $1,650.00.
- **ECEA**: 13 rows have payments but no Total Paid cell; the Balance column
  is empty throughout; 22 rows state no fee.
- **Schedules are templates**: 11 April, 16 June and 11 March records have an
  installment schedule ($5,365) that differs from the row's stated total fee.
- Balances are kept as stated; none was recomputed.

## 7. Hosted state: CURRENT → DELETE → TARGET

Live baseline (linked SQL, 2026-10-21) equals the ticket's expected baseline:
programs 2 · batches 23 · students 385 · finance records 397 · installments
1825 · payments 1013 · receipts 0 · receipt deliveries 0 · reminder
deliveries 0 · import batches 1 · import exceptions 1 · batch finance columns
383 · audit log 0 · `students.email` non-NULL 0 · `students.phone` non-NULL 0.

| Table | Current | Delete | Retained | Insert | Apply audit | Target |
| --- | --- | --- | --- | --- | --- | --- |
| programs | 2 | 0 | 2 | 1 (French) | 0 | 3 |
| batches | 23 | 21 | 2 | 10 | 0 | 12 |
| students | 385 | 228 | 157 | 27 | 0 | 184 |
| student_finance_records | 397 | 372 | 25 | 159 | 0 | 184 |
| installments | 1825 | 1675 | 150 | 582 | 0 | 732 |
| payments | 1013 | 991 | 22 | 419 | 0 | 441 |
| receipts | 0 | 0 | 0 | 0 | 0 | 0 |
| receipt_deliveries | 0 | 0 | 0 | 0 | 0 | 0 |
| reminder_deliveries | 0 | 0 | 0 | 0 | 0 | 0 |
| import_batches | 1 | 0 | 1 | 1 | 0 | 2 |
| import_exceptions | 1 | 0 | 1 | 18 | 0 | 19 |
| batch_finance_columns | 383 | 349 | 34 | 137 | 0 | 171 |
| audit_log | 0 | 0 | 0 | 0 | 1 | 1 |

- **Removed batches (21):** 20 PSW (every 2025 intake, Dec 2025, Jan 2026,
  and the historical copies of the April/June/August 2026 tables) and the
  historical ECEA batch. Removed finance records include all 22 unassigned
  records.
- **Retained students (157)** = 25 March + 132 re-used by exact number.
  **Deleted students (228)** are referenced only by removed records.
- **Dated hosted payments of target students:** 19 (ECEA 5, April 9, June 5;
  $18,743.22) are removed with their old records — every one reconciled in
  §7.1; none carries money the target would lose.
- **Import exceptions (18 new):** placeholder seats 6, misplaced numeric
  values 3, cells outside the table 3, below-table notes 4, `#REF!` rows 2.
- Foreign-key invariants (every remaining or inserted row's parents exist;
  no remaining record points at a deleted student; no inserted id collides
  with a retained one): **none violated.**

### 7.1 The 19 dated hosted payments of target students — reconciled

Each payment was tied to an enrollment by exact evidence only (the historical
import's own routing to one batch table; the Tracker Master batch cell's
month against each enrollment's month; a student with a single enrollment),
then compared with the target record by payment order, cell and cumulative
total. Equal amounts alone never decided anything. Row-level detail (UUIDs,
records, amounts, dates, methods, provenance, evidence):
`.private/finance-cutover-05a/dated-payment-reconciliation.json`.

| Class | Payments | Amount | Target cohorts | Kept in target |
| --- | --- | --- | --- | --- |
| A. REPRESENTED_IN_NEW_WORKBOOK | 7 | $6,313.77 | ECEA 5, April 2 | no — already in the workbook cells; keeping them would double-count |
| B. NOT_REPRESENTED_IN_NEW_WORKBOOK | 0 | $0.00 | — | — |
| C. AMBIGUOUS | 0 | $0.00 | — | — |
| PRIOR_ENROLLMENT_NOT_TARGET_MONEY | 12 | $12,429.45 | June 5, April 7 (two students) | no — see below |

- **A, 7 payments.**
  - 3 equal the cell at their position in the student's payment order
    (enrolment fee or 1st installment) on the row the historical import
    routed them to.
  - 2 fit inside the cell at their position, with the student's payments to
    that enrollment inside the row's ACTUAL total, which states the fee fully
    paid.
  - 1 April deposit equals the April Enroll. Fee cell on its routed row.
  - 1 April deposit, dated January 2026, belongs to a retired January 2026
    enrollment. The student's stated total fee minus the April record's fee is
    exactly that deposit, so April's fee is already net of it.
- **Prior-enrollment payments, 12.** These are dated March 2025 – January
  2026 and carry `Mar-25` / `Aug-25` batch cells. They are the complete
  payment histories of two **earlier, completed 2025 enrollments** of
  students who re-enrolled in April and June 2026. One sums exactly to that
  2025 cohort's Total Paid; the other is $82.55 above it.
  - They are not in the new workbook. They are also not money paid toward the
    2026 enrollment, whose workbook row is self-contained (its own fee and its
    own payments).
  - Attaching them to the 2026 record would wrongly show those two students
    $5,756.00 and $6,673.45 in credit.
  - They therefore leave with their retired cohorts, like every other
    historical cohort's payment, and stay in the backup and the restore.
  - This class sits outside the brief's A/B/C on purpose. It is not
    double-counted money (A), not money the target would lose (B), and not
    undeterminable (C).
- **B and C both block the plan** (an invariant violation). B would need a
  reviewed preservation step, which does not exist because no payment needs
  it. Result: **0 payments preserved**. The target payment count stays
  **441**, and no reminder amount changed.
- **Receipts:** none of the 19 is preserved, so none is
  historical-receipt-capable. A preserved one would be flagged capable only
  with a student number, an amount, a date and configured program numbering;
  generating any historical receipt stays a later, explicit decision.

## 8. Contact readiness (exact student number only)

184 target students; nothing is written (contacts remain NULL on hosted).

| Status | Students |
| --- | --- |
| CONTACT_READY | 159 |
| CONTACT_MISSING | 8 (all September; the numbers are in no master) |
| CONTACT_SHARED_REVIEW | 5 (PSW 2, ECEA 3) |
| MISSING_STUDENT_NUMBER | 12 |
| CONTACT_INVALID | 0 |
| CONTACT_AMBIGUOUS | 0 |

Workbook named rows with an exact master match: **139 of 159** (the 20 others:
12 without a number, 8 September numbers not in the PSW master). September
rows are imported regardless; their contacts stay NULL and are flagged.

A contact apply after the cutover must be a **new** 04B2 dry run against the
post-cutover data. The superseded 220-student plan (hash `83b73358…`) must
never be run.

## 9. Collection mode — a persisted generic column

Migration `20261021120000_finance_record_collection_mode.sql` (additive; no
earlier migration edited) adds `student_finance_records.collection_mode`,
nullable text, constraint `student_finance_records_collection_mode_check`:

| Value | Meaning | Cohorts | Records after cutover |
| --- | --- | --- | --- |
| `installment` | schedule through the current calendar month − paid toward it | PSW April, June, August, September | 103 |
| `legacy_balance` | preserved balance snapshot is the basis; old ledger is evidence only | PSW March | 25 |
| `balance` | stated fee − recorded payments; no reliable installment dates | ECEA | 54 |
| `configuration_incomplete` | not safe for automated collection | French | 2 |

NULL means "not decided".

**Applied to hosted 2026-10-21.**
- Run with `supabase db push --linked` after confirming the linked project
  is `hwekiiompxixybxclche` and that a dry run listed only this migration.
- Migration list is now 8 local = 8 remote.
- Verified on hosted:
  - the column and constraint exist, and all 397 existing rows are NULL;
  - `authenticated` holds SELECT and UPDATE on the column through the
    table-level grants;
  - visibility is governed by the unchanged `can_read_finance()` row policy,
    so 05B can query it under normal finance RLS.
  - `anon` holds the table-level SELECT grant every public table has; RLS has
    no `anon` policy, so it sees no rows. This is unchanged.
- No financial value changed: the backup re-captured afterwards is
  value-for-value identical on all 3,630 rows, apart from the new NULL
  column.

**The cutover writes it on all 184 target records.**
- The 159 inserted records carry it in the row.
- The 25 retained March records are set to `legacy_balance` by an `UPDATE`
  inside the same transaction. It is count-checked and only touches rows
  whose value is still NULL. It bumps those rows' `updated_at`, the only
  change to any March row.
- The post-state gate requires exactly 103 / 25 / 54 / 2 and no NULL.
- The audit row still records the per-mode id lists.

## 10. Collection readiness (as of 2026-10-21; nothing sent)

Recomputed on the final target (which includes every dated payment that had
to survive: none). Every figure is unchanged from the previous pass.

**PSW, `installment`.** Amount due through the month =
cumulative scheduled amount through **October 2026** − paid toward the
schedule. No due day is inferred ("scheduled through October 2026", never
"due 1 October"); remaining tuition is never "due". Payments under a Late Fees
column are real money but are not applied to the schedule (April: 2 records,
$1,300.00). Each schedule column's year comes only from the batch start date
and column order; all 8 batches map deterministically:

| Batch(es) | Start | Enroll. Fee | September … January |
| --- | --- | --- | --- |
| 27th April 2026 Morning/Evening | 2026-04-27 | 2026-04 | 2026-09 … 2027-01 |
| 1st June 2026 Morning/Evening | 2026-06-01 | 2026-06 | 2026-09 … 2027-01 |
| 29th July 2026 Morning/Evening | 2026-07-29 | 2026-07 | 2026-09 … 2027-01 |
| 28th Sept 2026 Morning/Evening | 2026-09-28 | 2026-09 | 2026-09 … 2027-01 |

Every PSW schedule is the same Sep–Jan template whatever the start month, so
April and June students have nothing scheduled May–August. That is the source,
not a mapping choice.

| Cohort | Records | Calculable | Contact-ready | Current | Amount due through Oct | Credit/ahead | Cannot determine | Due and contact-ready | Amount due |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| April | 41 | 37 | 40 | 1 | 4 | 32 | 4 (no schedule) | 4 | $1,810.00 |
| June | 28 | 28 | 26 | 0 | 10 | 18 | 0 | 8 | $16,223.00 |
| August | 18 | 17 | 17 | 3 | 12 | 2 | 1 (no schedule) | 11 | $15,279.25 |
| September | 16 | 15 | 6 | 0 | 15 | 0 | 1 (no schedule) | 6 | $25,625.00 |

**PSW March, `legacy_balance`.** All 25 have a preserved balance; 8 show
a balance outstanding ($26,248.00, equal to the stated balance), 17 are
settled; all 25 are contact-ready, so 8 are `LEGACY_BALANCE_REMINDER`
candidates (balance/account wording). The snapshot dates from the historical
workbook and may be stale.

**ECEA, `balance`.** 32 of 54 state a fee; 17 have a balance
outstanding ($15,504.85), 16 of them contact-ready; 14 settled, 1 in credit;
22 cannot be determined (no fee stated). This population (and every other
reminder candidate, 66 records) is frozen for 05B in
`.private/finance-cutover-05a/balance-population.json`
(sha256 `15b087e74679b6c719c0e941a77e32e8194e285039350cdc5713f8f8eaad65ee`).

**French, `configuration_incomplete`.** 2 records, both
`BLOCKED_MANUAL` and flagged `FINANCE_CONFIGURATION_INCOMPLETE` and
`CONTACT_INCOMPLETE` (no student numbers). No automatic reminder, no receipt;
it does not block the cutover.

## 11. Receipt readiness

- **Historical payments deliberately NOT receipt-eligible: all 441** carried
  by the cutover — 419 workbook cell payments (no date, no method) and March's
  22 (incomplete ledger). No receipt is created retroactively.
- **Rule for new payments** (`receiptIneligibility` in `readiness.mts`): an
  identifiable student, a finance record, an amount, a payment date and the
  program's receipt numbering. The method is optional and never invented. Any
  payment with `source = 'legacy_import'` is historical and never eligible
  (all 1,013 hosted payments and all 419 new ones are `legacy_import`).
- **Receipt numbering configured:** PSW, ECEA. **Not configured:** FRENCH.
- **Infrastructure:** the `receipts`/`receipt_deliveries` schema and program
  numbering columns exist; the app has no payment-entry or receipt-generation
  code yet. `receipts.student_suffix` is the student number without the
  program prefix, so the 12 number-less students (French 2, ECEA 6, PSW 4)
  will need a numbering decision before their first receipt.

## 12. Private backup and restore

| | |
| --- | --- |
| Backup | `.private/finance-cutover-05a/hosted-backup.json` (+ manifest) |
| Backup sha256 | `fe8acfb6679d085f092ab6d835c070fdc91fe274c3105cb733f6e5fe10703060` (7,299,689 bytes) |
| Restore manifest | `.private/finance-cutover-05a/restore-manifest.json` |
| Restore manifest sha256 | `abb5bda0a51a75c8ed4577f07de83fab81135753473aea542559e304c9225789` |
| Restore files | `.private/finance-cutover-05a/restore/`: 10 stage files, 1 swap, 1 cleanup (largest 1,820,861 bytes) |

The backup was re-captured after the `collection_mode` migration, which
changed the stored row text of `student_finance_records` (one more column,
NULL). Compared row by row with the previous backup (sha256
`62f6c000…3d09`, kept beside it as `*.previous`), all 3,630 rows hold
identical values. The only differences are the new column, NULL on all 397
finance records, and therefore that table's full-row md5; every id set is
unchanged.

Backup proof: it reads back and parses, its sha256 equals the manifest, and
for every table the row count and id set equal the live fingerprint. Hosted
was unchanged before and after. The restore re-inserts `collection_mode` as
NULL on every restored finance record, as the field was before the cutover.

**Why the restore is staged.** The Management API rejects request bodies
above about 2.5 MB (measured with harmless `select length(...)` probes: 2.5 MB
accepted, 3 MB rejected with HTTP 413). The backup is 5.6 MB of row data, so:

1. **Stage** (10 files, each under 2.4 MB): load the backup rows into
   `cutover_05a_restore.restore_rows`, a schema with every privilege revoked
   from `public`, `anon` and `authenticated`. Idempotent; touches no finance
   table.
2. **Swap** (one DO block, one transaction):
   - refuses unless the session first runs
     `set finance.cutover_05a_restore = '<backup sha256>'`;
   - refuses if receipts or deliveries exist that the backup does not hold;
   - proves the staging table holds exactly the backup (count and id set per
     table);
   - deletes the twelve finance tables children first (never the audit log)
     and re-inserts every row parents first, with original ids and
     timestamps;
   - requires the count, id set and full-row md5 of every table to equal the
     backup's, then writes one audit row;
   - any mismatch rolls back.
3. **Cleanup**: drop the staging schema.

**Restore verification (run; no live row read or written, nothing created on
hosted):** each of the 10 chunks was inserted into a temporary copy of its
real table (structure, checks and keys copied from `public`) through the same
`jsonb_populate_recordset` path. Every restored row had to equal its
backed-up row column for column (`to_jsonb(row) = backup row`); then the
block raised and rolled back. All passed: programs 2, batches 23, students
385, finance records 397, installments 1,825, payments 1,013, import batches
1, import exceptions 1, column layout 383 (receipts, deliveries and audit log
hold no rows). The swap was sent with a `raise` before its first statement
and parsed and compiled. Offline, every chunk covers its table's rows exactly
once with the fingerprint's id set, and every foreign key inside the backup
resolves. The restore was **not** executed against live data.

Size ceiling: every generated statement is checked against 2,400,000 bytes.
The cutover apply statement is 1,769,440 bytes; it is a plan blocker if that
is ever exceeded.

## 13. Hashes and the cutover command

| | sha256 |
| --- | --- |
| Finance workbook | `0d32527990b140d7ab587ee53841e27df87fbff50da4b09b28a9e278376a2dfe` (unchanged) |
| Backup | `fe8acfb6679d085f092ab6d835c070fdc91fe274c3105cb733f6e5fe10703060` |
| Restore manifest | `abb5bda0a51a75c8ed4577f07de83fab81135753473aea542559e304c9225789` |
| Target dataset | `004e80f207f87d50bec5da1fdfa7f02259f0e47e88246f5dd576a98774c1eeb0` |
| Cutover plan | `8361f0abe6d3fbc77463481a6d87a388dd865a53d923fe61ba44b95c42662bd9` |

These replace every earlier target and plan hash. Those are void, and the
real CLI refuses the previous plan hash with `PLAN_HASH_MISMATCH`. The target
now writes `collection_mode`, and the plan carries the dated-payment
reconciliation, the March `collection_mode` update and the post-state mode
counts. Both hashes reproduce exactly across dry runs. Counts are unchanged
from §7. The command that **would** execute the cutover (not run):

```
npm run finance:cutover -- --apply --plan-hash=8361f0abe6d3fbc77463481a6d87a388dd865a53d923fe61ba44b95c42662bd9
```

## 14. Cutover safeguards

- **Gate (before anything is sent):**
  - `--apply` and the exact plan hash;
  - the approved workbook hash;
  - the backup present, verified, and equal to the planned backup;
  - the restore manifest and every restore file present and unchanged;
  - the live fingerprint equal to both the plan's pre-state and the ticket
    baseline;
  - the plan recomputed now hashing to the approved value;
  - no blocker.

  Each refusal is tested. The real CLI refused `--apply` with no hash and with
  a wrong hash (exit 5, nothing written).
- **One transaction:** the apply is a single DO block.
  - Inside, the pre-state fingerprint must match before anything is touched.
  - Deletes run in FK order and inserts in dependency order, each checked
    against its exact count.
  - One `audit_log` row records the hashes and the collection modes.
  - The post-state counts and a dangling-reference check must hold.
  - Any failure rolls the whole statement back.
- **Probe (run):** the same statement with a leading `raise` was accepted and
  parsed; no planned insert column is missing on hosted.
- **After commit:** the CLI re-reads the fingerprint and compares every count
  with the plan (exit 7 on a difference). Recovery is the staged restore
  (§12).
- **Safety check, re-run for this pass (all ok):**
  - the backup parses and its hash is unchanged;
  - the restore manifest and its files match and verify;
  - the target and plan hashes are stable;
  - the workbook hash is unchanged;
  - the live fingerprint equals the planned pre-state and the backup;
  - email/phone are 0 non-NULL and `audit_log` is 0, so no contact apply has
    run;
  - live counts equal the pre-cutover baseline, so no cutover has run.

## 15. Remaining items (none blocks the cutover itself)

1. Reviewer confirmation of the 12 PRIOR_ENROLLMENT_NOT_TARGET_MONEY
   payments (§7.1). They are classified with exact evidence and kept out of
   the target, but the class is not one of the brief's A/B/C.
2. 05B: reminder wording for amount-due-through-month, legacy-balance and
   balance; reading `collection_mode` on finance screens.
3. French: receipt numbering and student numbers when the program is set up.
4. A contact apply after the cutover must be a NEW 04B2 dry run on the
   post-cutover data.
5. REST-based QA cannot run from this network (REST host DNS-filtered); run
   the post-apply UI check where the project host resolves.
6. Any change to any finance row before the apply voids the plan; re-run the
   dry run and re-review.

## 16. Verification

- `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`: see the
  final report of this pass.
- `npm run finance:cutover -- --probe-sql --verify-restore`: exit 0; the
  restore verified; the apply statement parsed; the hosted fingerprint was
  identical before and after.

## 17. Narrowed first launch — PSW June / August / September 2026 (2026-11-02, NOT applied)

Business priority changed: the first live scope is only PSW June, August and
September 2026. The full plan above (§1–§16, hash `8361f0ab…`) is kept
unchanged and still reproduces; it is **not** the plan to run now.

`npm run finance:cutover:launch` (`scripts/finance-cutover/launch.mts`) builds
a **scoped, non-destructive** plan with the same parser, identity rules, cell
payments, backup, staged restore, gates and single DO block. Output:
`.private/finance-cutover-05a/launch-jas/`.

- Replaced: only the 4 superseded hosted June/August batch tables (28 + 17
  records, 270 installments, 60 column rows, **0 payments**). September is new.
- Retained by id: every other hosted row (March, April, 2025 cohorts, ECEA,
  unassigned, import history) and **every student** (0 student deletes; a
  scoped plan that would delete a student or a batch outside the scope blocks).
- Hosted unchanged since the 2026-10-21 backup (fingerprint equal), so backup
  `fe8acfb6…` and restore manifest `abb5bda0…` remain the recovery path.
- Counts: batches 23→25, students 385→404, records 397→414, installments
  1825→1915, payments 1013→1162, import exceptions 1→13, column rows 383→411,
  audit 0→1. `collection_mode`: installment 62, NULL 352 (untouched).
- Target `5f0e04f4eff5e1afb527b832f644328b2e1686180837fbf6a658aec2df762ff6`,
  plan `80c0d1b517735b704bd511c7ba221a9107ed8dabc47c2b6d7f26f24fade42f47`,
  apply statement 833,007 bytes.
- Dated hosted payments of launch students: 5 ($5,756.00), all on an
  unassigned record of one June student's 2025 enrollment — kept, untouched,
  not counted toward the June record. None on a replaced record.
- Gates: BOTH the row-count baseline (`LAUNCH_EXPECTED_BASELINE`, re-read
  2026-11-02, equal to the 2026-10-21 counts) AND the exact pre-state
  fingerprint (count, id-set md5, full-row md5 per table, email/phone
  counts) must hold; the DO block re-checks the fingerprint inside the
  transaction.
- Supabase CLI pinned to `supabase@3.0.0`. 3.x refuses statements from an
  agent run unless `--read-only` (every read) or `--yes` (consent). The probe,
  `--verify-restore` and `--apply` pass `--yes` and are human-run only.
