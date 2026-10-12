import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'

export interface Rect { x: number; y: number; width: number; height: number }
export interface SnapshotWindow { pid: number; title: string; width: number; height: number; hwnd?: string }
export interface Target { rect?: Rect; dragTo?: Rect; pointer: boolean; coordinateSpace?: 'window' | 'desktop'; window?: SnapshotWindow }
export interface Activity {
  ts: string
  tool: string
  app?: string
  phase: 'begin' | 'dispatch' | 'end' | 'error'
  rect?: Rect
  dragTo?: Rect
  /** A cursor is shown only when we know the actual target, not an app's bounds. */
  pointer: boolean
  coordinateSpace?: 'window' | 'desktop'
  window?: SnapshotWindow
  label?: string
}

/**
 * Describe observable tool work, not a guess about the model's internal state.
 *
 * The completion labels are deliberately about *dispatch*, not effect: the
 * overlay reports when the driver call returned, which is before anything has
 * been verified. "Text sent" is true even when the app ignored the input;
 * "Text set" would claim a change nobody measured. Whether the app actually
 * responded is reported by the verification line in the tool result, where
 * there is evidence to back it.
 */
export function activityLabel(tool: string, phase: Activity['phase']): string {
  const labels: Record<string, [string, string, string]> = {
    computer_session: ['Session active', 'Session ended', 'Session unavailable'],
    list_apps: ['Finding apps', 'Apps listed', 'Could not list apps'],
    get_app_state: ['Reading app', 'View captured', 'Could not read app'],
    click: ['Clicking', 'Click sent', 'Click failed'],
    set_value: ['Setting text', 'Text sent', 'Text failed'],
    type_text: ['Typing', 'Text sent', 'Typing failed'],
    press_key: ['Sending key', 'Key sent', 'Key failed'],
    scroll: ['Scrolling', 'Scroll sent', 'Scroll failed'],
    drag: ['Dragging', 'Drag sent', 'Drag failed'],
    perform_secondary_action: ['Acting on element', 'Action sent', 'Action failed'],
  }
  return (labels[tool] ?? ['Working', 'Step finished', 'Needs attention'])[(phase === 'begin' || phase === 'dispatch') ? 0 : phase === 'end' ? 1 : 2]!
}

/**
 * Snapshot analysis for action verification.
 *
 * The driver reports success when a dispatch did not throw. Whether an app
 * actually reacted is a separate question, and the wrapper can answer part of
 * it without any driver change: it holds the tree the model was looking at and
 * receives a fresh one after every action. Comparing those two is what turns
 * "the call returned" into evidence. Everything here works on rendered
 * snapshot text, so it stays correct for third-party drivers too.
 */

/** A node line is `<tabs><index> <role> <title>[ Value: ...][ Actions: ...][ Frame: ...]`. */
const NODE_LINE = /^\t*\d+\s+/

/** Node lines only: the state an agent acts on, with window headers excluded. */
export function snapshotNodeLines(text: string): string[] {
  const lines: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (NODE_LINE.test(line)) lines.push(line.replace(/\s+$/u, ''))
  }
  return lines
}

export function snapshotNodeCount(text: string): number {
  return snapshotNodeLines(text).length
}

/**
 * A cheap order-sensitive hash of a bounded projection of the tree.
 *
 * A plain hash of the whole snapshot cannot be compared across calls: the
 * driver renders an action's snapshot with its own defaults and a model's
 * `get_app_state` with the server's tuned limits, so the two texts have
 * different lengths even when nothing changed. Callers therefore fingerprint
 * both sides at the same node limit, the one the model actually saw.
 */
