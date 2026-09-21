/**
 * FINANCE-GRID-03B — counts the Supabase requests the *real* grid loader makes.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     --import ./scripts/finance-qa/loader-request-count.hooks.mts \
 *     scripts/finance-qa/loader-request-count.mts
 *
 * `src/lib/finance/grid/load.ts` is `server-only` and reads its session from
 * `next/headers`, so it cannot be imported by a plain script. The companion
 * hooks file registers Node module customization hooks that resolve the `@/`
 * alias and stand in for `server-only` (an empty module) and `next/headers`
 * (a `cookies()` that returns the QA admin session's cookies), so the loader
 * runs exactly as written against hosted Supabase under RLS. Global `fetch`
 * is wrapped to count every request to the project's REST endpoint.
 *
 * Read-only: the loader has no write path, and the wrapper records URLs only
 * (query strings are reported without values). Nothing else is changed.
 */

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { readEnvironment } from '../finance-import/importer/supabase-write.mts'

import { openHostedSession, sessionCookies } from './hosted-session.mts'

interface Probe {
  label: string
  program?: string
  batch?: string
}

function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

async function main(): Promise<number> {
  const repoRoot = repoRootFromHere()
  const session = await openHostedSession(repoRoot)

  // `src/lib/env.ts` validates the public variables from `process.env` at
  // import time; a plain Node process does not load `.env.local`.
  const env = readEnvironment(repoRoot)
  for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']) {
    if (env[name] && !process.env[name]) process.env[name] = env[name]
  }

  // The stub `next/headers` reads this. Set before the loader is imported.
  const cookieStore = globalThis as unknown as { __qaCookies?: { name: string; value: string }[] }
  cookieStore.__qaCookies = sessionCookies(session.projectRef, session.session)

  // Count REST requests, by table. Auth calls are counted separately.
  const rest = new URL('/rest/v1/', session.supabaseUrl).toString()
  const auth = new URL('/auth/v1/', session.supabaseUrl).toString()
  let restCalls: string[] = []
  let authCalls = 0
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith(rest)) {
      const parsed = new URL(url)
      restCalls.push(`${parsed.pathname.slice('/rest/v1/'.length)}?${[...parsed.searchParams.keys()].join(',')}`)
    } else if (url.startsWith(auth)) {
      authCalls += 1
    }
    return original(input, init)
  }) as typeof fetch

  const { loadFinanceGrid } = await import('../../src/lib/finance/grid/load.ts')

  // Batches by name, so the probes read like the ticket.
  const first = await loadFinanceGrid({})
  restCalls = []
  authCalls = 0
  const byName = new Map(first.batches.map((batch) => [batch.name, batch.id]))

  const probes: Probe[] = [
    { label: 'default (PSW newest)' },
    { label: '27th April 2026 - Evening (largest PSW, 26)', program: 'PSW', batch: byName.get('27th April 2026 - Evening') },
    { label: '29th JULY, 2026 - Morning (smallest, 6)', program: 'PSW', batch: byName.get('29th JULY, 2026 - Morning') },
    { label: 'ECEA ELCE 25 & 26 (50)', program: 'ECEA' },
    { label: 'Unassigned — no batch', program: 'PSW', batch: 'unassigned' },
  ]

  const results: { label: string; rows: number; restRequests: number; authRequests: number; requests: string[] }[] = []
  for (const probe of probes) {
    restCalls = []
    authCalls = 0
    const view = await loadFinanceGrid({ program: probe.program, batch: probe.batch })
    results.push({
      label: probe.label,
      rows: view.rows.length,
      restRequests: restCalls.length,
      authRequests: authCalls,
      requests: [...restCalls],
    })
  }

  for (const result of results) {
    console.log(`${result.label}: ${result.rows} rows, ${result.restRequests} REST requests, ${result.authRequests} auth requests`)
    for (const request of result.requests) console.log(`    ${request}`)
  }

  await session.signOut()
  return 0
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exit(1)
  },
)
