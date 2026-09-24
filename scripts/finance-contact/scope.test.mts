import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ContactImportRow } from './canonical.mts'
import { applyScope, decideScope, DEFAULT_SCOPE_CONFIG, type ScopeConfig } from './scope.mts'

const CONFIG: ScopeConfig = {
  operationalCutoff: '2025-12-01',
  operationalEnd: '2026-08-31',
  excludedFutureIntakes: [{ programCode: 'PSW', intakeDate: '2026-09-28', note: 'upcoming' }],
}

function row(overrides: Partial<ContactImportRow>): ContactImportRow {
  return {
    stagedRowId: 'X:sheet:1',
    sourceWorkbook: 'fixture.xlsx',
    sourceSheet: 'sheet',
    sourceTable: null,
    sourceRow: 1,
    programCode: 'PSW',
    studentNumber: '900001',
    studentNumberRaw: '900001',
    firstName: null,
    middleName: null,
    lastName: null,
    displayName: null,
    emailRaw: null,
    emailNormalized: null,
    emailStatus: 'missing',
    phoneRaw: null,
    phoneNormalized: null,
    phoneStatus: 'missing',
    intakeLabel: null,
    intakeDate: null,
    session: null,
    sourceStartDate: null,
    sourceStatus: null,
    inOperationalScope: true,
    exclusionReason: null,
    ...overrides,
  }
}

describe('decideScope', () => {
  it('excludes an intake before the cutoff as historical, not as an error', () => {
    const decision = decideScope(row({ intakeDate: '2025-10-06' }), 'intakeDate', CONFIG)
    assert.equal(decision.inOperationalScope, false)
    assert.equal(decision.exclusionReason, 'OUT_OF_SCOPE_HISTORICAL')
    assert.equal(decision.scopeDate, '2025-10-06')
  })

  it('includes the cutoff day itself', () => {
    const decision = decideScope(row({ intakeDate: '2025-12-01' }), 'intakeDate', CONFIG)
    assert.equal(decision.inOperationalScope, true)
    assert.equal(decision.exclusionReason, null)
  })

  it('excludes an explicitly listed upcoming intake as future', () => {
    const decision = decideScope(row({ intakeDate: '2026-09-28' }), 'intakeDate', CONFIG)
    assert.equal(decision.exclusionReason, 'OUT_OF_SCOPE_FUTURE')
  })

  it('excludes anything after the operational end as future, by configuration alone', () => {
    assert.equal(decideScope(row({ intakeDate: '2026-09-01' }), 'intakeDate', CONFIG).exclusionReason, 'OUT_OF_SCOPE_FUTURE')
    assert.equal(decideScope(row({ intakeDate: '2026-08-31' }), 'intakeDate', CONFIG).exclusionReason, null)
    const open: ScopeConfig = { ...CONFIG, operationalEnd: null, excludedFutureIntakes: [] }
    assert.equal(decideScope(row({ intakeDate: '2026-09-28' }), 'intakeDate', open).exclusionReason, null)
  })

  it('an explicit exclusion is program-specific', () => {
    const decision = decideScope(row({ programCode: 'ECEA', intakeDate: '2026-09-28' }), 'intakeDate', {
      ...CONFIG,
      operationalEnd: null,
    })
    assert.equal(decision.exclusionReason, null)
  })

  it('uses the per-row start date for a source whose tables are not intakes', () => {
    assert.equal(
      decideScope(row({ programCode: 'ECEA', sourceStartDate: '2025-01-08' }), 'sourceStartDate', CONFIG).exclusionReason,
      'OUT_OF_SCOPE_HISTORICAL',
    )
    assert.equal(
      decideScope(row({ programCode: 'ECEA', sourceStartDate: '2026-01-12' }), 'sourceStartDate', CONFIG).exclusionReason,
      null,
    )
  })

  it('falls back to the other date and keeps an undated row in scope, flagged', () => {
    assert.equal(decideScope(row({ intakeDate: null, sourceStartDate: '2025-05-12' }), 'intakeDate', CONFIG).exclusionReason, 'OUT_OF_SCOPE_HISTORICAL')
    const undated = decideScope(row({}), 'intakeDate', CONFIG)
    assert.equal(undated.inOperationalScope, true)
    assert.equal(undated.dateUnknown, true)
    assert.equal(undated.scopeDate, null)
  })
})

describe('applyScope', () => {
  it('marks every row in place and tallies the outcome', () => {
    const rows = [
      row({ stagedRowId: 'a', intakeDate: '2025-03-17' }),
      row({ stagedRowId: 'b', intakeDate: '2026-01-12' }),
      row({ stagedRowId: 'c', intakeDate: '2026-09-28' }),
      row({ stagedRowId: 'd' }),
    ]
    const result = applyScope(rows, 'intakeDate', CONFIG)
    assert.deepEqual(result.counts, { operational: 2, historical: 1, future: 1, dateUnknown: 1 })
    assert.deepEqual(result.dateUnknownRowIds, ['d'])
    assert.deepEqual(
      rows.map((item) => item.exclusionReason),
      ['OUT_OF_SCOPE_HISTORICAL', null, 'OUT_OF_SCOPE_FUTURE', null],
    )
    assert.equal(rows[0].inOperationalScope, false)
  })

  it('ships with the 04B1 scope: 1 Dec 2025 through August 2026, September 2026 excluded', () => {
    assert.equal(DEFAULT_SCOPE_CONFIG.operationalCutoff, '2025-12-01')
    assert.equal(DEFAULT_SCOPE_CONFIG.operationalEnd, '2026-08-31')
    assert.deepEqual(
      DEFAULT_SCOPE_CONFIG.excludedFutureIntakes.map((intake) => [intake.programCode, intake.intakeDate]),
      [['PSW', '2026-09-28']],
    )
  })
})
