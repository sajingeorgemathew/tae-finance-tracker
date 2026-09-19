/**
 * Renders the committable dry-run report.
 *
 * Like the Phase A report, this file writes a document that goes into Git from
 * data describing real students' finances, and it enforces the same narrow
 * rule: **aggregates and structure only**. No student number, no name, no payer,
 * no remark and no amount attributable to a person is ever written here. Row
 * numbers are aggregated into counts rather than listed, because a row number
 * plus the workbook identifies a person.
 *
 * Sheet names, table titles, column headings and cell references for cells that
 * carry no student are structural facts about the file's layout and are printed,
 * exactly as the Phase A report prints them.
 */

import type { DryRunPlan } from './plan.mts'
import type { CountResult, PriorImportCheck } from './supabase-readonly.mts'

function table(headers: string[], rows: (string | number)[][]): string {
  const head = `| ${headers.join(' | ')} |`
  const rule = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n')
  return [head, rule, body].join('\n')
}

function code(value: string | null): string {
  return value === null ? '_(none)_' : `\`${value}\``
}

/** Counts by category, for reporting rows without identifying any of them. */
function tallyBy<T>(items: readonly T[], key: (item: T) => string): [string, number][] {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

export interface ReportInputs {
  plan: DryRunPlan
  countsBefore: CountResult
  countsAfter: CountResult
  priorImport: PriorImportCheck
  workbookUnchanged: boolean
  /** Private output files written by this run, as repo-relative paths. */
  privateOutputs: string[]
}

export function renderDryRunReport(inputs: ReportInputs): string {
  const { plan, countsBefore, countsAfter, priorImport, workbookUnchanged } = inputs
  const { counts, readiness } = plan
  const out: string[] = []

  out.push('# FINANCE-IMPORT-02 — import dry run (Phase B1)')
  out.push('')
  out.push(
    'Dry run only. **No database data of any kind was written** — see ' +
      '[No database writes](#14-no-database-writes) at the end of this document.',
  )
  out.push('')
  out.push(
    'This report states what an apply *would* create from the historical finance workbook, ' +
      'using the mapping decisions approved after the Phase A analysis in ' +
      '[FINANCE-IMPORT-02-ANALYSIS.md](FINANCE-IMPORT-02-ANALYSIS.md). It plans; it does not import.',
  )
  out.push('')

  // --- Privacy ---------------------------------------------------------------
  out.push('## Privacy')
  out.push('')
  out.push(
    'This document contains aggregate counts, sheet names, table titles and column headings only. ' +
      'It contains no student names, no student numbers, no payer names, no remarks and no amount ' +
      'attributable to a person. Source row numbers are reported as counts rather than listed, because ' +
      'a row number together with the workbook identifies a person. Row-level detail is written to ' +
      '`.private/finance-import-analysis/`, which is Git-ignored and must stay that way.',
  )
  out.push('')

  // --- 1. Source -------------------------------------------------------------
  out.push('## 1. Source workbook')
  out.push('')
  out.push(
    table(
      ['Property', 'Value'],
      [
        ['File', `\`${plan.fingerprint.relativePath}\``],
        ['Size', `${plan.fingerprint.sizeBytes.toLocaleString('en-CA')} bytes`],
        ['SHA-256', `\`${plan.fingerprint.sha256}\``],
        ['Date system', plan.date1904 ? '1904' : '1900 (with the Lotus leap-year bug)'],
        ['Sheets', plan.sheetNames.length],
        ['Unchanged after the dry run', workbookUnchanged ? 'yes' : '**NO**'],
      ],
    ),
  )
  out.push('')
  out.push(
    'Sheet names below are reproduced from `workbook.SheetNames`, so they are the workbook’s own ' +
      'spelling and not a transcription:',
  )
  out.push('')
  out.push(plan.sheetNames.map((name) => `\`${name}\``).join(' · '))
  out.push('')

  // --- 2. Programs -----------------------------------------------------------
  out.push('## 2. Canonical programs')
  out.push('')
  out.push(
    table(
      ['`programs.short_code`', 'Workbook label(s)', 'Alias'],
      plan.programs.map((program) => [
        `\`${program.shortCode}\``,
        program.sourceLabels.map((label) => `\`${label}\``).join(', '),
        program.aliased ? 'yes' : 'no',
      ]),
    ),
  )
  out.push('')
  out.push(
    'The `ELCE` → `ECEA` mapping is an alias for the database relationship only. The workbook’s ' +
      '`ELCE` text is never rewritten: it is preserved in every `legacy_raw_json` payload and in the ' +
      'batch name derived from the sheet. No program row is created by an import; programs are matched ' +
      'on `short_code` against the configuration migration.',
  )
  out.push('')
  if (plan.deferred.length > 0) {
    out.push(
      table(
        ['Deferred sheet', 'Reason', 'Meaningful rows', 'Rows with a student number'],
        plan.deferred.map((sheet) => [
          `\`${sheet.sheetName}\``,
          `\`${sheet.reason}\``,
          sheet.meaningfulRows,
          sheet.rowsWithStudentNumber,
        ]),
      ),
    )
    out.push('')
    out.push(
      'No French program is created, and no French student, finance record, installment or payment is ' +
        'planned. `programs` decides how receipt numbers are assembled, so a guessed short code would ' +
        'become a permanent wrong value on real receipts.',
    )
    out.push('')
  }

  // --- 3. Planned inserts ----------------------------------------------------
  out.push('## 3. Planned inserts')
  out.push('')
  out.push(
    table(
      ['Entity', 'Planned', 'PSW', 'ECEA'],
      [
        [
          'Batches',
          counts.batches,
          counts.batchesByProgram.PSW ?? 0,
          counts.batchesByProgram.ECEA ?? 0,
        ],
        ['Students', counts.students, '—', '—'],
        ['Students (unresolved, no student number)', counts.unresolvedStudents, '—', '—'],
        ['— from a batch table', counts.unresolvedBatchStudents, '—', '—'],
        ['— from Tracker Master', counts.unresolvedTrackerStudents, '—', '—'],
        [
          'Student finance records',
          counts.financeRecords,
          counts.financeRecordsByProgram.PSW ?? 0,
          counts.financeRecordsByProgram.ECEA ?? 0,
        ],
        ['— batch-specific', counts.financeRecordsBatchSpecific, '—', '—'],
        ['— unassigned (`batch_id` null)', counts.financeRecordsUnassigned, '—', '—'],
        [
          'Installments',
          counts.installments,
          counts.installmentsByProgram.PSW ?? 0,
          counts.installmentsByProgram.ECEA ?? 0,
        ],
        ['Payments', counts.paymentsPlanned, '—', '—'],
        ['Import exceptions', counts.importExceptions, '—', '—'],
        ['Receipts', 0, 0, 0],
        ['Receipt deliveries', 0, 0, 0],
        ['Programs', 0, 0, 0],
      ],
    ),
  )
  out.push('')
  out.push(
    `Students are counted per exact student number: ${counts.students} distinct numbers across the ` +
      'supported PSW, ECEA and Tracker Master sources, plus ' +
      `${counts.unresolvedStudents} unresolved student(s) created one per source row for rows that ` +
      'name a student without numbering them. No student number is manufactured and no two rows are ' +
      'merged on the strength of similar names — two number-less rows spelling the same name stay two ' +
      'students.',
  )
  out.push('')
  out.push(
    `${counts.unresolvedBatchStudents} of those come from a batch table. Because their table is known, ` +
      'each also gets a **batch-specific** finance record carrying that row’s fee, paid and balance ' +
      'snapshot, so a row that happens to lack a number does not lose its finances. The remaining ' +
      `${counts.unresolvedTrackerStudents} come from Tracker Master and get an unassigned record ` +
      '(`batch_id` null), because a transaction row does not say which batch table the student sits in.'
  )
  out.push('')
  out.push(
    'Zero receipts, receipt numbers, PDFs and deliveries are planned. The workbook’s `Receipt Sent` ' +
      'value is preserved inside each payment’s `legacy_raw_json` as historical metadata only.',
  )
  out.push('')

  // --- 4. Batches ------------------------------------------------------------
  out.push('## 4. Batch candidates')
  out.push('')
  out.push(
    `${counts.batches} batch candidates, one per detected table rather than one per sheet. ` +
      'A dated PSW sheet holds a Morning and an Evening table; one batch per sheet would merge two cohorts.',
  )
  out.push('')
  out.push(
    table(
      ['Sheet', 'Source title (verbatim)', 'Session', 'Proposed `batches.name`', '`start_date`'],
      plan.batches.map((batch) => [
        `\`${batch.legacySheetName}\``,
        code(batch.sourceTitle),
        batch.session ?? '—',
        `\`${batch.name}\``,
        batch.startDate === null ? '**null**' : `\`${batch.startDate}\``,
      ]),
    ),
  )
  out.push('')

  const undated = plan.batches.filter((batch) => batch.startDate === null)
  if (undated.length > 0) {
    out.push(
      `${undated.length} batch(es) get a null \`start_date\`. A date is produced only when the title ` +
        'states a day, a month and a four-digit year; no day is assumed, no two-digit year is expanded, ' +
        'and the year is never taken from the worksheet name. The sheet named `Aug 2026` carries tables ' +
        'titled "29th JULY, 2026", which is exactly why.',
    )
    out.push('')
    out.push(
      table(
        ['Sheet', 'Source title', 'Why null'],
        undated.map((batch) => [
          `\`${batch.legacySheetName}\``,
          code(batch.sourceTitle),
          batch.startDateReason,
        ]),
      ),
    )
    out.push('')
  }

  out.push(
    'Every source title above is preserved verbatim in the batch plan and in `legacy_raw_json`. ' +
      '`batches.legacy_sheet_name` holds the exact worksheet name; `batches.code` holds the ' +
      'deterministic source-table key. `Morning`/`Evening` is appended only where the table title ' +
      'names it — never inferred from a table’s position on the sheet.',
  )
  out.push('')

  if (plan.batchNameCollisions.length > 0) {
    out.push(
      `**${plan.batchNameCollisions.length} batch name collision(s)** would violate ` +
        '`batches_program_name_key`. Listed in the private batch plan.',
    )
    out.push('')
  }

  // --- 5. Payment routing ----------------------------------------------------
  out.push('## 5. Payment routing')
  out.push('')
  out.push(
    `Tracker Master is the historical transaction source: ${counts.payments} rows, one planned payment ` +
      'each. No payment is created from a batch sheet’s ACTUAL section — those cells are very likely ' +
      'another representation of the same money, and importing both would double it. They are preserved ' +
      'inside each finance record’s `legacy_raw_json` instead.',
  )
  out.push('')
  out.push(
    table(
      ['Routing outcome', 'Payments', 'Goes to'],
      [
        [
          'Unique batch',
          counts.paymentRouting.uniqueBatch,
          'the batch-specific finance record for that student',
        ],
        [
          'Ambiguous batch',
          counts.paymentRouting.ambiguousBatch,
          'an unassigned record (`batch_id` null); not guessed',
        ],
        [
          'No batch found',
          counts.paymentRouting.batchNotFound,
          'an unassigned record (`batch_id` null)',
        ],
        [
          'Missing student number',
          counts.paymentRouting.missingStudentId,
          'an unresolved student and its own unassigned record',
        ],
        ['**Total**', counts.payments, ''],
      ],
    ),
  )
  out.push('')
  out.push(
    'Tracker Master’s `Batch` column holds a date serial, not a batch name, and a date cannot ' +
      'distinguish the Morning cohort from the Evening one. It is never used to route a payment; it is ' +
      'preserved verbatim in `legacy_raw_json`.',
  )
  out.push('')
  if (counts.programInferredPayments > 0) {
    out.push(
      `${counts.programInferredPayments} payment(s) have a blank \`Program\` cell and take their ` +
        'program from the single canonical program of the student’s own batch tables. Each such ' +
        'inference is recorded on the payment in `legacy_raw_json.program_resolution`. Where the ' +
        'student’s batch tables do not agree on exactly one program, the row is reported as ' +
        '`unresolved_program` and plans no insert.',
    )
    out.push('')
  }

  // --- 6. What is preserved, not corrected -----------------------------------
  out.push('## 6. Preserved, not corrected')
  out.push('')
  out.push(
    table(
      ['Finding', 'Count', 'Handling'],
      [
        [
          'Totals rows excluded',
          counts.totalsRowsExcluded,
          'rows with money and no student; never a student, finance record, installment or payment',
        ],
        [
          'Other non-student rows excluded',
          counts.otherRowsExcluded,
          'rows in a data span carrying neither a student nor money',
        ],
        [
          'Duplicate candidates preserved',
          `${counts.duplicateCandidateGroups} group(s) / ${counts.duplicateCandidateRows} rows`,
          'every row imported; nothing deduplicated',
        ],
        [
          'Same-ID name conflicts preserved',
          counts.nameConflicts,
          'one student per exact student number; every spelling kept in `legacy_raw_json`',
        ],
        [
          '— of those, disagreeing within one sheet',
          counts.nameConflictsWithinOneSheet,
          'the serious kind: one number written two ways into the same column',
        ],
        [
          'Formula/error cells preserved',
          counts.errorCellsPreserved,
          'not repaired, not coerced to zero, barred from becoming a student number',
        ],
      ],
    ),
  )
  out.push('')

  if (plan.errorCells.length > 0) {
    out.push(
      table(
        ['Sheet', 'Cell', 'Error', 'Disposition'],
        plan.errorCells.map((cell) => [
          `\`${cell.sheetName}\``,
          `\`${cell.ref}\``,
          `\`${cell.error}\``,
          cell.disposition,
        ]),
      ),
    )
    out.push('')
  }

  out.push(
    `${counts.nameConflicts} student number(s) carry more than one distinct name, of which ` +
      `${counts.nameConflictsWithinOneSheet} disagree within a single sheet. The rest differ only ` +
      '*between* sheets, which is mostly structural: Tracker Master holds one name column and the batch ' +
      'sheets hold two or three, so the two rarely reduce to the same string even for one person. ' +
      'Neither kind splits a student: one exact student number is one student, the canonical display ' +
      'name follows the approved priority (Tracker Master first, then the batch sheet), and every other ' +
      'spelling is preserved in `students.legacy_raw_json`. Nothing is fuzzy-matched or merged.',
  )
  out.push('')
  out.push(
    'Tracker Master’s `Balance Fees` is a row-local formula, not a student outstanding balance. ' +
      'It is **not** mapped to `student_finance_records.legacy_balance`. Its raw value, displayed text ' +
      'and formula source are preserved in each payment’s `legacy_raw_json` and never recalculated.',
  )
  out.push('')
  out.push(
    'Payment methods are stored exactly as the workbook spells them. `Etransfer`, `E-Transfer` and ' +
      '`ETRANSFER` remain three distinct historical values; none is normalised to a code list.',
  )
  out.push('')
  out.push(
    'A blank cell is never converted to zero. Blank instalment cells create no installment, blank fee ' +
      'cells leave the legacy field null, and a blank `Enrollment Total Fees` means "not restated here" ' +
      'rather than a fee of zero.',
  )
  out.push('')

  // --- 7. Installments -------------------------------------------------------
  out.push('## 7. Scheduled installments')
  out.push('')
  out.push(
    `${counts.installments} installments planned, from the scheduled side of each table only. ` +
      'On a PSW batch sheet that is the `INSTALLMENT FEE STRUCTURE` section; the identically-named ' +
      'columns in the `ACTUAL` section record money received and create nothing here.',
  )
  out.push('')
  out.push(
    table(
      ['`installment_type`', 'Planned', 'Default note'],
      tallyBy(plan.installments, (installment) => installment.installmentType).map(
        ([type, count]) => [
          `\`${type}\``,
          count,
          type === 'enrollment'
            ? '`Enrolment fee`'
            : type === 'monthly'
              ? '`{Month} installment`'
              : 'taken from the source heading, e.g. `1st installment`',
        ],
      ),
    ),
  )
  out.push('')
  out.push(
    '`installment_month` is **null on every planned installment**. The month columns name a month and ' +
      'never a year, and a schedule running from October into February spans two of them. There is no ' +
      'safe year to write, so the month label is preserved in `legacy_column_name` and in the default ' +
      'note instead. Deriving the year from the batch start date would look like fact once stored.',
  )
  out.push('')
  out.push(
    'The ECEA/`ELCE` roster uses an ordinal plan — `1st Installment`, `2nd Installment` — not calendar ' +
      'months, and is not forced into one: those columns take `installment_type = other` and a note taken ' +
      'from the source heading. The scheduled section’s own `Total Fee` column is excluded: it is the ' +
      'total of the plan, not an instalment in it, and creating one would double the plan.',
  )
  out.push('')

  // --- 8. Source keys and idempotency ---------------------------------------
  out.push('## 8. Source keys and idempotency')
  out.push('')
  out.push(
    'Every planned entity carries a deterministic source key built from the workbook SHA-256 and where ' +
      'in the workbook it came from. Two runs over the same file produce identical keys.',
  )
  out.push('')
  out.push(
    table(
      ['Entity', 'Key parts'],
      [
        ['Batch', 'hash + `batch` + sheet + detected table key'],
        ['Student', 'hash + `student` + exact student number'],
        ['Unresolved student', 'hash + `unresolved-student` + sheet + source row'],
        ['Finance record (batch)', 'hash + `finance-record` + sheet + source row + table key'],
        ['Finance record (unassigned)', 'hash + `finance-record-unassigned` + student key + program'],
        ['Payment', 'hash + `payment` + `Tracker Master` + source row'],
        ['Installment', 'hash + `installment` + sheet + row + column + schedule section'],
      ],
    ),
  )
  out.push('')
  out.push(
    'The workbook hash is the first part of every key, so a different file is a different key space: ' +
      '`legacy_source_row` only means something relative to one exact file. Before any apply, the ' +
      'importer checks `import_batches` for a completed import carrying the same SHA-256 and **refuses** ' +
      'a duplicate. There is no `--force` behaviour.',
  )
  out.push('')
  out.push(
    table(
      ['Idempotency check', 'Result'],
      [
        ['Checked against `import_batches`', priorImport.checked ? 'yes' : 'no'],
        ['Completed import of this hash exists', priorImport.alreadyImported ? '**yes**' : 'no'],
        ['Note', priorImport.note],
      ],
    ),
  )
  out.push('')

  // --- 9. Import exceptions --------------------------------------------------
  out.push('## 9. Import exceptions')
  out.push('')
  out.push(
    'A source row that cannot safely become a normalized record has three possible fates, and two of ' +
      'them are unacceptable: inventing a value so it fits, or dropping it. An exception is the third — ' +
      'the row is preserved in `import_exceptions` exactly as the workbook holds it, with the reason it ' +
      'could not be normalized.',
  )
  out.push('')
  out.push(
    table(
      ['Reason', 'Rows', 'Entity it would have been'],
      Object.entries(counts.importExceptionsByReason)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([reason, count]) => {
          const kinds = [
            ...new Set(
              plan.importExceptions
                .filter((exception) => exception.reason === reason)
                .map((exception) => exception.entityType),
            ),
          ]
          return [`\`${reason}\``, count, kinds.map((kind) => `\`${kind}\``).join(', ')]
        }),
    ),
  )
  out.push('')
  out.push(
    `${counts.missingAmountExceptions} transaction row(s) state no amount. \`payments.amount\` is ` +
      'NOT NULL and no zero may be invented, so the row is preserved as an exception rather than ' +
      'becoming a payment: the money is not asserted and the history is not lost. Where such a row also ' +
      'establishes a student and a program, the student and the finance record are still planned — only ' +
      'the payment becomes an exception.',
  )
  out.push('')

  // --- 10. Unresolved --------------------------------------------------------
  out.push('## 10. Unresolved rows')
  out.push('')
  out.push(
    'Every source row either has a deterministic planned import path or appears here with where it went ' +
      'instead. Nothing is dropped silently. Row numbers are aggregated into counts; the individual rows ' +
      'are listed in `.private/finance-import-analysis/unresolved-records.json`.',
  )
  out.push('')

  if (plan.unresolved.length === 0) {
    out.push('_No unresolved rows._')
    out.push('')
  } else {
    out.push(
      table(
        ['Category', 'Rows', 'Sheets', 'Destination', 'Blocks a safe apply'],
        tallyBy(plan.unresolved, (row) => row.category).map(([category, count]) => {
          const rows = plan.unresolved.filter((row) => row.category === category)
          const sheets = [...new Set(rows.map((row) => row.sheetName))]
          const preserved = rows.filter((row) => row.preservedAs !== null).length
          return [
            `\`${category}\``,
            count,
            sheets.map((sheet) => `\`${sheet}\``).join(', '),
            preserved === count ? '`import_exceptions`' : '**none**',
            rows.some((row) => row.blocking) ? '**yes**' : 'no',
          ]
        }),
      ),
    )
    out.push('')
  }

  // --- 10. Readiness ---------------------------------------------------------
  out.push('## 11. Apply readiness')
  out.push('')
  out.push(`\`READY_FOR_APPLY=${readiness.ready ? 'true' : 'false'}\``)
  out.push('')
  out.push(
    table(
      ['Internal consistency check', 'Result'],
      [
        [
          'Every planned payment has an amount and a planned finance record',
          plan.invariantViolations.length === 0 ? 'pass' : '**FAIL**',
        ],
        [
          'Every installment and finance record resolves to a planned parent',
          plan.invariantViolations.length === 0 ? 'pass' : '**FAIL**',
        ],
        [
          'Source keys are unique across every planned entity',
          plan.invariantViolations.length === 0 ? 'pass' : '**FAIL**',
        ],
      ],
    ),
  )
  out.push('')

  if (readiness.blockers.length > 0) {
    out.push('Blocking:')
    out.push('')
    for (const blocker of readiness.blockers) out.push(`- ${blocker}`)
    out.push('')
  }
  if (readiness.notes.length > 0) {
    out.push('Reported, not blocking PSW/ECEA:')
    out.push('')
    for (const note of readiness.notes) out.push(`- ${note}`)
    out.push('')
  }
  out.push(
    'Deferral by an approved rule — French — is reported separately and does not make a PSW/ECEA apply ' +
      'unsafe. Any PSW/ECEA payment row without a deterministic path does, which is the whole point of ' +
      'the rule.',
  )
  out.push('')

  // --- 11. Database state ----------------------------------------------------
  out.push('## 12. Database row counts')
  out.push('')
  out.push(`Access: ${countsBefore.availability.reason}.`)
  out.push('')
  out.push(
    table(
      ['Table', 'Before the dry run', 'After the dry run', 'Changed'],
      Object.keys(countsBefore.counts).map((name) => {
        const before = countsBefore.counts[name]
        const after = countsAfter.counts[name]
        return [
          `\`${name}\``,
          before === null ? '_not read_' : before,
          after === null ? '_not read_' : after,
          before !== null && after !== null && before !== after ? '**YES**' : 'no',
        ]
      }),
    ),
  )
  out.push('')

  // --- 12. Prerequisites -----------------------------------------------------
  out.push('## 13. Prerequisites before an apply')
  out.push('')
  out.push('Two migrations are prepared and **neither is applied by this phase**.')
  out.push('')
  out.push(
    table(
      ['Migration', 'What it does'],
      [
        [
          '`20260918120000_legacy_raw_json.sql`',
          'adds a nullable `legacy_raw_json` column to `students`, `student_finance_records` and ' +
            '`installments`; only `payments` has one today',
        ],
        [
          '`20260918130000_import_exceptions.sql`',
          'creates `import_exceptions` with RLS, so a row that cannot be normalized is preserved ' +
            'rather than invented or dropped',
        ],
      ],
    ),
  )
  out.push('')
  out.push(
    'Both are additive: no existing table, column, constraint or row is altered, and neither writes a ' +
      'row of any kind. An apply must run both first.',
  )
  out.push('')

  // --- 13. No database writes ------------------------------------------------
  out.push('## 14. No database writes')
  out.push('')
  out.push('**NO DATABASE DATA OF ANY KIND WAS WRITTEN IN THIS PHASE.**')
  out.push('')
  out.push(
    'No `import_batches` row was created. No students, batches, finance records, installments, payments ' +
      'or receipts were created or modified. No receipt number was generated, no PDF was produced and no ' +
      'email was sent. The only Supabase access is counting rows and one lookup against `import_batches`; ' +
      'the module that performs it exposes no insert, update, upsert or delete. The workbook was opened ' +
      'read-only from a buffer and its SHA-256 re-checked afterwards.',
  )
  out.push('')
  out.push(
    'Dry run is the default and only behaviour. `--apply` is recognised solely so it can be refused ' +
      'with an explanation; no apply path exists in this phase.',
  )
  out.push('')
  out.push('---')
  out.push('')
  out.push(
    '_Generated by `npm run finance:import:dry-run` (`scripts/finance-import/import-workbook.mts`). ' +
      'Regenerate rather than edit by hand: every count here is read from the workbook._',
  )
  out.push('')

  return out.join('\n')
}
