/**
 * The proposed workbook-to-database mapping, and what still blocks it.
 *
 * Nothing here executes. It is a plan built from what the analysis actually
 * found, so the counts quoted in it move when the workbook does, and the open
 * questions appear only when the evidence for them appears.
 *
 * The plan's governing rule is that the workbook is history. Where the
 * workbook disagrees with arithmetic, the workbook wins and the disagreement
 * is recorded. No balance is recomputed, no blank is filled, no duplicate is
 * removed, and no student is merged.
 */

import type { WorkbookAnalysis } from './analyze-workbook.mts'

export interface FieldMapping {
  source: string
  target: string
  note: string
}

export interface SourceMapping {
  source: string
  /** Sheets this mapping covers. */
  sheets: string[]
  grain: string
  /** Whether the grain claim was tested, and how. */
  grainEvidence: string
  targetTables: string[]
  fields: FieldMapping[]
  cautions: string[]
  status: 'proposed' | 'blocked' | 'not-imported'
}

export interface OrderStep {
  step: number
  what: string
  why: string
}

export interface OpenQuestion {
  id: string
  question: string
  why: string
  /** What the analysis found that raised it. */
  evidence: string
  blocking: boolean
}

export interface ImportPlan {
  sources: SourceMapping[]
  importOrder: OrderStep[]
  idempotency: {
    key: string[]
    behaviour: string[]
    constraints: string[]
  }
  legacyPreservation: {
    columns: string[]
    rawJsonShape: Record<string, string>
    rationale: string[]
  }
  receiptSentStrategy: {
    recommendation: string
    rationale: string[]
    doNot: string[]
  }
  openQuestions: OpenQuestion[]
}

