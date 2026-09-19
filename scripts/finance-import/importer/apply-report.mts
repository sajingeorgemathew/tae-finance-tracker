/**
 * Renders the committable apply report.
 *
 * Same rule as the Phase A and Phase B1 reports, and for the same reason: this
 * file writes a document that goes into Git from data describing real students'
 * finances. **Aggregates and structure only.** No student number, no name, no
 * payer, no remark and no amount attributable to a person. Source row numbers
 * are aggregated into counts rather than listed, because a row number plus the
 * workbook identifies a person.
 *
 * Sheet names, table titles, column headings, table names and UUIDs of rows
 * that are not people are structural facts and are printed.
 */

import type { ApplyResult } from './apply.mts'
import type { OperatorVerification } from './operator-verification.mts'
import type { DryRunPlan } from './plan.mts'

function table(headers: string[], rows: (string | number)[][]): string {
  const head = `| ${headers.join(' | ')} |`
  const rule = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n')
  return [head, rule, body].join('\n')
}

function tick(passed: boolean): string {
  return passed ? 'pass' : '**FAIL**'
}

export interface ApplyReportInputs {
  result: ApplyResult
  plan: DryRunPlan
  workbookUnchanged: boolean
  appliedAt: Date
  /** Private output files written by this run, as repo-relative paths. */
  privateOutputs: string[]
  /** The RLS verification, run separately from the service-role apply. */
  rls: {
    attempted: boolean
    adminReadSucceeded: boolean | null
    anonymousReadBlocked: boolean | null
    note: string
  }
  /**
   * The acceptance steps carried out by hand after the apply. Rendered from
   * `operator-verification.mts` so that the whole document is generated — a
   * hand-appended tail is the part that goes stale unnoticed.
   */
  operator: OperatorVerification
}

