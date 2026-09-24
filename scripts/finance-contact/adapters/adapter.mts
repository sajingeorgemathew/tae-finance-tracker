/**
 * The source-adapter contract.
 *
 * A master roster workbook is program-specific in layout and program-generic
 * in meaning. An adapter owns the layout: it recognizes its workbook from the
 * workbook's *structure* (sheet titles, heading rows — never the filename),
 * and maps that structure onto canonical `ContactImportRow`s. Everything after
 * `parse()` — scope, matching, reconciliation, reporting — is shared and knows
 * nothing about the program.
 *
 * Adding a third program is: write one adapter (a title recognizer and a
 * heading map, usually on top of `scanSheet`), register it in
 * `ADAPTERS`, and give it a scope entry in `scope-config.mts`. No parser,
 * engine or report changes.
 */

import type { WorkBook } from 'xlsx'

import type { ContactImportRow } from '../canonical.mts'
import type { SheetScan } from '../table-scan.mts'

export interface AdapterRecognition {
  recognized: boolean
  /** Why, in structural terms ("12 sheets titled 'PSW … Batch'"). Never a filename. */
  reason: string
  matchedSheets: string[]
}

/** One roster table the adapter found: a source intake/cohort, as the source states it. */
export interface DiscoveredIntake {
  programCode: string
  sheetName: string
  tableTitle: string | null
  intakeLabel: string | null
  intakeDate: string | null
  session: string | null
  /** Rows classified as student rows in this table. */
  studentRows: number
  /** Whether the table is authoritative for staging, or a validation-only copy. */
  role: 'primary' | 'cross_check'
}

export interface AdapterParseResult {
  adapterId: string
  programCode: string
  workbookName: string
  sheets: SheetScan[]
  /**
   * Rows staged for reconciliation. For a workbook with one master sheet and
   * subset copies, only the master's rows are here.
   */
  rows: ContactImportRow[]
  /** Rows from validation-only sheets, kept for cross-checks and never staged twice. */
  crossCheckRows: ContactImportRow[]
  intakes: DiscoveredIntake[]
  /** Heading texts seen but not mapped, across every sheet. Names only. */
  ignoredHeadings: string[]
  /** The subset of ignored headings that matched a sensitive pattern. Names only. */
  sensitiveHeadings: string[]
  /** Structural observations worth a reader's attention. Never row values. */
  notes: string[]
}

export interface MasterContactSourceAdapter {
  /** Stable id, e.g. `psw-masterclass-list`. */
  id: string
  programCode: string
  /** Which per-row date decides scope for this source. */
  scopeDateField: 'intakeDate' | 'sourceStartDate'
  recognize(workbook: WorkBook): AdapterRecognition
  parse(workbook: WorkBook, workbookName: string): AdapterParseResult
}
