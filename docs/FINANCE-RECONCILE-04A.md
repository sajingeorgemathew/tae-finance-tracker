# FINANCE-RECONCILE-04A — Unassigned finance record forensics

Follows [FINANCE-IMPORT-02-APPLY](FINANCE-IMPORT-02-APPLY.md) (the import that
created the records), [FINANCE-GRID-03](FINANCE-GRID-03.md) and
[FINANCE-GRID-03C-USABILITY](FINANCE-GRID-03C-USABILITY.md) (the screen they
appear on). It answers one question with evidence: why do the 22 imported
finance records under **Unassigned — no batch** look as if they hold little or
no financial information?

This was a read-only ticket. No record was assigned, moved or merged; no
student number was resolved; no payment, receipt, reminder or audit row was
written; no hosted row changed. The one code change to the application is a
read-only presentation improvement, justified in §9.

## Privacy

This document contains no student names, no student numbers, no per-student
amounts, no workbook row numbers and no remarks. Aggregate counts, batch names,
rules and code paths only. Row-level evidence — identity, source rows,
payments, candidate batches, routing notes — is in
`.private/finance-qa/unassigned-forensics.json` and `.csv`, which Git ignores.

---

## 1. The answer, in one paragraph

The records are not empty. **41 of the 1,013 imported payments hang off them**,
every one of those 41 reaches the browser, and the drawer renders every one.
They *look* empty because an unassigned record has **no batch sheet row behind
it**: the import created it from Tracker Master transactions it could not tie
to exactly one batch table, so there is no ACTUAL section, no INSTALLMENT
section, no Total Paid and no Balance to show, and the grid (correctly) shows
none of those. Until this ticket the only visible figure on the row was
Payment Status *Unknown* and a blank Balance, and the payments were reachable
only by opening Details. The data path is sound: **0 payments are lost**
between the database and the screen. The gap was presentation, and §9
closes it with normalized data only.

## 2. Pre-flight and baseline

- Branch `feature/finance-reconcile-04a-unassigned-forensics`, created from
  `main` at the merge of FINANCE-GRID-03C (`3d02591`).
- Hosted project `hwekiiompxixybxclche`; workbook hash
  `62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2`,
  unchanged before and after every run.
- Baseline gates before any change: 544 tests, lint clean, typecheck clean.

Hosted counts, read under the admin session with Row Level Security enforced
(service role used only to mint the one-time token), identical before and
after every audit run:

| Table | Count |
| --- | ---: |
| batches | 23 |
| students | 385 |
| student_finance_records | 397 (375 batch + 22 unassigned) |
| installments | 1,825 |
| payments | 1,013 |
| receipts | 0 |
| receipt_deliveries | 0 |
| reminder_deliveries | 0 |
| import_batches | 1 |
| import_exceptions | 1 |
| audit_log | 0 |

## 3. The audit tool

`npm run finance:unassigned-audit` (`scripts/finance-qa/unassigned-audit.mts`).
Read-only. For every finance record with `batch_id IS NULL` it:

1. reads the hosted rows under RLS — record, embedded student, installments,
   payments (the loader's own projection, read out of `load.ts` so it cannot
   drift), plus, on the private path only, each unassigned payment's preserved
   provenance so it can be traced to its Tracker Master row;
2. rebuilds the approved import plan from the workbook and joins it on the
   importer's deterministic v5 ids, so every record and every payment is tied
   back to the exact source rows that produced it;
3. runs the real `src/lib/finance/grid/load.ts` under Node (the module hooks
   from `loader-request-count`) and captures the `payments` REST response on
   the way past, then reads the view model it builds, then — when a local dev
   server is up — opens the Unassigned view in headless Chrome as the admin and
   opens every record's drawer;
4. grades batch and identity evidence with the pure rules in
   `unassigned-forensics.mts` (unit-tested, 32 tests), and writes the
   row-level JSON and CSV privately and an aggregate with no PII to the console.

It exits non-zero if payment conservation fails, if any payment is lost at any
UI stage, if the workbook hash changes, or if any hosted count changes.

## 4. Payment conservation

