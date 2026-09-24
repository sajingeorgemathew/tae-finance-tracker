/**
 * In-memory fixture workbooks for the contact-import tests.
 *
 * Every value here is invented: `example.test` addresses, 555 phone numbers,
 * student numbers in the 9xxxxx range no real program uses. The *layouts*
 * mirror the real masters exactly — that is what the adapters are tested on.
 */

import * as XLSX from 'xlsx'

import type { WorkBook } from 'xlsx'

type Cell = string | number | null

function sheetOf(rows: Cell[][]): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet(rows.map((row) => row.map((cell) => (cell === null ? undefined : cell))) as unknown[][])
}

export function workbookOf(sheets: Record<string, Cell[][]>): WorkBook {
  const workbook = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, sheetOf(rows), name)
  }
  return workbook
}

/** The password value the PSW fixture carries. Tests assert it never appears in any output. */
export const FIXTURE_PASSWORD = 'Secret-Fixture-Password-1'

/** A date of birth the fixtures carry. Tests assert it never appears in any output. */
export const FIXTURE_DOB = '1990-01-31'

/** An address the fixtures carry. Tests assert it never appears in any output. */
export const FIXTURE_ADDRESS = '1 Fixture Street, Nowhere'

const PSW_HEADER_WITH_PASSWORD: Cell[] = [
  'Sr. No. ', 'Student ID ', 'Password ', 'First Name ', 'Last Name ', 'YYYY/MM/DD', 'WP', 'Contact No. ', 'Email ', 'Address ',
  'Transcripts', 'College Cert', 'NACC', 'VENUE', 'START DATE', 'FINISH DATE', 'STATUS', 'GRADUATED',
]

const PSW_HEADER: Cell[] = [
  'Sr. No. ', 'Student ID ', 'First Name ', 'Middle Name', 'Last Name ', 'YYYY/MM/DD', 'Status', 'Contact No. ', 'Email ', 'Address',
  'Transcripts', 'College Cert', 'NACC', 'VENUE', 'START DATE', 'FINISH DATE', 'STATUS', 'GRADUATED',
]

const LEGEND: Cell[][] = [
  [null, null, 'Withdrawal'],
  [null, null, 'Enrollment Pending'],
  [null, null, 'Other Reason'],
]

/**
 * A PSW-shaped workbook: three intake sheets (historical, operational,
 * upcoming), each with a Morning and an Evening table.
 *
 * Deliberate cases:
 *  - a Password column on the historical sheet, whose values must never leak;
 *  - student 900003 listed in both the Dec 2025 Evening table and the Sep
 *    2026 Morning table (a repeated number across intakes);
 *  - student 900002 listed twice in the same table with different emails;
 *  - a leading-zero student number stored as text;
 *  - a row with a name and email but no student number;
 *  - a placeholder row that carries only a serial number;
 *  - a malformed email and a 9-digit phone;
 *  - two students sharing one phone number.
 */
