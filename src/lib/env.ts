import { z } from 'zod'

/**
 * Environment configuration for the Toronto Academy finance application.
 *
 * Two separate schemas are exported:
 *
 * - `publicEnv` is safe to reference from Client Components. It only ever reads
 *   `NEXT_PUBLIC_*` variables, which Next.js inlines into the browser bundle.
 * - `serverEnv()` additionally exposes secrets and MUST only be imported from
 *   server-only modules. See `src/lib/env.server.ts`.
 *
 * Never add a secret to the public schema. Anything reachable from this file's
 * public exports is assumed to be world-readable.
 */

/** Supabase supports either the newer publishable key or the legacy anon key. */
const publicSchema = z
  .object({
    NEXT_PUBLIC_SUPABASE_URL: z
      .string()
      .min(1, 'NEXT_PUBLIC_SUPABASE_URL is required')
      .url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL'),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  })
  .refine(
    (env) =>
      Boolean(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    {
      message:
        'Either NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (preferred) or NEXT_PUBLIC_SUPABASE_ANON_KEY must be set',
      path: ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'],
    },
  )

export type PublicEnv = z.infer<typeof publicSchema>

/**
 * Next.js only inlines `process.env.NEXT_PUBLIC_*` when the property is
 * accessed statically, so these must be written out literally rather than
 * looped over.
 */
const rawPublicEnv = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
}

const parsedPublicEnv = publicSchema.safeParse(rawPublicEnv)

/**
 * Whether the browser/server-shared Supabase configuration is complete.
 * Safe to call from anywhere — it reveals presence, never values.
 */
export function isPublicEnvConfigured(): boolean {
  return parsedPublicEnv.success
}

/**
 * Human-readable list of what is missing, for server logs and the dev-only
 * health check. Contains variable NAMES and validation messages only.
 */
export function publicEnvIssues(): string[] {
  if (parsedPublicEnv.success) return []
  return parsedPublicEnv.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  )
}

/**
 * Validated public environment. Throws if configuration is incomplete, so call
 * it only where a missing value is genuinely fatal (e.g. creating a client).
 */
export function publicEnv(): PublicEnv {
  if (!parsedPublicEnv.success) {
    throw new Error(
      `Invalid Supabase public environment configuration:\n${publicEnvIssues().join('\n')}`,
    )
  }
  return parsedPublicEnv.data
}

/** The key the Supabase clients should send, preferring the newer name. */
export function supabasePublishableKey(): string {
  const env = publicEnv()
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!key) {
    throw new Error(
      'Neither NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY nor NEXT_PUBLIC_SUPABASE_ANON_KEY is set',
    )
  }
  return key
}

/** Variable names this app reads, for documentation and the health check. */
export const PUBLIC_ENV_VAR_NAMES = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
] as const