| | Payments |
| --- | ---: |
| attached to batch (assigned) finance records | 972 |
| attached to unassigned finance records | 41 |
| attached to no known record (orphaned) | 0 |
| **total** | **1,013** |

972 + 41 = 1,013. Every payment row is accounted for. No payment is voided.

Across the 22 unassigned records:

| Payments on the record | Records |
| --- | ---: |
| 0 | 1 |
| 1 | 14 |
| 2 or more | 7 |

Installments linked to unassigned records: 0 (an installment always belongs
to a batch-sheet row, and these records have none).

## 5. What the 22 records hold

| Fact | Records |
| --- | ---: |
| unique students represented | 22 |
| with a student number | 19 |
| with no student number (unresolved identity) | 3 |
| with a `legacy_total_fee` value | 15 |
| with a `legacy_total_paid` value | 0 |
| with a `legacy_balance` value | 0 |
| with a batch-sheet snapshot (source sheet/row) | 0 |
| with no financial figure of any kind and no payment | 1 |
| whose Tracker Master rows state conflicting fee values | 0 |

The 15 fee values are **not batch snapshots**. They are Tracker Master's
*Enrollment Total Fees*, which the workbook states once per student on their
first transaction row; the importer copies it to the unassigned record only
when every row that states it agrees. Total Paid and Balance were never
recorded for these records and are not calculated: Tracker Master's *Balance
Fees* is a row-local formula and is deliberately never mapped to a balance.

Receipt values on the 41 payments: `YES` 39, blank 2. Payment methods are the
workbook's spellings (`Etransfer`, `ETRANSFER`, `Mastercard`, blank). 3 of the
41 payments have a paid-date cell that could not be read as a date; the drawer
shows them last with "No readable date".

## 6. Why 22 records exist — origin and routing

### 6.1 Transaction rows versus finance records

The import report counted **transaction rows**; this ticket counts **finance
records**. They differ by design.

| Routing outcome (per Tracker Master row) | Rows | → unassigned records |
| --- | ---: | ---: |
| unique_batch | 972 | — (tied to a batch record) |
| ambiguous_batch | 19 | 5 |
| batch_not_found | 20 | 14 |
| missing_student_id | 3 | 3 |
| **rows that could not be tied to one batch** | **42** | **22** |

The importer keeps **one unassigned record per (student, program)** and routes
every unroutable row of that student to it. So 42 rows resolve to 22 records:
7 records hold two or more rows (one holds seven). 41 of the 42 rows became
payments; **1 was preserved as the import's single `missing_amount` exception
instead**, which is why one record has no payment. Every record's rows carry
a single routing outcome (0 records with mixed routing), and the reason the
importer wrote on each record agrees with the rebuilt plan for all 22.

The earlier informal split (5 ambiguous / 14 not found / 3 missing number)
is confirmed at record level.

### 6.2 Source-row traceability

All 22 records were found in the rebuilt plan as `kind: 'unassigned'`; all 42
Tracker Master rows the plan tied to them were traced; all 41 planned payment
ids exist in the hosted `payments` table and all 41 hosted payments are in the
plan (0 extra, 0 missing); the 1 exception id exists in `import_exceptions`
and its `would_be_entity_source_key` is the amount-less row's payment key.
No unassigned record aggregates rows from more than one program.

### 6.3 Origin categories

| Category | Records |
| --- | ---: |
| A — Tracker Master transaction(s) exist, batch unresolved | 21 |
| B — batch-sheet snapshot exists, batch unresolved | 0 |
| C — student identity unresolved | 3 (2 also A; 1 also D, E, G) |
| D — no payment and no financial figure | 1 |
| E — potential importer anomaly | 1 (the same record as D) |
| F — UI / view-model anomaly | 0 |
| G — created by an amount-less row preserved as an exception | 1 (the same record) |

Category G is not in the ticket's list and was not forced into D. It is the
case the single `missing_amount` exception produces.

### 6.4 The one empty record (§12 of the ticket)

