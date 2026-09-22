import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  chooseDefaultIntake,
  formatIntakeDate,
  groupBatchesIntoIntakes,
  intakeForBatch,
  parseMonthTitle,
  resolveRequestedIntake,
  sessionOfBatchName,
  UNASSIGNED_INTAKE,
  type IntakeBatch,
} from './intake.ts'

/**
 * FINANCE-GRID-03C — intake grouping.
 *
 * The fixtures mirror the hosted batches exactly as the import wrote them:
 * two tables per PSW sheet sharing one `legacy_sheet_name`, differently
 * spelled names, six batches with no start date, and one ECEA roster.
 */

function batch(partial: Partial<IntakeBatch> & { id: string; name: string }): IntakeBatch {
  return {
    programId: 'psw',
    programShortCode: 'PSW',
    startDate: null,
    legacySheetName: null,
    session: sessionOfBatchName(partial.name),
    studentCount: 0,
    ...partial,
  }
}

const JULY_MORNING = batch({
  id: 'july-m',
  name: '29th JULY, 2026 - Morning',
  startDate: '2026-07-29',
  legacySheetName: 'Aug 2026',
  studentCount: 6,
})
const JULY_EVENING = batch({
  id: 'july-e',
  name: '29th JULY 2026 - Evening',
  startDate: '2026-07-29',
  legacySheetName: 'Aug 2026',
  studentCount: 11,
})
const AUGUST_MORNING = batch({
  id: 'aug-m',
  name: '18th August 2025 - Morning',
  startDate: '2025-08-18',
  legacySheetName: '18th August 2025',
  studentCount: 14,
})
const AUGUST_EVENING = batch({
  id: 'aug-e',
  name: '18 August 2025 - Evening',
  startDate: '2025-08-18',
  legacySheetName: '18th August 2025',
  studentCount: 24,
})
const MARCH_MORNING = batch({
  id: 'march-m',
  name: '17th March 2025 - Morning',
  startDate: '2025-03-17',
  legacySheetName: '17th March 2025',
  studentCount: 13,
})
const MARCH_EVENING = batch({
  id: 'march-e',
  name: '17th March 2025 - Evening',
  startDate: '2025-03-17',
  legacySheetName: '17th March 2025',
  studentCount: 11,
})
const DECEMBER_MORNING = batch({
  id: 'dec-m',
  name: 'December 2025 - Morning',
  legacySheetName: 'Dec 2025',
  studentCount: 17,
})
const DECEMBER_EVENING = batch({
  id: 'dec-e',
  name: 'December - Evening',
  legacySheetName: 'Dec 2025',
  studentCount: 14,
})
const JANUARY_MORNING = batch({
  id: 'jan-m',
  name: 'January 2026 - Morning',
  legacySheetName: 'Jan 2026',
  studentCount: 20,
})
const JANUARY_EVENING = batch({
  id: 'jan-e',
  name: 'January 026 - Evening',
  legacySheetName: 'Jan 2026',
  studentCount: 19,
})
const ECEA = batch({
  id: 'elce',
  name: 'ELCE 25 & 26',
  programId: 'ecea',
  programShortCode: 'ECEA',
  legacySheetName: 'ELCE 25 & 26',
  studentCount: 50,
})

describe('session comes from the batch name and nowhere else', () => {
  it('reads Morning and Evening, case-insensitively', () => {
    assert.equal(sessionOfBatchName('29th JULY, 2026 - Morning'), 'Morning')
    assert.equal(sessionOfBatchName('January 026 - Evening'), 'Evening')
  })

  it('returns null when the name states neither', () => {
    assert.equal(sessionOfBatchName('ELCE 25 & 26'), null)
  })
})

