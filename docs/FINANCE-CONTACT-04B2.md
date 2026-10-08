# FINANCE-CONTACT-04B2 — Safe Existing-Student Contact Apply

Branch `feature/finance-contact-04b2-safe-apply`, created from `main` at
`2c9185b` (merged FINANCE-CONTACT-04B1). Hosted project
`hwekiiompxixybxclche`.

> **Status: infrastructure delivered; the original plan was SUPERSEDED and
> NOT EXECUTED.**
>
> - 04B2 delivered the safe contact-fill infrastructure: the atomic
>   `public.apply_student_contact_fill` RPC (migration applied to the hosted
>   project), the shared staging pipeline, the plan engine, the gated apply
>   CLI, the rolled-back RPC harness and their tests.
> - The original 220-student plan (§10) was reviewed but **never applied**.
>   `students.email` and `students.phone` were not changed by 04B2; both are
>   still NULL for every hosted row (re-verified 2026-10-08, §17).
> - Before live execution the business scope changed and that plan was
>   superseded by **FINANCE-CUTOVER-05A** (new finance workbook covering PSW
>   April / June / August / September 2026, ECEA and French).
> - Any future contact apply must generate a **new** plan from the
>   post-cutover dataset with a fresh dry run. Old plan hashes, including
>   the one in §10, must never be reused.
>
> §10–§12 are kept only as historical dry-run evidence of the tooling.

This document holds rules, counts and hashes only. Names, student numbers
and contact values exist solely in the hosted database, the ignored
`reference/` workbooks and the ignored `.private/` outputs.

---

## 1. What this ticket is, and is not

A **field-level safe fill** of `students.email` and `students.phone` for
EXISTING hosted students matched by EXACT student number, where the hosted
field is currently NULL.

It does not create students or enrollments, update names or student numbers,
change batches, sessions, finance records or payments, resolve the 22
Unassigned records, send email, or overwrite any non-NULL contact.

## 2. Pre-flight (verified 2026-09-26)

| Check | Result |
| --- | --- |
| branch | `feature/finance-contact-04b2-safe-apply`, `main` is an ancestor |
| PSW master sha256 | `9130458b3c17ee14a6229c597816b12e7f55ed82f19cd7fcfc99a272fe249a29` |
| ECEA master sha256 | `f328cfbda08453a359def3ae69290ca79be9d51bc6647c161752eb341e7eccb8` |
| finance workbook sha256 | `62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2` |
| `npm run finance:contact-audit` | reproduces 04B1 (236 / 226 / 9 / 1 / 32 / 4 shared emails / 4 shared phones / 4 session disagreements) |

Hosted baseline, counted under the admin's RLS session before any work and
again after the migration and the rolled-back RPC verification:

| Table | Count |
| --- | ---: |
| programs | 2 |
| batches | 23 |
| students | 385 |
| student_finance_records | 397 |
| installments | 1825 |
| payments | 1013 |
| receipts | 0 |
| receipt_deliveries | 0 |
| reminder_deliveries | 0 |
| import_batches | 1 |
| import_exceptions | 1 |
| audit_log | 0 |
| batch_finance_columns | 383 |
| students with non-NULL email | 0 |
| students with non-NULL phone | 0 |

Scope is unchanged from 04B1: operational intakes from 2025-12-01 through
2026-08-31 inclusive; the PSW 2026-09-28 intake and the ECEA September 2026
rows stay excluded; pre-December-2025 students are untouched.

## 3. Field-level eligibility

Both audit and plan run the same staging (`pipeline.mts`) and the same
engine (`reconcile.mts`); the plan (`apply-plan.mts`) then reduces the
operational row assessments to one candidate per unique hosted student and
decides each field separately.

**Email fills** only when every one of these holds: operational row; exact
student number; exactly one hosted student for that number; source email
valid; hosted email NULL; every source row for that student agrees; the
address is not shared with another student number; the student is hosted;
the row has a number.

**Phone fills** only when: the same identity conditions hold; the source
phone is `valid_nanp` under the 04B1 rule; hosted phone NULL; rows agree; the
number is not shared; the value is not invalid, ambiguous or written with a
non-1 country code.