The record with 0 payments comes from the last Tracker Master transaction row.
That row states **no student number, no name, no amount, no date, no method,
no batch cell** — only a Program label and a `Balance Fees` formula cell that
was dragged down from the row above and evaluates to `$0.00`. It was not
"every cell blank", so the importer treated it as a transaction: it created an
unresolved student (with no name), an unassigned finance record (with no
figures) and, because `payments.amount` is NOT NULL and no zero may be
invented, an import exception for the payment. Nothing was lost and nothing
was invented; but the record represents **no identifiable person**, and that
is why it is also counted as the ticket's one importer anomaly. It should
remain for audit. RECONCILE-04B should be able to mark it as an import
artifact rather than a student. The importer was not changed in this ticket.

## 7. UI path — where the 41 payments go

| Stage | Payments | Lost at this stage |
| --- | ---: | ---: |
| database (`payments` rows on the 22 records) | 41 | — |
| loader: the `payments` REST response the real `load.ts` receives | 41 | 0 |
| view model: `buildFinanceGrid` rows (`row.payments`) | 41 | 0 |
| independent rebuild of the same view model from the QA reads | 41 | agrees |
| drawer / browser: transaction rows rendered in headless Chrome, 22 drawers opened | 41 | 0 |
| **unexplained loss** | | **0** |

The Unassigned load costs 6 REST requests (programs, batches, the tally, the
records, installments, payments — no manifest), unchanged from GRID-03C. The
view model for the unassigned records has `layoutSource: 'none'`, 0 ACTUAL
columns, 0 INSTALLMENT columns, 22 rows all with Payment Status *Unknown*, an
unverifiable balance convention (no row records fee, paid and balance
together), and no truncation. The one zero-payment record renders the
drawer's "No imported payment is tied to this record" sentence rather than an
empty table. No console errors.

Conclusion: **no UI bug hides payments** (option B of the ticket's §3 is
ruled out at every stage). The empty look is option A applied to the *grid
columns* — no batch snapshot — not to the payments.

## 8. Main grid versus drawer — what belongs where

- **The Excel-style ACTUAL and INSTALLMENT groups** exist only for a batch
  table's rows: their columns come from that batch's column manifest and
  their values from the batch-sheet row. An unassigned record has neither, so
  the grid shows neither. That is correct and must stay: rendering those
  groups for these rows would either be blank for every cell or would invent
  structure.
- **Total Fee / Total Paid / Balance** are batch snapshots. For these records
  only the Tracker Master fee is available (15 of 22), and it is labelled as
  such in the drawer. Paid and Balance are blank, never `$0.00`, and Payment
  Status is *Unknown* by derivation, not by default.
- **Imported transactions** are the normalized `payments` rows and are the
  canonical transaction history for *every* record, batch or not. They need no
  batch manifest. They belong in the drawer's Imported transactions table — and,
  after this ticket, in a per-row count and sum on the grid — but never in the
  historical totals, never as a balance.

## 9. Read-only UI improvement (made)

The audit proved payments exist that staff could not see without opening each
row. The change surfaces normalized data and invents nothing:

- **Grid, Unassigned view only:** a new column group **Imported transactions
  (Tracker Master)** with *Payments* (count; `None` for zero), *Payments total*
  (sum of the record's payments; blank for none), *Last payment* (newest
  readable date), *Source batch cell* (the workbook's own `Batch` text, e.g.
  `Aug-25`, described in its tooltip as a month that cannot tell Morning from
  Evening) and *Why unassigned* (a badge from the importer's routing outcome:
  *In two batch tables* / *In no batch table* / *No student number*, with the
  routing rule in the tooltip). The group takes the space the ACTUAL and
  INSTALLMENT groups occupy for a batch; it is not shown for intakes, whose
  acceptance checks and column probes are unchanged. Rows also carry
  `data-record-id` and `data-payment-count` for QA.
- **Summary strip, Unassigned view only:** an *Imported payments* stat
  (41, on 21 of 22 records, 1 with none) and a sentence stating that no batch
  snapshot exists, that Total fees is Tracker Master's Enrollment Total Fees,
  and that a payments total is a transaction sum, not a balance.
- **Drawer, records with no batch:** *Why unassigned* and *Source batch cell*
  rows under "Where this record sits", and the Historical snapshot note now
  says no batch sheet row exists and where the fee came from.
