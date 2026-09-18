/**
 * Renders the committable analysis report.
 *
 * This file writes a document that goes into Git, from data that describes
 * real students' finances. The rule it enforces is narrow and absolute: only
 * structure, aggregates and values from an explicit allowlist are ever
 * written. Names, payers, remarks, individual student numbers and individual
 * amounts stay in the Git-ignored private JSON.
 *
 * The allowlist is a whitelist rather than a blacklist on purpose. A new
 * column added to the workbook is silently excluded from the report until
 * somebody decides it is safe to print, which is the right default when the
 * cost of being wrong is publishing a student's finances.
 */

import type { ColumnProfile } from './lib/profile.mts'
import type { ImportPlan } from './import-plan.mts'
import type { WorkbookAnalysis } from './analyze-workbook.mts'

/**
 * Headings whose *values* may appear in the committed report.
 *
 * Every one of these is a closed vocabulary describing a transaction, not a
 * person: a payment method, a program code, a yes/no flag. Anything not listed
 * here is reported as a count only.
 */
const PRINTABLE_VALUE_HEADERS = new Set([
  'program',
  'mode of payment',
  'receipt sent',
  'graduated',
  'wkd/wknd',
])

function mayPrintValues(profile: ColumnProfile): boolean {
  return profile.header !== null && PRINTABLE_VALUE_HEADERS.has(profile.header.trim().toLowerCase())
}

function table(headers: string[], rows: (string | number)[][]): string {
  const head = `| ${headers.join(' | ')} |`
  const rule = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n')
  return [head, rule, body].join('\n')
}

function tally(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (entries.length === 0) return '_none_'
  return entries.map(([value, count]) => `\`${value}\` ×${count}`).join(', ')
}

function code(value: string | null): string {
  return value === null ? '_(none)_' : `\`${value}\``
}

