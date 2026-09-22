/**
 * FINANCE-GRID-03B / 03C — drives the local `/finance` page in a real Chrome.
 *
 *   npm run finance:ui-acceptance            (dev server on http://localhost:3000)
 *   FINANCE_QA_BASE_URL=http://localhost:3001 npm run finance:ui-acceptance
 *
 * Launches the installed Chrome headless, attaches over the DevTools
 * protocol with nothing but Node's built-in WebSocket, signs it in as the
 * admin with the same one-time-token session the reconciliation uses (so
 * every render goes through RLS as a staff member's would), and walks the
 * ticket's UI workflow: default intake, program and intake selectors, the
 * Session filter, Payment Status pills, search, clear, scrolling, sticky
 * header and frozen columns, selection, disabled actions, the details drawer,
 * URL refresh, back/forward, old `?batch=` links, ECEA, Unassigned.
 *
 * Every step records what it observed. Screenshots and the row-level log go
 * to `.private/finance-qa/` because they show real student rows; the console
 * summary is counts and booleans only.
 *
 * The page is read-only and so is this: it clicks, types, scrolls and reads.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { Cdp, launchChrome, Page, sleep } from './headless-chrome.mts'
import { openHostedSession, sessionCookies } from './hosted-session.mts'

const BASE_URL = process.env.FINANCE_QA_BASE_URL ?? 'http://localhost:3000'
const PRIVATE_DIR = path.join('.private', 'finance-qa')
const SHOTS = path.join(PRIVATE_DIR, 'screenshots')

// -----------------------------------------------------------------------------
// Page probes — everything the checks read from the DOM
// -----------------------------------------------------------------------------

/** The grid as rendered, read from the DOM. */
const GRID_PROBE = `(() => {
  const table = document.querySelector('table')
  if (!table) return null
  const headerRows = [...table.querySelectorAll('thead tr')]
  const banners = [...headerRows[0].querySelectorAll('th')].map((th) => ({ text: th.textContent.trim(), span: th.colSpan }))
  const headings = [...headerRows[1].querySelectorAll('th')].map((th) => ({
    text: th.textContent.trim(),
    align: getComputedStyle(th).textAlign,
    nowrap: getComputedStyle(th).whiteSpace,
  }))
  const leafIds = [...headerRows[1].querySelectorAll('th')].map((th) => th.textContent.trim())
  const financeStart = leafIds.indexOf('Reminder') + 1
  const rows = [...table.querySelectorAll('tbody tr')].map((tr) => {
    const cells = [...tr.querySelectorAll('td')]
    return {
      number: cells[1]?.textContent.trim() ?? '',
      name: cells[2]?.querySelector('button')?.textContent.trim() ?? '',
      legacy: Boolean(cells[2]?.textContent.includes('Legacy')),
      session: tr.dataset.session ?? null,
      status: tr.dataset.status ?? null,
      batchId: tr.dataset.batchId ?? null,
      statusText: tr.querySelector('[data-status]')?.textContent.trim() ?? '',
      balance: cells.find((td, index) => leafIds[index] === 'Balance')?.textContent.trim() ?? '',
      receipt: tr.querySelector('[data-receipt]')?.textContent.trim() ?? '',
      reminder: cells.find((td, index) => leafIds[index] === 'Reminder')?.textContent.trim() ?? '',
      // The Excel-like detail: every cell after the Reminder column, minus Actions.
      cells: cells.slice(financeStart, -1).map((td) => ({
        text: td.textContent.trim(),
        align: getComputedStyle(td.firstElementChild ?? td).textAlign,
        color: getComputedStyle(td.firstElementChild ?? td).color,
      })),
      height: tr.getBoundingClientRect().height,
    }
  })
  const container = table.parentElement
  return {
    banners,
    headings,
    financeHeadings: headings.slice(financeStart, -1).map((heading) => heading.text),
    rows,
    rowCount: rows.length,
    scrollWidth: container.scrollWidth,
    clientWidth: container.clientWidth,
    fontSize: getComputedStyle(table).fontSize,
  }
})()`

const STATE_PROBE = `(() => ({
  url: location.pathname + location.search,
  program: document.querySelector('#finance-program')?.selectedOptions[0]?.text ?? null,
  intake: document.querySelector('#finance-intake')?.selectedOptions[0]?.text ?? null,
  intakeOptions: [...(document.querySelector('#finance-intake')?.options ?? [])].map((option) => option.text),
  sessionControl: Boolean(document.querySelector('#finance-session')),
  sessions: [...document.querySelectorAll('#finance-session button')].map((button) => ({ text: button.textContent.trim(), pressed: button.getAttribute('aria-pressed') })),
  search: document.querySelector('#finance-search')?.value ?? null,
  note: [...document.querySelectorAll('h1 ~ p')].map((p) => p.textContent.trim()).join(' | '),
  shown: [...document.querySelectorAll('span[aria-live]')].map((span) => span.textContent.trim()).join(' '),
  summary: [...document.querySelectorAll('section[aria-label="Intake summary"] p')].map((p) => p.textContent.trim()),
  filters: [...document.querySelectorAll('[data-status-filter]')].map((button) => ({ text: button.textContent.trim(), status: button.dataset.statusFilter, disabled: button.disabled, pressed: button.getAttribute('aria-pressed'), title: button.title })),
  receiptFilters: [...document.querySelectorAll('[data-receipt-filter]')].map((button) => ({ text: button.textContent.trim(), receipt: button.dataset.receiptFilter, pressed: button.getAttribute('aria-pressed') })),
  sourceHeadings: [...document.querySelectorAll('thead th [data-source-session]')].map((span) => ({ text: span.textContent.trim(), session: span.dataset.sourceSession, title: span.title })),
  emptyState: document.querySelector('.border-dashed p')?.textContent.trim() ?? null,
  selectionBar: document.querySelector('[role=status]')?.textContent.trim() ?? null,
  selectionButtons: [...(document.querySelector('[role=status]')?.querySelectorAll('button') ?? [])].map((button) => ({ text: button.textContent.trim(), disabled: button.disabled, title: button.title })),
  drawerOpen: Boolean(document.querySelector('[role=dialog]')),
}))()`

const DRAWER_PROBE = `(() => {
  const dialog = document.querySelector('[role=dialog]')
  if (!dialog) return null
  const figures = [...dialog.querySelectorAll('dl dt')].map((dt) => ({ label: dt.textContent.trim(), value: dt.nextElementSibling?.textContent.trim() ?? '' }))
  const transactions = [...dialog.querySelectorAll('table tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()))
  const sections = [...dialog.querySelectorAll('h3')].map((h3) => h3.textContent.trim())
  return {
    title: dialog.querySelector('h2')?.textContent.trim() ?? '',
    subtitle: dialog.querySelector('h2 + p')?.textContent.trim() ?? '',
    placement: [...dialog.querySelectorAll('section:first-of-type dl > *')].map((node) => node.textContent.trim()).join(' | '),
    figures,
    sections,
    transactions,
    transactionSummary: [...dialog.querySelectorAll('p')].map((p) => p.textContent.trim()).find((text) => /imported payment/.test(text)) ?? null,
    receipt: dialog.querySelector('section:has(h3) span[title]')?.textContent.trim() ?? null,
    rect: (() => { const r = dialog.getBoundingClientRect(); return { left: r.left, width: r.width } })(),
    focusInside: dialog.contains(document.activeElement),
    editable: dialog.querySelectorAll('input, textarea, select, [contenteditable=true]').length,
  }
})()`

