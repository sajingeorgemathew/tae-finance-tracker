/**
 * The apply, rendered as one atomic SQL statement — generated, never run here.
 *
 * The whole cutover is a single `DO` block, so it is a single transaction: it
 * either commits completely or leaves the database exactly as it was. Inside
 * it, in order:
 *
 *  1. **Pre-state gate.** Recomputes the fingerprint (count, id-set md5 and
 *     full-row md5 per table, plus the email/phone counts) and raises unless
 *     it equals the one the plan was computed against. A single changed row
 *     anywhere stops it before anything is touched.
 *  2. **Deletes** in foreign-key order, each checked for the exact row count.
 *  3. **Inserts** in dependency order through `jsonb_populate_recordset`, each
 *     checked for the exact row count. Timestamps are left to their column
 *     defaults; every other column is written as planned.
 *  4. **One audit row** naming the plan, workbook, backup and target hashes.
 *  5. **Post-state gate.** Every table's count and the email/phone counts
 *     must equal the plan's expected post-state, and no finance record may
 *     point at a missing student or batch; otherwise it raises and the whole
 *     block rolls back.
 *
 * The data travels inline as dollar-quoted JSON with a tag proved absent from
 * the payload. No value is ever spliced into SQL text unquoted.
 */

import { BACKUP_TABLES } from './config.mts'
import { fingerprintExpression } from './hosted.mts'
import { DELETE_ORDER, type CutoverPlan } from './plan.mts'
import { INSERT_TABLES, type TargetDataset } from './target.mts'

/** A dollar-quote tag that does not occur in `text`. */
export function safeDollarTag(text: string, base: string): string {
  let tag = base
  let index = 0
  while (text.includes(`$${tag}$`)) {
    index += 1
    tag = `${base}${index}`
  }
  return tag
}

function quoteJson(value: unknown, base: string): string {
  const text = JSON.stringify(value)
  const tag = safeDollarTag(text, base)
  return `$${tag}$${text}$${tag}$::jsonb`
}

/** Column names the inserts write, per table: the keys every planned row carries. */
export function insertColumnsOf(rows: readonly Record<string, unknown>[]): string[] {
  if (rows.length === 0) return []
  const keys = Object.keys(rows[0]).sort()
  for (const row of rows) {
    const other = Object.keys(row).sort()
    if (other.join(',') !== keys.join(',')) throw new Error('planned rows of one table carry different columns')
  }
  return keys
}

function identifierList(columns: readonly string[]): string {
  for (const column of columns) {
    if (!/^[a-z_][a-z0-9_]*$/.test(column)) throw new Error(`unexpected column name ${JSON.stringify(column)}`)
  }
  return columns.join(', ')
}

/**
 * Finance record ids per collection mode. Written into the cutover's audit
 * row so the next ticket can read every record's approved strategy from
 * hosted without a schema change.
 */
export function collectionModesOf(target: TargetDataset): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const link of target.links) (out[link.collectionMode] ??= []).push(link.financeRecordId)
  for (const ids of Object.values(out)) ids.sort()
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

