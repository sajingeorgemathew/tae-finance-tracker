# scripts

Operational, developer-run scripts: workbook import, Excel backup/export,
Supabase type generation.

Anything here that touches `reference/` must open it read-only.

## Running these

They are TypeScript, run directly by Node's built-in type stripping — no
bundler, no `ts-node`, no build step. They use the `.mts` extension so Node
treats them as ES modules, and their relative imports carry that extension
because that is what Node's module resolution expects.

## `finance-import/` — FINANCE-IMPORT-02 Phase A

```
npm run finance:analyze
```

Reads the historical finance workbook from `reference/` and writes:

| Output | Committed? |
| --- | --- |
| `.private/finance-import-analysis/*.json` | **No** — Git-ignored. Row-level detail: names, student numbers, amounts. |
| `docs/FINANCE-IMPORT-02-ANALYSIS.md` | Yes. Structure, aggregates and mapping decisions only. |

**It writes nothing to the database and nothing to `reference/`.** The workbook
is parsed from a read-only buffer and re-hashed afterwards to prove it was not
modified; the run fails if the hash moved.

Two rules hold throughout, and Phase B inherits both:

* **The workbook is history.** Inconsistencies are flagged, never corrected. No
  balance is recalculated, no blank is filled from another row, no duplicate is
  removed, no student is merged.
* **Nothing identifying reaches a committed file.** The report prints column
  values only for an explicit allowlist of closed vocabularies (payment method,
  program, receipt-sent flag). Everything else is counted, not quoted. See
  `report.mts`, and the test in `report.test.mts` that guards it.

## `finance-import/` — FINANCE-IMPORT-02 Phase B1

```
npm run finance:import:dry-run
```

Performs the complete workbook-to-database mapping and writes:

| Output | Committed? |
| --- | --- |
| `.private/finance-import-analysis/*.json` | **No** — Git-ignored. The row-level plan: student numbers, names, amounts. |
| `docs/FINANCE-IMPORT-02-DRY-RUN.md` | Yes. Aggregate counts, sheet names and table titles only. |

**Dry run is the default.** Without both apply signals (see Phase B2 below),
nothing this script reaches can write: the planning modules hold no client, and
the only Supabase access on this path is counting rows, a schema probe and one
`import_batches` lookup, through `importer/supabase-readonly.mts`, which exposes
nothing else. The writing lives in a separate module that the dry-run path never
imports, so the guarantee is structural rather than a flag somebody has to
remember to leave unset.

The run proves it changed nothing: it counts the operational tables before and
after, and re-hashes the workbook.

Layout:

```
finance-import/
  analyze-workbook.mts   Phase A entry point: orchestrates, writes the outputs
  import-workbook.mts    Phase B1 entry point: the dry run, and B2's apply
  regenerate-apply-report.mts  re-renders the apply report. No client, no apply.
  import-plan.mts        the Phase A proposed mapping and open questions
  report.mts             renders the Phase A sanitised report
  lib/                   pure utilities — cells, headers, blocks, formulas, IDs
  analyzers/             one module per kind of sheet (Phase A)
  importer/              the mapping itself (Phase B1)
    source-tables.mts      worksheets -> the shape the planners work on
    source-keys.mts        deterministic keys; the idempotency primitive
    programs.mts           PSW -> PSW, ELCE -> ECEA, French deferred
    batches.mts            one batch per detected table; strict date reading
    students.mts           identity: exact student number, never a name
    finance-records.mts    per-student-per-batch records and legacy snapshots
    installments.mts       the scheduled side of a table only
    payments.mts           Tracker Master only, and the routing rules
    exceptions.mts         rows preserved verbatim instead of normalized
    plan.mts               orchestrates the above into one plan
    dry-run-report.mts     renders the sanitised dry-run report
    supabase-readonly.mts  counting, a schema probe and one lookup. No writes.
    fixtures.mts           synthetic sheets for the tests
    apply-preflight.mts    the safety gate (Phase B2); no override exists
    deterministic-ids.mts  source key -> RFC 4122 v5 UUID; the retry-safety primitive
    apply-rows.mts         the plan -> database rows. Pure; no client, no clock.
    apply.mts              the write itself, in FK order, then verification
    apply-report.mts       renders the sanitised apply report
    operator-verification.mts  the acceptance steps, as data rather than prose
    report-fixtures.mts    one plan full of people, for both reports' privacy tests
    rls-verification.mts   reads back as the application does, never as service role
    supabase-write.mts     the only module that writes. Service role only.
    batch-tables.mts       table discovery, shared by the plan and the manifest (03A)
    column-manifest.mts    the batch column layout: plan, match, render, privacy gate (03A)
  generate-column-manifest.mts  03A entry point: dry run, --write-migration, --check
```

## `finance-import/` — FINANCE-IMPORT-02 Phase B2

```
FINANCE_IMPORT_APPLY=YES npm run finance:import:apply
```

Applies the reviewed plan to hosted Supabase. This is the first phase that
writes historical finance data, and it writes it once.

| Output | Committed? |
| --- | --- |
| `.private/finance-import-analysis/import-apply-result.json` | **No** — Git-ignored. Row-level result, including internal source keys and derived UUIDs. |
| `docs/FINANCE-IMPORT-02-APPLY.md` | Yes. Aggregate counts and verification results only. |