- **Loader:** `PAYMENT_COLUMNS` projects one more JSON key,
  `legacy_raw_json->batch->>formatted_text`, as `legacy_batch_hint`, evaluated
  by PostgREST like `receipt_sent`. The rest of the payload still never
  crosses the wire; nothing raw reaches the browser (acceptance check
  unchanged).
- **View model:** `FinanceGridRow.unassignedReason` (a closed enum, read from
  the record's preserved JSON on the server, only when `batchId` is null) and
  `FinanceGridRow.sourceBatchHints`; `PaymentEntry.legacyBatchHint`. No
  balance, fee or schedule is derived from payments anywhere.

Not done, deliberately: no payment count column on intake views (it would
change the Excel-style column probes the acceptance run compares cell by
cell; a follow-up can add it with its own checks), no "candidate batch" on
the grid (§11), no write path of any kind.

## 10. Batch evidence, graded (§14 of the ticket)

Every candidate carries its strength; nothing is auto-selected.

| Assessment | Records | Evidence |
| --- | ---: | --- |
| human-assignable | 5 | the exact student number is listed in one or more batch tables for PSW (`strong`); 4 of the 5 are listed in two different batches, and 1 is listed on **two rows of the same batch table**, so for that one the batch is not in doubt but which of its two batch records should hold the money is |
| month hint only | 13 | in no batch table; only the Tracker Master `Batch` cell's month and year points at a Morning/Evening pair (`month`) — a hint that cannot choose a cohort |
| missing identity | 3 | no student number; nothing ties the record to a table and no name matching is performed |
| genuinely unresolved | 1 | in no batch table, and the `Batch` cell names a month and year (`Dec-26`) that no PSW batch has — including the undated December batches, whose workbook sheet states 2025 |

Candidate counts: 9 `strong`, 35 `month`, 0 `day` (no Tracker Master `Batch`
date equals a batch's recorded start date). Month matching compares the
batch's start date, or, for the six undated batches, the month and year the
**workbook sheet name** states (`Dec 2025`, `Jan 2026`, `March 26`); it never
assigns.

## 11. Student identity (§13 of the ticket)

For the 3 number-less records: the `Student ID` cell is blank on every one
of their Tracker Master rows (not an unreadable value); no email or phone was
imported for any student, so no contact identifier exists; an exact,
whitespace-collapsed, case-folded comparison of each row's name against every
spelling the workbook and the hosted `students` table hold for the 382
numbered students finds **0 exact matches** for the two named rows, and the
third row states no name at all. The two named rows spell **exactly the same
name as each other** (one payment each, six days apart); the data cannot say
whether that is one person paying twice or two people, so they are reported
as peers and not joined. All 3 identities are genuinely unresolved. No fuzzy
comparison was made and nothing was merged.

## 12. Tests and quality gates

New tests: `scripts/finance-qa/unassigned-forensics.test.mts` (32: conservation,
0/1/2+ buckets, routing reconciliation, origin categories including the
identity-less artifact, month matching by sheet name, evidence grading
including the twice-listed case, exact-name identity with unresolved peers, stage losses),
`src/lib/finance/grid/unassigned.test.mts` (reason reading and wording) and
four cases in `view-model.test.mts` (reason only for batch-less records;
payment count, total, last date and source hints without any manifest;
zero-payment presentation with no fabricated fee, paid or balance; a payments
total never becoming a balance). Fixture builders gained `legacy_batch_hint`.

Acceptance (`npm run finance:ui-acceptance`) gained checks for the
Imported transactions group and its headings, per-row payment counts summing
to 41 with `None` for zero, blank totals for zero and no fabricated balance,
the reason badges, the summary sentence and stat, the drawer's *Why
unassigned* and snapshot note, and a multi-payment record's drawer listing
exactly its payments with no batch manifest. The shared headless-Chrome
driver moved to `scripts/finance-qa/headless-chrome.mts` and the hosted read
helpers to `hosted-reads.mts`; `reconcile-grid.mts` imports both.

Results are in the completion report for the ticket. Expected: tests pass,
lint clean, typecheck clean, build clean, reconcile 23/23, acceptance all
checks, audit exit 0 with 0 unexplained loss and counts unchanged.

## 13. RECONCILE-04B — recommended write workflow (design only)

Evidence from this ticket supports these actions, each behind a confirmation
screen that shows the listed evidence, and none of which overwrites an
imported figure:

| Action | Applies to | Evidence to show before confirmation |
| --- | --- | --- |
| **Assign record to a batch** | the 4 human-assignable records listed in two batches | both batch tables naming the student, with sheet, table and row; the record's payments (dates, amounts, methods); the Tracker Master `Batch` cell; the batch's existing finance record for that student and its snapshot; a required reason |
| **Attach payments to an existing batch record** (rather than assigning the unassigned record) | the same 4, and the 1 listed twice in one table | the target batch record(s) with their snapshot figures; a statement that the unassigned record will be retired or kept; for the twice-listed case, both batch rows side by side so a person chooses one |
| **Assign with a month hint only** | the 13 month-hint records | must show the hint as a hint: the `Batch` cell, the Morning and Evening candidates, that no table lists the student, and require the person to pick a cohort explicitly; never pre-selected |
| **Keep unassigned intentionally** | the 1 genuinely unresolved, any month-hint record a person declines to place | the reason, a required note; the record stays visible and countable |
| **Resolve student number** | the 2 named number-less records | the source name, the blank ID cell, the zero exact matches; entering a number must be a typed, confirmed value with a reason, never chosen from a list of similar names |
| **Mark as import artifact** | the 1 identity-less record | the source row's content (a Program label and a dragged formula), the exception it produced; marks the record and its student as an artifact without deleting either |
| **Add reconciliation note** | any | free text, stored with the audit entry, never in `legacy_raw_json` |

Merging identities by name similarity is excluded. Linking an unresolved
student to a numbered one requires an exact external identifier that does
not yet exist in the data.

Every action is a new row, never an update to `legacy_total_fee`,
`legacy_total_paid`, `legacy_balance`, `legacy_raw_json` or any payment
figure. Assignment writes `batch_id` (and optionally a new
`student_finance_record_id` on a payment) and nothing else on the historical
row.

## 14. Audit-log requirements for 04B (design only)

The existing `audit_log` table (`actor_user_id`, `entity_type`, `entity_id`,
`action`, `before_data`, `after_data`, `metadata`, `created_at`) can hold every
field required; `metadata` carries the rest. Each correction must record:

| Field | Where |
| --- | --- |
| actor user id | `actor_user_id` |
| timestamp | `created_at` |
| action type (`assign_batch`, `move_payments`, `resolve_student_number`, `keep_unassigned`, `mark_artifact`, `add_note`) | `action` |
| finance record id | `entity_id` (with `entity_type = 'student_finance_record'`) or `metadata.finance_record_id` when the entity is a payment or student |
| student id | `metadata.student_id` |
| original batch id / new batch id | `before_data.batch_id` / `after_data.batch_id` |
| original and new student linkage, when relevant | `before_data.student_id` / `after_data.student_id`, or the payment's `student_finance_record_id` |
| reason (required, free text) | `metadata.reason` |
| evidence / reference | `metadata.evidence`: the batch table(s), source rows, `Batch` cell text and candidate strength shown at confirmation, plus the import batch id |
| before state / after state | `before_data` / `after_data`: the full mutable columns of the affected row(s), never the legacy figures, which cannot change |

Rules: one audit row per affected entity per action, written in the same
transaction as the change; historical imported figures are never overwritten
by a reconciliation action; an action that would change a legacy figure is
rejected, not logged.

## 15. Security and privacy

All reads used the authenticated admin session under RLS; the service role
minted the one-time token and read nothing. The full payment payload was read
only by the private QA path, for the 41 unassigned payments, and written only
to Git-ignored files. The browser receives one more projected key (the
`Batch` cell text); the acceptance run still finds no `legacy_raw_json`,
`raw_value`, `source_key`, `formatted_text` or key material in the served
page. Screenshots of the Unassigned grid and every drawer are under
`.private/finance-qa/screenshots/`, ignored by Git.
