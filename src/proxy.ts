import type { NextRequest } from 'next/server'

import { updateSession } from '@/lib/supabase/proxy'

/**
 * Next.js 16 renamed `middleware` to `proxy`. Same behaviour, new file and
 * export name — see node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md
 *
 * The proxy runtime is always Node.js in Next 16 and cannot be configured.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Run on every request except static assets and image files, so the auth
     * session is refreshed on real navigations only.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