Precedence per field, in order: hosted value already equal
(`ALREADY_MATCHES`, nothing to do) → hosted non-NULL and different
(`HELD_CONTACT_DIFFERENCE`, never overwritten) → rows disagree
(`HELD_SOURCE_CONFLICT`) → source problem (`HELD_INVALID_EMAIL`,
`HELD_INVALID_PHONE`, `HELD_AMBIGUOUS_PHONE`, `HELD_NON_NANP_PHONE`) →
nothing stated (`NO_SOURCE_VALUE`) → shared (`HELD_SHARED_CONTACT`) →
`SAFE_FILL`.

A student may receive email while phone stays NULL, and vice versa.

**Roster issues never block a contact fill.** Session mismatch, a number
listed in two intakes with agreeing contacts, intake discrepancies and name
spelling differences are recorded on the candidate as evidence flags
(`SESSION_DIFFERENCE`, `REPEATED_SOURCE_NUMBER`, `INTAKE_DIFFERENCE`,
`NAME_DIFFERENCE`) and counted; no roster or finance data is touched.

**Shared contacts are held.** A value that 04B1 found on two different
student numbers is not written for either student; the field stays NULL and
the candidate carries `HELD_SHARED_CONTACT`. Sharing is not treated as
evidence of a duplicate identity and no students are merged.

## 4. Deferred categories

| Category | Rows | Meaning |
| --- | ---: | --- |
| `DEFERRED_NEW_STUDENT` | 9 (9 distinct numbers) | exact number, no hosted student; left for the roster/enrollment ticket |
| `DEFERRED_MISSING_IDENTITY` | 1 | no student number; never matched by name, email or phone |
| `HELD_DUPLICATE_HOSTED_NUMBER` | 0 | the number would match more than one hosted row |

## 5. Storage normalization (`contact-normalization/1`)

**Email:** trimmed, lower-cased. Spelling, domain and missing characters are
never corrected. The original cell text is kept only in the private plan
and, for a written field, in the audit row's `metadata.sources[].email_raw`.

**Phone:** only a value the 04B1 rule classifies `valid_nanp` (ten digits,
or eleven starting with 1, area code and exchange 2–9) is written, as
`+1XXXXXXXXXX`. Ambiguous, invalid and explicit-international values are
never written and never converted. The UI may format for display later.

The RPC re-checks both forms and refuses a value that is not canonical
(`INVALID_EMAIL`, `INVALID_PHONE`), so nothing non-canonical can be stored
even by a bug in the planner.

## 6. The atomic RPC

Migration `supabase/migrations/20260926120000_student_contact_fill.sql`,
applied to the linked project on 2026-09-26 (`supabase migration list
--linked` showed only this file pending; `db push --dry-run` listed only
this file).

```
public.apply_student_contact_fill(
  p_student_id              uuid,
  p_email                   text  default null,
  p_phone                   text  default null,
  p_expected_student_number text  default null,
  p_metadata                jsonb default '{}'
) returns jsonb
```

**Security model.** `SECURITY INVOKER` (stated explicitly), `search_path =
''`, every reference schema-qualified, no dynamic SQL. It runs as the
calling role with the caller's JWT, so the existing RLS on `students`
(update: `can_write_finance()`) and `audit_log` (insert:
`can_write_finance()` and `actor_user_id = auth.uid()`) apply unchanged.
EXECUTE is revoked from `PUBLIC` and `anon` and granted to `authenticated`;
the hosted default privileges also leave EXECUTE with `service_role` and the
owner `postgres`, as for every function in the schema. The apply CLI calls
it through the admin's own session, never the service role.

**Checks inside the function, in order:** caller authenticated
(`NOT_AUTHENTICATED`) → `can_write_finance()` (`NOT_AUTHORISED`) → student
UUID given → at least one field proposed (`NO_FIELD_REQUESTED`) → metadata
is an object → email/phone canonical → `SELECT … FOR UPDATE` on the target
(`STUDENT_NOT_FOUND`) → expected student number matches
(`STUDENT_NUMBER_MISMATCH`) → each requested field is still NULL
(`STALE_TARGET`) → `UPDATE` of only the requested fields, guarded again by
`IS NULL` in the `WHERE` → one `audit_log` insert → return
`{student_id, student_number, audit_log_id, actor_user_id, fields, before,
after, updated_at}`.

