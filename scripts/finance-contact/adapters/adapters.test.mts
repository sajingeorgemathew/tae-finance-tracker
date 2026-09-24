import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isSensitiveHeading, normalizeHeading } from '../canonical.mts'
import {
  eceaFixtureWorkbook,
  financeShapedWorkbook,
  FIXTURE_ADDRESS,
  FIXTURE_DOB,
  FIXTURE_PASSWORD,
  pswFixtureWorkbook,
} from '../fixtures.mts'
import { sheetConserved } from '../table-scan.mts'

import { eceaAdapter, eceaSessionValue, recognizeEceaTitle } from './ecea.mts'
import { pswAdapter, recognizePswTitle } from './psw.mts'
import { identifyWorkbook } from './registry.mts'
import { parseTitleDate } from './title-date.mts'

/**
 * FINANCE-CONTACT-04B1 — two structurally different adapters on the one
 * generic scanner. The fixtures invent every value; only the layouts are real.
 */

describe('structural recognition', () => {
  it('assigns each fixture to exactly one adapter by sheet titles, not filename', () => {
    const psw = identifyWorkbook(pswFixtureWorkbook())
    assert.equal(psw.adapter?.id, 'psw-masterclass-list')
    assert.equal(psw.conflict, null)

    const ecea = identifyWorkbook(eceaFixtureWorkbook())
    assert.equal(ecea.adapter?.id, 'ecea-masterclass-list')
    assert.equal(ecea.conflict, null)
  })

  it('leaves a finance-shaped workbook unclaimed even though one sheet carries a PSW title', () => {
    const finance = identifyWorkbook(financeShapedWorkbook())
    assert.equal(finance.adapter, null)
    assert.equal(finance.conflict, null)
    assert.match(finance.verdicts.find((verdict) => verdict.adapterId === 'psw-masterclass-list')!.recognition.reason, /only 1 of 3/)
  })
})

describe('title reading', () => {
  it('reads PSW titles in every spelling the workbook uses', () => {
    assert.deepEqual(recognizePswTitle('PSW Morning Batch - 17th March 2025'), {
      text: 'PSW Morning Batch - 17th March 2025',
      intakeLabel: '17th March 2025',
      intakeDate: '2025-03-17',
      session: 'Morning',
    })
    assert.equal(recognizePswTitle('PSW Evening Batch - 06th October 2025')?.intakeDate, '2025-10-06')
    assert.equal(recognizePswTitle('PSW Morning Batch - January 12, 2026')?.intakeDate, '2026-01-12')
    assert.equal(recognizePswTitle('PSW Evening Batch - April 27,2026')?.intakeDate, '2026-04-27')
    assert.equal(recognizePswTitle('  PSW Morning Batch - June 1, 2026')?.session, 'Morning')
    assert.equal(recognizePswTitle('PSW Evening Batch - 1st Dec 2025')?.intakeDate, '2025-12-01')
    assert.equal(recognizePswTitle('Sr. No.'), null)
    assert.equal(recognizePswTitle('PLACEMENT'), null)
  })

  it('never expands a two-digit year or invents a day', () => {
    assert.deepEqual(parseTitleDate('March 26'), { isoDate: null, yearMonth: null })
    assert.deepEqual(parseTitleDate('Dec 2025'), { isoDate: null, yearMonth: '2025-12' })
    // An impossible day yields no date; the month and year it states survive as a label.
    assert.deepEqual(parseTitleDate('31st February 2026'), { isoDate: null, yearMonth: '2026-02' })
    assert.deepEqual(parseTitleDate('ELCE 25 & 26'), { isoDate: null, yearMonth: null })
  })

  it('reads ECEA titles, separating the cohort suffix from the year label', () => {
    assert.deepEqual(recognizeEceaTitle('Early Childhood Education Assistant (ECEA) Batch - 2025 & 26'), {
      text: 'Early Childhood Education Assistant (ECEA) Batch - 2025 & 26',
      intakeLabel: '2025 & 26',
      intakeDate: null,
      session: null,
    })
    assert.equal(recognizeEceaTitle('Early Childhood Education Assistant (ECEA) Batch - 2025 & 26 - Weekend Evening')?.session, 'Weekend Evening')
    assert.equal(recognizeEceaTitle('Early Childhood Education Assistant (ECEA) Batch - 2025 & 26 - Weekend Evening')?.intakeLabel, '2025 & 26')
    assert.equal(eceaSessionValue('WD'), 'Weekday')
    assert.equal(eceaSessionValue('wn'), 'Weekend')
    assert.equal(eceaSessionValue('paid'), 'paid')
    assert.equal(eceaSessionValue(''), null)
  })
})

