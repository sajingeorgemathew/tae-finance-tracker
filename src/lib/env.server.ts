import 'server-only'

import { z } from 'zod'

/**
 * Server-only environment configuration.
 *
 * The `server-only` import above makes this module a build error if it is ever
 * pulled into a Client Component bundle, which is the guard that keeps the
 * service-role key and the Resend key off the browser.
 *
 * Nothing in here may be re-exported from `src/lib/env.ts`.
 */

const serverSchema = z.object({
  /**
   * Full-access Supabase key. Bypasses Row Level Security, so it must only be
   * used from server code that has already performed its own authorization.
   * Not required for the app to boot.
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  /** Email delivery. Intentionally unused in FINANCE-BOOTSTRAP-00. */
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),
})

export type ServerEnv = z.infer<typeof serverSchema>

const parsedServerEnv = serverSchema.safeParse({
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
})

export function serverEnv(): ServerEnv {
  if (!parsedServerEnv.success) {
    throw new Error(
      `Invalid server environment configuration:\n${parsedServerEnv.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n')}`,
    )
  }
  return parsedServerEnv.data
}

/**
 * Presence-only view of the optional server secrets. Returns booleans, never
 * values, so it is safe to log or surface in a dev-only diagnostic.
 */
export function serverEnvPresence(): Record<string, boolean> {
  return {
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    RESEND_API_KEY: Boolean(process.env.RESEND_API_KEY),
    EMAIL_FROM: Boolean(process.env.EMAIL_FROM),
  }
}

/** Variable names this app reads on the server, for documentation. */
export const SERVER_ENV_VAR_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY',
  'EMAIL_FROM',
] as const
