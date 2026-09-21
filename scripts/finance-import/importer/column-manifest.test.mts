/**
 * The column manifest planner, against synthetic sheets.
 *
 * The real workbook is Git-ignored, so the rules are exercised on fixtures
 * built to the same shape: a PSW table whose ACTUAL span carries a month
 * nobody paid in, a Late Fees nobody incurred, a blank REMARKS, a blank
 * Payer, an unheaded outstanding column and a mistyped month; and an
 * ELCE-shaped flat roster whose Balance column is empty throughout.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { discoverBatchTables } from './batch-tables.mts'
import {
  findUnexpectedArtifactLiterals,
  manifestRoleFor,
  manifestValueKindFor,
  matchTableToBatch,
  planColumnManifest,
  planTableManifest,
  renderManifestMigration,
  type HostedBatchIdentity,
  type ManifestPlan,
} from './column-manifest.mts'
import { entityId, UUID_V5_PATTERN } from './deterministic-ids.mts'
import { BLANK, sheetFromRows } from './fixtures.mts'
import { batchFinanceColumnSourceKey, batchSourceKey } from './source-keys.mts'

import type { SupportedBatchTable } from './batch-tables.mts'
import type { WorkBook } from 'xlsx'

const HASH = '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2'

/** Names, numbers and amounts that must never reach an artifact. */
const STUDENT_NUMBERS = ['125001', '125002', '125003']
const STUDENT_NAMES = ['Asha', 'Rao', 'Bina', 'Shah', 'Chetan', 'Iyer']
const AMOUNTS = ['5000', '4000', '1500', '1400', '3500', '2600', '800']

/**
 * A PSW-shaped sheet with two tables.
 *
 * Columns:
 *   A Sr. No.  B Student ID  C First Name  D Last Name
 *   E Total Fee  F Payer  G Enroll. Fee  H May  I Marc  J October  K Late Fees
 *   L Total Paid  M (unheaded outstanding)  N REMARKS
 *   O Total Fee  P Enroll. Fee  Q May  R June
 *
 * October, Late Fees, REMARKS and Payer are blank on every student row, which
 * is exactly the case the manifest exists for. "Marc" is a mistyped March.
 */
function pswSheet(): ReturnType<typeof sheetFromRows> {
  const header = [
    'Sr. No. ',
    'Student ID ',
    'First Name ',
    'Last Name ',
    'Total Fee',
    'Payer',
    'Enroll. Fee',
    'May',
    'Marc',
    'October',
    'Late Fees',
    'Total Paid',
    BLANK,
    'REMARKS',
    'Total Fee',
    'Enroll. Fee',
    'May',
    'June',
  ]
  return sheetFromRows([
    ['PSW Morning Batch - 12th May 2025'],
    header,
    [
      1, 125001, 'Asha', 'Rao', 5000, BLANK, 500, 1000, BLANK, BLANK, BLANK,
      { f: 'SUM(G3:K3)', v: 1500 }, { f: 'L3-E3', v: -3500 }, BLANK,
      5000, 500, 1000, BLANK,
    ],
    [
      2, 125002, 'Bina', 'Shah', 4000, BLANK, 400, 800, 200, BLANK, BLANK,
      { f: 'SUM(G4:K4)', v: 1400 }, { f: 'L4-E4', v: -2600 }, BLANK,
      4000, 400, 800, 0,
    ],
    [BLANK, BLANK, BLANK, BLANK, 9000, BLANK, 900, 1800, 200, BLANK, BLANK, { f: 'SUM(L3:L4)', v: 2900 }, BLANK, BLANK, 9000, 900, 1800, 0],
    [],
    ['PSW Evening Batch - 12th May 2025'],
    header,
    [
      1, 125003, 'Chetan', 'Iyer', 5000, BLANK, 500, BLANK, BLANK, BLANK, BLANK,
      { f: 'SUM(G9:K9)', v: 500 }, { f: 'L9-E9', v: -4500 }, BLANK,
      5000, 500, 1000, 1000,
    ],
  ])
}

/**
 * An ELCE-shaped flat roster: no title, no ACTUAL/INSTALLMENT split, identity
 * and dates beside the figures, and a Balance column nobody filled in.
 */