export function pswFixtureWorkbook(): WorkBook {
  return workbookOf({
    '17th March': [
      ['PSW Morning Batch - 17th March 2025'],
      PSW_HEADER_WITH_PASSWORD,
      [1, 900101, FIXTURE_PASSWORD, 'Hist', 'Morning', FIXTURE_DOB, 'Work Permit', '4165550101', 'hist.morning@example.test', FIXTURE_ADDRESS, 'Y', 'Y', 'Y', null, null, null, null, 'GRADUATED'],
      [null],
      ...LEGEND,
      [null],
      [null, null, null, null, null, null, null, null, null, null, null, null, null, 'PLACEMENT'],
      ['Sr. No. ', 'Student ID ', 'Password ', 'First Name ', 'Last Name ', 'D.O.B', 'Status', 'Contact No. ', 'Email ', 'Address ', 'Transcripts', 'College Cert', 'NACC', 'VENUE', 'START DATE', 'FINISH DATE', 'STATUS'],
      [1, 900102, FIXTURE_PASSWORD, 'Hist', 'Evening', FIXTURE_DOB, 'Citizen', '4165550102', 'hist.evening@example.test', FIXTURE_ADDRESS],
    ],
    'Dec 1st': [
      ['PSW Morning Batch - 01st Dec 2025'],
      PSW_HEADER,
      [1, 900001, 'Alpha', null, 'Tester', FIXTURE_DOB, 'PGWP', '416-555-0001', 'Alpha.Tester@Example.test', FIXTURE_ADDRESS, null, null, null, null, null, null, null, 'GRADUATED'],
      [2, 900002, 'Beta', 'Middle', 'Tester', FIXTURE_DOB, 'PGWP', '(416) 555-0002', 'beta@example.test', FIXTURE_ADDRESS],
      [3, 900002, 'Beta', 'Middle', 'Tester', FIXTURE_DOB, 'PGWP', '(416) 555-0002', 'beta.other@example.test', FIXTURE_ADDRESS],
      [4, '0900004', 'Gamma', null, 'Zero', FIXTURE_DOB, null, '416.555.0004', 'gamma@example.test', FIXTURE_ADDRESS],
      [5, null, 'Delta', null, 'Unnumbered', FIXTURE_DOB, null, '416-555-0005', 'delta@example.test', FIXTURE_ADDRESS],
      [6, 900006, 'Epsilon', null, 'Badmail', FIXTURE_DOB, null, '437-555-012', 'epsilon-at-example.test', FIXTURE_ADDRESS],
      [7],
      [null],
      ...LEGEND,
      [null],
      ['PSW Evening Batch - 1st Dec 2025'],
      PSW_HEADER,
      [1, 900003, 'Zeta', null, 'Repeat', FIXTURE_DOB, 'Refugee', '416-555-0003', 'zeta@example.test', FIXTURE_ADDRESS],
      [2, 900007, 'Eta', null, 'Sharedphone', FIXTURE_DOB, null, '416-555-0003', 'eta@example.test', FIXTURE_ADDRESS],
      [3, 900008, 'Theta', null, 'Nocontact', FIXTURE_DOB, null, null, null, FIXTURE_ADDRESS],
    ],
    'Sep 28th': [
      ['PSW Morning Batch - September 28, 2026'],
      PSW_HEADER,
      [1, 900003, 'Zeta', null, 'Repeat', FIXTURE_DOB, 'Refugee', '416-555-0003', 'zeta.new@example.test', FIXTURE_ADDRESS],
      [2],
      [3],
      [null],
      ['PSW Evening Batch - September 28, 2026'],
      PSW_HEADER,
      [1, 900009, 'Iota', null, 'Future', FIXTURE_DOB, null, '416-555-0009', 'iota@example.test', FIXTURE_ADDRESS],
    ],
  })
}

const ECEA_HEADER: Cell[] = [
  'Sr. No.', 'Student ID', 'First Name', 'Middle Name', 'Last Name', 'DOB (YYYY-MM-DD)', 'GRADUATED', 'WKND & WKD', 'START DATE', 'END DATE', 'Status', 'Contact No.', 'Email', 'Address',
]

/**
 * An ECEA-shaped workbook: a master sheet and two subset sheets, each subset
 * holding a Morning and an Evening table.
 *
 * Deliberate cases:
 *  - 910001 (WD) and 910002 (WN) appear in master and in the right subset;
 *  - 910003 appears in the master and in the Weekday subset with a *different*
 *    email (a source conflict);
 *  - 910004 appears only in the Weekend subset (subset-only discrepancy);
 *  - 910005 is in the master with a start date before the cutoff (historical);
 *  - 910006 is in the master with no start date (date unknown);
 *  - 910001 is also listed in the Weekend subset although the master says WD.
 */
