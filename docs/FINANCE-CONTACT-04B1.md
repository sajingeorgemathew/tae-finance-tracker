# FINANCE-CONTACT-04B1 — Master contact import audit (dry run)

Follows [FINANCE-RECONCILE-04A](FINANCE-RECONCILE-04A.md) and
[FINANCE-GRID-03C-USABILITY](FINANCE-GRID-03C-USABILITY.md). It builds the
read-only foundation for importing student **contact** information (student
number, name, email, phone, intake and session context) from the two master
roster workbooks under `reference/`, and reconciles them against the hosted
students without writing anything.

This was a read-only ticket. No student was created or updated, no email or
phone was written, no batch was assigned, no reconciliation write was made,
no email was sent, and every hosted row count is identical before and after
each run. Nothing under `reference/` was modified (hashed before and after).

## Privacy

This document contains no student names, student numbers, emails, phones,
addresses or row-level values. Aggregate counts, sheet and table titles, file
fingerprints, rules and code paths only. Row-level evidence is written only
to `.private/finance-contact/` (Git-ignored): `contact-audit.json`,
`contact-audit.csv`, `psw-source-rows.csv`, `ecea-source-rows.csv`,
`conflicts.csv`, `unassigned-cross-check.csv`, and an aggregate copy of the
console report. The source workbooks are Git-ignored under `/reference/*`.

---

## 1. Pre-flight

- Branch `feature/finance-contact-04b1-master-audit`, created from `main` at
  the merge of FINANCE-RECONCILE-04A (`e42901a`); `main` includes
  FINANCE-GRID-03C (`3d02591`) and FINANCE-RECONCILE-04A (`e42901a`).
- Hosted project `hwekiiompxixybxclche`. Baseline, read under the admin
  session with Row Level Security enforced, identical before and after every
  audit run:

| Table | Count |
| --- | ---: |
| batches | 23 |
| students | 385 |
| student_finance_records | 397 |
| installments | 1,825 |
| payments | 1,013 |
| receipts | 0 |
| receipt_deliveries | 0 |
| reminder_deliveries | 0 |
| import_batches | 1 |
| import_exceptions | 1 |
| audit_log | 0 |

- Baseline gates before any change: 585 tests (584 pass, 1 skipped — the
  column-manifest test skipped itself because `reference/` no longer held
  exactly one workbook), lint clean, typecheck clean.

### 1.1 Source workbook fingerprints

Three workbooks sit under `reference/`. Identification is **structural**
(sheet titles), never by filename.

| File | Bytes | SHA-256 | Sheets | Identified as |
| --- | ---: | --- | ---: | --- |
| `PSW MASTERCLASS LIST- 2025 - 26 (6).xlsx` | 125,019 | `9130458b3c17ee14a6229c597816b12e7f55ed82f19cd7fcfc99a272fe249a29` | 12 | PSW contact master (`psw-masterclass-list`) |
| `ELCE_MASTERCLASS_LIST_2025-26_New#.xlsx` | 25,397 | `f328cfbda08453a359def3ae69290ca79be9d51bc6647c161752eb341e7eccb8` | 3 | ECEA contact master (`ecea-masterclass-list`) |
| `finance-tracker.xlsx.xlsx` | 268,547 | `62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2` | 15 | not a contact master (finance workbook; unchanged approved hash) |

Sheets discovered:

