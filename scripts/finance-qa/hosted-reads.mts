/**
 * Hosted reads the finance QA scripts share.
 *
 * Two things every read-only check needs: the exact `select(...)` projections
 * the grid loader uses, pulled out of its source so a QA tool can never check
 * a projection the page no longer reads; and a paged, authenticated select
 * that reads under Row Level Security and nothing else.
 *
 * Nothing here writes.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { SupabaseClient } from '@supabase/supabase-js'

export interface LoaderProjection {
  records: string
  installments: string
  payments: string
  manifest: string
}

/**
 * Pulls the four `select(...)` strings out of `src/lib/finance/grid/load.ts`.
 *
 * `load.ts` is `server-only` and cannot be imported here, and copying the
 * strings by hand is how a QA tool ends up checking a projection the page no
 * longer uses. Reading them from the file is the honest alternative.
 */
export function readLoaderProjection(repoRoot: string): LoaderProjection {
  const source = readFileSync(path.join(repoRoot, 'src', 'lib', 'finance', 'grid', 'load.ts'), 'utf8')

  const pick = (name: string): string => {
    const match = new RegExp(`const ${name} =\\s*(?:\`([^\`]*)\`|'([^']*)')`).exec(source)
    if (!match) throw new Error(`could not find ${name} in load.ts`)
    return (match[1] ?? match[2]).replace(/\s+/g, ' ').trim()
  }

  return {
    records: pick('RECORD_COLUMNS'),
    installments: pick('INSTALLMENT_COLUMNS'),
    payments: pick('PAYMENT_COLUMNS'),
    manifest: pick('MANIFEST_COLUMNS'),
  }
}

/** Every row of a table, paged, under the session's own RLS. */
export async function selectAll<T>(
  client: SupabaseClient,
  table: string,
  columns: string,
  orderBy: string,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .order(orderBy)
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`read ${table}: ${error.message}`)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < pageSize) break
  }
  return out
}

/** `count(*)` of a table under RLS, without fetching a row. */
export async function countRows(client: SupabaseClient, table: string): Promise<number> {
  const { count, error } = await client.from(table).select('id', { count: 'exact', head: true })
  if (error) throw new Error(`count ${table}: ${error.message}`)
  return count ?? 0
}

export interface HostedProgram {
  id: string
  name: string
  short_code: string
}

export interface HostedBatch {
  id: string
  program_id: string
  name: string
  code: string | null
  legacy_sheet_name: string | null
  start_date: string | null
  active: boolean
}
