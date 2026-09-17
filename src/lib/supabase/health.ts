import 'server-only'

import { isPublicEnvConfigured, publicEnvIssues } from '@/lib/env'

import { createClient } from './server'

export type SupabaseHealthStatus =
  | 'connected'
  | 'schema-missing'
  | 'configuration-error'
  | 'unreachable'

export interface SupabaseHealth {
  status: SupabaseHealthStatus
  /** Safe for public UI. Never contains keys, URLs or driver errors. */
  label: string
}

/**
 * The relation the probe touches: small, legitimate, and containing
 * configuration rather than anyone's finance data.
 */
const PROBE_TABLE = 'programs'

/** PostgREST / Postgres codes meaning the relation itself is not there yet. */
const RELATION_MISSING = new Set(['PGRST205', '42P01'])

/**
 * Codes meaning we reached the database and it answered, but declined this
 * caller. The connection is healthy; RLS is simply doing its job for an
 * anonymous or unprivileged session.
 */
const PERMISSION_DENIED = new Set(['42501'])

const LABELS: Record<SupabaseHealthStatus, string> = {
  connected: 'Supabase: Connected',
  'schema-missing': 'Supabase: Migration Pending',
  'configuration-error': 'Supabase: Configuration Error',
  unreachable: 'Supabase: Unreachable',
}

/**
 * Server-side Supabase connectivity check.
 *
 * Issues a zero-row request against `programs` — no row contents are returned
 * by the query, and none reach the caller. Uses the publishable/anon key
 * through the normal request-scoped client, so it exercises exactly the path
 * the application uses, never the service role.
 *
 * A signed-out caller is expected to match no RLS policy here. That is a
 * healthy result, not a failure: the check is about reachability, and it must
 * not be able to reveal whether any finance data exists.
 *
 * Internal error details are logged server-side and are not returned.
 */
export async function checkSupabaseHealth(): Promise<SupabaseHealth> {
  if (!isPublicEnvConfigured()) {
    console.error('[health] Supabase environment incomplete:', publicEnvIssues().join('; '))
    return { status: 'configuration-error', label: LABELS['configuration-error'] }
  }

  try {
    const supabase = await createClient()

    // `limit(0)` asks for the table but no rows: cheap, and it exposes nothing.
    //
    // Deliberately not `{ head: true }`. A HEAD response has no body, and
    // postgrest-js turns a bodyless 404 into a 204 with `error === null`, so a
    // missing table would be indistinguishable from a healthy one — which is
    // precisely the case this check exists to catch.
    const { error } = await supabase.from(PROBE_TABLE).select('id').limit(0)

    if (!error) {
      return { status: 'connected', label: LABELS.connected }
    }

    const code = error.code ?? ''

    if (PERMISSION_DENIED.has(code)) {
      return { status: 'connected', label: LABELS.connected }
    }

    if (RELATION_MISSING.has(code)) {
      console.error(
        `[health] Table "${PROBE_TABLE}" is missing. Apply the finance foundation migration.`,
      )
      return { status: 'schema-missing', label: LABELS['schema-missing'] }
    }

    console.error('[health] Supabase responded with an unexpected error code:', code)
    return { status: 'configuration-error', label: LABELS['configuration-error'] }
  } catch (error) {
    console.error('[health] Supabase connectivity check failed:', error)
    return { status: 'unreachable', label: LABELS.unreachable }
  }
}