describe('the allowlist', () => {
  it('refuses sensitive headings whatever an adapter map says', () => {
    for (const heading of ['Password ', 'YYYY/MM/DD', 'D.O.B', 'DOB (YYYY-MM-DD)', 'Address', 'WP', 'VENUE', 'Transcripts', 'NACC', 'Doc Status', 'SIN']) {
      assert.equal(isSensitiveHeading(normalizeHeading(heading)), true, heading)
    }
    for (const heading of ['Student ID ', 'First Name', 'Contact No.', 'Email', 'GRADUATED', 'WKND & WKD', 'START DATE']) {
      assert.equal(isSensitiveHeading(normalizeHeading(heading)), false, heading)
    }
  })
})

describe('PSW adapter', () => {
  const parsed = pswAdapter.parse(pswFixtureWorkbook(), 'psw-fixture.xlsx')

  it('stages one canonical row per source row, keeping Morning and Evening apart', () => {
    assert.equal(parsed.rows.length, 2 + 6 + 3 + 1 + 1)
    assert.equal(parsed.crossCheckRows.length, 0)
    const dec = parsed.rows.filter((row) => row.sourceSheet === 'Dec 1st')
    assert.deepEqual(
      dec.map((row) => row.session),
      ['Morning', 'Morning', 'Morning', 'Morning', 'Morning', 'Morning', 'Evening', 'Evening', 'Evening'],
    )
    assert.equal(dec[0].sourceTable, 'PSW Morning Batch - 01st Dec 2025')
    assert.equal(dec[6].sourceTable, 'PSW Evening Batch - 1st Dec 2025')
    assert.equal(dec[0].intakeDate, '2025-12-01')
    assert.equal(dec[0].programCode, 'PSW')
    assert.equal(dec[0].sourceRow, 3)
  })

  it('keeps the student number as text and preserves a leading zero', () => {
    const zero = parsed.rows.find((row) => row.firstName === 'Gamma')!
    assert.equal(zero.studentNumber, '0900004')
    assert.equal(typeof zero.studentNumber, 'string')
    const numeric = parsed.rows.find((row) => row.firstName === 'Alpha')!
    assert.equal(numeric.studentNumber, '900001')
  })

  it('stages a row with a name but no student number, for review', () => {
    const unnumbered = parsed.rows.find((row) => row.firstName === 'Delta')!
    assert.equal(unnumbered.studentNumber, null)
    assert.equal(unnumbered.emailNormalized, 'delta@example.test')
  })

  it('normalizes contacts for comparison while keeping the raw text', () => {
    const alpha = parsed.rows.find((row) => row.firstName === 'Alpha')!
    assert.equal(alpha.emailRaw, 'Alpha.Tester@Example.test')
    assert.equal(alpha.emailNormalized, 'alpha.tester@example.test')
    assert.equal(alpha.phoneRaw, '416-555-0001')
    assert.equal(alpha.phoneNormalized, '+14165550001')
    assert.equal(alpha.displayName, 'Alpha Tester')
    assert.equal(alpha.sourceStatus, 'GRADUATED')

    const bad = parsed.rows.find((row) => row.firstName === 'Epsilon')!
    assert.equal(bad.emailStatus, 'invalid')
    assert.equal(bad.phoneStatus, 'invalid')

    const none = parsed.rows.find((row) => row.firstName === 'Theta')!
    assert.equal(none.emailStatus, 'missing')
    assert.equal(none.phoneStatus, 'missing')
  })

  it('classifies every row of every sheet exactly once', () => {
    for (const sheet of parsed.sheets) assert.equal(sheetConserved(sheet), true, sheet.sheetName)
    const dec = parsed.sheets.find((sheet) => sheet.sheetName === 'Dec 1st')!
    assert.deepEqual(dec.counts, { title: 2, header: 2, student: 9, placeholder: 1, legend: 3, blank: 2, other: 0 })
    const sep = parsed.sheets.find((sheet) => sheet.sheetName === 'Sep 28th')!
    assert.equal(sep.counts.placeholder, 2)
    assert.equal(sep.counts.student, 2)
  })

  it('ignores the Password column and every other unmapped heading by name only', () => {
    assert.ok(parsed.ignoredHeadings.includes('Password'))
    assert.ok(parsed.sensitiveHeadings.includes('Password'))
    assert.ok(parsed.ignoredHeadings.includes('Address'))
    assert.ok(parsed.ignoredHeadings.includes('START DATE'))
    const everything = JSON.stringify(parsed)
    assert.equal(everything.includes(FIXTURE_PASSWORD), false)
    assert.equal(everything.includes(FIXTURE_DOB), false)
    assert.equal(everything.includes(FIXTURE_ADDRESS), false)
    assert.equal(everything.includes('Work Permit'), false)
    assert.equal(everything.includes('Refugee'), false)
    assert.equal(everything.includes('PGWP'), false)
  })

  it('does not map the placement START DATE as a per-row start date', () => {
    assert.ok(parsed.rows.every((row) => row.sourceStartDate === null))
  })

  it('reports one discovered intake per table with its stated session, and no session for an untitled table', () => {
    assert.equal(parsed.intakes.length, 6)
    // The fixture's March Evening table has no title cell, like the real
    // workbook's: it inherits the sheet's date and states no session.
    assert.match(parsed.notes.join('\n'), /17th March: table at row 10 has no title cell/)
    const untitled = parsed.rows.find((row) => row.sourceSheet === '17th March' && row.sourceRow === 11)!
    assert.equal(untitled.session, null)
    assert.equal(untitled.intakeDate, '2025-03-17')
    assert.deepEqual(
      parsed.intakes.map((intake) => [intake.sheetName, intake.intakeDate, intake.session, intake.studentRows]),
      [
        ['17th March', '2025-03-17', 'Morning', 1],
        ['17th March', '2025-03-17', null, 1],
        ['Dec 1st', '2025-12-01', 'Morning', 6],
        ['Dec 1st', '2025-12-01', 'Evening', 3],
        ['Sep 28th', '2026-09-28', 'Morning', 1],
        ['Sep 28th', '2026-09-28', 'Evening', 1],
      ],
    )
  })
})