function elceSheet(): ReturnType<typeof sheetFromRows> {
  return sheetFromRows([
    [],
    [],
    [
      'Sr. No. ',
      'Student ID ',
      'First Name ',
      'Last Name ',
      'Payee',
      'Total fees',
      'Enrollment fees',
      '1st Installment',
      'Late fees',
      'Total Paid',
      'Balance',
    ],
    [1, 125001, 'Asha', 'Rao', 'Self', 5000, 500, 1500, BLANK, 2000, BLANK],
    [2, 125002, 'Bina', 'Shah', 'Parent', 4000, 400, BLANK, BLANK, 400, BLANK],
  ])
}

function workbook(): WorkBook {
  return {
    SheetNames: ['12th May 2025', 'ELCE 25 & 26'],
    Sheets: { '12th May 2025': pswSheet(), 'ELCE 25 & 26': elceSheet() },
  } as unknown as WorkBook
}

/** Hosted batches exactly as the import would have created them. */
function hostedFor(tables: readonly SupportedBatchTable[]): HostedBatchIdentity[] {
  return tables.map(({ table, programShortCode }) => ({
    id: entityId(batchSourceKey(HASH, table.sheetName, table.key)),
    code: `${table.sheetName}!${table.key}`,
    legacySheetName: table.sheetName,
    programShortCode,
  }))
}

function planFixture(): { tables: SupportedBatchTable[]; plan: ManifestPlan } {
  const tables = discoverBatchTables(workbook()).supported
  return { tables, plan: planColumnManifest(HASH, tables, hostedFor(tables)) }
}

describe('discovering batch tables', () => {
  it('finds one table per detected block, never one per sheet', () => {
    const { supported } = discoverBatchTables(workbook())
    assert.deepEqual(
      supported.map((entry) => [entry.programShortCode, entry.table.sheetName, entry.table.key]),
      [
        ['PSW', '12th May 2025', 'title@1'],
        ['PSW', '12th May 2025', 'title@7'],
        ['ECEA', 'ELCE 25 & 26', 'header@3'],
      ],
    )
  })
})

