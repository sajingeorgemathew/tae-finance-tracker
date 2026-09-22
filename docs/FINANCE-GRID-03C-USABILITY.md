# FINANCE-GRID-03C — Finance Tracker usability

Follows [FINANCE-GRID-03](FINANCE-GRID-03.md) (the grid) and
[FINANCE-GRID-03-ACCEPTANCE](FINANCE-GRID-03-ACCEPTANCE.md) (its
reconciliation). The grid was accurate; this ticket makes it easier to
operate. Where this document and GRID-03 disagree — batch selection, URL
state, the quick filters, the column groups — this document is current.

## Privacy

This document contains no student names, no student numbers, no amounts
attributable to a person, and no remarks. Batch names, column headings,
aggregate counts and rules only. Screenshots from the acceptance run live
under `.private/finance-qa/screenshots/`, which Git ignores.

---

## 1. What changed, in one paragraph

Staff now pick an **intake** — "29 Jul 2026" — instead of choosing between
"29th JULY, 2026 - Morning" and "29th JULY 2026 - Evening". Both cohorts show
together, with a **Session** column and a Session filter (All / Morning /
Evening). Each row carries a **Payment Status** (Outstanding, Settled, Credit,
Unknown) beside its historical **Balance**, and both sit in the frozen region
next to the student's name, so nobody scrolls through twelve months of figures
to learn whether money is owed. The status also drives the quick filters and
the summary strip, from one derivation. The Excel-style ACTUAL and INSTALLMENT
columns are unchanged and still scroll horizontally. **Nothing in the database
changed**: no batch was merged or renamed, no payment, installment, record,
receipt, reminder or manifest row was written, and every row still knows the
real batch it belongs to.

## 2. Read-only

No server action is defined or imported by any finance component. The loader
issues only `select` requests through the request-scoped Supabase client under
Row Level Security. Receipt and Reminder buttons remain `disabled` with the
tooltip "Available in a later workflow". Hosted row counts are unchanged.

## 3. Intake grouping — the algorithm

Implemented in `src/lib/finance/grid/intake.ts`; pure, tested.

**Two batches form one intake when, and only when:**

1. they belong to the same program, **and**
2. they were imported from the same workbook sheet — the same
   `batches.legacy_sheet_name` — **and**
3. each states a different session in its name: one Morning, one Evening.

The sheet is the deterministic source-structure fact the ticket asked for.
Every PSW sheet in the workbook holds exactly one Morning table and one Evening
table, and the importer recorded the sheet name on each batch it created
(`batches.legacy_sheet_name`, `batches.code = sheet!tableKey`). Grouping on it
is a lookup, not a comparison of titles: "18th August 2025 - Morning" and
"18 August 2025 - Evening" (different spellings) pair correctly, and two
batches whose names merely look alike never do. Nothing is fuzzy-matched.

Safety rules:

- A sheet group that is not exactly one Morning and one Evening (two Morning
  tables, a third table, a batch with no stated session) is **not merged** —
  each batch becomes an intake of its own.
- A batch with no recorded sheet is an intake of its own.
- Batches never group across programs.
- The unassigned records are not a batch and never join an intake.

The session of a batch is what its stored name states (`Morning` / `Evening`,
case-insensitive, whole word). It is never inferred from dates, order or
content. The finance records' preserved `legacy_raw_json.session` agrees for
all 22 PSW batches (verified by query, not used by the code).

Result on the hosted data:

| | Before | After |
| --- | ---: | ---: |
| Top-level PSW choices | 22 batches + Unassigned | **11 intakes** + Unassigned |
| ECEA | 1 batch | 1 intake (ELCE 25 & 26) |
| Batches in the database | 23 | 23, unchanged |

Underlying batch preservation: `FinanceIntake.underlyingBatchIds` and
`FinanceIntake.batches` carry the real ids and stored names; every
`FinanceGridRow` carries `batchId`, `batchName` and `session`; the drawer shows
the real batch. A future write workflow acts on `batchId` / `financeRecordId`,
never on an intake.

## 4. Labels, keys and ordering

