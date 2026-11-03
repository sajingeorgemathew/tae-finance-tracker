/**
 * The cutover plan: exactly what would be deleted, kept and inserted.
 *
 * The plan is computed from the private backup (the hosted state, row by row)
 * and the target dataset. It is a list of ids per table plus the counts that
 * must hold before and after, and it is what the apply executes and nothing
 * more. Its SHA-256 is the approval token: the apply recomputes the plan from
 * the then-current inputs and refuses unless the hash is identical.
 *
 * Deletion follows the foreign keys:
 *
 *   payments → installments → student_finance_records → batch_finance_columns
 *   → batches → students
 *
 * A student survives when a retained or target finance record still refers to
 * it (March students, and hosted students re-used by exact number); every
 * other hosted student is referenced only by removed cohorts and goes.
 * Programs, import history, receipts, deliveries and the audit log are never
 * deleted.
 */

import { createHash } from 'node:crypto'

import { canonicalJson } from '../finance-contact/apply-plan.mts'

import { BACKUP_TABLES, TICKET, type BackupTable, type TargetScope } from './config.mts'
import { reconcileDatedPayments, type DatedPaymentClass } from './dated-payments.mts'
import { INSERT_TABLES, type InsertTable, type TargetDataset } from './target.mts'

import type { BackupRow, StateFingerprint } from './hosted.mts'

/** Tables the cutover deletes from, in the order the deletes must run. */
export const DELETE_ORDER = [
  'payments',
  'installments',
  'student_finance_records',
  'batch_finance_columns',
  'batches',
  'students',
] as const

export type DeleteTable = (typeof DELETE_ORDER)[number]

export type TableCounts = Record<BackupTable, number>

export interface CutoverPlan {
  ticket: string
  workbook: { fileName: string; sha256: string }
  backup: { file: string; sha256: string }
  /** The restore statement generated from that backup. The apply refuses without it. */
  restore: { file: string; sha256: string }
  targetHash: string
  /** The live hosted fingerprint the plan was computed against. The apply refuses on any difference. */
  preState: StateFingerprint
  deletes: Record<DeleteTable, string[]>
  /**
   * Retained finance records whose `collection_mode` the cutover sets (March).
   * Inserted records carry theirs in the row itself.
   */
  collectionModeUpdates: { mode: string; ids: string[] }[]
  /**
   * Every dated hosted payment of a target student that the cutover removes,
   * with its class (see `dated-payments.mts`). Part of the hash, so an approved
   * plan carries its reconciliation.
   */
  datedPayments: { paymentId: string; class: DatedPaymentClass; amount: number }[]
  /** `collection_mode` counts over all finance records after the cutover. */
  expectedCollectionModes: Record<string, number>
  counts: {
    current: TableCounts
    delete: TableCounts
    retained: TableCounts
    insert: TableCounts
    /** The audit row the apply itself writes. */
    applyAudit: TableCounts
    target: TableCounts
  }
  expectedPost: TableCounts & { studentsEmailNonNull: number; studentsPhoneNonNull: number }
  removedBatches: { id: string; programShortCode: string; name: string; legacySheetName: string | null; records: number }[]
  invariantViolations: string[]
  /** Present only for a narrowed, non-destructive launch plan. */
  scope?: TargetScope
}

function zeroCounts(): TableCounts {
  return Object.fromEntries(BACKUP_TABLES.map((table) => [table, 0])) as TableCounts
}

/**
 * Builds the plan. Pure: the backup rows, the target and the fingerprint in,
 * the plan out.
 */
