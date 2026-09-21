/**
 * Reading a batch's column manifest — FINANCE-COLUMN-MANIFEST-03A.
 *
 * `batch_finance_columns` says which finance columns a batch *has*: their
 * order, their headings, which section they sit in, whether a cell in them is
 * money or text, and whether the grid shows them. It says nothing about any
 * student's values — those stay on the finance record and the normalized
 * installments — so a column the manifest lists and no student filled in is
 * rendered blank, exactly as the workbook showed it, and never as `$0.00`.
 *
 * This module turns the selected rows into resolved columns. It is pure and
 * carries no `server-only` import, so the same rules run in the view-model
 * builder and in a test. It never rewrites a heading: `source_header` is the
 * label, verbatim and trimmed, and the semantic role is a separate field that
 * the label does not depend on. "Marc" is displayed as "Marc".
 *
 * Values the database could hold that this code does not recognise — a new
 * section, role or value kind added by a later migration — are handled in the
 * safe direction: an unknown section is not rendered, an unknown role is
 * `other`, and an unknown value kind is read as text rather than currency.
 */

import type { FinanceColumn, FinanceColumnRole, FinanceColumnSection, FinanceColumnValueKind } from './types.ts'

/** A `batch_finance_columns` row, as the loader selects it. */
export interface RawManifestColumn {
  column_key: string
  section: string
  source_column_letter: string | null
  source_header: string | null
  normalized_role: string | null
  value_kind: string
  display_order: number
  is_grid_visible: boolean
  display_even_if_blank: boolean
}

export const FINANCE_COLUMN_ROLES: readonly FinanceColumnRole[] = [
  'student_number',
  'student_name',
  'enrollment',
  'month',
  'late_fees',
  'total_fee',
  'total_paid',
  'balance',
  'discount',
  'installment',
  'remarks',
  'payer',
  'other',
]

const ROLE_SET: ReadonlySet<string> = new Set(FINANCE_COLUMN_ROLES)

/**
 * A column resolved for the server-side builder.
 *
 * Carries what the browser-bound `FinanceColumn` deliberately does not: the
 * spreadsheet letter the cell map is keyed on, and the two visibility flags.
 * `toFinanceColumn` strips those before anything reaches a Client Component.
 */
export interface ResolvedColumn extends FinanceColumn {
  /** Source column letter, for reading the preserved cell. Null when the column has no spreadsheet behind it. */
  letter: string | null
  visible: boolean
  displayEvenIfBlank: boolean
}

export interface ResolvedManifest {
  actual: ResolvedColumn[]
  installment: ResolvedColumn[]
}

function roleOf(value: string | null): FinanceColumnRole {
  return value !== null && ROLE_SET.has(value) ? (value as FinanceColumnRole) : 'other'
}

/** Unknown kinds read as text: a value that might not be money is not shown as money. */
function valueKindOf(value: string): FinanceColumnValueKind {
  return value === 'money' ? 'money' : 'text'
}

function sectionOf(value: string): FinanceColumnSection | null {
  return value === 'actual' || value === 'installment' ? value : null
}

/**
 * The label of a manifest column.
 *
 * The heading as stored, trimmed for display. An unheaded historical column is
 * named by its cell reference — `Column Q` — because the workbook never named
 * it and this screen may not. An unheaded application-defined column, which
 * has no letter, falls back to its key rather than to an invented heading.
 */
export function manifestColumnLabel(row: RawManifestColumn): { label: string; unheaded: boolean } {
  const header = row.source_header?.trim() ?? ''
  if (header !== '') return { label: header, unheaded: false }
  if (row.source_column_letter) return { label: `Column ${row.source_column_letter}`, unheaded: true }
  return { label: row.column_key, unheaded: true }
}

/**
 * Resolves manifest rows into columns, one list per section.
 *
 * Hidden columns are *kept* here, with `visible: false`, because the builder
 * needs to know a letter is accounted for — a REMARKS column the manifest
 * hides must not reappear as a derived column the moment someone types a
 * remark into it. The builder drops hidden columns before the view model is
 * returned.
 *
 * Order within a section is `display_order`, then key, so two rows that ever
 * shared an order still render in a stable sequence.
 */
export function resolveManifestColumns(rows: readonly RawManifestColumn[]): ResolvedManifest {
  const actual: ResolvedColumn[] = []
  const installment: ResolvedColumn[] = []

  for (const row of rows) {
    const section = sectionOf(row.section)
    if (section === null) continue

    const { label, unheaded } = manifestColumnLabel(row)
    const column: ResolvedColumn = {
      key: row.column_key,
      label,
      section,
      role: roleOf(row.normalized_role),
      valueKind: valueKindOf(row.value_kind),
      order: row.display_order,
      unheaded,
      origin: 'manifest',
      letter: row.source_column_letter,
      visible: row.is_grid_visible,
      displayEvenIfBlank: row.display_even_if_blank,
    }

    if (section === 'actual') actual.push(column)
    else installment.push(column)
  }

  const byOrder = (a: ResolvedColumn, b: ResolvedColumn) =>
    a.order - b.order || a.key.localeCompare(b.key)

  return { actual: actual.sort(byOrder), installment: installment.sort(byOrder) }
}

/** The browser-safe shape: key, label, section, role, kind, order. Nothing else. */
export function toFinanceColumn(column: ResolvedColumn): FinanceColumn {
  return {
    key: column.key,
    label: column.label,
    section: column.section,
    role: column.role,
    valueKind: column.valueKind,
    order: column.order,
    unheaded: column.unheaded,
    origin: column.origin,
  }
}
