/**
 * FINANCE-RECONCILE-04A — the pure rules behind the unassigned-record audit.
 *
 * Everything in this file is data in, data out: no database, no workbook, no
 * browser. `unassigned-audit.mts` gathers the evidence and this module grades
 * it, so the grading can be tested without a hosted project and cannot drift
 * towards whatever a query happens to return.
 *
 * Nothing here assigns, merges, resolves or corrects anything. It classifies
 * what the evidence supports and says how strong that evidence is, for a human
 * to read before a later write workflow (RECONCILE-04B) exists.
 */

// -----------------------------------------------------------------------------
// Payment conservation
// -----------------------------------------------------------------------------

export interface ConservationInput {
  /** Every hosted payment: which finance record it hangs off. */
  payments: readonly { id: string; student_finance_record_id: string }[]
  /** Every hosted finance record: its batch, or null. */
  records: readonly { id: string; batch_id: string | null }[]
}

export interface Conservation {
  total: number
  assigned: number
  unassigned: number
  /** Payments whose record is not in the record set at all. Must be 0. */
  orphaned: number
  /** `assigned + unassigned + orphaned === total`. */
  conserved: boolean
}

/** How every payment row distributes between batch and unassigned records. */
export function conservePayments(input: ConservationInput): Conservation {
  const batchByRecord = new Map(input.records.map((record) => [record.id, record.batch_id]))
  let assigned = 0
  let unassigned = 0
  let orphaned = 0

  for (const payment of input.payments) {
    if (!batchByRecord.has(payment.student_finance_record_id)) orphaned += 1
    else if (batchByRecord.get(payment.student_finance_record_id) === null) unassigned += 1
    else assigned += 1
  }

  return {
    total: input.payments.length,
    assigned,
    unassigned,
    orphaned,
    conserved: assigned + unassigned + orphaned === input.payments.length,
  }
}

/** 0 / 1 / 2+ payments, as the ticket asks for them. */
export function bucketPaymentCounts(counts: readonly number[]): { zero: number; one: number; twoPlus: number } {
  return {
    zero: counts.filter((count) => count === 0).length,
    one: counts.filter((count) => count === 1).length,
    twoPlus: counts.filter((count) => count >= 2).length,
  }
}

// -----------------------------------------------------------------------------
// Transaction rows versus finance records
// -----------------------------------------------------------------------------

/** One Tracker Master row as the importer planned it. */
export interface PlannedRow {
  sourceRow: number
  /** The routing outcome the importer recorded for the row. */
  routing: string
  /** True when the row became a `payments` insert; false for an exception. */
  plansPayment: boolean
  unresolved: string | null
  /** The finance record the row was tied to, or null when none could be. */
  financeRecordId: string | null
}

export interface RoutingReconciliation {
  /** Transaction rows by routing outcome, as the import report counted them. */
  rowsByRouting: Record<string, number>
  /** Rows that reached an unassigned record, by routing outcome. */
  unassignedRowsByRouting: Record<string, number>
  /** Unassigned finance records by the routing outcome of the rows behind them. */
  unassignedRecordsByRouting: Record<string, number>
  unassignedRows: number
  unassignedRowsThatBecamePayments: number
  unassignedRowsPreservedAsExceptions: number
  unassignedRecords: number
  /** Records whose rows carry more than one routing outcome. Expected 0. */
  recordsWithMixedRouting: number
  /** Records with two or more Tracker Master rows behind them. */
  recordsAggregatingSeveralRows: number
  /** The sentence the report has to state. */
  explanation: string
}

/**
 * Why a transaction count and a finance-record count differ.
 *
 * The importer keeps one unassigned record per (student, program) and routes
 * every unroutable row of that student to it, so 42 rows can produce 22
 * records. This lays the two counts side by side, per routing outcome.
 */
