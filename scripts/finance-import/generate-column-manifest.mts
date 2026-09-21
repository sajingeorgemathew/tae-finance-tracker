/**
 * FINANCE-COLUMN-MANIFEST-03A — the batch column manifest generator.
 *
 *   npm run finance:manifest                      dry run: plan, report, write nothing committable
 *   npm run finance:manifest -- --write-migration  also (re)write the data migration
 *   npm run finance:manifest -- --check            verify the committed migration is current
 *
 * Reads the historical finance workbook from `reference/` — read-only, from a
 * buffer, re-hashed afterwards — walks every batch table with the importer's
 * own block detection, and derives the complete column layout of each table:
 * which columns existed, in what order, headed how, in which section, holding
 * money or text. It then proves each table maps to exactly one hosted batch
 * by deterministic identity, and renders the layout as a source-controlled
 * SQL data migration.
 *
 * The workbook is needed here and nowhere else. The application never reads
 * it: the migration this produces is what a fresh environment runs, and this
 * script exists to reproduce and audit that migration from its source.
 *
 * ## What it writes
 *
 *   .private/finance-import-analysis/column-manifest-plan.json   Git-ignored
 *   supabase/migrations/<version>_batch_finance_columns_legacy_manifest.sql
 *                                                only with --write-migration
 *
 * Nothing here writes to the database. The only Supabase access is a read of
 * `batches` and `programs` through `importer/supabase-readonly.mts`, to
 * confirm the mapping; applying the migration is a separate, reviewed
 * `supabase db push`.
 *
 * ## Refusals
 *
 * The migration is not written when any table is unmatched or ambiguous, when
 * hosted batches could not be read, when the workbook is not the approved one,
 * or when the rendered SQL contains a string literal the layout does not
 * account for. Console output is aggregate and layout-only throughout: batch
 * codes and column headings, never a student, an amount or a remark.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { APPROVED_WORKBOOK_SHA256 } from './importer/apply-preflight.mts'
import { discoverBatchTables } from './importer/batch-tables.mts'
import {
  findUnexpectedArtifactLiterals,
  planColumnManifest,
  renderManifestMigration,
  type ManifestPlan,
} from './importer/column-manifest.mts'
import { readBatchIdentities } from './importer/supabase-readonly.mts'
import { hashWorkbookOnDisk, openWorkbook, WorkbookDiscoveryError } from './lib/workbook-source.mts'

const PRIVATE_DIR = path.join('.private', 'finance-import-analysis')
const PRIVATE_PLAN = 'column-manifest-plan.json'

/**
 * The data migration this generator owns.
 *
 * Fixed rather than timestamped per run: the artifact is regenerated in
 * place, and `--check` compares against exactly this file. Creating a new
 * migration per run would apply the same rows twice under two versions.
 */
export const MANIFEST_MIGRATION_FILE =
  '20260920120100_batch_finance_columns_legacy_manifest.sql'
export const MANIFEST_MIGRATION_PATH = `supabase/migrations/${MANIFEST_MIGRATION_FILE}`

const REGENERATE_COMMAND = 'npm run finance:manifest -- --write-migration'