| Source facts | Precision | Label | Key (`?intake=`) | Sorts on |
| --- | --- | --- | --- | --- |
| a `start_date` on an underlying batch | `day` | `29 Jul 2026` (`d MMM yyyy`) | the date, `2026-07-29` | the date |
| no `start_date`; sheet title is *Month YYYY* (`Dec 2025`, `Jan 2026`, `March 2026`) | `month` | `December 2025` — month and year only, no day | `2025-12` | the stated month |
| neither (`ELCE 25 & 26`) | `none` | the sheet title verbatim | a slug, `elce-25-and-26` | last, by label |

Rules:

- No day is ever invented. A month-titled intake shows only the month, and the
  selector adds `· no start date recorded`.
- A two-digit year in a title (`March 26`) is **not** expanded; only a bare
  month followed by a four-digit year is read. All three undated PSW sheets
  carry a four-digit year, so all three get a month label.
- Ordering is most recent first. A month-titled intake is placed by the month
  its title states — a fact the source gives at month precision — so December
  2025 sits between 6 Oct 2025 and 27 Apr 2026, as the ticket's example lists
  it. An intake stating neither a date nor a month sorts after everything
  that states something.
- Keys are unique within a program; a same-day collision would append the
  sheet slug. None occurs in the data.
- The default intake is the first in that order; the page note says which rule
  applied and that the intake combines both cohorts.

The 11 PSW intakes, as listed: 29 Jul 2026 · 1 Jun 2026 · 27 Apr 2026 ·
March 2026 · January 2026 · December 2025 · 6 Oct 2025 · 18 Aug 2025 ·
2 Jul 2025 · 12 May 2025 · 17 Mar 2025.

## 5. View model

`FinanceIntake { key, programId, programShortCode, displayName, sourceTitle,
underlyingBatchIds[], batches[], availableSessions[], latestStartDate,
datePrecision, studentCount }`.

`FinanceGridRow` gains `batchId`, `session` and `paymentStatus`; everything
GRID-03 put on it is still there. `FinanceGridView` now carries `intakes`,
`selectedIntake`, `statusCounts`, `sessionCounts`, one `batchConventions`
entry per real batch, and `legacyBatchRedirect` for old links.

## 6. Combined column manifest

`src/lib/finance/grid/intake-grid.ts`. Each batch is first built exactly as
GRID-03 built it — its own manifest, its own records, its own verified balance
convention — and the two grids are then placed side by side.

- **Same column**: same section, same source key (letter position) and the same
  heading, compared case-insensitively with whitespace collapsed. Shown once.
  "Late fees" / "Late Fees" (17 March 2025) is one column, labelled as the
  Morning table spells it.
- **Same letter, different heading**: two columns, side by side, each labelled
  verbatim. The workbook has "Mar" (Morning) and "Marc" (Evening) at column N
  on 6 Oct 2025, and "Late Fees" against "Feb" at column O on 18 Aug 2025.
  Nothing is renamed to force a match.
- **Column in one table only**: kept. Rows from the other table render **blank**
  (em dash) — their table had no such cell, and "no cell" is not `$0.00`.
- **Source labels** (final polish): a column only one cohort's table has
  carries that cohort as a compact secondary label — `Mar Morning` beside
  `Marc Evening` — and the model records the other heading at the same
  position (`FinanceColumn.conflictingHeadings`), so the tooltip can say
  "The Evening table heads the same column position “Marc”, shown beside it.
  Neither heading was changed." A column both tables share carries no label
  at all. Nothing is merged, renamed or re-keyed.
- **Order**: a merge of the two tables' own orders — Morning's sequence leads,
  Evening's extra columns are inserted after the column that precedes them in
  Evening, and two readings of one letter stay adjacent.
- ACTUAL and INSTALLMENT remain distinct groups; the installment union follows
  the same rules.
- Structural blank columns are counted over the combined rows and stated once
  in the strip. On 27 Apr 2026 this is now one column (October) rather than
  Morning's two, because Evening fills Late Fees.

