/**
 * Headless Chrome over the DevTools Protocol, for the finance QA scripts.
 *
 * Launches the installed Chrome headless with a throwaway profile, attaches
 * with nothing but Node's built-in WebSocket, and exposes a small page
 * object that navigates, evaluates, clicks, types and screenshots. Shared by
 * `browser-acceptance.mts` (GRID-03B/03C) and `unassigned-audit.mts`
 * (RECONCILE-04A) so the two drive the page the same way.
 *
 * Nothing here writes to the application: it clicks, types, scrolls and reads.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const DEBUG_PORT = 9333

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((candidate): candidate is string => Boolean(candidate))

/** Where a page sets its cookies and saves its screenshots. */
export interface PageOptions {
  baseUrl: string
  shotsDir: string
}

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

export class Cdp {
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

export class Page {
  consoleErrors: string[] = []
  consoleWarnings: string[] = []
  private loadWaiters: (() => void)[] = []
  private cdp: Cdp
  private sessionId: string
  private options: PageOptions

  constructor(cdp: Cdp, sessionId: string, options: PageOptions) {
    this.cdp = cdp
    this.sessionId = sessionId
    this.options = options
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

  static async open(cdp: Cdp, options: PageOptions): Promise<Page> {
    const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string }
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }
    const page = new Page(cdp, sessionId, options)
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
      cookies: cookies.map((cookie) => ({ ...cookie, url: this.options.baseUrl, path: '/' })),
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
    const target = path.join(this.options.shotsDir, `${name}.png`)
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// -----------------------------------------------------------------------------
// Chrome
// -----------------------------------------------------------------------------

export async function launchChrome(profileDir: string): Promise<{ process: ChildProcess; wsUrl: string }> {
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

