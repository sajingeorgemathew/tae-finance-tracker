/**
 * FINANCE-STUDENT-SYNC-05B — the reviewable dry-run output.
 *
 * `renderPreviewCsv` is the row-level comparison a reviewer opens in a
 * spreadsheet (it carries names and contacts: private output only).
 * `renderSummary` is the aggregate, with no name, number or contact value.
 */

import { CLASSIFICATIONS, FIELD_STATUSES, SYNC_FIELDS, type ComparisonRow, type SyncPlan } from './reconcile.mts'

export const PREVIEW_COLUMNS = [
  'Student Number',
  'Current Name',
  'Incoming Name',
  'Current Email',
  'Incoming Email',
  'Current Phone',
  'Incoming Phone',
  'Current Batch',
  'Incoming Batch',
  'Classification',
  'Reason',
  'Warnings',
  'Field Status',
  'Source Row',
] as const

function csvCell(value: string | null): string {
  if (value === null) return ''
  // A leading = @, or + - not followed by digits only, would be evaluated as a
  // formula when the CSV is opened; a +1XXXXXXXXXX phone is left as it is.
  const safe = /^[=@]/.test(value) || /^[+-](?!\d+$)/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

const ORDER = new Map(CLASSIFICATIONS.map((item, index) => [item, index]))

/** Optional extra column, e.g. the old-master cross-check (warning only). */
export interface ExtraColumn {
  heading: string
  valueOf: (row: ComparisonRow) => string | null
}

export function renderPreviewCsv(rows: readonly ComparisonRow[], extra?: ExtraColumn): string {
  const sorted = [...rows].sort(
    (a, b) =>
      (ORDER.get(a.classification) ?? 0) - (ORDER.get(b.classification) ?? 0) ||
      (a.studentNumber ?? '').localeCompare(b.studentNumber ?? '') ||
      (a.rowRef ?? '').localeCompare(b.rowRef ?? ''),
  )
  const lines = [[...PREVIEW_COLUMNS, ...(extra ? [extra.heading] : [])].map(csvCell).join(',')]
  for (const row of sorted) {
    // Fields that are not NO_CHANGE, e.g. "email: SAFE_CONTACT_UPDATE; name: IDENTITY_REVIEW_REQUIRED".
    const fieldStatus = row.fields.filter((f) => f.status !== 'NO_CHANGE').map((f) => `${f.field}: ${f.status}`).join('; ')
    lines.push(
      [
        row.studentNumber,
        row.currentName,
        row.incomingName,
        row.currentEmail,
        row.incomingEmail,
        row.currentPhone,
        row.incomingPhone,
        row.currentBatch,
        row.incomingBatch,
        row.classification,
        row.reasons.join('; '),
        row.warnings.join('; '),
        fieldStatus,
        row.rowRef,
        ...(extra ? [extra.valueOf(row)] : []),
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

export function renderSummary(plan: SyncPlan, hash: string, extras: string[] = []): string {
  const s = plan.summary
  const c = s.byClassification
  const row = (label: string, value: number | string) => `| ${label} | ${value} |`
  return [
    `# ${plan.ticket} — current student data dry run`,
    '',
    `Plan hash: \`${hash}\` (review artifact; this ticket has no apply)`,
    `Source: ${plan.source.fileName} · sheet "${plan.source.sheet}" · header row ${plan.source.headerRow} · sha256 ${plan.source.sha256}`,
    `Columns read: ${Object.entries(plan.source.mapped).map(([field, heading]) => `${field} ← "${heading}"`).join(', ')}`,
    `Scope: ${plan.scope.cohorts.map((cohort) => cohort.label).join(', ')} (${plan.scope.batchIds.length} batches)`,
    '',
    '| | |',
    '| --- | ---: |',
    row('live scoped students', s.liveScopedStudents),
    row('incoming rows', s.incomingRows),
    row('exact student-number matches', s.exactMatches),
    row('NO_CHANGE', c.NO_CHANGE),
    row('SAFE_UPDATE', c.SAFE_UPDATE),
    row('NEW_STUDENT', c.NEW_STUDENT),
    row('MISSING_FROM_CURRENT_LIST', c.MISSING_FROM_CURRENT_LIST),
    row('CONFLICT_REVIEW', c.CONFLICT_REVIEW),
    row('MISSING_STUDENT_NUMBER (incoming + live)', c.MISSING_STUDENT_NUMBER),
    row('DUPLICATE_STUDENT_NUMBER', c.DUPLICATE_STUDENT_NUMBER),
    row('INVALID_CONTACT', c.INVALID_CONTACT),
    row('OUT_OF_SCOPE (ignored)', c.OUT_OF_SCOPE),
    row('SAFE_CONTACT_UPDATE: email (NULL → value)', s.safeContactUpdates.email),
    row('SAFE_CONTACT_UPDATE: phone (NULL → value)', s.safeContactUpdates.phone),
    row('IDENTITY_REVIEW_REQUIRED items', s.reviewItems),
    row('… of which proposed Student Number changes', s.proposedNumberChanges),
    row('finance rows that would change', 0),
    ...extras.map((line) => `| ${line} |`),
    '',
    '## Field status',
    '',
    `| Field | ${FIELD_STATUSES.join(' | ')} |`,
    `| --- |${FIELD_STATUSES.map(() => ' ---: |').join('')}`,
    ...SYNC_FIELDS.map((field) => `| ${field} | ${FIELD_STATUSES.map((status) => s.fieldStatus[field][status]).join(' | ')} |`),
  ].join('\n')
}