The GRID-03B reconciliation script still builds each batch on its own and is
unaffected.

## 7. Payment Status

`src/lib/finance/grid/payment-status.ts`. One derivation, from one input: the
row's imported `legacy_balance`, read under the sign convention GRID-03
verifies **per batch** (`balance = paid − fee` across every record stating all
three figures).

| Reliable balance | Status |
| --- | --- |
| `< 0` | **Outstanding** |
| `= 0` | **Settled** (deliberately not "Paid") |
| `> 0` | **Credit** |
| blank, unparseable, or batch convention unverified/inconsistent | **Unknown** |

Not used, by test: payments, `fee − paid`, Tracker Master's `Balance Fees`
(the loader's payment select does not name it; a test reads `load.ts` to
prove it). ECEA's 50 rows are Unknown because the roster records no balance
and its convention cannot be verified — no status is manufactured for them.
The 22 unassigned records are Unknown for the same reason.

The row badge, the quick filters and the summary counts all read
`row.paymentStatus`; a test asserts the filter returns exactly the rows whose
badge shows that status.

Counts on representative intakes (from the acceptance run):

| Intake | Students | Outstanding | Settled | Credit | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| 29 Jul 2026 (6 + 11) | 17 | 13 | 0 | 0 | 4 |
| 27 Apr 2026 (15 + 26) | 41 | 30 | 10 | 1 | 0 |
| ELCE 25 & 26 (ECEA) | 50 | 0 | 0 | 0 | 50 |
| Unassigned — no batch | 22 | 0 | 0 | 0 | 22 |

## 8. Colour and status system

One restrained palette from the existing Tailwind tokens, used the same way in
the badge, the quick filters and the summary strip:

| Status | Colour | Glyph | Word |
| --- | --- | --- | --- |
| Outstanding | amber | `!` | Outstanding |
| Settled | emerald | `✓` | Settled |
| Credit | sky | `+` | Credit |
| Unknown | zinc (neutral) | `?` | Unknown |
| Legacy marker | amber outline, 10px | `⚠` | Legacy |

Every status carries its word and a glyph as well as its colour, so it survives
greyscale and colour-blindness. Rows are never coloured as a whole; figures stay
in plain ink; negatives stay red as before. Dark-mode variants are defined for
every token. Contrast: the pill text colours are the 800/900 shades on 50-tint
backgrounds (light) and 200 on 950/40 (dark), all above 4.5:1.

## 9. Grid layout

| Group | Columns | Frozen |
| --- | --- | --- |
| STUDENT | checkbox · Student # · Student name | always |
| STATUS | Session · Payment status · Balance | at ≥ 1280px |
| RECEIPT · REMINDER | Receipt · Reminder | no |
| ACTUAL FEE STRUCTURE (as recorded) | manifest union | no |
| INSTALLMENT FEE STRUCTURE (scheduled) | manifest union | no |
| ACTIONS | Details · Receipt · Reminder | no |

Frozen widths: 36 + 120 + 200 + 76 + 112 + 100 = **644px** with the Session
column (568px without). At 1366px the detail area still has ≈ 650px to scroll;
below 1280px the STATUS trio releases and only the STUDENT trio stays frozen,
so the Excel-like detail is never squeezed out. Verified in headless Chrome at
1600, 1366 and 1180px; the table is kept at every width and never becomes
cards. Frozen cell content is clamped to the declared width so the frozen
offsets are exact (the pixel comparison of the frozen region before and after
scrolling is identical).

Rows are 13px type on 28px rows (`py-[3px]`), denser than GRID-03's 32px.
The Session column is omitted where no row states a session (ECEA,
Unassigned); the Session filter is omitted where an intake has fewer than two
sessions.

## 10. Balance display

Unchanged: the imported figure, sign and all — `-$865.00`, `$0.00`, `$200.00`,
`—`. Nothing is flipped; the status beside it says what the sign means. The
Balance column is slightly heavier and sits in the frozen region.

## 11. Quick filters