export function renderApplySql(plan: CutoverPlan, planHash: string, target: TargetDataset): string {
  const fingerprintObject =
    `jsonb_build_object('tables', jsonb_build_object(${BACKUP_TABLES.map((table) => `'${table}', ${fingerprintExpression(table)}::jsonb`).join(', ')}), ` +
    `'studentsEmailNonNull', (select count(*) from public.students where email is not null), ` +
    `'studentsPhoneNonNull', (select count(*) from public.students where phone is not null))`

  const lines: string[] = []
  lines.push(`-- FINANCE-CUTOVER-05A apply. GENERATED — do not edit by hand.`)
  lines.push(`-- plan sha256:     ${planHash}`)
  lines.push(`-- target sha256:   ${plan.targetHash}`)
  lines.push(`-- workbook sha256: ${plan.workbook.sha256}`)
  lines.push(`-- backup sha256:   ${plan.backup.sha256}`)
  lines.push(`-- restore sha256:  ${plan.restore.sha256} (${plan.restore.file})`)
  lines.push(`-- One DO block = one transaction. Any failed check raises and rolls everything back.`)
  lines.push(`do $cutover$`)
  lines.push(`declare`)
  lines.push(`  v_expected_pre jsonb := ${quoteJson(plan.preState, 'pre')};`)
  lines.push(`  v_expected_post jsonb := ${quoteJson(plan.expectedPost, 'post')};`)
  lines.push(`  v_deletes jsonb := ${quoteJson(plan.deletes, 'del')};`)
  lines.push(`  v_data jsonb := ${quoteJson(target.inserts, 'data')};`)
  lines.push(`  v_actual jsonb;`)
  lines.push(`  n bigint;`)
  lines.push(`begin`)
  lines.push(`  -- 1. pre-state gate`)
  lines.push(`  v_actual := ${fingerprintObject};`)
  lines.push(`  if v_actual is distinct from v_expected_pre then`)
  lines.push(`    raise exception 'STALE_PRESTATE: hosted state differs from the plan''s pre-state; nothing changed';`)
  lines.push(`  end if;`)
  lines.push(``)
  lines.push(`  -- 2. deletes, foreign-key order`)
  for (const table of DELETE_ORDER) {
    lines.push(`  delete from public.${table} where id in (select (jsonb_array_elements_text(v_deletes->'${table}'))::uuid);`)
    lines.push(`  get diagnostics n = row_count;`)
    lines.push(`  if n <> ${plan.deletes[table].length} then raise exception 'DELETE_COUNT ${table}: % rows, expected ${plan.deletes[table].length}', n; end if;`)
  }
  lines.push(``)
  lines.push(`  -- 3. inserts, dependency order`)
  for (const table of INSERT_TABLES) {
    const rows = target.inserts[table]
    if (rows.length === 0) continue
    const columns = identifierList(insertColumnsOf(rows))
    const extra = table === 'import_batches' ? ', completed_at' : ''
    const extraValue = table === 'import_batches' ? ', now()' : ''
    lines.push(`  insert into public.${table} (${columns}${extra})`)
    lines.push(`    select ${columns}${extraValue} from jsonb_populate_recordset(null::public.${table}, v_data->'${table}');`)
    lines.push(`  get diagnostics n = row_count;`)
    lines.push(`  if n <> ${rows.length} then raise exception 'INSERT_COUNT ${table}: % rows, expected ${rows.length}', n; end if;`)
  }
  lines.push(``)
  lines.push(`  -- 3b. collection_mode on retained records (inserted records carry it in the row)`)
  for (const update of plan.collectionModeUpdates) {
    if (!/^[a-z_]+$/.test(update.mode)) throw new Error(`unexpected collection mode ${JSON.stringify(update.mode)}`)
    lines.push(`  update public.student_finance_records set collection_mode = '${update.mode}'`)
    lines.push(`    where collection_mode is null and id in (select (jsonb_array_elements_text(${quoteJson(update.ids, 'ids')}))::uuid);`)
    lines.push(`  get diagnostics n = row_count;`)
    lines.push(`  if n <> ${update.ids.length} then raise exception 'COLLECTION_MODE_UPDATE ${update.mode}: % rows, expected ${update.ids.length}', n; end if;`)
  }
  const importBatchId = target.inserts.import_batches[0]?.id ?? null
  lines.push(``)
  lines.push(`  -- 4. the cutover's own audit row`)
  lines.push(`  insert into public.audit_log (actor_user_id, entity_type, entity_id, action, before_data, after_data, metadata)`)
  lines.push(
    `    values (null, 'import_batches', ${importBatchId === null ? 'null' : `'${importBatchId}'::uuid`}, 'finance_cutover_05a_apply', ` +
      `${quoteJson(plan.counts.current, 'before')}, ${quoteJson(plan.counts.target, 'after')}, ` +
      `${quoteJson({ ticket: plan.ticket, plan_sha256: planHash, target_sha256: plan.targetHash, workbook_sha256: plan.workbook.sha256, backup_sha256: plan.backup.sha256, deleted: Object.fromEntries(DELETE_ORDER.map((table) => [table, plan.deletes[table].length])), inserted: plan.counts.insert, restore_sha256: plan.restore.sha256, collection_modes: collectionModesOf(target) }, 'meta')});`,
  )
  lines.push(``)
  lines.push(`  -- 5. post-state gate`)
  lines.push(
    `  v_actual := jsonb_build_object(${BACKUP_TABLES.map((table) => `'${table}', (select count(*) from public.${table})`).join(', ')}, ` +
      `'studentsEmailNonNull', (select count(*) from public.students where email is not null), ` +
      `'studentsPhoneNonNull', (select count(*) from public.students where phone is not null));`,
  )
  lines.push(`  if v_actual is distinct from v_expected_post then`)
  lines.push(`    raise exception 'POST_STATE_MISMATCH: % expected %', v_actual, v_expected_post;`)
  lines.push(`  end if;`)
  lines.push(`  select count(*) into n from public.student_finance_records r`)
  lines.push(`    where not exists (select 1 from public.students s where s.id = r.student_id)`)
  lines.push(`       or (r.batch_id is not null and not exists (select 1 from public.batches b where b.id = r.batch_id));`)
  lines.push(`  if n <> 0 then raise exception 'POST_STATE_DANGLING: % finance record(s)', n; end if;`)
  lines.push(`  v_actual := coalesce((select jsonb_object_agg(coalesce(collection_mode, 'NULL'), c) from (select collection_mode, count(*) as c from public.student_finance_records group by collection_mode) m), '{}'::jsonb);`)
  lines.push(`  if v_actual is distinct from ${quoteJson(plan.expectedCollectionModes, 'modes')} then`)
  lines.push(`    raise exception 'POST_STATE_COLLECTION_MODE: % expected %', v_actual, ${quoteJson(plan.expectedCollectionModes, 'modes')};`)
  lines.push(`  end if;`)
  lines.push(`  raise notice 'FINANCE-CUTOVER-05A applied: plan ${planHash}';`)
  lines.push(`end`)
  lines.push(`$cutover$;`)
  return `${lines.join('\n')}\n`
}

