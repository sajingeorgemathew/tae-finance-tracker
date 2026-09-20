/**
 * Read-only Supabase access for the dry run.
 *
 * This module exposes counting and one lookup. It has no insert, update, upsert
 * or delete anywhere in it, and nothing it returns can be used to perform one —
 * the Supabase client it builds never leaves the module. That is the guarantee
 * the dry run rests on, and it is structural rather than a flag somebody has to
 * remember to set.
 *
 * Connecting is optional. The dry run's job is to map a workbook, and it does
 * that without a database. When credentials are present the run additionally
 * proves it changed nothing, by counting the operational tables before and
 * after; when they are not, it says so rather than failing.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createClient } from '@supabase/supabase-js'

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The operational finance tables, in the order the report lists them.
 *
 * `programs` is configuration rather than operational data, but it is counted
 * too: an import that created a program would be a serious fault, and the count
 * is the cheapest way to see that it did not.
 */
export const OPERATIONAL_TABLES = [
  'programs',
  'batches',
  'students',
  'student_finance_records',
  'installments',
  'payments',
  'receipts',
  'receipt_deliveries',
  'reminder_deliveries',
  'import_exceptions',
  'import_batches',
] as const

export type OperationalTable = (typeof OPERATIONAL_TABLES)[number]

export type TableCounts = Record<string, number | null>

export interface SupabaseAvailability {
  available: boolean
  /** Which key was used. Never the key itself. */
  keyKind: 'service_role' | 'publishable' | null
  reason: string
}

/**
 * Reads `.env.local` without adding a dependency.
 *
 * Node does not load it for a plain `node script.mts`, and the values are
 * needed only here. Nothing is logged: values go straight into the client.
 */
function loadEnvLocal(repoRoot: string): Record<string, string> {
  const out: Record<string, string> = {}

  let contents: string
  try {
    contents = readFileSync(path.join(repoRoot, '.env.local'), 'utf8')
  } catch {
    return out
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[match[1]] = value
  }

  return out
}

interface Connection {
  client: SupabaseClient
  availability: SupabaseAvailability
}

/**
 * Builds the read-only client, or explains why it could not.
 *
 * The service-role key is preferred because Row Level Security would otherwise
 * hide every row from an unauthenticated caller and make the counts read as
 * zero — which would look like a passing check for the wrong reason.
 */
function connect(repoRoot: string): Connection | null {
  const env = { ...loadEnvLocal(repoRoot), ...process.env }

  const url = env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) return null

  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY
  const publishable = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  const key = serviceRole ?? publishable
  if (!key) return null

  return {
    client: createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    availability: {
      available: true,
      keyKind: serviceRole ? 'service_role' : 'publishable',
      reason: serviceRole
        ? 'connected with the service-role key, which sees every row'
        : 'connected with the publishable key; Row Level Security may hide rows, so counts are a lower bound',
    },
  }
}

export interface CountResult {
  availability: SupabaseAvailability
  counts: TableCounts
  errors: Record<string, string>
}

/**
 * Counts rows in the operational tables.
 *
 * `head: true` with an exact count sends no row data back, so no student
 * information is pulled into the script to satisfy a count.
 */
export async function countOperationalTables(repoRoot: string): Promise<CountResult> {
  const connection = connect(repoRoot)

  if (connection === null) {
    return {
      availability: {
        available: false,
        keyKind: null,
        reason: 'no Supabase URL and key available; row counts were not verified',
      },
      counts: Object.fromEntries(OPERATIONAL_TABLES.map((table) => [table, null])),
      errors: {},
    }
  }

  const counts: TableCounts = {}
  const errors: Record<string, string> = {}

  for (const table of OPERATIONAL_TABLES) {
    const { count, error } = await connection.client
      .from(table)
      .select('*', { count: 'exact', head: true })

    if (error) {
      counts[table] = null
      errors[table] = error.message
      continue
    }
    counts[table] = count ?? 0
  }

  return { availability: connection.availability, counts, errors }
}

export interface PriorImportCheck {
  checked: boolean
  /** A completed import of this exact workbook already exists. */
  alreadyImported: boolean
  /** Rows found for this hash, by status. */
  statuses: Record<string, number>
  note: string
}

/**
 * Looks for a completed import of the same workbook.
 *
 * This is the idempotency gate a future apply must pass: the same SHA-256
 * already imported means the apply is refused. Running it here proves the gate
 * works and tells the reviewer what an apply would find.
 */
export async function findPriorImport(
  repoRoot: string,
  sha256: string,
): Promise<PriorImportCheck> {
  const connection = connect(repoRoot)

  if (connection === null) {
    return {
      checked: false,
      alreadyImported: false,
      statuses: {},
      note: 'not checked: no Supabase credentials available',
    }
  }

  const { data, error } = await connection.client
    .from('import_batches')
    .select('status')
    .eq('source_file_hash', sha256)

  if (error) {
    return {
      checked: false,
      alreadyImported: false,
      statuses: {},
      note: `not checked: ${error.message}`,
    }
  }

  const statuses: Record<string, number> = {}
  for (const row of data ?? []) {
    const status = String((row as { status: unknown }).status)
    statuses[status] = (statuses[status] ?? 0) + 1
  }

  const alreadyImported = (statuses.completed ?? 0) > 0

  return {
    checked: true,
    alreadyImported,
    statuses,
    note: alreadyImported
      ? 'a completed import of this exact workbook already exists; an apply must refuse'
      : 'no completed import of this workbook hash; an apply would be allowed to proceed',
  }
}