export function buildImportPlan(analysis: WorkbookAnalysis): ImportPlan {
  const master = analysis.trackerMaster
  const batchSheets = [...new Set(analysis.batchBlocks.map((block) => block.sheetName))]
  const elce = analysis.rosters.find((roster) => /elce/i.test(roster.sheetName)) ?? null
  const french = analysis.rosters.find((roster) => /french/i.test(roster.sheetName)) ?? null

  const sources: SourceMapping[] = []

  // --- Tracker Master --------------------------------------------------------
  if (master) {
    const feeVerdict = master.enrollmentTotalFee
    sources.push({
      source: 'Tracker Master',
      sheets: [master.sheetName],
      grain: 'one row is one payment',
      grainEvidence:
        `${master.transactionRowCount} populated rows carry a Payment No that restarts at 1 per student ` +
        `(${master.distinctStudentIdCount} distinct student numbers), an Amount Paid and a Mode of Payment. ` +
        `Enrollment Total Fees is filled on ${feeVerdict.filledRows} rows and blank on ${feeVerdict.blankRows}: ` +
        `${feeVerdict.verdict}, so it is a per-student figure stated once, not a per-payment one.`,
      targetTables: ['students', 'student_finance_records', 'payments'],
      fields: [
        { source: 'Student ID', target: 'students.student_number', note: 'text, never parsed as a number' },
        { source: 'Student Name', target: 'students.legacy_name', note: 'stored whole; not split into parts' },
        { source: 'Amount Paid', target: 'payments.amount', note: 'verbatim, including zero and negative values' },
        { source: 'Paid Date', target: 'payments.payment_date', note: 'serial parsed to a date; the serial is kept in legacy_raw_json' },
        { source: 'Mode of Payment', target: 'payments.payment_method', note: 'stored as written, not normalised to a code list' },
        { source: 'Payment No', target: 'payments.reference', note: 'the workbook’s own per-student sequence' },
        { source: 'Program', target: 'programs.short_code (match only)', note: 'matched, never created' },
        { source: 'Batch', target: 'batches (match only)', note: 'a date serial, not a batch name; see open questions' },
        { source: 'Enrollment Total Fees', target: 'student_finance_records.legacy_total_fee', note: 'taken from the row that states it; never copied onto other rows' },
        { source: 'Balance Fees', target: 'payments.legacy_raw_json', note: 'a row-local formula result, not a student balance; see cautions' },
        { source: 'REMARKS, VIKAS REMARKS', target: 'payments.note', note: 'kept separate and labelled by source column' },
        { source: 'Receipt Sent', target: 'payments.legacy_raw_json + legacy receipt status', note: 'never a receipts row; see the receipt strategy' },
      ],
      cautions: [
        `Balance Fees is ${master.balanceFees.verdict} of the form ${master.balanceFees.distinctFormulaShapes.join(', ') || '(none)'}, ` +
          `evaluated against the same row only. Where Enrollment Total Fees is blank it yields the negative of that single payment ` +
          `(${master.balanceFees.negativeRows} rows are negative). It must not be read as the student's outstanding balance and must never be recalculated.`,
        `${master.rowsMissingStudentId} row(s) have no student number and ${master.rowsMissingPaidDate} have no paid date. ` +
          'Both import as-is; neither is filled in from elsewhere.',
        `${master.duplicates.looseSignatureGroups} potential duplicate candidate group(s) covering ` +
          `${master.duplicates.looseSignatureRowCount} rows (same student number, amount and paid date), and ` +
          `${master.duplicates.exactDuplicateRowGroups} group(s) identical across every column. These are candidates, ` +
          'not confirmed duplicates: two identical instalments paid the same day are ordinary. All are imported ' +
          'unless removal is explicitly approved.',
      ],
      status: 'proposed',
    })
  }

  // --- PSW batch sheets ------------------------------------------------------
  if (analysis.batchBlocks.length > 0) {
    const inconsistentTotals = analysis.batchBlocks.filter(
      (block) => !block.totalPaidEvidence.consistent,
    )
    const withInherited = analysis.batchBlocks.filter((block) => block.inheritedHeaders.length > 0)

    sources.push({
      source: 'PSW batch sheets',
      sheets: batchSheets,
      grain: 'one row is one student in one batch; each sheet holds two batch tables',
      grainEvidence:
        `${analysis.batchBlocks.length} batch tables across ${batchSheets.length} sheets — every dated sheet carries a ` +
        'Morning and an Evening table with separate titles, header rows and data spans.',
      targetTables: ['batches', 'students', 'student_finance_records', 'installments', 'payments'],
      fields: [
        { source: 'block title', target: 'batches.name + batches.legacy_sheet_name', note: 'title kept verbatim; the sheet name is recorded separately' },
        { source: 'Student ID', target: 'students.student_number', note: 'text; stored as a number on some sheets and a string on others' },
        { source: 'First/Last Name', target: 'students.first_name / last_name', note: 'kept as the sheet splits them, whatever that split is' },
        { source: 'Payer / Payee', target: 'payments.payer_name', note: 'present on some sheets only' },
        { source: 'ACTUAL: Total Fee', target: 'student_finance_records.legacy_total_fee', note: 'the fee agreed, not money received' },
        { source: 'ACTUAL: Enroll. Fee, month columns, Late Fees', target: 'payments (source = legacy_import)', note: 'one payment per populated cell; a blank cell creates nothing' },
        { source: 'ACTUAL: Total Paid', target: 'student_finance_records.legacy_total_paid', note: 'the sheet’s own SUM, stored but never used to validate the payments' },
        { source: 'ACTUAL: Outstanding (often unheaded)', target: 'student_finance_records.legacy_balance', note: 'stored as stated, including negatives' },
        { source: 'INSTALLMENT: Total Fee, Enroll. Fee, month columns', target: 'installments (scheduled_amount)', note: 'a plan, not money; installment_type enrollment or monthly' },
        { source: 'Graduated / REMARKS', target: 'student_finance_records.status + note', note: 'status words are recorded, not mapped to a lifecycle yet' },
        { source: 'Discount', target: 'legacy_raw_json', note: 'a formula against a constant list price; no target column exists' },
      ],
      cautions: [
        'The ACTUAL and INSTALLMENT sections both contain a Total Fee, an Enroll. Fee and month columns with the same names. ' +
          'They are different concepts and must never be combined: one is money received, the other is money scheduled.',
        `A blank month cell means no payment was recorded, not a payment of zero. ${analysis.batchBlocks.length} tables rely on this.`,
        inconsistentTotals.length === 0
          ? 'Every table sums a single consistent column span into Total Paid.'
          : `${inconsistentTotals.length} table(s) sum a different column span into Total Paid on different rows ` +
            `(${inconsistentTotals.map((block) => `${block.sheetName}: ${block.totalPaidEvidence.rangesSeen.map((range) => range.range).join(' / ')}`).join('; ')}). ` +
            'Which columns count as money received therefore varies row by row on those sheets, and the per-cell import must not assume the header-row layout.',
        withInherited.length === 0
          ? 'Every table states its own headings.'
          : `${withInherited.length} table(s) do not restate every heading and line up positionally with the table above them. ` +
            'The analysis records which headings were borrowed and from which row; an importer must resolve columns per table, not per sheet.',
      ],
      status: 'proposed',
    })
  }

  // --- ELCE ------------------------------------------------------------------
  if (elce) {
    sources.push({
      source: 'ELCE cohort sheet',
      sheets: [elce.sheetName],
      grain: 'one row is one student with a two-instalment plan',
      grainEvidence:
        `${elce.meaningfulRowCount} meaningful rows; ${elce.rowsWithStudentId} carry a student number, ` +
        `${elce.rowsWithAnyInstallment} carry instalment values. No month columns and no ACTUAL/INSTALLMENT split.`,
      targetTables: ['students', 'student_finance_records', 'installments', 'payments'],
      fields: [
        { source: 'Student ID', target: 'students.student_number', note: `prefixes seen: ${Object.keys(elce.studentIdPrefixCounts).join(', ')}` },
        { source: 'First / Middle / Last Name', target: 'students.first_name / middle_name / last_name', note: 'three explicit name columns, unlike the PSW sheets' },
        { source: 'Payee', target: 'payments.payer_name', note: 'a payer, not the student' },
        { source: 'WKD/WKND', target: 'batches.code or legacy_raw_json', note: 'weekday/weekend stream; no column exists for it yet' },
        { source: 'Total fees', target: 'student_finance_records.legacy_total_fee', note: '' },
        { source: 'Enrollment fees, 1st/2nd Installment, Late fees', target: 'payments', note: 'amounts inside the Total Paid SUM, so money received' },
        { source: 'Total Paid', target: 'student_finance_records.legacy_total_paid', note: 'the sheet’s own SUM' },
        { source: 'Balance', target: 'student_finance_records.legacy_balance', note: '' },
      ],
      cautions: [
        'This sheet must not be forced into the PSW monthly model. Its instalments are ordinal (1st, 2nd), not calendar months.',
        `The column headed "YYYY/MM/DD" holds serials reading ${elce.dateColumnFindings.interpretedISORange?.join(' to ') ?? '(none)'} — ` +
          'decades before any batch start, and the adjacent "Start Date" column is empty. What it records is not decided here.',
      ],
      status: 'blocked',
    })
  }

  // --- French ----------------------------------------------------------------
  if (french) {
    sources.push({
      source: 'French cohort sheet',
      sheets: [french.sheetName],
      grain: 'one row is one student; the sheet is largely unpopulated',
      grainEvidence:
        `${french.meaningfulRowCount} meaningful row(s) of ${french.rowsInSpan} in the data span; ` +
        `${french.rowsWithStudentId} carry a student number and ${french.rowsWithAnyMoney} carry any money value.`,
      targetTables: [],
      fields: [],
      cautions: [
        'No program row exists for French in the database, and none may be invented. ' +
          'Program configuration is a deliberate migration, not a side effect of an import.',
        'Without student numbers there is no reliable identity key for these rows.',
      ],
      status: 'blocked',
    })
  }

  // --- Summary ---------------------------------------------------------------
  if (analysis.summary) {
    const summary = analysis.summary
    sources.push({
      source: 'Summary',
      sheets: [summary.sheetName],
      grain: 'one row is one student total',
      grainEvidence:
        `${summary.meaningfulRowCount} rows, ${summary.formulaCount} formulas. ` +
        summary.pivotEvidence.join('; '),
      targetTables: [],
      fields: [],
      cautions: [
        summary.comparisonWithTrackerMaster.note +
          `; ${summary.comparisonWithTrackerMaster.studentIdsOnlyInSummary} student number(s) appear only here and ` +
          `${summary.comparisonWithTrackerMaster.studentIdsOnlyInTrackerMaster} only in Tracker Master.`,
        'Importing these rows would create a second record of money already recorded per transaction, with no way to tell which is authoritative.',
      ],
      status: 'not-imported',
    })
  }

  // --- Open questions --------------------------------------------------------
  const openQuestions: OpenQuestion[] = []

  if (elce) {
    openQuestions.push({
      id: 'Q1-ELCE-PROGRAM-IDENTITY',
      question:
        'Is the sheet "ELCE 25 & 26" the same program as the configured ECEA (Early Childhood Education Assistant, prefix 121)?',
      why:
        'Every ELCE finance record needs a program_id. Matching it to ECEA on a hunch would file real money under the wrong program and produce wrong receipt numbers, since receipt numbers are built from the program code.',
      evidence:
        `ELCE student numbers use the prefix ${Object.keys(elce.studentIdPrefixCounts).join(', ')}, and ECEA is configured with student_number_prefix 121. ` +
        'The prefix agrees but the names do not. Neither name is altered by this analysis.',
      blocking: true,
    })
  }

  if (french) {
    openQuestions.push({
      id: 'Q2-FRENCH-PROGRAM-CONFIG',
      question:
        'Should a French program be configured, and with what short code, student number prefix and receipt course code?',
      why:
        'programs is production configuration that decides how receipt numbers are assembled. It ships as a migration, so a value guessed here would become a permanent, wrong part of every French receipt.',
      evidence:
        `The French sheet has ${french.meaningfulRowCount} meaningful row(s), ${french.rowsWithStudentId} with a student number ` +
        `and ${french.rowsWithAnyMoney} with money values. No French program exists in the database.`,
      blocking: true,
    })
  }

  if (master) {
    openQuestions.push({
      id: 'Q3-BATCH-COLUMN-MEANING',
      question:
        'Should the Tracker Master "Batch" date serial be matched to a batch table by date, or kept only as a raw value?',
      why:
        'Tracker Master identifies a batch by a date while the batch sheets identify it by a title, and each dated sheet holds both a Morning and an Evening batch. A date alone cannot say which of the two a payment belongs to, and payments.student_finance_record_id is NOT NULL.',
      evidence:
        `Batch reads as ${analysis.trackerMaster?.batchDateBehaviour.verdict} across ` +
        `${analysis.batchLinkage.distinctTrackerBatchValues} distinct values` +
        (analysis.trackerMaster?.batchDateBehaviour.isoRange
          ? ` spanning ${analysis.trackerMaster.batchDateBehaviour.isoRange.join(' to ')}`
          : '') +
        `, against ${analysis.batchLinkage.batchTablesInWorkbook} batch tables on ` +
        `${analysis.batchLinkage.datedSheetsInWorkbook} dated sheets. ${analysis.batchLinkage.note}`,
      blocking: true,
    })

    if (master.duplicates.looseSignatureGroups > 0 || master.duplicates.exactDuplicateRowGroups > 0) {
      openQuestions.push({
        id: 'Q4-DUPLICATE-CANDIDATES',
        question:
          `Should all ${master.duplicates.looseSignatureRowCount} rows in the ${master.duplicates.looseSignatureGroups} potential duplicate candidate group(s) be imported?`,
        why:
          'Two payments of the same amount on the same day by the same student are ordinary — an instalment paid in two parts, or a second student on one card. Dropping them would silently lose real money; keeping a genuine double-entry would overstate it. This is a business decision, not a technical one.',
        evidence:
          `${master.duplicates.exactDuplicateRowGroups} group(s) are identical across every column. ` +
          `${master.duplicates.looseSignatureGroups} group(s) share student number, amount and paid date ` +
          `(largest group: ${master.duplicates.largestLooseGroupSize} rows). Adding Payment No to the signature ` +
          `reduces this to ${master.duplicates.signatureDuplicateGroups} group(s), because Payment No increments ` +
          'within each student and so makes the signature very nearly a key.',
        blocking: false,
      })
    }

    if (master.rowsMissingStudentId > 0) {
      openQuestions.push({
        id: 'Q5-ROWS-WITHOUT-STUDENT-NUMBER',
        question: `How should the ${master.rowsMissingStudentId} transaction row(s) with no student number be attached to a student?`,
        why:
          'payments.student_finance_record_id is NOT NULL, so a payment cannot be stored without resolving a student. Matching on name alone would be a fuzzy identity decision on real money.',
        evidence: `${master.rowsMissingStudentId} populated row(s) carry a name but no student number.`,
        blocking: true,
      })
    }
  }

  const identityConflicts = analysis.crossSheet.sameIdDifferentNameWithinASheet
  if (identityConflicts > 0 || analysis.crossSheet.sameNameDifferentIdCount > 0) {
    openQuestions.push({
      id: 'Q6-IDENTITY-CONFLICTS',
      question:
        `Are the ${identityConflicts} student number(s) that carry two different names on one sheet one person each, or two people sharing a number?`,
      why:
        'Student numbers are the only identity key trusted here. If one number covers two people, importing by number would merge two students’ finances into a single record.',
      evidence:
        `${identityConflicts} student number(s) appear with two name spellings within a single sheet, which is a ` +
        `genuine disagreement. A further ${analysis.crossSheet.sameIdDifferentNameAcrossSheets} differ only ` +
        'between sheets, which is mostly structural: Tracker Master holds one name column and the batch sheets ' +
        `hold two or three. Separately, ${analysis.crossSheet.sameNameDifferentIdCount} name(s) appear under more ` +
        'than one student number. No merging or fuzzy matching was performed.',
      blocking: false,
    })
  }

  const errorSheets = analysis.inventory.filter((entry) => entry.errorCount > 0)
  if (errorSheets.length > 0) {
    openQuestions.push({
      id: 'Q7-FORMULA-ERROR-CELLS',
      question: 'What should be stored for cells that currently hold a spreadsheet error?',
      why:
        'An error cell has no numeric value to import. Storing zero would invent a figure; storing nothing loses the fact that the workbook had an error there.',
      evidence: errorSheets
        .map((entry) => `${entry.name}: ${entry.errorCells.map((cell) => `${cell.ref} ${cell.error}`).join(', ')}`)
        .join('; '),
      blocking: false,
    })
  }

  const titleMismatch = analysis.batchBlocks.filter((block) => {
    if (!block.title || !block.probableBatchDate.iso) return false
    const month = Number(block.probableBatchDate.iso.slice(5, 7))
    const sheetMonth = /aug/i.test(block.sheetName) ? 8 : null
    return sheetMonth !== null && month !== sheetMonth
  })

  if (titleMismatch.length > 0) {
    openQuestions.push({
      id: 'Q8-SHEET-NAME-VS-TITLE',
      question: 'Which is authoritative when a sheet name and its block title disagree about the batch date?',
      why: 'batches.start_date and the batch name both come from here, and they must not disagree once imported.',
      evidence: titleMismatch
        .map((block) => `sheet ${JSON.stringify(block.sheetName)} vs title ${JSON.stringify(block.title)}`)
        .join('; '),
      blocking: false,
    })
  }

  const lowConfidenceDates = analysis.batchBlocks.filter(
    (block) => block.probableBatchDate.confidence === 'low' || block.probableBatchDate.confidence === 'none',
  )
  if (lowConfidenceDates.length > 0) {
    openQuestions.push({
      id: 'Q9-BATCH-DATE-CONFIDENCE',
      question: `Confirm the start date for the ${lowConfidenceDates.length} batch table(s) whose title does not give an unambiguous date.`,
      why: 'batches.start_date is a real date column; an assumed first-of-month would look like fact once stored.',
      evidence: lowConfidenceDates
        .map((block) => `${JSON.stringify(block.title)} — ${block.probableBatchDate.note}`)
        .join('; '),
      blocking: false,
    })
  }

  return {
    sources,
    importOrder: [
      {
        step: 1,
        what: 'Create the import_batches row',
        why: 'Written first, with the workbook SHA-256, so every row that follows can be traced to one run of one file — and so a failed run is identifiable rather than anonymous.',
      },
      {
        step: 2,
        what: 'Match programs; do not create them',
        why: 'programs is production configuration that decides receipt numbering. An unmatched program value stops the import rather than inventing a row.',
      },
      {
        step: 3,
        what: 'Create batches, one per batch table rather than one per sheet',
        why: 'Each dated sheet holds a Morning and an Evening batch. One batch per sheet would merge two cohorts.',
      },
      {
        step: 4,
        what: 'Create students, keyed on exact student number',
        why: 'Everything downstream references a student. Rows without a number are held back for review rather than matched on name.',
      },
      {
        step: 5,
        what: 'Create student_finance_records from the batch sheets, one per student per batch',
        why: 'The batch sheets carry the per-student fee, total paid and balance. legacy_* values are written exactly as the workbook states them.',
      },
      {
        step: 6,
        what: 'Create installments from the INSTALLMENT section only',
        why: 'A scheduled amount is not money. Keeping the scheduled side out of payments is what stops the two being added together.',
      },
      {
        step: 7,
        what: 'Create payments from the ACTUAL section cells and from Tracker Master rows',
        why: 'Payments need their finance record to exist. Both sources are recorded with their own legacy_source_sheet so they stay distinguishable.',
      },
      {
        step: 8,
        what: 'Record historical receipt status as metadata',
        why: 'Last, and only as a status: it depends on payments existing and must not become a receipt.',
      },
    ],
    idempotency: {
      key: [
        'import_batches.source_file_hash — the workbook SHA-256',
        'legacy_source_sheet — the sheet the row came from',
        'legacy_source_row — the 1-based row number',
        'the source column letter, for batch sheets where one row yields several payments',
      ],
      behaviour: [
        'A re-run of the same workbook hash finds every row it would create already present and creates nothing.',
        'A re-run with a different hash is a different source file and is refused unless explicitly confirmed, because the row numbers it would key on no longer mean the same rows.',
        'Rows that were held back for review stay held back on a re-run; they are not silently imported once the code changes.',
        'The import runs in one transaction per sheet, so a failure leaves no half-imported batch.',
      ],
      constraints: [
        'No unique constraint is added to students.student_number yet: the workbook contains numbers that appear with more than one name, and a database constraint would reject real history before a human has looked at it.',
        'Uniqueness is enforced in the importer, on (import_batch, legacy_source_sheet, legacy_source_row, source column), which is a property of the import rather than of the data.',
        'A partial unique index on payments over the legacy key, restricted to source = legacy_import, is the natural next step once the duplicate-candidate question is answered.',
      ],
    },
    legacyPreservation: {
      columns: ['legacy_source_sheet', 'legacy_source_row', 'legacy_raw_json'],
      rawJsonShape: {
        sheet: 'sheet name, exactly as the workbook spells it',
        block_title: 'the batch table title, for sheets with more than one table',
        row: '1-based row number in the sheet',
        column: 'source column letter, for values taken from one cell',
        header: 'the column heading exactly as stored, trailing spaces and all',
        raw_value: 'the stored cell value, untouched — the serial, not the date',
        formatted_text: 'what Excel displayed, when the file carries it',
        formula: 'the formula source, where the cell had one',
        cell_type: 'the SheetJS cell type, so a blank is distinguishable from a zero',
      },
      rationale: [
        'A date is stored as a serial and a parsed date. If the parse is ever wrong, the serial is still there to correct it from.',
        'A heading like "Student ID " carries a trailing space that identifies which sheet a value came from. Trimming it on import would lose that.',
        'Formula cells are imported as their calculated value, with the formula kept in legacy_raw_json. The value is what the school acted on; the formula explains how it got there.',
        'A blank and a zero are recorded distinguishably, because the difference decides whether a payment exists at all.',
      ],
    },
    receiptSentStrategy: {
      recommendation:
        'Store the workbook’s Receipt Sent value as a legacy status on the payment, inside legacy_raw_json and as a boolean-with-provenance field. Do not create a receipts row and do not create a receipt_deliveries row.',
      rationale: [
        'The workbook records that a receipt was sent. It does not record a receipt number, a PDF, a recipient address or a send timestamp.',
        'A receipts row implies a receipt document exists and can be reissued. Creating one from a "YES" would fabricate a record the school could send to a student.',
        'Receipt numbers are generated from program configuration and a sequence. Inventing numbers for historical receipts would collide with, or corrupt, that sequence.',
        'A receipt_deliveries row asserts a provider, a message id and an address that were never recorded. That is fabricated delivery history.',
      ],
      doNot: [
        'generate receipt numbers for historical payments',
        'generate PDFs for historical payments',
        'create receipt_deliveries rows from a Receipt Sent flag',
        'normalise the recorded values into a boolean without keeping what was written',
      ],
    },
    openQuestions,
  }
}
