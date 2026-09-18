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

Layout:

```
finance-import/
  analyze-workbook.mts   entry point: orchestrates, writes the outputs
  import-plan.mts        the proposed mapping, import order and open questions
  report.mts             renders the sanitised Markdown report
  lib/                   pure utilities — cells, headers, blocks, formulas, IDs
  analyzers/             one module per kind of sheet
```

Tests cover the pure utilities in `lib/` and the report's privacy allowlist:

```
npm test
```
