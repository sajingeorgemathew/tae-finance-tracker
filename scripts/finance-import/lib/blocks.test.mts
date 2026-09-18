import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import * as XLSX from 'xlsx'

import { findBlocks } from './blocks.mts'

import type { WorkSheet } from 'xlsx'

/**
 * Builds a worksheet from a grid of values, mirroring the shapes the real
 * workbook uses. `undefined` leaves a cell absent, which is how a blank is
 * represented — not as an empty string.
 */
function sheetFrom(grid: (string | number | undefined)[][], merges: string[] = []): WorkSheet {
  const sheet: WorkSheet = {}
  grid.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      if (value === undefined) return
      const ref = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })
      sheet[ref] = typeof value === 'number' ? { t: 'n', v: value } : { t: 's', v: value }
    })
  })
  sheet['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: grid.length - 1, c: Math.max(...grid.map((row) => row.length)) - 1 },
  })
  if (merges.length > 0) sheet['!merges'] = merges.map((merge) => XLSX.utils.decode_range(merge))
  return sheet
}

function blocksOf(sheet: WorkSheet) {
  return findBlocks(sheet, XLSX.utils.decode_range(sheet['!ref'] as string))
}

describe('a sheet can hold more than one batch table', () => {
  it('finds a Morning and an Evening table on one sheet', () => {
    const sheet = sheetFrom([
      ['PSW Morning Batch - 17th March 2025', undefined, undefined, 'ACTUAL FEE STRUCTURE', undefined, undefined, 'INSTALLMENT FEE STRUCTURE'],
      ['Sr. No. ', 'Student ID ', 'First Name ', 'Total Fee ', 'March', 'Total Paid', 'Total Fee ', 'April '],
      [1, 12506, 'A', 5600, 1000, 5600, 5600, 1000],
      [2, 12507, 'B', 5600, 900, 5600, 5600, 1000],
      [],
      ['PSW Evening Batch - 17th March 2025'],
      ['Sr. No. ', 'Student ID ', 'First Name ', 'Total Fee ', 'March', 'Total Paid', 'Total Fee ', 'April '],
      [1, 12501, 'C', 5000, 500, 5000, 5000, 1000],
    ])

    const blocks = blocksOf(sheet)

    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].title, 'PSW Morning Batch - 17th March 2025')
    assert.equal(blocks[1].title, 'PSW Evening Batch - 17th March 2025')
    assert.deepEqual([blocks[0].firstDataRow, blocks[0].lastDataRow], [3, 4])
    assert.deepEqual([blocks[1].firstDataRow, blocks[1].lastDataRow], [8, 8])
  })

  it('handles a table whose title and headings share one row', () => {
    // Dec 2025, Jan 2026 and March 2026 all do this.
    const sheet = sheetFrom([
      ['PSW Morning Batch - December 2025'],
      ['Sr. No. ', 'Student ID ', 'Total Fee ', 'Total Paid', 'Total Fee ', 'Enroll. Fee', 'December'],
      [1, 125159, 6826, 5939, 6826, 826, 1000],
      [],
      ['PSW Evening Batch - December', undefined, undefined, undefined, 'Total Fee ', 'Enroll. Fee', 'December'],
      [1, 125157, 6600, 6600, 6600, 600, 1000],
    ])

    const blocks = blocksOf(sheet)

    assert.equal(blocks.length, 2)
    assert.equal(blocks[1].titleRow, 5)
    assert.equal(blocks[1].headerRow, 5, 'the title row is also the heading row')
    assert.equal(blocks[1].firstDataRow, 6)
    // The title itself must not be picked up as a column heading.
    assert.equal(
      blocks[1].ownHeaders.some((header) => header.original.includes('Evening')),
      false,
    )
  })

  it('records headings borrowed from the table above rather than inventing them', () => {
    const sheet = sheetFrom([
      ['PSW Morning Batch - December 2025'],
      ['Sr. No. ', 'Student ID ', 'Total Fee ', 'Total Paid', 'Total Fee ', 'Enroll. Fee', 'December'],
      [1, 125159, 6826, 5939, 6826, 826, 1000],
      [],
      ['PSW Evening Batch - December', undefined, undefined, undefined, 'Total Fee ', 'Enroll. Fee', 'December'],
      [1, 125157, 6600, 6600, 6600, 600, 1000],
    ])

    const evening = blocksOf(sheet)[1]

    const borrowed = evening.inheritedHeaders.map((header) => header.original)
    assert.ok(borrowed.includes('Student ID '), 'Student ID was borrowed from the table above')
    assert.ok(evening.inheritedHeaders.every((header) => header.fromRow === 2))
    // Borrowed headings are reported separately from the ones the table states.
    assert.equal(
      evening.ownHeaders.some((header) => header.original === 'Student ID '),
      false,
    )
    assert.equal(
      evening.headers.some((header) => header.original === 'Student ID '),
      true,
    )
  })
})