**An apply needs two independent signals**: the `--apply` flag *and*
`FINANCE_IMPORT_APPLY=YES` in the environment. With either absent the script
runs the dry run and writes nothing — it does not prompt, and it does not warn
and continue. A flag alone is one arrow-key through shell history away from
writing historical financial data to production. The confirmation is supplied
per invocation and is deliberately not persisted to `.env.local`.

**There is no `--force`.** A completed import of the same workbook hash is
refused, and the way past that is review.

Before writing anything the run passes a pre-flight gate: the branch, the
workbook hash, the four required migrations (verified structurally, since the
project is not linked and migrations are applied by hand), `READY_FOR_APPLY`,
the plan's invariants, French still deferred, the operational tables still
empty, no completed import of this hash, and every regenerated count against the
reviewed Phase B1 baseline. The baseline is a tripwire, not an input: the plan is
always regenerated from the workbook, and a count that drifts stops the apply
and is named.

Writes go in foreign-key order and each entity class is verified by reading back
the ids it wrote. A mismatch stops the run there rather than continuing to the
next class. Afterwards the import is verified against the hosted database,
including that Tracker Master's 1,014 meaningful transaction rows are fully
accounted for as 1,013 payments plus 1 import exception, and that Row Level
Security still admits an admin and still blocks a stranger — checked *without*
the service role, which bypasses RLS and would prove nothing.

Every row is inserted under an RFC 4122 v5 UUID derived from its source key
rather than a generated one, so the whole graph can be built before anything is
sent and a retry after a partial transport failure converges instead of
doubling. See `importer/deterministic-ids.mts`.

### Regenerating the apply report

```
npm run finance:import:apply-report            rewrite the report
npm run finance:import:apply-report -- --check verify it is up to date
```

The apply runs once, so the report it produced cannot be refreshed by running
it again. `regenerate-apply-report.mts` renders the same document from the same
inputs instead — the recorded result in
`.private/finance-import-analysis/import-apply-result.json`, the plan rebuilt
from the workbook, and the acceptance steps recorded in
`importer/operator-verification.mts`. It has no database client and no
`--apply`; there is nothing in it to apply.

Every identifier the report states — the import batch ID, the `import_type`,
the workbook hash — comes from the recorded result and from nowhere else, which
is what stops a report restating an ID that no import ever had. The renderer
holding an identifier of its own is a test failure, and the operator
verification is data rather than prose appended after the fact, so the whole
document regenerates rather than all but its last section. `--check` renders
and compares without writing: that is how a reviewer confirms the committed
report is what these inputs produce.

## `finance-import/` — FINANCE-COLUMN-MANIFEST-03A

```
npm run finance:manifest                       dry run: plan and report, write nothing committable
npm run finance:manifest -- --write-migration   also (re)write the data migration
npm run finance:manifest -- --check             verify the committed migration is current
```

Derives each imported batch's **column layout** — which finance columns
existed, in what order, headed how, in which section, holding money or text —
from the workbook, using the importer's own block detection
(`importer/batch-tables.mts` is the table-discovery half of the import
planner, lifted out so the two cannot diverge). The layout is written as a
source-controlled SQL data migration; see `docs/FINANCE-COLUMN-MANIFEST-03A.md`.

| Output | Committed? |
| --- | --- |
| `.private/finance-import-analysis/column-manifest-plan.json` | **No** — Git-ignored, though it holds layout only. |
| `supabase/migrations/20260920120100_batch_finance_columns_legacy_manifest.sql` | Yes. Generated; 383 rows of batch codes, sheet names, column letters and headings. |

Three things to know:

* **The workbook is not required at application runtime.** The application
  reads `batch_finance_columns`; the generated migration is what a fresh
  environment runs. The workbook is needed only here, to reproduce or audit
  that migration from its source — `--check` is how a reviewer confirms the
  committed file is what the workbook produces, and a test does the same when
  the workbook is present.
* **The migration is already source-controlled.** Regenerating it in place is
  a no-op unless the rules change; a new migration per run would apply the
  same rows twice. Every row's id is the importer's v5 UUID over a source key
  (`batchFinanceColumnSourceKey`), and the migration is `on conflict do nothing`.
* **Nothing about a student reaches the artifact.** The generator refuses to
  write a migration containing any string literal that is not exactly a value
  of the layout — a whitelist computed from the plan, not a heuristic — and
  `importer/column-manifest.test.mts` checks it against fixtures with known
  names, numbers and amounts.

The dry run reads hosted `batches` and `programs` (read-only, through
`importer/supabase-readonly.mts`) to prove each table maps to exactly one batch
by deterministic id **and** batch code. Any ambiguity or gap blocks the whole
plan; nothing partial is written. It never writes to the database — applying
the migration is a separate, reviewed `supabase db push`.

Four rules hold across both phases:

* **The workbook is history.** Inconsistencies are flagged, never corrected.
* **A blank is not a zero.** The difference decides whether money exists at all.
* **Identity is the exact student number.** No fuzzy matching, ever. A row that
  names a student without numbering them gets its own unresolved student, keyed
  on that exact source row, rather than a manufactured number or a name match.
* **Every row has a destination.** A row that cannot become a normalized record
  is preserved in `import_exceptions` with the reason. Inventing a value to make
  it fit, and dropping it, are both unacceptable — that is what makes
  `READY_FOR_APPLY` mean something.

Tests cover the pure utilities in `lib/`, every mapping rule in `importer/`, and
the privacy allowlist on both committed reports:

```
npm test
```