export function reconcileRouting(
  rows: readonly PlannedRow[],
  unassignedRecordIds: ReadonlySet<string>,
): RoutingReconciliation {
  const rowsByRouting = countBy(rows.map((row) => row.routing))

  const unassigned = rows.filter(
    (row) => row.financeRecordId !== null && unassignedRecordIds.has(row.financeRecordId),
  )
  const unassignedRowsByRouting = countBy(unassigned.map((row) => row.routing))

  const routingsByRecord = new Map<string, Set<string>>()
  const rowsPerRecord = new Map<string, number>()
  for (const row of unassigned) {
    const id = row.financeRecordId as string
    const set = routingsByRecord.get(id) ?? new Set<string>()
    set.add(row.routing)
    routingsByRecord.set(id, set)
    rowsPerRecord.set(id, (rowsPerRecord.get(id) ?? 0) + 1)
  }

  const unassignedRecordsByRouting: Record<string, number> = {}
  let mixed = 0
  for (const set of routingsByRecord.values()) {
    if (set.size > 1) mixed += 1
    const key = [...set].sort().join('+')
    unassignedRecordsByRouting[key] = (unassignedRecordsByRouting[key] ?? 0) + 1
  }

  const becamePayments = unassigned.filter((row) => row.plansPayment).length
  const exceptions = unassigned.length - becamePayments
  const aggregating = [...rowsPerRecord.values()].filter((count) => count >= 2).length

  return {
    rowsByRouting,
    unassignedRowsByRouting,
    unassignedRecordsByRouting,
    unassignedRows: unassigned.length,
    unassignedRowsThatBecamePayments: becamePayments,
    unassignedRowsPreservedAsExceptions: exceptions,
    unassignedRecords: routingsByRecord.size,
    recordsWithMixedRouting: mixed,
    recordsAggregatingSeveralRows: aggregating,
    explanation:
      `${unassigned.length} Tracker Master rows could not be tied to exactly one batch table ` +
      `(${describeCounts(unassignedRowsByRouting)}). The importer keeps one unassigned finance record ` +
      `per student per program and routes every such row of that student to it, so those ` +
      `${unassigned.length} rows resolve to ${routingsByRecord.size} records: ${aggregating} of the records ` +
      `hold two or more rows. ${becamePayments} of the rows became payments and ${exceptions} ` +
      `${exceptions === 1 ? 'was' : 'were'} preserved as an import exception instead, which is why a record can exist with no payment.`,
  }
}

function describeCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key} ${count}`)
    .join(', ')
}

// -----------------------------------------------------------------------------
// Origin of a finance record
// -----------------------------------------------------------------------------

/**
 * The ticket's categories, plus the one the workbook forces.
 *
 *   A  Tracker Master transaction(s) exist, batch unresolved
 *   B  Source finance snapshot exists, batch unresolved
 *   C  Student identity unresolved
 *   D  Finance record exists but no payment/snapshot financial figures
 *   E  Potential importer anomaly
 *   F  Potential UI/view-model anomaly
 *   G  Record created by an amount-less transaction preserved as an import
 *      exception: the row established the student and program, the money was
 *      never asserted. Not in the ticket's list; it is the case the single
 *      `missing_amount` exception produces and is documented rather than
 *      forced into D.
 */
export type OriginCategory = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'

export interface OriginInput {
  studentNumber: string | null
  unassignedReason: string | null
  paymentCount: number
  /** Tracker Master rows the plan tied to this record. */
  plannedRows: number
  plannedPaymentRows: number
  plannedExceptionRows: number
  /** A batch-sheet snapshot behind this record. Never true for an unassigned record. */
  hasBatchSnapshot: boolean
  hasFee: boolean
  hasPaid: boolean
  hasBalance: boolean
  /** Hosted payment count differs from the planned payment count. */
  paymentCountDisagreesWithPlan: boolean
  /** The hosted reason differs from the planned one. */
  reasonDisagreesWithPlan: boolean
  /** Payments visible in the database and missing at any UI stage. */
  uiLoss: boolean
  /**
   * Whether any source behind the record states a name or a number. A row
   * with neither established no person, and the record is an artifact of the
   * rule that a transaction row creates its student.
   */
  hasAnyIdentity: boolean
}

export interface Origin {
  categories: OriginCategory[]
  explanation: string
}

/** Why an unassigned finance record exists, from the evidence alone. */
export function classifyOrigin(input: OriginInput): Origin {
  const categories: OriginCategory[] = []
  const notes: string[] = []

  if (input.paymentCount > 0) {
    categories.push('A')
    notes.push(
      `${input.paymentCount} Tracker Master transaction${input.paymentCount === 1 ? '' : 's'} ` +
        `tied to the record; batch unresolved (${input.unassignedReason ?? 'reason not recorded'})`,
    )
  }

  if (input.hasBatchSnapshot) {
    categories.push('B')
    notes.push('a batch-sheet snapshot exists')
  }

  if (input.studentNumber === null) {
    categories.push('C')
    notes.push('the source row states no student number, so the student is its own unresolved identity')
  }

  if (input.paymentCount === 0 && input.plannedExceptionRows > 0) {
    categories.push('G')
    notes.push(
      `${input.plannedExceptionRows} amount-less Tracker Master row${input.plannedExceptionRows === 1 ? '' : 's'} ` +
        'preserved as an import exception established the student and program; no payment was asserted',
    )
  }

  if (input.paymentCount === 0 && !input.hasFee && !input.hasPaid && !input.hasBalance) {
    categories.push('D')
    notes.push('no payment and no fee, paid or balance figure')
  }

  if (
    input.paymentCountDisagreesWithPlan ||
    input.reasonDisagreesWithPlan ||
    (input.paymentCount === 0 && input.plannedRows === 0) ||
    !input.hasAnyIdentity
  ) {
    categories.push('E')
    notes.push(
      !input.hasAnyIdentity
        ? 'no source row states a name or a number: the record represents no identifiable person and is an import artifact of a row that was not entirely blank'
        : input.paymentCount === 0 && input.plannedRows === 0
          ? 'no planned Tracker Master row explains the record'
          : 'hosted payments or reason differ from the approved plan',
    )
  }

  if (input.uiLoss) {
    categories.push('F')
    notes.push('payments exist in the database and are missing at a UI stage')
  }

  if (categories.length === 0) {
    categories.push('E')
    notes.push('no category fits; the record needs a human look')
  }

  return { categories, explanation: notes.join('; ') }
}

// -----------------------------------------------------------------------------
// Batch evidence
// -----------------------------------------------------------------------------

export interface BatchLike {
  id: string
  name: string
  start_date: string | null
  /** The workbook sheet the batch came from, which states a month and year for undated batches. */
  legacy_sheet_name?: string | null
}

/** A batch a record could belong to, with how strong the evidence is. */
export interface BatchCandidate {
  batchId: string
  batchName: string
  /**
   * `strong`  — the exact student number appears in that batch table's snapshot.
   * `day`     — Tracker Master's Batch date is that batch's recorded start date.
   * `month`   — Tracker Master's Batch month and year match the batch; a hint.
   */
  strength: 'strong' | 'day' | 'month'
  evidence: string
  /** For `strong`: every row of that table listing the number. Two rows is a duplicate. */
  sourceRows: number[]
}

export type BatchAssessment =
  | 'human_assignable'
  | 'month_hint_only'
  | 'missing_identity'
  | 'genuinely_unresolved'

export interface BatchEvidenceInput {
  studentNumber: string | null
  /** Batches whose table lists this exact student number. */
  appearances: readonly { batch: BatchLike; sheetName: string; tableKey: string; sourceRow: number }[]
  /** Tracker Master Batch cells behind the record's rows. */
  trackerHints: readonly { text: string | null; iso: string | null }[]
  /** Every batch of the record's program. */
  programBatches: readonly BatchLike[]
}

export interface BatchEvidence {
  candidates: BatchCandidate[]
  assessment: BatchAssessment
  note: string
  /**
   * True when one batch table lists the student number on two rows. The
   * batch is then not in doubt; which of the two batch records should hold
   * the money is, and that is a different question for a human.
   */
  listedTwiceInOneTable: boolean
}

/**
 * Grades the evidence for where a record might belong. Never assigns.
 *
 * A student number sitting in a batch table is strong evidence — it is the
 * workbook's own statement that the student was in that cohort — and a
 * person choosing between two such tables has something real to choose on.
 * Tracker Master's Batch cell is a date, and a date names an intake, never
 * a Morning or an Evening; on its own it is a hint, and this says so.
 */
export function assessBatchEvidence(input: BatchEvidenceInput): BatchEvidence {
  const candidates: BatchCandidate[] = []
  const seen = new Set<string>()
  let listedTwiceInOneTable = false

  for (const appearance of input.appearances) {
    const existing = candidates.find(
      (candidate) => candidate.strength === 'strong' && candidate.batchId === appearance.batch.id,
    )
    if (existing) {
      existing.sourceRows.push(appearance.sourceRow)
      existing.evidence += `, row ${appearance.sourceRow}`
      listedTwiceInOneTable = true
      continue
    }
    seen.add(`${appearance.batch.id}|strong`)
    candidates.push({
      batchId: appearance.batch.id,
      batchName: appearance.batch.name,
      strength: 'strong',
      evidence: `student number listed in ${appearance.sheetName}!${appearance.tableKey} row ${appearance.sourceRow}`,
      sourceRows: [appearance.sourceRow],
    })
  }

  const hintTexts = [...new Set(input.trackerHints.map((hint) => hint.text).filter((text): text is string => Boolean(text)))]
  const hintDays = [...new Set(input.trackerHints.map((hint) => hint.iso).filter((iso): iso is string => Boolean(iso)))]

  for (const batch of input.programBatches) {
    if (batch.start_date !== null && hintDays.includes(batch.start_date)) {
      const key = `${batch.id}|day`
      if (!seen.has(key)) {
        seen.add(key)
        candidates.push({
          batchId: batch.id,
          batchName: batch.name,
          strength: 'day',
          evidence: `Tracker Master Batch date ${batch.start_date} equals this batch's start date; cannot tell Morning from Evening`,
          sourceRows: [],
        })
      }
      continue
    }
    const matchingText = hintTexts.find((text) => batchMatchesMonthText(batch, text))
    if (matchingText !== undefined) {
      const key = `${batch.id}|month`
      if (!seen.has(key)) {
        seen.add(key)
        candidates.push({
          batchId: batch.id,
          batchName: batch.name,
          strength: 'month',
          evidence: `Tracker Master Batch cell "${matchingText}" names this batch's month and year; a hint only`,
          sourceRows: [],
        })
      }
    }
  }

  const strong = candidates.filter((candidate) => candidate.strength === 'strong')
  const dated = candidates.filter((candidate) => candidate.strength !== 'strong')
  const duplicateNote = listedTwiceInOneTable
    ? '; one table lists the number on two rows, so the batch is clear and the target record is not'
    : ''

  if (input.studentNumber === null) {
    return {
      candidates,
      assessment: 'missing_identity',
      note: 'no student number: nothing ties the record to a batch table, and no name matching is performed',
      listedTwiceInOneTable,
    }
  }
  if (strong.length > 0) {
    return {
      candidates,
      assessment: 'human_assignable',
      note:
        `the student number appears in ${strong.length} batch table${strong.length === 1 ? '' : 's'}; a person can choose among them` +
        (dated.length > 0 ? `; the Tracker Master batch date also points at ${dated.length} batch${dated.length === 1 ? '' : 'es'}` : '') +
        duplicateNote,
      listedTwiceInOneTable,
    }
  }
  if (dated.length > 0) {
    return {
      candidates,
      assessment: 'month_hint_only',
      note:
        `the student appears in no batch table; only the Tracker Master batch date (${hintTexts.join(', ')}) ` +
        `points at ${dated.length} batch${dated.length === 1 ? '' : 'es'}, which cannot tell Morning from Evening`,
      listedTwiceInOneTable,
    }
  }
  return {
    candidates,
    assessment: 'genuinely_unresolved',
    note:
      hintTexts.length > 0
        ? `the student appears in no batch table and the Tracker Master batch date (${hintTexts.join(', ')}) matches no batch`
        : 'the student appears in no batch table and Tracker Master states no batch date',
    listedTwiceInOneTable,
  }
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/**
 * Whether a batch is the month and year a Tracker Master Batch cell names.
 *
 * The cell text is `Mon-YY`. A batch matches on its start date's month and
 * year. Where the importer refused to invent a start date, the workbook
 * sheet the batch came from still states a month and a year ("Dec 2025",
 * "Jan 2026", "March 26"), and that is what is compared; only a batch with
 * no sheet name falls back to its own name, which may state no year at all
 * ("December - Evening") and then matches any year. Never used to assign.
 */