`All · Outstanding · Settled · Credit · Unknown`, each with a count of what it
would show given the current session and search. They replace GRID-03's
`Balance due / Settled / Balance not recorded / Legacy receipt not sent` and
the disabled "Reminder needed" control:

| GRID-03 filter | Now |
| --- | --- |
| Balance due | Outstanding |
| Settled | Settled |
| Balance not recorded | Unknown |
| Legacy receipt not sent | replaced by the secondary **Receipt** filter below |
| Reminder needed (disabled) | dropped — no due-date rule exists, and the ticket forbids claiming "needed" |

No filter is ever disabled: Unknown is a real answer, so ECEA and Unassigned
simply count everything under it. Old `?filter=` links are mapped to the
matching `status` (§15).

**Secondary Receipt filter** (final polish): `All · Sent · Mixed · Not sent ·
Unknown`, labelled *Receipt legacy*, visually quieter than Payment Status and
separated from it. It filters on the row's historical workbook receipt status
— exactly what the Receipt cell shows (GRID-03 §9) — and nothing else. It
composes with intake, session, payment status and search; each pill's count
is what it would show given every other filter. It creates no receipt row,
and "Sent" here is not read as blocking future receipt generation. The URL
carries it as `receipt=` (§15).

**Old `filter=legacy_receipt_gap` links** meant "Not sent *or* Mixed". They
keep that meaning through a compatibility value, `receipt=gap`, that matches
exactly those two statuses and never Sent or Unknown. It is a legal URL value,
so the resolved narrowing survives refresh and back/forward, and it appears as
an active "Not sent or Mixed" pill beside the five normal pills only while it
is the active filter; choosing any normal pill drops it. It is not offered
otherwise, so the everyday UI stays at five pills.

## 12. Summary strip