describe('the ACTUAL section manifest', () => {
  it('takes the whole ACTUAL span of a split table, blank columns included', () => {
    const { tables } = planFixture()
    const rows = planTableManifest(HASH, tables[0]).filter((row) => row.section === 'actual')

    assert.deepEqual(
      rows.map((row) => [row.sourceColumnLetter, row.sourceHeader, row.displayOrder]),
      [
        ['E', 'Total Fee', 1],
        ['F', 'Payer', 2],
        ['G', 'Enroll. Fee', 3],
        ['H', 'May', 4],
        ['I', 'Marc', 5],
        ['J', 'October', 6],
        ['K', 'Late Fees', 7],
        ['L', 'Total Paid', 8],
        ['M', null, 9],
        ['N', 'REMARKS', 10],
      ],
    )
  })

  it('reports which columns every student left blank, without reading what they hold', () => {
    const { tables } = planFixture()
    const rows = planTableManifest(HASH, tables[0])

    const blank = rows.filter((row) => row.allBlankInSource).map((row) => row.sourceHeader)
    assert.deepEqual(blank, ['Payer', 'October', 'Late Fees', 'REMARKS'])

    // A column with a value on some row is not blank, and the value itself is
    // never carried on the planned row.
    const may = rows.find((row) => row.sourceHeader === 'May' && row.section === 'actual')
    assert.equal(may?.allBlankInSource, false)
    assert.ok(!('value' in (may ?? {})))
  })

  it('keeps text columns in the manifest and out of the money grid', () => {
    const { tables } = planFixture()
    const rows = planTableManifest(HASH, tables[0])

    const remarks = rows.find((row) => row.sourceHeader === 'REMARKS')
    const payer = rows.find((row) => row.sourceHeader === 'Payer')
    for (const row of [remarks, payer]) {
      assert.ok(row)
      assert.equal(row.section, 'actual')
      assert.equal(row.valueKind, 'text')
      assert.equal(row.isGridVisible, false)
      assert.equal(row.displayEvenIfBlank, true)
    }
    assert.equal(remarks?.normalizedRole, 'remarks')
    assert.equal(payer?.normalizedRole, 'payer')
  })

  it('keeps money columns visible even when every student left them blank', () => {
    const { tables } = planFixture()
    const rows = planTableManifest(HASH, tables[0])

    for (const header of ['October', 'Late Fees']) {
      const row = rows.find((entry) => entry.sourceHeader === header && entry.section === 'actual')
      assert.ok(row, header)
      assert.equal(row.allBlankInSource, true)
      assert.equal(row.valueKind, 'money')
      assert.equal(row.isGridVisible, true)
      assert.equal(row.displayEvenIfBlank, true)
    }
  })

  it('preserves a mistyped heading verbatim and does not guess its meaning', () => {
    const { tables } = planFixture()
    const marc = planTableManifest(HASH, tables[0]).find((row) => row.sourceColumnLetter === 'I')
    assert.equal(marc?.sourceHeader, 'Marc')
    assert.equal(marc?.normalizedRole, 'other')
    assert.equal(marc?.valueKind, 'money')
  })

  it('preserves an unheaded column by its letter, as money, with no invented heading', () => {
    const { tables } = planFixture()
    const unheaded = planTableManifest(HASH, tables[0]).find((row) => row.sourceColumnLetter === 'M')
    assert.equal(unheaded?.sourceHeader, null)
    assert.equal(unheaded?.normalizedRole, 'other')
    assert.equal(unheaded?.valueKind, 'money')
    assert.equal(unheaded?.isGridVisible, true)
    assert.equal(unheaded?.columnKey, 'actual:M')
  })

  it('takes only money-headed columns of a flat roster, so Payee and dates stay out', () => {
    const { tables } = planFixture()
    const rows = planTableManifest(HASH, tables[2])

    assert.deepEqual(
      rows.map((row) => [row.section, row.sourceHeader, row.normalizedRole]),
      [
        ['actual', 'Total fees', 'total_fee'],
        ['actual', 'Enrollment fees', 'enrollment'],
        ['actual', '1st Installment', 'installment'],
        ['actual', 'Late fees', 'late_fees'],
        ['actual', 'Total Paid', 'total_paid'],
        ['actual', 'Balance', 'balance'],
      ],
    )
    assert.equal(rows.some((row) => row.section === 'installment'), false)
  })

  it('restores the ELCE Balance column structurally, blank throughout', () => {
    const { tables } = planFixture()
    const balance = planTableManifest(HASH, tables[2]).find((row) => row.sourceHeader === 'Balance')
    assert.ok(balance)
    assert.equal(balance.allBlankInSource, true)
    assert.equal(balance.isGridVisible, true)
    assert.equal(balance.valueKind, 'money')
  })
})

describe('the INSTALLMENT section manifest', () => {
  it('numbers schedule columns exactly as the installment planner does', () => {
    const { tables } = planFixture()
    const rows = planTableManifest(HASH, tables[0]).filter((row) => row.section === 'installment')

    // The schedule's own Total Fee (O) is not an instalment and is not listed.
    assert.deepEqual(
      rows.map((row) => [row.sourceColumnLetter, row.sourceHeader, row.displayOrder, row.normalizedRole]),
      [
        ['P', 'Enroll. Fee', 1, 'enrollment'],
        ['Q', 'May', 2, 'month'],
        ['R', 'June', 3, 'month'],
      ],
    )
  })

  it('describes structure only: a blank schedule cell plans no row of any kind', () => {
    const { plan } = planFixture()
    // Nothing in the plan is keyed by a student row.
    for (const row of plan.rows) {
      assert.ok(!('row' in row))
      assert.ok(!('studentNumber' in row))
      assert.ok(!('amount' in row))
    }
    assert.equal(plan.counts.allBlankInstallmentRows, 0)
  })
})

describe('roles and value kinds', () => {
  it('maps importer roles to manifest roles and leaves the rest as other', () => {
    assert.equal(manifestRoleFor('outstanding'), 'balance')
    assert.equal(manifestRoleFor('enrollment_fee'), 'enrollment')
    assert.equal(manifestRoleFor('installment_ordinal'), 'installment')
    assert.equal(manifestRoleFor('unknown'), 'other')
    assert.equal(manifestRoleFor('graduated'), 'other')
  })

  it('reads text roles as text even inside the money span', () => {
    assert.equal(manifestValueKindFor('remarks'), 'text')
    assert.equal(manifestValueKindFor('payer'), 'text')
    assert.equal(manifestValueKindFor('month'), 'money')
    assert.equal(manifestValueKindFor('unknown'), 'money')
  })
})

