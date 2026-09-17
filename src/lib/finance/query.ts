import 'server-only'

import type { PostgrestError } from '@supabase/supabase-js'

/**
 * Shared plumbing for the finance data layer.
 *
 * Every module in `lib/finance` runs on the server, goes through the
 * request-scoped Supabase client, and therefore reads with the signed-in user's
 * own privileges. Row Level Security is the authorization boundary — these
 * helpers never reach for the service-role key.
 *
 * A consequence worth remembering: a caller without finance access gets an
 * empty result, not an error. Absence of rows is not proof that a record does
 * not exist.
 */

/** A failed finance query. Carries no driver detail — that stays in the logs. */
export class FinanceQueryError extends Error {
  constructor(operation: string) {
    super(`Could not ${operation}.`)
    this.name = 'FinanceQueryError'
  }
}

/**
 * Logs the driver error server-side and throws a message safe to surface.
 *
 * Postgres error text can name columns, constraints and policies, so it is
 * never returned to the caller.
 */
export function raiseQueryError(operation: string, error: PostgrestError): never {
  console.error(`[finance] Failed to ${operation}:`, {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  })
  throw new FinanceQueryError(operation)
}

/** Upper bound on any list query, so a missing filter cannot pull the table. */
export const MAX_PAGE_SIZE = 500

/** Default page size for list queries. */
export const DEFAULT_PAGE_SIZE = 100

export interface PageOptions {
  /** Rows to return. Clamped to `MAX_PAGE_SIZE`. */
  limit?: number
  /** Rows to skip. */
  offset?: number
}

/** Resolves page options into an inclusive PostgREST range. */
export function resolveRange(options: PageOptions = {}): { from: number; to: number } {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const from = Math.max(options.offset ?? 0, 0)
  return { from, to: from + limit - 1 }
}

/**
 * Escapes a user-supplied search term for a PostgREST `or()` filter.
 *
 * Commas and parentheses are the filter grammar's separators, and `*` is its
 * wildcard, so an unescaped term could otherwise change the shape of the query.
 */
export function sanitizeSearchTerm(term: string): string {
  return term.replace(/[(),*"\\]/g, ' ').trim()
}