Row one: Students (with Morning n · Evening n), Outstanding, Settled, Credit,
Unknown — from `row.paymentStatus`. Row two: Historical total fees, total paid,
balance — sums of the underlying batches' own imported snapshots, each row once,
missing figures excluded (and counted beside the total), never `$0.00` for a
column nobody filled. Then the balance-convention note, per cohort for a
combined intake ("Morning: verified across 5 students; Evening: verified across
8 students"), the structural-blank-columns note, and the truncation warning
if any query hit its cap (none does).

## 13. Receipt presentation

Compact: `Sent`, `Mixed`, `Not sent`, `Unknown`, each followed by a tiny
`LEGACY` mark; tooltip opens "Historical workbook status." and ends "No receipt
has been issued by this system." The derivation is GRID-03 §9, unchanged. No
normalized receipt row is created, a legacy "Sent" does not block future
generation, and nothing implies a historical PDF exists.

**How FINANCE-RECEIPTS will extend this.** The model keeps two separate
facts: `receiptStatus` / `receiptSummary` (historical, from the workbook's
`Receipt Sent` values on payments) and, to come, a system receipt state read
from `receipts` rows (number, PDF, delivery). The Receipt cell will show the
system state first when one exists ("R-PSW-…, sent 2026-09-30") and the legacy
mark as secondary; where no system receipt exists it shows what it shows now.
The receipt filter, if wanted then, filters on the system state. Backfilling
`receipts` for historical YES values remains the open decision from GRID-03
§18; nothing here presumes an answer.

## 14. Reminder presentation

`Never sent` (muted), tooltip "No reminder has been sent from this system…
nothing is claimed to be overdue." No row is labelled "Reminder needed": no
due-date rule exists. The row and selection-bar Reminder buttons are where the
future action will live, disabled with "Available in a later workflow".

## 15. URL state

```
/finance?program=PSW&intake=2026-07-29&session=morning&status=outstanding&q=…
```

| Param | Meaning | Updates by |
| --- | --- | --- |
| `program` | short code | `router.push` (rows change) |
| `intake` | intake key (§4) or `unassigned` | `router.push` |
| `session` | `morning` / `evening`; absent = all | `history.replaceState` |
| `status` | `outstanding` / `settled` / `credit` / `unknown`; absent = all | `replaceState` |
| `receipt` | `sent` / `mixed` / `not_sent` / `unknown` (historical), or `gap` = Not sent or Mixed, reached only from an old `filter=legacy_receipt_gap` link; absent = all | `replaceState` |
| `q` | search term | `replaceState` |

The address bar always names `program` and `intake`, even on the default
landing, so a copied link opens exactly the view on screen. No batch uuid is
exposed; the row data carries the real ids. Nothing is written to local or
session storage.

**Backward compatibility.** `?batch=<uuid>` is mapped server-side to the intake
containing that batch and redirected (307, `replace`) to
`?program=…&intake=<key>&session=<that batch's session>`, with `q` and the
mapped `status` carried along — the old link lands on exactly the rows it used
to show. `?batch=unassigned` opens the Unassigned view. `?filter=` is read as
its `status` equivalent (§11). A stale intake key or batch id falls back to
the default with an explanation, as before. Verified in the acceptance run.

## 16. Search, selection, drawer

- **Search** runs over both cohorts of the intake under Session = All, and
  respects the Session filter otherwise: an Evening student found by number
  disappears when Morning is selected. Substring, case-insensitive, never fuzzy.
- **Selection** is keyed on `financeRecordId` and managed by the pure
  `selection.ts`. Select-all ticks exactly the rows visible after intake,
  session, status and search; a row hidden by a filter is neither selected nor
  cleared by it. Changing intake resets the selection (the tracker is keyed on
  the selection). Verified: select-all under Session = Evening on January 2026
  selects 19, not 39.
- **Drawer** adds a "Where this record sits" section — Intake, the real
  Batch, Session, Payment status with its explanation — above the historical
  snapshot, scheduled installments, imported transactions, legacy receipt
  status and reminder state ("Never sent"). Still no editable field.

## 17. Query and performance

Seven bounded REST requests per render for any intake, six for Unassigned —
the same as GRID-03 for a single batch. Combining Morning and Evening adds
nothing: records and manifests are fetched with one `in (batch_id…)` each, and
installments and payments with one `in (record_id…)` each. Measured with the
real loader under RLS (`scripts/finance-qa/loader-request-count.mts`):

| View | Rows | Batches | REST requests |
| --- | ---: | ---: | ---: |
| 29 Jul 2026 (default) | 17 | 2 | 7 |
| 27 Apr 2026 (largest) | 41 | 2 | 7 |
| December 2025 (undated pair) | 31 | 2 | 7 |
| old `?batch=` link to 29th JULY, 2026 - Morning | 17 | 2 | 7 (then one redirect) |
| ELCE 25 & 26 | 50 | 1 | 7 |
| Unassigned — no batch | 22 | — | 6 |

No request per batch or per student anywhere. Caps unchanged (500 records,
500 manifest rows, 2000 installments, 2000 payments); the largest intake holds
41 records and 232 payments.

## 18. Tests

`npm test`: **533 tests, 137 suites, 0 failures** (475 before; 60 added, 2
retired with `select-batch.ts`, whose rules moved into `intake.ts`).

Added, per the ticket's list: Morning + Evening become one intake; underlying
batch ids preserved; Session = All shows both; Morning filter shows only
Morning; Evening only Evening; combined manifest union preserves order (and is
deterministic whichever part is listed first); a Morning-only column is blank
for an Evening row and vice versa, for ACTUAL and INSTALLMENT; blank ≠ zero;
Outstanding / Settled / Credit from reliable balances; Unknown from missing,
unparseable and unverified; ECEA stays Unknown; Tracker Master Balance Fees
never used (loader source and payment shape); status filter uses the badge's
own field; search works across both sessions and respects the session filter;
select-all selects visible rows only; unassigned stays separate; plus the
grouping safety rules (no cross-sheet, no cross-program, no two-Morning
merge), labels, keys, month-title parsing (two-digit years rejected),
ordering, default and stale-link resolution, and old-link mapping.

## 19. Quality gates

| Gate | Result |
| --- | --- |
| `npm test` | 533 / 533 |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run build` | passes; `/finance` dynamic |
| `npm run finance:ui-acceptance` | see §20 |
| Console | 0 application errors across the session |

## 20. UI acceptance

Headless Chrome over the DevTools protocol against the local dev server,
signed in as the admin with a one-time-token session (RLS enforced; the
service role minted the token only). The script was rewritten for the intake
UI; it now runs **122 checks** and takes screenshots of every intake at
1600×1000, plus the frozen region at 1366 and 1180px.

Inspected, per the ticket: 29 Jul 2026, 1 Jun 2026 and 17 Mar 2025 combined;
the undated December 2025, January 2026 and March 2026; ECEA; Unassigned; and
the other five PSW intakes. For every combined intake the row count equals
Morning + Evening (e.g. 29 Jul 2026: 17 = 6 + 11; 27 Apr 2026: 41 = 15 + 26;
January 2026: 39 = 20 + 19), rows carry two distinct batch ids, no row is
duplicated, and each row's Session matches its batch.

Also verified: the Mar / Marc columns side by side on 6 Oct 2025 with the
other cohort's rows blank; the shared Late Fees column on 27 Apr 2026 blank
for Morning and filled for some Evening rows; `$0.00` beside `—` on January
2026; status pill counts equal to the badges; six frozen columns at 1600 and
1366px, three at 1180px, pixel-identical frozen region before and after
horizontal scrolling; search, session and status composing; selection across
cohorts; the drawer naming the real batch; refresh, back/forward, old
`?batch=` and `?filter=` links, `?batch=unassigned`, and stale links.

## 21. Owner-facing usability checklist

Work through these in the running application, signed in as yourself.

- [ ] Does intake selection feel simpler? (11 PSW choices instead of 22.)
- [ ] Is Morning / Evening still easy to distinguish? (Session column, Session filter, counts in the strip.)
- [ ] Can I identify Outstanding students immediately? (Amber `!` pill; Outstanding filter.)
- [ ] Can I identify Settled students immediately? (Green `✓` pill; Settled filter.)
- [ ] Is Balance visible without excessive scrolling? (Frozen beside the name at laptop width.)
- [ ] Is Receipt status understandable? (One word plus `LEGACY`; tooltip says it is the workbook's status.)
- [ ] Is Reminder status understandable? (`Never sent`; nothing claims to be overdue.)
- [ ] Are colours useful but not distracting? (Only the pills and dots are coloured.)
- [ ] Can I still inspect full Excel-style details? (ACTUAL and INSTALLMENT groups scroll to the right; Details opens the drawer.)
- [ ] Does ECEA clearly communicate unknown balance status? (Balance blank, every status Unknown, strip says why.)
- [ ] Is Unassigned clearly separate? (Its own entry at the bottom of the selector; no session control; every status Unknown.)

## 22. Remaining usability concerns

1. **Unknown on verified PSW rows.** 29 Jul 2026 has four Unknown rows because
   those students' balance cells are blank in the sheet. The legacy marker and
   the drawer explain it, but staff may still ask "why unknown?". A future
   ticket could add a one-line reason under the pill.
2. **Two columns for one letter** ("Mar" / "Marc"; "Late Fees" / "Feb") is
   faithful but slightly surprising. Each now carries its cohort as a label
   and a tooltip naming the other heading. Renaming would be inventing
   meaning and was not done.
3. **The Session filter is per intake.** Switching intake resets it to All.
   Deliberate — the new intake may not have both cohorts — but worth confirming
   with staff.
4. **ECEA and Unassigned show the STATUS group with nothing to say** (Balance
   blank, status Unknown). Hiding the group would make the two screens less
   consistent; it was left in.
5. The receipt filter is **historical only**. Once FINANCE-RECEIPTS issues
   real receipts, staff will want to filter on the system state; that filter
   should sit beside, not replace, this one.

## 23. Git

Working tree only; nothing committed, nothing pushed. Changed: the finance
grid library and components, the finance page, the QA scripts, this document
and the two READMEs. Deleted: `select-batch.ts` and its test (superseded by
`intake.ts`). Not tracked, and ignored: `.private/**`, `.env.local`,
`reference/**`.