**Atomicity.** The body runs inside the caller's transaction; PostgREST
gives each RPC call its own. Any exception anywhere in the body rolls back
both the student update and the audit insert. There is no client-side
two-step. Verified by fault injection (§9, cases K and L).

**Stale-target protection.** The row is locked and re-read at execution
time; a requested field that is no longer NULL raises `STALE_TARGET` and the
call writes nothing — including any other field in the same call (§9, case
E). The CLI records the student as `STALE_TARGET`, does not retry, and never
counts it as applied.

**Rollback / removal.** A later reviewed migration may `drop function
public.apply_student_contact_fill(uuid, text, text, text, jsonb)`. Dropping
it does not undo a fill; those stay recorded in `audit_log`.

## 7. Audit design

One `audit_log` row per student changed, inserted by the RPC:

| Column | Value |
| --- | --- |
| `actor_user_id` | `auth.uid()` of the caller (RLS also enforces this) |
| `entity_type` / `entity_id` | `student` / the student UUID |
| `action` | `contact_fill` |
| `before_data` | `{"email": null}` and/or `{"phone": null}` — only the fields in this call |
| `after_data` | the same keys with the written values |
| `metadata` | caller provenance merged with `rpc` and `fields` |

Provenance the CLI passes in `metadata`: `ticket`, `source_type =
master_contact_import`, `plan_version`, `plan_hash`, `normalization_rule`,
`program_codes`, `requested_fields`, `evidence_flags`, and one `sources[]`
entry per source row (`staged_row_id`, `program_code`, `workbook`,
`workbook_sha256`, `sheet`, `table`, `row`, plus `email_raw` / `phone_raw`
only for the field being written). Legacy finance JSON is not touched; the
table remains append-only (no UPDATE or DELETE policy exists).

The hosted audit row contains the written value, as the real change history.
No tracked file does.

## 8. Plan, hash, dry run and apply

`npm run finance:contact-apply` (or `-- --dry-run`) writes
`.private/finance-contact/contact-04b2-plan.json` — `{generatedAt, planHash,
plan}` — and `contact-04b2-plan-aggregate.md`, and prints the hash and
aggregate counts only. The hashed plan holds: ticket, plan version,
normalization rule, scope, every `reference/` workbook with its sha256, the
hosted baseline (project ref, the thirteen integrity counts, non-NULL
email/phone counts), the candidates (sorted by student UUID, each with
expected current email/phone, proposed values, field actions and reasons,
source evidence, workbook hashes, evidence flags) and the deferred rows.
The hash is SHA-256 of the key-sorted canonical JSON. The dry run counts
every integrity table before and after and re-hashes the workbooks.

`npm run finance:contact-apply -- --apply --plan-hash=<sha256>`:

1. `--apply` without `--plan-hash`, a malformed hash, or `--apply --dry-run`
   is refused (exit 5) — nothing is demoted to a silent dry run.
2. The plan is rebuilt from the current workbooks and hosted state and
   hashed. A different hash refuses (exit 5) and lists why, without values:
   a changed workbook, a changed hosted count, changed non-NULL contact
   counts, or candidates that differ from the stored plan.
3. Any hosted student number held by more than one row refuses.
4. Each candidate with a fill is sent to the RPC in plan order, as the
   admin's session. `STALE_TARGET` is recorded and skipped;
   `NOT_AUTHENTICATED` / `NOT_AUTHORISED` abort the run.
5. Counts are taken again and checked: every integrity table unchanged
   except `audit_log`, which must rise by exactly the number applied;
   non-NULL email and phone counts must rise by exactly the fields written.
   Results go to `.private/finance-contact/contact-04b2-apply-result.json`.
   Exit 6 if anything was stale, failed or an invariant did not hold.

**Idempotency.** After an apply the engine classifies a filled field as
`ALREADY_MATCHES` (`EXACT_UNCHANGED` in the audit), the next plan has 0
fills for it, and — because the baseline counts and candidates are part of
the hashed plan — the pre-apply hash no longer matches anything and cannot
be reused. Unit-tested in `apply-plan.test.mts`.

The audit already handles populated hosted contacts (`compareEmail` /
`comparePhone` distinguish unchanged, difference and fill); tests cover a
hosted value written in another presentation (`416-555-…`, mixed-case
address) still comparing equal.

