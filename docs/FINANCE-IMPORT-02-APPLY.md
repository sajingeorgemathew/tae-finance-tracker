# FINANCE-IMPORT-02 — historical import apply (Phase B2)

The reviewed Phase B1 plan, applied to hosted Supabase. This is the first phase that wrote historical finance data. It followed [FINANCE-IMPORT-02-DRY-RUN.md](FINANCE-IMPORT-02-DRY-RUN.md), which followed [FINANCE-IMPORT-02-ANALYSIS.md](FINANCE-IMPORT-02-ANALYSIS.md).

## Privacy

This document contains aggregate counts, sheet names, table names and identifiers of rows that are not people. It contains no student names, no student numbers, no payer names, no remarks and no amount attributable to a person. Row-level detail is written to `.private/finance-import-analysis/`, which is Git-ignored and must stay that way.

## 1. Result

| Field | Value |
| --- | --- |
| Workbook | `finance-tracker.xlsx.xlsx` |
| Workbook SHA-256 | `62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2` |
| Workbook unchanged by the apply | yes |
| Import batch ID | `630f8106-4218-5989-90b9-c674de0a60f6` |
| Import status | **completed** |
| `import_type` | `finance_workbook` |
| Applied at (UTC) | 2026-09-18T23:26:33.899Z |

The import batch ID is itself derived from the workbook hash rather than generated, so a re-run after a failed apply continues the same import instead of opening a second one against the same file.

## 2. One documented deviation from the ticket

The ticket specifies `import_type = legacy_finance_workbook`. The foundation migration (`20260917143000_finance_foundation.sql`) constrains `import_batches.import_type` to `(finance_workbook, students, payments, other)`, and the pre-flight gate locks the applied migration list to four files — so widening that constraint is outside this phase. `finance_workbook` is the constrained vocabulary's term for exactly this import, and the ticket's intended label is recorded in the batch row's `notes` so the deviation is visible in the data, not only here. Nothing else in the ticket was varied.

## 3. Rows written

| Table | Planned | Verified present | Result |
| --- | --- | --- | --- |
| `batches` | 23 | 23 | pass |
| `students` | 385 | 385 | pass |
| `student_finance_records` | 397 | 397 | pass |
| `installments` | 1825 | 1825 | pass |
| `payments` | 1013 | 1013 | pass |
| `import_exceptions` | 1 | 1 | pass |

Students break down as **378 identified by exact student number** plus **7 unresolved source rows** carrying `student_number = NULL` (4 from batch tables, 3 from Tracker Master). Unresolved students were never merged by name and no student number was manufactured for them.

Finance records break down as **375 tied to a batch** plus **22 approved unassigned records** with `batch_id = NULL`.

## 4. Financial source conservation

Tracker Master is the only source of normalized historical payments. Every meaningful transaction row it holds has a destination:

| Quantity | Rows |
| --- | --- |
| Tracker Master meaningful transaction rows | 1014 |
| → `payments` | 1013 |
| → `import_exceptions` (`missing_amount`) | 1 |
| **Total accounted for** | **1014** |

1013 + 1 = 1014. No historical source transaction disappeared. The row without an amount did not become a payment of zero and was not discarded; `payments.amount` is `NOT NULL` and no value was invented for it.

## 5. `import_batches` counter semantics

| Counter | Value | Meaning |
| --- | --- | --- |
| `rows_seen` | 3644 | Every entity row the reviewed plan requires: batches + students + finance records + installments + payments + import exceptions. The `import_batches` row itself is excluded — it records the run, it is not imported by it. |
| `rows_imported` | 3644 | Of those, the rows verified present in the database after the write. |
| `rows_skipped` | 0 | Rows the plan required that the import did not write. **The missing-amount row is not counted here.** It is preserved as an import exception and is counted in both `rows_seen` and `rows_imported` as that exception. A skipped row would be a silent drop, and this import has none. |

## 6. Deterministic entity IDs

Every row was inserted under a primary key derived from its source key, not generated. The source key is the workbook SHA-256 plus where in that workbook the entity sits, so the same workbook and the same source entity always produce the same UUID.

| Property | Value |
| --- | --- |
| Scheme | RFC 4122 version 5 (SHA-1 over namespace + name) |
| Namespace name | `finance-import.toronto-academy-of-education` |
| Namespace UUID | `dc235a0f-c1c4-5283-8410-e32c8b0af1a8` |
| Namespace derivation | version 5 over the RFC 4122 DNS namespace and the namespace name above |
| Name | the importer's deterministic source key for the entity |
| Write mode | `upsert` on `id` with duplicates ignored |