const STICKY_PROBE = `(() => {
  const table = document.querySelector('table')
  const container = table.parentElement
  container.scrollLeft = 700
  // Positions are measured from the container's padding edge: a sticky
  // left of 0 sits inside the container's own 1px border.
  const base = container.getBoundingClientRect().left + container.clientLeft
  const headerCells = [...table.querySelectorAll('thead tr:nth-child(2) th')]
  const frozenCount = headerCells.filter((th) => getComputedStyle(th).position === 'sticky').length
  const frozen = headerCells.slice(0, frozenCount).map((th) => th.getBoundingClientRect())
  const banner = table.querySelector('thead tr:first-child th').getBoundingClientRect()
  window.scrollTo(0, 400)
  const theadTop = table.querySelector('thead').getBoundingClientRect().top
  const containerTopAfter = container.getBoundingClientRect().top
  window.scrollTo(0, 0)
  const tableRect = table.getBoundingClientRect()
  const result = {
    scrollLeft: container.scrollLeft,
    frozenCount,
    frozenHeadings: headerCells.slice(0, frozenCount).map((th) => th.textContent.trim()),
    frozenLefts: frozen.map((r) => Math.round(r.left - base)),
    frozenRights: frozen.map((r) => Math.round(r.right - base)),
    bannerLeft: Math.round(banner.left - base),
    identityStaysAtZero: Math.round(frozen[0].left - base) === 0,
    bannerFrozen: Math.round(banner.left - base) === 0,
    theadStickyWhilePageScrolled: theadTop >= containerTopAfter - 1 && theadTop <= containerTopAfter + 1,
    // The frozen region, for a pixel comparison before and after scrolling.
    // Inset by 4px: the container's rounded top-left corner anti-aliases
    // differently over sticky and static paint, and it is not a seam.
    frozenClip: { x: base + 4, y: tableRect.top + 4, width: Math.round(frozen[frozen.length - 1].right - base) - 4, height: Math.min(Math.round(tableRect.height), 600) - 4 },
  }
  container.scrollLeft = 0
  return result
})()`

// -----------------------------------------------------------------------------
// The workflow
// -----------------------------------------------------------------------------

interface Check {
  step: string
  ok: boolean
  detail: string
}

interface Observation {
  step: string
  state?: unknown
  grid?: unknown
  drawer?: unknown
  sticky?: unknown
  screenshot?: string
  note?: string
}

/** Intake selector labels (the prefix before " — "), as the ticket names them. */
const REPRESENTATIVE_INTAKES = [
  '29 Jul 2026',
  '1 Jun 2026',
  '27 Apr 2026',
  'March 2026',
  'January 2026',
  'December 2025',
  '6 Oct 2025',
  '18 Aug 2025',
  '2 Jul 2025',
  '12 May 2025',
  '17 Mar 2025',
]

/** Waits for the intake selector to show the named intake and the grid to settle. */
function intakeReady(label: string): string {
  return `document.querySelector('#finance-intake')?.selectedOptions[0]?.text.startsWith(${JSON.stringify(label)}) && document.querySelector('table') && !document.querySelector('span[aria-live]')?.textContent.includes('Loading')`
}

