/**
 * FINANCE-RECONCILE-04A — read-only forensics of the unassigned finance records.
 *
 *   npm run finance:unassigned-audit
 *   FINANCE_QA_BASE_URL=http://localhost:3000 npm run finance:unassigned-audit
 *
 * For every `student_finance_records` row with `batch_id IS NULL` this
 * establishes, from evidence rather than assumption:
 *
 *   * what the hosted database holds for it — student, figures, payments,
 *     installments — read under an authenticated admin session with Row
 *     Level Security enforced, never the service role;
 *   * which Tracker Master rows the approved import plan tied to it, why the
 *     batch stayed null, and whether a row became a payment or an exception,
 *     by rebuilding the plan from the approved workbook and joining on the
 *     importer's own deterministic ids;
 *   * where its payments go on the way to the screen — the real `load.ts`
 *     run under Node, the view model it builds, and, when a local dev server
 *     is reachable, the details drawer as headless Chrome renders it;
 *   * what evidence exists for a batch and for an identity, graded but never
 *     acted on.
 *
 * It proves payment conservation across all 1,013 rows, reconciles the
 * import's transaction-level routing counts with the record-level count, and
 * verifies the hosted counts are unchanged when it finishes.
 *
 * It writes nothing to Supabase. Row-level output — names, numbers, amounts —
 * goes only to Git-ignored files under `.private/finance-qa/`; the console and
 * the aggregate file carry counts only.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { APPROVED_WORKBOOK_SHA256 } from '../finance-import/importer/apply-preflight.mts'
import { discoverBatchTables } from '../finance-import/importer/batch-tables.mts'
import { entityId } from '../finance-import/importer/deterministic-ids.mts'
import { buildDryRunPlan, type DryRunPlan } from '../finance-import/importer/plan.mts'
import { batchSourceKey } from '../finance-import/importer/source-keys.mts'
import { serialToISODate, usesDate1904 } from '../finance-import/lib/excel-values.mts'
import { hashWorkbookOnDisk, openWorkbook } from '../finance-import/lib/workbook-source.mts'
import { readEnvironment } from '../finance-import/importer/supabase-write.mts'

import { resolveStudentName } from '../../src/lib/finance/grid/student-name.ts'
import type { FinanceGridView } from '../../src/lib/finance/grid/types.ts'
import {
  buildFinanceGrid,
  type RawFinanceRecord,
  type RawInstallment,
  type RawPayment,
} from '../../src/lib/finance/grid/view-model.ts'

import { Cdp, launchChrome, Page, sleep } from './headless-chrome.mts'
import { countRows, readLoaderProjection, selectAll, type HostedBatch, type HostedProgram } from './hosted-reads.mts'
import { openHostedSession, sessionCookies, type HostedSession } from './hosted-session.mts'
import {
  assessBatchEvidence,
  assessIdentity,
  bucketPaymentCounts,
  classifyOrigin,
  conservePayments,
  countBy,
  reconcileRouting,
  stageLosses,
  type BatchEvidence,
  type IdentityFinding,
  type Origin,
  type PlannedRow,
  type StageLosses,
} from './unassigned-forensics.mts'

const PRIVATE_DIR = path.join('.private', 'finance-qa')
const SHOTS = path.join(PRIVATE_DIR, 'screenshots')
const BASE_URL = process.env.FINANCE_QA_BASE_URL ?? 'http://localhost:3000'

/** The tables whose counts must be identical before and after. */
const INTEGRITY_TABLES = [
  'batches',
  'students',
  'student_finance_records',
  'installments',
  'payments',
  'receipts',
  'receipt_deliveries',
  'reminder_deliveries',
  'import_batches',
  'import_exceptions',
  'audit_log',
] as const

// -----------------------------------------------------------------------------
// Hosted shapes
// -----------------------------------------------------------------------------

interface HostedRecord extends RawFinanceRecord {
  program_id: string
  legacy_source_sheet: string | null
}

interface HostedStudent {
  id: string
  student_number: string | null
  first_name: string | null
  middle_name: string | null
  last_name: string | null
  display_name: string | null
  legacy_name: string | null
  email: string | null
  phone: string | null
  legacy_source: string | null
}

/** The private-path projection of a payment: provenance included. */
interface HostedPaymentProvenance {
  id: string
  student_finance_record_id: string
  legacy_source_sheet: string | null
  legacy_source_row: number | null
  legacy_raw_json: Record<string, unknown> | null
}

interface HostedException {
  id: string
  source_sheet: string | null
  source_row: number | null
  entity_type: string | null
  reason: string
  source_key: string
  resolved: boolean
  legacy_raw_json: Record<string, unknown>
}

interface Hosted {
  programs: HostedProgram[]
  batches: HostedBatch[]
  records: HostedRecord[]
  installments: RawInstallment[]
  payments: RawPayment[]
  students: HostedStudent[]
  exceptions: HostedException[]
  unassignedPaymentProvenance: HostedPaymentProvenance[]
}

async function readHosted(session: HostedSession, repoRoot: string): Promise<Hosted> {
  const projection = readLoaderProjection(repoRoot)
  const { client } = session

  const programs = await selectAll<HostedProgram>(client, 'programs', 'id, name, short_code', 'short_code')
  const batches = await selectAll<HostedBatch>(
    client,
    'batches',
    'id, program_id, name, code, legacy_sheet_name, start_date, active',
    'code',
  )
  // The loader's projection plus `program_id` and the source sheet: a
  // superset, read so the audit can say where a record came from.
  const records = await selectAll<HostedRecord>(
    client,
    'student_finance_records',
    `${projection.records}, program_id, legacy_source_sheet`,
    'id',
  )
  const installments = await selectAll<RawInstallment>(client, 'installments', projection.installments, 'id')
  const payments = await selectAll<RawPayment>(client, 'payments', projection.payments, 'id')
  const students = await selectAll<HostedStudent>(
    client,
    'students',
    'id, student_number, first_name, middle_name, last_name, display_name, legacy_name, email, phone, legacy_source',
    'id',
  )
  const exceptions = await selectAll<HostedException>(
    client,
    'import_exceptions',
    'id, source_sheet, source_row, entity_type, reason, source_key, resolved, legacy_raw_json',
    'id',
  )

  // The one place the full payment payload is read: the private QA path,
  // for the unassigned records' payments only, so each can be traced to its
  // Tracker Master row and routing note. Never forwarded anywhere.
  const unassignedIds = records.filter((record) => record.batch_id === null).map((record) => record.id)
  const provenance =
    unassignedIds.length === 0
      ? { data: [] as HostedPaymentProvenance[], error: null }
      : await client
          .from('payments')
          .select('id, student_finance_record_id, legacy_source_sheet, legacy_source_row, legacy_raw_json')
          .in('student_finance_record_id', unassignedIds)
          .order('id')
  if (provenance.error) throw new Error(`read payment provenance: ${provenance.error.message}`)

  return {
    programs,
    batches,
    records,
    installments,
    payments,
    students,
    exceptions,
    unassignedPaymentProvenance: (provenance.data ?? []) as HostedPaymentProvenance[],
  }
}