describe('matching tables to hosted batches', () => {
  it('matches on deterministic id and code together', () => {
    const { tables } = planFixture()
    const match = matchTableToBatch(HASH, tables[0], hostedFor(tables))
    assert.equal(match.match.status, 'matched')
  })

  it('never matches a batch by name, title or date: nothing to match on means unmatched', () => {
    const { tables } = planFixture()
    const lookalike: HostedBatchIdentity = {
      id: '00000000-0000-5000-8000-000000000000',
      code: null,
      legacySheetName: '12th May 2025',
      programShortCode: 'PSW',
    }
    const match = matchTableToBatch(HASH, tables[0], [lookalike])
    assert.equal(match.match.status, 'unmatched')
  })

  it('refuses a partial match rather than taking it', () => {
    const { tables } = planFixture()
    const [hosted] = hostedFor(tables)
    const match = matchTableToBatch(HASH, tables[0], [{ ...hosted, programShortCode: 'ECEA' }])
    assert.equal(match.match.status, 'ambiguous')
    assert.match((match.match as { reason: string }).reason, /program/)
  })

  it('refuses two candidates', () => {
    const { tables } = planFixture()
    const [hosted] = hostedFor(tables)
    const match = matchTableToBatch(HASH, tables[0], [
      hosted,
      { ...hosted, id: '00000000-0000-5000-8000-000000000000' },
    ])
    assert.equal(match.match.status, 'ambiguous')
  })

  it('a single unmatched table blocks the whole plan; nothing partial is planned', () => {
    const { tables } = planFixture()
    const hosted = hostedFor(tables).slice(0, 2)
    const plan = planColumnManifest(HASH, tables, hosted)
    assert.equal(plan.counts.matchedBatches, 2)
    assert.equal(plan.counts.unmatchedTables, 1)
    assert.ok(plan.blockers.length > 0)
    assert.throws(() => renderManifestMigration(plan, { regenerateCommand: 'x' }), /blocked/)
  })
})