export function buildCutoverPlan(input: {
  hosted: Record<BackupTable, BackupRow[]>
  fingerprint: StateFingerprint
  backup: { file: string; sha256: string }
  restore: { file: string; sha256: string }
  target: TargetDataset
  targetHash: string
  /** Program short codes with receipt numbering configured. */
  receiptNumbered: ReadonlySet<string>
  /** The narrowed launch scope the target was built with, if any. */
  scope?: TargetScope
}): CutoverPlan {
  const { hosted, target } = input
  const violations: string[] = []

  const retainedSet = Object.fromEntries(
    BACKUP_TABLES.map((table) => [table, new Set(target.retained[table])]),
  ) as Record<BackupTable, Set<string>>

  // Everything hosted that is not retained is deleted — for the tables the
  // cutover owns. The others must be retained whole.
  const deletes = Object.fromEntries(DELETE_ORDER.map((table) => [table, [] as string[]])) as Record<DeleteTable, string[]>
  for (const table of DELETE_ORDER) {
    deletes[table] = hosted[table].filter((row) => !retainedSet[table].has(row.id)).map((row) => row.id).sort()
  }
  for (const table of BACKUP_TABLES) {
    if ((DELETE_ORDER as readonly string[]).includes(table)) continue
    const missing = hosted[table].filter((row) => !retainedSet[table].has(row.id)).length
    if (missing > 0) violations.push(`${table}: ${missing} hosted row(s) neither retained nor deletable`)
  }
  for (const table of BACKUP_TABLES) {
    const hostedIds = new Set(hosted[table].map((row) => row.id))
    const phantom = target.retained[table].filter((id) => !hostedIds.has(id)).length
    if (phantom > 0) violations.push(`${table}: ${phantom} retained id(s) do not exist on hosted`)
  }

  // --- Referential integrity of what is left plus what is added ------------
  const finalIds = (table: BackupTable): Set<string> => {
    const ids = new Set(target.retained[table])
    if ((INSERT_TABLES as readonly string[]).includes(table)) {
      for (const row of target.inserts[table as InsertTable]) ids.add(row.id)
    }
    return ids
  }
  const byId = (table: BackupTable): Map<string, BackupRow> => new Map(hosted[table].map((row) => [row.id, row]))
  const finalRows = (table: BackupTable & InsertTable): Record<string, unknown>[] => {
    const hostedById = byId(table)
    return [
      ...target.retained[table].map((id) => hostedById.get(id) as Record<string, unknown>),
      ...target.inserts[table],
    ]
  }
  const check = (child: BackupTable & InsertTable, column: string, parent: BackupTable, nullable: boolean): void => {
    const parents = finalIds(parent)
    const dangling = finalRows(child).filter((row) => {
      const value = row[column]
      if (value === null || value === undefined) return !nullable
      return !parents.has(String(value))
    }).length
    if (dangling > 0) violations.push(`${child}.${column}: ${dangling} row(s) reference no ${parent} row after the cutover`)
  }
  check('batches', 'program_id', 'programs', false)
  check('student_finance_records', 'student_id', 'students', false)
  check('student_finance_records', 'program_id', 'programs', false)
  check('student_finance_records', 'batch_id', 'batches', true)
  check('installments', 'student_finance_record_id', 'student_finance_records', false)
  check('payments', 'student_finance_record_id', 'student_finance_records', false)
  check('payments', 'installment_id', 'installments', true)
  check('batch_finance_columns', 'batch_id', 'batches', false)
  check('import_exceptions', 'import_batch_id', 'import_batches', true)

  // Nothing restrict-referenced by a retained row may be deleted.
  const deletedStudents = new Set(deletes.students)
  const referencedDeleted = finalRows('student_finance_records').filter((row) => deletedStudents.has(String(row.student_id))).length
  if (referencedDeleted > 0) violations.push(`${referencedDeleted} remaining finance record(s) reference a deleted student`)
  if (hosted.receipts.length > 0) violations.push('hosted holds receipts; a payment delete could break them — not planned for')

  // Every hosted student either stays or goes, and every inserted student is new.
  const hostedStudentIds = new Set(hosted.students.map((row) => row.id))
  const reinserted = target.inserts.students.filter((row) => hostedStudentIds.has(row.id)).length
  if (reinserted > 0) violations.push(`${reinserted} inserted student id(s) already exist on hosted`)
  for (const table of INSERT_TABLES) {
    const hostedIds = new Set(hosted[table].map((row) => row.id))
    const clash = target.inserts[table].filter((row) => hostedIds.has(row.id) && !deletes[table as DeleteTable]?.includes(row.id)).length
    if (clash > 0) violations.push(`${table}: ${clash} inserted id(s) collide with a retained hosted row`)
  }

  // --- Counts -----------------------------------------------------------------
  const current = zeroCounts()
  const del = zeroCounts()
  const retained = zeroCounts()
  const insert = zeroCounts()
  const applyAudit = zeroCounts()
  const targetCounts = zeroCounts()
  for (const table of BACKUP_TABLES) {
    current[table] = hosted[table].length
    del[table] = (deletes as Record<string, string[]>)[table]?.length ?? 0
    retained[table] = target.retained[table].length
    insert[table] = (INSERT_TABLES as readonly string[]).includes(table) ? target.inserts[table as InsertTable].length : 0
  }
  applyAudit.audit_log = 1
  for (const table of BACKUP_TABLES) {
    targetCounts[table] = current[table] - del[table] + insert[table] + applyAudit[table]
    if (current[table] - del[table] !== retained[table]) {
      violations.push(`${table}: current ${current[table]} − delete ${del[table]} ≠ retained ${retained[table]}`)
    }
    if (current[table] !== input.fingerprint.tables[table].count) {
      violations.push(`${table}: backup holds ${current[table]} rows but the live fingerprint says ${input.fingerprint.tables[table].count}`)
    }
  }

  const programById = new Map(hosted.programs.map((row) => [row.id, String(row.short_code)]))
  const recordsPerBatch = new Map<string, number>()
  for (const record of hosted.student_finance_records) {
    if (record.batch_id === null) continue
    recordsPerBatch.set(String(record.batch_id), (recordsPerBatch.get(String(record.batch_id)) ?? 0) + 1)
  }
  const removedBatches = hosted.batches
    .filter((batch) => deletes.batches.includes(batch.id))
    .map((batch) => ({
      id: batch.id,
      programShortCode: programById.get(String(batch.program_id)) ?? 'unknown',
      name: String(batch.name),
      legacySheetName: (batch.legacy_sheet_name as string | null) ?? null,
      records: recordsPerBatch.get(batch.id) ?? 0,
    }))
    .sort((a, b) => a.programShortCode.localeCompare(b.programShortCode) || a.name.localeCompare(b.name))

  const keptStudents = new Set(target.retained.students)
  const keptEmail = hosted.students.filter((row) => keptStudents.has(row.id) && row.email !== null).length
  const keptPhone = hosted.students.filter((row) => keptStudents.has(row.id) && row.phone !== null).length
  const insertedEmail = target.inserts.students.filter((row) => row.email !== null).length
  const insertedPhone = target.inserts.students.filter((row) => row.phone !== null).length

  const datedPayments = reconcileDatedPayments({ target, hosted, deletedPaymentIds: deletes.payments, receiptNumbered: input.receiptNumbered })
  for (const entry of datedPayments) {
    if (entry.class === 'AMBIGUOUS') violations.push(`dated payment ${entry.paymentId} cannot be reconciled: ${entry.evidence.join('; ')}`)
    if (entry.class === 'PRIOR_ENROLLMENT_NOT_TARGET_MONEY' && input.scope !== undefined) {
      // A narrowed launch retires no other cohort, so a prior enrollment's
      // money would be deleted while its cohort stays: that is a loss.
      violations.push(`dated payment ${entry.paymentId} belongs to a prior enrollment the narrowed launch keeps; it may not be deleted with the replaced table`)
    }
    if (entry.class === 'NOT_REPRESENTED_IN_NEW_WORKBOOK') {
      violations.push(`dated payment ${entry.paymentId} holds money the target would lose; the cutover has no reviewed step to preserve it yet`)
    }
  }

  const retainedRecords = new Set(target.retained.student_finance_records)
  const updatesByMode = new Map<string, string[]>()
  const expectedCollectionModes: Record<string, number> = {}
  for (const link of target.links) {
    expectedCollectionModes[link.collectionMode] = (expectedCollectionModes[link.collectionMode] ?? 0) + 1
    if (retainedRecords.has(link.financeRecordId)) updatesByMode.set(link.collectionMode, [...(updatesByMode.get(link.collectionMode) ?? []), link.financeRecordId])
  }
  const collectionModeUpdates = [...updatesByMode.entries()]
    .map(([mode, ids]) => ({ mode, ids: [...ids].sort() }))
    .sort((a, b) => a.mode.localeCompare(b.mode))
  // Retained records the cutover does not link keep whatever mode they hold
  // (NULL on hosted today: "not decided", never collected automatically).
  const linkedIds = new Set(target.links.map((link) => link.financeRecordId))
  for (const row of hosted.student_finance_records) {
    if (!retainedRecords.has(row.id) || linkedIds.has(row.id)) continue
    const mode = typeof row.collection_mode === 'string' ? row.collection_mode : 'NULL'
    expectedCollectionModes[mode] = (expectedCollectionModes[mode] ?? 0) + 1
  }
  const insertedWithoutMode = target.inserts.student_finance_records.filter((row) => typeof row.collection_mode !== 'string').length
  if (insertedWithoutMode > 0) violations.push(`${insertedWithoutMode} inserted finance record(s) carry no collection_mode`)
  const linked = Object.values(expectedCollectionModes).reduce((total, value) => total + value, 0)
  if (linked !== targetCounts.student_finance_records) {
    violations.push(`${linked} target finance records carry a collection mode, the target holds ${targetCounts.student_finance_records}`)
  }

  return {
    ticket: TICKET,
    workbook: target.workbook,
    backup: input.backup,
    restore: input.restore,
    targetHash: input.targetHash,
    preState: input.fingerprint,
    deletes,
    datedPayments: datedPayments.map((entry) => ({ paymentId: entry.paymentId, class: entry.class, amount: entry.amount })),
    collectionModeUpdates,
    expectedCollectionModes: Object.fromEntries(Object.entries(expectedCollectionModes).sort(([a], [b]) => a.localeCompare(b))),
    counts: { current, delete: del, retained, insert, applyAudit, target: targetCounts },
    expectedPost: { ...targetCounts, studentsEmailNonNull: keptEmail + insertedEmail, studentsPhoneNonNull: keptPhone + insertedPhone },
    removedBatches,
    invariantViolations: violations,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  }
}

export function cutoverPlanHash(plan: CutoverPlan): string {
  return createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex')
}