/**
 * The columns and tables each required migration is responsible for.
 *
 * The project is not linked to the hosted Supabase project and migrations are
 * applied by hand, so there is no migration ledger to trust. What matters
 * before an apply is that the schema the plan targets is actually there, which
 * is what this probes — a `select … head` naming the columns fails if any one
 * of them is missing, and reads no row data to find out.
 */
const SCHEMA_PROBES: Record<string, { table: string; columns: string }> = {
  '20260917143000_finance_foundation': {
    table: 'payments',
    columns: 'id, student_finance_record_id, amount, source, legacy_raw_json',
  },
  '20260917150000_initial_program_configuration': {
    table: 'programs',
    columns: 'id, short_code, student_number_prefix',
  },
  'students.legacy_raw_json': { table: 'students', columns: 'id, legacy_raw_json' },
  'student_finance_records.legacy_raw_json': {
    table: 'student_finance_records',
    columns: 'id, legacy_raw_json',
  },
  'installments.legacy_raw_json': { table: 'installments', columns: 'id, legacy_raw_json' },
  'public.import_exceptions': {
    table: 'import_exceptions',
    columns: 'id, import_batch_id, source_filename, source_sheet, source_row, entity_type, reason, source_key, legacy_raw_json',
  },
}

/** Probes for the schema each required migration creates. Reads no rows. */
export async function probeSchema(repoRoot: string): Promise<Record<string, boolean>> {
  const connection = connect(repoRoot)
  if (connection === null) {
    return Object.fromEntries(Object.keys(SCHEMA_PROBES).map((name) => [name, false]))
  }

  const presence: Record<string, boolean> = {}
  for (const [name, probe] of Object.entries(SCHEMA_PROBES)) {
    const { error } = await connection.client
      .from(probe.table)
      .select(probe.columns, { head: true, count: 'exact' })
    presence[name] = !error
  }

  // The configuration migration is present only if its rows are too: the
  // programs table exists without it.
  if (presence['20260917150000_initial_program_configuration']) {
    const { data, error } = await connection.client.from('programs').select('short_code')
    const codes = new Set((data ?? []).map((row) => String((row as { short_code: unknown }).short_code)))
    presence['20260917150000_initial_program_configuration'] =
      !error && codes.has('PSW') && codes.has('ECEA')
  }

  return presence
}

/**
 * A hosted batch, reduced to the fields that identify it.
 *
 * Read by the column manifest generator (FINANCE-COLUMN-MANIFEST-03A) to
 * prove each workbook table maps to exactly one hosted batch before any
 * layout row is planned against it. Nothing here is about a student.
 */
export interface HostedBatchIdentityRow {
  id: string
  code: string | null
  legacySheetName: string | null
  programShortCode: string | null
}

export interface BatchIdentityResult {
  availability: SupabaseAvailability
  batches: HostedBatchIdentityRow[]
  error: string | null
}

/**
 * Reads every batch's id, code, legacy sheet name and program short code.
 *
 * Two small selects — batches and programs — joined in memory. No student
 * table is touched.
 */
export async function readBatchIdentities(repoRoot: string): Promise<BatchIdentityResult> {
  const connection = connect(repoRoot)

  if (connection === null) {
    return {
      availability: {
        available: false,
        keyKind: null,
        reason: 'no Supabase URL and key available; hosted batches were not read',
      },
      batches: [],
      error: null,
    }
  }

  const programs = await connection.client.from('programs').select('id, short_code')
  if (programs.error) {
    return { availability: connection.availability, batches: [], error: programs.error.message }
  }

  const shortCodeById = new Map(
    (programs.data ?? []).map((row) => [
      String((row as { id: unknown }).id),
      String((row as { short_code: unknown }).short_code),
    ]),
  )

  const batches = await connection.client
    .from('batches')
    .select('id, code, legacy_sheet_name, program_id')
    .order('code')
  if (batches.error) {
    return { availability: connection.availability, batches: [], error: batches.error.message }
  }

  return {
    availability: connection.availability,
    batches: (batches.data ?? []).map((row) => {
      const record = row as {
        id: unknown
        code: unknown
        legacy_sheet_name: unknown
        program_id: unknown
      }
      return {
        id: String(record.id),
        code: record.code === null ? null : String(record.code),
        legacySheetName: record.legacy_sheet_name === null ? null : String(record.legacy_sheet_name),
        programShortCode: shortCodeById.get(String(record.program_id)) ?? null,
      }
    }),
    error: null,
  }
}

/** Table-by-table comparison of two count snapshots. */
export function diffCounts(
  before: TableCounts,
  after: TableCounts,
): { table: string; before: number | null; after: number | null; changed: boolean }[] {
  return OPERATIONAL_TABLES.map((table) => ({
    table,
    before: before[table] ?? null,
    after: after[table] ?? null,
    changed:
      before[table] !== null && after[table] !== null && before[table] !== after[table],
  }))
}