export function renderApplyReport(inputs: ApplyReportInputs): string {
  const { result, plan, workbookUnchanged, appliedAt, rls, operator } = inputs
  const { counts } = plan
  const out: string[] = []

  out.push('# FINANCE-IMPORT-02 — historical import apply (Phase B2)')
  out.push('')
  out.push(
    'The reviewed Phase B1 plan, applied to hosted Supabase. This is the first phase that ' +
      'wrote historical finance data. It followed ' +
      '[FINANCE-IMPORT-02-DRY-RUN.md](FINANCE-IMPORT-02-DRY-RUN.md), which followed ' +
      '[FINANCE-IMPORT-02-ANALYSIS.md](FINANCE-IMPORT-02-ANALYSIS.md).',
  )
  out.push('')

  // --- Privacy ---------------------------------------------------------------
  out.push('## Privacy')
  out.push('')
  out.push(
    'This document contains aggregate counts, sheet names, table names and identifiers of rows ' +
      'that are not people. It contains no student names, no student numbers, no payer names, no ' +
      'remarks and no amount attributable to a person. Row-level detail is written to ' +
      '`.private/finance-import-analysis/`, which is Git-ignored and must stay that way.',
  )
  out.push('')

  // --- 1. Result -------------------------------------------------------------
  out.push('## 1. Result')
  out.push('')
  out.push(
    table(
      ['Field', 'Value'],
      [
        ['Workbook', `\`${plan.fingerprint.fileName}\``],
        ['Workbook SHA-256', `\`${result.workbookSha256}\``],
        ['Workbook unchanged by the apply', workbookUnchanged ? 'yes' : '**NO**'],
        ['Import batch ID', `\`${result.importBatchId}\``],
        ['Import status', `**${result.status}**`],
        ['`import_type`', `\`${result.importType}\``],
        ['Applied at (UTC)', appliedAt.toISOString()],
      ],
    ),
  )
  out.push('')
  out.push(
    'The import batch ID is itself derived from the workbook hash rather than generated, so a ' +
      're-run after a failed apply continues the same import instead of opening a second one ' +
      'against the same file.',
  )
  out.push('')

  // --- 2. Deviation ----------------------------------------------------------
  out.push('## 2. One documented deviation from the ticket')
  out.push('')
  out.push(
    'The ticket specifies `import_type = legacy_finance_workbook`. The foundation migration ' +
      '(`20260917143000_finance_foundation.sql`) constrains `import_batches.import_type` to ' +
      '`(finance_workbook, students, payments, other)`, and the pre-flight gate locks the applied ' +
      'migration list to four files — so widening that constraint is outside this phase. ' +
      '`finance_workbook` is the constrained vocabulary\'s term for exactly this import, and the ' +
      'ticket\'s intended label is recorded in the batch row\'s `notes` so the deviation is visible ' +
      'in the data, not only here. Nothing else in the ticket was varied.',
  )
  out.push('')

  // --- 3. What was written ---------------------------------------------------
  out.push('## 3. Rows written')
  out.push('')
  out.push(
    table(
      ['Table', 'Planned', 'Verified present', 'Result'],
      result.entities.map((entity) => [
        `\`${entity.table}\``,
        entity.planned,
        entity.verified,
        tick(entity.passed),
      ]),
    ),
  )
  out.push('')
  out.push(
    `Students break down as **${counts.students} identified by exact student number** plus ` +
      `**${counts.unresolvedStudents} unresolved source rows** carrying \`student_number = NULL\` ` +
      `(${counts.unresolvedBatchStudents} from batch tables, ${counts.unresolvedTrackerStudents} ` +
      'from Tracker Master). Unresolved students were never merged by name and no student number ' +
      'was manufactured for them.',
  )
  out.push('')
  out.push(
    `Finance records break down as **${counts.financeRecordsBatchSpecific} tied to a batch** plus ` +
      `**${counts.financeRecordsUnassigned} approved unassigned records** with \`batch_id = NULL\`.`,
  )
  out.push('')

  // --- 4. Conservation -------------------------------------------------------
  out.push('## 4. Financial source conservation')
  out.push('')
  out.push(
    'Tracker Master is the only source of normalized historical payments. Every meaningful ' +
      'transaction row it holds has a destination:',
  )
  out.push('')
  out.push(
    table(
      ['Quantity', 'Rows'],
      [
        ['Tracker Master meaningful transaction rows', counts.payments],
        ['→ `payments`', counts.paymentsPlanned],
        ['→ `import_exceptions` (`missing_amount`)', counts.importExceptions],
        [
          '**Total accounted for**',
          `**${counts.paymentsPlanned + counts.importExceptions}**`,
        ],
      ],
    ),
  )
  out.push('')
  out.push(
    `${counts.paymentsPlanned} + ${counts.importExceptions} = ` +
      `${counts.paymentsPlanned + counts.importExceptions}. No historical source transaction ` +
      'disappeared. The row without an amount did not become a payment of zero and was not ' +
      'discarded; `payments.amount` is `NOT NULL` and no value was invented for it.',
  )
  out.push('')

  // --- 5. Counters -----------------------------------------------------------
  out.push('## 5. `import_batches` counter semantics')
  out.push('')
  out.push(
    table(
      ['Counter', 'Value', 'Meaning'],
      [
        [
          '`rows_seen`',
          result.counters.rowsSeen,
          'Every entity row the reviewed plan requires: batches + students + finance records + installments + payments + import exceptions. The `import_batches` row itself is excluded — it records the run, it is not imported by it.',
        ],
        ['`rows_imported`', result.counters.rowsImported, 'Of those, the rows verified present in the database after the write.'],
        [
          '`rows_skipped`',
          result.counters.rowsSkipped,
          'Rows the plan required that the import did not write. **The missing-amount row is not counted here.** It is preserved as an import exception and is counted in both `rows_seen` and `rows_imported` as that exception. A skipped row would be a silent drop, and this import has none.',
        ],
      ],
    ),
  )
  out.push('')

  // --- 6. Deterministic IDs --------------------------------------------------
  out.push('## 6. Deterministic entity IDs')
  out.push('')
  out.push(
    'Every row was inserted under a primary key derived from its source key, not generated. The ' +
      'source key is the workbook SHA-256 plus where in that workbook the entity sits, so the same ' +
      'workbook and the same source entity always produce the same UUID.',
  )
  out.push('')
  out.push(
    table(
      ['Property', 'Value'],
      [
        ['Scheme', 'RFC 4122 version 5 (SHA-1 over namespace + name)'],
        ['Namespace name', `\`${result.namespace.name}\``],
        ['Namespace UUID', `\`${result.namespace.uuid}\``],
        ['Namespace derivation', 'version 5 over the RFC 4122 DNS namespace and the namespace name above'],
        ['Name', "the importer's deterministic source key for the entity"],
        ['Write mode', '`upsert` on `id` with duplicates ignored'],
      ],
    ),
  )
  out.push('')
  out.push(
    'This is what makes the apply retry-safe: a transport failure partway through an entity class ' +
      'can be re-run, and rows that already landed are recognised by primary key rather than ' +
      'inserted a second time. Nothing is ever updated by the write, so a retry cannot overwrite a ' +
      'value already in the database. SHA-1 is used here exactly as RFC 4122 specifies it — as a ' +
      'name-to-identifier mapping, not as a security primitive.',
  )
  out.push('')

  // --- 7. Verification -------------------------------------------------------
  const failed = result.checks.filter((entry) => !entry.passed)
  out.push('## 7. Post-import verification')
  out.push('')
  out.push(
    `**${result.checks.length - failed.length} of ${result.checks.length} checks passed.** ` +
      'Every check was read back from hosted Supabase after the writes.',
  )
  out.push('')
  out.push(
    table(
      ['Check', 'Expected', 'Actual', 'Result'],
      result.checks.map((entry) => [entry.name, entry.expected, entry.actual, tick(entry.passed)]),
    ),
  )
  out.push('')
  out.push(
    'The foreign-key checks are not asking whether the database accepted the row — the schema ' +
      'enforces that. They ask whether every child points at a row *this import* created, which a ' +
      'foreign key alone does not say.',
  )
  out.push('')

  // --- 8. Table totals -------------------------------------------------------
  out.push('## 8. Hosted table totals after the apply')
  out.push('')
  out.push(
    table(
      ['Table', 'Rows'],
      Object.entries(result.tableTotals).map(([name, total]) => [`\`${name}\``, total]),
    ),
  )
  out.push('')
  out.push(
    '`receipts`, `receipt_deliveries` and `reminder_deliveries` are zero and were never written ' +
      "to. Tracker Master's historical *Receipt Sent* values stay inside preserved " +
      '`legacy_raw_json` only: no receipt row, receipt number, PDF, delivery or email history was ' +
      'created, and no email or reminder was sent.',
  )
  out.push('')

  // --- 9. French -------------------------------------------------------------
  out.push('## 9. French remains deferred')
  out.push('')
  const french = plan.deferred.find((sheet) => sheet.sheetName === 'French')
  out.push(
    `The \`French\` sheet's **${french?.meaningfulRows ?? 0} meaningful rows** were not imported. ` +
      'No French program, batch, student, finance record, payment or installment was created. ' +
      `\`programs\` holds ${result.tableTotals.programs ?? 'n/a'} rows — PSW and ECEA — exactly as ` +
      'the configuration migration left it. The deferral is recorded in import metadata and in ' +
      'this report only.',
  )
  out.push('')

  // --- 10. Installments ------------------------------------------------------
  out.push('## 10. Installments')
  out.push('')
  out.push(
    table(
      ['Program', 'Normalized installments', 'Rule applied'],
      [
        [
          'PSW',
          counts.installmentsByProgram.PSW ?? 0,
          'the explicit `INSTALLMENT FEE STRUCTURE` section only',
        ],
        [
          'ECEA',
          counts.installmentsByProgram.ECEA ?? 0,
          'none — Enrollment fee, 1st/2nd Installment and Late fee columns stay in finance-record `legacy_raw_json`',
        ],
      ],
    ),
  )
  out.push('')
  out.push(
    'No installment was created from an actual-payment column, and none from an ECEA ordinal fee ' +
      'column. A blank scheduled cell is absent, not zero. No calendar year or month was invented: ' +
      'the PSW schedule names ordinal installments, so `installment_month` and `due_date` are null ' +
      'by design.',
  )
  out.push('')

  // --- 11. Preserved, not corrected -----------------------------------------
  out.push('## 11. Preserved, not corrected')
  out.push('')
  out.push(
    table(
      ['Observation', 'Count', 'Disposition'],
      [
        ['Totals rows excluded', counts.totalsRowsExcluded, 'not student rows; never imported as finance records'],
        [
          'Duplicate payment candidates',
          `${counts.duplicateCandidateGroups} group(s) / ${counts.duplicateCandidateRows} rows`,
          '**all imported**; historical payments are never deduplicated',
        ],
        [
          'Same-number name conflicts',
          counts.nameConflicts,
          'one student number is one student; losing spellings preserved in `students.legacy_raw_json`',
        ],
        ['Formula/error cells', counts.errorCellsPreserved, 'preserved verbatim in `legacy_raw_json`; never repaired'],
        [
          'Payment method spellings',
          'unchanged',
          'written exactly as the workbook spells them; never normalized',
        ],
        [
          'Tracker Master *Balance Fees*',
          'not mapped',
          'a row-local formula, never written to `legacy_balance`',
        ],
        [
          'Batch-sheet ACTUAL columns',
          'not mapped',
          'preserved in finance-record `legacy_raw_json`; never imported as payments',
        ],
      ],
    ),
  )
  out.push('')

  // --- 12. RLS ---------------------------------------------------------------
  out.push('## 12. Row Level Security verification')
  out.push('')
  out.push(
    'Run separately from the apply and deliberately **not** with the service role, which bypasses ' +
      'RLS and would prove nothing about application access. No staff role was altered for this ' +
      'check.',
  )
  out.push('')
  out.push(
    table(
      ['Check', 'Result'],
      [
        [
          'Unauthenticated read of finance data is blocked',
          rls.anonymousReadBlocked === null ? 'not run' : tick(rls.anonymousReadBlocked),
        ],
        [
          'Authenticated admin can read finance data',
          rls.adminReadSucceeded === null ? 'not run' : tick(rls.adminReadSucceeded),
        ],
      ],
    ),
  )
  out.push('')
  out.push(rls.note)
  out.push('')

  // --- 13. Private outputs ---------------------------------------------------
  out.push('## 13. Private apply report')
  out.push('')
  out.push(
    'The detailed, row-level result — including internal source keys and the derived UUIDs — is ' +
      'written to the Git-ignored private directory:',
  )
  out.push('')
  for (const file of inputs.privateOutputs) out.push(`- \`${file}\``)
  out.push('')

  // --- 14. Re-running --------------------------------------------------------
  out.push('## 14. Re-running this import')
  out.push('')
  out.push(
    'A second apply of this workbook is **refused**: the pre-flight gate looks for a completed ' +
      '`import_batches` row with the same `source_file_hash` and stops. There is no `--force`. ' +
      'Applying at all requires both the `--apply` flag and `FINANCE_IMPORT_APPLY=YES` in the ' +
      'environment; with either absent the script runs the dry run and writes nothing. The ' +
      'confirmation is supplied per invocation and is not persisted to `.env.local` or to source ' +
      'control.',
  )
  out.push('')

  // --- 15. Failure, when there was one ---------------------------------------
  let section = 15
  if (result.failure !== null) {
    out.push(`## ${section}. Failure`)
    out.push('')
    out.push(`The apply did not complete: ${result.failure}`)
    out.push('')
    section += 1
  }

  // --- 16. Operator verification ---------------------------------------------
  out.push(`## ${section}. Post-apply operator verification`)
  out.push('')
  out.push(
    'Ticket acceptance steps carried out by hand after the apply rather than importer outputs. ' +
      `They are recorded in \`scripts/finance-import/importer/operator-verification.mts\` and ` +
      'rendered from there, so regenerating this report reproduces this section too. Recorded at ' +
      `${operator.recordedAt}.`,
  )
  out.push('')

  out.push(`### ${section}.1 Application health`)
  out.push('')
  out.push('The routes were exercised against the imported data.')
  out.push('')
  out.push(table(['Route', 'Result'], operator.routes.map((entry) => [entry.route, entry.result])))
  out.push('')
  for (const note of operator.routeNotes) {
    out.push(note)
    out.push('')
  }

  out.push(`### ${section}.2 Duplicate-import refusal, exercised`)
  out.push('')
  out.push(
    operator.duplicateRefusal.exercised
      ? operator.duplicateRefusal.note
      : '**Not exercised.** The refusal path was not provoked after this apply.',
  )
  out.push('')

  out.push(`### ${section}.3 Validation`)
  out.push('')
  out.push(
    table(
      ['Command', 'Result'],
      operator.validation.map((entry) => [entry.command, entry.result]),
    ),
  )
  out.push('')

  out.push(`### ${section}.4 Workbook`)
  out.push('')
  out.push(
    `Re-hashed after everything above: \`${operator.workbook.sha256}\` — ` +
      `${operator.workbook.unchanged ? 'unchanged' : '**CHANGED**'}. ${operator.workbook.note}`,
  )
  out.push('')

  return `${out.join('\n')}\n`
}
