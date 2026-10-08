import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildApplyPlan,
  canonicalJson,
  decideEmail,
  decidePhone,
  executeApply,
  planHash,
  renderPlanAggregate,
  rpcArgumentsFor,
  type ApplyPlan,
  type BuildPlanInput,
  type RpcArguments,
  type RpcResult,
} from './apply-plan.mts'
import type { ContactImportRow } from './canonical.mts'
import { classifyRows, findDuplicateSourceNumbers, findSharedContacts, type HostedSnapshot, type HostedStudentLike } from './reconcile.mts'
import { DEFAULT_SCOPE_CONFIG } from './scope.mts'

/**
 * FINANCE-CONTACT-04B2 — the apply plan, on invented data only.
 *
 * Every value here is made up: `example.test` addresses, 555 numbers,
 * student numbers in the 9xxxxx range, and fixture UUIDs. Nothing touches a
 * database, and the module under test has no client to touch one with.
 */

const WORKBOOK = 'fixture-master.xlsx'
const WORKBOOK_SHA = 'a'.repeat(64)

function row(overrides: Partial<ContactImportRow>): ContactImportRow {
  const number = overrides.studentNumber === undefined ? '900001' : overrides.studentNumber
  return {
    stagedRowId: `PSW:sheet:${overrides.sourceRow ?? 1}`,
    sourceWorkbook: WORKBOOK,
    sourceSheet: 'sheet',
    sourceTable: 'PSW Morning Batch - 01st Dec 2025',
    sourceRow: overrides.sourceRow ?? 1,
    programCode: 'PSW',
    studentNumber: number,
    studentNumberRaw: number,
    firstName: 'Fixture',
    middleName: null,
    lastName: 'Student',
    displayName: 'Fixture Student',
    emailRaw: ' Fixture.Student@Example.test ',
    emailNormalized: 'fixture.student@example.test',
    emailStatus: 'valid',
    phoneRaw: '(416) 555-0100',
    phoneNormalized: '+14165550100',
    phoneStatus: 'valid_nanp',
    intakeLabel: '01st Dec 2025',
    intakeDate: '2025-12-01',
    session: 'Morning',
    sourceStartDate: null,
    sourceStatus: null,
    inOperationalScope: true,
    exclusionReason: null,
    ...overrides,
  }
}

function student(overrides: Partial<HostedStudentLike> & { id: string }): HostedStudentLike {
  return {
    student_number: '900001',
    first_name: 'Fixture',
    middle_name: null,
    last_name: 'Student',
    display_name: null,
    legacy_name: null,
    email: null,
    phone: null,
    ...overrides,
  }
}

const ID_1 = '00000000-0000-4000-8000-000000000001'
const ID_2 = '00000000-0000-4000-8000-000000000002'
const ID_3 = '00000000-0000-4000-8000-000000000003'
const ID_4 = '00000000-0000-4000-8000-000000000004'

function snapshot(students: HostedStudentLike[]): HostedSnapshot {
  return { students, programs: [{ id: 'p1', short_code: 'PSW' }], batches: [], records: [], intakes: [] }
}

function planFor(rows: ContactImportRow[], students: HostedStudentLike[], baselineOverrides: Partial<BuildPlanInput['baseline']> = {}): ApplyPlan {
  const hosted = snapshot(students)
  const duplicates = findDuplicateSourceNumbers(rows)
  const shared = findSharedContacts(rows)
  const assessments = classifyRows(rows, { hosted, duplicates, shared, dateUnknownRowIds: new Set() })
  return buildApplyPlan({
    assessments,
    shared,
    hostedStudents: students,
    workbooks: [{ fileName: WORKBOOK, sha256: WORKBOOK_SHA, adapterId: 'psw-masterclass-list' }],
    baseline: { projectRef: 'fixture', counts: { students: 2, audit_log: 0 }, studentsWithEmail: 0, studentsWithPhone: 0, ...baselineOverrides },
    scope: DEFAULT_SCOPE_CONFIG,
  })
}