## 9. RPC verification (rolled back, hosted)

`scripts/finance-contact/rpc-verification.sql`, run with `npx supabase db
query --linked -f …`, does everything inside one `DO` block that ends by
raising, so the eight fixture students, the test writes and the two
fault-injection triggers are all rolled back. Result on 2026-09-26:
**22 of 22 cases ok**, and the hosted counts afterwards were unchanged
(students 385, audit_log 0, no fixture rows, no leftover trigger or
function).

| Case | Result |
| --- | --- |
| A email NULL → email filled, one audit row limited to email | ok |
| B phone NULL → phone filled, one audit row limited to phone | ok |
| C both NULL → both filled, exactly one audit row | ok |
| D existing email → `STALE_TARGET`, no write, no audit row | ok |
| D2 same row, phone-only request → phone filled, email kept | ok |
| E existing phone, combined request → `STALE_TARGET`, email NOT written either | ok |
| F both proposed NULL → `NO_FIELD_REQUESTED` | ok |
| G authenticated uid with no writer profile → `NOT_AUTHORISED` (42501) | ok |
| H1 `anon` → no EXECUTE (42501) | ok |
| H2 `authenticated` with no claims → `NOT_AUTHENTICATED` | ok |
| I admin writer → allowed (A–C, D2) | ok |
| J `actor_user_id` = `auth.uid()` | ok |
| K forced UPDATE failure → no audit row, student unchanged | ok |
| L forced audit INSERT failure → student unchanged | ok |
| M names, number, legacy fields, active, created_at unchanged | ok |
| N1–N5 upper-case email, `+1`-less phone, international phone, wrong expected number, unknown UUID → each rejected | ok |
| conservation inside the transaction (fixtures + 4 successful fills, all attributed to the admin) | ok |

Not covered here: a real `viewer` account and a real `finance` account. The
hosted project has one profile (the admin), and the harness deliberately
creates no auth user and changes no role. Case G exercises the same
`can_write_finance()` branch a viewer fails; the finance role is the other
half of that predicate and is not tested by a live session.

## 10. Dry-run result (2026-09-26) — SUPERSEDED / NOT EXECUTED

Historical evidence only. This plan was superseded by FINANCE-CUTOVER-05A
and was never applied; its hash must not be reused.

Plan hash (superseded, do not use)
`83b733580b7b7c812e08b595f26931a3d6f9e8ea6702dba5059af334193cc41f`.

| | |
| --- | ---: |
| operational source rows | 236 |
| unique operational numbers | 234 |
| existing hosted matches (rows) | 226 |
| unique matched existing students | 225 |
| unique target students (any fill) | 220 |
| email fills | 220 |
| phone fills | 218 |
| students receiving both | 218 |
| students receiving email only | 2 |
| students receiving phone only | 0 |
| shared-contact holds (students; email and phone both held) | 5 |
| invalid-email holds | 0 |
| invalid-phone holds | 1 |
| ambiguous-phone holds | 1 |
| non-NANP phone holds | 0 |
| source-conflict holds | 0 |
| contact-difference holds | 0 |
| email / phone already matching hosted | 0 / 0 |
| new-student deferrals (rows / distinct numbers) | 9 / 9 |
| missing-ID deferrals | 1 |
| duplicate-hosted-number holds | 0 |
| name-difference flags | 32 |
| session-difference flags | 4 |
| intake-difference flags | 0 |
| repeated-number collapsed candidates | 1 |
| student rows that would be created | 0 |
| student rows that would be overwritten | 0 |
| expected audit_log rows after apply | 220 |

Fills by program: PSW 176 students, ECEA 44. The 220 proposed emails are
220 distinct values and the 218 proposed phones 218 distinct values. Every
candidate's expected current email and phone is NULL. Hosted counts were
identical before and after the dry run; the workbooks re-hashed unchanged.

These equal the 04B1 §11.1 population exactly (220 email / 218 phone / 5
shared / 2 phone-only holds / 9 new / 1 number-less / 1 repeated pair).

## 11. Post-apply expectations for the superseded plan (never run)