describe('the whole plan', () => {
  it('counts what the audit counted', () => {
    const { plan } = planFixture()
    assert.equal(plan.counts.sourceBatchTables, 3)
    assert.equal(plan.counts.matchedBatches, 3)
    assert.equal(plan.counts.ambiguousMappings, 0)
    assert.equal(plan.counts.unmatchedTables, 0)
    // 10 + 10 actual on the PSW tables, 6 on the roster; 3 + 3 installment.
    assert.equal(plan.counts.actualRows, 26)
    assert.equal(plan.counts.installmentRows, 6)
    assert.equal(plan.counts.rows, 32)
    assert.equal(plan.counts.hiddenTextRows, 4)
    assert.equal(plan.counts.gridVisibleRows, 28)
    // Morning: October, Late Fees. Evening: May, Marc, October, Late Fees. Roster: Late fees, Balance.
    assert.equal(plan.counts.allBlankVisibleRows, 8)
    assert.equal(plan.counts.allBlankHiddenRows, 4)
    assert.equal(plan.counts.allBlankInstallmentRows, 0)
    assert.equal(plan.counts.batchesWithAllBlankColumns, 3)
    assert.deepEqual(plan.blockers, [])
  })

  it('is deterministic: the same workbook gives the same plan and the same artifact', () => {
    const first = planFixture().plan
    const second = planFixture().plan
    assert.deepEqual(first, second)

    const options = { regenerateCommand: 'npm run finance:manifest -- --write-migration' }
    assert.equal(renderManifestMigration(first, options), renderManifestMigration(second, options))
  })

  it('derives every id from the source key, in the importer namespace', () => {
    const { plan } = planFixture()
    for (const row of plan.rows) {
      assert.match(row.id, UUID_V5_PATTERN)
      assert.equal(
        row.id,
        entityId(
          batchFinanceColumnSourceKey(
            HASH,
            row.legacySheetName,
            row.legacyTableKey,
            row.section,
            row.sourceColumnLetter,
          ),
        ),
      )
    }
    assert.equal(new Set(plan.rows.map((row) => row.id)).size, plan.rows.length)
  })

  it('pins the derivation: changing it would re-key every manifest row', () => {
    // Column I ("March") of the first table on the 17th March 2025 sheet, as
    // written into the historical migration.
    assert.equal(
      entityId(batchFinanceColumnSourceKey(HASH, '17th March 2025', 'title@1', 'actual', 'I')),
      '203d2db3-b16a-56c3-9e09-ca4c74253d46',
    )
  })

  it('orders rows stably: program, batch code, section, position', () => {
    const { plan } = planFixture()
    const sql = renderManifestMigration(plan, { regenerateCommand: 'x' })
    const codes = [...sql.matchAll(/^  \('[^']+', '[^']+', '([^']+)', '([^']+)'/gm)].map(
      (match) => `${match[1]} ${match[2]}`,
    )
    const sorted = codes.slice().sort((a, b) => {
      const [codeA, sectionA] = a.split(' ')
      const [codeB, sectionB] = b.split(' ')
      return codeA.localeCompare(codeB) || sectionA.localeCompare(sectionB)
    })
    // ECEA sorts before PSW by program, and the tuples within a batch keep
    // section order; the exact order is what the rendered artifact commits to.
    assert.equal(codes[0], 'ELCE 25 & 26!header@3 actual')
    assert.deepEqual(
      codes.slice(6),
      sorted.filter((entry) => entry.startsWith('12th May')),
    )
  })
})

describe('nothing identifying reaches the artifact', () => {
  it('contains no student number, name or amount from the sheets it was built from', () => {
    const { plan } = planFixture()
    const sql = renderManifestMigration(plan, { regenerateCommand: 'x' })

    for (const value of [...STUDENT_NUMBERS, ...STUDENT_NAMES]) {
      assert.equal(sql.includes(value), false, `${value} must not appear`)
    }
    // Amounts are checked as literals, not substrings: "5000" could sit
    // inside a uuid. The tuples carry no numeric literal but display_order.
    for (const value of AMOUNTS) {
      assert.equal(new RegExp(`[(, ]${value}[,)]`).test(sql), false, `${value} must not appear`)
    }
  })

  it('every string literal in the VALUES block is a layout value the plan accounts for', () => {
    const { plan } = planFixture()
    const sql = renderManifestMigration(plan, { regenerateCommand: 'x' })
    assert.deepEqual(findUnexpectedArtifactLiterals(sql, plan), [])
  })

  it('the whitelist catches a literal that is not layout', () => {
    const { plan } = planFixture()
    const sql = renderManifestMigration(plan, { regenerateCommand: 'x' }).replace(
      "'REMARKS'",
      "'Asha Rao'",
    )
    assert.deepEqual(findUnexpectedArtifactLiterals(sql, plan), ['Asha Rao'])
  })

  it('the private plan JSON carries no cell values either', () => {
    const { plan } = planFixture()
    const json = JSON.stringify(plan)
    for (const value of [...STUDENT_NAMES, ...STUDENT_NUMBERS]) {
      assert.equal(json.includes(value), false, `${value} must not appear`)
    }
  })
})

describe('the rendered migration', () => {
  it('inserts through a join on batch id and code, and converges on conflict', () => {
    const { plan } = planFixture()
    const sql = renderManifestMigration(plan, { regenerateCommand: 'x' })
    assert.match(sql, /insert into public\.batch_finance_columns \(id, batch_id, section/)
    assert.match(sql, /join public\.batches b on b\.id = v\.batch_id::uuid and b\.code = v\.batch_code/)
    assert.match(sql, /on conflict \(id\) do nothing;/)
    assert.match(sql, /GENERATED FILE/)
    assert.equal((sql.match(/^  \('/gm) ?? []).length, plan.counts.rows)
  })

  it('escapes a heading with a quote in it', () => {
    const { plan } = planFixture()
    const row = plan.rows[0]
    const altered: ManifestPlan = {
      ...plan,
      rows: [{ ...row, sourceHeader: "Vikas' Remarks" }],
    }
    const sql = renderManifestMigration(altered, { regenerateCommand: 'x' })
    assert.ok(sql.includes("'Vikas'' Remarks'"))
    assert.deepEqual(findUnexpectedArtifactLiterals(sql, altered), [])
  })
})