describe('decideEmail / decidePhone', () => {
  const none = new Set<string>()

  it('fills when hosted is NULL, the source is valid and nothing is shared', () => {
    assert.deepEqual(decideEmail([row({})], null, none), { action: 'fill', reason: 'SAFE_FILL', value: 'fixture.student@example.test' })
    assert.deepEqual(decidePhone([row({})], null, none), { action: 'fill', reason: 'SAFE_FILL', value: '+14165550100' })
  })

  it('never proposes a value over a hosted non-NULL value', () => {
    assert.equal(decideEmail([row({})], 'other@example.test', none).reason, 'HELD_CONTACT_DIFFERENCE')
    assert.equal(decideEmail([row({})], 'other@example.test', none).action, 'hold')
    assert.equal(decidePhone([row({})], '+14165550199', none).reason, 'HELD_CONTACT_DIFFERENCE')
  })

  it('recognises a hosted value that already matches, in any presentation', () => {
    assert.equal(decideEmail([row({})], 'Fixture.Student@Example.test', none).reason, 'ALREADY_MATCHES')
    assert.equal(decidePhone([row({})], '416-555-0100', none).reason, 'ALREADY_MATCHES')
    assert.equal(decidePhone([row({})], '+14165550100', none).action, 'none')
  })

  it('holds a shared value and says so', () => {
    const shared = new Set(['PSW:sheet:1'])
    assert.equal(decideEmail([row({})], null, shared).reason, 'HELD_SHARED_CONTACT')
    assert.equal(decidePhone([row({})], null, shared).reason, 'HELD_SHARED_CONTACT')
  })

  it('holds a source conflict between rows of the same student', () => {
    const rows = [row({ sourceRow: 1 }), row({ sourceRow: 2, emailNormalized: 'second@example.test', phoneNormalized: '+14165550101' })]
    assert.equal(decideEmail(rows, null, none).reason, 'HELD_SOURCE_CONFLICT')
    assert.equal(decidePhone(rows, null, none).reason, 'HELD_SOURCE_CONFLICT')
  })

  it('names invalid, ambiguous and non-NANP phones separately and never fills them', () => {
    assert.equal(decidePhone([row({ phoneStatus: 'invalid', phoneNormalized: null })], null, none).reason, 'HELD_INVALID_PHONE')
    assert.equal(decidePhone([row({ phoneStatus: 'ambiguous', phoneNormalized: null })], null, none).reason, 'HELD_AMBIGUOUS_PHONE')
    assert.equal(decidePhone([row({ phoneStatus: 'international_explicit', phoneNormalized: '+441632960000' })], null, none).reason, 'HELD_NON_NANP_PHONE')
    assert.equal(decideEmail([row({ emailStatus: 'invalid', emailNormalized: null })], null, none).reason, 'HELD_INVALID_EMAIL')
  })

  it('does nothing for a field the source does not state', () => {
    assert.deepEqual(decideEmail([row({ emailStatus: 'missing', emailNormalized: null, emailRaw: null })], null, none), { action: 'none', reason: 'NO_SOURCE_VALUE', value: null })
    assert.equal(decidePhone([row({ phoneStatus: 'missing', phoneNormalized: null, phoneRaw: null })], 'x', none).reason, 'NO_SOURCE_VALUE')
  })
})

