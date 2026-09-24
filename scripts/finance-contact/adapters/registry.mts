/**
 * The adapter registry — the one list a new program is added to.
 *
 * Identification is structural. Every workbook found under `reference/` is
 * offered to every adapter; the adapter that recognizes the workbook's sheet
 * titles owns it. A workbook no adapter recognizes (the finance workbook, a
 * receipt template) is reported as such and left alone. Two adapters claiming
 * one workbook is an error, not a coin toss.
 */

import type { WorkBook } from 'xlsx'

import type { AdapterRecognition, MasterContactSourceAdapter } from './adapter.mts'
import { eceaAdapter } from './ecea.mts'
import { pswAdapter } from './psw.mts'

export const ADAPTERS: readonly MasterContactSourceAdapter[] = [pswAdapter, eceaAdapter]

export interface WorkbookIdentification {
  adapter: MasterContactSourceAdapter | null
  /** Every adapter's verdict, for the report. */
  verdicts: { adapterId: string; recognition: AdapterRecognition }[]
  /** Set when more than one adapter claimed the workbook. */
  conflict: string[] | null
}

export function identifyWorkbook(
  workbook: WorkBook,
  adapters: readonly MasterContactSourceAdapter[] = ADAPTERS,
): WorkbookIdentification {
  const verdicts = adapters.map((adapter) => ({ adapterId: adapter.id, recognition: adapter.recognize(workbook) }))
  const claimants = adapters.filter((_, index) => verdicts[index].recognition.recognized)
  if (claimants.length > 1) {
    return { adapter: null, verdicts, conflict: claimants.map((adapter) => adapter.id) }
  }
  return { adapter: claimants[0] ?? null, verdicts, conflict: null }
}
