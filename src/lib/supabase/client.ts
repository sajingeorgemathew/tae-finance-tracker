'use client'

import { createBrowserClient } from '@supabase/ssr'

import { publicEnv, supabasePublishableKey } from '@/lib/env'

/**
 * Supabase client for Client Components.
 *
 * Only ever receives the publishable/anon key, which is designed to be public
 * and is constrained by Row Level Security. The service-role key must never
 * reach this module.
 */
export function createClient() {
  const { NEXT_PUBLIC_SUPABASE_URL } = publicEnv()
  return createBrowserClient(NEXT_PUBLIC_SUPABASE_URL, supabasePublishableKey())
}
