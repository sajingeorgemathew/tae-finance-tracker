/**
 * The regeneration entry point reads a recorded apply. What it refuses to read
 * is the point: the apply happened once, so the recorded result is the only
 * evidence the report has, and a report rendered from a damaged or partial
 * record would look exactly as authoritative as a correct one.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseRecordedApply } from './regenerate-apply-report.mts'

const RECORDED = {
  result: {
    importBatchId: '630f8106-4218-5989-90b9-c674de0a60f6',
    importType: 'finance_workbook',
    status: 'completed',
    workbookSha256: '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2',
  },
  rls: { attempted: true },
  workbookUnchanged: true,
  appliedAt: '2026-09-18T23:26:33.899Z',
}

function recorded(mutate: (value: Record<string, unknown>) => void = () => {}): string {
  const value = structuredClone(RECORDED) as Record<string, unknown>
  mutate(value)
  return JSON.stringify(value)
}

describe('parseRecordedApply', () => {
  it('reads the identifiers the report will state', () => {
    const parsed = parseRecordedApply(recorded())
    assert.equal(parsed.result.importBatchId, RECORDED.result.importBatchId)
    assert.equal(parsed.result.importType, 'finance_workbook')
    assert.equal(parsed.appliedAt, RECORDED.appliedAt)
  })

  it('refuses a record with no import batch ID', () => {
    assert.throws(
      () => parseRecordedApply(recorded((value) => {
        delete (value.result as Record<string, unknown>).importBatchId
      })),
      /no import batch ID/,
    )
  })

  it('refuses a record with no import_type', () => {
    assert.throws(
      () => parseRecordedApply(recorded((value) => {
        delete (value.result as Record<string, unknown>).importType
      })),
      /no import_type/,
    )
  })

  it('refuses a record with no workbook hash', () => {
    assert.throws(
      () => parseRecordedApply(recorded((value) => {
        delete (value.result as Record<string, unknown>).workbookSha256
      })),
      /no workbook SHA-256/,
    )
  })

  it('refuses a record with no usable applied-at timestamp', () => {
    assert.throws(() => parseRecordedApply(recorded((value) => { value.appliedAt = 'whenever' })), /appliedAt/)
  })

  it('refuses a record with no RLS verification', () => {
    assert.throws(() => parseRecordedApply(recorded((value) => { delete value.rls })), /rls/)
  })

  it('treats a missing workbookUnchanged as not proven, never as yes', () => {
    const parsed = parseRecordedApply(recorded((value) => { delete value.workbookUnchanged }))
    assert.equal(parsed.workbookUnchanged, false)
  })
})
