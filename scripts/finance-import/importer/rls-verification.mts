/**
 * Row Level Security verification, run after the apply.
 *
 * The apply writes with the service role, which bypasses RLS entirely. That
 * means a successful import proves nothing about whether the application can
 * actually read what was imported — or whether a stranger can. This module
 * answers both questions using the keys the application itself uses.
 *
 * Two checks:
 *
 *   * **Unauthenticated reads are blocked.** The publishable key with no
 *     session. Every finance policy targets `authenticated`, so the expected
 *     result is no rows — not an error. A count that matches the imported total
 *     would mean the data is world-readable.
 *
 *   * **An authenticated admin can read.** The same publishable key, with a
 *     session for the existing admin. The session is obtained from a one-time
 *     magic-link token minted through the admin API: it signs in as the account
 *     without touching its password, its role or its active flag. No staff role
 *     is altered to make this check pass — if the account could not read, that
 *     is the finding, not something to fix by granting it more.
 *
 * The service role is never used for either read.
 */

import { createClient } from '@supabase/supabase-js'

import type { SupabaseClient } from '@supabase/supabase-js'

export interface RlsVerification {
  attempted: boolean
  adminReadSucceeded: boolean | null
  anonymousReadBlocked: boolean | null
  /** Aggregate, sanitised. Never a row, a name or a token. */
  note: string
  details: {
    anonymousPaymentRows: number | null
    anonymousError: string | null
    adminPaymentRows: number | null
    adminFinanceRecordRows: number | null
    adminRole: string | null
    adminError: string | null
  }
}

export interface RlsInputs {
  url: string
  publishableKey: string
  serviceRoleKey: string
  /** The admin account to sign in as. Its role and password are not changed. */
  adminEmail: string
  /** What the service role sees, for comparison. */
  expectedPaymentRows: number
}

/** Counts rows visible to this client. RLS decides what that is. */
async function visibleCount(
  client: SupabaseClient,
  table: string,
): Promise<{ count: number | null; error: string | null }> {
  const { count, error } = await client.from(table).select('*', { count: 'exact', head: true })
  return { count: count ?? null, error: error ? error.message : null }
}

export async function verifyRls(inputs: RlsInputs): Promise<RlsVerification> {
  const details: RlsVerification['details'] = {
    anonymousPaymentRows: null,
    anonymousError: null,
    adminPaymentRows: null,
    adminFinanceRecordRows: null,
    adminRole: null,
    adminError: null,
  }

  // --- 1. Unauthenticated ----------------------------------------------------
  const anonymous = createClient(inputs.url, inputs.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const anonymousPayments = await visibleCount(anonymous, 'payments')
  details.anonymousPaymentRows = anonymousPayments.count
  details.anonymousError = anonymousPayments.error

  // Blocked means: an error, or zero rows where the service role sees many.
  const anonymousReadBlocked =
    anonymousPayments.error !== null || (anonymousPayments.count ?? 0) === 0

  // --- 2. Authenticated admin ------------------------------------------------
  let adminReadSucceeded: boolean | null = null

  try {
    const admin = createClient(inputs.url, inputs.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // A one-time token for an existing account. Changes no password, no role,
    // no active flag — it only produces a session to read with.
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: inputs.adminEmail,
    })
    if (linkError) throw new Error(linkError.message)

    const hashedToken = link.properties?.hashed_token
    if (!hashedToken) throw new Error('no one-time token was issued for the admin account')

    const asAdmin = createClient(inputs.url, inputs.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { error: otpError } = await asAdmin.auth.verifyOtp({
      type: 'magiclink',
      token_hash: hashedToken,
    })
    if (otpError) throw new Error(otpError.message)

    const role = await asAdmin.rpc('current_app_role')
    details.adminRole = role.error ? null : String(role.data)

    const adminPayments = await visibleCount(asAdmin, 'payments')
    const adminRecords = await visibleCount(asAdmin, 'student_finance_records')
    details.adminPaymentRows = adminPayments.count
    details.adminFinanceRecordRows = adminRecords.count

    adminReadSucceeded =
      adminPayments.error === null &&
      adminRecords.error === null &&
      (adminPayments.count ?? 0) === inputs.expectedPaymentRows

    await asAdmin.auth.signOut()
  } catch (error: unknown) {
    details.adminError = error instanceof Error ? error.message : 'unknown failure'
    adminReadSucceeded = false
  }

  const note =
    `Unauthenticated: ${details.anonymousPaymentRows ?? 'error'} payment row(s) visible ` +
    `(expected 0 — every finance policy targets \`authenticated\`). ` +
    `Authenticated admin: ${details.adminPaymentRows ?? 'error'} payment row(s) and ` +
    `${details.adminFinanceRecordRows ?? 'error'} finance record(s) visible ` +
    `(expected ${inputs.expectedPaymentRows} payments)` +
    (details.adminRole ? `, resolved app role \`${details.adminRole}\`` : '') +
    (details.adminError ? `. Admin check error: ${details.adminError}` : '') +
    '. Neither read used the service role.'

  return { attempted: true, adminReadSucceeded, anonymousReadBlocked, note, details }
}