describe('buildApplyPlan', () => {
  it('produces one candidate per unique hosted student with field-level actions', () => {
    const rows = [
      row({ sourceRow: 1, studentNumber: '900001' }),
      row({ sourceRow: 2, studentNumber: '900002', emailNormalized: 'two@example.test', phoneStatus: 'invalid', phoneNormalized: null, phoneRaw: 'n/a' }),
    ]
    const plan = planFor(rows, [student({ id: ID_1 }), student({ id: ID_2, student_number: '900002' })])
    assert.equal(plan.candidates.length, 2)
    const [first, second] = plan.candidates
    assert.equal(first.studentId, ID_1)
    assert.equal(first.emailAction, 'fill')
    assert.equal(first.phoneAction, 'fill')
    assert.equal(first.proposedEmail, 'fixture.student@example.test')
    assert.equal(first.proposedPhone, '+14165550100')
    assert.equal(second.emailAction, 'fill')
    assert.equal(second.phoneAction, 'hold')
    assert.equal(second.phoneReason, 'HELD_INVALID_PHONE')
    assert.equal(second.proposedPhone, null)
    assert.deepEqual(plan.aggregate, {
      ...plan.aggregate,
      operationalSourceRows: 2,
      uniqueOperationalNumbers: 2,
      existingHostedMatchRows: 2,
      uniqueMatchedStudents: 2,
      uniqueTargetStudents: 2,
      emailFills: 2,
      phoneFills: 1,
      studentsReceivingBoth: 1,
      studentsReceivingEmailOnly: 1,
      studentsReceivingPhoneOnly: 0,
      invalidPhoneHolds: 1,
      expectedAuditRows: 2,
      studentRowsCreated: 0,
      studentRowsOverwritten: 0,
    })
  })

  it('collapses a repeated number with agreeing contacts into one candidate and flags it', () => {
    const rows = [row({ sourceRow: 1 }), row({ sourceRow: 2, sourceTable: 'PSW Morning Batch - 06th Apr 2026', intakeDate: '2026-04-06' })]
    const plan = planFor(rows, [student({ id: ID_1 })])
    assert.equal(plan.candidates.length, 1)
    assert.equal(plan.candidates[0].sourceEvidence.length, 2)
    assert.ok(plan.candidates[0].evidenceFlags.includes('REPEATED_SOURCE_NUMBER'))
    assert.equal(plan.candidates[0].emailAction, 'fill')
    assert.equal(plan.aggregate.repeatedNumberCollapsedCandidates, 1)
    assert.equal(plan.aggregate.uniqueTargetStudents, 1)
  })

  it('holds both fields of both students when a contact is shared between numbers', () => {
    const rows = [row({ sourceRow: 1, studentNumber: '900001' }), row({ sourceRow: 2, studentNumber: '900002' })]
    const plan = planFor(rows, [student({ id: ID_1 }), student({ id: ID_2, student_number: '900002' })])
    for (const candidate of plan.candidates) {
      assert.equal(candidate.emailReason, 'HELD_SHARED_CONTACT')
      assert.equal(candidate.phoneReason, 'HELD_SHARED_CONTACT')
      assert.equal(candidate.proposedEmail, null)
    }
    assert.equal(plan.aggregate.sharedContactHolds, 2)
    assert.equal(plan.aggregate.uniqueTargetStudents, 0)
    assert.equal(plan.aggregate.expectedAuditRows, 0)
  })

  it('defers new students and number-less rows, and never creates or overwrites', () => {
    const rows = [
      row({ sourceRow: 1, studentNumber: '900001' }),
      row({ sourceRow: 2, studentNumber: '900009', emailNormalized: 'nine@example.test', phoneNormalized: '+14165550109' }),
      row({ sourceRow: 3, studentNumber: null, studentNumberRaw: null, emailNormalized: 'fixture.student@example.test' }),
    ]
    const plan = planFor(rows, [student({ id: ID_1 })])
    assert.equal(plan.candidates.length, 1)
    assert.deepEqual(
      plan.deferred.map((item) => [item.stagedRowId, item.category]),
      [
        ['PSW:sheet:2', 'DEFERRED_NEW_STUDENT'],
        ['PSW:sheet:3', 'DEFERRED_MISSING_IDENTITY'],
      ],
    )
    assert.equal(plan.aggregate.newStudentDeferrals, 1)
    assert.equal(plan.aggregate.missingIdDeferrals, 1)
    assert.equal(plan.aggregate.studentRowsCreated, 0)
    assert.equal(plan.aggregate.studentRowsOverwritten, 0)
    // The number-less row shares the first student's email; that must not match it by email.
    assert.equal(plan.candidates[0].sourceEvidence.length, 1)
  })

  it('holds a number that matches more than one hosted row', () => {
    const plan = planFor([row({})], [student({ id: ID_1 }), student({ id: ID_2 })])
    assert.equal(plan.candidates.length, 0)
    assert.equal(plan.deferred[0].category, 'HELD_DUPLICATE_HOSTED_NUMBER')
    assert.equal(plan.aggregate.duplicateHostedNumberHolds, 1)
  })

  it('keeps out-of-scope rows out of the plan entirely', () => {
    const rows = [row({ sourceRow: 1 }), row({ sourceRow: 2, studentNumber: '900002', inOperationalScope: false, exclusionReason: 'OUT_OF_SCOPE_HISTORICAL' })]
    const plan = planFor(rows, [student({ id: ID_1 }), student({ id: ID_2, student_number: '900002' })])
    assert.equal(plan.candidates.length, 1)
    assert.equal(plan.deferred.length, 0)
    assert.equal(plan.aggregate.operationalSourceRows, 1)
  })

  it('is idempotent: after a fill the same sources produce no writes and ALREADY_MATCHES', () => {
    const rows = [row({})]
    const before = planFor(rows, [student({ id: ID_1 })])
    assert.equal(before.aggregate.uniqueTargetStudents, 1)
    const after = planFor(rows, [student({ id: ID_1, email: 'fixture.student@example.test', phone: '+14165550100' })], { studentsWithEmail: 1, studentsWithPhone: 1, counts: { students: 2, audit_log: 1 } })
    assert.equal(after.candidates[0].emailAction, 'none')
    assert.equal(after.candidates[0].emailReason, 'ALREADY_MATCHES')
    assert.equal(after.candidates[0].phoneReason, 'ALREADY_MATCHES')
    assert.equal(after.aggregate.uniqueTargetStudents, 0)
    assert.equal(after.aggregate.emailAlreadyMatching, 1)
    assert.equal(after.aggregate.expectedAuditRows, 0)
    assert.notEqual(planHash(before), planHash(after), 'the pre-apply plan hash must not describe the post-apply state')
  })

  it('carries evidence flags without letting them block a fill', () => {
    const rows = [row({ displayName: 'Fixture Student-Different' })]
    const plan = planFor(rows, [student({ id: ID_1 })])
    assert.ok(plan.candidates[0].evidenceFlags.includes('NAME_DIFFERENCE'))
    assert.equal(plan.candidates[0].emailAction, 'fill')
    assert.equal(plan.aggregate.nameDifferenceFlags, 1)
  })

  it('records the hosted student number as stored, for the RPC to re-check', () => {
    const plan = planFor([row({})], [student({ id: ID_1, student_number: ' 900001 ' })])
    assert.equal(plan.candidates[0].studentNumber, ' 900001 ')
  })
})

