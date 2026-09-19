/**
 * FINANCE-IMPORT-02 — re-render the committed apply report.
 *
 *   npm run finance:import:apply-report            rewrite the report
 *   npm run finance:import:apply-report -- --check verify it is up to date
 *
 * The apply happened once and must never happen again, so the document it
 * produced cannot be refreshed by re-running it. This script renders the same
 * document from the same inputs instead: the recorded apply result, the plan
 * rebuilt from the workbook, and the operator verification recorded in
 * `importer/operator-verification.mts`.
 *
 * **It cannot write to the database and it cannot import.** The apply, the
 * pre-flight gate and the write module are absent from this file's runtime
 * import graph — what it takes from them is types, which are erased. The
 * planner it does use reads the workbook and nothing else. Nothing here takes
 * an `--apply` flag, because there is nothing here to apply.
 *
 * `--check` renders and compares without writing, which is how a reviewer
 * confirms that the committed report is what these inputs produce rather than
 * something edited by hand afterwards.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { renderApplyReport } from './importer/apply-report.mts'
import { APPLY_OPERATOR_VERIFICATION } from './importer/operator-verification.mts'
import { buildDryRunPlan } from './importer/plan.mts'
import { hashWorkbookOnDisk } from './lib/workbook-source.mts'

import type { ApplyResult } from './importer/apply.mts'
import type { RlsVerification } from './importer/rls-verification.mts'

const RESULT_PATH = path.join('.private', 'finance-import-analysis', 'import-apply-result.json')
const APPLY_REPORT_PATH = path.join('docs', 'FINANCE-IMPORT-02-APPLY.md')

/** The recorded apply, as `import-workbook.mts` wrote it. */
export interface RecordedApply {
  result: ApplyResult
  rls: RlsVerification
  workbookUnchanged: boolean
  appliedAt: string
}

function repoRelative(target: string): string {
  return target.split(path.sep).join('/')
}

/**
 * Reads the recorded apply, refusing anything that would render a report
 * describing a run that did not happen. The report names a batch ID and an
 * import type; both come from here, and neither is defaulted.
 */
export function parseRecordedApply(json: string): RecordedApply {
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('the recorded apply result is not an object')
  }

  const { result, rls, workbookUnchanged, appliedAt } = parsed as Partial<RecordedApply>

  if (!result || typeof result !== 'object') throw new Error('no `result` in the recorded apply')
  if (typeof result.importBatchId !== 'string' || result.importBatchId.length === 0) {
    throw new Error('the recorded apply has no import batch ID')
  }
  if (typeof result.importType !== 'string' || result.importType.length === 0) {
    throw new Error('the recorded apply has no import_type')
  }
  if (typeof result.workbookSha256 !== 'string' || result.workbookSha256.length === 0) {
    throw new Error('the recorded apply has no workbook SHA-256')
  }
  if (!rls || typeof rls !== 'object') throw new Error('no `rls` in the recorded apply')
  if (typeof appliedAt !== 'string' || Number.isNaN(Date.parse(appliedAt))) {
    throw new Error('the recorded apply has no usable `appliedAt` timestamp')
  }

  return { result, rls, workbookUnchanged: workbookUnchanged === true, appliedAt }
}

export interface RegenerateOptions {
  repoRoot: string
  now: Date
}

/** Renders the report from the recorded inputs. Reads; never writes. */
export function renderRecordedApplyReport(options: RegenerateOptions): {
  markdown: string
  recorded: RecordedApply
} {
  const { repoRoot, now } = options
  const recorded = parseRecordedApply(readFileSync(path.join(repoRoot, RESULT_PATH), 'utf8'))

  const workbookSha256 = hashWorkbookOnDisk(repoRoot)
  if (workbookSha256 !== recorded.result.workbookSha256) {
    throw new Error(
      'the workbook on disk is not the workbook that was imported ' +
        `(${workbookSha256} vs the recorded ${recorded.result.workbookSha256}). ` +
        'Regenerating would describe the import with a different file.',
    )
  }
  if (APPLY_OPERATOR_VERIFICATION.workbook.sha256 !== recorded.result.workbookSha256) {
    throw new Error(
      'the operator verification records a different workbook hash than the apply did ' +
        `(${APPLY_OPERATOR_VERIFICATION.workbook.sha256} vs ${recorded.result.workbookSha256})`,
    )
  }

  const plan = buildDryRunPlan(repoRoot, now)

  return {
    recorded,
    markdown: renderApplyReport({
      result: recorded.result,
      plan,
      workbookUnchanged: recorded.workbookUnchanged,
      appliedAt: new Date(recorded.appliedAt),
      privateOutputs: [repoRelative(RESULT_PATH)],
      rls: recorded.rls,
      operator: APPLY_OPERATOR_VERIFICATION,
    }),
  }
}

function main(): void {
  const repoRoot = process.cwd()
  const flags = process.argv.slice(2).filter((argument) => argument.startsWith('--'))
  const unknown = flags.filter((flag) => flag !== '--check')
  if (unknown.length > 0) {
    console.error(`Unrecognised option(s): ${unknown.join(', ')}`)
    process.exit(2)
  }
  const checkOnly = flags.includes('--check')

  console.log('FINANCE-IMPORT-02 — apply report regeneration')
  console.log('No database access. No import. Rendering from the recorded apply result.')
  console.log('')

  const { markdown, recorded } = renderRecordedApplyReport({ repoRoot, now: new Date() })

  console.log(`Source        ${repoRelative(RESULT_PATH)}`)
  console.log(`Batch ID      ${recorded.result.importBatchId}`)
  console.log(`import_type   ${recorded.result.importType}`)
  console.log(`Status        ${recorded.result.status}`)
  console.log(`Workbook      ${recorded.result.workbookSha256}`)
  console.log(`Applied at    ${recorded.appliedAt}`)
  console.log('')

  const target = path.join(repoRoot, APPLY_REPORT_PATH)
  const current = readFileSync(target, 'utf8')

  if (current === markdown) {
    console.log(`${repoRelative(APPLY_REPORT_PATH)} is byte-identical to the regenerated report.`)
    return
  }

  if (checkOnly) {
    console.error(
      `${repoRelative(APPLY_REPORT_PATH)} differs from what these inputs render. ` +
        'Run without --check to rewrite it.',
    )
    process.exit(1)
  }

  writeFileSync(target, markdown, 'utf8')
  console.log(`Rewrote ${repoRelative(APPLY_REPORT_PATH)}.`)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) main()