describe('ECEA adapter', () => {
  const parsed = eceaAdapter.parse(eceaFixtureWorkbook(), 'ecea-fixture.xlsx')

  it('stages the master only and keeps subset rows for cross-checking', () => {
    assert.equal(parsed.rows.length, 5)
    assert.equal(parsed.crossCheckRows.length, 3 + 3)
    assert.ok(parsed.rows.every((row) => row.sourceSheet === 'Master-ECEA'))
    assert.ok(parsed.crossCheckRows.every((row) => row.sourceSheet !== 'Master-ECEA'))
  })

  it('reads the per-row session and course start date the master states', () => {
    const kappa = parsed.rows.find((row) => row.studentNumber === '910001')!
    assert.equal(kappa.session, 'Weekday')
    assert.equal(kappa.sourceStartDate, '2025-12-18')
    assert.equal(kappa.intakeLabel, '2025 & 26')
    assert.equal(kappa.intakeDate, null)
    assert.equal(kappa.sourceStatus, 'YES')
    const undated = parsed.rows.find((row) => row.studentNumber === '910006')!
    assert.equal(undated.sourceStartDate, null)
  })

  it('lets a row-level session column override the table title on subset sheets', () => {
    const weekendListed = parsed.crossCheckRows.find((row) => row.sourceSheet === 'ECEA-WEEKEND' && row.studentNumber === '910001')!
    assert.equal(weekendListed.session, 'Weekend')
    assert.equal(weekendListed.sourceTable, 'Early Childhood Education Assistant (ECEA) Batch - 2025 & 26 - Weekend Evening')
  })

  it('ignores DOB, immigration Status, END DATE and Address by name and leaks no value', () => {
    assert.deepEqual(parsed.ignoredHeadings, ['Address', 'DOB (YYYY-MM-DD)', 'END DATE', 'Status'])
    const everything = JSON.stringify(parsed)
    assert.equal(everything.includes(FIXTURE_DOB), false)
    assert.equal(everything.includes(FIXTURE_ADDRESS), false)
    assert.equal(everything.includes('Open Work Permit'), false)
    assert.equal(everything.includes('Dropped'), false)
  })

  it('conserves every row of every sheet', () => {
    for (const sheet of parsed.sheets) assert.equal(sheetConserved(sheet), true, sheet.sheetName)
    assert.deepEqual(parsed.intakes.map((intake) => intake.role), ['primary', 'cross_check', 'cross_check', 'cross_check', 'cross_check'])
  })
})