These applied only to the §10 plan and are not current targets. Had that
plan been approved and applied: students 385, finance tables
unchanged, student rows created 0, deleted 0, `audit_log` 0 → 220, students
with non-NULL email 0 → 220, with non-NULL phone 0 → 218. The CLI derives
every one of these from the live plan and checks them; nothing is hard-coded.
A second dry run afterwards must show 0 fills, 220 `ALREADY_MATCHES` on
email and 218 on phone, and a different plan hash.

## 12. Live apply command — SUPERSEDED, DO NOT RUN

The command reviewed for the §10 plan is withdrawn and was never executed.
It is deliberately not reproduced here so it cannot be copied.

The general form remains:

```
npm run finance:contact-apply -- --apply --plan-hash=<hash from a NEW dry run>
```

A future apply must start from a fresh `npm run finance:contact-apply --
--dry-run` against the post-cutover workbooks and hosted state, be reviewed
on its own, and use only that run's hash. The CLI also refuses a stale hash
on its own, because the workbooks and hosted counts are part of the hashed
plan.

## 13. UI

The finance detail drawer shows no contact area today, so nothing was
changed. Adding read-only email/phone to the student section of the drawer
would be small (the loader already selects from `students`), and is left to
a UI ticket; it is not needed to verify the writes, which the CLI's
count-based invariants and the audit log cover.

## 14. Quality gates (2026-09-26)

| Gate | Result |
| --- | --- |
| `npm test` | 699 / 699 |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run build` | ok |
| `npm run finance:contact-audit` (after migration) | 04B1 numbers reproduced, counts unchanged, conservation PASS |
| `npm run finance:contact-apply -- --dry-run` | §10, exit 0 |
| `npm run finance:reconcile` | 23 / 23 PASS |
| `npm run finance:unassigned-audit` | 41 payments, 0 lost (browser step skipped: no dev server) |
| RPC verification | 22 / 22, rolled back |

## 15. Privacy

`reference/*` (except its README) and `.private/` remain Git-ignored. The
tracked changes — migration, scripts, tests, SQL harness, this document —
contain only invented fixtures (`example.test`, 555 numbers, `T04B2-*`,
9xxxxx numbers), hashes and counts. Console output prints hashes and counts
only.

## 16. Files

- `supabase/migrations/20260926120000_student_contact_fill.sql` — the RPC
- `scripts/finance-contact/pipeline.mts` — staging + hosted reads shared by audit and apply (extracted from `contact-audit.mts`)
- `scripts/finance-contact/apply-plan.mts` — candidates, aggregate, canonical hash, RPC arguments, execution
- `scripts/finance-contact/contact-apply.mts` — the CLI (dry run default; gated apply)
- `scripts/finance-contact/rpc-verification.sql` — rolled-back RPC tests
- `scripts/finance-contact/apply-plan.test.mts`, `contact-apply.test.mts`
- `scripts/finance-contact/contact-audit.mts` — now uses the pipeline; integrity counts include `programs` and `batch_finance_columns`
- `package.json` — `finance:contact-apply`
- `scripts/README.md`, `supabase/migrations/README.md`, this document

The private plan files under `.private/finance-contact/` (`contact-04b2-plan.json`,
`contact-04b2-plan-aggregate.md`) are the superseded plan; they are ignored
and never committed. No `contact-04b2-apply-result.json` exists, because no
apply was run.

## 17. Supersede checkpoint (2026-10-08)

Business scope changed before the live contact apply. The 220-student plan
is closed as SUPERSEDED / NOT EXECUTED; the infrastructure is committed so
the hosted migration history matches the repository before
FINANCE-CUTOVER-05A starts.

Hosted state, re-verified on 2026-10-08:

| Check | Result |
| --- | ---: |
| students | 385 |
| student_finance_records | 397 |
| payments | 1013 |
| installments | 1825 |
| students with non-NULL email | 0 |
| students with non-NULL phone | 0 |
| audit_log (any action) | 0 |
| audit_log `contact_fill` rows | 0 |
| latest `students.updated_at` | 2026-09-18 (before 04B2) |
| `public.apply_student_contact_fill` present | yes |
| `supabase migration list --linked` | local and remote both list `20260926120000`; no mismatch |

The RPC stays in place: it is generic (any reviewed plan can use it) and
dropping it would need its own migration. Nothing in 04B2 changed student,
finance or contact data.
