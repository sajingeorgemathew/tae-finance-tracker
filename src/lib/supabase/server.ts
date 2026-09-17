import 'server-only'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

import { publicEnv, supabasePublishableKey } from '@/lib/env'

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * A new client is created per request — never cache or share one across
 * requests, or a later response can be left without the cache headers that
 * accompany a token refresh.
 *
 * Note: `cookies()` is asynchronous in Next.js 16.
 */
export async function createClient() {
  const cookieStore = await cookies()
  const { NEXT_PUBLIC_SUPABASE_URL } = publicEnv()

  return createServerClient(NEXT_PUBLIC_SUPABASE_URL, supabasePublishableKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // `src/proxy.ts` refreshes the session, so this is safe to ignore.
        }
      },
    },
  })
}

/**
 * Service-role Supabase client. Bypasses Row Level Security entirely.
 *
 * Deliberately NOT used anywhere in FINANCE-BOOTSTRAP-00. It is defined here so
 * that later tickets have a single audited place for elevated access, rather
 * than reaching for `process.env.SUPABASE_SERVICE_ROLE_KEY` ad hoc.
 *
 * Callers must perform their own authorization first.
 */
export function createServiceRoleClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured')
  }

  const { NEXT_PUBLIC_SUPABASE_URL } = publicEnv()

  return createServerClient(NEXT_PUBLIC_SUPABASE_URL, key, {
    // The service-role client is request-independent and must never read or
    // write a user's session cookies.
    cookies: {
      getAll() {
        return []
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}