export const PROBE_MARKER = 'CUTOVER_05A_PROBE_OK'

/**
 * The apply statement with a `raise` as the very first statement of the body.
 *
 * PL/pgSQL evaluates the DECLARE initialisers (every JSON payload) and parses
 * the block before running its first statement, which then raises — so a
 * probe proves the payload is accepted and parses, and can never reach a
 * DELETE or INSERT. The CLI reports the raise as an error; the marker in it
 * is the success signal.
 */
export function renderProbeSql(applySql: string): string {
  const marker = '\nbegin\n'
  const at = applySql.indexOf(marker)
  if (at === -1 || applySql.indexOf(marker, at + 1) !== -1) throw new Error('apply statement does not have exactly one body')
  const head = applySql.slice(0, at + marker.length)
  const body = applySql.slice(at + marker.length)
  if (!body.startsWith('  -- 1. pre-state gate')) throw new Error('unexpected apply statement layout')
  return `${head}  raise exception '${PROBE_MARKER}: payload parsed, % bytes of data', length(v_data::text);\n${body}`
}

/** A read-only catalog query: which planned insert columns do not exist on hosted. */
export function renderColumnCheckSql(target: TargetDataset): string {
  const pairs = INSERT_TABLES.flatMap((table) => insertColumnsOf(target.inserts[table]).map((column) => `('${table}', '${column}')`))
  pairs.push(`('import_batches', 'completed_at')`)
  return (
    `select coalesce(json_agg(p.t || '.' || p.c order by p.t, p.c), '[]'::json) as missing from (values ${pairs.join(', ')}) as p(t, c)\n` +
    `where not exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = p.t and c.column_name = p.c);\n`
  )
}
