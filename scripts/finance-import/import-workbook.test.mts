/**
 * The apply gate at the command line.
 *
 * The rule this guards: an apply needs two independent signals, and anything
 * less runs the dry run. Not a warning, not a prompt — the dry run. A flag on
 * its own is one arrow-key through shell history away from writing historical
 * financial data to production, which is exactly the accident the second signal
 * exists to prevent.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { APPLY_ENV_VALUE, APPLY_ENV_VAR, parseArguments, resolveApplyGate } from './import-workbook.mts'

const CONFIRMED = { [APPLY_ENV_VAR]: APPLY_ENV_VALUE }

function gate(argv: string[], env: Record<string, string | undefined>) {
  return resolveApplyGate(parseArguments(argv), env)
}

describe('parseArguments', () => {
  it('recognises --apply', () => {
    assert.equal(parseArguments(['--apply']).apply, true)
  })

  it('reports anything else as unknown rather than ignoring it', () => {
    assert.deepEqual(parseArguments(['--force']).unknown, ['--force'])
  })

  it('has no --force to find', () => {
    // Stated as a test because its absence is the safety property: a completed
    // import of the same workbook is refused, and review is the way past that.
    assert.deepEqual(parseArguments(['--apply', '--force']).unknown, ['--force'])
  })
})

describe('an apply requires both signals', () => {
  it('authorises only with --apply and the environment confirmation', () => {
    assert.equal(gate(['--apply'], CONFIRMED).authorised, true)
  })

  it('refuses --apply on its own', () => {
    const result = gate(['--apply'], {})
    assert.equal(result.authorised, false)
    assert.equal(result.flagPresent, true)
    assert.equal(result.confirmationPresent, false)
    assert.match(result.reason, /running the dry run instead/)
  })

  it('refuses the environment confirmation on its own', () => {
    const result = gate([], CONFIRMED)
    assert.equal(result.authorised, false)
    assert.equal(result.flagPresent, false)
    assert.equal(result.confirmationPresent, true)
  })

  it('runs the dry run when neither is given', () => {
    const result = gate([], {})
    assert.equal(result.authorised, false)
    assert.match(result.reason, /dry run/)
  })

  it('requires the exact confirmation value', () => {
    for (const value of ['yes', 'Yes', 'true', '1', 'YES ', '']) {
      assert.equal(gate(['--apply'], { [APPLY_ENV_VAR]: value }).authorised, false, value)
    }
  })

  it('is not satisfied by a similarly named variable', () => {
    assert.equal(gate(['--apply'], { FINANCE_IMPORT_APPLY_CONFIRM: 'YES' }).authorised, false)
    assert.equal(gate(['--apply'], { APPLY: 'YES' }).authorised, false)
  })
})
