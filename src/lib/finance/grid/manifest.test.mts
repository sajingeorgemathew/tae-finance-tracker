import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  manifestColumnLabel,
  resolveManifestColumns,
  toFinanceColumn,
  type RawManifestColumn,
} from './manifest.ts'

function row(partial: Partial<RawManifestColumn>): RawManifestColumn {
  return {
    column_key: 'actual:G',
    section: 'actual',
    source_column_letter: 'G',
    source_header: 'Total Fee ',
    normalized_role: 'total_fee',
    value_kind: 'money',
    display_order: 1,
    is_grid_visible: true,
    display_even_if_blank: true,
    ...partial,
  }
}

describe('labels come from the source heading, verbatim', () => {
  it('trims for display and never rewrites', () => {
    assert.deepEqual(manifestColumnLabel(row({ source_header: 'Total Fee ' })), {
      label: 'Total Fee',
      unheaded: false,
    })
    assert.deepEqual(manifestColumnLabel(row({ source_header: 'Marc', normalized_role: 'other' })), {
      label: 'Marc',
      unheaded: false,
    })
  })

  it('names an unheaded historical column by its letter', () => {
    assert.deepEqual(manifestColumnLabel(row({ source_header: null, source_column_letter: 'Q' })), {
      label: 'Column Q',
      unheaded: true,
    })
    assert.deepEqual(manifestColumnLabel(row({ source_header: '   ', source_column_letter: 'Q' })), {
      label: 'Column Q',
      unheaded: true,
    })
  })

  it('falls back to the key for an unheaded column with no letter', () => {
    assert.deepEqual(
      manifestColumnLabel(row({ source_header: null, source_column_letter: null, column_key: 'fee:x' })),
      { label: 'fee:x', unheaded: true },
    )
  })
})

describe('resolving manifest rows', () => {
  it('splits by section and orders by display_order, not by key or arrival', () => {
    const resolved = resolveManifestColumns([
      row({ column_key: 'installment:V', section: 'installment', source_column_letter: 'V', display_order: 2 }),
      row({ column_key: 'actual:Q', source_column_letter: 'Q', source_header: null, display_order: 11 }),
      row({ column_key: 'actual:G', display_order: 1 }),
      row({ column_key: 'installment:U', section: 'installment', source_column_letter: 'U', display_order: 1 }),
      row({ column_key: 'actual:I', source_column_letter: 'I', source_header: 'March', normalized_role: 'month', display_order: 3 }),
    ])

    assert.deepEqual(
      resolved.actual.map((column) => column.key),
      ['actual:G', 'actual:I', 'actual:Q'],
    )
    assert.deepEqual(
      resolved.installment.map((column) => column.key),
      ['installment:U', 'installment:V'],
    )
  })

  it('keeps hidden columns, flagged, so the builder knows their letters are accounted for', () => {
    const resolved = resolveManifestColumns([
      row({ column_key: 'actual:R', source_column_letter: 'R', source_header: 'REMARKS', normalized_role: 'remarks', value_kind: 'text', is_grid_visible: false, display_order: 12 }),
    ])
    assert.equal(resolved.actual.length, 1)
    assert.equal(resolved.actual[0].visible, false)
    assert.equal(resolved.actual[0].valueKind, 'text')
    assert.equal(resolved.actual[0].role, 'remarks')
  })

  it('handles values a later migration might add in the safe direction', () => {
    const resolved = resolveManifestColumns([
      row({ column_key: 'x', section: 'summary' }),
      row({ column_key: 'actual:Z', source_column_letter: 'Z', normalized_role: 'something_new', value_kind: 'percentage', display_order: 5 }),
    ])
    // An unknown section is not rendered anywhere.
    assert.equal(resolved.actual.length + resolved.installment.length, 1)
    // An unknown role is other; an unknown kind is read as text, never currency.
    assert.equal(resolved.actual[0].role, 'other')
    assert.equal(resolved.actual[0].valueKind, 'text')
  })

  it('the browser-bound shape carries no letter, flags or provenance', () => {
    const [column] = resolveManifestColumns([row({})]).actual
    const publicColumn = toFinanceColumn(column)
    assert.deepEqual(Object.keys(publicColumn).sort(), [
      'conflictingHeadings',
      'key',
      'label',
      'order',
      'origin',
      'role',
      'section',
      'sessions',
      'unheaded',
      'valueKind',
    ])
    assert.equal(publicColumn.origin, 'manifest')
  })
})
