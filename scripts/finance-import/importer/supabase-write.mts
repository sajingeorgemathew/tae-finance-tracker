/**
 * Service-role Supabase access for the apply.
 *
 * This is the only module in the importer that writes. It is separate from
 * `supabase-readonly.mts` on purpose: the dry run imports that module and
 * therefore *cannot* write, and that guarantee stays structural rather than
 * becoming a flag somebody has to remember to leave unset.
 *
 * Three rules hold throughout:
 *
 *   * **Service role only.** Row Level Security would otherwise reject the
 *     insert of historical data by an unauthenticated caller. The key is read
 *     from the environment, is never logged, never written to a file, and never
 *     leaves this module — nothing it returns exposes it.
 *
 *   * **Inserts are chunked.** A single request carrying 1,825 installments,
 *     each with a `legacy_raw_json` payload of the source cell, is large enough
 *     to be refused by the API. Chunks are a fixed size so a re-run splits the
 *     work identically.
 *
 *   * **Every write is idempotent on the primary key.** Rows arrive with
 *     deterministic IDs (`deterministic-ids.mts`), so the write is an upsert
 *     that ignores duplicates. A retry after a partial transport failure
 *     converges instead of doubling.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createClient } from '@supabase/supabase-js'

import type { SupabaseClient } from '@supabase/supabase-js'

/** Rows per request. Small enough for the payload sizes this importer sends. */
export const CHUNK_SIZE = 200

/**
 * Reads `.env.local` merged over `process.env`.
 *
 * Exported because the post-apply RLS verification needs the *publishable* key
 * and the URL to read as the application does, and the admin API to mint a
 * one-time session. Nothing here logs a value, and callers are expected to pass
 * keys straight into a client rather than print or store them.
 */
export function readEnvironment(repoRoot: string): Record<string, string> {
  return { ...loadEnvLocal(repoRoot), ...process.env } as Record<string, string>
}

/** Reads `.env.local`. Values go straight into the client; none is logged. */
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

export class WriteAccessError extends Error {}

/**
 * Builds the service-role client, or explains why it could not.
 *
 * The publishable key is deliberately *not* accepted as a fallback. Falling
 * back would either fail row by row against RLS or, worse, half-succeed — and
 * an import that writes some rows under a key that cannot read the rest is the
 * state this whole phase exists to avoid.
 */
export function connectForWrite(repoRoot: string): SupabaseClient {
  const env = { ...loadEnvLocal(repoRoot), ...process.env }

  const url = env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) {
    throw new WriteAccessError('NEXT_PUBLIC_SUPABASE_URL is not set; cannot apply.')
  }

  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRole) {
    throw new WriteAccessError(
      'SUPABASE_SERVICE_ROLE_KEY is not set. The apply writes historical finance data ' +
        'and requires the service role; it will not fall back to the publishable key.',
    )
  }

  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export interface InsertOutcome {
  table: string
  attempted: number
  /** Rows present in the table for this import after the write. */
  verified: number
  chunks: number
}

/**
 * Inserts rows in deterministic chunks, ignoring rows that already exist.
 *
 * `onConflict: 'id'` with `ignoreDuplicates` makes the write converge: the
 * first run inserts, a retry after a partial failure inserts only what is
 * missing, and a complete re-run is a no-op. Nothing is ever updated, so a
 * retry cannot rewrite a value that is already in the database.
 *
 * Chunks are processed in order and a failure stops the class immediately —
 * the caller must not proceed to the next entity class on a mismatch.
 */
export async function insertChunked(
  client: SupabaseClient,
  table: string,
  rows: readonly Record<string, unknown>[],
): Promise<number> {
  let chunks = 0

  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    const chunk = rows.slice(start, start + CHUNK_SIZE)
    const { error } = await client
      .from(table)
      .upsert(chunk as Record<string, unknown>[], {
        onConflict: 'id',
        ignoreDuplicates: true,
      })

    if (error) {
      throw new WriteAccessError(
        `insert into ${table} failed on rows ${start}-${start + chunk.length - 1}: ${error.message}`,
      )
    }
    chunks += 1
  }

  return chunks
}

/** Exact row count for a table, or a thrown error. Reads no row data. */
export async function countRows(
  client: SupabaseClient,
  table: string,
): Promise<number> {
  const { count, error } = await client.from(table).select('*', { count: 'exact', head: true })
  if (error) throw new WriteAccessError(`count of ${table} failed: ${error.message}`)
  return count ?? 0
}

/**
 * Counts rows of a table whose `id` is among `ids`.
 *
 * This is the per-entity-class verification: it counts what *this import*
 * actually put there, rather than the table total, so a pre-existing row could
 * never stand in for one the import failed to write.
 */
export async function countByIds(
  client: SupabaseClient,
  table: string,
  ids: readonly string[],
): Promise<number> {
  let found = 0

  for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
    const chunk = ids.slice(start, start + CHUNK_SIZE)
    const { count, error } = await client
      .from(table)
      .select('id', { count: 'exact', head: true })
      .in('id', chunk as string[])

    if (error) throw new WriteAccessError(`verification of ${table} failed: ${error.message}`)
    found += count ?? 0
  }

  return found
}

/** Fetches selected columns for the given ids, in chunks. For FK verification. */
export async function selectByIds(
  client: SupabaseClient,
  table: string,
  columns: string,
  ids: readonly string[],
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []

  for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
    const chunk = ids.slice(start, start + CHUNK_SIZE)
    const { data, error } = await client
      .from(table)
      .select(columns)
      .in('id', chunk as string[])

    if (error) throw new WriteAccessError(`read-back of ${table} failed: ${error.message}`)
    rows.push(...((data ?? []) as unknown as Record<string, unknown>[]))
  }

  return rows
}
