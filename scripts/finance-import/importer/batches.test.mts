import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  batchLabelFromTitle,
  batchStartDateFromTitle,
  buildBatchCandidate,
  findBatchNameCollisions,
  proposedBatchName,
} from './batches.mts'
import { buildSourceTable, sessionFromTitle } from './source-tables.mts'
import { findBlocks } from '../lib/blocks.mts'
import { pswBatchSheet, rangeOf } from './fixtures.mts'

const HASH = '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2'

function tableFor(title: string) {
  const sheet = pswBatchSheet(title)
  const blocks = findBlocks(sheet, rangeOf(sheet))
  return buildSourceTable('Fixture Sheet', sheet, blocks[0], 'psw_batch')
}

describe('a start date is read, never invented', () => {
  it('reads a full date from a title that states one', () => {
    assert.equal(
      batchStartDateFromTitle('PSW Morning Batch - 17th March 2025').iso,
      '2025-03-17',
    )
    assert.equal(batchStartDateFromTitle('PSW Evening Batch - 18 August 2025').iso, '2025-08-18')
    assert.equal(batchStartDateFromTitle('PSW Morning Batch - 06th October 2025').iso, '2025-10-06')
    assert.equal(batchStartDateFromTitle('PSW Morning Batch - 1st June, 2026').iso, '2026-06-01')
    assert.equal(batchStartDateFromTitle('PSW Morning Batch - 29th JULY, 2026').iso, '2026-07-29')
  })

  it('refuses to assume the first of the month when no day is stated', () => {
    const reading = batchStartDateFromTitle('PSW Morning Batch - December 2025')
    assert.equal(reading.iso, null)
    assert.match(reading.reason, /no day/)
  })

  it('refuses a title with no year at all', () => {
    const reading = batchStartDateFromTitle('PSW Evening Batch - December')
    assert.equal(reading.iso, null)
    assert.match(reading.reason, /no year/)
  })

  it('refuses to expand a two- or three-digit year into a century', () => {
    for (const title of ['PSW Evening Batch - January 026', 'PSW Morning Batch - March 26']) {
      const reading = batchStartDateFromTitle(title)
      assert.equal(reading.iso, null, title)
      assert.match(reading.reason, /not four digits/)
    }
  })

  it('never takes the year from the worksheet name', () => {
    // The sheet is called "Aug 2026"; its tables are titled July. Only the
    // title is read, so the batch dates land in July and not in August.
    assert.equal(batchStartDateFromTitle('PSW Evening Batch - 29th JULY 2026').iso, '2026-07-29')
  })

  it('refuses a day that is not a real date', () => {
    const reading = batchStartDateFromTitle('PSW Morning Batch - 31st February 2026')
    assert.equal(reading.iso, null)
    assert.match(reading.reason, /not a real date/)
  })

  it('reports a title it cannot read at all', () => {
    assert.equal(batchStartDateFromTitle(null).iso, null)
    assert.equal(batchStartDateFromTitle('PSW Morning Batch').iso, null)
  })
})

describe('Morning and Evening come from the title, never from position', () => {
  it('reads a session the title names', () => {
    assert.equal(sessionFromTitle('PSW Morning Batch - March 26'), 'Morning')
    assert.equal(sessionFromTitle('PSW Evening Batch - March 26'), 'Evening')
  })

  it('returns null for a title that names no session', () => {
    assert.equal(sessionFromTitle('PSW Batch - March 26'), null)
    assert.equal(sessionFromTitle(null), null)
  })

  it('appends the session only when the title names it', () => {
    const named = tableFor('PSW Morning Batch - 12th May 2025')
    assert.equal(proposedBatchName(named), '12th May 2025 - Morning')

    const unnamed = tableFor('PSW Batch - 12th May 2025')
    assert.equal(proposedBatchName(unnamed), '12th May 2025')
  })
})

describe('batch names are deterministic and human readable', () => {
  it('keeps the source spelling of the date label', () => {
    assert.equal(batchLabelFromTitle('PSW Morning Batch - 29th JULY, 2026'), '29th JULY, 2026')
  })

  it('gives the same name for the same table every time', () => {
    const table = tableFor('PSW Morning Batch - 12th May 2025')
    assert.equal(proposedBatchName(table), proposedBatchName(tableFor('PSW Morning Batch - 12th May 2025')))
  })

  it('separates the Morning and Evening tables of one sheet', () => {
    assert.notEqual(
      proposedBatchName(tableFor('PSW Morning Batch - 12th May 2025')),
      proposedBatchName(tableFor('PSW Evening Batch - 12th May 2025')),
    )
  })
})

describe('a batch candidate records its source', () => {
  it('carries the exact worksheet name and the verbatim title', () => {
    const table = tableFor('PSW Morning Batch - 12th May 2025')
    const candidate = buildBatchCandidate(HASH, table, 'PSW', 'PSW')

    assert.equal(candidate.legacySheetName, 'Fixture Sheet')
    assert.equal(candidate.sourceTitle, 'PSW Morning Batch - 12th May 2025')
    assert.equal(candidate.startDate, '2025-05-12')
    assert.equal(candidate.programShortCode, 'PSW')
    assert.match(candidate.code, /^Fixture Sheet!title@1$/)
  })

  it('preserves the ELCE source label on an ECEA batch', () => {
    const table = tableFor('ELCE Batch - 12th May 2025')
    const candidate = buildBatchCandidate(HASH, table, 'ECEA', 'ELCE')
    assert.equal(candidate.programShortCode, 'ECEA')
    assert.equal(candidate.sourceProgramLabel, 'ELCE')
  })
})

describe('name collisions are caught before an apply hits the constraint', () => {
  it('finds two batches of one program sharing a name', () => {
    const table = tableFor('PSW Morning Batch - 12th May 2025')
    const first = buildBatchCandidate(HASH, table, 'PSW', 'PSW')
    const second = { ...first, sourceKey: `${first.sourceKey}-other` }

    assert.equal(findBatchNameCollisions([first, second]).length, 1)
  })

  it('allows the same name under two different programs', () => {
    const table = tableFor('PSW Morning Batch - 12th May 2025')
    const psw = buildBatchCandidate(HASH, table, 'PSW', 'PSW')
    const ecea = { ...psw, programShortCode: 'ECEA' }

    assert.equal(findBatchNameCollisions([psw, ecea]).length, 0)
  })
})
