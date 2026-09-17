import 'server-only'

import { isPublicEnvConfigured, publicEnvIssues } from '@/lib/env'

import { createClient } from './server'

export type SupabaseHealthStatus = 'connected' | 'configuration-error' | 'unreachable'

export interface SupabaseHealth {
  status: SupabaseHealthStatus
  /** Safe for public UI. Never contains keys, URLs or driver errors. */
  label: string
}

/**
 * PostgREST codes that prove we reached the project and were authenticated:
 * the request got as far as schema resolution and was told the probe relation
 * does not exist. That is exactly what we expect, since this ticket creates no
 * finance tables.
 */
const REACHED_POSTGREST = new Set(['PGRST205', 'PGRST202', '42P01'])

/** A relation that intentionally does not exist. */
const PROBE_RELATION = '__finance_health_probe__'

/**
 * Server-side Supabase connectivity check.
 *
 * Exercises the real server client using only the publishable/anon key — never
 * the service role. Internal error details are logged server-side and are not
 * returned to the caller.
 */
export async function checkSupabaseHealth(): Promise<SupabaseHealth> {
  if (!isPublicEnvConfigured()) {
    console.error('[health] Supabase environment incomplete:', publicEnvIssues().join('; '))
    return { status: 'configuration-error', label: 'Supabase: Configuration Error' }
  }

  try {
    const supabase = await createClient()
    const { error } = await supabase.from(PROBE_RELATION).select('*').limit(1)

    if (!error) {
      // Unexpected, but a successful response is still a reachable project.
      return { status: 'connected', label: 'Supabase: Connected' }
    }

    if (REACHED_POSTGREST.has(error.code ?? '')) {
      return { status: 'connected', label: 'Supabase: Connected' }
    }

    console.error('[health] Supabase responded with an unexpected error code:', error.code)
    return { status: 'configuration-error', label: 'Supabase: Configuration Error' }
  } catch (error) {
    console.error('[health] Supabase connectivity check failed:', error)
    return { status: 'unreachable', label: 'Supabase: Configuration Error' }
  }
}