async function main(): Promise<number> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  mkdirSync(path.join(repoRoot, SHOTS), { recursive: true })
  // A throwaway Chrome profile in the OS temp directory: it holds Chrome's
  // own files, not ours, and must not sit inside the repository.
  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'finance-qa-chrome-'))

  const checks: Check[] = []
  const observations: Observation[] = []
  const check = (step: string, ok: boolean, detail: string): void => {
    checks.push({ step, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`)
  }
  const observe = (observation: Observation): void => {
    observations.push(observation)
  }

  const session = await openHostedSession(repoRoot)
  const chrome = await launchChrome(profileDir)
  const cdp = await Cdp.connect(chrome.wsUrl)

  try {
    const page = await Page.open(cdp, { baseUrl: BASE_URL, shotsDir: SHOTS })

    // --- 0. Unauthenticated redirect -----------------------------------------
    await page.navigate(`${BASE_URL}/finance`)
    await page.waitFor(`location.pathname === '/login'`, 30_000, 'redirect to /login')
    const loginUrl = await page.evaluate<string>('location.pathname + location.search')
    check('unauthenticated /finance redirects to /login', loginUrl === '/login?redirectTo=%2Ffinance', loginUrl)
    observe({ step: 'unauthenticated', screenshot: await page.screenshot('00-unauthenticated') })

    // --- 1. Sign in with the admin session (RLS, no service role) ------------
    await page.setCookies(sessionCookies(session.projectRef, session.session))
    await page.navigate(`${BASE_URL}/finance`)
    await page.waitFor(`document.querySelector('#finance-intake') && document.querySelector('table')`, 60_000, 'grid')
    let state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    let grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    type GridRow = { number: string; name: string; legacy: boolean; session: string | null; status: string | null; batchId: string | null; statusText: string; balance: string; receipt: string; reminder: string; height: number; cells: { text: string; align: string; color: string }[] }
    type Grid = { banners: { text: string; span: number }[]; headings: { text: string; align: string; nowrap: string }[]; financeHeadings: string[]; rows: GridRow[]; rowCount: number; scrollWidth: number; clientWidth: number }
    // A filter that leaves no rows renders the empty state instead of a table.
    const EMPTY_GRID: Grid = { banners: [], headings: [], financeHeadings: [], rows: [], rowCount: 0, scrollWidth: 0, clientWidth: 0 }
    const g = () => (grid ?? EMPTY_GRID) as unknown as Grid
    check('authenticated admin sees the grid', grid !== null && g().rowCount > 0, `${g().rowCount} rows`)
    const leaked = await page.evaluate<string[]>(`['legacy_raw_json', 'raw_value', 'source_key', 'formatted_text', 'service_role'].filter((needle) => document.documentElement.outerHTML.includes(needle))`)
    check('no raw legacy JSON or key material in the served page', leaked.length === 0, leaked.join(', '))
    check(
      'default intake is the newest dated PSW intake, Morning + Evening combined',
      String(state.intake).startsWith('29 Jul 2026') && String(state.intake).includes('Morning + Evening') && String(state.program).startsWith('PSW'),
      `${state.program} / ${state.intake}`,
    )
    check('default intake note explains the rule and the combination', String(state.note).includes('most recent intake with a recorded start date') && String(state.note).includes('Morning and Evening'), String(state.note))
    const intakeOptions = state.intakeOptions as string[]
    check('intake selector lists 11 PSW intakes plus Unassigned (was 22 batches + Unassigned)', intakeOptions.length === 12 && intakeOptions[intakeOptions.length - 1].startsWith('Unassigned'), `${intakeOptions.length} options: ${intakeOptions.map((option) => option.split(' — ')[0]).join(', ')}`)
    check('intakes are listed most recent first, undated ones by their stated month', intakeOptions.slice(0, 11).map((option) => option.split(' — ')[0]).join('|') === REPRESENTATIVE_INTAKES.join('|'), intakeOptions.slice(0, 11).map((option) => option.split(' — ')[0]).join(' | '))
    check('three undated intakes say so and are given no day', intakeOptions.filter((option) => option.includes('no start date recorded')).length === 3 && ['March 2026', 'January 2026', 'December 2025'].every((label) => intakeOptions.some((option) => option.startsWith(`${label} — `) && option.includes('no start date recorded'))), '')
    check('every PSW intake reads Morning + Evening', intakeOptions.slice(0, 11).every((option) => option.includes('Morning + Evening')), '')
    observe({ step: 'default', state, grid, screenshot: await page.screenshot('01-default') })

    // --- 2. The combined 29 Jul 2026 intake ------------------------------------
    const julyRows = g().rows
    const julyMorning = julyRows.filter((row) => row.session === 'Morning')
    const julyEvening = julyRows.filter((row) => row.session === 'Evening')
    check('29 Jul 2026 combined: 17 rows = Morning 6 + Evening 11', julyRows.length === 17 && julyMorning.length === 6 && julyEvening.length === 11, `${julyRows.length} = ${julyMorning.length} + ${julyEvening.length}`)
    check('no duplicate rows from grouping', new Set(julyRows.map((row) => `${row.batchId}|${row.number}|${row.name}`)).size === julyRows.length, '')
    check('rows carry two distinct underlying batch ids', new Set(julyRows.map((row) => row.batchId)).size === 2, [...new Set(julyRows.map((row) => row.batchId))].join(', '))
    check('Morning rows precede Evening rows', julyRows.findIndex((row) => row.session === 'Evening') === julyMorning.length, '')
    check('Session column visible per row', julyRows.every((row) => row.session === 'Morning' || row.session === 'Evening'), '')
    const sessionButtons = state.sessions as { text: string; pressed: string }[]
    check('session control offered with counts', state.sessionControl === true && sessionButtons.some((button) => button.text.replace(/\s+/g, ' ') === 'Morning 6') && sessionButtons.some((button) => button.text.replace(/\s+/g, ' ') === 'Evening 11'), JSON.stringify(sessionButtons))
    const summary = state.summary as string[]
    check('summary strip reads Morning 6 · Evening 11', summary.some((text) => text.includes('Morning 6') && text.includes('Evening 11')), summary.join(' | '))
    check('summary strip states both cohorts’ conventions', summary.some((text) => text.includes('Morning: verified across') && text.includes('Evening: verified across')), '')
    const statusFilters = state.filters as { text: string; status: string; pressed: string; disabled: boolean }[]
    check('Payment Status filters: All, Outstanding, Settled, Credit, Unknown — none disabled', statusFilters.map((filter) => filter.status).join(',') === 'all,outstanding,settled,credit,unknown' && statusFilters.every((filter) => !filter.disabled), statusFilters.map((filter) => filter.text.replace(/\s+/g, ' ')).join(' | '))
    const countOf = (status: string) => Number(/(\d+)$/.exec(statusFilters.find((filter) => filter.status === status)!.text.trim())?.[1] ?? NaN)
    const badgeCounts = { outstanding: julyRows.filter((row) => row.status === 'outstanding').length, settled: julyRows.filter((row) => row.status === 'settled').length, credit: julyRows.filter((row) => row.status === 'credit').length, unknown: julyRows.filter((row) => row.status === 'unknown').length }
    check('status pill counts equal the row badges (same derivation)', countOf('outstanding') === badgeCounts.outstanding && countOf('settled') === badgeCounts.settled && countOf('credit') === badgeCounts.credit && countOf('unknown') === badgeCounts.unknown && countOf('all') === julyRows.length, JSON.stringify(badgeCounts))
    check('every row shows a status word, not a colour alone', julyRows.every((row) => /(Outstanding|Settled|Credit|Unknown)$/.test(row.statusText)), julyRows.map((row) => row.statusText).slice(0, 3).join(', '))
    check('negative balance rows read Outstanding; zero rows Settled; positive Credit; blank Unknown', julyRows.every((row) => (row.balance.startsWith('-$') ? row.status === 'outstanding' : row.balance === '$0.00' ? row.status === 'settled' : row.balance === '—' ? row.status === 'unknown' : row.status === 'credit')), julyRows.map((row) => `${row.balance}:${row.status}`).join(' '))
    check('balance keeps its recorded sign; no sign is flipped for display', julyRows.filter((row) => row.status === 'outstanding').every((row) => row.balance.startsWith('-$')), '')
    check('receipt cells are compact words with a legacy marker', julyRows.every((row) => /^(Sent|Mixed|Not sent|Unknown)\s*legacy$/i.test(row.receipt)), julyRows[0]?.receipt)
    check('reminder cells read Never sent, never "needed"', julyRows.every((row) => row.reminder === 'Never sent'), julyRows[0]?.reminder)
    check('grouped headers: Student, Status, Receipt · Reminder, Actual, Installment, Actions', g().banners.map((banner) => banner.text.toLowerCase()).join('|') === ['student', 'status', 'receipt · reminder', 'actual fee structure (as recorded)', 'installment fee structure (scheduled)', 'actions'].join('|'), g().banners.map((banner) => `${banner.text} (${banner.span})`).join(' | '))
    check('leaf headings in the operational order', g().headings.slice(1, 8).map((heading) => heading.text).join('|') === 'Student #|Student name|Session|Payment status|Balance|Receipt|Reminder', g().headings.slice(0, 8).map((heading) => heading.text).join(' | '))
    observe({ step: 'july-combined', state, grid })

    // Session filter, in place (no navigation).
    await page.click('#finance-session button', 1)
    await sleep(500)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('Session = Morning shows only the 6 Morning rows', g().rowCount === 6 && g().rows.every((row) => row.session === 'Morning'), `${g().rowCount} rows`)
    check('session filter does not navigate; it mirrors into the URL', String(state.url).includes('session=morning') && String(state.url).includes('intake=2026-07-29'), String(state.url))
    observe({ step: 'session-morning', state, grid, screenshot: await page.screenshot('03-session-morning') })
    await page.click('#finance-session button', 2)
    await sleep(500)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('Session = Evening shows only the 11 Evening rows', g().rowCount === 11 && g().rows.every((row) => row.session === 'Evening'), `${g().rowCount} rows`)
    await page.click('#finance-session button', 0)
    await sleep(500)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('Session = All restores both cohorts and drops the param', g().rowCount === 17 && !String(state.url).includes('session='), `${g().rowCount} rows; ${String(state.url)}`)

    // Status filter.
    await page.click('[data-status-filter="outstanding"]', 0)
    await sleep(500)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('Outstanding filter shows exactly the Outstanding-badged rows', g().rowCount === badgeCounts.outstanding && g().rows.every((row) => row.status === 'outstanding'), `${g().rowCount} rows`)
    check('status filter mirrored into the URL beside the program and intake', String(state.url).includes('status=outstanding') && String(state.url).includes('program=PSW') && String(state.url).includes('intake=2026-07-29'), String(state.url))
    observe({ step: 'status-outstanding', state, grid, screenshot: await page.screenshot('04-status-outstanding') })
    await page.click('[data-status-filter="settled"]', 0)
    await sleep(500)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('Settled filter shows exactly the Settled-badged rows', g().rowCount === badgeCounts.settled && g().rows.every((row) => row.status === 'settled'), `${g().rowCount} rows`)
    // Session + status together.
    await page.click('#finance-session button', 2)
    await sleep(500)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('Session and status compose', g().rows.every((row) => row.session === 'Evening' && row.status === 'settled') && g().rowCount === julyEvening.filter((row) => row.status === 'settled').length, `${g().rowCount} rows`)
    await page.click('#finance-session button', 0)
    await page.click('[data-status-filter="all"]', 0)
    await sleep(500)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('All / All restores every row', g().rowCount === 17, `${g().rowCount} rows`)

    // --- 3. Visual density, formatting, frozen columns ---------------------------
    const rows = g().rows
    const headings = g().headings
    check('compact rows (32px or under)', rows.every((row) => row.height <= 32), `${Math.round(rows[0].height)}px`)
    check('money headings and cells right-aligned', g().financeHeadings.length > 0 && headings.slice(8, -1).every((heading) => heading.align === 'right') && rows.every((row) => row.cells.every((cell) => cell.align === 'right')), '')
    check('headings do not wrap', headings.every((heading) => heading.nowrap === 'nowrap'), '')
    const blankColor = rows.flatMap((row) => row.cells).find((cell) => cell.text === '—')?.color
    const amountColor = rows.flatMap((row) => row.cells).find((cell) => /^\$[1-9]/.test(cell.text))?.color
    check('blank (em dash) styled differently from a figure', blankColor !== undefined && amountColor !== undefined && blankColor !== amountColor, `blank ${blankColor}, figure ${amountColor}`)
    check('horizontal scrollbar available on the grid', g().scrollWidth > g().clientWidth, `${g().scrollWidth} > ${g().clientWidth}`)

    const sticky = await page.evaluate<Record<string, unknown>>(STICKY_PROBE)
    check('six operational columns frozen at 1600px: select, #, name, Session, Payment status, Balance', sticky.frozenCount === 6 && (sticky.frozenHeadings as string[]).slice(1).join('|') === 'Student #|Student name|Session|Payment status|Balance', JSON.stringify(sticky.frozenHeadings))
    check('frozen columns stay put on horizontal scroll', sticky.identityStaysAtZero === true, JSON.stringify(sticky.frozenLefts))
    check('Student banner stays frozen too', sticky.bannerFrozen === true, String(sticky.bannerLeft))
    check('header row sticks while the page scrolls', sticky.theadStickyWhilePageScrolled === true, '')
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
    const clip = { ...(sticky.frozenClip as { x: number; y: number; width: number; height: number }), scale: 1 }
    const frozenBefore = (await page.send('Page.captureScreenshot', { format: 'png', clip })) as { data: string }
    await page.evaluate(`document.querySelector('table').parentElement.scrollLeft = 700`)
    await sleep(200)
    const frozenAfter = (await page.send('Page.captureScreenshot', { format: 'png', clip })) as { data: string }
    check('no scrolled content bleeds through the frozen columns', frozenBefore.data === frozenAfter.data, `frozen region ${clip.width}x${clip.height}px pixel-identical before and after scrolling: ${frozenBefore.data === frozenAfter.data}`)
    writeFileSync(path.join(repoRoot, SHOTS, '02a-frozen-unscrolled.png'), Buffer.from(frozenBefore.data, 'base64'))
    writeFileSync(path.join(repoRoot, SHOTS, '02b-frozen-scrolled.png'), Buffer.from(frozenAfter.data, 'base64'))
    observe({ step: 'sticky', sticky, screenshot: await page.screenshot('02-scrolled-right') })
    await page.evaluate(`document.querySelector('table').parentElement.scrollLeft = 0`)

    // Laptop width: the STATUS trio releases below 1280px so the detail stays usable.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false })
    await sleep(300)
    const stickyLaptop = await page.evaluate<Record<string, unknown>>(STICKY_PROBE)
    const gridLaptop = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('1366px laptop: six columns frozen and the detail still has room to scroll', stickyLaptop.frozenCount === 6 && (gridLaptop as { clientWidth: number }).clientWidth - (stickyLaptop.frozenClip as { width: number }).width >= 600, `frozen ${(stickyLaptop.frozenClip as { width: number }).width}px of ${(gridLaptop as { clientWidth: number }).clientWidth}px`)
    observe({ step: 'laptop-1366', sticky: stickyLaptop, screenshot: await page.screenshot('02c-laptop-1366') })
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 768, deviceScaleFactor: 1, mobile: false })
    await sleep(300)
    const stickyNarrow = await page.evaluate<Record<string, unknown>>(STICKY_PROBE)
    const stillTable = await page.evaluate<boolean>(`Boolean(document.querySelector('table'))`)
    check('below 1280px only the Student trio stays frozen; the table is kept, never cards', stickyNarrow.frozenCount === 3 && stillTable, `frozen ${stickyNarrow.frozenCount}`)
    observe({ step: 'narrow-1180', sticky: stickyNarrow, screenshot: await page.screenshot('02d-narrow-1180') })
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    await sleep(300)

    // Row hover.
    const before = await page.evaluate<string>(`getComputedStyle(document.querySelector('tbody tr')).backgroundColor`)
    await page.hover('tbody tr td', 8)
    await sleep(200)
    const after = await page.evaluate<string>(`getComputedStyle(document.querySelector('tbody tr')).backgroundColor`)
    check('row hover changes the row background', before !== after, `${before} → ${after}`)

    // --- 4. Representative intakes ---------------------------------------------
    const expectedCounts: Record<string, [number, number]> = {
      '29 Jul 2026': [6, 11], '1 Jun 2026': [14, 14], '27 Apr 2026': [15, 26], 'March 2026': [15, 10],
      'January 2026': [20, 19], 'December 2025': [17, 14], '6 Oct 2025': [18, 12], '18 Aug 2025': [14, 24],
      '2 Jul 2025': [15, 12], '12 May 2025': [11, 14], '17 Mar 2025': [13, 11],
    }
    for (const [index, label] of REPRESENTATIVE_INTAKES.entries()) {
      await page.selectOption('#finance-intake', label)
      await page.waitFor(intakeReady(label), 30_000, label)
      await sleep(300)
      grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
      state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
      const morning = g().rows.filter((row) => row.session === 'Morning').length
      const evening = g().rows.filter((row) => row.session === 'Evening').length
      const [expectedMorning, expectedEvening] = expectedCounts[label]
      const banners = g().banners.map((banner) => `${banner.text} (${banner.span})`).join(' | ')
      check(`intake renders: ${label} = Morning ${expectedMorning} + Evening ${expectedEvening}`, g().rowCount === expectedMorning + expectedEvening && morning === expectedMorning && evening === expectedEvening && new Set(g().rows.map((row) => row.batchId)).size === 2, `${g().rowCount} rows (${morning} + ${evening}); ${banners}`)
      observe({ step: `intake:${label}`, state, grid, screenshot: await page.screenshot(`10-intake-${String(index).padStart(2, '0')}`) })
    }

    // Specific edge cases on the intakes that carry them.
    await page.selectOption('#finance-intake', '6 Oct 2025')
    await page.waitFor(intakeReady('6 Oct 2025'), 30_000, 'Oct')
    await sleep(300)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    const octHeadings = g().financeHeadings
    const marIndex = octHeadings.findIndex((heading) => /^Mar( |$)/.test(heading))
    const marcIndex = octHeadings.findIndex((heading) => /^Marc( |$)/.test(heading))
    check('same letter headed "Mar" (Morning) and "Marc" (Evening) shown as two verbatim columns, side by side', marIndex >= 0 && marcIndex === marIndex + 1, octHeadings.join(', '))
    check('a Morning-only column is blank for every Evening row, and vice versa (blank, not $0.00)', g().rows.filter((row) => row.session === 'Evening').every((row) => row.cells[marIndex].text === '—') && g().rows.filter((row) => row.session === 'Morning').every((row) => row.cells[marcIndex].text === '—'), '')
    check('unheaded column labelled by letter', octHeadings.some((heading) => /^Column [A-Z]+/.test(heading)), octHeadings.filter((heading) => heading.startsWith('Column ')).join(', '))
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const sourceHeadings = state.sourceHeadings as { text: string; session: string; title: string }[]
    const marHeading = sourceHeadings.find((heading) => heading.text.startsWith('Mar '))
    const marcHeading = sourceHeadings.find((heading) => heading.text.startsWith('Marc '))
    check('conflicting headings carry the cohort as a secondary label: "Mar Morning" and "Marc Evening"', octHeadings[marIndex] === 'Mar Morning' && octHeadings[marcIndex] === 'Marc Evening' && marHeading?.session === 'Morning' && marcHeading?.session === 'Evening', `${octHeadings[marIndex]} / ${octHeadings[marcIndex]}`)
    check('their tooltips name the other heading at the same position, unrenamed', Boolean(marHeading?.title.includes('Evening table heads the same column position “Marc”')) && Boolean(marcHeading?.title.includes('Morning table heads the same column position “Mar”')), marHeading?.title ?? 'missing')
    check('shared columns carry no cohort label', !sourceHeadings.some((heading) => /^(Total Fee|Enroll\. Fee|October|November|December|January|February|Total Paid) /.test(heading.text)) && octHeadings.includes('Total Fee') && octHeadings.includes('February'), sourceHeadings.map((heading) => heading.text).join(', '))
    observe({ step: 'oct-edge-cases', grid, screenshot: await page.screenshot('11-oct-mar-marc') })

    await page.selectOption('#finance-intake', '27 Apr 2026')
    await page.waitFor(intakeReady('27 Apr 2026'), 30_000, 'April')
    await sleep(300)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const aprilHeadings = g().financeHeadings
    const aprilRows = g().rows
    const octoberIndex = aprilHeadings.findIndex((heading) => heading === 'October')
    const lateFeesIndex = aprilHeadings.findIndex((heading) => heading === 'Late Fees')
    check('all-blank restored October column present (shared by both tables) and blank for all 41 rows', octoberIndex >= 0 && aprilRows.length === 41 && aprilRows.every((row) => row.cells[octoberIndex].text === '—'), aprilHeadings.join(', '))
    check('Late Fees is one shared column: blank for every Morning row (restored), filled by some Evening rows', lateFeesIndex >= 0 && aprilRows.filter((row) => row.session === 'Morning').every((row) => row.cells[lateFeesIndex].text === '—') && aprilRows.some((row) => row.session === 'Evening' && row.cells[lateFeesIndex].text !== '—'), aprilHeadings[lateFeesIndex] ?? 'missing')
    check('27 Apr 2026 shares every column: no cohort label anywhere', (state.sourceHeadings as unknown[]).length === 0, '')
    check('summary strip states the blank structural column once, over the combined rows', (state.summary as string[]).some((text) => /1 column from the workbook layout holds no figure/.test(text)), (state.summary as string[]).filter((text) => /workbook layout/.test(text)).join(' | '))
    check('negative values visible and coloured', aprilRows.some((row) => row.cells.some((cell) => cell.text.startsWith('-$'))) && aprilRows.flatMap((row) => row.cells).filter((cell) => cell.text.startsWith('-$')).every((cell) => cell.color !== amountColor), '')
    observe({ step: 'april-edge-cases', state, grid })

    await page.selectOption('#finance-intake', 'January 2026')
    await page.waitFor(intakeReady('January 2026'), 30_000, 'Jan')
    await sleep(300)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const janRows = g().rows
    const janHeadings = g().financeHeadings
    check('undated intake: 39 rows = Morning 20 + Evening 19, labelled by month only', janRows.length === 39 && String(state.intake).startsWith('January 2026') && String(state.intake).includes('no start date recorded'), String(state.intake))
    check('recorded $0.00 shown as $0.00, beside blanks', janRows.some((row) => row.cells.some((cell) => cell.text === '$0.00')) && janRows.some((row) => row.cells.some((cell) => cell.text === '—')), '')
    check('Payer (text) column hidden from the money grid', !janHeadings.includes('Payer'), '')
    const janZero = janRows.flatMap((row) => row.cells).find((cell) => cell.text === '$0.00')
    const janBlank = janRows.flatMap((row) => row.cells).find((cell) => cell.text === '—')
    check('$0.00 and blank visibly distinct', janZero !== undefined && janBlank !== undefined && janZero.color !== janBlank.color, `zero ${janZero?.color}, blank ${janBlank?.color}`)
    observe({ step: 'january-undated', state, grid, screenshot: await page.screenshot('12-january-undated') })

    // --- 5. Search across both cohorts ----------------------------------------
    const eveningTarget = janRows.find((row) => row.session === 'Evening' && /^\d/.test(row.number))!
    await page.type('#finance-search', eveningTarget.number)
    await page.waitFor(`document.querySelectorAll('tbody tr').length === 1`, 10_000, 'search by number narrows to one row')
    await sleep(500)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('search by student number finds an Evening student under Session = All', g().rowCount === 1 && g().rows[0].number === eveningTarget.number && g().rows[0].session === 'Evening', String(state.shown))
    check('search term mirrored into the URL', String(state.url).includes(`q=${encodeURIComponent(eveningTarget.number)}`), String(state.url))
    check('neighbouring student numbers are not fuzzy-matched', g().rowCount === 1, '')
    await page.click('#finance-session button', 1)
    await sleep(500)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('Session = Morning is not ignored by search: the Evening match disappears', String(state.emptyState).includes('No matching students'), String(state.shown))
    await page.click('#finance-session button', 0)
    await sleep(400)
    observe({ step: 'search-number', state, screenshot: await page.screenshot('20-search-number') })

    await page.clearInput('#finance-search')
    await page.waitFor(`document.querySelectorAll('tbody tr').length === ${janRows.length}`, 10_000, 'clear restores rows')
    await sleep(500)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('clearing the search restores every row and drops q from the URL', !String(state.url).includes('q='), String(state.url))

    const namePart = eveningTarget.name.split(' ')[0].slice(0, 4).toLowerCase()
    await page.type('#finance-search', namePart)
    await sleep(600)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    const nameRows = g().rows
    check('search by (partial, case-insensitive) name narrows correctly across cohorts', nameRows.length >= 1 && nameRows.every((row) => row.name.toLowerCase().includes(namePart)), `${nameRows.length} rows`)
    await page.clearInput('#finance-search')
    await sleep(400)

    // --- 5b. The secondary legacy Receipt filter ------------------------------
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const receiptFilters = state.receiptFilters as { text: string; receipt: string; pressed: string }[]
    const receiptCountOf = (receipt: string) => Number(/(\d+)$/.exec(receiptFilters.find((filter) => filter.receipt === receipt)!.text.trim())?.[1] ?? NaN)
    const receiptCells = { sent: janRows.filter((row) => /^Sent/.test(row.receipt)).length, mixed: janRows.filter((row) => /^Mixed/.test(row.receipt)).length, not_sent: janRows.filter((row) => /^Not sent/.test(row.receipt)).length, unknown: janRows.filter((row) => /^Unknown/.test(row.receipt)).length }
    check('Receipt filter offered: All, Sent, Mixed, Not sent, Unknown, with counts equal to the Receipt cells', receiptFilters.map((filter) => filter.receipt).join(',') === 'all,sent,mixed,not_sent,unknown' && receiptCountOf('sent') === receiptCells.sent && receiptCountOf('unknown') === receiptCells.unknown && receiptCountOf('all') === janRows.length, JSON.stringify(receiptCells))
    check('Receipt filter is labelled legacy and never disabled', await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="finance-receipt-label"]').textContent.includes('legacy') && [...document.querySelectorAll('[data-receipt-filter]')].every((button) => !button.disabled)`), '')
    await page.click('[data-receipt-filter="unknown"]', 0)
    await sleep(500)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('Receipt = Unknown shows exactly the rows whose Receipt cell reads Unknown', g().rowCount === receiptCells.unknown && g().rows.every((row) => /^Unknown/.test(row.receipt)), `${g().rowCount} rows`)
    check('receipt filter mirrored into the URL', String(state.url).includes('receipt=unknown'), String(state.url))
    check('payment status is untouched by the receipt filter: rows still carry their own status', g().rows.some((row) => row.status !== 'unknown') || g().rowCount === 0, g().rows.map((row) => row.status).join(','))
    await page.click('[data-status-filter="outstanding"]', 0)
    await sleep(500)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('receipt and payment status compose', g().rows.every((row) => /^Unknown/.test(row.receipt) && row.status === 'outstanding') && g().rowCount === janRows.filter((row) => /^Unknown/.test(row.receipt) && row.status === 'outstanding').length, `${g().rowCount} rows`)
    await page.click('[data-status-filter="all"]', 0)
    await page.click('[data-receipt-filter="sent"]', 0)
    await sleep(400)
    await page.type('#finance-search', eveningTarget.number)
    await sleep(600)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    const targetIsSent = /^Sent/.test(eveningTarget.receipt)
    check('receipt and search compose', targetIsSent ? g().rowCount === 1 && g().rows[0].number === eveningTarget.number : g().rowCount === 0, `target receipt ${eveningTarget.receipt}; ${g().rowCount} rows`)
    await page.clearInput('#finance-search')
    await sleep(400)
    await page.click('#finance-session button', 2)
    await sleep(400)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('receipt and session compose', g().rows.every((row) => row.session === 'Evening' && /^Sent/.test(row.receipt)) && g().rowCount === janRows.filter((row) => row.session === 'Evening' && /^Sent/.test(row.receipt)).length, `${g().rowCount} rows`)
    await page.click('#finance-session button', 0)
    await page.click('[data-receipt-filter="all"]', 0)
    await sleep(500)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('Receipt = All restores every row and drops the param', g().rowCount === janRows.length && !String(state.url).includes('receipt='), String(state.url))
    observe({ step: 'receipt-filter', state, screenshot: await page.screenshot('22-receipt-filter') })

    await page.type('#finance-search', 'zzzz-no-such-student')
    await page.waitFor(`document.body.textContent.includes('No matching students')`, 10_000, 'empty state')
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('empty search result shows the empty state, not a blank grid', String(state.emptyState).includes('No matching students'), String(state.shown))
    observe({ step: 'search-empty', screenshot: await page.screenshot('21-search-empty') })
    await page.clearInput('#finance-search')
    await page.waitFor(`document.querySelector('table')`, 10_000, 'grid back')

    // --- 6. Selection across the combined intake -------------------------------
    await page.click('tbody tr input[type=checkbox]', 0)
    await page.waitFor(`document.querySelector('[role=status]')`, 5_000, 'selection bar')
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const indeterminate = await page.evaluate<boolean>(`document.querySelector('thead input[type=checkbox]').indeterminate`)
    check('selecting one row shows the selection bar', String(state.selectionBar).startsWith('1 selected'), String(state.selectionBar))
    check('select-all checkbox is indeterminate with a partial selection', indeterminate, '')
    check('Receipt and Reminder actions are disabled with an explanation', (state.selectionButtons as { text: string; disabled: boolean; title: string }[]).filter((button) => button.text === 'Receipt' || button.text === 'Reminder').every((button) => button.disabled && button.title.includes('later workflow')), JSON.stringify(state.selectionButtons))
    await page.click('tbody tr input[type=checkbox]', janRows.length - 1) // an Evening row
    await sleep(200)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('a Morning and an Evening row can be selected together', String(state.selectionBar).startsWith('2 selected'), String(state.selectionBar))
    await page.click('thead input[type=checkbox]', 0)
    await sleep(200)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('select-all selects every visible row of both cohorts', String(state.selectionBar).startsWith(`${janRows.length} selected`), String(state.selectionBar))
    await page.click('[role=status] button', 2)
    await sleep(200)
    await page.click('#finance-session button', 2) // Evening only
    await sleep(400)
    await page.click('thead input[type=checkbox]', 0)
    await sleep(200)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('select-all under Session = Evening selects only the 19 visible Evening rows', String(state.selectionBar).startsWith('19 selected'), String(state.selectionBar))
    observe({ step: 'select-all-evening', screenshot: await page.screenshot('30-select-all-evening') })
    await page.click('[role=status] button', 2)
    await sleep(200)
    await page.click('#finance-session button', 0)
    await sleep(400)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('Clear empties the selection', state.selectionBar === null, '')
    const rowActionButtons = await page.evaluate<{ text: string; disabled: boolean; title: string }[]>(`[...document.querySelectorAll('tbody tr:first-child td:last-child button')].map((button) => ({ text: button.textContent.trim(), disabled: button.disabled, title: button.title }))`)
    check('row actions read Details · Receipt · Reminder, the last two disabled with "later workflow"', rowActionButtons.map((button) => button.text).join('|') === 'Details|Receipt|Reminder' && rowActionButtons.slice(1).every((button) => button.disabled && button.title.includes('later workflow')), JSON.stringify(rowActionButtons))

    // --- 7. Details drawer -----------------------------------------------------
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    const eveningIndex = g().rows.findIndex((row) => row.session === 'Evening')
    const eveningRow = g().rows[eveningIndex]
    await page.click('tbody tr td:nth-child(3) button', eveningIndex)
    await page.waitFor(`document.querySelector('[role=dialog]')`, 5_000, 'drawer')
    await sleep(200)
    let drawer = await page.evaluate<Record<string, unknown>>(DRAWER_PROBE)
    check('drawer opens from the student name and takes focus', drawer !== null && drawer.focusInside === true, String(drawer?.title))
    check('drawer names the student, program and the real underlying batch', String(drawer?.title).includes(eveningRow.name) && String(drawer?.subtitle).includes('PSW') && /Evening/.test(String(drawer?.subtitle)), String(drawer?.subtitle))
    check('drawer states intake, batch, session and payment status', ['Where this record sits', 'Historical snapshot', 'Imported transactions', 'Receipts', 'Reminders'].every((section) => (drawer?.sections as string[]).includes(section)) && String(drawer?.placement).includes('January 2026') && String(drawer?.placement).includes('Evening'), String(drawer?.placement))
    check('drawer has no editable field', drawer?.editable === 0, '')
    check('drawer leaves the filter bar visible beside it', (drawer?.rect as { left: number }).left > 900, `drawer starts at x=${(drawer?.rect as { left: number }).left}`)
    observe({ step: 'drawer', drawer, screenshot: await page.screenshot('40-drawer') })
    await page.pressKey('Escape', 'Escape', 27)
    await sleep(200)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('Escape closes the drawer', state.drawerOpen === false, '')
    await page.click('tbody tr:first-child td:last-child button', 0)
    await page.waitFor(`document.querySelector('[role=dialog]')`, 5_000, 'drawer via Details')
    await page.click('[role=dialog] header button', 0)
    await sleep(200)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('Details opens the drawer and Close closes it', state.drawerOpen === false, '')

    const drawerSamples: unknown[] = []
    for (const label of ['17 Mar 2025', '2 Jul 2025', 'January 2026', '29 Jul 2026']) {
      await page.selectOption('#finance-intake', label)
      await page.waitFor(intakeReady(label), 30_000, label)
      await sleep(300)
      const sampleIndex = await page.evaluate<number>(`[...document.querySelectorAll('tbody tr')].findIndex((tr) => /[0-9]+ of [0-9]+ imported payment/.test(tr.querySelector('[data-receipt]')?.title ?? ''))`)
      if (sampleIndex < 0) {
        check(`drawer transactions for a ${label} row`, true, 'no row in this intake has an imported payment tied to it (routing outcome); nothing to open')
        continue
      }
      await page.click('tbody tr td:nth-child(3) button', sampleIndex)
      await page.waitFor(`document.querySelector('[role=dialog]')`, 5_000, 'drawer')
      await sleep(200)
      drawer = await page.evaluate<Record<string, unknown>>(DRAWER_PROBE)
      const tooltip = await page.evaluate<string>(`document.querySelectorAll('tbody tr')[${sampleIndex}].querySelector('[data-receipt]').title`)
      const claimed = /(\d+) of (\d+) imported payment/.exec(tooltip)
      const transactions = drawer?.transactions as string[][]
      const ok = claimed !== null && transactions.length === Number(claimed[2]) && transactions.every((cells) => cells.length === 4 && /^\d{4}-\d{2}-\d{2}$|No readable date/.test(cells[0]) && /^-?\$[\d,]+\.\d{2}$/.test(cells[1]))
      check(`drawer transactions render for a ${label} row`, ok, `${transactions.length} rows; tooltip says ${claimed?.[2] ?? '?'}`)
      drawerSamples.push({ label, drawer })
      await page.pressKey('Escape', 'Escape', 27)
      await sleep(200)
    }
    observe({ step: 'drawer-samples', drawer: drawerSamples })

    // --- 8. URL refresh, history and old links --------------------------------
    await page.selectOption('#finance-intake', '2 Jul 2025')
    await page.waitFor(intakeReady('2 Jul 2025'), 30_000, 'july 2025')
    const julyUrl = await page.evaluate<string>('location.href')
    check('intake navigation writes ?intake=<key>, never a batch uuid', julyUrl.includes('intake=2025-07-02') && !/batch=/.test(julyUrl), julyUrl.replace(BASE_URL, ''))
    await page.type('#finance-search', '125')
    await page.click('[data-status-filter="unknown"]', 0)
    await page.click('[data-receipt-filter="sent"]', 0)
    await page.click('#finance-session button', 2)
    await sleep(700)
    const withParams = await page.evaluate<string>('location.href')
    check('search, status, receipt and session are mirrored into the URL', withParams.includes('q=125') && withParams.includes('status=unknown') && withParams.includes('receipt=sent') && withParams.includes('session=evening'), withParams.replace(BASE_URL, ''))
    await page.navigate(withParams)
    await page.waitFor(`document.querySelector('#finance-intake') && (document.querySelector('table') || document.querySelector('.border-dashed'))`, 60_000, 'reload')
    await sleep(300)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('refresh with URL params restores intake, session, status, receipt and search', String(state.intake).startsWith('2 Jul 2025') && state.search === '125' && (state.filters as { status: string; pressed: string }[]).some((filter) => filter.status === 'unknown' && filter.pressed === 'true') && (state.receiptFilters as { receipt: string; pressed: string }[]).some((filter) => filter.receipt === 'sent' && filter.pressed === 'true') && (state.sessions as { text: string; pressed: string }[]).some((button) => button.text.startsWith('Evening') && button.pressed === 'true'), `${state.intake} / q=${state.search}`)
    observe({ step: 'refresh-with-params', state, screenshot: await page.screenshot('50-refresh-params') })

    await page.evaluate('history.back()')
    await sleep(1500)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const backUrl = await page.evaluate<string>('location.href')
    check('browser back returns to the previous intake and the grid follows', backUrl !== withParams && !String(state.intake).startsWith('2 Jul 2025'), `${backUrl.replace(BASE_URL, '')} → ${state.intake}`)
    await page.evaluate('history.forward()')
    await sleep(1500)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const forwardUrl = await page.evaluate<string>('location.href')
    check('browser forward returns to the later state', forwardUrl !== backUrl && String(state.intake).startsWith('2 Jul 2025'), `${forwardUrl.replace(BASE_URL, '')} → ${state.intake}`)

    // A GRID-03 link to one batch: lands on its intake, narrowed to its session.
    const eveningBatchId = julyRows.find((row) => row.session === 'Evening')!.batchId
    await page.navigate(`${BASE_URL}/finance?program=PSW&batch=${eveningBatchId}&filter=balance_due`)
    await page.waitFor(`location.search.includes('intake=') && document.querySelector('#finance-intake') && (document.querySelector('table') || document.querySelector('.border-dashed'))`, 60_000, 'legacy batch link')
    await sleep(500)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('old ?batch=<uuid> link redirects to its intake with session=evening and the mapped status', String(state.url).includes('intake=2026-07-29') && String(state.url).includes('session=evening') && String(state.url).includes('status=outstanding') && !String(state.url).includes('batch='), String(state.url))
    check('…and shows only that batch’s rows', g().rows.every((row) => row.session === 'Evening' && row.batchId === eveningBatchId && row.status === 'outstanding'), `${g().rowCount} rows`)
    observe({ step: 'legacy-batch-link', state, grid })

    // --- 9. ECEA ---------------------------------------------------------------
    await page.navigate(`${BASE_URL}/finance?program=ECEA`)
    await page.waitFor(`document.querySelector('#finance-intake') && document.querySelector('table')`, 60_000, 'ECEA')
    await sleep(300)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const eceaBanners = g().banners.map((banner) => banner.text)
    const eceaHeadings = g().financeHeadings
    const eceaRows = g().rows
    const balanceIndex = eceaHeadings.indexOf('Balance')
    check('ECEA is its own intake with no session control and no Session column', String(state.intake).startsWith('ELCE 25 & 26') && state.sessionControl === false && !g().headings.some((heading) => heading.text === 'Session'), String(state.intake))
    check('ECEA renders 50 students with no installment group', g().rowCount === 50 && !eceaBanners.some((banner) => banner.toLowerCase().includes('installment')), eceaBanners.join(' | '))
    check('ECEA ordinal fee columns sit in the actual group', ['Enrollment fees', '1st Installment', '2nd Installment', 'Late fees'].every((label) => eceaHeadings.some((heading) => heading.toLowerCase() === label.toLowerCase())), eceaHeadings.join(', '))
    check('ECEA Balance header visible and every value blank', balanceIndex >= 0 && eceaRows.every((row) => row.cells[balanceIndex].text === '—'), '')
    check('ECEA operational Balance column blank and Payment Status Unknown for all 50', eceaRows.every((row) => row.balance === '—' && row.status === 'unknown'), '')
    check('ECEA status counts: Unknown 50, nothing Outstanding', (state.filters as { status: string; text: string }[]).find((filter) => filter.status === 'unknown')!.text.trim().endsWith('50') && (state.filters as { status: string; text: string }[]).find((filter) => filter.status === 'outstanding')!.text.trim().endsWith('0'), '')
    await page.click('[data-receipt-filter="sent"]', 0)
    await sleep(500)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('ECEA: Receipt = Sent narrows to the legacy-Sent rows while every Payment Status stays Unknown', g().rowCount > 0 && g().rowCount < 50 && g().rows.every((row) => /^Sent/.test(row.receipt) && row.status === 'unknown'), `${g().rowCount} rows`)
    await page.click('[data-receipt-filter="all"]', 0)
    await sleep(400)
    check('ECEA batch balance total blank with 50 recorded no figure', (state.summary as string[]).some((text) => text.includes('50 students recorded no figure')), '')
    check('ECEA program selector reads ECEA', String(state.program).startsWith('ECEA'), String(state.program))
    observe({ step: 'ecea', state, grid, screenshot: await page.screenshot('60-ecea') })

    // --- 10. Unassigned --------------------------------------------------------
    await page.navigate(`${BASE_URL}/finance?program=PSW&intake=unassigned`)
    await page.waitFor(`document.querySelector('#finance-intake') && document.querySelector('table')`, 60_000, 'unassigned')
    await sleep(300)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const unassignedBanners = g().banners.map((banner) => banner.text)
    const unassignedRows = g().rows
    check('Unassigned view lists 22 records with no ACTUAL or INSTALLMENT columns and an Imported transactions group instead (RECONCILE-04A)', g().rowCount === 22 && unassignedBanners.length === 5 && unassignedBanners[3].startsWith('Imported transactions') && !unassignedBanners.some((banner) => /fee structure/i.test(banner)), unassignedBanners.join(' | '))
    const transactionHeadings = g().financeHeadings
    check('the transactions group heads Payments, Payments total, Last payment, Source batch cell and Why unassigned', transactionHeadings.join('|') === 'Payments|Payments total|Last payment|Source batch cell|Why unassigned', transactionHeadings.join(' | '))
    const paymentCounts = await page.evaluate<{ attr: string; cell: string; total: string; reason: string; balance: string }[]>(`[...document.querySelectorAll('tbody tr')].map((tr) => { const heads = [...tr.closest('table').querySelectorAll('thead tr:nth-child(2) th')].map((th) => th.textContent.trim()); const tds = [...tr.querySelectorAll('td')]; const start = heads.indexOf('Payments'); return { attr: tr.dataset.paymentCount, cell: tds[start]?.textContent.trim(), total: tds[start + 1]?.textContent.trim(), reason: tr.querySelector('[data-unassigned-reason]')?.dataset.unassignedReason ?? '', balance: tds[heads.indexOf('Balance')]?.textContent.trim() } })`)
    check('every row shows its imported payment count, "None" for zero, and the counts sum to the 41 unassigned payments', paymentCounts.every((row) => (row.attr === '0' ? row.cell === 'None' : row.cell === row.attr)) && paymentCounts.reduce((sum, row) => sum + Number(row.attr), 0) === 41, `${paymentCounts.filter((row) => row.attr === '0').length} with none; total ${paymentCounts.reduce((sum, row) => sum + Number(row.attr), 0)}`)
    check('a record with no payment shows a blank payments total, and no row fabricates a balance', paymentCounts.filter((row) => row.attr === '0').every((row) => row.total === '—') && paymentCounts.every((row) => row.balance === '—'), '')
    check('every row carries an unassigned reason badge from the importer outcome', paymentCounts.every((row) => ['ambiguous_batch', 'batch_not_found', 'missing_student_id'].includes(row.reason)) && new Set(paymentCounts.map((row) => row.reason)).size === 3, [...new Set(paymentCounts.map((row) => row.reason))].join(', '))
    check('the summary strip states that no batch snapshot exists and counts the imported payments', (state.summary as string[]).some((text) => text.startsWith('No batch snapshot exists')) && (state.summary as string[])[(state.summary as string[]).indexOf('Imported payments') + 1] === '41', (state.summary as string[]).filter((text) => /Imported payments|No batch snapshot/.test(text)).map((text) => text.slice(0, 60)).join(' | '))
    check('Unassigned view is labelled as such, not as an intake, with no session control', String(state.intake).startsWith('Unassigned — no batch (22)') && String(state.note).includes('could not tie') && state.sessionControl === false, String(state.intake))
    check('Unassigned rows show Payment Status Unknown, never Outstanding from a missing balance', unassignedRows.every((row) => row.status === 'unknown'), '')
    await page.click('[data-receipt-filter="unknown"]', 0)
    await sleep(500)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('Unassigned: Receipt = Unknown shows the 2 records with no stated receipt value', g().rowCount === 2 && g().rows.every((row) => /^Unknown/.test(row.receipt)), `${g().rowCount} rows`)
    await page.click('[data-receipt-filter="all"]', 0)
    await sleep(400)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('unresolved students read "No student number" with the legacy marker', unassignedRows.filter((row) => row.number === 'No student number').length === 3 && unassignedRows.filter((row) => row.number === 'No student number').every((row) => row.legacy), '')
    check('no fabricated identifier for unresolved students', unassignedRows.every((row) => row.number === 'No student number' || /^\d+$/.test(row.number)), '')
    await page.click('tbody tr td:nth-child(3) button', unassignedRows.findIndex((row) => row.number === 'No student number'))
    await page.waitFor(`document.querySelector('[role=dialog]')`, 5_000, 'drawer')
    drawer = await page.evaluate<Record<string, unknown>>(DRAWER_PROBE)
    check('unresolved student drawer says No student number and No batch', String(drawer?.subtitle).includes('No student number') && String(drawer?.subtitle).includes('No batch') && String(drawer?.placement).includes('Unassigned'), String(drawer?.subtitle))
    check('the drawer states why the record is unassigned and that no batch snapshot exists', String(drawer?.placement).includes('Why unassigned') && (drawer?.sections as string[]).includes('Historical snapshot') && await page.evaluate<boolean>(`[...document.querySelectorAll('[role=dialog] p')].some((p) => p.textContent.startsWith('No batch sheet row exists for this record'))`), String(drawer?.placement).slice(0, 120))
    observe({ step: 'unassigned', state, grid, drawer, screenshot: await page.screenshot('70-unassigned-drawer') })
    await page.pressKey('Escape', 'Escape', 27)
    await page.waitFor(`!document.querySelector('[role=dialog]')`, 5_000, 'drawer closed')
    // A record with several payments: the drawer must list exactly that many.
    const richIndex = paymentCounts.findIndex((row) => Number(row.attr) >= 2)
    await page.click('tbody tr td:nth-child(3) button', richIndex)
    await page.waitFor(`document.querySelector('[role=dialog]')`, 5_000, 'drawer')
    drawer = await page.evaluate<Record<string, unknown>>(DRAWER_PROBE)
    check('an unassigned record with several payments lists every one of them in the drawer without any batch manifest', richIndex >= 0 && (drawer?.transactions as string[][]).length === Number(paymentCounts[richIndex].attr) && String(drawer?.transactionSummary).startsWith(`${paymentCounts[richIndex].attr} imported payments`), `${(drawer?.transactions as string[][]).length} rows; ${drawer?.transactionSummary}`)
    await page.pressKey('Escape', 'Escape', 27)
    await page.waitFor(`!document.querySelector('[role=dialog]')`, 5_000, 'drawer closed')
    // The old spelling of the same link still works.
    await page.navigate(`${BASE_URL}/finance?program=PSW&batch=unassigned`)
    await page.waitFor(`document.querySelector('#finance-intake') && document.querySelector('table')`, 60_000, 'unassigned legacy')
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('old ?batch=unassigned link still opens the Unassigned view', String(state.intake).startsWith('Unassigned — no batch (22)'), String(state.intake))

    // --- 11. Stale links fall back -----------------------------------------------
    await page.navigate(`${BASE_URL}/finance?program=PSW&intake=no-such-intake`)
    await page.waitFor(`document.querySelector('#finance-intake') && document.querySelector('table')`, 60_000, 'stale intake')
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('a stale intake link falls back to the default with an explanation', String(state.note).includes('not available') && String(state.intake).startsWith('29 Jul 2026'), String(state.note))
    await page.navigate(`${BASE_URL}/finance?program=PSW&batch=00000000-0000-0000-0000-000000000000`)
    await page.waitFor(`document.querySelector('#finance-intake') && document.querySelector('table')`, 60_000, 'stale batch')
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('a stale batch link falls back to the default with an explanation', String(state.note).includes('not available') && String(state.intake).startsWith('29 Jul 2026'), String(state.note))

    // --- 11b. The GRID-03 receipt-gap link keeps its meaning ----------------------
    // 2 Jul 2025 holds the workbook's two Mixed records, one per cohort.
    await page.navigate(`${BASE_URL}/finance?program=PSW&intake=2025-07-02`)
    await page.waitFor(intakeReady('2 Jul 2025'), 60_000, 'july 2025')
    await sleep(300)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    const julyAll = g().rows
    const gapExpected = julyAll.filter((row) => /^(Not sent|Mixed)/.test(row.receipt)).length
    await page.navigate(`${BASE_URL}/finance?program=PSW&intake=2025-07-02&filter=legacy_receipt_gap`)
    await page.waitFor(intakeReady('2 Jul 2025'), 60_000, 'legacy receipt gap')
    await sleep(700)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('old ?filter=legacy_receipt_gap shows only Not sent or Mixed rows, never Sent or Unknown, and not All', gapExpected > 0 && g().rowCount === gapExpected && g().rowCount < julyAll.length && g().rows.every((row) => /^(Not sent|Mixed)/.test(row.receipt)), `${g().rowCount} of ${julyAll.length} rows; expected ${gapExpected}`)
    const gapPills = state.receiptFilters as { text: string; receipt: string; pressed: string }[]
    check('the compatibility state is visible as an active "Not sent or Mixed" pill beside the five normal pills', gapPills.map((pill) => pill.receipt).join(',') === 'all,sent,mixed,not_sent,unknown,gap' && gapPills.find((pill) => pill.receipt === 'gap')?.pressed === 'true', gapPills.map((pill) => pill.text.replace(/\s+/g, ' ')).join(' | '))
    check('the resolved state is mirrored into the URL as receipt=gap', String(state.url).includes('receipt=gap') && !String(state.url).includes('filter='), String(state.url))
    await page.navigate(await page.evaluate<string>('location.href'))
    await page.waitFor(intakeReady('2 Jul 2025'), 60_000, 'refresh gap')
    await sleep(300)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('refresh preserves the Not sent or Mixed narrowing', g().rowCount === gapExpected && g().rows.every((row) => /^(Not sent|Mixed)/.test(row.receipt)), `${g().rowCount} rows`)
    await page.click('[data-receipt-filter="sent"]', 0)
    await sleep(500)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('choosing a normal pill drops the compatibility pill', (state.receiptFilters as { receipt: string }[]).map((pill) => pill.receipt).join(',') === 'all,sent,mixed,not_sent,unknown' && String(state.url).includes('receipt=sent'), String(state.url))
    observe({ step: 'legacy-receipt-gap', state, grid, screenshot: await page.screenshot('80-legacy-receipt-gap') })

    // --- 12. Console -----------------------------------------------------------------
    const applicationErrors = page.consoleErrors.filter((entry) => !/extension|chrome-extension/i.test(entry))
    check('no application console errors across the session', applicationErrors.length === 0, applicationErrors.slice(0, 3).join(' // '))
    observe({ step: 'console', note: `${page.consoleErrors.length} errors, ${page.consoleWarnings.length} warnings` })
  } finally {
    cdp.close()
    chrome.process.kill()
    await session.signOut()
    await sleep(500)
    rmSync(profileDir, { recursive: true, force: true })
  }

  const logPath = path.join(repoRoot, PRIVATE_DIR, 'browser-acceptance.json')
  writeFileSync(logPath, `${JSON.stringify({ baseUrl: BASE_URL, ranAt: new Date().toISOString(), checks, observations }, null, 2)}\n`, 'utf8')

  const failed = checks.filter((entry) => !entry.ok)
  console.log('')
  console.log(`${checks.length - failed.length} / ${checks.length} checks passed`)
  console.log(`wrote ${path.join(PRIVATE_DIR, 'browser-acceptance.json').split(path.sep).join('/')} and screenshots under ${SHOTS.split(path.sep).join('/')} (Git-ignored)`)
  return failed.length === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exit(1)
  },
)