describe('Morning and Evening on one sheet become one intake', () => {
  it('groups the pair and keeps both underlying batch ids', () => {
    const intakes = groupBatchesIntoIntakes([JULY_EVENING, JULY_MORNING])

    assert.equal(intakes.length, 1)
    const [intake] = intakes
    assert.deepEqual(intake.underlyingBatchIds, ['july-m', 'july-e'])
    assert.deepEqual(intake.availableSessions, ['Morning', 'Evening'])
    assert.equal(intake.studentCount, 17)
    assert.equal(intake.latestStartDate, '2026-07-29')
  })

  it('groups on the shared sheet even when the names are spelled differently', () => {
    const intakes = groupBatchesIntoIntakes([AUGUST_EVENING, AUGUST_MORNING])
    assert.equal(intakes.length, 1)
    assert.deepEqual(intakes[0].underlyingBatchIds, ['aug-m', 'aug-e'])
  })

  it('never merges batches from different sheets, however alike their names', () => {
    const lookalike = batch({
      id: 'other-e',
      name: '17th March 2025 - Evening',
      startDate: '2025-03-17',
      legacySheetName: 'Some other sheet',
    })
    const intakes = groupBatchesIntoIntakes([MARCH_MORNING, lookalike])
    assert.equal(intakes.length, 2)
  })

  it('never merges across programs', () => {
    const eceaOnPswSheet = batch({
      id: 'x',
      name: 'Evening thing',
      programId: 'ecea',
      programShortCode: 'ECEA',
      legacySheetName: '17th March 2025',
    })
    const intakes = groupBatchesIntoIntakes([MARCH_MORNING, eceaOnPswSheet])
    assert.equal(intakes.length, 2)
  })

  it('leaves two Morning tables on one sheet as two intakes rather than guessing', () => {
    const secondMorning = batch({
      id: 'march-m2',
      name: 'Another Morning',
      startDate: '2025-03-17',
      legacySheetName: '17th March 2025',
    })
    const intakes = groupBatchesIntoIntakes([MARCH_MORNING, secondMorning])
    assert.equal(intakes.length, 2)
    assert.ok(intakes.every((intake) => intake.underlyingBatchIds.length === 1))
  })

  it('leaves a batch with no recorded sheet as an intake of its own', () => {
    const noSheet = batch({ id: 'n', name: 'New batch - Morning', legacySheetName: null })
    const intakes = groupBatchesIntoIntakes([noSheet, JULY_MORNING, JULY_EVENING])
    assert.equal(intakes.length, 2)
  })

  it('ECEA stays its own intake with no sessions', () => {
    const intakes = groupBatchesIntoIntakes([ECEA])
    assert.equal(intakes.length, 1)
    assert.deepEqual(intakes[0].availableSessions, [])
    assert.equal(intakes[0].displayName, 'ELCE 25 & 26')
    assert.equal(intakes[0].datePrecision, 'none')
  })

  it('reduces the 22 PSW batches to 11 intakes', () => {
    const pairs: IntakeBatch[] = []
    for (let index = 0; index < 11; index += 1) {
      const date = `2025-${String(index + 1).padStart(2, '0')}-01`
      pairs.push(
        batch({ id: `m${index}`, name: `Batch ${index} - Morning`, startDate: date, legacySheetName: `Sheet ${index}` }),
        batch({ id: `e${index}`, name: `Batch ${index} - Evening`, startDate: date, legacySheetName: `Sheet ${index}` }),
      )
    }
    assert.equal(groupBatchesIntoIntakes(pairs).length, 11)
  })

  it('the unassigned view is never an intake', () => {
    const intakes = groupBatchesIntoIntakes([JULY_MORNING, JULY_EVENING, ECEA])
    assert.ok(intakes.every((intake) => intake.key !== UNASSIGNED_INTAKE))
    assert.equal(UNASSIGNED_INTAKE, 'unassigned')
  })
})

