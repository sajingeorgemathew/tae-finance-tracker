import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  cleanNamePart,
  isDigitsOnly,
  joinNameParts,
  nameComparisonKey,
  normalizeEmail,
  normalizePhone,
  normalizeStudentNumber,
} from './normalize.mts'

describe('normalizeStudentNumber', () => {
  it('trims whitespace and keeps the text exactly', () => {
    assert.equal(normalizeStudentNumber('  125001 '), '125001')
    assert.equal(normalizeStudentNumber('125001 '), '125001')
  })

  it('preserves leading zeroes and never coerces to a number', () => {
    assert.equal(normalizeStudentNumber('00125'), '00125')
    assert.equal(normalizeStudentNumber('0125001'), '0125001')
    assert.notEqual(normalizeStudentNumber('0125001'), String(Number('0125001')))
  })

  it('treats blank as missing', () => {
    assert.equal(normalizeStudentNumber(''), null)
    assert.equal(normalizeStudentNumber('   '), null)
    assert.equal(normalizeStudentNumber(null), null)
    assert.equal(normalizeStudentNumber(undefined), null)
  })

  it('reports whether a number is digits only without rejecting it', () => {
    assert.equal(isDigitsOnly('125001'), true)
    assert.equal(isDigitsOnly('125-001'), false)
    assert.equal(isDigitsOnly('ABC12'), false)
  })
})

describe('normalizeEmail', () => {
  it('trims and lower-cases for comparison, keeping the raw text', () => {
    const result = normalizeEmail('  Person.Name@Example.COM ')
    assert.equal(result.raw, '  Person.Name@Example.COM ')
    assert.equal(result.normalized, 'person.name@example.com')
    assert.equal(result.status, 'valid')
  })

  it('treats an empty string as missing', () => {
    assert.equal(normalizeEmail('').status, 'missing')
    assert.equal(normalizeEmail('   ').status, 'missing')
    assert.equal(normalizeEmail(null).status, 'missing')
  })

  it('classifies malformed addresses as invalid rather than repairing them', () => {
    for (const bad of ['nobody', 'nobody@', '@example.com', 'two words@example.com', 'a@b', 'a@@b.com', 'a@b.com c@d.com']) {
      const result = normalizeEmail(bad)
      assert.equal(result.status, 'invalid', bad)
      assert.equal(result.normalized, null, bad)
      assert.equal(result.raw, bad)
    }
  })

  it('does not guess a domain or correct a spelling', () => {
    assert.equal(normalizeEmail('person@gmial.com').normalized, 'person@gmial.com')
    assert.equal(normalizeEmail('person@gmail').status, 'invalid')
  })
})

describe('normalizePhone', () => {
  it('derives +1XXXXXXXXXX for a clearly valid ten-digit NANP number, keeping the raw value', () => {
    for (const written of ['4165550123', '416-555-0123', '(416) 555-0123', '416.555.0123', ' 416 555 0123 ']) {
      const result = normalizePhone(written)
      assert.equal(result.status, 'valid_nanp', written)
      assert.equal(result.normalized, '+14165550123', written)
      assert.equal(result.raw, written)
    }
  })

  it('accepts an eleven-digit number that states the 1 country code', () => {
    assert.equal(normalizePhone('1-416-555-0123').normalized, '+14165550123')
    assert.equal(normalizePhone('+1 416 555 0123').normalized, '+14165550123')
  })

  it('keeps an explicit international number as written, without assuming a country', () => {
    const result = normalizePhone('+44 20 7946 0958')
    assert.equal(result.status, 'international_explicit')
    assert.equal(result.normalized, '+442079460958')
  })

  it('leaves a number without a country code and a non-NANP length ambiguous', () => {
    const result = normalizePhone('84 868 141 627')
    assert.equal(result.status, 'ambiguous')
    assert.equal(result.normalized, null)
  })

  it('classifies too few digits as invalid', () => {
    const result = normalizePhone('437-933-236')
    assert.equal(result.status, 'invalid')
    assert.equal(result.normalized, null)
  })

  it('classifies letters and several numbers in one cell as invalid', () => {
    assert.equal(normalizePhone('call me 416-555-0123').status, 'invalid')
    assert.equal(normalizePhone('416-555-0123 / 647-555-0199').status, 'invalid')
    assert.equal(normalizePhone('416-555-0123 or 647-555-0199').status, 'invalid')
  })

  it('does not accept a ten-digit number whose area code starts with 0 or 1 as NANP', () => {
    assert.equal(normalizePhone('0165550123').status, 'ambiguous')
    assert.equal(normalizePhone('1165550123').status, 'ambiguous')
  })

  it('treats blank as missing', () => {
    assert.equal(normalizePhone('').status, 'missing')
    assert.equal(normalizePhone(null).status, 'missing')
  })
})

describe('names', () => {
  it('trims and collapses spaces but keeps spelling and case', () => {
    assert.equal(cleanNamePart('  MARY   anne '), 'MARY anne')
    assert.equal(cleanNamePart(''), null)
  })

  it('joins only the parts that exist', () => {
    assert.equal(joinNameParts('First', null, 'Last'), 'First Last')
    assert.equal(joinNameParts('First', 'Mid', 'Last'), 'First Mid Last')
    assert.equal(joinNameParts(null, '', null), null)
  })

  it('produces a comparison key that is only for reporting differences', () => {
    assert.equal(nameComparisonKey("O'Brien, Mary-Anne"), 'obrien maryanne')
    assert.equal(nameComparisonKey('  mary  ANNE '), 'mary anne')
    assert.equal(nameComparisonKey(null), null)
  })
})
