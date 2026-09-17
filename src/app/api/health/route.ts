import { NextResponse } from 'next/server'

import { serverEnvPresence } from '@/lib/env.server'
import { checkSupabaseHealth } from '@/lib/supabase/health'

/** Never cache a health probe. */
export const dynamic = 'force-dynamic'

/**
 * Development-only diagnostic.
 *
 * Reports which environment variable NAMES are present and whether the Supabase
 * server client can reach the project. Returns booleans and a status string
 * only — never a key, URL or driver error. Disabled outside development.
 */
export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return new NextResponse('Not Found', { status: 404 })
  }

  const health = await checkSupabaseHealth()

  return NextResponse.json({
    supabase: health.status,
    label: health.label,
    // Presence only. No values.
    serverEnvPresent: serverEnvPresence(),
  })
}