describe('splitting a table into actual and scheduled sections', () => {
  it('uses the banners when they are there', () => {
    const sheet = sheetFrom(
      [
        ['PSW Morning Batch - 2nd July 2025', undefined, undefined, 'ACTUAL FEE STRUCTURE', undefined, undefined, 'INSTALLMENT FEE STRUCTURE'],
        ['Sr. No. ', 'Student ID ', 'Payer', 'Total Fee ', 'July', 'Total Paid', 'Total Fee ', 'July'],
        [1, 12566, undefined, 5673, 1000, 5673, 5673, 1000],
      ],
      ['D1:F1', 'G1:H1'],
    )

    const block = blocksOf(sheet)[0]

    assert.equal(block.actualSection?.evidence, 'banner')
    assert.equal(block.installmentSection?.evidence, 'banner')
    assert.equal(block.actualSection?.firstLetter, 'D')
    assert.equal(block.installmentSection?.firstLetter, 'G')
  })

  it('falls back to the repeated Total Fee heading when there is no banner', () => {
    const sheet = sheetFrom([
      ['PSW Morning Batch - March 26'],
      ['Sr. No. ', 'Student ID ', 'Total Fee ', 'March', 'Total Paid', 'Total Fee ', 'December'],
      [1, 125236, 5865, 1000, 5865, 5865, 1000],
    ])

    const block = blocksOf(sheet)[0]

    assert.equal(block.installmentSection?.evidence, 'repeated-total-fee-header')
    assert.equal(block.installmentSection?.firstLetter, 'F')
    assert.equal(block.actualSection?.firstLetter, 'C')
    assert.equal(block.actualSection?.lastLetter, 'E', 'the actual side stops where the scheduled side starts')
  })

  it('gives a flat table no sections rather than inventing a split', () => {
    // Tracker Master, ELCE and French have no actual/scheduled division.
    const sheet = sheetFrom([
      ['Sr. No. ', 'Student ID ', 'First Name ', 'Total fees', 'Enrollment fees', 'Total Paid'],
      [1, 12101, 'A', 1953.77, 823.77, 1953.77],
    ])

    const block = blocksOf(sheet)[0]

    assert.equal(block.actualSection, null)
    assert.equal(block.installmentSection, null)
  })
})

describe('data row spans', () => {
  it('stops at the last populated row, not the declared range', () => {
    const grid: (string | number | undefined)[][] = [
      ['PSW Morning Batch - 17th March 2025'],
      ['Sr. No. ', 'Student ID ', 'Total Fee ', 'Total Paid'],
      [1, 12506, 5600, 5600],
    ]
    // A long empty tail, as 17th March 2025 has.
    for (let index = 0; index < 40; index += 1) grid.push([])
    grid[grid.length - 1] = []

    const block = blocksOf(sheetFrom(grid))[0]

    assert.equal(block.lastDataRow, 3)
  })

  it('keeps a blank row that sits between two populated rows', () => {
    const sheet = sheetFrom([
      ['PSW Morning Batch - 17th March 2025'],
      ['Sr. No. ', 'Student ID ', 'Total Fee ', 'Total Paid'],
      [1, 12506, 5600, 5600],
      [],
      [3, 12508, 5000, 1000],
    ])

    const block = blocksOf(sheet)[0]

    assert.deepEqual([block.firstDataRow, block.lastDataRow], [3, 5])
  })
})
