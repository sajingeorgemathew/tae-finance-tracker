/**
 * Module customization hooks for `loader-request-count.mts`.
 *
 * Lets the real `src/lib/finance/grid/load.ts` run under plain Node:
 *
 *   * `@/…` resolves to `src/…`, as `tsconfig.json` maps it;
 *   * `server-only` resolves to an empty module — the guard exists to keep the
 *     file out of a browser bundle, and this is a Node process;
 *   * `next/headers` resolves to a stub whose `cookies()` returns the QA
 *     session's cookies, so `createServerClient` sees a signed-in admin.
 *
 * Nothing else is intercepted.
 */

import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const STUB_SERVER_ONLY = 'data:text/javascript,export {}'
const STUB_NEXT_HEADERS = `data:text/javascript,${encodeURIComponent(`
export async function cookies() {
  const jar = globalThis.__qaCookies ?? []
  return {
    getAll: () => jar.map((cookie) => ({ ...cookie })),
    get: (name) => jar.find((cookie) => cookie.name === name),
    set: () => {},
  }
}
`)}`

register(
  `data:text/javascript,${encodeURIComponent(`
const repoRoot = ${JSON.stringify(pathToFileURL(repoRoot + path.sep).href)}
export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: ${JSON.stringify(STUB_SERVER_ONLY)}, shortCircuit: true }
  if (specifier === 'next/headers') return { url: ${JSON.stringify(STUB_NEXT_HEADERS)}, shortCircuit: true }
  if (specifier.startsWith('@/')) {
    const target = new URL('src/' + specifier.slice(2), repoRoot).href
    const candidates = [target, target + '.ts', target + '.tsx']
    for (const candidate of candidates) {
      try { return await next(candidate, context) } catch {}
    }
  }
  return next(specifier, context)
}
`)}`,
)