describe('plan hash', () => {
  it('is deterministic and independent of key order', () => {
    const plan = planFor([row({})], [student({ id: ID_1 })])
    const reordered = JSON.parse(JSON.stringify(plan)) as ApplyPlan
    assert.equal(canonicalJson(plan), canonicalJson(reordered))
    assert.equal(planHash(plan), planHash(planFor([row({})], [student({ id: ID_1 })])))
    assert.match(planHash(plan), /^[0-9a-f]{64}$/)
  })

  it('changes when a source hash, the hosted baseline or a candidate changes', () => {
    const base = planHash(planFor([row({})], [student({ id: ID_1 })]))
    assert.notEqual(base, planHash(planFor([row({})], [student({ id: ID_1 })], { counts: { students: 3, audit_log: 0 } })))
    assert.notEqual(base, planHash(planFor([row({ phoneNormalized: '+14165550101' })], [student({ id: ID_1 })])))
    assert.notEqual(base, planHash(planFor([row({})], [student({ id: ID_1, phone: '+14165550100' })])))
  })

  it('sorts keys at every level in the canonical form', () => {
    assert.equal(canonicalJson({ b: [{ z: 1, a: 2 }], a: null }), '{"a":null,"b":[{"a":2,"z":1}]}')
  })
})

describe('rpcArgumentsFor', () => {
  it('targets the UUID, proposes only filled fields and carries provenance', () => {
    const plan = planFor([row({ phoneStatus: 'ambiguous', phoneNormalized: null, phoneRaw: '4165550100123' })], [student({ id: ID_1 })])
    const args = rpcArgumentsFor(plan.candidates[0], 'h'.repeat(64))
    assert.equal(args.p_student_id, ID_1)
    assert.equal(args.p_email, 'fixture.student@example.test')
    assert.equal(args.p_phone, null)
    assert.equal(args.p_expected_student_number, '900001')
    assert.equal(args.p_metadata.ticket, 'FINANCE-CONTACT-04B2')
    assert.equal(args.p_metadata.source_type, 'master_contact_import')
    assert.equal(args.p_metadata.plan_hash, 'h'.repeat(64))
    assert.deepEqual(args.p_metadata.requested_fields, ['email'])
    const sources = args.p_metadata.sources as Record<string, unknown>[]
    assert.equal(sources[0].workbook_sha256, WORKBOOK_SHA)
    assert.equal(sources[0].staged_row_id, 'PSW:sheet:1')
    assert.equal(sources[0].email_raw, ' Fixture.Student@Example.test ')
    assert.equal('phone_raw' in sources[0], false, 'raw phone is not provenance for a call that does not write phone')
  })
})

