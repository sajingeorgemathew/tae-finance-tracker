import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { planStudents } from './students.mts'

import type { StudentObservation } from './students.mts'

const HASH = '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2'

function master(row: number, studentNumber: string | null, fullName: string | null): StudentObservation {
  return {
    origin: 'tracker_master',
    sheetName: 'Tracker Master',
    tableKey: null,
    row,
    order: 0,
    studentNumber,
    firstName: null,
    middleName: null,
    lastName: null,
    fullName,
  }
}

function batch(
  sheetName: string,
  row: number,
  studentNumber: string | null,
  firstName: string | null,
  lastName: string | null,
  order = 1,
): StudentObservation {
  return {
    origin: 'batch_table',
    sheetName,
    tableKey: 'title@1',
    row,
    order,
    studentNumber,
    firstName,
    middleName: null,
    lastName,
    fullName: null,
  }
}

describe('one exact student number is one student', () => {
  it('collapses every source row for a number into a single student', () => {
    const plan = planStudents(HASH, [
      master(2, '125001', 'Asha Rao'),
      master(3, '125001', 'Asha Rao'),
      batch('Dec 2025', 5, '125001', 'Asha', 'Rao'),
    ])

    assert.equal(plan.students.length, 1)
    assert.equal(plan.students[0].studentNumber, '125001')
    assert.equal(plan.students[0].observations.length, 3)
  })

  it('never merges two different numbers, however alike the names', () => {
    const plan = planStudents(HASH, [
      master(2, '125001', 'Gurleen Kaur'),
      master(3, '125002', 'Gurleen Kaur'),
    ])

    assert.equal(plan.students.length, 2)
  })

  it('does not split a number that carries two spellings', () => {
    const plan = planStudents(HASH, [
      master(2, '125001', 'Asha Rao'),
      master(3, '125001', 'Aasha Rao'),
    ])

    assert.equal(plan.students.length, 1)
    assert.equal(plan.students[0].hasNameConflict, true)
    assert.equal(plan.nameConflicts.length, 1)
  })

  it('stores a student number as text, exactly as given', () => {
    const plan = planStudents(HASH, [master(2, '012345', 'Leading Zero')])
    assert.equal(plan.students[0].studentNumber, '012345')
  })
})

describe('the canonical display name follows the approved priority', () => {
  it('prefers the Tracker Master name over a batch-sheet name', () => {
    const plan = planStudents(HASH, [
      batch('Dec 2025', 5, '125001', 'Asha', 'Rao'),
      master(2, '125001', 'Asha R. Rao'),
    ])

    assert.equal(plan.students[0].legacyDisplayName, 'Asha R. Rao')
    assert.match(plan.students[0].displayNameSource, /Tracker Master row 2/)
  })

  it('falls back to the batch-sheet name when Tracker Master has none', () => {
    const plan = planStudents(HASH, [batch('Dec 2025', 5, '125001', 'Asha', 'Rao')])

    assert.equal(plan.students[0].legacyDisplayName, 'Asha Rao')
    assert.match(plan.students[0].displayNameSource, /Dec 2025 row 5/)
  })

  it('keeps every alternate spelling rather than discarding the losers', () => {
    const plan = planStudents(HASH, [
      master(2, '125001', 'Asha R. Rao'),
      batch('Dec 2025', 5, '125001', 'Asha', 'Rao'),
      batch('Jan 2026', 9, '125001', 'Aasha', 'Rao', 2),
    ])

    const values = plan.students[0].nameVariants.map((variant) => variant.value).sort()
    assert.deepEqual(values, ['Aasha Rao', 'Asha R. Rao', 'Asha Rao'])
    // And they survive into the column the migration adds for exactly this.
    assert.equal(
      (plan.students[0].legacyRawJson.name_variants as unknown[]).length,
      3,
    )
  })

  it('does not depend on the order observations arrive in', () => {
    const observations = [
      batch('Jan 2026', 9, '125001', 'Aasha', 'Rao', 2),
      master(2, '125001', 'Asha R. Rao'),
      batch('Dec 2025', 5, '125001', 'Asha', 'Rao'),
    ]

    const forward = planStudents(HASH, observations)
    const reversed = planStudents(HASH, [...observations].reverse())

    assert.equal(forward.students[0].legacyDisplayName, reversed.students[0].legacyDisplayName)
    assert.equal(forward.students[0].sourceKey, reversed.students[0].sourceKey)
  })
})

describe('name parts are set only where the sources agree', () => {
  it('sets them when every source that states them agrees', () => {
    const plan = planStudents(HASH, [
      batch('Dec 2025', 5, '125001', 'Asha', 'Rao'),
      batch('Jan 2026', 9, '125001', 'Asha', 'Rao', 2),
    ])

    assert.equal(plan.students[0].firstName, 'Asha')
    assert.equal(plan.students[0].lastName, 'Rao')
  })

  it('leaves them null rather than picking one sheet over another', () => {
    const plan = planStudents(HASH, [
      batch('Dec 2025', 5, '125001', 'Asha', 'Rao'),
      batch('Jan 2026', 9, '125001', 'Aasha', 'Rao', 2),
    ])

    assert.equal(plan.students[0].firstName, null)
    assert.equal(plan.students[0].lastName, null)
    // The full name still reaches legacy_name, so nothing is lost.
    assert.equal(plan.students[0].legacyDisplayName, 'Asha Rao')
  })
})

