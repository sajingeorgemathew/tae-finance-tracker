/**
 * An authenticated, RLS-enforced session against the hosted project — for QA.
 *
 * The finance grid is rendered through the request-scoped Supabase client with
 * the signed-in user's JWT, so Row Level Security decides every row. A QA
 * check that read with the service role would prove nothing about what staff
 * actually see. This module therefore produces a real *user* session for the
 * existing admin account and hands back a client that reads under that
 * session only.
 *
 * The service-role key is used for exactly two things, both administrative
 * and neither a data read: looking up which account is the active admin, and
 * minting a one-time magic-link token for it (`auth.admin.generateLink`). The
 * token is exchanged with the publishable key through `verifyOtp`, which is
 * the same technique `importer/rls-verification.mts` uses. No password is
 * touched, no role is changed, and nothing is written.
 *
 * Nothing here logs a key, a token or a cookie value.
 */

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'

import { readEnvironment } from '../finance-import/importer/supabase-write.mts'

export interface HostedSession {
  /** Reads under the admin's own JWT. RLS applies. */
  client: SupabaseClient
  /** The project ref, e.g. `hwekiiompxixybxclche`, parsed from the URL. */
  projectRef: string
  supabaseUrl: string
  /** The account the session belongs to. Reported; never a token. */
  email: string
  /** `current_app_role()` as the database resolves it for this session. */
  appRole: string | null
  /** The raw session, for building the `@supabase/ssr` cookie. */
  session: Session
  /** An unauthenticated client with the publishable key, for negative checks. */
  anonymous: SupabaseClient
  signOut(): Promise<void>
}

/** The project ref is the first label of the API host. */
export function projectRefFromUrl(url: string): string {
  const host = new URL(url).hostname
  return host.split('.')[0]
}

/**
 * Opens the session.
 *
 * `FINANCE_IMPORT_RLS_ADMIN_EMAIL` names the account when set; otherwise the
 * first active admin profile is used, exactly as the import's RLS read-back
 * does.
 */
export async function openHostedSession(repoRoot: string): Promise<HostedSession> {
  const env = readEnvironment(repoRoot)

  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL
  const publishable = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !publishable) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and a publishable key are required in .env.local')
  }
  if (!serviceRole) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is required to mint the one-time admin token (it is not used to read data)',
    )
  }

  const admin = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let email: string | null = env.FINANCE_IMPORT_RLS_ADMIN_EMAIL ?? null
  if (!email) {
    const { data, error } = await admin
      .from('profiles')
      .select('email')
      .eq('role', 'admin')
      .eq('active', true)
      .order('created_at')
      .limit(1)
    if (error) throw new Error(`could not look up the admin account: ${error.message}`)
    const first = (data ?? [])[0] as { email?: unknown } | undefined
    email = first?.email ? String(first.email) : null
  }
  if (!email) throw new Error('no active admin profile found to open a session for')

  const adminEmail: string = email
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: adminEmail,
  })
  if (linkError) throw new Error(`could not mint a one-time token: ${linkError.message}`)
  const hashedToken = link.properties?.hashed_token
  if (!hashedToken) throw new Error('no one-time token was issued for the admin account')

  const client = createClient(supabaseUrl, publishable, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: verified, error: otpError } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: hashedToken,
  })
  if (otpError) throw new Error(`could not exchange the one-time token: ${otpError.message}`)
  if (!verified.session) throw new Error('token exchange produced no session')

  const role = await client.rpc('current_app_role')

  const anonymous = createClient(supabaseUrl, publishable, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return {
    client,
    projectRef: projectRefFromUrl(supabaseUrl),
    supabaseUrl,
    email: adminEmail,
    appRole: role.error ? null : String(role.data),
    session: verified.session,
    anonymous,
    signOut: async () => {
      await client.auth.signOut()
    },
  }
}

/**
 * The `@supabase/ssr` cookie(s) for a session, as `Cookie:` header text.
 *
 * `@supabase/ssr` stores the session JSON as `base64-` + base64url, split into
 * chunks of at most 3180 characters named `<name>.0`, `<name>.1`, … when it
 * does not fit in one cookie. Reproduced here so the local Next.js server can
 * be asked for a server-rendered `/finance` as the signed-in admin.
 */
export function sessionCookieHeader(projectRef: string, session: Session): string {
  const name = `sb-${projectRef}-auth-token`
  const encoded = `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`
  const limit = 3180

  if (encoded.length <= limit) return `${name}=${encoded}`

  const chunks: string[] = []
  for (let index = 0; index * limit < encoded.length; index += 1) {
    chunks.push(`${name}.${index}=${encoded.slice(index * limit, (index + 1) * limit)}`)
  }
  return chunks.join('; ')
}

/** Individual cookies, for a browser automation API that sets them one by one. */
export function sessionCookies(projectRef: string, session: Session): { name: string; value: string }[] {
  return sessionCookieHeader(projectRef, session)
    .split('; ')
    .map((pair) => {
      const at = pair.indexOf('=')
      return { name: pair.slice(0, at), value: pair.slice(at + 1) }
    })
}