async function integrityCounts(session: HostedSession): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of INTEGRITY_TABLES) out[table] = await countRows(session.client, table)
  return out
}

// -----------------------------------------------------------------------------
// Per-record forensics
// -----------------------------------------------------------------------------

interface TrackerRowTrace {
  sourceRow: number
  routing: string
  routingNote: string
  plansPayment: boolean
  unresolved: string | null
  amount: number | null
  paymentDate: string | null
  paymentMethod: string | null
  receiptSent: string | null
  programLabel: string | null
  programInferred: boolean
  batchHint: { text: string | null; serial: unknown; iso: string | null }
  studentIdCell: { raw: unknown; text: string | null; cellType: string | null }
  studentName: string | null
  /** The id the payment row got, and whether the hosted table holds it. */
  hostedPaymentId: string
  hostedPaymentFound: boolean
  /** For an amount-less row: the exception that stands in for it. */
  hostedExceptionId: string | null
  hostedExceptionFound: boolean
}

interface HostedPaymentTrace {
  id: string
  amount: string | null
  date: string | null
  method: string | null
  receiptSent: string | null
  note: string | null
  voided: boolean
  sourceSheet: string | null
  sourceRow: number | null
  routing: string | null
  batchHintText: string | null
  /** Whether the approved plan planned exactly this payment for this record. */
  inPlan: boolean
}

interface BrowserStage {
  ran: boolean
  reason?: string
  gridRow?: { number: string; name: string; recordId: string | null; paymentCountAttribute: string | null; cells: string[] }
  drawer?: {
    title: string
    subtitle: string
    placement: string
    transactionRows: number
    summary: string | null
    emptyStatement: boolean
    screenshot?: string
  }
}

interface RecordForensics {
  financeRecordId: string
  studentId: string
  studentNumber: string | null
  studentName: string
  legacyName: string | null
  program: string
  batchId: null
  legacySourceSheet: string | null
  legacySourceRow: number | null
  legacyTotalFee: string | null
  legacyTotalPaid: string | null
  legacyBalance: string | null
  snapshot: {
    hasFee: boolean
    hasPaid: boolean
    hasBalance: boolean
    feeSource: string | null
    conflictingFeeValues: unknown
    /** Always false for an unassigned record: no batch-sheet row exists. */
    hasBatchSnapshot: boolean
  }
  unassignedReason: string | null
  plannedReason: string | null
  plannedSourceKey: string | null
  plannedRecordFound: boolean
  installmentCount: number
  paymentCount: number
  paymentTotal: number
  paymentDates: (string | null)[]
  paymentMethods: (string | null)[]
  legacyReceiptValues: (string | null)[]
  payments: HostedPaymentTrace[]
  trackerRows: TrackerRowTrace[]
  aggregatesSeveralRows: boolean
  origin: Origin
  batchEvidence: BatchEvidence
  identity: IdentityFinding
  ui: {
    stages: StageLosses
    loaderRawPaymentIds: string[] | null
    viewModelPaymentIds: string[] | null
    independentViewModelPaymentIds: string[]
    viewModelRow: { paymentCount: number; paymentTotal: unknown; receiptStatus: string; legacyFlags: string[] } | null
    browser: BrowserStage
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

// -----------------------------------------------------------------------------
// The real loader, under Node
// -----------------------------------------------------------------------------

interface LoaderRun {
  view: FinanceGridView
  /** The `payments` rows exactly as PostgREST returned them to the loader. */
  rawPayments: RawPayment[]
  restRequests: string[]
}

/**
 * Runs `src/lib/finance/grid/load.ts` as written, against hosted Supabase
 * under the QA admin session, with the module hooks `loader-request-count`
 * uses. The REST response for `payments` is captured on the way past so the
 * loader's own input can be compared with what its view model carries.
 */
async function runRealLoader(session: HostedSession, repoRoot: string, programShortCode: string): Promise<LoaderRun> {
  const env = readEnvironment(repoRoot)
  for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']) {
    if (env[name] && !process.env[name]) process.env[name] = env[name]
  }
  const cookieStore = globalThis as unknown as { __qaCookies?: { name: string; value: string }[] }
  cookieStore.__qaCookies = sessionCookies(session.projectRef, session.session)

  await import('./loader-request-count.hooks.mts')

  const rest = new URL('/rest/v1/', session.supabaseUrl).toString()
  const restRequests: string[] = []
  const rawPayments: RawPayment[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const response = await original(input, init)
    if (url.startsWith(rest)) {
      const parsed = new URL(url)
      const table = parsed.pathname.slice('/rest/v1/'.length)
      restRequests.push(`${table}?${[...parsed.searchParams.keys()].join(',')}`)
      if (table === 'payments' && response.ok) {
        const body = (await response.clone().json()) as RawPayment[]
        rawPayments.push(...body)
      }
    }
    return response
  }) as typeof fetch

  try {
    const { loadFinanceGrid } = await import('../../src/lib/finance/grid/load.ts')
    const view = await loadFinanceGrid({ program: programShortCode, intake: 'unassigned' })
    return { view, rawPayments, restRequests }
  } finally {
    globalThis.fetch = original
  }
}

