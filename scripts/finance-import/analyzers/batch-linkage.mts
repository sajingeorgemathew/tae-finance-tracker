/**
 * Can a Tracker Master payment be attached to a batch table?
 *
 * Tracker Master names a batch with a date serial. The batch sheets name one
 * with a title such as "PSW Morning Batch - 12th May 2025", and every dated
 * sheet carries two of them. So the question has two parts, and this module
 * answers both with counts rather than with a matching rule:
 *
 *   1. Do the dates agree at all?
 *   2. Even where they do, a single date cannot distinguish the Morning table
 *      from the Evening one.
 *
 * No payment is assigned to a batch here. This is the evidence behind the open
 * question, not an attempt to settle it.
 */

import { interpretDateCell, numericValue, readCell } from '../lib/excel-values.mts'

import type { BatchBlockAnalysis } from './psw-batch.mts'
import type { SheetBlock } from '../lib/blocks.mts'
import type { WorkSheet } from 'xlsx'

export interface BatchLinkageAnalysis {
  /** Distinct Batch values in Tracker Master, by raw serial. */
  trackerBatchValues: {
    serial: number
    iso: string | null
    rowCount: number
    /** Batch table titles whose own date reads as the same day. */
    exactTitleMatches: string[]
  }[]
  distinctTrackerBatchValues: number
  batchTablesInWorkbook: number
  datedSheetsInWorkbook: number
  valuesMatchingATitleDate: number
  valuesMatchingNoTitleDate: number
  /** Batch values whose date matches more than one table — the Morning/Evening pair. */
  valuesMatchingMoreThanOneTable: number
  note: string
}

export function analyzeBatchLinkage(
  trackerSheet: WorkSheet | null,
  trackerBlock: SheetBlock | null,
  batchColumn: number | null,
  batchBlocks: readonly BatchBlockAnalysis[],
  date1904: boolean,
): BatchLinkageAnalysis {
  const counts = new Map<number, number>()

  if (trackerSheet && trackerBlock && batchColumn !== null) {
    for (let row = trackerBlock.firstDataRow ?? 0; row <= (trackerBlock.lastDataRow ?? -1); row += 1) {
      const value = numericValue(readCell(trackerSheet, row - 1, batchColumn))
      if (value === null) continue
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
  }

  const trackerBatchValues = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([serial, rowCount]) => {
      const iso = interpretDateCell({ ref: '', type: 'n', value: serial }, date1904).iso
      const exactTitleMatches = batchBlocks
        .filter((block) => block.probableBatchDate.iso !== null && block.probableBatchDate.iso === iso)
        .map((block) => block.title ?? '(untitled)')
      return { serial, iso, rowCount, exactTitleMatches }
    })

  const matching = trackerBatchValues.filter((value) => value.exactTitleMatches.length > 0)
  const multiple = trackerBatchValues.filter((value) => value.exactTitleMatches.length > 1)

  const datedSheets = new Set(batchBlocks.map((block) => block.sheetName)).size

  return {
    trackerBatchValues,
    distinctTrackerBatchValues: trackerBatchValues.length,
    batchTablesInWorkbook: batchBlocks.length,
    datedSheetsInWorkbook: datedSheets,
    valuesMatchingATitleDate: matching.length,
    valuesMatchingNoTitleDate: trackerBatchValues.length - matching.length,
    valuesMatchingMoreThanOneTable: multiple.length,
    note:
      matching.length === 0
        ? `None of the ${trackerBatchValues.length} distinct Batch values falls on the same day as any batch table title. ` +
          'The Batch column is a date, but not the batch start date the sheets state.'
        : `${matching.length} of ${trackerBatchValues.length} distinct Batch values fall on the same day as a batch table title` +
          (multiple.length > 0
            ? `, and ${multiple.length} match more than one table because each dated sheet holds both a Morning and an Evening batch.`
            : '.'),
  }
}