export function batchMatchesMonthText(
  batch: { name: string; start_date: string | null; legacy_sheet_name?: string | null },
  text: string,
): boolean {
  const match = /^([A-Za-z]{3,9})[-\s']+(\d{2,4})$/.exec(text.trim())
  if (!match) return false
  const month = MONTH_NAMES.findIndex((name) => name.startsWith(match[1].toLowerCase().slice(0, 3)))
  if (month === -1) return false
  const yearDigits = match[2].slice(-2)

  if (batch.start_date !== null) {
    return (
      batch.start_date.slice(5, 7) === String(month + 1).padStart(2, '0') &&
      batch.start_date.slice(2, 4) === yearDigits
    )
  }

  const stated = (batch.legacy_sheet_name?.trim() || batch.name).toLowerCase()
  const full = MONTH_NAMES[month]
  if (!new RegExp(`\\b(?:${full}|${full.slice(0, 3)})\\b`).test(stated)) return false
  const yearStated = /\b(\d{2,4})\b/.exec(stated)
  return yearStated === null || yearStated[1].slice(-2) === yearDigits
}

// -----------------------------------------------------------------------------
// Identity of a number-less student
// -----------------------------------------------------------------------------

export interface IdentityInput {
  studentNumber: string | null
  /** The name the record's own source row spells. */
  sourceName: string | null
  /** Contact fields the import could have carried. Presence only. */
  email: string | null
  phone: string | null
  /** Every numbered student, with every spelling the workbook holds for them. */
  numberedStudents: readonly { studentId: string; studentNumber: string; names: readonly string[] }[]
  /** The other number-less records, so two of them spelling one name can be reported. */
  unresolvedPeers?: readonly { financeRecordId: string; sourceName: string | null }[]
}

export interface IdentityFinding {
  status: 'numbered' | 'exact_name_match' | 'several_exact_name_matches' | 'unresolved'
  /** Numbered students whose name folds to exactly the same string. Report only. */
  exactMatches: { studentId: string; studentNumber: string; name: string }[]
  /**
   * Other number-less records whose source row spells exactly the same name.
   * Two such rows may be one person paying twice or two people; the data
   * cannot say, and this lists them for a human without joining them.
   */
  exactUnresolvedPeers: string[]
  hasContactIdentifier: boolean
  note: string
}

/**
 * A name reduced to a comparison form: trimmed, inner whitespace collapsed,
 * case folded. An exact-match aid for reporting only. Never a merge key.
 */
export function nameFold(value: string | null): string | null {
  if (value === null) return null
  const folded = value.replace(/\s+/g, ' ').trim().toLowerCase()
  return folded === '' ? null : folded
}

/**
 * What the evidence says about a number-less student. Reports, never merges:
 * an exact spelling match is listed so a person can look, and nothing here
 * calls two rows the same person.
 */
export function assessIdentity(input: IdentityInput): IdentityFinding {
  const hasContactIdentifier = Boolean(input.email?.trim()) || Boolean(input.phone?.trim())

  if (input.studentNumber !== null) {
    return { status: 'numbered', exactMatches: [], exactUnresolvedPeers: [], hasContactIdentifier, note: 'the record carries a student number' }
  }

  const folded = nameFold(input.sourceName)
  const exactMatches: IdentityFinding['exactMatches'] = []
  const exactUnresolvedPeers: string[] = []
  if (folded !== null) {
    for (const student of input.numberedStudents) {
      const hit = student.names.find((name) => nameFold(name) === folded)
      if (hit !== undefined) {
        exactMatches.push({ studentId: student.studentId, studentNumber: student.studentNumber, name: hit })
      }
    }
    for (const peer of input.unresolvedPeers ?? []) {
      if (nameFold(peer.sourceName) === folded) exactUnresolvedPeers.push(peer.financeRecordId)
    }
  }
  const peerNote =
    exactUnresolvedPeers.length === 0
      ? ''
      : `; ${exactUnresolvedPeers.length} other number-less record${exactUnresolvedPeers.length === 1 ? '' : 's'} spell${exactUnresolvedPeers.length === 1 ? 's' : ''} the same name, which the data cannot resolve into one person or two`

  if (exactMatches.length === 1) {
    return {
      status: 'exact_name_match',
      exactMatches,
      exactUnresolvedPeers,
      hasContactIdentifier,
      note: 'one numbered student spells the same name exactly; evidence for a person to check, not a merge' + peerNote,
    }
  }
  if (exactMatches.length > 1) {
    return {
      status: 'several_exact_name_matches',
      exactMatches,
      exactUnresolvedPeers,
      hasContactIdentifier,
      note: `${exactMatches.length} numbered students spell the same name exactly; identity stays unresolved` + peerNote,
    }
  }
  return {
    status: 'unresolved',
    exactMatches,
    exactUnresolvedPeers,
    hasContactIdentifier,
    note:
      folded === null
        ? 'the source row states no name and no number'
        : 'no numbered student spells this name exactly' + (hasContactIdentifier ? '' : '; no email or phone was imported') + peerNote,
  }
}

// -----------------------------------------------------------------------------
// The UI path, stage by stage
// -----------------------------------------------------------------------------

export interface StageInput {
  database: readonly string[]
  loader: readonly string[] | null
  viewModel: readonly string[] | null
  /** Rendered transaction rows in the drawer. Count only; the DOM carries no ids. */
  browserRows: number | null
}

export interface StageLosses {
  database: number
  loader: number | null
  viewModel: number | null
  browser: number | null
  lostAtLoader: string[]
  lostAtViewModel: string[]
  lostAtBrowser: number | null
  /** Payments in the database that any measured stage failed to carry. */
  unexplainedLoss: number
}

/** Counts losses at each stage a payment passes through on its way to the screen. */
export function stageLosses(input: StageInput): StageLosses {
  const database = new Set(input.database)
  const loader = input.loader === null ? null : new Set(input.loader)
  const viewModel = input.viewModel === null ? null : new Set(input.viewModel)

  const lostAtLoader = loader === null ? [] : [...database].filter((id) => !loader.has(id))
  const lostAtViewModel = viewModel === null ? [] : [...(loader ?? database)].filter((id) => !viewModel.has(id))
  const upstream = viewModel?.size ?? loader?.size ?? database.size
  const lostAtBrowser = input.browserRows === null ? null : Math.max(0, upstream - input.browserRows)

  return {
    database: database.size,
    loader: loader?.size ?? null,
    viewModel: viewModel?.size ?? null,
    browser: input.browserRows,
    lostAtLoader,
    lostAtViewModel,
    lostAtBrowser,
    unexplainedLoss: lostAtLoader.length + lostAtViewModel.length + (lostAtBrowser ?? 0),
  }
}

// -----------------------------------------------------------------------------

export function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}
