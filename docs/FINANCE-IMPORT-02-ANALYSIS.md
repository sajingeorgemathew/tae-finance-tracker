# FINANCE-IMPORT-02 — workbook analysis (Phase A)

Analysis only. **No database data of any kind was written in this phase** — see [No database writes](#19-no-database-writes) at the end of this document.

This report describes the structure of the historical finance workbook and proposes how it would map onto the schema created by FINANCE-DATA-01. It records inconsistencies in the workbook; it does not correct any of them.

## Privacy

The workbook holds real student financial records. This document contains sheet names, column headings, aggregate counts, structural patterns and mapping decisions only. It contains no student names, no individual student numbers, no payer names and no amounts attributable to a person. Row-level detail is written to `.private/finance-import-analysis/`, which is Git-ignored and must stay that way.

## 1. Workbook fingerprint

| Property | Value |
| --- | --- |
| File | `reference/finance-tracker.xlsx.xlsx` |
| Size | 268,547 bytes |
| SHA-256 | `62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2` |
| Last modified | 2026-09-17T17:39:50.013Z |
| Analyzed at | 2026-09-18T18:18:56.465Z |
| Date system | 1900 (with the Lotus leap-year bug) |
| Sheets | 15 |

The doubled extension in the filename is deliberate and preserved. The workbook is discovered by extension rather than by name, so nothing depends on that spelling. The hash is taken over the exact bytes read, and re-checked after the analysis to prove the file was not modified.

## 2. Sheet inventory

| # | Sheet | Used range | Declared rows | Last populated row | Tables | Merged | Formulas | Errors | Hidden |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `Summary` | A1:F247 | 247 | 247 | 1 | 0 | 0 | 0 | no |
| 2 | `Tracker Master` | A1:M1015 | 1015 | 1015 | 1 | 0 | 1016 | 0 | no |
| 3 | `17th March 2025` | A1:Z595 | 595 | 35 | 2 | 4 | 109 | 0 | no |
| 4 | `12th May 2025` | A1:AB36 | 36 | 36 | 2 | 4 | 139 | 0 | no |
| 5 | `2nd July 2025` | A1:AA38 | 38 | 38 | 2 | 5 | 121 | 0 | no |
| 6 | `18th August 2025` | A1:Z49 | 49 | 49 | 2 | 6 | 201 | 0 | no |
| 7 | `6th Oct 2025` | A1:Z43 | 43 | 43 | 2 | 4 | 147 | 0 | no |
| 8 | `Dec 2025` | A1:Y36 | 36 | 36 | 2 | 2 | 109 | 0 | no |
| 9 | `Jan 2026` | A1:AA49 | 49 | 49 | 2 | 0 | 121 | 0 | no |
| 10 | `March 2026` | A1:Z33 | 33 | 33 | 2 | 0 | 86 | 0 | no |
| 11 | `27 April 26` | A2:Y52 | 51 | 51 | 2 | 6 | 175 | 0 | no |
| 12 | `1st June 2026` | A2:X43 | 42 | 42 | 2 | 6 | 130 | 0 | no |
| 13 | `Aug 2026` | A2:V30 | 29 | 29 | 2 | 6 | 85 | 1 | no |
| 14 | `ELCE 25 & 26` | A1:P62 | 62 | 61 | 1 | 1 | 83 | 0 | no |
| 15 | `French` | A1:P62 | 62 | 61 | 1 | 1 | 61 | 0 | no |

**Declared range is not the data range.** `17th March 2025` declares 595 rows but stops carrying data at row 35. An importer must find the last meaningful row rather than trusting `!ref`.

### Header and data rows per sheet

| Sheet | Header row(s) | First data row | Last meaningful row | Empty-row runs inside the range |
| --- | --- | --- | --- | --- |
| `Summary` | 4 | 5 | 247 | 1-2 |
| `Tracker Master` | 1 | 2 | 1015 | — |
| `17th March 2025` | 2, 22 | 3 | 35 | 17-20, 36-595 |
| `12th May 2025` | 2, 20 | 3 | 36 | 16-18 |
| `2nd July 2025` | 2, 24 | 3 | 38 | 20-22 |
| `18th August 2025` | 2, 23 | 3 | 49 | 19-21 |
| `6th Oct 2025` | 2, 27 | 3 | 43 | 22-25 |
| `Dec 2025` | 2, 22 | 3 | 36 | 20-21 |
| `Jan 2026` | 2, 26 | 3 | 49 | 23-25, 47-48 |
| `March 2026` | 2, 21 | 3 | 33 | 20, 32 |
| `27 April 26` | 4, 24 | 5 | 51 | 2, 21-22, 52 |
| `1st June 2026` | 4, 25 | 5 | 42 | 2, 22-23, 43 |
| `Aug 2026` | 4, 16 | 5 | 29 | 2, 13-14, 30 |
| `ELCE 25 & 26` | 3 | 4 | 61 | 2, 62 |
| `French` | 3 | 4 | 61 | 2, 62 |

## 3. Sheet classification

| Sheet | Classification | Evidence |
| --- | --- | --- |
| `Summary` | `summary` | carries 2 aggregate heading(s) of the form "Sum of ...": "Sum of Amount Paid", "Sum of Balance Fees"; sheet is named "Summary" |
| `Tracker Master` | `transaction_master` | headings include Payment No, Amount Paid and Paid Date: one row is one payment |
| `17th March 2025` | `psw_batch` | 2 block title(s) name a PSW batch; block has a separate scheduled-installment section |
| `12th May 2025` | `psw_batch` | 2 block title(s) name a PSW batch; block has a separate scheduled-installment section |
| `2nd July 2025` | `psw_batch` | 2 block title(s) name a PSW batch; block has a separate scheduled-installment section |
| `18th August 2025` | `psw_batch` | 2 block title(s) name a PSW batch; block has a separate scheduled-installment section |
| `6th Oct 2025` | `psw_batch` | 2 block title(s) name a PSW batch; block has a separate scheduled-installment section |
| `Dec 2025` | `psw_batch` | 2 block title(s) name a PSW batch; block has a separate scheduled-installment section |
| `Jan 2026` | `psw_batch` | 2 block title(s) name a PSW batch; block has a separate scheduled-installment section |
| `March 2026` | `psw_batch` | 2 block title(s) name a PSW batch; block has a separate scheduled-installment section |
| `27 April 26` | `psw_batch` | 2 block title(s) name a PSW batch; block has a separate scheduled-installment section |
| `1st June 2026` | `psw_batch` | 2 block title(s) name a PSW batch; block has a separate scheduled-installment section |
| `Aug 2026` | `psw_batch` | 2 block title(s) name a PSW batch; block has a separate scheduled-installment section |
| `ELCE 25 & 26` | `other_program_batch` | headings include Student ID, Total Fee and Total Paid: one row is one student; no block title names PSW |
| `French` | `other_program_batch` | headings include Student ID, Total Fee and Total Paid: one row is one student; no block title names PSW |

> **A sheet is not a batch.** Every dated PSW sheet carries two batch tables — a Morning batch and an Evening batch — stacked vertically, each with its own title, header row and data span. This is the single most consequential structural finding in the workbook: an importer that treats one sheet as one batch would merge two cohorts.

## 4. Tracker Master

### Columns, exactly as spelled in the workbook

| Col | Heading (verbatim) | Recognised as | Filled | Blank | Formulas | Distinct |
| --- | --- | --- | --- | --- | --- | --- |
| A | `Payment No` | `payment_number` | 1013 | 1 | 0 | 13 |
| B | `Batch` | `batch` | 1011 | 3 | 0 | 11 |
| C | `Student ID ` | `student_id` | 1011 | 3 | 1 | 242 |
| D | `Student Name` | `student_name` | 1013 | 1 | 0 | 244 |
| E | `Amount Paid` | `amount_paid` | 1013 | 1 | 1 | 114 |
| F | `Paid Date` | `paid_date` | 999 | 15 | 0 | 309 |
| G | `Mode of Payment` | `payment_method` | 1010 | 4 | 0 | 13 |
| H | `Receipt Sent` | `receipt_sent` | 1009 | 5 | 0 | 2 |
| I | `Enrollment Total Fees` | `total_fee` | 232 | 782 | 0 | 49 |
| J | `Program` | `program` | 1012 | 2 | 0 | 2 |
| K | `REMARKS` | `remarks` | 9 | 1005 | 0 | 5 |
| L | `VIKAS REMARKS` | `remarks` | 5 | 1009 | 0 | 1 |
| M | `Balance Fees` | `balance` | 1014 | 0 | 1014 | 161 |

Several headings carry a trailing space — `"Student ID "` among them. They are reported and stored exactly as spelled; normalisation happens only for matching, never in the stored value.

### Row counts

| Measure | Count |
| --- | --- |
| Rows in the data span | 1014 |
| Entirely empty rows in the span | 0 |
| **Transaction rows** | **1014** |
| Distinct student numbers | 242 |
| Rows with no student number | 3 |
| Rows with no student name | 1 |
| Rows with no paid date | 15 |
| Rows with no amount | 1 |
| Rows with a zero amount | 0 |
| Rows with a negative amount | 1 |

### Stored value domains

- **Program** — `PSW` ×1009, `ELCE` ×3, `(blank)` ×2
- **Mode of Payment** — `Etransfer` ×734, `E-Transfer` ×153, `Credit Card` ×50, `Mastercard` ×36, `Cash` ×13, `MASTER CARD` ×7, `MASTERCARD` ×5, `(blank)` ×4, `CASH` ×4, `ETRANSFER` ×3, `AMEX` ×2, `Card` ×1, `MASTER` ×1, `VISA` ×1
- **Receipt Sent** — `YES` ×1005, `(blank)` ×5, `NO` ×4

These are printed exactly as stored, including case and spacing variants. They are not normalised here and must not be normalised on import.

### Payment No

Distinct values: 14. The sequence restarts at 1 for most students, so it numbers a student’s payments rather than the workbook’s rows.

### Enrollment Total Fees

| Measure | Count |
| --- | --- |
| Rows stating a value | 232 |
| Rows leaving it blank | 782 |
| Students with a value anywhere | 228 |
| Students stating it on their first row only | 214 |
| Students stating it on a later row too | 14 |
| Students whose stated values disagree | 0 |

**Finding:** stated once, on the student’s first transaction row. This is a per-student figure recorded once, not a property of each payment, and it belongs on the finance record rather than the payment. A blank on a later row means "not restated here" — it does not mean the fee is zero, and it is not filled in from the student’s other rows.

### Balance Fees

| Measure | Count |
| --- | --- |
| Rows holding a formula | 1014 |
| Rows holding a typed value | 0 |
| Blank rows | 0 |
| Negative results | 780 |
| Zero results | 1 |

Formula shape(s): `In-En`.

**Finding:** Balance Fees is a row-local subtraction of that row’s Amount Paid from that row’s Enrollment Total Fees. Because the fee is stated only once per student, every subsequent row computes `blank − amount` and yields a negative number. It is therefore **not** a running balance and **not** the student’s outstanding amount, despite its name. It is imported exactly as the workbook states it and is never recalculated.

### Date behaviour

| Column | Reads as | Interpreted range | Notes |
| --- | --- | --- | --- |
| `Batch` | date-serials | 2025-01-01 → 2026-12-12 | 12 distinct values — a date, not a batch name |
| `Paid Date` | date-serials | 2025-01-05 → 2026-12-20 | 15 row(s) leave it blank |

### Duplicate candidates

| Signature | Groups | Rows |
| --- | --- | --- |
| Identical across every column | 0 | 0 |
| Student number + amount + paid date | 7 | 14 |
| Student number + amount + paid date + payment no | 0 | 0 |

Largest candidate group: 2 rows. Adding Payment No to the signature collapses the count, because Payment No increments within each student and so makes the signature very nearly a primary key — which is why the looser signature is the informative one.

These are **potential duplicate candidates**, not duplicates. Two identical instalments paid on the same day are ordinary in this data. Nothing is removed or merged, and the import preserves every row unless removal is explicitly approved. See question **Q4**.

### Linking a payment to a batch

| Measure | Count |
| --- | --- |
| Distinct Batch values in Tracker Master | 12 |
| Batch tables in the workbook | 22 |
| Dated sheets in the workbook | 11 |
| Batch values falling on a batch table’s title date | 2 |
| Batch values matching no title date | 10 |
| Batch values matching more than one table | 0 |

2 of 12 distinct Batch values fall on the same day as a batch table title. See question **Q3**.

## 5. PSW batch sheets

22 batch tables across 11 sheets.

| Sheet | Table title (verbatim) | Title row | Header row | Data rows | Rows | With student no. | Non-student rows | Actual cols | Installment cols |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `17th March 2025` | `PSW Morning Batch - 17th March 2025` | 1 | 2 | 3–16 | 14 | 13 | 1 | G–S | T–Z |
| `17th March 2025` | `PSW Evening Batch - 17th March 2025` | 21 | 22 | 23–35 | 13 | 11 | 2 | G–S | T–Z |
| `12th May 2025` | `PSW Morning Batch - 12th May 2025` | 1 | 2 | 3–15 | 13 | 11 | 2 | G–T | U–AA |
| `12th May 2025` | `PSW Evening Batch - 12th May 2025` | 19 | 20 | 21–36 | 16 | 14 | 2 | G–T | U–AB |
| `2nd July 2025` | `PSW Morning Batch - 2nd July 2025` | 1 | 2 | 3–19 | 17 | 15 | 2 | G–S | T–Z |
| `2nd July 2025` | `PSW Evening Batch - 2nd July 2025` | 23 | 24 | 25–38 | 14 | 12 | 2 | G–S | T–AA |
| `18th August 2025` | `PSW Morning Batch - 18th August 2025` | 1 | 2 | 3–18 | 16 | 14 | 2 | G–R | S–Y |
| `18th August 2025` | `PSW Evening Batch - 18 August 2025` | 22 | 23 | 24–49 | 26 | 24 | 2 | G–R | S–Y |
| `6th Oct 2025` | `PSW Morning Batch - 06th October 2025` | 1 | 2 | 3–21 | 19 | 18 | 1 | G–R | S–Z |
| `6th Oct 2025` | `PSW Evening Batch - 06th October 2025` | 26 | 27 | 28–43 | 16 | 12 | 4 | G–R | S–Z |
| `Dec 2025` | `PSW Morning Batch - December 2025` | 1 | 2 | 3–19 | 17 | 17 | 0 | G–R | S–Y |
| `Dec 2025` | `PSW Evening Batch - December` | 22 | 22 | 23–36 | 14 | 14 | 0 | G–R | S–Y |
| `Jan 2026` | `PSW Morning Batch - January 2026` | 1 | 2 | 3–22 | 20 | 20 | 0 | G–T | U–AA |
| `Jan 2026` | `PSW Evening Batch - January 026` | 26 | 26 | 27–49 | 23 | 19 | 4 | G–T | U–AA |
| `March 2026` | `PSW Morning Batch - March 26` | 1 | 2 | 3–19 | 17 | 15 | 2 | G–S | T–Z |
| `March 2026` | `PSW Evening Batch - March 26` | 21 | 21 | 22–33 | 12 | 10 | 2 | G–S | T–Z |
| `27 April 26` | `PSW Morning Batch - 27th April 2026` | 3 | 4 | 5–20 | 16 | 15 | 1 | F–Q | R–X |
| `27 April 26` | `PSW Evening Batch - 27th April 2026` | 23 | 24 | 25–51 | 27 | 26 | 1 | F–Q | R–X |
| `1st June 2026` | `PSW Morning Batch - 1st June, 2026` | 3 | 4 | 5–21 | 17 | 14 | 3 | F–P | Q–W |
| `1st June 2026` | `PSW Evening Batch - 1st June 2026` | 24 | 25 | 26–42 | 17 | 13 | 3 | F–P | Q–W |
| `Aug 2026` | `PSW Morning Batch - 29th JULY, 2026` | 3 | 4 | 5–12 | 8 | 5 | 2 | F–N | O–U |
| `Aug 2026` | `PSW Evening Batch - 29th JULY 2026` | 15 | 16 | 17–29 | 13 | 11 | 2 | F–N | O–U |

### Structural variants

- **Title placement** — 19 table(s) put the title on its own row above the headings; 3 table(s) put the title and the headings on the same row.
- **Partial heading rows** — 11 table(s) restate only some headings and line up positionally with the table above. Affected: `17th March 2025` (1 heading(s) borrowed from row 2); `12th May 2025` (3 heading(s) borrowed from row 2); `2nd July 2025` (1 heading(s) borrowed from row 2); `18th August 2025` (1 heading(s) borrowed from row 2); `6th Oct 2025` (2 heading(s) borrowed from row 2); `Dec 2025` (16 heading(s) borrowed from row 2); `Jan 2026` (17 heading(s) borrowed from row 2); `March 2026` (8 heading(s) borrowed from row 2); `27 April 26` (1 heading(s) borrowed from row 4); `1st June 2026` (1 heading(s) borrowed from row 4); `Aug 2026` (1 heading(s) borrowed from row 4). Recorded as an observation; no heading was invented.
- **Section banners** — 11 table(s) carry an explicit `INSTALLMENT FEE STRUCTURE` banner; 11 do not, and their split was inferred from the heading row repeating `Total Fee`. Both are recorded with the evidence used.
- **Column positions differ between sheets** — the actual section starts at column F on some sheets and G on others. Columns must be resolved per table from its own heading row, never by fixed position.
- **A totals line sits inside the data span** of 19 of 22 tables: a row with money on it but no student. Its Total Paid cell sums down the column rather than across the row. It must not become a student, a finance record or a payment.
- **Total Paid sums a different span on different rows** in 10 table(s): `2nd July 2025` — the summed span differs between student rows: H:N on 12 row(s); H:O on 3 row(s); `2nd July 2025` — the summed span differs between student rows: H:N on 8 row(s); H:O on 4 row(s); `6th Oct 2025` — the summed span differs between student rows: H:N on 14 row(s); H:O on 4 row(s); `6th Oct 2025` — the summed span differs between student rows: H:O on 6 row(s); H:N on 5 row(s); `Dec 2025` — the summed span differs between student rows: H:O on 12 row(s); H:M on 5 row(s); `Dec 2025` — the summed span differs between student rows: H:O on 9 row(s); H:M on 4 row(s); `Jan 2026` — the summed span differs between student rows: I:O on 12 row(s); I:P on 4 row(s); `Jan 2026` — the summed span differs between student rows: I:O on 9 row(s); I:P on 9 row(s); `March 2026` — the summed span differs between student rows: H:M on 11 row(s); H:O on 3 row(s); I:M on 1 row(s); `March 2026` — the summed span differs between student rows: H:M on 8 row(s); H:O on 2 row(s).

## 6. Actual payments vs scheduled installments

Each batch table is split left-to-right into two sections that use **the same column headings**: both have a `Total Fee`, an `Enroll. Fee` and a run of month columns. They are different concepts:

| Section | Means | Maps to |
| --- | --- | --- |
| `ACTUAL FEE STRUCTURE` | the fee agreed, and money actually received | `student_finance_records.legacy_total_fee`, `payments` |
| `INSTALLMENT FEE STRUCTURE` | the payment plan — amounts expected, by month | `installments.scheduled_amount` |

### How the split was established

Not by position or by wording, but by the sheet’s own arithmetic. `Total Paid` is a `SUM` over a contiguous range, and the columns inside that range are the ones the workbook itself counts as money received:

| Sheet | Table | Total Paid column | Sums (student rows) | Consistent | Totals-row formula |
| --- | --- | --- | --- | --- | --- |
| `17th March 2025` | Morning | P | `H:O` ×13 | yes | `SUM(Hn:On)` |
| `17th March 2025` | Evening | P | `H:O` ×11 | yes | `SUM(Hn:On)`, `Pn-Gn` |
| `12th May 2025` | Morning | P | `H:O` ×11 | yes | `SUM(Pn:Pn)`, `Pn-Gn` |
| `12th May 2025` | Evening | P | `H:O` ×14 | yes | `SUM(Pn:Pn)`, `Pn-Gn` |
| `2nd July 2025` | Morning | P | `H:N` ×12, `H:O` ×3 | **no** | `SUM(Pn:Pn)`, `Pn-Gn` |
| `2nd July 2025` | Evening | P | `H:N` ×8, `H:O` ×4 | **no** | `SUM(Pn:Pn)`, `Pn-Gn` |
| `18th August 2025` | Morning | P | `H:O` ×14 | yes | `SUM(Hn:On)`, `SUM(Hn:Nn)` |
| `18th August 2025` | Evening | P | `H:O` ×24 | yes | `SUM(Hn:On)`, `SUM(Hn:Nn)` |
| `6th Oct 2025` | Morning | P | `H:N` ×14, `H:O` ×4 | **no** | `SUM(Hn:Nn)` |
| `6th Oct 2025` | Evening | P | `H:O` ×6, `H:N` ×5 | **no** | `SUM(Hn:Nn)` |
| `Dec 2025` | Morning | P | `H:O` ×12, `H:M` ×5 | **no** | — |
| `Dec 2025` | Evening | P | `H:O` ×9, `H:M` ×4 | **no** | — |
| `Jan 2026` | Morning | Q | `I:O` ×12, `I:P` ×4 | **no** | — |
| `Jan 2026` | Evening | Q | `I:O` ×9, `I:P` ×9 | **no** | — |
| `March 2026` | Morning | P | `H:M` ×11, `H:O` ×3, `I:M` ×1 | **no** | `SUM(Hn:Mn)` |
| `March 2026` | Evening | P | `H:M` ×8, `H:O` ×2 | **no** | — |
| `27 April 26` | Morning | O | `G:N` ×15 | yes | `SUM(Gn:Nn)` |
| `27 April 26` | Evening | O | `G:N` ×26 | yes | `SUM(Gn:Nn)` |
| `1st June 2026` | Morning | N | `G:M` ×14 | yes | `SUM(Gn:Mn)` |
| `1st June 2026` | Evening | N | `G:M` ×14 | yes | `SUM(Gn:Mn)` |
| `Aug 2026` | Morning | L | `G:K` ×6 | yes | `SUM(Gn:Kn)` |
| `Aug 2026` | Evening | L | `G:K` ×11 | yes | `SUM(Gn:Kn)` |

This is what establishes that `Enroll. Fee` on the actual side is **money received** rather than a fee: it falls inside the summed range. The identically-named `Enroll. Fee` on the installment side does not, and is a scheduled amount.

The spans above are measured over student rows only. The last column shows the different formula a trailing totals line uses, which sums down the column instead — counting it as a student row would make every table look inconsistent for the wrong reason.

### Month columns

234 month-named columns across all batch tables: **124** sit in the actual section and record money received, **110** sit in the installment section and record amounts scheduled. The same month name means different things in the two sections, and the two runs of months do not even cover the same months on most sheets.

**A blank month cell is not a zero payment.** It means no payment was recorded for that month. Nothing in the import may treat it as a payment of 0.

### Columns holding data with no heading

| Sheet | Table | Col | Filled | Formula shape(s) |
| --- | --- | --- | --- | --- |
| `17th March 2025` | Morning | F | 1 | _literal values_ |
| `17th March 2025` | Evening | F | 1 | _literal values_ |
| `12th May 2025` | Morning | Q | 12 | `Pn-Gn (12)` |
| `12th May 2025` | Evening | Q | 15 | `Pn-Gn (15)` |
| `12th May 2025` | Evening | AB | 14 | `SUM(Vn:AAn)-Un (14)` |
| `2nd July 2025` | Morning | O | 3 | _literal values_ |
| `2nd July 2025` | Morning | Q | 15 | `Pn-Gn (15)` |
| `2nd July 2025` | Evening | O | 4 | `SUM(On:On) (1)` |
| `2nd July 2025` | Evening | Q | 13 | `Pn-Gn (13)` |
| `2nd July 2025` | Evening | AA | 12 | `SUM(Un:Zn)-Tn (12)` |
| `18th August 2025` | Morning | Q | 15 | `Pn-Gn (14)`, `SUM(Qn:Qn) (1)` |
| `18th August 2025` | Evening | Q | 25 | `Pn-Gn (25)` |
| `6th Oct 2025` | Morning | Q | 19 | `Pn-Gn (19)` |
| `6th Oct 2025` | Morning | Z | 18 | `SUM(Tn:Yn)-Sn (18)` |
| `6th Oct 2025` | Evening | Q | 13 | `Pn-Gn (13)` |
| `6th Oct 2025` | Evening | Z | 13 | `SUM(Tn:Yn)-Sn (13)` |
| `Dec 2025` | Morning | Q | 17 | `Pn-Gn (17)` |
| `Dec 2025` | Evening | Q | 14 | `Pn-Gn (14)` |
| `Jan 2026` | Morning | R | 16 | `Qn-Gn (16)` |
| `Jan 2026` | Evening | R | 19 | `Qn-Gn (18)`, `SUM(Rn:Rn) (1)` |
| `March 2026` | Morning | Q | 17 | `Pn-Gn (16)`, `SUM(Qn:Qn) (1)` |
| `March 2026` | Evening | Q | 11 | `Pn-Gn (10)`, `SUM(Qn:Qn) (1)` |
| `27 April 26` | Morning | P | 16 | `On-Fn (16)` |
| `27 April 26` | Evening | P | 27 | `On-Fn (27)` |
| `1st June 2026` | Morning | O | 15 | `Nn-Fn (15)` |
| `1st June 2026` | Evening | O | 12 | `Nn-Fn (12)` |
| `Aug 2026` | Morning | M | 7 | `Ln-Fn (7)` |
| `Aug 2026` | Evening | M | 10 | `Ln-Fn (10)` |

On most sheets this is the outstanding-balance column: the heading was never typed, but the formula is `Total Paid − Total Fee`. It is identified by its formula, not by an assumption about position.

## 7. ELCE 25 & 26

| Col | Heading (verbatim) | Recognised as |
| --- | --- | --- |
| A | `Sr. No. ` | `serial_number` |
| B | `Student ID ` | `student_id` |
| C | `First Name ` | `first_name` |
| D | `Middle Name` | `middle_name` |
| E | `Last Name ` | `last_name` |
| F | `Start Date` | `start_date` |
| G | `YYYY/MM/DD` | `date_yyyymmdd` |
| H | `Payee` | `payer` |
| I | `WKD/WKND` | `schedule_type` |
| J | `Total fees` | `total_fee` |
| K | `Enrollment fees` | `enrollment_fee` |
| L | `1st Installment` | `installment_ordinal` |
| M | `2nd Installment` | `installment_ordinal` |
| N | `Late fees` | `late_fees` |
| O | `Total Paid` | `total_paid` |
| P | `Balance` | `balance` |

| Measure | Count |
| --- | --- |
| Rows in the data span | 58 |
| **Meaningful rows** | **51** |
| Rows with a serial number and nothing else | 7 |
| Rows with a student number | 48 |
| Rows with any name | 50 |
| Rows with any money value | 45 |
| Rows with a total fee | 33 |
| Rows with an enrollment fee | 38 |
| Rows with any installment value | 18 |
| Rows with a total paid | 29 |
| Rows with a balance | 0 |

Student number prefixes: `121` ×48. Payment data present: yes. Schedule data present: yes.

**Ambiguous date column.** Column G, headed `YYYY/MM/DD`, holds 20 serials that read as 1980-02-11 to 2004-01-06 — long before any batch start — while the adjacent `Start Date` column is empty. The heading states a format, not a meaning. What this column records is **not decided here**.

**This sheet must not be forced into the PSW monthly model.** Its plan is ordinal — `1st Installment`, `2nd Installment` — not calendar months, and it has three explicit name columns where the PSW sheets have two.

**Program identity is an open question.** The sheet is named `ELCE 25 & 26`; the database is configured with a program named *Early Childhood Education Assistant*, short code `ECEA`, student number prefix `121`. The student numbers on this sheet do use the `121` prefix, but that is not sufficient evidence that ELCE and ECEA are the same program, and **this analysis does not decide it**. Neither name has been altered. See question **Q1**.

## 8. French

| Col | Heading (verbatim) | Recognised as |
| --- | --- | --- |
| A | `Sr. No. ` | `serial_number` |
| B | `Student ID ` | `student_id` |
| C | `First Name ` | `first_name` |
| D | `Middle Name` | `middle_name` |
| E | `Last Name ` | `last_name` |
| F | `Start Date` | `start_date` |
| G | `YYYY/MM/DD` | `date_yyyymmdd` |
| H | `Payee` | `payer` |
| I | `WKD/WKND` | `schedule_type` |
| J | `Total fees` | `total_fee` |
| K | `Enrollment fees` | `enrollment_fee` |
| L | `1st Installment` | `installment_ordinal` |
| M | `2nd Installment` | `installment_ordinal` |
| N | `Late fees` | `late_fees` |
| O | `Total Paid` | `total_paid` |
| P | `Balance` | `balance` |

| Measure | Count |
| --- | --- |
| Rows in the data span | 58 |
| **Meaningful rows** | **3** |
| Rows with a serial number and nothing else | 55 |
| Rows with a student number | 0 |
| Rows with any name | 2 |
| Rows with any money value | 2 |
| Rows with a total fee | 1 |
| Rows with an enrollment fee | 2 |
| Rows with any installment value | 2 |
| Rows with a total paid | 1 |
| Rows with a balance | 0 |

Student number prefixes: _none_. Payment data present: yes. Schedule data present: yes.

**Blocked.** There is no French program configured in the database and none may be invented: `programs` is production configuration that decides how receipt numbers are assembled, and it ships as a migration. A French import needs a program row with an agreed short code, student number prefix and receipt course code first. See question **Q2**.

## 9. Summary sheet

| Measure | Value |
| --- | --- |
| Rows in the data span | 243 |
| Populated rows | 243 |
| Distinct student numbers | 234 |
| Formula cells | 0 |
| Reads as pivot output | yes |

Evidence:
- no cell in the data range holds a formula: the values are stored, not computed live
- headings are of the form "Sum of ...", the shape Excel gives a pivot value field
- a stray "Values" label sits above the headings, left by a pivot layout

Compared against Tracker Master:

| Measure | Count |
| --- | --- |
| Student numbers in both | 232 |
| Only in Summary | 2 |
| Only in Tracker Master | 10 |
| Totals that disagree | 16 |

16 student(s) total differently from the sum of their Tracker Master rows.

**Recommendation: do not import Summary rows as source-of-truth records.** The evidence is that it is derived: stored pivot output with no formulas and aggregate headings, and for 216 of the 232 student numbers it shares with Tracker Master its total is exactly the sum of that student’s transaction rows. Importing it would create a second record of money already recorded per transaction, with nothing to say which is authoritative.

**It is also out of date.** 16 student total(s) do **not** match the sum of that student’s current Tracker Master rows, and 10 student number(s) in Tracker Master are missing from it entirely — what a pivot that was refreshed once and then left behind looks like. That is a further reason not to import it, and a reason not to use it as a reconciliation oracle without first refreshing it.


## 10. Student numbers (aggregate only)

| Measure | Count |
| --- | --- |
| Student rows examined across all sheets | 1633 |
| Rows with no student number | 17 |
| **Distinct student numbers** | **380** |
| Numbers appearing on more than one sheet | 241 |
| In Tracker Master only | 1 |
| On batch sheets only | 138 |
| In both | 241 |
| Numbers with a leading zero | 0 |
| Numbers containing a non-digit character | 2 |

Prefix distribution: `125` ×330, `121` ×48, `(no prefix)` ×2.

Length distribution: `6` ×235, `5` ×143, `11` ×1, `7` ×1 characters.

**Malformed student numbers exist.** 2 number(s) contain a non-digit character, and the length distribution above shows values outside the five- and six-digit norm. They are recorded exactly as stored and are not cleaned up, reformatted or dropped. They are a reason the database has no unique constraint on `students.student_number` yet.

**Student numbers are text.** Some sheets store them as numbers and some as strings — the same value appears both ways. Reading one through a JS number risks losing a leading zero, and the prefix carries the program meaning (`125` → PSW, `121` → ECEA) that receipt numbering depends on.

### Identity findings

| Finding | Count |
| --- | --- |
| One student number with two name spellings **on the same sheet** | 5 |
| One student number whose name differs **between sheets** | 184 |
| One name appearing under more than one student number | 21 |
| Rows with a name but no student number | 17 |

The two rows are counted separately because they mean different things. A number carrying two spellings **on one sheet** is a genuine disagreement, written twice into the same column. A number whose name differs **between sheets** is mostly structural: Tracker Master records one `Student Name`, the batch sheets split the name across two or three columns, so the two rarely reduce to the same string even for the same person. The second number is reported, and is not on its own evidence of anything.

Matching is on **exact student number only**. Names are compared exactly, after trimming and case folding, and solely to raise these counts. No fuzzy matching was performed, no students were merged, and no name was rewritten. Each case needs a human decision before import. See questions **Q5** and **Q6**.

## 11. Date handling

The workbook uses the 1900 date system. Dates are stored as serial numbers, never as text. The strategy is to keep both forms:

- The **raw serial** goes into `legacy_raw_json`, untouched.
- The **parsed date** goes into the typed `date` column.
- Serials at or below 60 fall inside Excel’s fictional 1900-02-29 and are reported as ambiguous rather than converted.
- Serials outside a plausible range are flagged, not discarded — the `YYYY/MM/DD` column on the cohort sheets is exactly this case.

If a parse ever turns out to be wrong, the serial is still on record to correct it from. That is the whole reason for storing both.

## 12. Formulas and error cells

| Sheet | Formula cells | Error cells |
| --- | --- | --- |
| `Summary` | 0 | 0 |
| `Tracker Master` | 1016 | 0 |
| `17th March 2025` | 109 | 0 |
| `12th May 2025` | 139 | 0 |
| `2nd July 2025` | 121 | 0 |
| `18th August 2025` | 201 | 0 |
| `6th Oct 2025` | 147 | 0 |
| `Dec 2025` | 109 | 0 |
| `Jan 2026` | 121 | 0 |
| `March 2026` | 86 | 0 |
| `27 April 26` | 175 | 0 |
| `1st June 2026` | 130 | 0 |
| `Aug 2026` | 85 | 1 |
| `ELCE 25 & 26` | 83 | 0 |
| `French` | 61 | 0 |

1 error cell(s):

| Sheet | Cell | Error | Formula |
| --- | --- | --- | --- |
| `Aug 2026` | A11 | `#REF!` | `#REF!+1` |

**Not repaired.** An error cell has no value to import. Storing a zero would invent a figure the workbook never contained. See question **Q7**.

### What to import from a formula cell

**Both.** The calculated value goes into the typed column, because that is the figure the school saw and acted on. The formula source goes into `legacy_raw_json`, because it explains how the figure was reached and is the only way to tell a typed-in total from a computed one later. Formulas are never recalculated on import and never repaired.

## 13. Legacy preservation strategy

Every imported finance record and payment carries: `legacy_source_sheet`, `legacy_source_row`, `legacy_raw_json`.

`legacy_raw_json` holds:

| Key | Holds |
| --- | --- |
| `sheet` | sheet name, exactly as the workbook spells it |
| `block_title` | the batch table title, for sheets with more than one table |
| `row` | 1-based row number in the sheet |
| `column` | source column letter, for values taken from one cell |
| `header` | the column heading exactly as stored, trailing spaces and all |
| `raw_value` | the stored cell value, untouched — the serial, not the date |
| `formatted_text` | what Excel displayed, when the file carries it |
| `formula` | the formula source, where the cell had one |
| `cell_type` | the SheetJS cell type, so a blank is distinguishable from a zero |

- A date is stored as a serial and a parsed date. If the parse is ever wrong, the serial is still there to correct it from.
- A heading like "Student ID " carries a trailing space that identifies which sheet a value came from. Trimming it on import would lose that.
- Formula cells are imported as their calculated value, with the formula kept in legacy_raw_json. The value is what the school acted on; the formula explains how it got there.
- A blank and a zero are recorded distinguishably, because the difference decides whether a payment exists at all.

## 14. Proposed source → database mapping

No writes are performed. This is a proposal for Phase B.

### Tracker Master — `proposed`

**Grain:** one row is one payment

**Evidence:** 1014 populated rows carry a Payment No that restarts at 1 per student (242 distinct student numbers), an Amount Paid and a Mode of Payment. Enrollment Total Fees is filled on 232 rows and blank on 782: stated once, on the student’s first transaction row, so it is a per-student figure stated once, not a per-payment one.

**Target tables:** `students`, `student_finance_records`, `payments`

| Source column | Target | Note |
| --- | --- | --- |
| `Student ID` | `students.student_number` | text, never parsed as a number |
| `Student Name` | `students.legacy_name` | stored whole; not split into parts |
| `Amount Paid` | `payments.amount` | verbatim, including zero and negative values |
| `Paid Date` | `payments.payment_date` | serial parsed to a date; the serial is kept in legacy_raw_json |
| `Mode of Payment` | `payments.payment_method` | stored as written, not normalised to a code list |
| `Payment No` | `payments.reference` | the workbook’s own per-student sequence |
| `Program` | `programs.short_code (match only)` | matched, never created |
| `Batch` | `batches (match only)` | a date serial, not a batch name; see open questions |
| `Enrollment Total Fees` | `student_finance_records.legacy_total_fee` | taken from the row that states it; never copied onto other rows |
| `Balance Fees` | `payments.legacy_raw_json` | a row-local formula result, not a student balance; see cautions |
| `REMARKS, VIKAS REMARKS` | `payments.note` | kept separate and labelled by source column |
| `Receipt Sent` | `payments.legacy_raw_json + legacy receipt status` | never a receipts row; see the receipt strategy |

**Cautions:**

- Balance Fees is a single row-local formula shape across the column of the form In-En, evaluated against the same row only. Where Enrollment Total Fees is blank it yields the negative of that single payment (780 rows are negative). It must not be read as the student's outstanding balance and must never be recalculated.
- 3 row(s) have no student number and 15 have no paid date. Both import as-is; neither is filled in from elsewhere.
- 7 potential duplicate candidate group(s) covering 14 rows (same student number, amount and paid date), and 0 group(s) identical across every column. These are candidates, not confirmed duplicates: two identical instalments paid the same day are ordinary. All are imported unless removal is explicitly approved.

### PSW batch sheets — `proposed`

**Grain:** one row is one student in one batch; each sheet holds two batch tables

**Evidence:** 22 batch tables across 11 sheets — every dated sheet carries a Morning and an Evening table with separate titles, header rows and data spans.

**Target tables:** `batches`, `students`, `student_finance_records`, `installments`, `payments`

| Source column | Target | Note |
| --- | --- | --- |
| `block title` | `batches.name + batches.legacy_sheet_name` | title kept verbatim; the sheet name is recorded separately |
| `Student ID` | `students.student_number` | text; stored as a number on some sheets and a string on others |
| `First/Last Name` | `students.first_name / last_name` | kept as the sheet splits them, whatever that split is |
| `Payer / Payee` | `payments.payer_name` | present on some sheets only |
| `ACTUAL: Total Fee` | `student_finance_records.legacy_total_fee` | the fee agreed, not money received |
| `ACTUAL: Enroll. Fee, month columns, Late Fees` | `payments (source = legacy_import)` | one payment per populated cell; a blank cell creates nothing |
| `ACTUAL: Total Paid` | `student_finance_records.legacy_total_paid` | the sheet’s own SUM, stored but never used to validate the payments |
| `ACTUAL: Outstanding (often unheaded)` | `student_finance_records.legacy_balance` | stored as stated, including negatives |
| `INSTALLMENT: Total Fee, Enroll. Fee, month columns` | `installments (scheduled_amount)` | a plan, not money; installment_type enrollment or monthly |
| `Graduated / REMARKS` | `student_finance_records.status + note` | status words are recorded, not mapped to a lifecycle yet |
| `Discount` | `legacy_raw_json` | a formula against a constant list price; no target column exists |

**Cautions:**

- The ACTUAL and INSTALLMENT sections both contain a Total Fee, an Enroll. Fee and month columns with the same names. They are different concepts and must never be combined: one is money received, the other is money scheduled.
- A blank month cell means no payment was recorded, not a payment of zero. 22 tables rely on this.
- 10 table(s) sum a different column span into Total Paid on different rows (2nd July 2025: H:N / H:O; 2nd July 2025: H:N / H:O; 6th Oct 2025: H:N / H:O; 6th Oct 2025: H:O / H:N; Dec 2025: H:O / H:M; Dec 2025: H:O / H:M; Jan 2026: I:O / I:P; Jan 2026: I:O / I:P; March 2026: H:M / H:O / I:M; March 2026: H:M / H:O). Which columns count as money received therefore varies row by row on those sheets, and the per-cell import must not assume the header-row layout.
- 11 table(s) do not restate every heading and line up positionally with the table above them. The analysis records which headings were borrowed and from which row; an importer must resolve columns per table, not per sheet.

### ELCE cohort sheet — `blocked`

**Grain:** one row is one student with a two-instalment plan

**Evidence:** 51 meaningful rows; 48 carry a student number, 18 carry instalment values. No month columns and no ACTUAL/INSTALLMENT split.

**Target tables:** `students`, `student_finance_records`, `installments`, `payments`

| Source column | Target | Note |
| --- | --- | --- |
| `Student ID` | `students.student_number` | prefixes seen: 121 |
| `First / Middle / Last Name` | `students.first_name / middle_name / last_name` | three explicit name columns, unlike the PSW sheets |
| `Payee` | `payments.payer_name` | a payer, not the student |
| `WKD/WKND` | `batches.code or legacy_raw_json` | weekday/weekend stream; no column exists for it yet |
| `Total fees` | `student_finance_records.legacy_total_fee` | — |
| `Enrollment fees, 1st/2nd Installment, Late fees` | `payments` | amounts inside the Total Paid SUM, so money received |
| `Total Paid` | `student_finance_records.legacy_total_paid` | the sheet’s own SUM |
| `Balance` | `student_finance_records.legacy_balance` | — |

**Cautions:**

- This sheet must not be forced into the PSW monthly model. Its instalments are ordinal (1st, 2nd), not calendar months.
- The column headed "YYYY/MM/DD" holds serials reading 1980-02-11 to 2004-01-06 — decades before any batch start, and the adjacent "Start Date" column is empty. What it records is not decided here.

### French cohort sheet — `blocked`

**Grain:** one row is one student; the sheet is largely unpopulated

**Evidence:** 3 meaningful row(s) of 58 in the data span; 0 carry a student number and 2 carry any money value.

**Cautions:**

- No program row exists for French in the database, and none may be invented. Program configuration is a deliberate migration, not a side effect of an import.
- Without student numbers there is no reliable identity key for these rows.

### Summary — `not-imported`

**Grain:** one row is one student total

**Evidence:** 243 rows, 0 formulas. no cell in the data range holds a formula: the values are stored, not computed live; headings are of the form "Sum of ...", the shape Excel gives a pivot value field; a stray "Values" label sits above the headings, left by a pivot layout

**Cautions:**

- 16 student(s) total differently from the sum of their Tracker Master rows; 2 student number(s) appear only here and 10 only in Tracker Master.
- Importing these rows would create a second record of money already recorded per transaction, with no way to tell which is authoritative.

## 15. Proposed import order

| # | Step | Why here |
| --- | --- | --- |
| 1 | Create the import_batches row | Written first, with the workbook SHA-256, so every row that follows can be traced to one run of one file — and so a failed run is identifiable rather than anonymous. |
| 2 | Match programs; do not create them | programs is production configuration that decides receipt numbering. An unmatched program value stops the import rather than inventing a row. |
| 3 | Create batches, one per batch table rather than one per sheet | Each dated sheet holds a Morning and an Evening batch. One batch per sheet would merge two cohorts. |
| 4 | Create students, keyed on exact student number | Everything downstream references a student. Rows without a number are held back for review rather than matched on name. |
| 5 | Create student_finance_records from the batch sheets, one per student per batch | The batch sheets carry the per-student fee, total paid and balance. legacy_* values are written exactly as the workbook states them. |
| 6 | Create installments from the INSTALLMENT section only | A scheduled amount is not money. Keeping the scheduled side out of payments is what stops the two being added together. |
| 7 | Create payments from the ACTUAL section cells and from Tracker Master rows | Payments need their finance record to exist. Both sources are recorded with their own legacy_source_sheet so they stay distinguishable. |
| 8 | Record historical receipt status as metadata | Last, and only as a status: it depends on payments existing and must not become a receipt. |

## 16. Historical "Receipt Sent" status

**Recommendation:** Store the workbook’s Receipt Sent value as a legacy status on the payment, inside legacy_raw_json and as a boolean-with-provenance field. Do not create a receipts row and do not create a receipt_deliveries row.

- The workbook records that a receipt was sent. It does not record a receipt number, a PDF, a recipient address or a send timestamp.
- A receipts row implies a receipt document exists and can be reissued. Creating one from a "YES" would fabricate a record the school could send to a student.
- Receipt numbers are generated from program configuration and a sequence. Inventing numbers for historical receipts would collide with, or corrupt, that sequence.
- A receipt_deliveries row asserts a provider, a message id and an address that were never recorded. That is fabricated delivery history.

Phase B must not: generate receipt numbers for historical payments; generate PDFs for historical payments; create receipt_deliveries rows from a Receipt Sent flag; normalise the recorded values into a boolean without keeping what was written.

## 17. Idempotency strategy

**Key:**

- import_batches.source_file_hash — the workbook SHA-256
- legacy_source_sheet — the sheet the row came from
- legacy_source_row — the 1-based row number
- the source column letter, for batch sheets where one row yields several payments

**Behaviour:**

- A re-run of the same workbook hash finds every row it would create already present and creates nothing.
- A re-run with a different hash is a different source file and is refused unless explicitly confirmed, because the row numbers it would key on no longer mean the same rows.
- Rows that were held back for review stay held back on a re-run; they are not silently imported once the code changes.
- The import runs in one transaction per sheet, so a failure leaves no half-imported batch.

**On database constraints:**

- No unique constraint is added to students.student_number yet: the workbook contains numbers that appear with more than one name, and a database constraint would reject real history before a human has looked at it.
- Uniqueness is enforced in the importer, on (import_batch, legacy_source_sheet, legacy_source_row, source column), which is a property of the import rather than of the data.
- A partial unique index on payments over the legacy key, restricted to source = legacy_import, is the natural next step once the duplicate-candidate question is answered.

## 18. Open questions and blockers

4 blocking, 5 non-blocking. Phase B should not start on the blocking ones until they are answered.

### Q1-ELCE-PROGRAM-IDENTITY — **blocking**

**Question:** Is the sheet "ELCE 25 & 26" the same program as the configured ECEA (Early Childhood Education Assistant, prefix 121)?

**Why it matters:** Every ELCE finance record needs a program_id. Matching it to ECEA on a hunch would file real money under the wrong program and produce wrong receipt numbers, since receipt numbers are built from the program code.

**What the analysis found:** ELCE student numbers use the prefix 121, and ECEA is configured with student_number_prefix 121. The prefix agrees but the names do not. Neither name is altered by this analysis.

### Q2-FRENCH-PROGRAM-CONFIG — **blocking**

**Question:** Should a French program be configured, and with what short code, student number prefix and receipt course code?

**Why it matters:** programs is production configuration that decides how receipt numbers are assembled. It ships as a migration, so a value guessed here would become a permanent, wrong part of every French receipt.

**What the analysis found:** The French sheet has 3 meaningful row(s), 0 with a student number and 2 with money values. No French program exists in the database.

### Q3-BATCH-COLUMN-MEANING — **blocking**

**Question:** Should the Tracker Master "Batch" date serial be matched to a batch table by date, or kept only as a raw value?

**Why it matters:** Tracker Master identifies a batch by a date while the batch sheets identify it by a title, and each dated sheet holds both a Morning and an Evening batch. A date alone cannot say which of the two a payment belongs to, and payments.student_finance_record_id is NOT NULL.

**What the analysis found:** Batch reads as date-serials across 12 distinct values spanning 2025-01-01 to 2026-12-12, against 22 batch tables on 11 dated sheets. 2 of 12 distinct Batch values fall on the same day as a batch table title.

### Q4-DUPLICATE-CANDIDATES

**Question:** Should all 14 rows in the 7 potential duplicate candidate group(s) be imported?

**Why it matters:** Two payments of the same amount on the same day by the same student are ordinary — an instalment paid in two parts, or a second student on one card. Dropping them would silently lose real money; keeping a genuine double-entry would overstate it. This is a business decision, not a technical one.

**What the analysis found:** 0 group(s) are identical across every column. 7 group(s) share student number, amount and paid date (largest group: 2 rows). Adding Payment No to the signature reduces this to 0 group(s), because Payment No increments within each student and so makes the signature very nearly a key.

### Q5-ROWS-WITHOUT-STUDENT-NUMBER — **blocking**

**Question:** How should the 3 transaction row(s) with no student number be attached to a student?

**Why it matters:** payments.student_finance_record_id is NOT NULL, so a payment cannot be stored without resolving a student. Matching on name alone would be a fuzzy identity decision on real money.

**What the analysis found:** 3 populated row(s) carry a name but no student number.

### Q6-IDENTITY-CONFLICTS

**Question:** Are the 5 student number(s) that carry two different names on one sheet one person each, or two people sharing a number?

**Why it matters:** Student numbers are the only identity key trusted here. If one number covers two people, importing by number would merge two students’ finances into a single record.

**What the analysis found:** 5 student number(s) appear with two name spellings within a single sheet, which is a genuine disagreement. A further 184 differ only between sheets, which is mostly structural: Tracker Master holds one name column and the batch sheets hold two or three. Separately, 21 name(s) appear under more than one student number. No merging or fuzzy matching was performed.

### Q7-FORMULA-ERROR-CELLS

**Question:** What should be stored for cells that currently hold a spreadsheet error?

**Why it matters:** An error cell has no numeric value to import. Storing zero would invent a figure; storing nothing loses the fact that the workbook had an error there.

**What the analysis found:** Aug 2026: A11 #REF!

### Q8-SHEET-NAME-VS-TITLE

**Question:** Which is authoritative when a sheet name and its block title disagree about the batch date?

**Why it matters:** batches.start_date and the batch name both come from here, and they must not disagree once imported.

**What the analysis found:** sheet "Aug 2026" vs title "PSW Morning Batch - 29th JULY, 2026"; sheet "Aug 2026" vs title "PSW Evening Batch - 29th JULY 2026"

### Q9-BATCH-DATE-CONFIDENCE

**Question:** Confirm the start date for the 6 batch table(s) whose title does not give an unambiguous date.

**Why it matters:** batches.start_date is a real date column; an assumed first-of-month would look like fact once stored.

**What the analysis found:** "PSW Morning Batch - December 2025" — no day in title; first of month assumed; "PSW Evening Batch - December" — month named but no year found in title; "PSW Morning Batch - January 2026" — no day in title; first of month assumed; "PSW Evening Batch - January 026" — year in title is "026", not four digits; left uninterpreted; "PSW Morning Batch - March 26" — year in title is "26", not four digits; left uninterpreted; "PSW Evening Batch - March 26" — year in title is "26", not four digits; left uninterpreted

## 19. No database writes

**NO DATABASE DATA WAS WRITTEN IN THIS PHASE.**

No students, batches, finance records, installments, payments or receipts were created. No receipt numbers were generated, no PDFs were produced and no email was sent. The workbook was opened read-only from a buffer and its SHA-256 re-checked afterwards; the receipt template PDF was not touched. This document and the Git-ignored JSON under `.private/finance-import-analysis/` are the only outputs.

---

_Generated by `npm run finance:analyze` (`scripts/finance-import/analyze-workbook.mts`). Regenerate rather than edit by hand: every count here is read from the workbook._