This is what makes the apply retry-safe: a transport failure partway through an entity class can be re-run, and rows that already landed are recognised by primary key rather than inserted a second time. Nothing is ever updated by the write, so a retry cannot overwrite a value already in the database. SHA-1 is used here exactly as RFC 4122 specifies it — as a name-to-identifier mapping, not as a security primitive.

## 7. Post-import verification

**36 of 36 checks passed.** Every check was read back from hosted Supabase after the writes.

| Check | Expected | Actual | Result |
| --- | --- | --- | --- |
| batches match the reviewed plan | 23 | 23 | pass |
| PSW batches | 22 | 22 | pass |
| ECEA batches | 1 | 1 | pass |
| numbered students | 378 | 378 | pass |
| unresolved students | 7 | 7 | pass |
| total student rows | 385 | 385 | pass |
| finance records | 397 | 397 | pass |
| payments | 1013 | 1013 | pass |
| import exceptions | 1 | 1 | pass |
| PSW installments | 1825 | 1825 | pass |
| ECEA installments | 0 | 0 | pass |
| Tracker Master meaningful transaction rows | 1014 | 1014 | pass |
| payments + import exceptions = source transaction rows | 1014 | 1014 | pass |
| unresolved students carry no manufactured student number | 7 | 7 | pass |
| receipts created by this import | 0 | 0 | pass |
| receipt_deliveries created by this import | 0 | 0 | pass |
| reminder_deliveries created by this import | 0 | 0 | pass |
| programs in the database (PSW and ECEA only) | 2 | 2 | pass |
| French meaningful rows deferred, none normalized | 3 | 3 | pass |
| batches created from the French sheet | 0 | 0 | pass |
| payments read back | 1013 | 1013 | pass |
| payments with a finance record created by this import | 1013 | 1013 | pass |
| installments read back | 1825 | 1825 | pass |
| installments with a finance record created by this import | 1825 | 1825 | pass |
| finance records read back | 397 | 397 | pass |
| finance records with a student created by this import | 397 | 397 | pass |
| finance records with a valid program | 397 | 397 | pass |
| finance records left unassigned by the approved plan | 22 | 22 | pass |
| batches: duplicate deterministic ids | 0 | 0 | pass |
| students: duplicate deterministic ids | 0 | 0 | pass |
| student_finance_records: duplicate deterministic ids | 0 | 0 | pass |
| installments: duplicate deterministic ids | 0 | 0 | pass |
| payments: duplicate deterministic ids | 0 | 0 | pass |
| import_exceptions: duplicate deterministic ids | 0 | 0 | pass |
| deterministic ids unique across every entity class | 3644 | 3644 | pass |
| deterministic ids that are valid v5 UUIDs | 3644 | 3644 | pass |

The foreign-key checks are not asking whether the database accepted the row — the schema enforces that. They ask whether every child points at a row *this import* created, which a foreign key alone does not say.

## 8. Hosted table totals after the apply

| Table | Rows |
| --- | --- |
| `receipts` | 0 |
| `receipt_deliveries` | 0 |
| `reminder_deliveries` | 0 |
| `batches` | 23 |
| `students` | 385 |
| `student_finance_records` | 397 |
| `installments` | 1825 |
| `payments` | 1013 |
| `import_exceptions` | 1 |
| `programs` | 2 |

`receipts`, `receipt_deliveries` and `reminder_deliveries` are zero and were never written to. Tracker Master's historical *Receipt Sent* values stay inside preserved `legacy_raw_json` only: no receipt row, receipt number, PDF, delivery or email history was created, and no email or reminder was sent.

## 9. French remains deferred

The `French` sheet's **3 meaningful rows** were not imported. No French program, batch, student, finance record, payment or installment was created. `programs` holds 2 rows — PSW and ECEA — exactly as the configuration migration left it. The deferral is recorded in import metadata and in this report only.

## 10. Installments

| Program | Normalized installments | Rule applied |
| --- | --- | --- |
| PSW | 1825 | the explicit `INSTALLMENT FEE STRUCTURE` section only |
| ECEA | 0 | none — Enrollment fee, 1st/2nd Installment and Late fee columns stay in finance-record `legacy_raw_json` |