describe('a conflict within one sheet is distinguished from one between sheets', () => {
  it('flags two spellings written into the same sheet', () => {
    const plan = planStudents(HASH, [
      batch('Dec 2025', 5, '125001', 'Asha', 'Rao'),
      batch('Dec 2025', 6, '125001', 'Aasha', 'Rao'),
    ])

    assert.equal(plan.nameConflicts[0].withinOneSheet, true)
  })

  it('does not flag a difference that is only between sheets', () => {
    // Tracker Master holds one name column and the batch sheets hold two, so
    // these rarely reduce to the same string even for one person.
    const plan = planStudents(HASH, [
      master(2, '125001', 'Asha R. Rao'),
      batch('Dec 2025', 5, '125001', 'Asha', 'Rao'),
    ])

    assert.equal(plan.nameConflicts[0].withinOneSheet, false)
  })
})

describe('rows with no student number', () => {
  it('creates one unresolved student per source row', () => {
    const plan = planStudents(HASH, [
      master(2, null, 'No Number One'),
      master(3, null, 'No Number Two'),
      master(4, null, 'No Number Three'),
    ])

    assert.equal(plan.unresolvedStudents.length, 3)
    assert.equal(plan.students.length, 0)
  })

  it('never merges two number-less rows, even with identical names', () => {
    const plan = planStudents(HASH, [master(2, null, 'Asha Rao'), master(3, null, 'Asha Rao')])

    assert.equal(plan.unresolvedStudents.length, 2)
    assert.notEqual(plan.unresolvedStudents[0].sourceKey, plan.unresolvedStudents[1].sourceKey)
  })

  it('manufactures no student number', () => {
    const plan = planStudents(HASH, [master(2, null, 'Asha Rao')])

    assert.equal(plan.unresolvedStudents[0].studentNumber, null)
    assert.equal(plan.unresolvedStudents[0].unresolved, true)
    assert.match(plan.unresolvedStudents[0].legacySource, /Tracker Master row 2/)
  })

  it('keeps the source name exactly as given', () => {
    const plan = planStudents(HASH, [master(2, null, '  Asha Rao ')])
    assert.equal(plan.unresolvedStudents[0].legacyDisplayName, '  Asha Rao ')
  })
})

describe('batch rows that name a student without numbering them', () => {
  it('creates an unresolved student for each such row', () => {
    const plan = planStudents(HASH, [
      batch('1st June 2026', 38, null, 'Nameless', 'One'),
      batch('Aug 2026', 10, null, 'Nameless', 'Two', 2),
    ])

    assert.equal(plan.unresolvedStudents.length, 2)
    assert.equal(plan.students.length, 0)
  })

  it('records that they came from a batch table, not Tracker Master', () => {
    const plan = planStudents(HASH, [
      batch('Aug 2026', 10, null, 'Nameless', 'One'),
      master(1015, null, 'Also Nameless'),
    ])

    const origins = plan.unresolvedStudents.map((student) => student.unresolvedOrigin).sort()
    assert.deepEqual(origins, ['batch_table', 'tracker_master'])
  })

  it('keys them on sheet, table and row, so two tables never collide', () => {
    // A dated sheet holds a Morning and an Evening table, and both can carry a
    // number-less row on the same sheet.
    const plan = planStudents(HASH, [
      { ...batch('Dec 2025', 10, null, 'Same', 'Name'), tableKey: 'title@1' },
      { ...batch('Dec 2025', 30, null, 'Same', 'Name'), tableKey: 'title@22' },
    ])

    assert.equal(plan.unresolvedStudents.length, 2)
    assert.notEqual(plan.unresolvedStudents[0].sourceKey, plan.unresolvedStudents[1].sourceKey)
  })

  it('keeps two identically-named rows as two students', () => {
    const plan = planStudents(HASH, [
      batch('Dec 2025', 10, null, 'Gurleen', 'Kaur'),
      batch('Dec 2025', 11, null, 'Gurleen', 'Kaur'),
    ])

    assert.equal(plan.unresolvedStudents.length, 2)
    assert.notEqual(plan.unresolvedStudents[0].sourceKey, plan.unresolvedStudents[1].sourceKey)
  })

  it('names the source table in legacy_source', () => {
    const plan = planStudents(HASH, [batch('Aug 2026', 10, null, 'Nameless', 'One')])
    assert.match(plan.unresolvedStudents[0].legacySource, /Aug 2026 \(title@1\) row 10/)
  })

  it('manufactures no student number', () => {
    const plan = planStudents(HASH, [batch('Aug 2026', 10, null, 'Nameless', 'One')])
    assert.equal(plan.unresolvedStudents[0].studentNumber, null)
    assert.equal(plan.unresolvedStudents[0].legacyDisplayName, 'Nameless One')
  })
})