// -----------------------------------------------------------------------------
// The browser
// -----------------------------------------------------------------------------

const GRID_ROWS_PROBE = `[...document.querySelectorAll('tbody tr')].map((tr) => {
  const cells = [...tr.querySelectorAll('td')]
  return {
    recordId: tr.dataset.recordId ?? null,
    paymentCountAttribute: tr.dataset.paymentCount ?? null,
    number: cells[1]?.textContent.trim() ?? '',
    name: cells[2]?.querySelector('button')?.textContent.trim() ?? '',
    cells: cells.map((td) => td.textContent.trim()),
  }
})`

const DRAWER_PROBE = `(() => {
  const dialog = document.querySelector('[role=dialog]')
  if (!dialog) return null
  const paragraphs = [...dialog.querySelectorAll('p')].map((p) => p.textContent.trim())
  return {
    title: dialog.querySelector('h2')?.textContent.trim() ?? '',
    subtitle: dialog.querySelector('h2 + p')?.textContent.trim() ?? '',
    placement: [...dialog.querySelectorAll('section:first-of-type dl > *')].map((node) => node.textContent.trim()).join(' | '),
    transactionRows: dialog.querySelectorAll('table tbody tr').length,
    summary: paragraphs.find((text) => /imported payment/.test(text)) ?? null,
    emptyStatement: paragraphs.some((text) => text.startsWith('No imported payment is tied to this record')),
  }
})()`

async function devServerReachable(): Promise<string | null> {
  try {
    const response = await fetch(`${BASE_URL}/login`, { redirect: 'manual' })
    return response.status >= 200 && response.status < 500 ? null : `GET ${BASE_URL}/login returned ${response.status}`
  } catch (error) {
    return `no dev server at ${BASE_URL} (${error instanceof Error ? error.message : String(error)})`
  }
}

/**
 * Opens the Unassigned view as the signed-in admin and, for every record,
 * opens the drawer and counts the transaction rows it renders. Screenshots
 * go to the private folder only.
 */
async function browserStage(
  session: HostedSession,
  repoRoot: string,
  programShortCode: string,
  recordIds: readonly string[],
): Promise<{ byRecord: Map<string, BrowserStage>; gridScreenshot: string | null; consoleErrors: string[]; reason: string | null }> {
  const byRecord = new Map<string, BrowserStage>()
  const unreachable = await devServerReachable()
  if (unreachable !== null) {
    for (const id of recordIds) byRecord.set(id, { ran: false, reason: unreachable })
    return { byRecord, gridScreenshot: null, consoleErrors: [], reason: unreachable }
  }

  mkdirSync(path.join(repoRoot, SHOTS), { recursive: true })
  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'finance-qa-chrome-'))
  const chrome = await launchChrome(profileDir)
  const cdp = await Cdp.connect(chrome.wsUrl)
  let gridScreenshot: string | null = null
  let consoleErrors: string[] = []

  try {
    const page = await Page.open(cdp, { baseUrl: BASE_URL, shotsDir: path.join(repoRoot, SHOTS) })
    await page.setCookies(sessionCookies(session.projectRef, session.session))
    await page.navigate(`${BASE_URL}/finance?program=${encodeURIComponent(programShortCode)}&intake=unassigned`)
    await page.waitFor(`document.querySelector('#finance-intake') && document.querySelector('table')`, 60_000, 'unassigned grid')
    await sleep(300)
    gridScreenshot = await page.screenshot('90-unassigned-grid-04a')

    const rows = await page.evaluate<{ recordId: string | null; paymentCountAttribute: string | null; number: string; name: string; cells: string[] }[]>(GRID_ROWS_PROBE)
    const indexByRecord = new Map(rows.map((row, index) => [row.recordId, index]))

    let shot = 0
    for (const id of recordIds) {
      const index = indexByRecord.get(id)
      if (index === undefined) {
        byRecord.set(id, { ran: true, reason: 'no grid row carries this record id' })
        continue
      }
      const gridRow = rows[index]
      await page.click('tbody tr td:nth-child(3) button', index)
      await page.waitFor(`document.querySelector('[role=dialog]')`, 5_000, 'drawer')
      await sleep(150)
      const drawer = await page.evaluate<NonNullable<BrowserStage['drawer']>>(DRAWER_PROBE)
      // One drawer screenshot per record, private. Numbered so the folder
      // reads in grid order; the file name carries no student detail.
      const screenshot = await page.screenshot(`91-unassigned-drawer-04a-${String(++shot).padStart(2, '0')}`)
      byRecord.set(id, { ran: true, gridRow, drawer: { ...drawer, screenshot } })
      await page.pressKey('Escape', 'Escape', 27)
      await page.waitFor(`!document.querySelector('[role=dialog]')`, 5_000, 'drawer closed')
    }
    consoleErrors = page.consoleErrors.filter((entry) => !/extension|chrome-extension/i.test(entry))
  } finally {
    cdp.close()
    chrome.process.kill()
    await sleep(500)
    rmSync(profileDir, { recursive: true, force: true })
  }

  return { byRecord, gridScreenshot, consoleErrors, reason: null }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

