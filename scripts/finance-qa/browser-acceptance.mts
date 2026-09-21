/**
 * FINANCE-GRID-03B — drives the local `/finance` page in a real Chrome.
 *
 *   npm run finance:ui-acceptance            (dev server on http://localhost:3000)
 *   FINANCE_QA_BASE_URL=http://localhost:3001 npm run finance:ui-acceptance
 *
 * Launches the installed Chrome headless, attaches over the DevTools
 * protocol with nothing but Node's built-in WebSocket, signs it in as the
 * admin with the same one-time-token session the reconciliation uses (so
 * every render goes through RLS as a staff member's would), and walks the
 * ticket's UI workflow: default batch, program and batch selectors, search,
 * clear, scrolling, sticky header and identity columns, selection, disabled
 * actions, the details drawer, URL refresh, back/forward, ECEA, Unassigned.
 *
 * Every step records what it observed. Screenshots and the row-level log go
 * to `.private/finance-qa/` because they show real student rows; the console
 * summary is counts and booleans only.
 *
 * The page is read-only and so is this: it clicks, types, scrolls and reads.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { openHostedSession, sessionCookies } from './hosted-session.mts'

const BASE_URL = process.env.FINANCE_QA_BASE_URL ?? 'http://localhost:3000'
const DEBUG_PORT = 9333
const PRIVATE_DIR = path.join('.private', 'finance-qa')
const SHOTS = path.join(PRIVATE_DIR, 'screenshots')

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((candidate): candidate is string => Boolean(candidate))

// -----------------------------------------------------------------------------
// A very small DevTools Protocol client
// -----------------------------------------------------------------------------

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: Record<string, unknown>
  error?: { message: string }
}

class Cdp {
  private nextId = 1
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  private listeners: ((message: CdpMessage) => void)[] = []

  private socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), { once: true })
    })
    const cdp = new Cdp(socket)
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage
      if (message.id !== undefined) {
        const waiter = cdp.pending.get(message.id)
        if (waiter) {
          cdp.pending.delete(message.id)
          if (message.error) waiter.reject(new Error(message.error.message))
          else waiter.resolve(message.result ?? {})
        }
        return
      }
      for (const listener of cdp.listeners) listener(message)
    })
    return cdp
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }

  on(listener: (message: CdpMessage) => void): void {
    this.listeners.push(listener)
  }

  close(): void {
    this.socket.close()
  }
}

// -----------------------------------------------------------------------------
// A page
// -----------------------------------------------------------------------------

class Page {
  consoleErrors: string[] = []
  consoleWarnings: string[] = []
  private loadWaiters: (() => void)[] = []
  private cdp: Cdp
  private sessionId: string

  constructor(cdp: Cdp, sessionId: string) {
    this.cdp = cdp
    this.sessionId = sessionId
    cdp.on((message) => {
      if (message.sessionId !== sessionId) return
      if (message.method === 'Page.loadEventFired') {
        for (const waiter of this.loadWaiters.splice(0)) waiter()
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params?.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
        this.consoleErrors.push(details?.exception?.description ?? details?.text ?? 'exception')
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const params = message.params as { type?: string; args?: { value?: unknown; description?: string }[] }
        const text = (params.args ?? []).map((argument) => String(argument.value ?? argument.description ?? '')).join(' ')
        if (params.type === 'error') this.consoleErrors.push(text)
        if (params.type === 'warning') this.consoleWarnings.push(text)
      }
    })
  }

  static async open(cdp: Cdp): Promise<Page> {
    const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string }
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }
    const page = new Page(cdp, sessionId)
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Network.enable')
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    })
    return page
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.cdp.send(method, params, this.sessionId)
  }

  async setCookies(cookies: { name: string; value: string }[]): Promise<void> {
    await this.send('Network.setCookies', {
      cookies: cookies.map((cookie) => ({ ...cookie, url: BASE_URL, path: '/' })),
    })
  }

  /** Evaluates an expression and returns its value. Promises are awaited. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }

  async navigate(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => this.loadWaiters.push(resolve))
    await this.send('Page.navigate', { url })
    await Promise.race([loaded, sleep(60_000)])
  }

  /** Polls until the expression is truthy. */
  async waitFor(expression: string, timeoutMs = 30_000, label = expression): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      try {
        if (await this.evaluate<boolean>(`Boolean(${expression})`)) return
      } catch {
        // Not ready yet — for example, mid-navigation.
      }
      await sleep(150)
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  async screenshot(name: string): Promise<string> {
    const { data } = (await this.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    const target = path.join(SHOTS, `${name}.png`)
    writeFileSync(target, Buffer.from(data, 'base64'))
    return target
  }

  /** Clicks the centre of the first element matching the selector, with a real mouse event. */
  async click(selector: string, index = 0): Promise<void> {
    const rect = await this.evaluate<{ x: number; y: number } | null>(`(() => {
      const element = document.querySelectorAll(${JSON.stringify(selector)})[${index}]
      if (!element) return null
      element.scrollIntoView({ block: 'center', inline: 'nearest' })
      const r = element.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    if (!rect) throw new Error(`no element for ${selector}[${index}]`)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  }

  async hover(selector: string, index = 0): Promise<void> {
    const rect = await this.evaluate<{ x: number; y: number } | null>(`(() => {
      const element = document.querySelectorAll(${JSON.stringify(selector)})[${index}]
      if (!element) return null
      const r = element.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    if (!rect) throw new Error(`no element for ${selector}[${index}]`)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  }

  /** Types into a focused input the way a keyboard would. */
  async type(selector: string, text: string): Promise<void> {
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
    await this.send('Input.insertText', { text })
  }

  async clearInput(selector: string): Promise<void> {
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  }

  async pressKey(key: string, code: string, keyCode: number): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
  }

  /** Changes a React-controlled `<select>` the way a user's choice reaches it. */
  async selectOption(selector: string, optionText: string): Promise<void> {
    const changed = await this.evaluate<boolean>(`(() => {
      const select = document.querySelector(${JSON.stringify(selector)})
      const option = [...select.options].find((candidate) => candidate.text.startsWith(${JSON.stringify(optionText)}))
      if (!option) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(select, option.value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    if (!changed) throw new Error(`no option starting with ${JSON.stringify(optionText)} in ${selector}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// -----------------------------------------------------------------------------
// Chrome
// -----------------------------------------------------------------------------

async function launchChrome(profileDir: string): Promise<{ process: ChildProcess; wsUrl: string }> {
  const executable = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
  if (!executable) throw new Error('Chrome not found; set CHROME_PATH')

  const child = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1600,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
      const body = (await response.json()) as { webSocketDebuggerUrl: string }
      return { process: child, wsUrl: body.webSocketDebuggerUrl }
    } catch {
      await sleep(200)
    }
  }
  child.kill()
  throw new Error('Chrome did not expose a DevTools endpoint')
}

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
  const rows = [...table.querySelectorAll('tbody tr')].map((tr) => {
    const cells = [...tr.querySelectorAll('td')]
    return {
      number: cells[1]?.textContent.trim() ?? '',
      name: cells[2]?.querySelector('button')?.textContent.trim() ?? '',
      legacy: Boolean(cells[2]?.textContent.includes('Legacy')),
      cells: cells.slice(3).map((td) => ({
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
  batch: document.querySelector('#finance-batch')?.selectedOptions[0]?.text ?? null,
  batchOptions: [...(document.querySelector('#finance-batch')?.options ?? [])].map((option) => option.text),
  search: document.querySelector('#finance-search')?.value ?? null,
  note: [...document.querySelectorAll('h1 ~ p')].map((p) => p.textContent.trim()).join(' | '),
  shown: [...document.querySelectorAll('span[aria-live]')].map((span) => span.textContent.trim()).join(' '),
  summary: [...document.querySelectorAll('section[aria-label^="Historical totals"] p')].map((p) => p.textContent.trim()),
  filters: [...document.querySelectorAll('[role=group] button')].map((button) => ({ text: button.textContent.trim(), disabled: button.disabled, pressed: button.getAttribute('aria-pressed'), title: button.title })),
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
  const frozen = headerCells.slice(0, 3).map((th) => th.getBoundingClientRect())
  const banner = table.querySelector('thead tr:first-child th').getBoundingClientRect()
  window.scrollTo(0, 400)
  const theadTop = table.querySelector('thead').getBoundingClientRect().top
  const containerTopAfter = container.getBoundingClientRect().top
  window.scrollTo(0, 0)
  const tableRect = table.getBoundingClientRect()
  const result = {
    scrollLeft: container.scrollLeft,
    frozenLefts: frozen.map((r) => Math.round(r.left - base)),
    frozenRights: frozen.map((r) => Math.round(r.right - base)),
    bannerLeft: Math.round(banner.left - base),
    identityStaysAtZero: Math.round(frozen[0].left - base) === 0,
    bannerFrozen: Math.round(banner.left - base) === 0,
    theadStickyWhilePageScrolled: theadTop >= containerTopAfter - 1 && theadTop <= containerTopAfter + 1,
    // The frozen region, for a pixel comparison before and after scrolling.
    frozenClip: { x: base, y: tableRect.top, width: Math.round(frozen[2].right - base), height: Math.min(Math.round(tableRect.height), 600) },
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

const REPRESENTATIVE_BATCHES = [
  '17th March 2025 - Morning',
  '17th March 2025 - Evening',
  '2nd July 2025 - Morning',
  '06th October 2025 - Evening',
  'January 2026 - Morning',
  '27th April 2026 - Morning',
  '1st June, 2026 - Morning',
  '1st June 2026 - Evening',
  '29th JULY, 2026 - Morning',
  '29th JULY 2026 - Evening',
]

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
    const page = await Page.open(cdp)

    // --- 0. Unauthenticated redirect -----------------------------------------
    await page.navigate(`${BASE_URL}/finance`)
    await page.waitFor(`location.pathname === '/login'`, 30_000, 'redirect to /login')
    const loginUrl = await page.evaluate<string>('location.pathname + location.search')
    check('unauthenticated /finance redirects to /login', loginUrl === '/login?redirectTo=%2Ffinance', loginUrl)
    observe({ step: 'unauthenticated', screenshot: await page.screenshot('00-unauthenticated') })

    // --- 1. Sign in with the admin session (RLS, no service role) ------------
    await page.setCookies(sessionCookies(session.projectRef, session.session))
    await page.navigate(`${BASE_URL}/finance`)
    await page.waitFor(`document.querySelector('#finance-batch') && document.querySelector('table')`, 60_000, 'grid')
    let state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    let grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('authenticated admin sees the grid', grid !== null && (grid as { rowCount: number }).rowCount > 0, `${(grid as { rowCount: number }).rowCount} rows`)
    const leaked = await page.evaluate<string[]>(`['legacy_raw_json', 'raw_value', 'source_key', 'formatted_text', 'service_role'].filter((needle) => document.documentElement.outerHTML.includes(needle))`)
    check('no raw legacy JSON or key material in the served page', leaked.length === 0, leaked.join(', '))
    check(
      'default batch is the newest dated PSW batch, morning first',
      String(state.batch).startsWith('29th JULY, 2026 - Morning') && String(state.program).startsWith('PSW'),
      `${state.program} / ${state.batch}`,
    )
    check('default batch note explains the rule', String(state.note).includes('most recent batch with a recorded start date'), String(state.note))
    check('batch selector lists 22 PSW batches plus Unassigned', (state.batchOptions as string[]).length === 23 && (state.batchOptions as string[]).some((option) => option.startsWith('Unassigned')), `${(state.batchOptions as string[]).length} options`)
    check('six undated batches are marked, none given a date', (state.batchOptions as string[]).filter((option) => option.includes('no start date')).length === 6, '')
    observe({ step: 'default', state, grid, screenshot: await page.screenshot('01-default') })

    // --- 2. Visual density and formatting on the default batch ---------------
    const rows = (grid as { rows: { height: number; cells: { text: string; align: string; color: string }[] }[] }).rows
    const headings = (grid as { headings: { text: string; align: string; nowrap: string }[] }).headings
    check('compact rows (under 32px)', rows.every((row) => row.height <= 32), `${Math.round(rows[0].height)}px`)
    check('money headings and cells right-aligned', headings.slice(3, -3).every((heading) => heading.align === 'right') && rows.every((row) => row.cells.slice(0, -3).every((cell) => cell.align === 'right')), '')
    check('headings do not wrap', headings.every((heading) => heading.nowrap === 'nowrap'), '')
    const blankColor = rows.flatMap((row) => row.cells).find((cell) => cell.text === '—')?.color
    const zeroColor = rows.flatMap((row) => row.cells).find((cell) => cell.text === '$0.00')?.color
    const amountColor = rows.flatMap((row) => row.cells).find((cell) => /^\$[1-9]/.test(cell.text))?.color
    check('blank (em dash) styled differently from a figure', blankColor !== undefined && amountColor !== undefined && blankColor !== amountColor, `blank ${blankColor}, figure ${amountColor}`)
    observe({ step: 'formatting', note: `zero colour ${zeroColor ?? 'no $0.00 on this batch'}` })
    check('horizontal scrollbar available on the grid', (grid as { scrollWidth: number; clientWidth: number }).scrollWidth > (grid as { clientWidth: number }).clientWidth, `${(grid as { scrollWidth: number }).scrollWidth} > ${(grid as { clientWidth: number }).clientWidth}`)

    const sticky = await page.evaluate<Record<string, unknown>>(STICKY_PROBE)
    check('identity columns stay frozen on horizontal scroll', sticky.identityStaysAtZero === true, JSON.stringify(sticky.frozenLefts))
    check('identity banner stays frozen too', sticky.bannerFrozen === true, String(sticky.bannerLeft))
    check('header row sticks while the page scrolls', sticky.theadStickyWhilePageScrolled === true, '')
    // Pixel comparison: the frozen region must look identical whether or not
    // the grid is scrolled sideways. Scrolled content bleeding through a gap
    // between frozen cells changes the pixels; nothing else should.
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

    // Row hover.
    const before = await page.evaluate<string>(`getComputedStyle(document.querySelector('tbody tr')).backgroundColor`)
    await page.hover('tbody tr td', 3)
    await sleep(200)
    const after = await page.evaluate<string>(`getComputedStyle(document.querySelector('tbody tr')).backgroundColor`)
    check('row hover changes the row background', before !== after, `${before} → ${after}`)

    // --- 3. Morning / Evening independently ----------------------------------
    const morningNames = rows.map((row) => (row as unknown as { name: string }).name)
    await page.selectOption('#finance-batch', '29th JULY 2026 - Evening')
    await page.waitFor(`document.querySelector('#finance-batch').selectedOptions[0].text.startsWith('29th JULY 2026 - Evening') && document.querySelector('table')`, 30_000, 'evening batch')
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const eveningNames = (grid as { rows: { name: string }[] }).rows.map((row) => row.name)
    check('Evening batch selectable independently of Morning', (grid as { rowCount: number }).rowCount === 11 && String(state.url).includes('batch='), `${(grid as { rowCount: number }).rowCount} rows; morning had ${morningNames.length}`)
    check('Morning and Evening rosters differ', JSON.stringify(morningNames) !== JSON.stringify(eveningNames), '')
    observe({ step: 'evening', state, grid, screenshot: await page.screenshot('03-evening') })

    // --- 4. Representative batches -------------------------------------------
    for (const [index, batchName] of REPRESENTATIVE_BATCHES.entries()) {
      await page.selectOption('#finance-batch', batchName)
      await page.waitFor(`document.querySelector('#finance-batch').selectedOptions[0].text.startsWith(${JSON.stringify(batchName)}) && document.querySelector('table') && !document.querySelector('span[aria-live]')?.textContent.includes('Loading')`, 30_000, batchName)
      await sleep(300)
      grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
      state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
      const banners = (grid as { banners: { text: string; span: number }[] }).banners.map((banner) => `${banner.text} (${banner.span})`).join(' | ')
      check(`batch renders: ${batchName}`, (grid as { rowCount: number }).rowCount > 0, `${(grid as { rowCount: number }).rowCount} rows; ${banners}`)
      observe({ step: `batch:${batchName}`, state, grid, screenshot: await page.screenshot(`10-batch-${String(index).padStart(2, '0')}`) })
    }

    // Specific edge cases on the batches that carry them.
    await page.selectOption('#finance-batch', '06th October 2025 - Evening')
    await page.waitFor(`document.querySelector('#finance-batch').selectedOptions[0].text.startsWith('06th October 2025 - Evening') && document.querySelector('table')`, 30_000, 'Oct evening')
    await sleep(300)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    const octHeadings = (grid as { headings: { text: string }[] }).headings.map((heading) => heading.text)
    check('source typo "Marc" preserved as a heading', octHeadings.includes('Marc'), octHeadings.join(', '))
    check('unheaded column labelled by letter', octHeadings.some((heading) => /^Column [A-Z]+$/.test(heading)), octHeadings.filter((heading) => heading.startsWith('Column ')).join(', '))

    await page.selectOption('#finance-batch', '27th April 2026 - Morning')
    await page.waitFor(`document.querySelector('#finance-batch').selectedOptions[0].text.startsWith('27th April 2026 - Morning') && document.querySelector('table')`, 30_000, 'April morning')
    await sleep(300)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const aprilHeadings = (grid as { headings: { text: string }[] }).headings.map((heading) => heading.text)
    const aprilRows = (grid as { rows: { cells: { text: string; color: string }[] }[] }).rows
    const octoberIndex = aprilHeadings.indexOf('October') - 3
    const lateFeesIndex = aprilHeadings.indexOf('Late Fees') - 3
    check('all-blank restored October column present and blank for every row', octoberIndex >= 0 && aprilRows.every((row) => row.cells[octoberIndex].text === '—'), '')
    check('all-blank Late Fees column present and blank for every row', lateFeesIndex >= 0 && aprilRows.every((row) => row.cells[lateFeesIndex].text === '—'), '')
    check('summary strip states the blank structural columns once', (state.summary as string[]).some((text) => text.includes('2 columns from this batch')), '')
    check('negative values visible and coloured', aprilRows.some((row) => row.cells.some((cell) => cell.text.startsWith('-$'))) && aprilRows.flatMap((row) => row.cells).filter((cell) => cell.text.startsWith('-$')).every((cell) => cell.color !== amountColor), '')
    observe({ step: 'april-morning-edge-cases', state, grid })

    await page.selectOption('#finance-batch', 'January 2026 - Morning')
    await page.waitFor(`document.querySelector('#finance-batch').selectedOptions[0].text.startsWith('January 2026 - Morning') && document.querySelector('table')`, 30_000, 'Jan morning')
    await sleep(300)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    const janRows = (grid as { rows: { cells: { text: string; color: string }[] }[] }).rows
    const janHeadings = (grid as { headings: { text: string }[] }).headings.map((heading) => heading.text)
    check('recorded $0.00 shown as $0.00, beside blanks', janRows.some((row) => row.cells.some((cell) => cell.text === '$0.00')) && janRows.some((row) => row.cells.some((cell) => cell.text === '—')), '')
    check('Payer (text) column hidden from the money grid', !janHeadings.includes('Payer'), '')
    const janZero = janRows.flatMap((row) => row.cells).find((cell) => cell.text === '$0.00')
    const janBlank = janRows.flatMap((row) => row.cells).find((cell) => cell.text === '—')
    check('$0.00 and blank visibly distinct', janZero !== undefined && janBlank !== undefined && janZero.color !== janBlank.color, `zero ${janZero?.color}, blank ${janBlank?.color}`)

    // --- 5. Search -------------------------------------------------------------
    const numberOfFirst = (grid as { rows: { number: string; name: string }[] }).rows.find((row) => /^\d/.test(row.number))
    await page.type('#finance-search', numberOfFirst!.number)
    await page.waitFor(`document.querySelectorAll('tbody tr').length === 1`, 10_000, 'search by number narrows to one row')
    await sleep(500)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    check('search by student number narrows to that row', (grid as { rowCount: number }).rowCount === 1 && (grid as { rows: { number: string }[] }).rows[0].number === numberOfFirst!.number, String(state.shown))
    check('search term mirrored into the URL', String(state.url).includes(`q=${encodeURIComponent(numberOfFirst!.number)}`), String(state.url))
    check('neighbouring student numbers are not fuzzy-matched', (grid as { rowCount: number }).rowCount === 1, '')
    observe({ step: 'search-number', state, screenshot: await page.screenshot('20-search-number') })

    await page.clearInput('#finance-search')
    await page.waitFor(`document.querySelectorAll('tbody tr').length === ${janRows.length}`, 10_000, 'clear restores rows')
    await sleep(500)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('clearing the search restores every row and drops q from the URL', !String(state.url).includes('q='), String(state.url))

    const namePart = numberOfFirst!.name.split(' ')[0].slice(0, 4).toLowerCase()
    await page.type('#finance-search', namePart)
    await sleep(600)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    const nameRows = (grid as { rows: { name: string }[] }).rows
    check('search by (partial, case-insensitive) name narrows correctly', nameRows.length >= 1 && nameRows.every((row) => row.name.toLowerCase().includes(namePart)), `${nameRows.length} rows`)
    await page.clearInput('#finance-search')
    await sleep(400)

    await page.type('#finance-search', 'zzzz-no-such-student')
    await page.waitFor(`document.body.textContent.includes('No matching students')`, 10_000, 'empty state')
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('empty search result shows the empty state, not a blank grid', String(state.emptyState).includes('No matching students'), String(state.shown))
    observe({ step: 'search-empty', screenshot: await page.screenshot('21-search-empty') })
    await page.clearInput('#finance-search')
    await page.waitFor(`document.querySelector('table')`, 10_000, 'grid back')

    // --- 6. Selection ----------------------------------------------------------
    await page.click('tbody tr input[type=checkbox]', 0)
    await page.waitFor(`document.querySelector('[role=status]')`, 5_000, 'selection bar')
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const indeterminate = await page.evaluate<boolean>(`document.querySelector('thead input[type=checkbox]').indeterminate`)
    check('selecting one row shows the selection bar', String(state.selectionBar).startsWith('1 selected'), String(state.selectionBar))
    check('select-all checkbox is indeterminate with a partial selection', indeterminate, '')
    check('Receipt and Reminder actions are disabled with an explanation', (state.selectionButtons as { text: string; disabled: boolean; title: string }[]).filter((button) => button.text === 'Receipt' || button.text === 'Reminder').every((button) => button.disabled && button.title.length > 0), JSON.stringify(state.selectionButtons))
    await page.click('tbody tr input[type=checkbox]', 1)
    await sleep(200)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('selecting a second row counts two', String(state.selectionBar).startsWith('2 selected'), String(state.selectionBar))
    await page.click('thead input[type=checkbox]', 0)
    await sleep(200)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('select-all selects every visible row', String(state.selectionBar).startsWith(`${janRows.length} selected`), String(state.selectionBar))
    observe({ step: 'select-all', screenshot: await page.screenshot('30-select-all') })
    await page.click('[role=status] button', 2)
    await sleep(200)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('Clear empties the selection', state.selectionBar === null, '')
    const rowActionButtons = await page.evaluate<{ text: string; disabled: boolean; title: string }[]>(`[...document.querySelectorAll('tbody tr:first-child td:last-child button')].map((button) => ({ text: button.textContent.trim(), disabled: button.disabled, title: button.title }))`)
    check('row-level Receipt and Reminder buttons are disabled', rowActionButtons.filter((button) => button.text !== 'View details').every((button) => button.disabled), JSON.stringify(rowActionButtons))

    // --- 7. Details drawer -----------------------------------------------------
    const firstRow = (grid as { rows: { number: string; name: string; cells: { text: string }[] }[] }).rows[0]
    await page.click('tbody tr:first-child td:nth-child(3) button', 0)
    await page.waitFor(`document.querySelector('[role=dialog]')`, 5_000, 'drawer')
    await sleep(200)
    let drawer = await page.evaluate<Record<string, unknown>>(DRAWER_PROBE)
    check('drawer opens from the student name and takes focus', drawer !== null && drawer.focusInside === true, String(drawer?.title))
    check('drawer names the student, program and batch', String(drawer?.title).includes(firstRow.name) && String(drawer?.subtitle).includes('PSW'), String(drawer?.subtitle))
    check('drawer shows snapshot, transactions, receipts and reminders sections', ['Historical snapshot', 'Imported transactions', 'Receipts', 'Reminders'].every((section) => (drawer?.sections as string[]).includes(section)), JSON.stringify(drawer?.sections))
    check('drawer has no editable field', drawer?.editable === 0, '')
    check('drawer leaves the filter bar visible beside it', (drawer?.rect as { left: number }).left > 900, `drawer starts at x=${(drawer?.rect as { left: number }).left}`)
    observe({ step: 'drawer', drawer, screenshot: await page.screenshot('40-drawer') })
    await page.pressKey('Escape', 'Escape', 27)
    await sleep(200)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('Escape closes the drawer', state.drawerOpen === false, '')
    await page.click('tbody tr:first-child td:last-child button', 0)
    await page.waitFor(`document.querySelector('[role=dialog]')`, 5_000, 'drawer via View details')
    await page.click('[role=dialog] header button', 0)
    await sleep(200)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('View details opens the drawer and Close closes it', state.drawerOpen === false, '')

    // Drawer transactions for one row per representative batch, checked
    // against what the grid row itself claims (the count in the Receipt
    // tooltip) and rendered as date / amount / method / receipt text.
    const drawerSamples: unknown[] = []
    for (const batchName of ['17th March 2025 - Morning', '2nd July 2025 - Morning', 'January 2026 - Morning', '29th JULY 2026 - Evening']) {
      await page.selectOption('#finance-batch', batchName)
      await page.waitFor(`document.querySelector('#finance-batch').selectedOptions[0].text.startsWith(${JSON.stringify(batchName)}) && document.querySelector('table')`, 30_000, batchName)
      await sleep(300)
      // A row whose receipt tooltip states a payment count. A batch where no
      // row has an imported payment (a routing outcome) is reported as such.
      const sampleIndex = await page.evaluate<number>(`[...document.querySelectorAll('tbody tr')].findIndex((tr) => /[0-9]+ of [0-9]+ imported payment/.test(tr.querySelector('td:nth-last-child(3) span[title]')?.title ?? ''))`)
      if (sampleIndex < 0) {
        check(`drawer transactions for a ${batchName} row`, true, 'no row in this batch has an imported payment tied to it (routing outcome); nothing to open')
        continue
      }
      await page.click('tbody tr td:nth-child(3) button', sampleIndex)
      await page.waitFor(`document.querySelector('[role=dialog]')`, 5_000, 'drawer')
      await sleep(200)
      drawer = await page.evaluate<Record<string, unknown>>(DRAWER_PROBE)
      const tooltip = await page.evaluate<string>(`document.querySelectorAll('tbody tr')[${sampleIndex}].querySelector('td:nth-last-child(3) span[title]').title`)
      const claimed = /(\d+) of (\d+) imported payment/.exec(tooltip)
      const transactions = drawer?.transactions as string[][]
      const ok = claimed !== null && transactions.length === Number(claimed[2]) && transactions.every((cells) => cells.length === 4 && /^\d{4}-\d{2}-\d{2}$|No readable date/.test(cells[0]) && /^-?\$[\d,]+\.\d{2}$/.test(cells[1]))
      check(`drawer transactions render for a ${batchName} row`, ok, `${transactions.length} rows; tooltip says ${claimed?.[2] ?? '?'}`)
      drawerSamples.push({ batchName, drawer })
      await page.pressKey('Escape', 'Escape', 27)
      await sleep(200)
    }
    observe({ step: 'drawer-samples', drawer: drawerSamples })

    // --- 8. URL refresh and history -------------------------------------------
    const currentUrl = await page.evaluate<string>('location.href')
    await page.selectOption('#finance-batch', '2nd July 2025 - Morning')
    await page.waitFor(`document.querySelector('#finance-batch').selectedOptions[0].text.startsWith('2nd July 2025 - Morning')`, 30_000, 'july')
    const julyUrl = await page.evaluate<string>('location.href')
    await page.type('#finance-search', '125')
    await page.click('[role=group] button', 3) // "Balance not recorded"
    await sleep(700)
    const withParams = await page.evaluate<string>('location.href')
    check('search and filter are mirrored into the URL', withParams.includes('q=125') && withParams.includes('filter=no_balance'), withParams.replace(BASE_URL, ''))
    await page.navigate(withParams)
    await page.waitFor(`document.querySelector('#finance-batch') && (document.querySelector('table') || document.querySelector('.border-dashed'))`, 60_000, 'reload')
    await sleep(300)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('refresh with URL params restores batch, search and filter', String(state.batch).startsWith('2nd July 2025 - Morning') && state.search === '125' && (state.filters as { text: string; pressed: string }[]).some((filter) => filter.text === 'Balance not recorded' && filter.pressed === 'true'), `${state.batch} / q=${state.search}`)
    observe({ step: 'refresh-with-params', state, screenshot: await page.screenshot('50-refresh-params') })

    await page.evaluate('history.back()')
    await sleep(1500)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const backUrl = await page.evaluate<string>('location.href')
    check('browser back returns to the previous batch and the grid follows', backUrl === currentUrl.replace(/([?&])(q|filter)=[^&]*/g, '$1').replace(/[?&]$/, '') || String(state.batch) !== '2nd July 2025 - Morning' || backUrl !== withParams, `${backUrl.replace(BASE_URL, '')} → ${state.batch}`)
    await page.evaluate('history.forward()')
    await sleep(1500)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const forwardUrl = await page.evaluate<string>('location.href')
    check('browser forward returns to the later state', forwardUrl !== backUrl && String(state.batch).startsWith('2nd July 2025 - Morning'), `${forwardUrl.replace(BASE_URL, '')} → ${state.batch}`)
    observe({ step: 'history', note: `july url ${julyUrl.replace(BASE_URL, '')}` })

    // --- 9. ECEA ---------------------------------------------------------------
    await page.navigate(`${BASE_URL}/finance?program=ECEA`)
    await page.waitFor(`document.querySelector('#finance-batch') && document.querySelector('table')`, 60_000, 'ECEA')
    await sleep(300)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const eceaBanners = (grid as { banners: { text: string }[] }).banners.map((banner) => banner.text)
    const eceaHeadings = (grid as { headings: { text: string }[] }).headings.map((heading) => heading.text)
    const eceaRows = (grid as { rows: { cells: { text: string }[] }[] }).rows
    const balanceIndex = eceaHeadings.indexOf('Balance') - 3
    check('ECEA renders 50 students with no installment group', (grid as { rowCount: number }).rowCount === 50 && !eceaBanners.some((banner) => banner.toLowerCase().includes('installment')), eceaBanners.join(' | '))
    check('ECEA ordinal fee columns sit in the actual group', ['Enrollment fees', '1st Installment', '2nd Installment', 'Late fees'].every((label) => eceaHeadings.some((heading) => heading.toLowerCase() === label.toLowerCase())), eceaHeadings.join(', '))
    check('ECEA Balance header visible and every value blank', balanceIndex >= 0 && eceaRows.every((row) => row.cells[balanceIndex].text === '—'), '')
    check('ECEA batch balance total blank with 50 recorded no figure', (state.summary as string[]).some((text) => text.includes('50 students recorded no figure')), '')
    check('ECEA Balance Due and Settled filters disabled with reason', (state.filters as { text: string; disabled: boolean; title: string }[]).filter((filter) => filter.text === 'Balance due' || filter.text === 'Settled').every((filter) => filter.disabled && filter.title.includes('cannot be established')), '')
    check('ECEA program selector reads ECEA', String(state.program).startsWith('ECEA'), String(state.program))
    observe({ step: 'ecea', state, grid, screenshot: await page.screenshot('60-ecea') })

    // --- 10. Unassigned --------------------------------------------------------
    await page.navigate(`${BASE_URL}/finance?program=PSW&batch=unassigned`)
    await page.waitFor(`document.querySelector('#finance-batch') && document.querySelector('table')`, 60_000, 'unassigned')
    await sleep(300)
    grid = await page.evaluate<Record<string, unknown>>(GRID_PROBE)
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    const unassignedBanners = (grid as { banners: { text: string }[] }).banners.map((banner) => banner.text)
    const unassignedRows = (grid as { rows: { number: string; legacy: boolean }[] }).rows
    check('Unassigned view lists 22 records with no finance columns', (grid as { rowCount: number }).rowCount === 22 && unassignedBanners.length === 2, unassignedBanners.join(' | '))
    check('Unassigned view is labelled as such, not as a batch', String(state.batch).startsWith('Unassigned — no batch (22)') && String(state.note).includes('could not tie'), String(state.batch))
    check('unresolved students read "No student number" with the legacy marker', unassignedRows.filter((row) => row.number === 'No student number').length === 3 && unassignedRows.filter((row) => row.number === 'No student number').every((row) => row.legacy), '')
    check('no fabricated identifier for unresolved students', unassignedRows.every((row) => row.number === 'No student number' || /^\d+$/.test(row.number)), '')
    await page.click('tbody tr td:nth-child(3) button', unassignedRows.findIndex((row) => row.number === 'No student number'))
    await page.waitFor(`document.querySelector('[role=dialog]')`, 5_000, 'drawer')
    drawer = await page.evaluate<Record<string, unknown>>(DRAWER_PROBE)
    check('unresolved student drawer says No student number and No batch', String(drawer?.subtitle).includes('No student number') && String(drawer?.subtitle).includes('No batch'), String(drawer?.subtitle))
    observe({ step: 'unassigned', state, grid, drawer, screenshot: await page.screenshot('70-unassigned-drawer') })
    await page.pressKey('Escape', 'Escape', 27)

    // --- 11. Stale batch id falls back --------------------------------------------
    await page.navigate(`${BASE_URL}/finance?program=PSW&batch=00000000-0000-0000-0000-000000000000`)
    await page.waitFor(`document.querySelector('#finance-batch') && document.querySelector('table')`, 60_000, 'stale')
    state = await page.evaluate<Record<string, unknown>>(STATE_PROBE)
    check('a stale batch link falls back to the default with an explanation', String(state.note).includes('not available') && String(state.batch).startsWith('29th JULY, 2026 - Morning'), String(state.note))

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
