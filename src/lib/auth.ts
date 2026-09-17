import 'server-only'

import { redirect } from 'next/navigation'
import type { User } from '@supabase/supabase-js'

import { createClient } from '@/lib/supabase/server'

/**
 * Server-side authentication gate for protected pages.
 *
 * `src/proxy.ts` performs an optimistic redirect, but that is a convenience
 * only. This is the real check: it revalidates the JWT with the Supabase auth
 * server on every render, so a forged or stale cookie cannot get past it.
 *
 * Call this at the top of every authenticated page.
 */
export async function requireUser(redirectTo?: string): Promise<User> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    const target = redirectTo ? `/login?redirectTo=${encodeURIComponent(redirectTo)}` : '/login'
    redirect(target)
  }

  return user
}

/** Returns the current user, or null. Does not redirect. */
export async function getUser(): Promise<User | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}