export function eceaFixtureWorkbook(): WorkBook {
  return workbookOf({
    'Master-ECEA': [
      ['Early Childhood Education Assistant (ECEA) Batch - 2025 & 26'],
      ECEA_HEADER,
      [1, 910001, 'Kappa', null, 'Weekday', FIXTURE_DOB, 'YES', 'WD', '2025-12-18', '2026-01-31', 'Open Work Permit', '647-555-1001', 'kappa@example.test', FIXTURE_ADDRESS],
      [2, 910002, 'Lambda', null, 'Weekend', FIXTURE_DOB, 'YES', 'WN', '2025-12-18', '2026-01-31', 'Refugee', '647-555-1002', 'lambda@example.test', FIXTURE_ADDRESS],
      [3, 910003, 'Mu', 'Conflict', 'Email', FIXTURE_DOB, 'YES', 'WD', '2026-01-12', '2026-02-21', 'PGWP', '647-555-1003', 'mu.master@example.test', FIXTURE_ADDRESS],
      [4, 910005, 'Nu', null, 'Historical', FIXTURE_DOB, 'DROPPED OFF', 'WD', '2025-01-08', 'Dropped', 'Study Permit', '647-555-1005', 'nu@example.test', FIXTURE_ADDRESS],
      [5, 910006, 'Xi', null, 'Undated', FIXTURE_DOB, null, 'WN', null, null, 'PGWP', '647-555-1006', 'xi@example.test', FIXTURE_ADDRESS],
    ],
    'ECEA-WEEKDAYS': [
      ['Early Childhood Education Assistant (ECEA) Batch - 2025 & 26 - Weekday Morning'],
      ECEA_HEADER,
      [1, 910001, 'Kappa', null, 'Weekday', FIXTURE_DOB, 'YES', 'WD', '2025-12-18', '2026-01-31', 'Open Work Permit', '647-555-1001', 'kappa@example.test', FIXTURE_ADDRESS],
      [2, 910003, 'Mu', 'Conflict', 'Email', FIXTURE_DOB, 'YES', 'WD', '2026-01-12', '2026-02-21', 'PGWP', '647-555-1003', 'mu.subset@example.test', FIXTURE_ADDRESS],
      [null],
      ['Early Childhood Education Assistant (ECEA) Batch - 2025 & 26 - Weekday Evening'],
      ECEA_HEADER,
      [1, 910005, 'Nu', null, 'Historical', FIXTURE_DOB, 'DROPPED OFF', 'WD', '2025-01-08', 'Dropped', 'Study Permit', '647-555-1005', 'nu@example.test', FIXTURE_ADDRESS],
    ],
    'ECEA-WEEKEND': [
      ['Early Childhood Education Assistant (ECEA) Batch - 2025 & 26 - Weekend Morning'],
      ECEA_HEADER,
      [1, 910002, 'Lambda', null, 'Weekend', FIXTURE_DOB, 'YES', 'WN', '2025-12-18', '2026-01-31', 'Refugee', '647-555-1002', 'lambda@example.test', FIXTURE_ADDRESS],
      [2, 910004, 'Omicron', null, 'Subsetonly', FIXTURE_DOB, 'YES', 'WN', '2026-01-09', '2026-02-21', 'PGWP', '647-555-1004', 'omicron@example.test', FIXTURE_ADDRESS],
      [null],
      ['Early Childhood Education Assistant (ECEA) Batch - 2025 & 26 - Weekend Evening'],
      ECEA_HEADER,
      [1, 910001, 'Kappa', null, 'Weekday', FIXTURE_DOB, 'YES', 'WN', '2025-12-18', '2026-01-31', 'Open Work Permit', '647-555-1001', 'kappa@example.test', FIXTURE_ADDRESS],
    ],
  })
}

/** A workbook shaped like the finance tracker: recognized by no contact adapter. */
export function financeShapedWorkbook(): WorkBook {
  return workbookOf({
    Summary: [['Summary'], ['Batch', 'Total']],
    'Tracker Master': [['Sr No', 'Student ID', 'Name', 'Program', 'Amount']],
    'Dec 2025': [['PSW Morning Batch - 01st Dec 2025'], ['Sr. No.', 'Student ID', 'Name', 'Total Fee']],
  })
}
