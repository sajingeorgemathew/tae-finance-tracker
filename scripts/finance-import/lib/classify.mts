/**
 * Tentative sheet classification.
 *
 * Classification is a reading of the evidence, not a decision about the data.
 * `unknown` is a legitimate and useful answer: a sheet nobody can confidently
 * place is exactly the sheet a reviewer should look at before any import runs,
 * and forcing it into the nearest category would hide that.
 *
 * Every classification carries the evidence it was made on, so the report can
 * show why rather than just what.
 */

import { normalizeHeader, roleForHeader } from './headers.mts'

import type { SheetBlock } from './blocks.mts'
import type { ColumnRole } from './headers.mts'

export type SheetClassification =
  /** Derived totals, not a source of transactions. */
  | 'summary'
  /** The one long list of individual payments. */
  | 'transaction_master'
  /** A dated PSW intake sheet, one or more batch tables. */
  | 'psw_batch'
  /** A cohort sheet for a program that is not PSW. */
  | 'other_program_batch'
  /** Not confidently any of the above. */
  | 'unknown'

export interface ClassificationResult {
  classification: SheetClassification
  /** Plain-language reasons, in the order they were checked. */
  evidence: string[]
}

/** Roles that together identify the transaction master. */
const TRANSACTION_ROLES: ColumnRole[] = ['payment_number', 'amount_paid', 'paid_date']

/** Roles that together identify a per-student cohort table. */
const COHORT_ROLES: ColumnRole[] = ['student_id', 'total_fee', 'total_paid']

const PSW_TITLE = /\bpsw\b/i
const SUMMARY_PIVOT_HEADER = /^sum of /i

function rolesPresent(blocks: SheetBlock[]): Set<ColumnRole> {
  const roles = new Set<ColumnRole>()
  for (const block of blocks) {
    for (const header of block.headers) roles.add(roleForHeader(header.original))
  }
  return roles
}

function hasAll(roles: Set<ColumnRole>, required: ColumnRole[]): boolean {
  return required.every((role) => roles.has(role))
}

/**
 * Classifies one sheet from its name and the tables found in it.
 *
 * The order matters: a pivot-style Summary is checked before the cohort shape,
 * because it also carries a Student ID column and would otherwise look like a
 * roster.
 */
export function classifySheet(sheetName: string, blocks: SheetBlock[]): ClassificationResult {
  const evidence: string[] = []
  const roles = rolesPresent(blocks)
  const normalizedName = normalizeHeader(sheetName)

  const pivotHeaders = blocks
    .flatMap((block) => block.headers)
    .filter((header) => SUMMARY_PIVOT_HEADER.test(header.normalized))

  if (pivotHeaders.length > 0) {
    evidence.push(
      `carries ${pivotHeaders.length} aggregate heading(s) of the form "Sum of ...": ` +
        pivotHeaders.map((header) => JSON.stringify(header.original)).join(', '),
    )
    if (normalizedName === 'summary') evidence.push('sheet is named "Summary"')
    return { classification: 'summary', evidence }
  }

  if (hasAll(roles, TRANSACTION_ROLES)) {
    evidence.push('headings include Payment No, Amount Paid and Paid Date: one row is one payment')
    return { classification: 'transaction_master', evidence }
  }

  const titles = blocks.map((block) => block.title).filter((title): title is string => title !== null)
  const pswTitles = titles.filter((title) => PSW_TITLE.test(title))

  if (pswTitles.length > 0) {
    evidence.push(`${pswTitles.length} block title(s) name a PSW batch`)
    if (blocks.some((block) => block.installmentSection !== null)) {
      evidence.push('block has a separate scheduled-installment section')
    }
    return { classification: 'psw_batch', evidence }
  }

  if (hasAll(roles, COHORT_ROLES)) {
    evidence.push('headings include Student ID, Total Fee and Total Paid: one row is one student')
    evidence.push('no block title names PSW')
    return { classification: 'other_program_batch', evidence }
  }

  if (blocks.length === 0) {
    evidence.push('no header row could be identified')
  } else {
    evidence.push(
      `headings did not match a known shape (roles seen: ${[...roles].sort().join(', ') || 'none'})`,
    )
  }

  return { classification: 'unknown', evidence }
}