async function main(): Promise<number> {
  const repoRoot = repoRootFromHere()
  const now = new Date()

  // --- Workbook and the approved plan ----------------------------------------
  const source = openWorkbook(repoRoot, now)
  const hash = source.fingerprint.sha256
  console.log(`workbook: ${source.fingerprint.relativePath}`)
  console.log(`sha256:   ${hash}`)
  if (hash !== APPROVED_WORKBOOK_SHA256) {
    console.error('STOP: workbook hash differs from the approved import hash')
    return 2
  }
  const date1904 = usesDate1904(source.workbook)
  const plan: DryRunPlan = buildDryRunPlan(repoRoot, now)
  const discovery = discoverBatchTables(source.workbook)

  // --- Hosted, authenticated, RLS --------------------------------------------
  const session = await openHostedSession(repoRoot)
  console.log(`hosted:   project ${session.projectRef}, app role ${session.appRole ?? 'unknown'} (RLS enforced)`)
  const countsBefore = await integrityCounts(session)
  console.log(`before:   ${JSON.stringify(countsBefore)}`)

  const hosted = await readHosted(session, repoRoot)
  const programById = new Map(hosted.programs.map((program) => [program.id, program]))
  const batchById = new Map(hosted.batches.map((batch) => [batch.id, batch]))
  const unassignedRecords = hosted.records.filter((record) => record.batch_id === null)
  const unassignedIds = new Set(unassignedRecords.map((record) => record.id))

  // --- Conservation ----------------------------------------------------------
  const conservation = conservePayments({ payments: hosted.payments, records: hosted.records })

  // --- Plan-side indexes -----------------------------------------------------
  const plannedRecordById = new Map(plan.financeRecords.map((record) => [entityId(record.sourceKey), record]))
  const plannedPaymentsByRecordId = new Map<string, DryRunPlan['payments']>()
  for (const payment of plan.payments) {
    if (payment.financeRecordSourceKey === null) continue
    const id = entityId(payment.financeRecordSourceKey)
    const list = plannedPaymentsByRecordId.get(id) ?? []
    list.push(payment)
    plannedPaymentsByRecordId.set(id, list)
  }
  const exceptionByWouldBeKey = new Map(
    plan.importExceptions.map((exception) => [
      asString(exception.legacyRawJson.would_be_entity_source_key),
      exception,
    ]),
  )
  const hostedPaymentIds = new Set(hosted.payments.map((payment) => payment.id))
  const hostedExceptionIds = new Set(hosted.exceptions.map((exception) => exception.id))

  // Where each numbered student appears in a batch table, with the hosted batch.
  const appearances = new Map<string, { batch: HostedBatch; sheetName: string; tableKey: string; sourceRow: number; program: string }[]>()
  for (const entry of discovery.supported) {
    const batch = batchById.get(entityId(batchSourceKey(hash, entry.table.sheetName, entry.table.key)))
    if (!batch) continue
    for (const row of entry.table.rows) {
      if (row.kind !== 'student' || row.studentNumber === null) continue
      const list = appearances.get(row.studentNumber) ?? []
      list.push({ batch, sheetName: entry.table.sheetName, tableKey: entry.table.key, sourceRow: row.row, program: entry.programShortCode })
      appearances.set(row.studentNumber, list)
    }
  }

  // Every spelling the workbook holds for each numbered student, for the
  // exact-name identity report. Hosted names are included so the comparison
  // covers what staff actually see.
  const hostedStudentById = new Map(hosted.students.map((student) => [student.id, student]))
  const namesByNumber = new Map<string, Set<string>>()
  for (const student of plan.students) {
    if (student.studentNumber === null) continue
    const names = namesByNumber.get(student.studentNumber) ?? new Set<string>()
    for (const variant of student.nameVariants) names.add(variant.value)
    if (student.legacyDisplayName) names.add(student.legacyDisplayName)
    namesByNumber.set(student.studentNumber, names)
  }
  const numberedStudents = hosted.students
    .filter((student) => student.student_number !== null && student.student_number.trim() !== '')
    .map((student) => ({
      studentId: student.id,
      studentNumber: student.student_number as string,
      names: [
        ...(namesByNumber.get(student.student_number as string) ?? []),
        ...[student.display_name, student.legacy_name, resolveStudentName(student)].filter((name): name is string => Boolean(name)),
      ],
    }))

  const hostedPaymentsByRecord = new Map<string, RawPayment[]>()
  for (const payment of hosted.payments) {
    const list = hostedPaymentsByRecord.get(payment.student_finance_record_id) ?? []
    list.push(payment)
    hostedPaymentsByRecord.set(payment.student_finance_record_id, list)
  }
  const provenanceById = new Map(hosted.unassignedPaymentProvenance.map((payment) => [payment.id, payment]))
  const installmentsByRecord = countBy(hosted.installments.map((installment) => installment.student_finance_record_id))

  // --- The UI path -----------------------------------------------------------
  // Programs with unassigned records; the loader is run once per program.
  const programsWithUnassigned = [...new Set(unassignedRecords.map((record) => record.program_id))]
    .map((id) => programById.get(id))
    .filter((program): program is HostedProgram => program !== undefined)

  const loaderRuns = new Map<string, LoaderRun>()
  for (const program of programsWithUnassigned) {
    loaderRuns.set(program.short_code, await runRealLoader(session, repoRoot, program.short_code))
  }

  // An independent build of the same view model from the QA reads, so a
  // discrepancy between loader and view model can be attributed.
  const independentRows = new Map<string, string[]>()
  for (const program of programsWithUnassigned) {
    const records = unassignedRecords.filter((record) => record.program_id === program.id)
    const ids = new Set(records.map((record) => record.id))
    const built = buildFinanceGrid({
      records,
      installments: hosted.installments.filter((row) => ids.has(row.student_finance_record_id)),
      payments: hosted.payments.filter((row) => ids.has(row.student_finance_record_id)),
      manifest: [],
      programShortCode: program.short_code,
      batchName: null,
    })
    for (const row of built.rows) independentRows.set(row.financeRecordId, row.payments.map((payment) => payment.id))
  }

  const browser = await browserStage(
    session,
    repoRoot,
    programsWithUnassigned[0]?.short_code ?? 'PSW',
    unassignedRecords.map((record) => record.id),
  )

  // --- Per record ------------------------------------------------------------
  const forensics: RecordForensics[] = []

  for (const record of unassignedRecords) {
    const program = programById.get(record.program_id)?.short_code ?? 'unknown'
    const raw = asRecord(record.legacy_raw_json)
    const planned = plannedRecordById.get(record.id) ?? null
    const plannedRaw = asRecord(planned?.legacyRawJson)
    const studentNumber = record.student?.student_number?.trim() || null
    const hostedStudent = hostedStudentById.get(record.student_id) ?? null

    const payments = hostedPaymentsByRecord.get(record.id) ?? []
    const plannedPayments = plannedPaymentsByRecordId.get(record.id) ?? []
    const plannedPaymentIds = new Set(plannedPayments.filter((payment) => payment.plansPayment).map((payment) => entityId(payment.sourceKey)))

    const paymentTraces: HostedPaymentTrace[] = payments.map((payment) => {
      const provenance = asRecord(provenanceById.get(payment.id)?.legacy_raw_json)
      return {
        id: payment.id,
        amount: payment.amount,
        date: payment.payment_date,
        method: payment.payment_method,
        receiptSent: payment.legacy_receipt_sent,
        note: payment.note,
        voided: payment.voided_at !== null,
        sourceSheet: provenanceById.get(payment.id)?.legacy_source_sheet ?? null,
        sourceRow: provenanceById.get(payment.id)?.legacy_source_row ?? null,
        routing: asString(asRecord(provenance.routing).outcome),
        batchHintText: asString(asRecord(provenance.batch).formatted_text),
        inPlan: plannedPaymentIds.has(payment.id),
      }
    })

    const trackerRows: TrackerRowTrace[] = plannedPayments.map((payment) => {
      const rawJson = payment.legacyRawJson
      const batch = asRecord(rawJson.batch)
      const serial = batch.raw_value
      const studentIdCell = asRecord(rawJson.student_id)
      const exception = payment.unresolved === null ? null : (exceptionByWouldBeKey.get(payment.sourceKey) ?? null)
      const hostedPaymentId = entityId(payment.sourceKey)
      const hostedExceptionId = exception === null ? null : entityId(exception.sourceKey)
      return {
        sourceRow: payment.legacySourceRow,
        routing: payment.routing,
        routingNote: payment.routingNote,
        plansPayment: payment.plansPayment,
        unresolved: payment.unresolved,
        amount: payment.amount,
        paymentDate: payment.paymentDate,
        paymentMethod: payment.paymentMethod,
        receiptSent: asString(rawJson.receipt_sent),
        programLabel: payment.sourceProgramLabel,
        programInferred: payment.programInferred,
        batchHint: {
          text: asString(batch.formatted_text),
          serial,
          iso: typeof serial === 'number' ? serialToISODate(serial, date1904) : null,
        },
        studentIdCell: {
          raw: studentIdCell.raw_value ?? null,
          text: asString(studentIdCell.formatted_text),
          cellType: asString(studentIdCell.cell_type),
        },
        studentName: asString(rawJson.student_name),
        hostedPaymentId,
        hostedPaymentFound: payment.plansPayment && hostedPaymentIds.has(hostedPaymentId),
        hostedExceptionId,
        hostedExceptionFound: hostedExceptionId !== null && hostedExceptionIds.has(hostedExceptionId),
      }
    })

    const hasFee = record.legacy_total_fee !== null
    const hasPaid = record.legacy_total_paid !== null
    const hasBalance = record.legacy_balance !== null
    const unassignedReason = asString(raw.unassigned_reason)
    const plannedReason = asString(plannedRaw.unassigned_reason)

    // UI stages.
    const loaderRun = loaderRuns.get(program) ?? null
    const loaderRawPaymentIds = loaderRun === null ? null : loaderRun.rawPayments.filter((payment) => payment.student_finance_record_id === record.id).map((payment) => payment.id)
    const viewRow = loaderRun?.view.rows.find((row) => row.financeRecordId === record.id) ?? null
    const viewModelPaymentIds = loaderRun === null ? null : (viewRow?.payments.map((payment) => payment.id) ?? [])
    const browserResult = browser.byRecord.get(record.id) ?? { ran: false, reason: 'not attempted' }
    const stages = stageLosses({
      database: payments.map((payment) => payment.id),
      loader: loaderRawPaymentIds,
      viewModel: viewModelPaymentIds,
      browserRows: browserResult.ran && browserResult.drawer ? browserResult.drawer.transactionRows : null,
    })

    const plannedPaymentCount = plannedPayments.filter((payment) => payment.plansPayment).length
    const origin = classifyOrigin({
      studentNumber,
      unassignedReason,
      paymentCount: payments.length,
      plannedRows: plannedPayments.length,
      plannedPaymentRows: plannedPaymentCount,
      plannedExceptionRows: plannedPayments.length - plannedPaymentCount,
      hasBatchSnapshot: record.legacy_source_sheet !== null || record.legacy_source_row !== null,
      hasFee,
      hasPaid,
      hasBalance,
      paymentCountDisagreesWithPlan: plannedPaymentCount !== payments.length || paymentTraces.some((payment) => !payment.inPlan),
      reasonDisagreesWithPlan: planned === null || unassignedReason !== plannedReason,
      uiLoss: stages.unexplainedLoss > 0,
      hasAnyIdentity:
        studentNumber !== null ||
        trackerRows.some((row) => row.studentName !== null) ||
        Boolean(hostedStudent?.legacy_name?.trim()) ||
        Boolean(hostedStudent?.display_name?.trim()),
    })

    const batchEvidence = assessBatchEvidence({
      studentNumber,
      appearances: (studentNumber === null ? [] : (appearances.get(studentNumber) ?? [])).filter((entry) => entry.program === program),
      trackerHints: trackerRows.map((row) => ({ text: row.batchHint.text, iso: row.batchHint.iso })),
      programBatches: hosted.batches.filter((batch) => programById.get(batch.program_id)?.short_code === program),
    })

    const sourceNameOf = (candidate: HostedRecord): string | null =>
      (plannedPaymentsByRecordId.get(candidate.id) ?? [])
        .map((payment) => asString(payment.legacyRawJson.student_name))
        .find((name) => name !== null) ??
      hostedStudentById.get(candidate.student_id)?.legacy_name ??
      null
    const identity = assessIdentity({
      studentNumber,
      sourceName: sourceNameOf(record),
      email: hostedStudent?.email ?? null,
      phone: hostedStudent?.phone ?? null,
      numberedStudents,
      unresolvedPeers: unassignedRecords
        .filter((other) => other.id !== record.id && !(other.student?.student_number?.trim()))
        .map((other) => ({ financeRecordId: other.id, sourceName: sourceNameOf(other) })),
    })

    forensics.push({
      financeRecordId: record.id,
      studentId: record.student_id,
      studentNumber,
      studentName: record.student ? resolveStudentName(record.student) : 'Unnamed student',
      legacyName: record.student?.legacy_name ?? null,
      program,
      batchId: null,
      legacySourceSheet: record.legacy_source_sheet,
      legacySourceRow: record.legacy_source_row,
      legacyTotalFee: record.legacy_total_fee,
      legacyTotalPaid: record.legacy_total_paid,
      legacyBalance: record.legacy_balance,
      snapshot: {
        hasFee,
        hasPaid,
        hasBalance,
        feeSource: asString(raw.legacy_total_fee_note),
        conflictingFeeValues: raw.conflicting_total_fee_values ?? null,
        hasBatchSnapshot: record.legacy_source_sheet !== null || record.legacy_source_row !== null,
      },
      unassignedReason,
      plannedReason,
      plannedSourceKey: planned?.sourceKey ?? null,
      plannedRecordFound: planned !== null && planned.kind === 'unassigned',
      installmentCount: installmentsByRecord[record.id] ?? 0,
      paymentCount: payments.length,
      paymentTotal: payments.reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0),
      paymentDates: payments.map((payment) => payment.payment_date),
      paymentMethods: payments.map((payment) => payment.payment_method),
      legacyReceiptValues: payments.map((payment) => payment.legacy_receipt_sent),
      payments: paymentTraces,
      trackerRows,
      aggregatesSeveralRows: plannedPayments.length >= 2,
      origin,
      batchEvidence,
      identity,
      ui: {
        stages,
        loaderRawPaymentIds,
        viewModelPaymentIds,
        independentViewModelPaymentIds: independentRows.get(record.id) ?? [],
        viewModelRow:
          viewRow === null
            ? null
            : { paymentCount: viewRow.paymentCount, paymentTotal: viewRow.paymentTotal, receiptStatus: viewRow.receiptStatus, legacyFlags: viewRow.legacyFlags },
        browser: browserResult,
      },
    })
  }

  // --- Routing: transaction rows versus records -----------------------------
  const plannedRows: PlannedRow[] = plan.payments.map((payment) => ({
    sourceRow: payment.legacySourceRow,
    routing: payment.routing,
    plansPayment: payment.plansPayment,
    unresolved: payment.unresolved,
    financeRecordId: payment.financeRecordSourceKey === null ? null : entityId(payment.financeRecordSourceKey),
  }))
  const routing = reconcileRouting(plannedRows, unassignedIds)

  // --- Aggregates (no PII) ---------------------------------------------------
  const unassignedPayments = forensics.reduce((sum, record) => sum + record.paymentCount, 0)
  const buckets = bucketPaymentCounts(forensics.map((record) => record.paymentCount))
  const firstRun = loaderRuns.get(programsWithUnassigned[0]?.short_code ?? '') ?? null
  const loaderView = firstRun?.view ?? null

  const aggregate = {
    runAt: now.toISOString(),
    branch: process.env.GIT_BRANCH ?? null,
    workbookHash: hash,
    projectRef: session.projectRef,
    sessionRole: session.appRole,
    hostedCountsBefore: countsBefore,
    unassigned: {
      records: forensics.length,
      uniqueStudents: new Set(forensics.map((record) => record.studentId)).size,
      numberedStudents: forensics.filter((record) => record.studentNumber !== null).length,
      unresolvedStudents: forensics.filter((record) => record.studentNumber === null).length,
      byProgram: countBy(forensics.map((record) => record.program)),
      recordsWithZeroPayments: buckets.zero,
      recordsWithOnePayment: buckets.one,
      recordsWithTwoOrMorePayments: buckets.twoPlus,
      totalLinkedPayments: unassignedPayments,
      installmentsLinked: forensics.reduce((sum, record) => sum + record.installmentCount, 0),
      recordsWithFee: forensics.filter((record) => record.snapshot.hasFee).length,
      recordsWithPaid: forensics.filter((record) => record.snapshot.hasPaid).length,
      recordsWithBalance: forensics.filter((record) => record.snapshot.hasBalance).length,
      recordsWithBatchSnapshot: forensics.filter((record) => record.snapshot.hasBatchSnapshot).length,
      recordsWithNoFinancialFigures: forensics.filter(
        (record) => record.paymentCount === 0 && !record.snapshot.hasFee && !record.snapshot.hasPaid && !record.snapshot.hasBalance,
      ).length,
      recordsWithFeeButNoPayment: forensics.filter((record) => record.paymentCount === 0 && record.snapshot.hasFee).length,
      recordsWithConflictingFeeValues: forensics.filter((record) => Array.isArray(record.snapshot.conflictingFeeValues) && record.snapshot.conflictingFeeValues.length > 0).length,
      byReason: countBy(forensics.map((record) => record.unassignedReason ?? 'unknown')),
      reasonAgreesWithPlan: forensics.filter((record) => record.unassignedReason === record.plannedReason).length,
      plannedRecordFound: forensics.filter((record) => record.plannedRecordFound).length,
      recordsAggregatingSeveralRows: forensics.filter((record) => record.aggregatesSeveralRows).length,
      trackerRowsTraced: forensics.reduce((sum, record) => sum + record.trackerRows.length, 0),
      trackerRowsThatBecamePayments: forensics.reduce((sum, record) => sum + record.trackerRows.filter((row) => row.plansPayment).length, 0),
      trackerRowsPreservedAsExceptions: forensics.reduce((sum, record) => sum + record.trackerRows.filter((row) => !row.plansPayment).length, 0),
      trackerPaymentRowsFoundHosted: forensics.reduce((sum, record) => sum + record.trackerRows.filter((row) => row.hostedPaymentFound).length, 0),
      trackerExceptionRowsFoundHosted: forensics.reduce((sum, record) => sum + record.trackerRows.filter((row) => row.hostedExceptionFound).length, 0),
      hostedPaymentsInPlan: forensics.reduce((sum, record) => sum + record.payments.filter((payment) => payment.inPlan).length, 0),
      hostedPaymentsNotInPlan: forensics.reduce((sum, record) => sum + record.payments.filter((payment) => !payment.inPlan).length, 0),
      voidedPayments: forensics.reduce((sum, record) => sum + record.payments.filter((payment) => payment.voided).length, 0),
      receiptValues: countBy(forensics.flatMap((record) => record.legacyReceiptValues.map((value) => value?.trim() || '(blank)'))),
      paymentMethods: countBy(forensics.flatMap((record) => record.paymentMethods.map((value) => value?.trim() || '(blank)'))),
      paymentsWithNoReadableDate: forensics.reduce((sum, record) => sum + record.paymentDates.filter((date) => date === null).length, 0),
      originCategories: countBy(forensics.map((record) => record.origin.categories.join('+'))),
      originCategoryCounts: countBy(forensics.flatMap((record) => record.origin.categories)),
      importerAnomalies: forensics.filter((record) => record.origin.categories.includes('E')).length,
      uiAnomalies: forensics.filter((record) => record.origin.categories.includes('F')).length,
      batchAssessment: countBy(forensics.map((record) => record.batchEvidence.assessment)),
      candidateStrengths: countBy(forensics.flatMap((record) => record.batchEvidence.candidates.map((candidate) => candidate.strength))),
      recordsWithStrongCandidates: forensics.filter((record) => record.batchEvidence.candidates.some((candidate) => candidate.strength === 'strong')).length,
      recordsListedTwiceInOneTable: forensics.filter((record) => record.batchEvidence.listedTwiceInOneTable).length,
      recordsWithNoIdentityAtAll: forensics.filter(
        (record) => record.studentNumber === null && record.trackerRows.every((row) => row.studentName === null) && !record.legacyName?.trim(),
      ).length,
      identity: countBy(forensics.map((record) => record.identity.status)),
      identityWithContactIdentifier: forensics.filter((record) => record.identity.hasContactIdentifier).length,
      unresolvedRecordsSharingAnExactNameWithAnotherUnresolvedRecord: forensics.filter((record) => record.identity.exactUnresolvedPeers.length > 0).length,
    },
    conservation,
    routing,
    exceptions: {
      hosted: hosted.exceptions.length,
      byReason: countBy(hosted.exceptions.map((exception) => exception.reason)),
      tiedToUnassignedRecord: forensics.filter((record) => record.trackerRows.some((row) => row.hostedExceptionFound)).length,
    },
    ui: {
      loader: loaderView === null
        ? null
        : {
            restRequests: firstRun?.restRequests ?? [],
            rawPaymentRows: firstRun?.rawPayments.length ?? 0,
            rows: loaderView.rows.length,
            layoutSource: loaderView.layoutSource,
            columns: loaderView.columns.length,
            scheduledColumns: loaderView.scheduledColumns.length,
            unassigned: loaderView.unassigned,
            unassignedCount: loaderView.unassignedCount,
            selectionNote: loaderView.selectionNote,
            truncated: loaderView.truncated,
            statusCounts: loaderView.statusCounts,
            balanceConvention: loaderView.balanceConvention.convention,
            totals: loaderView.totals,
          },
      loaderPayments: forensics.reduce((sum, record) => sum + (record.ui.stages.loader ?? 0), 0),
      viewModelPayments: forensics.reduce((sum, record) => sum + (record.ui.stages.viewModel ?? 0), 0),
      independentViewModelPayments: forensics.reduce((sum, record) => sum + record.ui.independentViewModelPaymentIds.length, 0),
      viewModelAgreesWithIndependentBuild: forensics.every(
        (record) =>
          record.ui.viewModelPaymentIds !== null &&
          [...record.ui.viewModelPaymentIds].sort().join() === [...record.ui.independentViewModelPaymentIds].sort().join(),
      ),
      browser: {
        ran: browser.reason === null,
        reason: browser.reason,
        baseUrl: BASE_URL,
        recordsOpened: forensics.filter((record) => record.ui.browser.ran && record.ui.browser.drawer).length,
        gridRowsStatingTheirPaymentCount: forensics.filter(
          (record) => record.ui.browser.gridRow?.paymentCountAttribute === String(record.paymentCount),
        ).length,
        transactionRows: forensics.reduce((sum, record) => sum + (record.ui.browser.drawer?.transactionRows ?? 0), 0),
        recordsShowingEmptyStatement: forensics.filter((record) => record.ui.browser.drawer?.emptyStatement === true).length,
        consoleErrors: browser.consoleErrors.length,
        gridScreenshot: browser.gridScreenshot,
      },
      lostAtLoader: forensics.reduce((sum, record) => sum + record.ui.stages.lostAtLoader.length, 0),
      lostAtViewModel: forensics.reduce((sum, record) => sum + record.ui.stages.lostAtViewModel.length, 0),
      lostAtBrowser: forensics.reduce((sum, record) => sum + (record.ui.stages.lostAtBrowser ?? 0), 0),
      unexplainedLoss: forensics.reduce((sum, record) => sum + record.ui.stages.unexplainedLoss, 0),
    },
    hostedCountsAfter: {} as Record<string, number>,
    countsUnchanged: false,
    workbookHashAfter: '',
  }

  // --- Outputs ---------------------------------------------------------------
  mkdirSync(path.join(repoRoot, PRIVATE_DIR), { recursive: true })
  const write = (name: string, value: unknown): string => {
    const target = path.join(repoRoot, PRIVATE_DIR, name)
    writeFileSync(target, `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`, 'utf8')
    return path.join(PRIVATE_DIR, name).split(path.sep).join('/')
  }

  // Integrity after every read is done. Then the aggregate is final.
  const countsAfter = await integrityCounts(session)
  aggregate.hostedCountsAfter = countsAfter
  aggregate.countsUnchanged = INTEGRITY_TABLES.every((table) => countsBefore[table] === countsAfter[table])
  await session.signOut()
  aggregate.workbookHashAfter = hashWorkbookOnDisk(repoRoot)

  const rowLevel = write('unassigned-forensics.json', { ...aggregate, records: forensics })
  const csv = write('unassigned-forensics.csv', toCsv(forensics))
  const aggregateText = renderAggregate(aggregate)
  const aggregatePath = write('unassigned-forensics-aggregate.md', aggregateText)

  console.log('')
  console.log(aggregateText)
  console.log(`wrote ${rowLevel} (Git-ignored, row level)`)
  console.log(`wrote ${csv} (Git-ignored, row level)`)
  console.log(`wrote ${aggregatePath} (Git-ignored copy of the aggregate above)`)

  if (aggregate.workbookHashAfter !== hash) {
    console.error(`WORKBOOK MODIFIED: hash before ${hash}, after ${aggregate.workbookHashAfter}`)
    return 3
  }
  if (!aggregate.countsUnchanged) {
    console.error('HOSTED COUNTS CHANGED during the audit')
    return 4
  }
  return conservation.conserved && aggregate.ui.unexplainedLoss === 0 ? 0 : 1
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

