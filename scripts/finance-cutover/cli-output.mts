/**
 * Parsing `supabase db query --output-format json` output (CLI 3.0.0).
 *
 * The CLI prints exactly one JSON document on stdout, in one of three shapes,
 * observed against the hosted project on 2026-11-03:
 *
 *  * **Human shell** — a bare array of row objects: `[ {...}, ... ]` (`[]` when
 *    no rows). This is what a person running the launch from their own
 *    terminal gets.
 *  * **Agent shell** (the CLI detects an AI agent from the environment) — an
 *    envelope `{ "boundary": "<hex>", "rows": [ ... ], "warning": "..." }`.
 *  * **Query failure** (either shell, exit 1) — `{ "_tag": "Error", "target":
 *    {...}, "error": { "code": "...", "message": "..." } }`. The SQL error is
 *    here, on stdout; stderr only carries the CLI's status lines.
 *
 * stderr on success is two status lines (`Warning: --linked is deprecated…`,
 * `Target: project …`). Anything error-like on stderr fails the query even
 * when the exit code is 0.
 *
 * The parser takes the whole of stdout as one document: trailing or leading
 * text, a second document, or any other shape is an error, never skipped.
 */

export type CliRow = Record<string, unknown>

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['boundary', 'rows', 'warning'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rowsOf(value: unknown[], where: string): CliRow[] {
  value.forEach((row, index) => {
    if (!isPlainObject(row)) throw new Error(`linked query output: ${where} row ${index} is not an object`)
  })
  return value as CliRow[]
}

/** The message of a CLI `_tag: "Error"` document, or null if `stdout` is not one. */
export function cliErrorOf(stdout: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (!isPlainObject(parsed) || parsed._tag !== 'Error') return null
  const error = isPlainObject(parsed.error) ? parsed.error : {}
  const code = typeof error.code === 'string' ? error.code : 'unknown'
  const message = typeof error.message === 'string' ? error.message : JSON.stringify(parsed.error ?? null)
  return `${code}: ${message}`
}

/** stderr lines that report a failure (as opposed to the CLI's status lines). */
export function stderrProblems(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(error|fatal|panic)\b/i.test(line))
}

/** The rows of one successful `db query --output-format json` run. Throws on anything else. */
export function parseCliRows(stdout: string): CliRow[] {
  const text = stdout.trim()
  if (text === '') throw new Error('linked query printed no output')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`linked query output is not a single JSON document: ${(error as Error).message}`)
  }
  if (Array.isArray(parsed)) return rowsOf(parsed, 'array')
  if (!isPlainObject(parsed)) throw new Error(`linked query output is a JSON ${parsed === null ? 'null' : typeof parsed}, not rows`)
  if (parsed._tag === 'Error') throw new Error(`linked query failed: ${cliErrorOf(text)}`)
  const unknown = Object.keys(parsed).filter((key) => !ENVELOPE_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`linked query output has unrecognised keys: ${unknown.join(', ')}`)
  if (!Array.isArray(parsed.rows)) throw new Error('linked query output envelope has no rows array')
  if (parsed.boundary !== undefined && typeof parsed.boundary !== 'string') throw new Error('linked query output envelope boundary is not a string')
  return rowsOf(parsed.rows, 'envelope')
}
