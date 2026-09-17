import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import { isPublicEnvConfigured, publicEnv, supabasePublishableKey } from '@/lib/env'

/**
 * Routes that require a signed-in user. Everything else is public.
 * Kept deliberately small for FINANCE-BOOTSTRAP-00 — no role model yet.
 */
const PROTECTED_PREFIXES = ['/dashboard', '/finance', '/settings'] as const

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

/**
 * Refreshes the Supabase auth session on every matched request and performs an
 * optimistic redirect for unauthenticated users.
 *
 * This is an optimistic check only — it keeps the session cookie fresh and
 * bounces obvious anonymous traffic. Each protected page still performs its own
 * server-side `getUser()` check; proxy logic is never the authorization
 * boundary.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let supabaseResponse = NextResponse.next({ request })

  // Without configuration there is no session to refresh. Let the request
  // through so the health check and error UI can explain the problem.
  if (!isPublicEnvConfigured()) {
    return supabaseResponse
  }

  const { NEXT_PUBLIC_SUPABASE_URL } = publicEnv()

  const supabase = createServerClient(NEXT_PUBLIC_SUPABASE_URL, supabasePublishableKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value)
        }
        supabaseResponse = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options)
        }
        // @supabase/ssr supplies the no-store cache headers that must travel
        // with a Set-Cookie for auth, so a CDN cannot serve one user's session
        // token to another.
        for (const [key, headerValue] of Object.entries(headers)) {
          supabaseResponse.headers.set(key, headerValue)
        }
      },
    },
  })

  // Must run before the response is generated, or a completed token refresh
  // cannot be written back to cookies.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  if (!user && isProtected(pathname)) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.search = ''
    loginUrl.searchParams.set('redirectTo', pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (user && pathname === '/login') {
    const dashboardUrl = request.nextUrl.clone()
    dashboardUrl.pathname = '/dashboard'
    dashboardUrl.search = ''
    return NextResponse.redirect(dashboardUrl)
  }

  return supabaseResponse
}