export function renderReport(analysis: WorkbookAnalysis, plan: ImportPlan): string {
  const master = analysis.trackerMaster
  const out: string[] = []

  out.push('# FINANCE-IMPORT-02 — workbook analysis (Phase A)')
  out.push('')
  out.push(
    'Analysis only. **No database data of any kind was written in this phase** — see ' +
      '[No database writes](#19-no-database-writes) at the end of this document.',
  )
  out.push('')
  out.push(
    'This report describes the structure of the historical finance workbook and proposes how it ' +
      'would map onto the schema created by FINANCE-DATA-01. It records inconsistencies in the ' +
      'workbook; it does not correct any of them.',
  )
  out.push('')
  out.push('## Privacy')
  out.push('')
  out.push(
    'The workbook holds real student financial records. This document contains sheet names, column ' +
      'headings, aggregate counts, structural patterns and mapping decisions only. It contains no ' +
      'student names, no individual student numbers, no payer names and no amounts attributable to a ' +
      'person. Row-level detail is written to `.private/finance-import-analysis/`, which is ' +
      'Git-ignored and must stay that way.',
  )
  out.push('')

  // --- 1. Fingerprint --------------------------------------------------------
  out.push('## 1. Workbook fingerprint')
  out.push('')
  out.push(
    table(
      ['Property', 'Value'],
      [
        ['File', `\`${analysis.fingerprint.relativePath}\``],
        ['Size', `${analysis.fingerprint.sizeBytes.toLocaleString('en-CA')} bytes`],
        ['SHA-256', `\`${analysis.fingerprint.sha256}\``],
        ['Last modified', analysis.fingerprint.modifiedAt],
        ['Analyzed at', analysis.fingerprint.analyzedAt],
        ['Date system', analysis.date1904 ? '1904' : '1900 (with the Lotus leap-year bug)'],
        ['Sheets', String(analysis.sheetCount)],
      ],
    ),
  )
  out.push('')
  out.push(
    'The doubled extension in the filename is deliberate and preserved. The workbook is discovered ' +
      'by extension rather than by name, so nothing depends on that spelling. The hash is taken over ' +
      'the exact bytes read, and re-checked after the analysis to prove the file was not modified.',
  )
  out.push('')

  // --- 2 & 3. Inventory and classification -----------------------------------
  out.push('## 2. Sheet inventory')
  out.push('')
  out.push(
    table(
      ['#', 'Sheet', 'Used range', 'Declared rows', 'Last populated row', 'Tables', 'Merged', 'Formulas', 'Errors', 'Hidden'],
      analysis.inventory.map((entry) => [
        entry.index + 1,
        `\`${entry.name}\``,
        entry.usedRange ?? '_empty_',
        entry.declaredRowCount,
        entry.lastPopulatedRow ?? '—',
        entry.blockCount,
        entry.mergedRanges.length,
        entry.formulaCount,
        entry.errorCount,
        entry.hidden ? 'yes' : 'no',
      ]),
    ),
  )
  out.push('')

  const overDeclared = analysis.inventory.filter(
    (entry) => entry.lastPopulatedRow !== null && entry.declaredRowCount - entry.lastPopulatedRow > 20,
  )
  if (overDeclared.length > 0) {
    out.push(
      `**Declared range is not the data range.** ${overDeclared
        .map((entry) => `\`${entry.name}\` declares ${entry.declaredRowCount} rows but stops carrying data at row ${entry.lastPopulatedRow}`)
        .join('; ')}. An importer must find the last meaningful row rather than trusting \`!ref\`.`,
    )
    out.push('')
  }

  out.push('### Header and data rows per sheet')
  out.push('')
  out.push(
    table(
      ['Sheet', 'Header row(s)', 'First data row', 'Last meaningful row', 'Empty-row runs inside the range'],
      analysis.inventory.map((entry) => [
        `\`${entry.name}\``,
        entry.probableHeaderRows.join(', ') || '—',
        entry.probableFirstDataRow ?? '—',
        entry.probableLastMeaningfulRow ?? '—',
        entry.emptyRowRuns.slice(0, 6).join(', ') + (entry.emptyRowRuns.length > 6 ? ', …' : '') || '—',
      ]),
    ),
  )
  out.push('')

  out.push('## 3. Sheet classification')
  out.push('')
  out.push(
    table(
      ['Sheet', 'Classification', 'Evidence'],
      analysis.inventory.map((entry) => [
        `\`${entry.name}\``,
        `\`${entry.classification}\``,
        entry.classificationEvidence.join('; ') || '—',
      ]),
    ),
  )
  out.push('')
  out.push(
    '> **A sheet is not a batch.** Every dated PSW sheet carries two batch tables — a Morning batch ' +
      'and an Evening batch — stacked vertically, each with its own title, header row and data span. ' +
      'This is the single most consequential structural finding in the workbook: an importer that ' +
      'treats one sheet as one batch would merge two cohorts.',
  )
  out.push('')

  // --- 4. Tracker Master -----------------------------------------------------
  out.push('## 4. Tracker Master')
  out.push('')
  if (!master) {
    out.push('_No transaction master sheet was identified._')
    out.push('')
  } else {
    out.push('### Columns, exactly as spelled in the workbook')
    out.push('')
    out.push(
      table(
        ['Col', 'Heading (verbatim)', 'Recognised as', 'Filled', 'Blank', 'Formulas', 'Distinct'],
        master.columnProfiles.map((profile) => [
          profile.letter,
          `\`${profile.header ?? ''}\``,
          `\`${profile.role}\``,
          profile.nonBlankCount,
          profile.blankCount,
          profile.formulaCount,
          profile.distinctCount,
        ]),
      ),
    )
    out.push('')
    out.push(
      'Several headings carry a trailing space — `"Student ID "` among them. They are reported and ' +
        'stored exactly as spelled; normalisation happens only for matching, never in the stored value.',
    )
    out.push('')

    out.push('### Row counts')
    out.push('')
    out.push(
      table(
        ['Measure', 'Count'],
        [
          ['Rows in the data span', master.totalRowsInSpan],
          ['Entirely empty rows in the span', master.emptyRowCount],
          ['**Transaction rows**', `**${master.transactionRowCount}**`],
          ['Distinct student numbers', master.distinctStudentIdCount],
          ['Rows with no student number', master.rowsMissingStudentId],
          ['Rows with no student name', master.rowsMissingStudentName],
          ['Rows with no paid date', master.rowsMissingPaidDate],
          ['Rows with no amount', master.rowsMissingAmount],
          ['Rows with a zero amount', master.rowsWithZeroAmount],
          ['Rows with a negative amount', master.rowsWithNegativeAmount],
        ],
      ),
    )
    out.push('')

    out.push('### Stored value domains')
    out.push('')
    out.push(`- **Program** — ${tally(master.programValues)}`)
    out.push(`- **Mode of Payment** — ${tally(master.paymentMethodValues)}`)
    out.push(`- **Receipt Sent** — ${tally(master.receiptSentValues)}`)
    out.push('')
    out.push(
      'These are printed exactly as stored, including case and spacing variants. They are not ' +
        'normalised here and must not be normalised on import.',
    )
    out.push('')

    out.push('### Payment No')
    out.push('')
    out.push(
      `Distinct values: ${Object.keys(master.paymentNumberDistribution).length}. ` +
        (master.paymentNumberRestartsPerStudent
          ? 'The sequence restarts at 1 for most students, so it numbers a student’s payments rather than the workbook’s rows.'
          : 'The sequence does not restart per student for most students; it may be a global counter.'),
    )
    out.push('')

    out.push('### Enrollment Total Fees')
    out.push('')
    out.push(
      table(
        ['Measure', 'Count'],
        [
          ['Rows stating a value', master.enrollmentTotalFee.filledRows],
          ['Rows leaving it blank', master.enrollmentTotalFee.blankRows],
          ['Students with a value anywhere', master.enrollmentTotalFee.studentsWithAnyValue],
          ['Students stating it on their first row only', master.enrollmentTotalFee.studentsWithValueOnFirstRowOnly],
          ['Students stating it on a later row too', master.enrollmentTotalFee.studentsWithValueOnLaterRows],
          ['Students whose stated values disagree', master.enrollmentTotalFee.studentsWithDisagreeingValues],
        ],
      ),
    )
    out.push('')
    out.push(
      `**Finding:** ${master.enrollmentTotalFee.verdict}. This is a per-student figure recorded once, ` +
        'not a property of each payment, and it belongs on the finance record rather than the payment. ' +
        'A blank on a later row means "not restated here" — it does not mean the fee is zero, and it is ' +
        'not filled in from the student’s other rows.',
    )
    out.push('')

    out.push('### Balance Fees')
    out.push('')
    out.push(
      table(
        ['Measure', 'Count'],
        [
          ['Rows holding a formula', master.balanceFees.formulaRows],
          ['Rows holding a typed value', master.balanceFees.literalRows],
          ['Blank rows', master.balanceFees.blankRows],
          ['Negative results', master.balanceFees.negativeRows],
          ['Zero results', master.balanceFees.zeroRows],
        ],
      ),
    )
    out.push('')
    out.push(`Formula shape(s): ${master.balanceFees.distinctFormulaShapes.map((shape) => `\`${shape}\``).join(', ') || '_none_'}.`)
    out.push('')
    out.push(
      '**Finding:** Balance Fees is a row-local subtraction of that row’s Amount Paid from that ' +
        'row’s Enrollment Total Fees. Because the fee is stated only once per student, every ' +
        'subsequent row computes `blank − amount` and yields a negative number. It is therefore **not** ' +
        'a running balance and **not** the student’s outstanding amount, despite its name. It is ' +
        'imported exactly as the workbook states it and is never recalculated.',
    )
    out.push('')

    out.push('### Date behaviour')
    out.push('')
    out.push(
      table(
        ['Column', 'Reads as', 'Interpreted range', 'Notes'],
        [
          [
            '`Batch`',
            master.batchDateBehaviour.verdict,
            master.batchDateBehaviour.isoRange?.join(' → ') ?? '—',
            `${master.batchDateBehaviour.distinctSerials} distinct values — a date, not a batch name`,
          ],
          [
            '`Paid Date`',
            master.paidDateBehaviour.verdict,
            master.paidDateBehaviour.isoRange?.join(' → ') ?? '—',
            `${master.rowsMissingPaidDate} row(s) leave it blank`,
          ],
        ],
      ),
    )
    out.push('')

    out.push('### Duplicate candidates')
    out.push('')
    out.push(
      table(
        ['Signature', 'Groups', 'Rows'],
        [
          [
            'Identical across every column',
            master.duplicates.exactDuplicateRowGroups,
            master.duplicates.exactDuplicateRowCount,
          ],
          [
            'Student number + amount + paid date',
            master.duplicates.looseSignatureGroups,
            master.duplicates.looseSignatureRowCount,
          ],
          [
            'Student number + amount + paid date + payment no',
            master.duplicates.signatureDuplicateGroups,
            master.duplicates.signatureDuplicateRowCount,
          ],
        ],
      ),
    )
    out.push('')
    out.push(
      `Largest candidate group: ${master.duplicates.largestLooseGroupSize} rows. Adding Payment No to the ` +
        'signature collapses the count, because Payment No increments within each student and so makes the ' +
        'signature very nearly a primary key — which is why the looser signature is the informative one.',
    )
    out.push('')
    out.push(
      'These are **potential duplicate candidates**, not duplicates. Two identical instalments paid on ' +
        'the same day are ordinary in this data. Nothing is removed or merged, and the import preserves ' +
        'every row unless removal is explicitly approved. See question **Q4**.',
    )
    out.push('')

    out.push('### Linking a payment to a batch')
    out.push('')
    const linkage = analysis.batchLinkage
    out.push(
      table(
        ['Measure', 'Count'],
        [
          ['Distinct Batch values in Tracker Master', linkage.distinctTrackerBatchValues],
          ['Batch tables in the workbook', linkage.batchTablesInWorkbook],
          ['Dated sheets in the workbook', linkage.datedSheetsInWorkbook],
          ['Batch values falling on a batch table’s title date', linkage.valuesMatchingATitleDate],
          ['Batch values matching no title date', linkage.valuesMatchingNoTitleDate],
          ['Batch values matching more than one table', linkage.valuesMatchingMoreThanOneTable],
        ],
      ),
    )
    out.push('')
    out.push(`${linkage.note} See question **Q3**.`)
    out.push('')
  }

  // --- 5. PSW batch structure ------------------------------------------------
  out.push('## 5. PSW batch sheets')
  out.push('')
  const batchSheets = [...new Set(analysis.batchBlocks.map((block) => block.sheetName))]
  out.push(
    `${analysis.batchBlocks.length} batch tables across ${batchSheets.length} sheets.`,
  )
  out.push('')
  out.push(
    table(
      ['Sheet', 'Table title (verbatim)', 'Title row', 'Header row', 'Data rows', 'Rows', 'With student no.', 'Non-student rows', 'Actual cols', 'Installment cols'],
      analysis.batchBlocks.map((block) => [
        `\`${block.sheetName}\``,
        `\`${block.title ?? ''}\``,
        block.titleRow ?? '—',
        block.headerRow ?? '—',
        `${block.firstDataRow ?? '—'}–${block.lastDataRow ?? '—'}`,
        block.rowCount,
        block.rowsWithStudentId,
        block.nonStudentRowCount,
        block.actualSection ? `${block.actualSection.firstLetter}–${block.actualSection.lastLetter}` : '—',
        block.installmentSection
          ? `${block.installmentSection.firstLetter}–${block.installmentSection.lastLetter}`
          : '—',
      ]),
    ),
  )
  out.push('')

  out.push('### Structural variants')
  out.push('')
  const variants: string[] = []

  const titleAboveHeader = analysis.batchBlocks.filter(
    (block) => block.titleRow !== null && block.headerRow !== null && block.headerRow > block.titleRow,
  ).length
  const titleOnHeader = analysis.batchBlocks.filter(
    (block) => block.titleRow !== null && block.headerRow === block.titleRow,
  ).length

  variants.push(
    `**Title placement** — ${titleAboveHeader} table(s) put the title on its own row above the headings; ` +
      `${titleOnHeader} table(s) put the title and the headings on the same row.`,
  )

  const inherited = analysis.batchBlocks.filter((block) => block.inheritedHeaders.length > 0)
  variants.push(
    inherited.length === 0
      ? '**Headings** — every table states its own headings.'
      : `**Partial heading rows** — ${inherited.length} table(s) restate only some headings and line up positionally with the table above. ` +
        `Affected: ${inherited.map((block) => `\`${block.sheetName}\` (${block.inheritedHeaders.length} heading(s) borrowed from row ${block.inheritedHeaders[0].fromRow})`).join('; ')}. ` +
        'Recorded as an observation; no heading was invented.',
  )

  const bannerless = analysis.batchBlocks.filter(
    (block) => block.installmentSection?.evidence !== 'banner',
  )
  variants.push(
    `**Section banners** — ${analysis.batchBlocks.length - bannerless.length} table(s) carry an explicit ` +
      `\`INSTALLMENT FEE STRUCTURE\` banner; ${bannerless.length} do not, and their split was inferred from the ` +
      'heading row repeating `Total Fee`. Both are recorded with the evidence used.',
  )

  const startCols = [...new Set(analysis.batchBlocks.map((block) => block.actualSection?.firstLetter ?? '—'))].sort()
  variants.push(
    `**Column positions differ between sheets** — the actual section starts at column ${startCols.join(' on some sheets and ')} ` +
      'on others. Columns must be resolved per table from its own heading row, never by fixed position.',
  )

  const withTotalsRow = analysis.batchBlocks.filter((block) => block.nonStudentRowCount > 0)
  variants.push(
    withTotalsRow.length === 0
      ? '**Totals rows** — no table carries a trailing totals line inside its data span.'
      : `**A totals line sits inside the data span** of ${withTotalsRow.length} of ${analysis.batchBlocks.length} tables: ` +
        'a row with money on it but no student. Its Total Paid cell sums down the column rather than across the row. ' +
        'It must not become a student, a finance record or a payment.',
  )

  const inconsistentSum = analysis.batchBlocks.filter((block) => !block.totalPaidEvidence.consistent)
  variants.push(
    inconsistentSum.length === 0
      ? '**Total Paid** — every table sums one consistent column span.'
      : `**Total Paid sums a different span on different rows** in ${inconsistentSum.length} table(s): ` +
        `${inconsistentSum.map((block) => `\`${block.sheetName}\` — ${block.totalPaidEvidence.note}`).join('; ')}.`,
  )

  for (const variant of variants) {
    out.push(`- ${variant}`)
  }
  out.push('')

  // --- 6. Actual vs installment ----------------------------------------------
  out.push('## 6. Actual payments vs scheduled installments')
  out.push('')
  out.push(
    'Each batch table is split left-to-right into two sections that use **the same column headings**: ' +
      'both have a `Total Fee`, an `Enroll. Fee` and a run of month columns. They are different concepts:',
  )
  out.push('')
  out.push(
    table(
      ['Section', 'Means', 'Maps to'],
      [
        ['`ACTUAL FEE STRUCTURE`', 'the fee agreed, and money actually received', '`student_finance_records.legacy_total_fee`, `payments`'],
        ['`INSTALLMENT FEE STRUCTURE`', 'the payment plan — amounts expected, by month', '`installments.scheduled_amount`'],
      ],
    ),
  )
  out.push('')
  out.push('### How the split was established')
  out.push('')
  out.push(
    'Not by position or by wording, but by the sheet’s own arithmetic. `Total Paid` is a `SUM` over a ' +
      'contiguous range, and the columns inside that range are the ones the workbook itself counts as ' +
      'money received:',
  )
  out.push('')
  out.push(
    table(
      ['Sheet', 'Table', 'Total Paid column', 'Sums (student rows)', 'Consistent', 'Totals-row formula'],
      analysis.batchBlocks.map((block) => [
        `\`${block.sheetName}\``,
        block.title?.includes('Evening') ? 'Evening' : 'Morning',
        block.totalPaidEvidence.column ?? '—',
        block.totalPaidEvidence.rangesSeen.map((range) => `\`${range.range}\` ×${range.rows}`).join(', ') || '—',
        block.totalPaidEvidence.consistent ? 'yes' : '**no**',
        block.totalPaidEvidence.nonStudentRowFormulas.map((shape) => `\`${shape}\``).join(', ') || '—',
      ]),
    ),
  )
  out.push('')
  out.push(
    'This is what establishes that `Enroll. Fee` on the actual side is **money received** rather than a ' +
      'fee: it falls inside the summed range. The identically-named `Enroll. Fee` on the installment side ' +
      'does not, and is a scheduled amount.',
  )
  out.push('')
  out.push(
    'The spans above are measured over student rows only. The last column shows the different formula a ' +
      'trailing totals line uses, which sums down the column instead — counting it as a student row would ' +
      'make every table look inconsistent for the wrong reason.',
  )
  out.push('')

  out.push('### Month columns')
  out.push('')
  const monthColumns = analysis.batchBlocks.flatMap((block) =>
    block.columns.filter((column) => column.month !== null),
  )
  const actualMonths = monthColumns.filter((column) => column.target === 'actual_payment').length
  const scheduledMonths = monthColumns.filter((column) => column.target === 'scheduled_installment').length
  const unresolvedMonths = monthColumns.length - actualMonths - scheduledMonths

  out.push(
    `${monthColumns.length} month-named columns across all batch tables: **${actualMonths}** sit in the ` +
      `actual section and record money received, **${scheduledMonths}** sit in the installment section and ` +
      `record amounts scheduled` +
      (unresolvedMonths > 0 ? `, and **${unresolvedMonths}** could not be resolved and need review` : '') +
      '. The same month name means different things in the two sections, and the two runs of months do not ' +
      'even cover the same months on most sheets.',
  )
  out.push('')
  out.push(
    '**A blank month cell is not a zero payment.** It means no payment was recorded for that month. ' +
      'Nothing in the import may treat it as a payment of 0.',
  )
  out.push('')

  const unnamed = analysis.batchBlocks.filter((block) => block.unnamedColumnsWithData.length > 0)
  if (unnamed.length > 0) {
    out.push('### Columns holding data with no heading')
    out.push('')
    out.push(
      table(
        ['Sheet', 'Table', 'Col', 'Filled', 'Formula shape(s)'],
        unnamed.flatMap((block) =>
          block.unnamedColumnsWithData.map((column) => [
            `\`${block.sheetName}\``,
            block.title?.includes('Evening') ? 'Evening' : 'Morning',
            column.letter,
            column.nonBlankCount,
            column.formulaShapes.map((shape) => `\`${shape}\``).join(', ') || '_literal values_',
          ]),
        ),
      ),
    )
    out.push('')
    out.push(
      'On most sheets this is the outstanding-balance column: the heading was never typed, but the formula ' +
        'is `Total Paid − Total Fee`. It is identified by its formula, not by an assumption about position.',
    )
    out.push('')
  }

  // --- 7 & 8. ELCE and French ------------------------------------------------
  for (const roster of analysis.rosters) {
    const isFrench = /french/i.test(roster.sheetName)
    out.push(`## ${isFrench ? '8' : '7'}. ${roster.sheetName}`)
    out.push('')
    out.push(
      table(
        ['Col', 'Heading (verbatim)', 'Recognised as'],
        roster.headers.map((header) => [header.letter, `\`${header.original}\``, `\`${header.role}\``]),
      ),
    )
    out.push('')
    out.push(
      table(
        ['Measure', 'Count'],
        [
          ['Rows in the data span', roster.rowsInSpan],
          ['**Meaningful rows**', `**${roster.meaningfulRowCount}**`],
          ['Rows with a serial number and nothing else', roster.skeletonRowCount],
          ['Rows with a student number', roster.rowsWithStudentId],
          ['Rows with any name', roster.rowsWithAnyName],
          ['Rows with any money value', roster.rowsWithAnyMoney],
          ['Rows with a total fee', roster.rowsWithTotalFees],
          ['Rows with an enrollment fee', roster.rowsWithEnrollmentFee],
          ['Rows with any installment value', roster.rowsWithAnyInstallment],
          ['Rows with a total paid', roster.rowsWithTotalPaid],
          ['Rows with a balance', roster.rowsWithBalance],
        ],
      ),
    )
    out.push('')
    out.push(
      `Student number prefixes: ${tally(roster.studentIdPrefixCounts)}. ` +
        `Payment data present: ${roster.hasPaymentData ? 'yes' : 'no'}. ` +
        `Schedule data present: ${roster.hasScheduleData ? 'yes' : 'no'}.`,
    )
    out.push('')

    if (roster.dateColumnFindings.letter !== null && roster.dateColumnFindings.nonBlankCount > 0) {
      out.push(
        `**Ambiguous date column.** Column ${roster.dateColumnFindings.letter}, headed ` +
          `${code(roster.dateColumnFindings.header)}, holds ${roster.dateColumnFindings.nonBlankCount} serials that ` +
          `read as ${roster.dateColumnFindings.interpretedISORange?.join(' to ') ?? 'nothing interpretable'} — long ` +
          'before any batch start — while the adjacent `Start Date` column is empty. The heading states a format, ' +
          'not a meaning. What this column records is **not decided here**.',
      )
      out.push('')
    }

    if (isFrench) {
      out.push(
        '**Blocked.** There is no French program configured in the database and none may be invented: ' +
          '`programs` is production configuration that decides how receipt numbers are assembled, and it ships ' +
          'as a migration. A French import needs a program row with an agreed short code, student number prefix ' +
          'and receipt course code first. See question **Q2**.',
      )
    } else {
      out.push(
        '**This sheet must not be forced into the PSW monthly model.** Its plan is ordinal — `1st Installment`, ' +
          '`2nd Installment` — not calendar months, and it has three explicit name columns where the PSW sheets ' +
          'have two.',
      )
      out.push('')
      out.push(
        '**Program identity is an open question.** The sheet is named `ELCE 25 & 26`; the database is configured ' +
          'with a program named *Early Childhood Education Assistant*, short code `ECEA`, student number prefix ' +
          '`121`. The student numbers on this sheet do use the `121` prefix, but that is not sufficient evidence ' +
          'that ELCE and ECEA are the same program, and **this analysis does not decide it**. Neither name has been ' +
          'altered. See question **Q1**.',
      )
    }
    out.push('')
  }

  // --- 9. Summary ------------------------------------------------------------
  out.push('## 9. Summary sheet')
  out.push('')
  if (!analysis.summary) {
    out.push('_No summary sheet was identified._')
  } else {
    const summary = analysis.summary
    out.push(
      table(
        ['Measure', 'Value'],
        [
          ['Rows in the data span', summary.rowsInSpan],
          ['Populated rows', summary.meaningfulRowCount],
          ['Distinct student numbers', summary.distinctStudentIdCount],
          ['Formula cells', summary.formulaCount],
          ['Reads as pivot output', summary.looksLikePivotOutput ? 'yes' : 'no'],
        ],
      ),
    )
    out.push('')
    out.push('Evidence:')
    for (const evidence of summary.pivotEvidence) out.push(`- ${evidence}`)
    out.push('')
    out.push('Compared against Tracker Master:')
    out.push('')
    out.push(
      table(
        ['Measure', 'Count'],
        [
          ['Student numbers in both', summary.comparisonWithTrackerMaster.studentIdsInBoth],
          ['Only in Summary', summary.comparisonWithTrackerMaster.studentIdsOnlyInSummary],
          ['Only in Tracker Master', summary.comparisonWithTrackerMaster.studentIdsOnlyInTrackerMaster],
          ['Totals that disagree', summary.comparisonWithTrackerMaster.studentsWhereAmountPaidDiffers],
        ],
      ),
    )
    out.push('')
    out.push(`${summary.comparisonWithTrackerMaster.note}.`)
    out.push('')
    const agreeing =
      summary.comparisonWithTrackerMaster.studentIdsInBoth -
      summary.comparisonWithTrackerMaster.studentsWhereAmountPaidDiffers

    out.push(
      '**Recommendation: do not import Summary rows as source-of-truth records.** The evidence is that it ' +
        'is derived: stored pivot output with no formulas and aggregate headings, and for ' +
        `${agreeing} of the ${summary.comparisonWithTrackerMaster.studentIdsInBoth} student numbers it shares ` +
        'with Tracker Master its total is exactly the sum of that student’s transaction rows. Importing it ' +
        'would create a second record of money already recorded per transaction, with nothing to say which is ' +
        'authoritative.',
    )
    out.push('')

    if (summary.comparisonWithTrackerMaster.studentsWhereAmountPaidDiffers > 0) {
      out.push(
        `**It is also out of date.** ${summary.comparisonWithTrackerMaster.studentsWhereAmountPaidDiffers} ` +
          'student total(s) do **not** match the sum of that student’s current Tracker Master rows, and ' +
          `${summary.comparisonWithTrackerMaster.studentIdsOnlyInTrackerMaster} student number(s) in Tracker ` +
          'Master are missing from it entirely — what a pivot that was refreshed once and then left behind ' +
          'looks like. That is a further reason not to import it, and a reason not to use it as a ' +
          'reconciliation oracle without first refreshing it.',
      )
      out.push('')
    }
  }
  out.push('')

  // --- 10. Student numbers ---------------------------------------------------
  out.push('## 10. Student numbers (aggregate only)')
  out.push('')
  const cross = analysis.crossSheet
  out.push(
    table(
      ['Measure', 'Count'],
      [
        ['Student rows examined across all sheets', cross.totalOccurrences],
        ['Rows with no student number', cross.occurrencesWithoutId],
        ['**Distinct student numbers**', `**${cross.distinctStudentIdCount}**`],
        ['Numbers appearing on more than one sheet', cross.idsOnMultipleSheets],
        ['In Tracker Master only', cross.idsInTrackerMasterOnly],
        ['On batch sheets only', cross.idsInBatchSheetsOnly],
        ['In both', cross.idsInBoth],
        ['Numbers with a leading zero', cross.idsWithLeadingZero.length],
        ['Numbers containing a non-digit character', cross.idsWithNonDigitCharacters.length],
      ],
    ),
  )
  out.push('')
  out.push(`Prefix distribution: ${tally(cross.prefixCounts)}.`)
  out.push('')
  out.push(`Length distribution: ${tally(cross.lengthCounts)} characters.`)
  out.push('')
  if (cross.idsWithNonDigitCharacters.length > 0 || Object.keys(cross.lengthCounts).length > 2) {
    out.push(
      `**Malformed student numbers exist.** ${cross.idsWithNonDigitCharacters.length} number(s) contain a ` +
        'non-digit character, and the length distribution above shows values outside the five- and ' +
        'six-digit norm. They are recorded exactly as stored and are not cleaned up, reformatted or ' +
        'dropped. They are a reason the database has no unique constraint on `students.student_number` yet.',
    )
    out.push('')
  }
  out.push(
    '**Student numbers are text.** Some sheets store them as numbers and some as strings — the same value ' +
      'appears both ways. Reading one through a JS number risks losing a leading zero, and the prefix carries ' +
      'the program meaning (`125` → PSW, `121` → ECEA) that receipt numbering depends on.',
  )
  out.push('')
  out.push('### Identity findings')
  out.push('')
  out.push(
    table(
      ['Finding', 'Count'],
      [
        [
          'One student number with two name spellings **on the same sheet**',
          cross.sameIdDifferentNameWithinASheet,
        ],
        [
          'One student number whose name differs **between sheets**',
          cross.sameIdDifferentNameAcrossSheets,
        ],
        ['One name appearing under more than one student number', cross.sameNameDifferentIdCount],
        ['Rows with a name but no student number', cross.occurrencesWithoutId],
      ],
    ),
  )
  out.push('')
  out.push(
    'The two rows are counted separately because they mean different things. A number carrying two ' +
      'spellings **on one sheet** is a genuine disagreement, written twice into the same column. A number ' +
      'whose name differs **between sheets** is mostly structural: Tracker Master records one `Student ' +
      'Name`, the batch sheets split the name across two or three columns, so the two rarely reduce to the ' +
      'same string even for the same person. The second number is reported, and is not on its own evidence ' +
      'of anything.',
  )
  out.push('')
  out.push(
    'Matching is on **exact student number only**. Names are compared exactly, after trimming and case ' +
      'folding, and solely to raise these counts. No fuzzy matching was performed, no students were merged, ' +
      'and no name was rewritten. Each case needs a human decision before import. See questions **Q5** and **Q6**.',
  )
  out.push('')

  // --- 11. Dates -------------------------------------------------------------
  out.push('## 11. Date handling')
  out.push('')
  out.push(
    `The workbook uses the ${analysis.date1904 ? '1904' : '1900'} date system. Dates are stored as serial ` +
      'numbers, never as text. The strategy is to keep both forms:',
  )
  out.push('')
  out.push('- The **raw serial** goes into `legacy_raw_json`, untouched.')
  out.push('- The **parsed date** goes into the typed `date` column.')
  out.push(
    '- Serials at or below 60 fall inside Excel’s fictional 1900-02-29 and are reported as ambiguous ' +
      'rather than converted.',
  )
  out.push(
    '- Serials outside a plausible range are flagged, not discarded — the `YYYY/MM/DD` column on the cohort ' +
      'sheets is exactly this case.',
  )
  out.push('')
  out.push(
    'If a parse ever turns out to be wrong, the serial is still on record to correct it from. That is the ' +
      'whole reason for storing both.',
  )
  out.push('')

  // --- 12. Formulas ----------------------------------------------------------
  out.push('## 12. Formulas and error cells')
  out.push('')
  out.push(
    table(
      ['Sheet', 'Formula cells', 'Error cells'],
      analysis.inventory.map((entry) => [`\`${entry.name}\``, entry.formulaCount, entry.errorCount]),
    ),
  )
  out.push('')
  const allErrors = analysis.inventory.flatMap((entry) =>
    entry.errorCells.map((cell) => ({ sheet: entry.name, ...cell })),
  )
  if (allErrors.length === 0) {
    out.push('No `#REF!`, `#VALUE!`, `#DIV/0!`, `#N/A` or `#NAME?` cells were found.')
  } else {
    out.push(`${allErrors.length} error cell(s):`)
    out.push('')
    out.push(
      table(
        ['Sheet', 'Cell', 'Error', 'Formula'],
        allErrors.map((cell) => [`\`${cell.sheet}\``, cell.ref, `\`${cell.error}\``, code(cell.formula)]),
      ),
    )
    out.push('')
    out.push(
      '**Not repaired.** An error cell has no value to import. Storing a zero would invent a figure the ' +
        'workbook never contained. See question **Q7**.',
    )
  }
  out.push('')
  out.push('### What to import from a formula cell')
  out.push('')
  out.push(
    '**Both.** The calculated value goes into the typed column, because that is the figure the school saw ' +
      'and acted on. The formula source goes into `legacy_raw_json`, because it explains how the figure was ' +
      'reached and is the only way to tell a typed-in total from a computed one later. Formulas are never ' +
      'recalculated on import and never repaired.',
  )
  out.push('')

  // --- 13. Legacy preservation ------------------------------------------------
  out.push('## 13. Legacy preservation strategy')
  out.push('')
  out.push(`Every imported finance record and payment carries: ${plan.legacyPreservation.columns.map((column) => `\`${column}\``).join(', ')}.`)
  out.push('')
  out.push('`legacy_raw_json` holds:')
  out.push('')
  out.push(
    table(
      ['Key', 'Holds'],
      Object.entries(plan.legacyPreservation.rawJsonShape).map(([key, value]) => [`\`${key}\``, value]),
    ),
  )
  out.push('')
  for (const rationale of plan.legacyPreservation.rationale) out.push(`- ${rationale}`)
  out.push('')

  // --- 14. Mapping -----------------------------------------------------------
  out.push('## 14. Proposed source → database mapping')
  out.push('')
  out.push('No writes are performed. This is a proposal for Phase B.')
  out.push('')
  for (const source of plan.sources) {
    out.push(`### ${source.source} — \`${source.status}\``)
    out.push('')
    out.push(`**Grain:** ${source.grain}`)
    out.push('')
    out.push(`**Evidence:** ${source.grainEvidence}`)
    out.push('')
    if (source.targetTables.length > 0) {
      out.push(`**Target tables:** ${source.targetTables.map((target) => `\`${target}\``).join(', ')}`)
      out.push('')
    }
    if (source.fields.length > 0) {
      out.push(
        table(
          ['Source column', 'Target', 'Note'],
          source.fields.map((field) => [`\`${field.source}\``, `\`${field.target}\``, field.note || '—']),
        ),
      )
      out.push('')
    }
    if (source.cautions.length > 0) {
      out.push('**Cautions:**')
      out.push('')
      for (const caution of source.cautions) out.push(`- ${caution}`)
      out.push('')
    }
  }

  // --- 15. Import order ------------------------------------------------------
  out.push('## 15. Proposed import order')
  out.push('')
  out.push(
    table(
      ['#', 'Step', 'Why here'],
      plan.importOrder.map((step) => [step.step, step.what, step.why]),
    ),
  )
  out.push('')

  // --- 16. Receipt status ----------------------------------------------------
  out.push('## 16. Historical "Receipt Sent" status')
  out.push('')
  out.push(`**Recommendation:** ${plan.receiptSentStrategy.recommendation}`)
  out.push('')
  for (const rationale of plan.receiptSentStrategy.rationale) out.push(`- ${rationale}`)
  out.push('')
  out.push(`Phase B must not: ${plan.receiptSentStrategy.doNot.join('; ')}.`)
  out.push('')

  // --- 17. Idempotency -------------------------------------------------------
  out.push('## 17. Idempotency strategy')
  out.push('')
  out.push('**Key:**')
  out.push('')
  for (const key of plan.idempotency.key) out.push(`- ${key}`)
  out.push('')
  out.push('**Behaviour:**')
  out.push('')
  for (const behaviour of plan.idempotency.behaviour) out.push(`- ${behaviour}`)
  out.push('')
  out.push('**On database constraints:**')
  out.push('')
  for (const constraint of plan.idempotency.constraints) out.push(`- ${constraint}`)
  out.push('')

  // --- 18. Open questions ----------------------------------------------------
  out.push('## 18. Open questions and blockers')
  out.push('')
  const blocking = plan.openQuestions.filter((question) => question.blocking)
  const nonBlocking = plan.openQuestions.filter((question) => !question.blocking)

  out.push(
    `${blocking.length} blocking, ${nonBlocking.length} non-blocking. Phase B should not start on the ` +
      'blocking ones until they are answered.',
  )
  out.push('')
  for (const question of plan.openQuestions) {
    out.push(`### ${question.id}${question.blocking ? ' — **blocking**' : ''}`)
    out.push('')
    out.push(`**Question:** ${question.question}`)
    out.push('')
    out.push(`**Why it matters:** ${question.why}`)
    out.push('')
    out.push(`**What the analysis found:** ${question.evidence}`)
    out.push('')
  }

  // --- 19. No writes ---------------------------------------------------------
  out.push('## 19. No database writes')
  out.push('')
  out.push('**NO DATABASE DATA WAS WRITTEN IN THIS PHASE.**')
  out.push('')
  out.push(
    'No students, batches, finance records, installments, payments or receipts were created. No receipt ' +
      'numbers were generated, no PDFs were produced and no email was sent. The workbook was opened ' +
      'read-only from a buffer and its SHA-256 re-checked afterwards; the receipt template PDF was not ' +
      'touched. This document and the Git-ignored JSON under `.private/finance-import-analysis/` are the ' +
      'only outputs.',
  )
  out.push('')
  out.push('---')
  out.push('')
  out.push(
    '_Generated by `npm run finance:analyze` (`scripts/finance-import/analyze-workbook.mts`). ' +
      'Regenerate rather than edit by hand: every count here is read from the workbook._',
  )
  out.push('')

  return out.join('\n')
}

/** Exported for tests: the only headings whose values may reach a committed file. */
export const PRINTABLE_HEADERS_FOR_TESTS = PRINTABLE_VALUE_HEADERS
export const mayPrintValuesForTests = mayPrintValues