No installment was created from an actual-payment column, and none from an ECEA ordinal fee column. A blank scheduled cell is absent, not zero. No calendar year or month was invented: the PSW schedule names ordinal installments, so `installment_month` and `due_date` are null by design.

## 11. Preserved, not corrected

| Observation | Count | Disposition |
| --- | --- | --- |
| Totals rows excluded | 35 | not student rows; never imported as finance records |
| Duplicate payment candidates | 7 group(s) / 14 rows | **all imported**; historical payments are never deduplicated |
| Same-number name conflicts | 189 | one student number is one student; losing spellings preserved in `students.legacy_raw_json` |
| Formula/error cells | 1 | preserved verbatim in `legacy_raw_json`; never repaired |
| Payment method spellings | unchanged | written exactly as the workbook spells them; never normalized |
| Tracker Master *Balance Fees* | not mapped | a row-local formula, never written to `legacy_balance` |
| Batch-sheet ACTUAL columns | not mapped | preserved in finance-record `legacy_raw_json`; never imported as payments |

## 12. Row Level Security verification

Run separately from the apply and deliberately **not** with the service role, which bypasses RLS and would prove nothing about application access. No staff role was altered for this check.

| Check | Result |
| --- | --- |
| Unauthenticated read of finance data is blocked | pass |
| Authenticated admin can read finance data | pass |

Unauthenticated: 0 payment row(s) visible (expected 0 — every finance policy targets `authenticated`). Authenticated admin: 1013 payment row(s) and 397 finance record(s) visible (expected 1013 payments), resolved app role `admin`. Neither read used the service role.

## 13. Private apply report

The detailed, row-level result — including internal source keys and the derived UUIDs — is written to the Git-ignored private directory:

- `.private/finance-import-analysis/import-apply-result.json`

## 14. Re-running this import

A second apply of this workbook is **refused**: the pre-flight gate looks for a completed `import_batches` row with the same `source_file_hash` and stops. There is no `--force`. Applying at all requires both the `--apply` flag and `FINANCE_IMPORT_APPLY=YES` in the environment; with either absent the script runs the dry run and writes nothing. The confirmation is supplied per invocation and is not persisted to `.env.local` or to source control.

## 15. Post-apply operator verification

Ticket acceptance steps carried out by hand after the apply rather than importer outputs. They are recorded in `scripts/finance-import/importer/operator-verification.mts` and rendered from there, so regenerating this report reproduces this section too. Recorded at 2026-09-19T22:55:54.914Z.

### 15.1 Application health

The routes were exercised against the imported data.

| Route | Result |
| --- | --- |
| `/api/health` | 200 — `supabase: connected`; the body lists environment variable **names** and whether each is present, never a value |
| `/dashboard` | 307 → `/login?redirectTo=%2Fdashboard` when unauthenticated; renders once signed in |
| `/finance` | 307 → `/login?redirectTo=%2Ffinance` when unauthenticated; renders once signed in |
| `/settings` | 307 → `/login?redirectTo=%2Fsettings` when unauthenticated; renders once signed in |

The routes were exercised unauthenticated against a development server reading the imported data. No route that mutates was requested, and the hosted row counts were read back afterwards and matched the totals above exactly.

`/api/health` is development-only by design: it returns 404 under `next start`, which is the intended behaviour and not a regression. The 307 redirects are the correct unauthenticated result and are consistent with the Row Level Security checks above.

No finance spreadsheet UI was built in this phase.

### 15.2 Duplicate-import refusal, exercised

The apply was deliberately re-run after completion. The gate stopped it on two independent checks — the operational tables are no longer empty, and a completed `import_batches` row exists for this workbook hash — and exited non-zero having written nothing. Row counts were unchanged afterwards. Re-confirmed read-only when this report was regenerated: exactly one `import_batches` row exists for this workbook hash, its status is `completed`, and a further apply must therefore refuse. The refusal was not provoked a second time, because the gate is the thing being trusted and re-running an apply to watch it stop is not free.

### 15.3 Validation

| Command | Result |
| --- | --- |
| `npm test` | pass — 333 tests, 85 suites, 0 failures |
| `npm run lint` | pass — no findings |
| `npm run typecheck` | pass |
| `npm run build` | pass — 7 routes compiled |

### 15.4 Workbook

Re-hashed after everything above: `62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2` — unchanged. The receipt PDF template was not opened or modified.

