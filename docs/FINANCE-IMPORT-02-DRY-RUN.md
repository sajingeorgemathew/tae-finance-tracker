# FINANCE-IMPORT-02 — import dry run (Phase B1)

Dry run only. **No database data of any kind was written** — see [No database writes](#14-no-database-writes) at the end of this document.

This report states what an apply *would* create from the historical finance workbook, using the mapping decisions approved after the Phase A analysis in [FINANCE-IMPORT-02-ANALYSIS.md](FINANCE-IMPORT-02-ANALYSIS.md). It plans; it does not import.

## Privacy

This document contains aggregate counts, sheet names, table titles and column headings only. It contains no student names, no student numbers, no payer names, no remarks and no amount attributable to a person. Source row numbers are reported as counts rather than listed, because a row number together with the workbook identifies a person. Row-level detail is written to `.private/finance-import-analysis/`, which is Git-ignored and must stay that way.

## 1. Source workbook

| Property | Value |
| --- | --- |
| File | `reference/finance-tracker.xlsx.xlsx` |
| Size | 268,547 bytes |
| SHA-256 | `62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2` |
| Date system | 1900 (with the Lotus leap-year bug) |
| Sheets | 15 |
| Unchanged after the dry run | yes |

Sheet names below are reproduced from `workbook.SheetNames`, so they are the workbook’s own spelling and not a transcription:

`Summary` · `Tracker Master` · `17th March 2025` · `12th May 2025` · `2nd July 2025` · `18th August 2025` · `6th Oct 2025` · `Dec 2025` · `Jan 2026` · `March 2026` · `27 April 26` · `1st June 2026` · `Aug 2026` · `ELCE 25 & 26` · `French`

## 2. Canonical programs

| `programs.short_code` | Workbook label(s) | Alias |
| --- | --- | --- |
| `ECEA` | `ELCE` | yes |
| `PSW` | `PSW` | no |

The `ELCE` → `ECEA` mapping is an alias for the database relationship only. The workbook’s `ELCE` text is never rewritten: it is preserved in every `legacy_raw_json` payload and in the batch name derived from the sheet. No program row is created by an import; programs are matched on `short_code` against the configuration migration.

| Deferred sheet | Reason | Meaningful rows | Rows with a student number |
| --- | --- | --- | --- |
| `French` | `deferred_program_configuration` | 3 | 0 |

No French program is created, and no French student, finance record, installment or payment is planned. `programs` decides how receipt numbers are assembled, so a guessed short code would become a permanent wrong value on real receipts.

## 3. Planned inserts

| Entity | Planned | PSW | ECEA |
| --- | --- | --- | --- |
| Batches | 23 | 22 | 1 |
| Students | 378 | — | — |
| Students (unresolved, no student number) | 7 | — | — |
| — from a batch table | 4 | — | — |
| — from Tracker Master | 3 | — | — |
| Student finance records | 397 | 347 | 50 |
| — batch-specific | 375 | — | — |
| — unassigned (`batch_id` null) | 22 | — | — |
| Installments | 1825 | 1825 | 0 |
| Payments | 1013 | — | — |
| Import exceptions | 1 | — | — |
| Receipts | 0 | 0 | 0 |
| Receipt deliveries | 0 | 0 | 0 |
| Programs | 0 | 0 | 0 |

Students are counted per exact student number: 378 distinct numbers across the supported PSW, ECEA and Tracker Master sources, plus 7 unresolved student(s) created one per source row for rows that name a student without numbering them. No student number is manufactured and no two rows are merged on the strength of similar names — two number-less rows spelling the same name stay two students.

4 of those come from a batch table. Because their table is known, each also gets a **batch-specific** finance record carrying that row’s fee, paid and balance snapshot, so a row that happens to lack a number does not lose its finances. The remaining 3 come from Tracker Master and get an unassigned record (`batch_id` null), because a transaction row does not say which batch table the student sits in.

Zero receipts, receipt numbers, PDFs and deliveries are planned. The workbook’s `Receipt Sent` value is preserved inside each payment’s `legacy_raw_json` as historical metadata only.

## 4. Batch candidates

23 batch candidates, one per detected table rather than one per sheet. A dated PSW sheet holds a Morning and an Evening table; one batch per sheet would merge two cohorts.

| Sheet | Source title (verbatim) | Session | Proposed `batches.name` | `start_date` |
| --- | --- | --- | --- | --- |
| `17th March 2025` | `PSW Morning Batch - 17th March 2025` | Morning | `17th March 2025 - Morning` | `2025-03-17` |
| `17th March 2025` | `PSW Evening Batch - 17th March 2025` | Evening | `17th March 2025 - Evening` | `2025-03-17` |
| `12th May 2025` | `PSW Morning Batch - 12th May 2025` | Morning | `12th May 2025 - Morning` | `2025-05-12` |
| `12th May 2025` | `PSW Evening Batch - 12th May 2025` | Evening | `12th May 2025 - Evening` | `2025-05-12` |
| `2nd July 2025` | `PSW Morning Batch - 2nd July 2025` | Morning | `2nd July 2025 - Morning` | `2025-07-02` |
| `2nd July 2025` | `PSW Evening Batch - 2nd July 2025` | Evening | `2nd July 2025 - Evening` | `2025-07-02` |
| `18th August 2025` | `PSW Morning Batch - 18th August 2025` | Morning | `18th August 2025 - Morning` | `2025-08-18` |
| `18th August 2025` | `PSW Evening Batch - 18 August 2025` | Evening | `18 August 2025 - Evening` | `2025-08-18` |
| `6th Oct 2025` | `PSW Morning Batch - 06th October 2025` | Morning | `06th October 2025 - Morning` | `2025-10-06` |
| `6th Oct 2025` | `PSW Evening Batch - 06th October 2025` | Evening | `06th October 2025 - Evening` | `2025-10-06` |
| `Dec 2025` | `PSW Morning Batch - December 2025` | Morning | `December 2025 - Morning` | **null** |
| `Dec 2025` | `PSW Evening Batch - December` | Evening | `December - Evening` | **null** |
| `Jan 2026` | `PSW Morning Batch - January 2026` | Morning | `January 2026 - Morning` | **null** |
| `Jan 2026` | `PSW Evening Batch - January 026` | Evening | `January 026 - Evening` | **null** |
| `March 2026` | `PSW Morning Batch - March 26` | Morning | `March 26 - Morning` | **null** |
| `March 2026` | `PSW Evening Batch - March 26` | Evening | `March 26 - Evening` | **null** |
| `27 April 26` | `PSW Morning Batch - 27th April 2026` | Morning | `27th April 2026 - Morning` | `2026-04-27` |
| `27 April 26` | `PSW Evening Batch - 27th April 2026` | Evening | `27th April 2026 - Evening` | `2026-04-27` |
| `1st June 2026` | `PSW Morning Batch - 1st June, 2026` | Morning | `1st June, 2026 - Morning` | `2026-06-01` |
| `1st June 2026` | `PSW Evening Batch - 1st June 2026` | Evening | `1st June 2026 - Evening` | `2026-06-01` |
| `Aug 2026` | `PSW Morning Batch - 29th JULY, 2026` | Morning | `29th JULY, 2026 - Morning` | `2026-07-29` |
| `Aug 2026` | `PSW Evening Batch - 29th JULY 2026` | Evening | `29th JULY 2026 - Evening` | `2026-07-29` |
| `ELCE 25 & 26` | _(none)_ | — | `ELCE 25 & 26` | **null** |

7 batch(es) get a null `start_date`. A date is produced only when the title states a day, a month and a four-digit year; no day is assumed, no two-digit year is expanded, and the year is never taken from the worksheet name. The sheet named `Aug 2026` carries tables titled "29th JULY, 2026", which is exactly why.

| Sheet | Source title | Why null |
| --- | --- | --- |
| `Dec 2025` | `PSW Morning Batch - December 2025` | no day of the month in the title; no date assumed |
| `Dec 2025` | `PSW Evening Batch - December` | no year in the title |
| `Jan 2026` | `PSW Morning Batch - January 2026` | no day of the month in the title; no date assumed |
| `Jan 2026` | `PSW Evening Batch - January 026` | year in the title is "026", not four digits; left uninterpreted |
| `March 2026` | `PSW Morning Batch - March 26` | year in the title is "26", not four digits; left uninterpreted |
| `March 2026` | `PSW Evening Batch - March 26` | year in the title is "26", not four digits; left uninterpreted |
| `ELCE 25 & 26` | _(none)_ | table has no title |

Every source title above is preserved verbatim in the batch plan and in `legacy_raw_json`. `batches.legacy_sheet_name` holds the exact worksheet name; `batches.code` holds the deterministic source-table key. `Morning`/`Evening` is appended only where the table title names it — never inferred from a table’s position on the sheet.

## 5. Payment routing

Tracker Master is the historical transaction source: 1014 rows, one planned payment each. No payment is created from a batch sheet’s ACTUAL section — those cells are very likely another representation of the same money, and importing both would double it. They are preserved inside each finance record’s `legacy_raw_json` instead.

| Routing outcome | Payments | Goes to |
| --- | --- | --- |
| Unique batch | 972 | the batch-specific finance record for that student |
| Ambiguous batch | 19 | an unassigned record (`batch_id` null); not guessed |
| No batch found | 20 | an unassigned record (`batch_id` null) |
| Missing student number | 3 | an unresolved student and its own unassigned record |
| **Total** | 1014 |  |

Tracker Master’s `Batch` column holds a date serial, not a batch name, and a date cannot distinguish the Morning cohort from the Evening one. It is never used to route a payment; it is preserved verbatim in `legacy_raw_json`.

2 payment(s) have a blank `Program` cell and take their program from the single canonical program of the student’s own batch tables. Each such inference is recorded on the payment in `legacy_raw_json.program_resolution`. Where the student’s batch tables do not agree on exactly one program, the row is reported as `unresolved_program` and plans no insert.

## 6. Preserved, not corrected

| Finding | Count | Handling |
| --- | --- | --- |
| Totals rows excluded | 35 | rows with money and no student; never a student, finance record, installment or payment |
| Other non-student rows excluded | 13 | rows in a data span carrying neither a student nor money |
| Duplicate candidates preserved | 7 group(s) / 14 rows | every row imported; nothing deduplicated |
| Same-ID name conflicts preserved | 189 | one student per exact student number; every spelling kept in `legacy_raw_json` |
| — of those, disagreeing within one sheet | 5 | the serious kind: one number written two ways into the same column |
| Formula/error cells preserved | 1 | not repaired, not coerced to zero, barred from becoming a student number |

| Sheet | Cell | Error | Disposition |
| --- | --- | --- | --- |
| `Aug 2026` | `A11` | `#REF!` | preserved as-is; not repaired, not coerced to zero, and barred from becoming a student number |

189 student number(s) carry more than one distinct name, of which 5 disagree within a single sheet. The rest differ only *between* sheets, which is mostly structural: Tracker Master holds one name column and the batch sheets hold two or three, so the two rarely reduce to the same string even for one person. Neither kind splits a student: one exact student number is one student, the canonical display name follows the approved priority (Tracker Master first, then the batch sheet), and every other spelling is preserved in `students.legacy_raw_json`. Nothing is fuzzy-matched or merged.

Tracker Master’s `Balance Fees` is a row-local formula, not a student outstanding balance. It is **not** mapped to `student_finance_records.legacy_balance`. Its raw value, displayed text and formula source are preserved in each payment’s `legacy_raw_json` and never recalculated.

Payment methods are stored exactly as the workbook spells them. `Etransfer`, `E-Transfer` and `ETRANSFER` remain three distinct historical values; none is normalised to a code list.

A blank cell is never converted to zero. Blank instalment cells create no installment, blank fee cells leave the legacy field null, and a blank `Enrollment Total Fees` means "not restated here" rather than a fee of zero.

## 7. Scheduled installments

1825 installments planned, from the scheduled side of each table only. On a PSW batch sheet that is the `INSTALLMENT FEE STRUCTURE` section; the identically-named columns in the `ACTUAL` section record money received and create nothing here.

| `installment_type` | Planned | Default note |
| --- | --- | --- |
| `monthly` | 1520 | `{Month} installment` |
| `enrollment` | 305 | `Enrolment fee` |

`installment_month` is **null on every planned installment**. The month columns name a month and never a year, and a schedule running from October into February spans two of them. There is no safe year to write, so the month label is preserved in `legacy_column_name` and in the default note instead. Deriving the year from the batch start date would look like fact once stored.

The ECEA/`ELCE` roster uses an ordinal plan — `1st Installment`, `2nd Installment` — not calendar months, and is not forced into one: those columns take `installment_type = other` and a note taken from the source heading. The scheduled section’s own `Total Fee` column is excluded: it is the total of the plan, not an instalment in it, and creating one would double the plan.

## 8. Source keys and idempotency

Every planned entity carries a deterministic source key built from the workbook SHA-256 and where in the workbook it came from. Two runs over the same file produce identical keys.

| Entity | Key parts |
| --- | --- |
| Batch | hash + `batch` + sheet + detected table key |
| Student | hash + `student` + exact student number |
| Unresolved student | hash + `unresolved-student` + sheet + source row |
| Finance record (batch) | hash + `finance-record` + sheet + source row + table key |
| Finance record (unassigned) | hash + `finance-record-unassigned` + student key + program |
| Payment | hash + `payment` + `Tracker Master` + source row |
| Installment | hash + `installment` + sheet + row + column + schedule section |

The workbook hash is the first part of every key, so a different file is a different key space: `legacy_source_row` only means something relative to one exact file. Before any apply, the importer checks `import_batches` for a completed import carrying the same SHA-256 and **refuses** a duplicate. There is no `--force` behaviour.

| Idempotency check | Result |
| --- | --- |
| Checked against `import_batches` | yes |
| Completed import of this hash exists | no |
| Note | no completed import of this workbook hash; an apply would be allowed to proceed |

## 9. Import exceptions

A source row that cannot safely become a normalized record has three possible fates, and two of them are unacceptable: inventing a value so it fits, or dropping it. An exception is the third — the row is preserved in `import_exceptions` exactly as the workbook holds it, with the reason it could not be normalized.

| Reason | Rows | Entity it would have been |
| --- | --- | --- |
| `missing_amount` | 1 | `payment` |

1 transaction row(s) state no amount. `payments.amount` is NOT NULL and no zero may be invented, so the row is preserved as an exception rather than becoming a payment: the money is not asserted and the history is not lost. Where such a row also establishes a student and a program, the student and the finance record are still planned — only the payment becomes an exception.

## 10. Unresolved rows

Every source row either has a deterministic planned import path or appears here with where it went instead. Nothing is dropped silently. Row numbers are aggregated into counts; the individual rows are listed in `.private/finance-import-analysis/unresolved-records.json`.

| Category | Rows | Sheets | Destination | Blocks a safe apply |
| --- | --- | --- | --- | --- |
| `missing_amount` | 1 | `Tracker Master` | `import_exceptions` | no |

## 11. Apply readiness

`READY_FOR_APPLY=true`

| Internal consistency check | Result |
| --- | --- |
| Every planned payment has an amount and a planned finance record | pass |
| Every installment and finance record resolves to a planned parent | pass |
| Source keys are unique across every planned entity | pass |

Reported, not blocking PSW/ECEA:

- 1 row(s) preserved as import exceptions: missing_amount
- 3 French row(s) deferred by an approved rule; reported separately

Deferral by an approved rule — French — is reported separately and does not make a PSW/ECEA apply unsafe. Any PSW/ECEA payment row without a deterministic path does, which is the whole point of the rule.

## 12. Database row counts

Access: connected with the service-role key, which sees every row.

| Table | Before the dry run | After the dry run | Changed |
| --- | --- | --- | --- |
| `programs` | 2 | 2 | no |
| `batches` | 0 | 0 | no |
| `students` | 0 | 0 | no |
| `student_finance_records` | 0 | 0 | no |
| `installments` | 0 | 0 | no |
| `payments` | 0 | 0 | no |
| `receipts` | 0 | 0 | no |
| `receipt_deliveries` | 0 | 0 | no |
| `reminder_deliveries` | 0 | 0 | no |
| `import_exceptions` | 0 | 0 | no |
| `import_batches` | 0 | 0 | no |

## 13. Prerequisites before an apply

Two migrations are prepared and **neither is applied by this phase**.

| Migration | What it does |
| --- | --- |
| `20260918120000_legacy_raw_json.sql` | adds a nullable `legacy_raw_json` column to `students`, `student_finance_records` and `installments`; only `payments` has one today |
| `20260918130000_import_exceptions.sql` | creates `import_exceptions` with RLS, so a row that cannot be normalized is preserved rather than invented or dropped |

Both are additive: no existing table, column, constraint or row is altered, and neither writes a row of any kind. An apply must run both first.

## 14. No database writes

**NO DATABASE DATA OF ANY KIND WAS WRITTEN IN THIS PHASE.**

No `import_batches` row was created. No students, batches, finance records, installments, payments or receipts were created or modified. No receipt number was generated, no PDF was produced and no email was sent. The only Supabase access is counting rows and one lookup against `import_batches`; the module that performs it exposes no insert, update, upsert or delete. The workbook was opened read-only from a buffer and its SHA-256 re-checked afterwards.

Dry run is the default and only behaviour. `--apply` is recognised solely so it can be refused with an explanation; no apply path exists in this phase.

---

_Generated by `npm run finance:import:dry-run` (`scripts/finance-import/import-workbook.mts`). Regenerate rather than edit by hand: every count here is read from the workbook._