describe('labels state what the source states, no more', () => {
  it('labels a dated intake from its start date', () => {
    const [intake] = groupBatchesIntoIntakes([JULY_MORNING, JULY_EVENING])
    assert.equal(intake.displayName, '29 Jul 2026')
    assert.equal(intake.datePrecision, 'day')
    assert.equal(intake.key, '2026-07-29')
  })

  it('labels an undated intake from the month its sheet title states, with no day', () => {
    const [intake] = groupBatchesIntoIntakes([DECEMBER_EVENING, DECEMBER_MORNING])
    assert.equal(intake.displayName, 'December 2025')
    assert.equal(intake.datePrecision, 'month')
    assert.equal(intake.latestStartDate, null)
    assert.equal(intake.key, '2025-12')
  })

  it('does not expand a two-digit year', () => {
    assert.equal(parseMonthTitle('March 26'), null)
    assert.deepEqual(parseMonthTitle('March 2026'), { month: 3, year: 2026 })
    assert.deepEqual(parseMonthTitle(' Sept 2025 '), { month: 9, year: 2025 })
    assert.equal(parseMonthTitle('ELCE 25 & 26'), null)
  })

  it('keeps a title with no month verbatim', () => {
    const [intake] = groupBatchesIntoIntakes([ECEA])
    assert.equal(intake.key, 'elce-25-and-26')
  })

  it('formats dates without inventing anything', () => {
    assert.equal(formatIntakeDate('2025-03-17'), '17 Mar 2025')
    assert.equal(formatIntakeDate('not-a-date'), 'not-a-date')
  })

  it('keeps keys unique when two dated intakes share a day', () => {
    const twinA = batch({ id: 'a', name: 'A - Morning', startDate: '2025-03-17', legacySheetName: 'Sheet A' })
    const twinB = batch({ id: 'b', name: 'B - Morning', startDate: '2025-03-17', legacySheetName: 'Sheet B' })
    const intakes = groupBatchesIntoIntakes([twinA, twinB])
    assert.equal(new Set(intakes.map((intake) => intake.key)).size, 2)
  })
})

describe('ordering is most recent first, at the precision the source gives', () => {
  const all = [
    DECEMBER_EVENING,
    MARCH_MORNING,
    JULY_EVENING,
    JANUARY_MORNING,
    AUGUST_MORNING,
    JULY_MORNING,
    ECEA,
    MARCH_EVENING,
    DECEMBER_MORNING,
    AUGUST_EVENING,
    JANUARY_EVENING,
  ]

  it('places dated and month-titled intakes by what they state, and an undated title last', () => {
    const labels = groupBatchesIntoIntakes(all).map((intake) => intake.displayName)
    assert.deepEqual(labels, [
      '29 Jul 2026',
      'January 2026',
      'December 2025',
      '18 Aug 2025',
      '17 Mar 2025',
      'ELCE 25 & 26',
    ])
  })

  it('is deterministic regardless of input order', () => {
    const forward = groupBatchesIntoIntakes(all).map((intake) => intake.key)
    const backward = groupBatchesIntoIntakes([...all].reverse()).map((intake) => intake.key)
    assert.deepEqual(forward, backward)
  })

  it('orders Morning before Evening inside an intake', () => {
    const [intake] = groupBatchesIntoIntakes([JULY_EVENING, JULY_MORNING])
    assert.deepEqual(
      intake.batches.map((item) => item.session),
      ['Morning', 'Evening'],
    )
  })
})

describe('the default and requested intake', () => {
  const intakes = groupBatchesIntoIntakes([
    MARCH_MORNING,
    MARCH_EVENING,
    JULY_MORNING,
    JULY_EVENING,
    DECEMBER_MORNING,
    DECEMBER_EVENING,
  ])

  it('opens on the most recent dated intake and says so', () => {
    const result = chooseDefaultIntake(intakes)
    assert.equal(result.intake?.key, '2026-07-29')
    assert.match(result.note, /2026-07-29/)
    assert.match(result.note, /Morning and Evening/)
  })

  it('says when the most recent intake states only a month', () => {
    const result = chooseDefaultIntake(groupBatchesIntoIntakes([DECEMBER_MORNING, DECEMBER_EVENING]))
    assert.equal(result.intake?.key, '2025-12')
    assert.match(result.note, /states only a month/)
  })

  it('reports no intake rather than throwing when a program has none', () => {
    assert.equal(chooseDefaultIntake([]).intake, null)
  })

  it('honours a requested key', () => {
    assert.equal(resolveRequestedIntake(intakes, '2025-03-17').intake?.key, '2025-03-17')
  })

  it('falls back to the default, with an explanation, when the link is stale', () => {
    const result = resolveRequestedIntake(intakes, 'no-such-intake')
    assert.equal(result.intake?.key, '2026-07-29')
    assert.match(result.note, /not available for this program/i)
  })

  it('maps an old batch link to its intake and session', () => {
    const mapped = intakeForBatch(intakes, 'march-e')
    assert.equal(mapped?.intake.key, '2025-03-17')
    assert.equal(mapped?.session, 'Evening')
    assert.equal(intakeForBatch(intakes, 'nope'), null)
  })
})