interface Options {
  writeMigration: boolean
  check: boolean
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { writeMigration: false, check: false }
  for (const arg of argv) {
    if (arg === '--write-migration') options.writeMigration = true
    else if (arg === '--check') options.check = true
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (options.writeMigration && options.check) {
    throw new Error('--write-migration and --check are mutually exclusive')
  }
  return options
}

function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/** Aggregate, layout-only. Every line here is safe for a terminal or a doc. */
function printSummary(plan: ManifestPlan): void {
  const { counts } = plan
  const lines = [
    '',
    'FINANCE-COLUMN-MANIFEST-03A — dry-run manifest plan',
    `  workbook SHA-256:                 ${plan.workbookHash}`,
    `  source batch tables:              ${counts.sourceBatchTables}`,
    `  hosted batches matched:           ${counts.matchedBatches}`,
    `  ambiguous mappings:               ${counts.ambiguousMappings}`,
    `  unmatched supported tables:       ${counts.unmatchedTables}`,
    `  manifest rows:                    ${counts.rows}`,
    `    ACTUAL section rows:            ${counts.actualRows}`,
    `    INSTALLMENT section rows:       ${counts.installmentRows}`,
    `    grid-visible (money) rows:      ${counts.gridVisibleRows}`,
    `    hidden text rows:               ${counts.hiddenTextRows}`,
    `    all-blank but visible rows:     ${counts.allBlankVisibleRows}`,
    `    all-blank hidden rows:          ${counts.allBlankHiddenRows}`,
    `    all-blank installment rows:     ${counts.allBlankInstallmentRows}`,
    `    batches with all-blank columns: ${counts.batchesWithAllBlankColumns}`,
    `  rows by program:                  ${JSON.stringify(counts.rowsByProgram)}`,
    `  rows by role:                     ${JSON.stringify(counts.rowsByRole)}`,
    '',
    '  restored grid-visible columns (blank in every student row of the batch):',
    ...plan.restoredColumns.map(
      (column) =>
        `    ${column.programShortCode.padEnd(4)} ${column.batchCode.padEnd(28)} ` +
        `${column.section}:${column.letter.padEnd(3)} ${JSON.stringify(column.header)} (${column.role})`,
    ),
    '',
    '  hidden text columns kept in the manifest:',
    ...plan.rows
      .filter((row) => !row.isGridVisible)
      .map(
        (row) =>
          `    ${row.programShortCode.padEnd(4)} ${row.batchCode.padEnd(28)} ` +
          `${row.section}:${row.sourceColumnLetter.padEnd(3)} ${JSON.stringify(row.sourceHeader)} ` +
          `(${row.normalizedRole}${row.allBlankInSource ? ', all blank' : ''})`,
      ),
  ]
  if (plan.blockers.length > 0) {
    lines.push('', '  BLOCKERS:', ...plan.blockers.map((blocker) => `    - ${blocker}`))
  }
  console.log(lines.join('\n'))
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  const repoRoot = repoRootFromHere()

  // --- 1. The workbook, and proof it is the approved one ----------------------
  let source
  try {
    source = openWorkbook(repoRoot, new Date())
  } catch (error: unknown) {
    if (error instanceof WorkbookDiscoveryError) {
      console.error(error.message)
      return 2
    }
    throw error
  }

  const hash = source.fingerprint.sha256
  console.log(`workbook: ${source.fingerprint.relativePath}`)
  console.log(`sha256:   ${hash}`)

  if (hash !== APPROVED_WORKBOOK_SHA256) {
    console.error(
      `STOP: workbook hash differs from the approved import hash ${APPROVED_WORKBOOK_SHA256}. ` +
        'The historical batches were imported from that exact file; a layout derived from a ' +
        'different one would describe tables that do not exist. Nothing written.',
    )
    return 2
  }

  // --- 2. Tables, and hosted batches to match them against -------------------
  const discovery = discoverBatchTables(source.workbook)
  console.log(
    `tables:   ${discovery.supported.length} supported, ${discovery.skipped.length} skipped ` +
      `(${discovery.skipped.map((entry) => `${entry.sheetName}: ${entry.status}`).join('; ') || 'none'})`,
  )

  const hosted = await readBatchIdentities(repoRoot)
  console.log(`hosted:   ${hosted.availability.reason}`)
  if (!hosted.availability.available || hosted.error !== null) {
    console.error(
      `STOP: hosted batches could not be read${hosted.error ? ` (${hosted.error})` : ''}; ` +
        'the mapping cannot be proven, so no migration will be written.',
    )
    return 2
  }
  console.log(`          ${hosted.batches.length} hosted batches read`)

  // --- 3. The plan ------------------------------------------------------------
  const plan = planColumnManifest(hash, discovery.supported, hosted.batches)
  printSummary(plan)

  mkdirSync(path.join(repoRoot, PRIVATE_DIR), { recursive: true })
  const privatePath = path.join(repoRoot, PRIVATE_DIR, PRIVATE_PLAN)
  writeFileSync(
    privatePath,
    `${JSON.stringify(
      {
        fingerprint: source.fingerprint,
        counts: plan.counts,
        blockers: plan.blockers,
        matches: plan.matches,
        restoredColumns: plan.restoredColumns,
        skippedTables: discovery.skipped,
        rows: plan.rows,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\nwrote ${path.join(PRIVATE_DIR, PRIVATE_PLAN).split(path.sep).join('/')} (Git-ignored)`)

  if (plan.blockers.length > 0) {
    console.error('\nSTOP: the plan has blockers; no migration written.')
    return 1
  }

  // --- 4. The artifact, and the privacy gate on it ---------------------------
  const sql = renderManifestMigration(plan, { regenerateCommand: REGENERATE_COMMAND })
  const unexpected = findUnexpectedArtifactLiterals(sql, plan)
  if (unexpected.length > 0) {
    console.error(
      `STOP: the rendered migration contains ${unexpected.length} string literal(s) the layout ` +
        'does not account for; refusing to write it.',
    )
    return 1
  }

  const migrationPath = path.join(repoRoot, MANIFEST_MIGRATION_PATH)

  if (options.check) {
    if (!existsSync(migrationPath)) {
      console.error(`CHECK FAILED: ${MANIFEST_MIGRATION_PATH} does not exist`)
      return 1
    }
    const committed = readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n')
    if (committed !== sql) {
      console.error(`CHECK FAILED: ${MANIFEST_MIGRATION_PATH} differs from the regenerated layout`)
      return 1
    }
    console.log(`check:    ${MANIFEST_MIGRATION_PATH} is current`)
  } else if (options.writeMigration) {
    writeFileSync(migrationPath, sql, 'utf8')
    console.log(`wrote     ${MANIFEST_MIGRATION_PATH} (${plan.counts.rows} rows)`)
  } else {
    console.log(`\ndry run only: pass --write-migration to write ${MANIFEST_MIGRATION_PATH}`)
  }

  // --- 5. Proof the workbook was not touched ----------------------------------
  const after = hashWorkbookOnDisk(repoRoot)
  if (after !== hash) {
    console.error(`WORKBOOK MODIFIED: hash before ${hash}, after ${after}`)
    return 3
  }
  console.log(`sha256 after: ${after} (unchanged)`)
  return 0
}

/**
 * Runs only when invoked directly. The test suite imports this module for
 * `MANIFEST_MIGRATION_PATH`, and an import must not open the workbook or
 * touch the network.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    },
  )
}