function toCsv(records: readonly RecordForensics[]): string {
  const columns: [string, (record: RecordForensics) => unknown][] = [
    ['finance_record_id', (r) => r.financeRecordId],
    ['student_id', (r) => r.studentId],
    ['student_number', (r) => r.studentNumber],
    ['student_name', (r) => r.studentName],
    ['program', (r) => r.program],
    ['legacy_total_fee', (r) => r.legacyTotalFee],
    ['legacy_total_paid', (r) => r.legacyTotalPaid],
    ['legacy_balance', (r) => r.legacyBalance],
    ['fee_source', (r) => r.snapshot.feeSource],
    ['unassigned_reason', (r) => r.unassignedReason],
    ['tracker_rows', (r) => r.trackerRows.map((row) => row.sourceRow).join(' ')],
    ['payment_count', (r) => r.paymentCount],
    ['payment_total', (r) => r.paymentTotal.toFixed(2)],
    ['payment_dates', (r) => r.paymentDates.map((date) => date ?? 'unreadable').join(' ')],
    ['payment_methods', (r) => r.paymentMethods.map((method) => method ?? '').join(' | ')],
    ['legacy_receipt_values', (r) => r.legacyReceiptValues.map((value) => value ?? '').join(' | ')],
    ['installment_count', (r) => r.installmentCount],
    ['tracker_batch_hints', (r) => [...new Set(r.trackerRows.map((row) => row.batchHint.text ?? ''))].join(' | ')],
    ['origin', (r) => r.origin.categories.join('+')],
    ['batch_assessment', (r) => r.batchEvidence.assessment],
    ['strong_candidates', (r) => r.batchEvidence.candidates.filter((candidate) => candidate.strength === 'strong').map((candidate) => candidate.batchName).join(' | ')],
    ['dated_candidates', (r) => r.batchEvidence.candidates.filter((candidate) => candidate.strength !== 'strong').map((candidate) => `${candidate.batchName} (${candidate.strength})`).join(' | ')],
    ['identity', (r) => r.identity.status],
    ['exact_name_matches', (r) => r.identity.exactMatches.map((match) => match.studentNumber).join(' ')],
    ['db_payments', (r) => r.ui.stages.database],
    ['loader_payments', (r) => r.ui.stages.loader],
    ['view_model_payments', (r) => r.ui.stages.viewModel],
    ['browser_rows', (r) => r.ui.stages.browser],
    ['unexplained_loss', (r) => r.ui.stages.unexplainedLoss],
  ]
  const escape = (value: unknown): string => {
    const text = value === null || value === undefined ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return [
    columns.map(([name]) => name).join(','),
    ...records.map((record) => columns.map(([, pick]) => escape(pick(record))).join(',')),
  ].join('\n')
}

function renderAggregate(aggregate: {
  runAt: string
  workbookHash: string
  projectRef: string
  sessionRole: string | null
  hostedCountsBefore: Record<string, number>
  hostedCountsAfter: Record<string, number>
  countsUnchanged: boolean
  unassigned: Record<string, unknown>
  conservation: ReturnType<typeof conservePayments>
  routing: ReturnType<typeof reconcileRouting>
  exceptions: Record<string, unknown>
  ui: Record<string, unknown>
}): string {
  const lines = [
    '# FINANCE-RECONCILE-04A unassigned forensics — aggregate (no PII)',
    '',
    `Run: ${aggregate.runAt}; project ${aggregate.projectRef}; session role ${aggregate.sessionRole ?? 'unknown'} (RLS enforced; service role used only to mint the one-time token); workbook ${aggregate.workbookHash}`,
    '',
    '## Hosted counts (before → after)',
    '',
    ...Object.keys(aggregate.hostedCountsBefore).map(
      (table) => `- ${table}: ${aggregate.hostedCountsBefore[table]} → ${aggregate.hostedCountsAfter[table]}`,
    ),
    `- unchanged: ${aggregate.countsUnchanged ? 'yes' : 'NO'}`,
    '',
    '## Payment conservation',
    '',
    `- assigned ${aggregate.conservation.assigned} + unassigned ${aggregate.conservation.unassigned} + orphaned ${aggregate.conservation.orphaned} = ${aggregate.conservation.assigned + aggregate.conservation.unassigned + aggregate.conservation.orphaned} of ${aggregate.conservation.total} → ${aggregate.conservation.conserved ? 'conserved' : 'NOT CONSERVED'}`,
    '',
    '## Unassigned records',
    '',
    ...Object.entries(aggregate.unassigned).map(([key, value]) => `- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`),
    '',
    '## Routing: transaction rows versus finance records',
    '',
    ...Object.entries(aggregate.routing).map(([key, value]) => `- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`),
    '',
    '## Import exceptions',
    '',
    ...Object.entries(aggregate.exceptions).map(([key, value]) => `- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`),
    '',
    '## UI path',
    '',
    ...Object.entries(aggregate.ui).map(([key, value]) => `- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`),
    '',
  ]
  return lines.join('\n')
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error)
      process.exit(1)
    },
  )
}
