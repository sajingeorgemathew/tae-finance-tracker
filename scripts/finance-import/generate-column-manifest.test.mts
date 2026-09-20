/**
 * The generator's committed output, and — when the workbook is present — the
 * full historical plan it is regenerated from.
 *
 * Two layers, because the workbook is Git-ignored and absent on most machines:
 *
 *  1. **Always**: the committed data migration is structurally what the
 *     renderer writes — its header states a row count that matches its
 *     tuples, it names the approved workbook hash, and its literals fit the
 *     layout vocabulary and nothing else.
 *  2. **With the approved workbook on disk**: the plan is rebuilt from it,
 *     matched against hosted batch identities *derived* from the workbook (no
 *     database in a test), and must reproduce the audit's counts and render
 *     byte-for-byte to the committed migration. That is `--check`, as a test.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { MANIFEST_MIGRATION_PATH } from './generate-column-manifest.mts'
import { APPROVED_WORKBOOK_SHA256 } from './importer/apply-preflight.mts'
import { discoverBatchTables } from './importer/batch-tables.mts'
import {
  findUnexpectedArtifactLiterals,
  planColumnManifest,
  renderManifestMigration,
  type HostedBatchIdentity,
} from './importer/column-manifest.mts'
import { entityId } from './importer/deterministic-ids.mts'
import { batchSourceKey } from './importer/source-keys.mts'
import { findWorkbookCandidates, openWorkbook } from './lib/workbook-source.mts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const migrationPath = path.join(repoRoot, MANIFEST_MIGRATION_PATH)

function committedMigration(): string {
  return readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n')
}

/** The approved workbook, or null when it is absent or is a different file. */
function approvedWorkbook() {
  if (!existsSync(path.join(repoRoot, 'reference'))) return null
  if (findWorkbookCandidates(repoRoot).length !== 1) return null
  const source = openWorkbook(repoRoot, new Date(0))
  return source.fingerprint.sha256 === APPROVED_WORKBOOK_SHA256 ? source : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const LETTER = /^[A-Z]{1,3}$/
const BATCH_CODE = /^[^!]+!(title|header)@\d+$/
const TABLE_KEY = /^(title|header)@\d+$/
const COLUMN_KEY = /^(actual|installment):[A-Z]{1,3}$/
const VOCAB = new Set([
  'actual',
  'installment',
  'money',
  'text',
  'legacy_workbook',
  'student_number',
  'student_name',
  'enrollment',
  'month',
  'late_fees',
  'total_fee',
  'total_paid',
  'balance',
  'discount',
  'other',
  'remarks',
  'payer',
])

describe('the committed historical manifest migration', () => {
  it('exists, is marked generated, and names the approved workbook', () => {
    const sql = committedMigration()
    assert.match(sql, /GENERATED FILE\. Do not edit by hand/)
    assert.ok(sql.includes(`Source workbook SHA-256: ${APPROVED_WORKBOOK_SHA256}`))
  })

  it('states a row count that matches its tuples', () => {
    const sql = committedMigration()
    const stated = /rows: (\d+) \(actual (\d+), installment (\d+)/.exec(sql)
    assert.ok(stated)
    const tuples = sql.match(/^  \('/gm) ?? []
    assert.equal(tuples.length, Number(stated[1]))
    assert.equal(Number(stated[2]) + Number(stated[3]), Number(stated[1]))
  })

  it('carries only layout literals: ids, batch codes, letters, headings, vocabulary', () => {
    const sql = committedMigration()
    const start = sql.indexOf('from (values')
    const end = sql.indexOf(') as v(')
    const block = sql.slice(start, end)

    const literals = [...block.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1])
    assert.ok(literals.length > 0)

    const headings = new Set<string>()
    for (const literal of literals) {
      if (UUID.test(literal) || HASH.test(literal) || LETTER.test(literal)) continue
      if (BATCH_CODE.test(literal) || TABLE_KEY.test(literal) || COLUMN_KEY.test(literal)) continue
      if (VOCAB.has(literal)) continue
      headings.add(literal)
    }

    // What is left is column headings and sheet names. None may look like a
    // student number (six digits) or carry a currency amount.
    for (const heading of headings) {
      assert.doesNotMatch(heading, /\d{5,}/, `${JSON.stringify(heading)} looks like an identifier`)
      assert.doesNotMatch(heading, /\$\s*\d/, `${JSON.stringify(heading)} looks like an amount`)
      assert.ok(heading.length <= 40, `${JSON.stringify(heading)} is too long for a heading`)
    }
  })

  it('has no delete, update or truncate statement', () => {
    const sql = committedMigration().toLowerCase()
    for (const forbidden of ['delete ', 'update ', 'truncate ', 'drop ', 'alter ']) {
      assert.equal(sql.includes(forbidden), false, `contains ${forbidden.trim()}`)
    }
  })
})

describe('regenerated from the approved workbook', () => {
  const source = approvedWorkbook()

  it('reproduces the audit and the committed migration', { skip: source === null && 'approved workbook not present' }, () => {
    assert.ok(source)
    const discovery = discoverBatchTables(source.workbook)

    // Hosted identities as the import created them. A test has no database,
    // and the import's ids are deterministic, so they are derived here — the
    // generator itself reads the real ones back and requires both to agree.
    const hosted: HostedBatchIdentity[] = discovery.supported.map(({ table, programShortCode }) => ({
      id: entityId(batchSourceKey(source.fingerprint.sha256, table.sheetName, table.key)),
      code: `${table.sheetName}!${table.key}`,
      legacySheetName: table.sheetName,
      programShortCode,
    }))

    const plan = planColumnManifest(source.fingerprint.sha256, discovery.supported, hosted)

    assert.deepEqual(plan.blockers, [])
    assert.equal(plan.counts.sourceBatchTables, 23)
    assert.equal(plan.counts.matchedBatches, 23)
    assert.equal(plan.counts.ambiguousMappings, 0)
    assert.equal(plan.counts.unmatchedTables, 0)
    assert.equal(plan.counts.actualRows, 251)
    assert.equal(plan.counts.installmentRows, 132)
    assert.equal(plan.counts.rows, 383)
    assert.equal(plan.counts.gridVisibleRows, 377)
    assert.equal(plan.counts.hiddenTextRows, 6)
    // The 21 all-blank ACTUAL columns the row-union grid lost: 15 money, 6 text.
    assert.equal(plan.counts.allBlankVisibleRows + plan.counts.allBlankHiddenRows, 21)
    assert.equal(plan.counts.allBlankVisibleRows, 15)
    assert.equal(plan.counts.allBlankHiddenRows, 6)
    assert.equal(plan.counts.allBlankInstallmentRows, 0)
    assert.equal(plan.counts.batchesWithAllBlankColumns, 14)

    const restoredByRole: Record<string, number> = {}
    for (const column of plan.restoredColumns) {
      restoredByRole[column.role] = (restoredByRole[column.role] ?? 0) + 1
    }
    assert.deepEqual(restoredByRole, { month: 8, late_fees: 6, balance: 1 })

    const hidden = plan.rows.filter((row) => !row.isGridVisible)
    assert.deepEqual(
      hidden.map((row) => row.normalizedRole).sort(),
      ['payer', 'payer', 'remarks', 'remarks', 'remarks', 'remarks'],
    )
    assert.ok(hidden.every((row) => row.valueKind === 'text' && row.section === 'actual'))

    // The ELCE Balance column exists structurally and was blank throughout.
    const elceBalance = plan.rows.find(
      (row) => row.programShortCode === 'ECEA' && row.normalizedRole === 'balance',
    )
    assert.ok(elceBalance)
    assert.equal(elceBalance.allBlankInSource, true)
    assert.equal(elceBalance.isGridVisible, true)

    // A mistyped heading survives verbatim.
    assert.ok(plan.rows.some((row) => row.sourceHeader === 'Marc' && row.normalizedRole === 'other'))

    // And the committed migration is exactly what this plan renders.
    const sql = renderManifestMigration(plan, {
      regenerateCommand: 'npm run finance:manifest -- --write-migration',
    })
    assert.deepEqual(findUnexpectedArtifactLiterals(sql, plan), [])
    assert.equal(committedMigration(), sql)
  })
})