export function fingerprintLines(lines: string[], limit: number = Number.POSITIVE_INFINITY): string {
  const bounded = lines.slice(0, Math.max(0, Math.min(limit, lines.length)))
  let hash = 2166136261
  for (const line of bounded) {
    for (let index = 0; index < line.length; index++) {
      hash ^= line.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    hash = Math.imul(hash ^ 10, 16777619)
  }
  hash = Math.imul(hash ^ bounded.length, 16777619)
  return `${bounded.length}-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function snapshotFingerprint(text: string, limit?: number): string {
  return fingerprintLines(snapshotNodeLines(text), limit)
}

export type VerificationState = 'changed' | 'unchanged' | 'unverified' | 'confirmed' | 'differs' | 'batch'

/** Every mutating tool result carries exactly one of these, so the model never has to guess. */
export const VERIFICATION_TAG = '[verification: '

export function verificationLine(state: VerificationState, detail: string): string {
  return `${VERIFICATION_TAG}${state}] ${detail}`
}

/** Read the state a result reported, for batch summaries and tests. */
export function parseVerification(text: string): VerificationState | undefined {
  const match = /\[verification: (changed|unchanged|unverified|confirmed|differs|batch)\]/.exec(text)
  return match?.[1] as VerificationState | undefined
}

export interface Observation {
  /** Node-line count of the snapshot the model saw. */
  nodes: number
  /** Fingerprint of that snapshot at its own node count. */
  fingerprint: string
  /** The raw line of one node, for reading a value back after an action. */
  lineFor(index: string | undefined): string | undefined
}

export type ChangeClassification =
  | { state: 'changed' | 'unchanged'; nodes: number }
  | { state: 'unverified'; reason: string }

/**
 * Did the tree change in the region the model could actually see?
 *
 * Detection is bounded by the earlier snapshot's node count: a change below
 * that cut is invisible here and reported as "no observable change", never as
 * proof that nothing happened.
 */
export function classifyChange(before: Observation | undefined, afterText: string | undefined): ChangeClassification {
  if (!before) return { state: 'unverified', reason: 'this session has no earlier snapshot of that window to compare against' }
  if (before.nodes === 0) return { state: 'unverified', reason: 'the earlier snapshot of that window contained no nodes' }
  if (afterText === undefined) return { state: 'unverified', reason: 'the driver returned no new snapshot' }
  const after = snapshotNodeCount(afterText)
  if (after === 0) return { state: 'unverified', reason: 'the new snapshot contained no nodes' }
  const comparable = Math.min(after, before.nodes)
  const matches = after >= before.nodes && snapshotFingerprint(afterText, before.nodes) === before.fingerprint
  return { state: matches ? 'unchanged' : 'changed', nodes: comparable }
}

export type ReadBack =
  | { state: 'confirmed' }
  | { state: 'differs'; observed: string }
  | { state: 'unreadable'; reason: string }

/** The driver appends these segments in this order, and omits a value equal to the label. */
const IDENTITY_MARKERS = [' Value: ', ' Secondary Actions: ', ' Frame: ']

/** Identify a node without its index, which the driver renumbers after an action. */
export function nodeIdentity(line: string): string {
  const body = line.replace(/^\t*/, '').replace(/^\d+\s+/, '')
  let end = body.length
  for (const marker of IDENTITY_MARKERS) {
    const at = body.indexOf(marker)
    if (at >= 0 && at < end) end = at
  }
  return body.slice(0, end)
}

function nodeValue(line: string): string | undefined {
  const at = line.indexOf(' Value: ')
  if (at < 0) return undefined
  let rest = line.slice(at + ' Value: '.length)
  for (const marker of [' Secondary Actions: ', ' Frame: ']) {
    const markerAt = rest.indexOf(marker)
    if (markerAt >= 0) rest = rest.slice(0, markerAt)
  }
  return rest
}

/**
 * Read an element's value back out of the snapshot returned after an action.
 *
 * Matching is by the node's rendered identity, not its index, because an action
 * refreshes the driver's snapshot and renumbers nodes. Anything ambiguous is
 * reported as unreadable rather than guessed at.
 */
export function readBackValue(beforeLine: string | undefined, afterText: string, expected: string): ReadBack {
  if (beforeLine === undefined) return { state: 'unreadable', reason: 'the element was not in the last snapshot this session read' }
  const identity = nodeIdentity(beforeLine)
  if (!identity) return { state: 'unreadable', reason: 'the element line carried no identity to match on' }
  const matches = snapshotNodeLines(afterText).filter((line) => nodeIdentity(line) === identity)
  if (matches.length === 0) return { state: 'unreadable', reason: 'the element is no longer present in the new snapshot' }
  const values = matches.map(nodeValue).filter((value): value is string => value !== undefined)
  if (values.length === 0) {
    return {
      state: 'unreadable',
      reason: 'the new snapshot shows no value for this element, and the driver omits a value that is empty or identical to the element label',
    }
  }
  const wanted = expected.replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  if (values.every((value) => valueMatches(value, wanted))) return { state: 'confirmed' }
  const distinct = [...new Set(values)]
  if (distinct.length === 1) return { state: 'differs', observed: distinct[0]! }
  return { state: 'unreadable', reason: 'several nodes in the new snapshot match this element with different values' }
}

/** Long values are truncated with an ellipsis by the driver's text limit. */
function valueMatches(observed: string, wanted: string): boolean {
  if (observed === wanted) return true
  return observed.endsWith('...') && wanted.length > observed.length && wanted.startsWith(observed.slice(0, -3))
}
export interface OverlaySink {
  send(event: Activity): Promise<void>
  status(): Record<string, unknown>
  close(): Promise<void>
}

/** Raw frames are kept separately from the compacted observation. Never renumber nodes. */
export class SnapshotTargets {
  private app = ''
  private frames = new Map<string, Rect>()
  private window: Rect | undefined
  private identity: SnapshotWindow | undefined
  private lines: string[] = []
  private lineByIndex = new Map<string, string>()

  clear(): void {
    this.app = ''
    this.frames.clear()
    this.window = undefined
    this.identity = undefined
    this.lines = []
    this.lineByIndex.clear()
  }

  /** Actions may carry a fresh snapshot too. A plain acknowledgement is not one. */
  static isSnapshot(text: string): boolean {
    return /^App=.+ \(pid \d+\)\r?$/m.test(text) && /^Window: ".*", App: .+\.\r?$/m.test(text) && /^\t*0 window .*Frame:/m.test(text)
  }

  observe(app: string, text: string): void {
    this.clear()
    this.app = app.toLowerCase()
    const number = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)'
    const frame = new RegExp(`Frame:\\s*\\{x:\\s*(${number}),\\s*y:\\s*(${number}),\\s*width:\\s*(${number}),\\s*height:\\s*(${number})\\}`)
    for (const line of text.split(/\r?\n/)) {
      const node = /^\t*(\d+)\s+(.*)$/.exec(line)
      if (!node) continue
      const trimmed = line.replace(/\s+$/u, '')
      this.lines.push(trimmed)
      // First occurrence wins: a rendered index addresses one node, and the
      // verification line must read back the same one.
      if (!this.lineByIndex.has(node[1]!)) this.lineByIndex.set(node[1]!, trimmed)
      const match = frame.exec(line)
      if (!match) continue
      const rect = { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) }
      if (!Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) continue
      this.frames.set(node[1]!, rect)
      if (!this.window && node[2]!.startsWith('window ')) this.window = rect
    }
    const pid = /^App=.+ \(pid (\d+)\)\r?$/m.exec(text)
    const title = /^Window: "(.*)", App: .+\.\r?$/m.exec(text)
    if (pid && title && this.window && this.window.x === 0 && this.window.y === 0 &&
        (text.match(/^Window: /gm)?.length === 1)) {
      const hwnd = /^Window-ID: ([1-9][0-9]*)\r?$/m.exec(text)?.[1]
      let windowTitle = title[1]!
      try { windowTitle = JSON.parse(`"${windowTitle}"`) as string } catch { /* Older driver titles may use Go-specific escapes. */ }
      this.identity = { pid: Number(pid[1]), title: windowTitle, width: this.window.width, height: this.window.height, ...(hwnd ? {hwnd} : {}) }
    }
  }

  /**
   * What this session last observed for `app`, as the baseline for verifying
   * the next action. Only one app is observed at a time, so a call for another
   * window reports nothing instead of comparing against a different tree.
   */
  observed(app: string | undefined): Observation | undefined {
    if (typeof app !== 'string' || app === '' || app.toLowerCase() !== this.app) return undefined
    if (this.lines.length === 0) return undefined
    return {
      nodes: this.lines.length,
      fingerprint: fingerprintLines(this.lines),
      lineFor: (index: string | undefined) => (index === undefined ? undefined : this.lineByIndex.get(index)),
    }
  }

  target(args: Record<string, unknown>, tool?: string): Target {
    if (typeof args['app'] !== 'string' || args['app'].toLowerCase() !== this.app) return { pointer: false }
    if (tool === 'drag') {
      const from = this.target({app: args['app'], x: args['from_x'], y: args['from_y']})
      const to = this.target({app: args['app'], x: args['to_x'], y: args['to_y']})
      return from.pointer && to.pointer ? {...from, dragTo: to.rect} : {pointer: false}
    }
    if (typeof args['element_index'] === 'string') {
      const rect = this.frames.get(args['element_index'])
      return { rect, pointer: rect !== undefined, ...(this.identity ? {coordinateSpace: 'window' as const, window: this.identity} : {}) }
    }
    // The bundled Windows snapshot identifies the exact physical window.
    // Its screenshot coordinates use that same window-relative pixel space.
    // Centre a one-pixel marker on the requested point; the native renderer
    // still checks current identity, size, visibility and occlusion.
    const x = args['x'], y = args['y']
    if (this.identity?.hwnd && typeof x === 'number' && typeof y === 'number' &&
        Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 &&
        x < this.identity.width && y < this.identity.height) {
      return { rect: { x: x - 0.5, y: y - 0.5, width: 1, height: 1 },
        pointer: true, coordinateSpace: 'window', window: this.identity }
    }
    // Coordinate tools use screenshot pixels; without a verified transform to
    // desktop pixels, show activity but never invent a cursor location.
    return { rect: this.window, pointer: false }
  }
}

/** A separately hosted native overlay, authenticated over a private loopback connection. */
export class DesktopOverlay implements OverlaySink {
  private server?: Server
  private socket?: Socket
  private child?: ChildProcess
  private starting?: Promise<void>
  private closed = false
  private state: string
  private error?: string
  private windows: unknown
  private displayRevision?: number
  private sequence = 0
  private sessionActive = false
  private reducedMotion?: boolean
  private rendered?: Record<string, unknown>
  private pending = new Map<number, () => void>()

  constructor() {
    this.state = process.env.FBC_OVERLAY === '0' ? 'disabled' : process.platform === 'win32' ? 'idle' : 'unsupported'
  }

  status(): Record<string, unknown> {
    return { state: this.state, error: this.error, windows: this.windows, sessionActive: this.sessionActive,
      ...(this.displayRevision === undefined ? {} : { displayRevision: this.displayRevision }),
      ...(this.rendered === undefined ? {} : { rendered: this.rendered }),
      ...(this.reducedMotion === undefined ? {} : { reducedMotion: this.reducedMotion }) }
  }

  private async start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.state !== 'idle' || this.closed) return
    this.starting = this.connect()
    return this.starting
  }

  private async connect(): Promise<void> {
    this.state = 'starting'
    const token = randomBytes(24).toString('hex')
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Overlay did not start within 10 seconds')), 10_000)
        const ready = () => { clearTimeout(timer); resolve() }
        const failed = (error: Error) => { clearTimeout(timer); reject(error) }
        const server = createServer((socket) => {
          let buffer = ''
          let authenticated = false
          socket.setTimeout(2000, () => { if (!authenticated) socket.destroy() })
          socket.on('error', () => socket.destroy())
          socket.on('data', (data) => {
            buffer += data.toString('utf8')
            if (buffer.length > 16384) { socket.destroy(); return }
            let newline: number
            while ((newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
              try {
                const message = JSON.parse(line) as Record<string, unknown>
                if (!authenticated) {
                  if (message['token'] !== token || this.socket) { socket.destroy(); return }
                  authenticated = true
                  this.socket = socket
                  this.windows = message['windows']
                  if (typeof message['reducedMotion'] === 'boolean') this.reducedMotion = message['reducedMotion']
                  if (typeof message['displayRevision'] === 'number') this.displayRevision = message['displayRevision']
                  this.state = 'running'
                  ready()
                } else if (typeof message['painted'] === 'number') {
                  if (message['rendered'] && typeof message['rendered'] === 'object') this.rendered = message['rendered'] as Record<string, unknown>
                  this.pending.get(message['painted'])?.()
                } else if (Array.isArray(message['windows']) && typeof message['displayRevision'] === 'number') {
                  this.windows = message['windows']
                  this.displayRevision = message['displayRevision']
                }
              } catch { socket.destroy() }
            }
          })
          socket.on('close', () => {
            if (this.socket === socket && !this.closed) {
              this.state = 'failed'; this.error = 'Overlay connection closed'
              this.sessionActive = false
              for (const complete of this.pending.values()) complete()
            }
          })
        })
        this.server = server
        server.on('error', failed)
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          if (!address || typeof address === 'string') { failed(new Error('Overlay listener unavailable')); return }
          const script = fileURLToPath(new URL('../native/overlay.ps1', import.meta.url))
          this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', script, '-Port', String(address.port), '-Token', token], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
          this.child.stderr?.on('data', (chunk: Buffer) => { this.error = ((this.error ?? '') + chunk.toString()).slice(-3000) })
          this.child.once('error', failed)
          this.child.once('exit', (code) => {
            if (this.state === 'starting') failed(new Error(this.error ?? `Overlay exited with code ${code}`))
            else if (!this.closed) { this.state = 'failed'; this.error ??= `Overlay exited with code ${code}` }
          })
        })
      })
    } catch (error) {
      this.state = 'failed'
      this.error = error instanceof Error ? error.message : String(error)
      this.socket?.destroy(); this.server?.close(); this.child?.kill()
    }
  }

  async send(event: Activity): Promise<void> {
    const ending = event.tool === 'computer_session' && event.phase === 'end'
    if (ending && this.state !== 'running') { this.sessionActive = false; return }
    await this.start()
    if (this.closed || this.state !== 'running' || !this.socket) return
    this.sessionActive = !ending
    const seq = ++this.sequence
    // Wait for the first paint before dispatching the action. A failed overlay
    // must not hang the MCP transport indefinitely.
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); this.pending.delete(seq); resolve() }
      const timer = setTimeout(() => { this.error = 'Overlay paint acknowledgement timed out'; finish() }, 1000)
      this.pending.set(seq, finish)
      // Driver frames on Windows are window-relative. No identity means no safe
      // transform; only explicit desktop fixtures may bypass window resolution.
      this.socket!.write(`${JSON.stringify({ ...event, coordinateSpace: event.coordinateSpace ?? 'window', label: (process.env.FBC_INPUT_MODE === 'foreground' ? 'Foreground · ' : '') + (event.label ?? activityLabel(event.tool, event.phase)), seq })}\n`, (error) => { if (error) finish() })
    })
  }

  async close(): Promise<void> {
    this.closed = true
    this.sessionActive = false
    if (this.starting) await this.starting
    for (const complete of this.pending.values()) complete()
    this.socket?.destroy()
    this.server?.close()
    const child = this.child
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve() }, 1500)
        child.once('exit', () => { clearTimeout(timer); resolve() })
      })
    }
    this.state = 'closed'
  }
}