- PSW: `17th March`, `12th May`, `2nd July`, `18th August`, `6th Oct`,
  `Dec 1st`, `Jan 12th`, `March 2`, `April 27`, `June 01`, `August 17`,
  `Sep 28th` — one sheet per intake, each holding a Morning table and an
  Evening table introduced by a merged title cell ("PSW Morning Batch -
  01st Dec 2025"). The `17th March` Evening table has no title cell.
- ECEA: `Master-ECEA` (one table, title stating no cohort), `ECEA-WEEKDAYS`
  (Weekday Morning + Weekday Evening tables), `ECEA-WEEKEND` (Weekend
  Morning + Weekend Evening tables).

### 1.2 A regression fixed on the way in

`scripts/finance-import/lib/workbook-source.mts` used to resolve "the finance
workbook" as *the only workbook in `reference/`* and refused to run with more
than one. With the two masters present, `finance:reconcile`,
`finance:unassigned-audit`, `finance:analyze` and `finance:manifest` would
all have stopped. The resolver now identifies the finance workbook by
structure — the single candidate carrying a `Tracker Master` sheet — and
still refuses if zero or several candidates do. Behaviour with one workbook
is unchanged. The column-manifest test no longer skips.

---

## 2. Source role

The finance workbook remains authoritative for historical payments,
installments, snapshots and imported finance history. The two masters are
**contact/roster** sources: candidates for student number, names, email,
phone, program, intake/session context and, for ECEA, a per-row course start
date. No finance figure is read from them and nothing in this ticket touches
a finance value.

---

## 3. Architecture — program-generic importer

```
reference/*.xlsx ──► sources.mts (fingerprint, open read-only from a Buffer)
        │
        ▼
adapters/registry.mts  identifyWorkbook(): every adapter's recognize(workbook)
        │                one claimant → owns the workbook; none → "not a contact master"
        ▼
adapters/psw.mts ─┐    parse(): title recognizer + heading allowlist on the shared
adapters/ecea.mts ┘    table-scan.mts → ContactImportRow[] (+ cross-check rows)
        │
        ▼
scope.mts              applyScope(): configuration (cutoff / end / explicit exclusions)
        │
        ▼
reconcile.mts          pure engine: exact-number matching, per-row primary category
                       + flags, duplicates, shared contacts, conflicts, master/subset
                       cross-check, intake cross-check, Unassigned cross-check,
                       source conservation
        │
        ▼
contact-audit.mts      the CLI: hosted reads under RLS, integrity before/after,
                       private outputs, aggregate console report, exit codes
```

All code lives in `scripts/finance-contact/`. Nothing in `src/` changed; the
application has no PSW/ECEA-specific contact code and no contact table.

### 3.1 The canonical row

`ContactImportRow` (`canonical.mts`): `stagedRowId`, `sourceWorkbook`,
`sourceSheet`, `sourceTable`, `sourceRow`, `programCode`, `studentNumber`,
`studentNumberRaw`, `firstName`, `middleName`, `lastName`, `displayName`,
`emailRaw`, `emailNormalized`, `emailStatus`, `phoneRaw`, `phoneNormalized`,
`phoneStatus`, `intakeLabel`, `intakeDate`, `session`, `sourceStartDate`,
`sourceStatus`, `inOperationalScope`, `exclusionReason`.

### 3.2 The field allowlist — and what is explicitly ignored

An adapter maps *normalized heading → canonical field* and the scanner reads
a cell **only through that map**. Every other heading is recorded by name and
its cells are never read. Headings matching `SENSITIVE_HEADING_PATTERNS`
(password, date of birth, address, SIN, banking, work permit/visa/immigration,
placement, venue, transcripts, certificates, document status, medical,
login/credential) are refused as map targets even if an adapter listed them.

Mapped (allowlist): Student ID, First Name, Middle Name, Last Name, Contact
No., Email; ECEA also WKND & WKD (session) and START DATE (per-row course
start); both adapters map GRADUATED to `sourceStatus` (enrollment outcome
text).

Ignored by name and never read, as observed in the real workbooks:

- PSW: **Password**, YYYY/MM/DD and D.O.B (date of birth), WP and Status
  (immigration), Address, Transcripts, College Cert, NACC, VENUE, START DATE,
  FINISH DATE, STATUS (the PLACEMENT block), Doc Status. The PSW START DATE
  column is a *placement* date, not an intake date, so it is not mapped; the
  intake date comes from the table title.
- ECEA: DOB (YYYY-MM-DD), Status (immigration), END DATE, Address.

Tests assert that fixture password, date-of-birth and address values never
appear anywhere in an adapter's serialized output. No debug output prints a
row value; the console carries counts and titles only.

The PSW sheets carry a three-line colour legend (Withdrawal / Enrollment
Pending / Other Reason), so row fills encode a status. Cell fills are not
readable with the community SheetJS build; no status is derived from colour,
and the legend rows are classified as legend rows, not students.

### 3.3 Adding a third program

1. Write `adapters/<program>.mts`: a `recognize(workbook)` that looks at
   sheet titles/headings, a `recognizeTitle(text)` and a `headingMap`, and
   call the shared `scanSheet`. Declare `scopeDateField` (`intakeDate` for a
   source whose tables are intakes, `sourceStartDate` for one that dates each
   row).
2. Add it to `ADAPTERS` in `adapters/registry.mts`.
3. If its intakes need an explicit exclusion, add it to `scope.mts`.
4. Run `npm run finance:contact-audit`. The engine, the report and the
   outputs need no change. The generic engine is tested with two structurally
   different fixture adapters (PSW-shaped intake sheets, ECEA-shaped master +
   subsets) in `adapters/adapters.test.mts` and `reconcile.test.mts`.

---

## 4. Operational scope (configuration)

`scope.mts` → `DEFAULT_SCOPE_CONFIG`:

| Setting | Value |
| --- | --- |
| `operationalCutoff` (inclusive) | `2025-12-01` |
| `operationalEnd` (inclusive) | `2026-08-31` |
| `excludedFutureIntakes` | PSW `2026-09-28` (the `Sep 28th` sheet — upcoming intake, not approved for import) |

A row's scope date is its adapter's field (PSW: the table title's date; ECEA:
the row's START DATE), with the other as fallback. Before the cutoff →
`OUT_OF_SCOPE_HISTORICAL` (not an error; blank contacts acceptable). Listed
or after the end → `OUT_OF_SCOPE_FUTURE`. A row with no date is kept in scope
and flagged `SCOPE_DATE_UNKNOWN` (0 such rows in the real masters). The CLI
accepts `--cutoff=`, `--end=` and `--include-excluded-intakes` for dry-run
experiments; enabling the September intake later is a config change, not a
parser change.

Discovered PSW intakes (all 12 sheets, 24 tables): 17 Mar 2025, 12 May 2025,
2 Jul 2025, 18 Aug 2025, 6 Oct 2025 (historical); 1 Dec 2025, 12 Jan 2026,
2 Mar 2026, 27 Apr 2026, 1 Jun 2026, 17 Aug 2026 (operational); 28 Sep 2026
(future, excluded). The expected "Dec 2025 through Aug 2026, excluding the
newest intake" scope is confirmed from the workbook.

ECEA rows are dated individually; their start months span 2025-01 (1 row,
historical), 2025-12 through 2026-08 (50 rows, operational) and 2026-09
(4 rows, future by the `operationalEnd` bound — these are upcoming ECEA
students, excluded by the same configuration and re-enabled the same way).

---

## 5. Source conservation

Every row of every sheet's used range receives exactly one kind. Student rows
= staged + cross-check rows; staged = operational + historical + future.

### 5.1 PSW

| Sheet | Range rows | Title | Header | Student | Placeholder | Legend | Blank | Other |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 17th March | 33 | 1 | 2 | 24 | 0 | 4 | 2 | 0 |
| 12th May | 35 | 2 | 2 | 25 | 0 | 3 | 3 | 0 |
| 2nd July | 36 | 2 | 2 | 27 | 0 | 3 | 2 | 0 |
| 18th August | 47 | 2 | 2 | 38 | 0 | 3 | 2 | 0 |
| 6th Oct | 40 | 2 | 2 | 30 | 0 | 3 | 3 | 0 |
| Dec 1st | 45 | 2 | 2 | 34 | 0 | 3 | 4 | 0 |
| Jan 12th | 53 | 2 | 2 | 40 | 0 | 3 | 6 | 0 |
| March 2 | 37 | 2 | 2 | 25 | 0 | 3 | 5 | 0 |
| April 27 | 54 | 2 | 2 | 41 | 0 | 3 | 6 | 0 |
| June 01 | 65 | 2 | 2 | 28 | 22 | 3 | 8 | 0 |
| August 17 | 60 | 2 | 2 | 18 | 27 | 3 | 8 | 0 |
| Sep 28th | 60 | 2 | 2 | 6 | 39 | 3 | 8 | 0 |
| **total** | **565** | 23 | 24 | **336** | 88 | 37 | 57 | 0 |

Placeholder = a row carrying only a pre-typed serial number. Legend = a lone
text cell inside or between tables (the colour legend; one PLACEMENT group
heading). All 12 sheets conserved.

| PSW | Rows |
| --- | ---: |
| discovered student rows | 336 |
| operational | 186 |
| historical exclusions | 144 |
| future exclusions | 6 |
| malformed / non-student rejections | 0 (non-student rows are the 88 + 37 + 57 above) |
| unaccounted | 0 |

Morning rows 196, Evening rows 165, session not stated 11 (the untitled
`17th March` Evening table; historical).

### 5.2 ECEA

| Sheet | Range rows | Title | Header | Student | Blank |
| --- | ---: | ---: | ---: | ---: | ---: |
| Master-ECEA | 57 | 1 | 1 | 55 | 0 |
| ECEA-WEEKDAYS | 34 | 2 | 2 | 29 | 1 |
| ECEA-WEEKEND | 29 | 2 | 2 | 24 | 1 |

| ECEA | Rows |
| --- | ---: |
| master rows (staged) | 55 |
| subset rows (cross-check only, never staged twice) | 53 |
| operational (master) | 50 |
| historical exclusions | 1 |
| future exclusions | 4 |
| unaccounted | 0 |

### 5.3 Weekday / Weekend cross-check (master is structurally primary)

| Check | Count |
| --- | ---: |
| distinct numbers on master | 55 |
| distinct numbers across subsets | 53 |
| on master, in no subset | 2 |
| in a subset, not on master | 0 |
| listed in more than one subset table | 0 |
| master/subset session mismatch | 1 |
| master/subset value conflicts | 1 (name spelling) |

The one session mismatch is a master row whose WKND & WKD cell holds free
text (a payment note) instead of WD/WN; it is reported as written, not
repaired. Master session values: Weekday 30, Weekend 24, other text 1.

---

## 6. Normalization (comparison forms only; nothing written)

- **Student number**: trimmed text, leading zeroes preserved, never coerced.
  All 391 staged numbers are digit-only. One PSW row (operational, `June 01`
  Evening) states a full name, email and phone but no number →
  `MISSING_STUDENT_NUMBER`, review required.
- **Email**: trimmed, lower-cased for comparison, empty = missing, basic
  shape check (`x@y.z`, no whitespace). No domain invented, no typo
  corrected. Operational rows: valid 236, missing 0, invalid 0.
- **Phone**: presentation characters (spaces, parentheses, hyphens, dots)
  removed. Ten NANP digits (area code and exchange 2–9) → comparison key
  `+1XXXXXXXXXX`; eleven digits starting with 1 likewise; an explicit `+`
  with another country code is kept as written; anything else is
  `ambiguous` (no `+`, non-NANP length) or `invalid` (letters, several
  numbers in one cell, fewer than ten digits). Country is never assumed.
  Operational rows: valid NANP 234, invalid 1, ambiguous 1. All scopes:
  invalid 4, ambiguous 1.
- **Names**: preserved exactly; a comparison key (case/punctuation-folded)
  is used only to *report* differences.

---

## 7. Hosted reconciliation (exact student number only)

Every hosted `students.email` and `students.phone` is currently NULL (none
was imported in FINANCE-IMPORT-02), so no row can be `EXACT_UNCHANGED` or
`CONTACT_DIFFERENCE` yet; the categories are implemented and tested.

**Terminology.** *Primary master rows* are every student row staged from a
master's primary tables, in every scope: PSW 336 + ECEA 55 = **391**. Only
the subset inside the configured window is *operational*: PSW 186 + ECEA 50
= **236**. The other 155 primary rows are historical (145) or future (10)
exclusions and are never called operational. Exact Student Number matches
are reported for both populations below; "371" is the all-scope figure and
"226" the operational one.

| | All primary master rows (every scope) | Operational rows only |
| --- | ---: | ---: |
| rows | 391 | 236 |
| exact hosted matches (one hosted student) | 371 | 226 |
| rows with no hosted student (valid number) | 9 | 9 |
| rows with no student number | 1 | 1 |
| historical rows matching a hosted student | 145 of 145 | – |
| future rows matching a hosted student | 0 of 10 | – |

Operational rows versus operational *students*:

| | Count |
| --- | ---: |
| operational rows | 236 |
| … with a student number | 235 |
| … without a student number (`MISSING_STUDENT_NUMBER`) | 1 |
| distinct operational student numbers | 234 |
| numbers listed on more than one operational row | 1 (2 rows, §7.2) |
| distinct hosted students matched by an operational row | 225 |
| distinct valid numbers with no hosted student | 9 |

So 226 safe-fill rows + 9 not-hosted rows + 1 number-less row = 236 rows
exactly, and 225 hosted students + 9 new students = 234 distinct numbered
people (the repeated number counts once), plus 1 row that cannot be
identified by number.

Primary category, operational rows:

| Category | Rows |
| --- | ---: |
| SAFE_CONTACT_FILL | 226 |
| STUDENT_NOT_IN_APP | 9 |
| MISSING_STUDENT_NUMBER | 1 |
| EXACT_UNCHANGED | 0 |
| CONTACT_DIFFERENCE | 0 |
| SOURCE_MISSING_CONTACT / SOURCE_INVALID_CONTACT | 0 |
| DUPLICATE_HOSTED_STUDENT_NUMBER | 0 |
| DUPLICATE_SOURCE_STUDENT_NUMBER | 0 (the one duplicate group agrees on every contact value) |

By program (all staged rows): PSW — SAFE_CONTACT_FILL 179, STUDENT_NOT_IN_APP
6, MISSING_STUDENT_NUMBER 1, OUT_OF_SCOPE_HISTORICAL 144, OUT_OF_SCOPE_FUTURE
6. ECEA — SAFE_CONTACT_FILL 47, STUDENT_NOT_IN_APP 3, OUT_OF_SCOPE_HISTORICAL
1, OUT_OF_SCOPE_FUTURE 4.

Flags, operational rows: SAFE_EMAIL_FILL 226, SAFE_PHONE_FILL 224,
NAME_DIFFERENCE 32 (name audited, never rewritten), SHARED_SOURCE_EMAIL 5,
SHARED_SOURCE_PHONE 5, DUPLICATE_SOURCE_STUDENT_NUMBER 2, SOURCE_INVALID_PHONE
1, SOURCE_AMBIGUOUS_PHONE 1, MISSING_STUDENT_NUMBER 1, STUDENT_NOT_IN_APP 9.

### 7.1 New students

9 operational rows (9 distinct students: PSW 6, ECEA 3) have a valid student
number and no hosted `students` row. They are active roster students with no
imported finance history — expected, not failures. A future contact apply
would need to **create** 9 students with program, number, name, email,
phone and intake/session association. None was created here.

### 7.2 Duplicates and shared contacts

| Check | Result |
| --- | --- |
| same number repeated in the PSW workbook | 1 group: listed in the 12 Jan 2026 Morning table and the 27 Apr 2026 Morning table; same name, email and phone → `repeat_or_transfer_candidate`. Hosted holds finance records for this number in the January *Evening* batch and the April Morning batch. Ambiguity: source says Morning for January; hosted says Evening. Not changed. |
| same number repeated in the ECEA master | 0 |
| emails shared by more than one student number | 4 (each by 2 numbers) — reported for review, not treated as one person |
| phones shared by more than one student number | 4 (each by 2 numbers) — same |
| hosted student numbers held by more than one hosted row | 0 |

**Repeated Student Number — interpretation.** When the same exact number
appears on more than one operational source row *and every contact value
agrees* (this is the case for the one PSW group: same name, same email,
same phone, `conflictingContact = false`):

- it is **not** a contact conflict by itself; the engine only raises
  `DUPLICATE_SOURCE_CONFLICTING_CONTACT` when the rows disagree;
- it may represent re-enrollment, a transfer between intakes, or plain
  roster duplication; 04B1 does not decide which;
- the rows collapse to **one** safe contact candidate for the one hosted
  student (2 rows → 1 student in every unique-student count above);
- the intake/enrollment history (two source intakes, two hosted finance
  records, one session disagreement) is a separate roster question for the
  enrollment relation (§10) and RECONCILE-04C. 04B1 merges nothing and
  rewrites no enrollment evidence.

**Shared email / phone — what the 4 groups are.** The 4 shared emails and
the 4 shared phones are the *same* 4 pairs of student numbers: each pair
shares both values. Three pairs are cross-program (one PSW number, one ECEA
number); two of those three carry the same name text, so they are most
likely one person holding a number in each program. The fourth pair is two
historical PSW rows. No pair is merged: a shared value is review evidence,
not an identity link (§11 rule 4).

### 7.3 Source conflicts (same number, different value)

PSW: 0 (the repeated number agrees on every value). ECEA: 1 name-spelling
conflict between master and a subset sheet; the master is structurally
primary and is reported as such — no value was chosen.

### 7.4 Hosted operational students the operational roster rows do not state

**Definition.** A *hosted operational student* is a hosted `students` row
that holds at least one `student_finance_records` row whose `batch_id`
points at a batch whose hosted intake date (the batch `start_date`, else
the first of its stated month) falls inside the operational window
(`2025-12-01` … `2026-08-31`). It is a batch-membership fact only: name
similarity, source status text and the masters play no part in it. A hosted
student whose only finance record is Unassigned (no batch) is *not*
operational under this definition, whatever the masters say.

| | Count |
| --- | ---: |
| hosted operational students (window batch) | 226 |
| … whose number is stated by an operational source row | 221 |
| … whose number **no operational** source row states | 5 (all PSW; none ECEA) |
| of those 5: number stated by a master under a **historical** intake only | 3 |
| of those 5: hosted student has **no** student number (exact match impossible) | 2 |
| of those 5: numbered, and absent from **both** masters in every scope | 0 |

The 221 + 5 = 226 reconciles with the 222 `MATCHES_HOSTED_INTAKE` rows of
§8 (222 rows, 221 students because of the repeated number). The 3
historical-listed cases are roster/enrollment discrepancies (master says a
2025 intake, hosted finance record sits in a 2026 batch), not missing
contacts: their historical rows carry contact values but are out of scope,
so nothing is filled. The 2 number-less hosted students cannot be matched
by any rule this ticket allows; they are listed privately for review.
Hosted batches involved: January 2026 Evening 1, 27 Apr 2026 Morning 1,
1 Jun 2026 Morning 1, 1 Jun 2026 Evening 1, 29 Jul 2026 Morning 1.

---

## 8. Batch / intake cross-check (diagnostic only)

Source intakes map to hosted intakes (the grid's grouping of one sheet's
Morning + Evening batches) by exact start date, then by stated month, then by
the hosted *sheet title's* month (weakest, labelled `sheet_title_month`),
then, for ECEA (undated tables), the program's single hosted intake. Mapping
tiers used by operational rows: start_date 69, year_month 99,
sheet_title_month 18, single_program_intake 50.

The `sheet_title_month` tier exists for one case: the PSW master's
"August 17, 2026" tables correspond to the finance workbook's `Aug 2026`
sheet, whose batches are titled 29 July 2026 (hosted `start_date`
2026-07-29). The dates disagree by source; the mapping is reported, not
assumed.

| Intake category, operational rows | Rows |
| --- | ---: |
| MATCHES_HOSTED_INTAKE | 222 |
| HOSTED_UNASSIGNED | 4 |
| NOT_APPLICABLE (no hosted student) | 10 |
| DIFFERENT_HOSTED_INTAKE | 0 |
| SOURCE_INTAKE_NOT_MAPPED | 0 |
| NO_FINANCE_RECORD | 0 |
| session disagreement within a matched intake (source Morning/Evening ≠ hosted batch) | 4 |

The 4 `HOSTED_UNASSIGNED` rows are four of the 22 Unassigned records (§9):
their source intake and session are now known from the master.

### 8.1 Session disagreement — interpretation

The 4 session disagreements (all PSW) are rows whose source intake maps to
the hosted intake but whose stated Morning/Evening differs from the hosted
batch: Dec 2025 Evening vs the hosted December Morning batch; Jan 2026
Morning vs the hosted January Evening batch (the repeated number of §7.2);
Apr 2026 Morning vs the hosted 27 April Evening batch; Aug 2026 Morning vs
the hosted 29 July Evening batch.

A session mismatch does **not** by itself block a contact fill when all of
the following hold, and for all 4 rows they do:

- the Student Number matches exactly one hosted student;
- the source email is valid and the source phone is `valid_nanp`;
- any duplicate source rows for the number agree on the contact values;
- the hosted email and phone are currently NULL.

All 4 therefore remain `SAFE_CONTACT_FILL`. The session disagreement is
retained as evidence for a later roster/enrollment review (RECONCILE-04C or
the enrollment relation of §10); no hosted batch or session assignment is
changed by 04B1, and 04B2 must not change one either.

---

## 9. The 22 Unassigned finance records

| | Records |
| --- | ---: |
| unassigned records | 22 |
| with a student number → exact-number check | 19 |
| without a student number → never matched by name | 3 |
| numbered records found in a master (exact number) | 9 |
| … providing a valid email | 9 |
| … providing a valid phone | 9 |
| … listed in exactly one source intake with a stated session that maps to one hosted batch (`single_batch`) | 8 |
| … listed in two source intakes (`several_intakes`) | 1 |
| numbered records absent from both masters | 10 |
| number-less records: source rows with identical name text (informational only) | 0 |

Of the 9 found: 3 sit in historical intakes (Mar, Aug, Oct 2025), 5 in
operational intakes (Dec 2025 ×3, Jan 2026 ×2) and 1 in two intakes (Jan
2026 and Apr 2026 Morning — the repeated number of §7.2). For the 3
number-less records the masters contain **no** row with the same name text,
and even if they did it would not be an identity link.

**Evidence for RECONCILE-04C**: yes, stronger than 04A had. 04A graded 5
records "human-assignable" and 13 "month hint only" from the finance
workbook. The masters now give a *stated session* for 8 of the 19 numbered
records, each resolving to a single hosted batch, plus a valid email and
phone for all 9 found. That is batch evidence 04C can present to a reviewer;
it is not authority to assign.

---

## 10. Schema recommendation

No schema was added. `students`, `programs`, `batches` and
`student_finance_records` remain the model, and a contact apply (04B2)
needs nothing new: `students.email` and `students.phone` already exist.

A **generic enrollment/roster relation is recommended for a later ticket**,
because the masters expose facts the current model cannot hold:

1. Roster membership and finance-record membership differ. 9 roster
   students have no finance record at all; today a student cannot be
   represented in a program/intake without a finance record and a batch.
   5 hosted students sit in operational batches the masters do not list.
2. One PSW student is listed in two intakes; hosted holds two finance
   records for the number, which happens to work, but "enrolled in intake X,
   session Y" is a roster fact, not a finance fact.
3. ECEA's Weekday/Weekend session is per student and has no batch to live
   on (hosted has one ECEA batch).
4. Source status (GRADUATED / DROPPED OFF / CURRENT) and per-row start dates
   are roster facts.

Suggested shape (not created): `student_enrollments(id, student_id,
program_id, batch_id NULL, intake_label, intake_date NULL, session,
source_status, source_workbook_sha256, source_sheet, source_row, created_at)`
with uniqueness on `(student_id, program_id, intake_label, session)`.
The export and mailing workflows would filter on it, not on finance records.

---

## 11. Proposed 04B2 apply rules (for review, not implemented)

1. Gate on both workbook SHA-256 values above and on the hosted baseline
   counts; refuse to apply if either differs from the dry run.
2. Apply only rows with primary `SAFE_CONTACT_FILL`, in operational scope,
   exactly one hosted match, and no `DUPLICATE_SOURCE_CONFLICTING_CONTACT`
   flag. Write `students.email` only when hosted email is NULL and the
   source email is valid (store trimmed; compare lower-cased). Write
   `students.phone` only when hosted phone is NULL and the source phone is
   `valid_nanp` (store `+1XXXXXXXXXX`) or `international_explicit`; never
   write an ambiguous or invalid phone.
3. Never overwrite a non-NULL hosted value: `CONTACT_DIFFERENCE` goes to a
   review list. Never write a name.
4. Hold for review, not apply: `MISSING_STUDENT_NUMBER`,
   `DUPLICATE_HOSTED_STUDENT_NUMBER`, any conflicting duplicate, and rows
   flagged `SHARED_SOURCE_EMAIL` / `SHARED_SOURCE_PHONE` (a shared address
   may be legitimate; a human decides).
5. `STUDENT_NOT_IN_APP` (9): create only with explicit approval, with
   `legacy_source = 'contact_master:<sha256>'` and no invented finance
   record; preferably after the enrollment relation exists so the
   intake/session association has somewhere to live.
6. Out-of-scope rows are not applied. Historical students keep blank
   contacts; the app may allow manual updates later.
7. One `import_batches` row (`import_type = 'students'`), one `audit_log`
   entry per changed row, deterministic and idempotent (re-running applies
   nothing), full private before/after report, RLS-authenticated writes only.

### 11.1 Proposed safe apply population under those rules (dry-run numbers)

Counted from the operational `SAFE_CONTACT_FILL` rows of the 2026-09-24
run; "students" means distinct hosted `students` rows, so the repeated
number counts once.

| | Rows | Students |
| --- | ---: | ---: |
| `SAFE_CONTACT_FILL` (exact match, hosted contacts NULL) | 226 | 225 |
| eligible for safe **email** fill (valid email, not shared) | 221 | 220 |
| eligible for safe **phone** fill (`valid_nanp`, not shared) | 219 | 218 |
| withheld: source email shared with another number | 5 | 5 |
| withheld: source phone shared with another number (same 5 rows) | 5 | 5 |
| withheld from phone fill only: source phone invalid (1) or ambiguous (1); email still eligible | 2 | 2 |
| withheld: no Student Number (`MISSING_STUDENT_NUMBER`) | 1 | – |
| not hosted (`STUDENT_NOT_IN_APP`; create only with approval) | 9 | 9 |
| repeated-number rows collapsing to one candidate | 2 → 1 | 1 |
| actual contact conflicts (`CONTACT_DIFFERENCE`, `DUPLICATE_SOURCE_CONFLICTING_CONTACT`) | 0 | 0 |

The 5 withheld rows come from 3 of the 4 shared pairs of §7.2 (two pairs
with both rows operational, one pair with one operational and one
historical row); the fourth pair is entirely historical and withholds
nothing. 220 + 5 = 225 students account for every safe-fill student on the
email side; 218 + 5 + 2 = 225 on the phone side. Future rows (10) and
historical rows (145) are outside the population by configuration.

---

## 12. Future export and mailing requirements

Exportable contact fields (from the app database, never from Excel):
student number, display name, email, phone, program, intake label/date,
session, active flag. Not exportable: anything the allowlist ignores (date of
birth, address, immigration, placement, documents, passwords).

Future receipt/reminder email must read the reconciled `students` record.
The reference workbooks are import evidence; no runtime path may open them.

---

## 13. Tooling

`npm run finance:contact-audit` (alias `finance:contact-dry-run`) —
`scripts/finance-contact/contact-audit.mts`. Read-only; exit 2 when no
master is recognized or two adapters claim one file, 3 if a reference file's
hash changes during the run, 4 if any hosted count changes, 1 if source
conservation fails, else 0. `--offline` runs steps 1–4 without hosted reads.

Hosted reads use the admin magic-link session from `finance-qa/hosted-session.mts`
(service role used only to mint the one-time token; every data read is under
the admin's own JWT with RLS). The engine module imports no database client.

---

## 14. Quality gates

| Gate | Result |
| --- | --- |
| `npm test` | 665 tests, 665 pass, 0 skipped (80 new; the manifest test runs again) |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run build` | success |
| `npm run finance:contact-audit` | exit 0; conservation PASS; hosted counts unchanged; workbooks unchanged |
| `npm run finance:reconcile` | exit 0, 23/23 batches, workbook hash unchanged |
| `npm run finance:unassigned-audit` | exit 0, 41/41 payments at every stage, counts unchanged |
| `npm run finance:ui-acceptance` | 148/148 |

Re-verified 2026-09-24 after the terminology pass (no code change): tests
665/665, lint clean, typecheck clean, build success; `finance:contact-audit`
exit 0 with every count above reproduced and hosted counts unchanged
(students 385, finance records 397, payments 1,013, audit_log 0);
`finance:reconcile` exit 0, workbook hash unchanged;
`finance:unassigned-audit` exit 0, 41/41 payments at every stage.

New tests cover: adapter canonical mapping (both layouts), student number as
text with leading zeroes, exact-number matching, no name/email/phone
matching, missing-number review, email trim/lower and invalid
classification, phone comparison and ambiguity, historical and future
exclusion, duplicate source numbers, shared email/phone not merging, ECEA
master/subset deduplication and discrepancies, PSW repeated-number
explanation, STUDENT_NOT_IN_APP, hosted contact difference, blank-contact
safe fill, Unassigned exact-number and number-less handling, source
conservation, and the engine's lack of any write path.

## 15. Privacy result

`reference/*` and `.private/` are Git-ignored (verified with
`git check-ignore`). No row value is printed to the console; the aggregate
report carries counts, titles and hashes only. The Password column is never
read; its heading is listed as ignored and sensitive. No screenshot was
taken. This document and the tests contain no real student data (fixtures
use `example.test` addresses, 555 numbers and 9xxxxx student numbers).

## 16. Remaining blockers before CONTACT-04B2

1. Owner decision on the 9 new students (create in 04B2, or after an
   enrollment relation exists).
2. Owner decision on the 4 ECEA rows starting 2026-09 and the PSW 28 Sep
   2026 intake (both excluded by configuration today).
3. Review of the 1 number-less operational PSW row, the 4 shared emails and
   4 shared phones, the 1 repeated PSW number (January session disagreement),
   and the 4 intake-session disagreements.
4. Agreement on the phone storage form (`+1XXXXXXXXXX`) and on keeping
   source spelling for names.
5. 04B2 must add the apply gate, audit-log writes and an idempotency test;
   nothing in 04B1 writes.