describe('executeApply', () => {
  function planOfThree(): ApplyPlan {
    return planFor(
      [
        row({ sourceRow: 1, studentNumber: '900001' }),
        row({ sourceRow: 2, studentNumber: '900002', emailNormalized: 'two@example.test', phoneNormalized: '+14165550102' }),
        row({ sourceRow: 3, studentNumber: '900003', emailNormalized: 'three@example.test', phoneNormalized: '+14165550103' }),
        row({ sourceRow: 4, studentNumber: '900004', emailNormalized: 'four@example.test', phoneStatus: 'missing', phoneNormalized: null, phoneRaw: null }),
      ],
      [student({ id: ID_1 }), student({ id: ID_2, student_number: '900002' }), student({ id: ID_3, student_number: '900003' }), student({ id: ID_4, student_number: '900004' })],
    )
  }

  it('calls the RPC once per candidate with a fill, in plan order, and tallies fields', async () => {
    const plan = planOfThree()
    const calls: RpcArguments[] = []
    const execution = await executeApply(plan, 'x'.repeat(64), async (args) => {
      calls.push(args)
      return { ok: true, data: { audit_log_id: `audit-${args.p_student_id}` } }
    })
    assert.deepEqual(calls.map((call) => call.p_student_id), [ID_1, ID_2, ID_3, ID_4])
    assert.equal(execution.applied, 4)
    assert.equal(execution.emailFieldsWritten, 4)
    assert.equal(execution.phoneFieldsWritten, 3)
    assert.equal(execution.outcomes[0].auditLogId, `audit-${ID_1}`)
  })

  it('records a stale target, continues, and never counts it as applied', async () => {
    const plan = planOfThree()
    const stale: RpcResult = { ok: false, message: 'STALE_TARGET', code: 'P0001', details: 'email is no longer NULL; nothing was written' }
    const execution = await executeApply(plan, 'x'.repeat(64), async (args) => (args.p_student_id === ID_2 ? stale : { ok: true, data: {} }))
    assert.equal(execution.applied, 3)
    assert.equal(execution.stale, 1)
    assert.equal(execution.outcomes.find((item) => item.studentId === ID_2)?.status, 'STALE_TARGET')
    assert.equal(execution.emailFieldsWritten, 3)
  })

  it('stops at the first authorisation failure', async () => {
    const plan = planOfThree()
    let calls = 0
    const execution = await executeApply(plan, 'x'.repeat(64), async () => {
      calls += 1
      return { ok: false, message: 'NOT_AUTHORISED', code: '42501', details: null }
    })
    assert.equal(calls, 1)
    assert.equal(execution.abortedBecause, 'NOT_AUTHORISED')
    assert.equal(execution.applied, 0)
    assert.equal(execution.failed, 1)
  })
})

describe('renderPlanAggregate', () => {
  it('prints counts and hashes only — no name, number or contact value', () => {
    const plan = planFor([row({})], [student({ id: ID_1 })])
    const text = renderPlanAggregate(plan, planHash(plan))
    assert.ok(text.includes('| email fills | 1 |'))
    assert.ok(text.includes(WORKBOOK_SHA))
    for (const secret of ['900001', 'example.test', '555', 'Fixture', ID_1]) {
      assert.equal(text.includes(secret), false, `aggregate leaks ${secret}`)
    }
  })
})
