import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATE_DIR } from './config.js'

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
    computer_screenshot: ['Capturing screen', 'Screen captured', 'Could not capture'],
    computer_wait: ['Waiting', 'Condition met', 'Wait ended'],
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

/** Find one node's rendered line by its element index. */
export function nodeLineFor(text: string, index: string): string | undefined {
  for (const line of snapshotNodeLines(text)) {
    const match = /^\t*(\d+)\s/.exec(line)
    if (match && match[1] === index) return line
  }
  return undefined
}

/** The Value segment of a rendered node line, when it has one. */
export function nodeValueOf(line: string | undefined): string | undefined {
  if (line === undefined) return undefined
  return nodeValue(line)
}

/** Secondary actions a node advertises, so a failed action can suggest the next one. */
export function nodeSecondaryActions(line: string | undefined): string[] {
  if (line === undefined) return []
  const match = / Secondary Actions: (.*?)(?: Frame: |$)/.exec(line)
  if (!match) return []
  return match[1]!.split(',').map((value) => value.trim()).filter(Boolean)
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
  /** Hide the visible session without closing the helper process. */
  endSession?(reason?: 'explicit' | 'idle'): Promise<boolean>
  /** Close the helper and return to a restartable idle state. */
  closeHelper?(): Promise<void>
}

/**
 * A one-line record of the helper this computer use server started.
 *
 * It exists so `fbc cleanup` can find a border the agent walked away from
 * without guessing at process names, and so `fbc doctor` can tell a live
 * session from its leftover.
 */
export interface OverlayRecord {
  pid: number
  parentPid: number
  startedAt: string
  monitors: number
}

const OVERLAY_RECORD = join(STATE_DIR, 'overlay.json')

export function readOverlayRecord(): OverlayRecord | undefined {
  try {
    if (!existsSync(OVERLAY_RECORD)) return undefined
    const raw = JSON.parse(readFileSync(OVERLAY_RECORD, 'utf8')) as Partial<OverlayRecord>
    if (typeof raw.pid !== 'number') return undefined
    return {
      pid: raw.pid,
      parentPid: typeof raw.parentPid === 'number' ? raw.parentPid : 0,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      monitors: typeof raw.monitors === 'number' ? raw.monitors : 0,
    }
  } catch {
    return undefined
  }
}

function writeOverlayRecord(record: OverlayRecord): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(OVERLAY_RECORD, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  } catch {
    // A missing record costs diagnostics, never the session.
  }
}

export function removeOverlayRecord(): void {
  try {
    rmSync(OVERLAY_RECORD, { force: true })
  } catch {
    // Best effort: a stale record is reported and replaced, not trusted.
  }
}

/** Raw frames are kept separately from the compacted observation. Never renumber nodes. */
export class SnapshotTargets {
  private app = ''
  private frames = new Map<string, Rect>()
  private window: Rect | undefined
  private identity: SnapshotWindow | undefined
  private lines: string[] = []
  private lineByIndex = new Map<string, string>()
  /** Screenshot pixels per window pixel, from the snapshot's own header line. */
  private scale = 1

  clear(): void {
    this.app = ''
    this.frames.clear()
    this.window = undefined
    this.identity = undefined
    this.lines = []
    this.lineByIndex.clear()
    this.scale = 1
  }

  screenshotScale(): number {
    return this.scale
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
    // A downscaled screenshot is its own coordinate space, so the same header
    // that tells the model how big the image is also tells the cursor how to
    // get back to the window.
    const scale = /^Screenshot: \d+x\d+ from \d+x\d+ \(scale ([0-9.]+)/m.exec(text)
    if (scale) {
      const value = Number(scale[1])
      if (Number.isFinite(value) && value > 0) this.scale = value
    }
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
        Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) {
      // The model's coordinates are screenshot pixels; the window's identity is
      // in window pixels. Convert once, here, so a downscaled capture cannot
      // put the cursor somewhere the click did not land.
      const windowX = x / this.scale
      const windowY = y / this.scale
      if (windowX < this.identity.width && windowY < this.identity.height) {
        return { rect: { x: windowX - 0.5, y: windowY - 0.5, width: 1, height: 1 },
          pointer: true, coordinateSpace: 'window', window: this.identity }
      }
      return { pointer: false }
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
  private lastEndReason?: 'explicit' | 'idle'
  private idleEnds = 0
  private helperPid?: number
  private stopping = false
  /** A failed helper is retried this many times per process, then reported as failed. */
  private restartBudget = 3

  constructor() {
    this.state = process.env.FBC_OVERLAY === '0' ? 'disabled' : process.platform === 'win32' ? 'idle' : 'unsupported'
  }

  status(): Record<string, unknown> {
    return { state: this.state, error: this.error, windows: this.windows, sessionActive: this.sessionActive,
      ...(this.displayRevision === undefined ? {} : { displayRevision: this.displayRevision }),
      ...(this.rendered === undefined ? {} : { rendered: this.rendered }),
      ...(this.reducedMotion === undefined ? {} : { reducedMotion: this.reducedMotion }),
      ...(this.helperPid === undefined ? {} : { helperPid: this.helperPid }),
      ...(this.lastEndReason === undefined ? {} : { lastEndReason: this.lastEndReason }),
      idleEnds: this.idleEnds }
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
        const owned = (): void => {
          this.state = 'owned-elsewhere'
          this.error =
            'Another Freebuff Computer session already owns the desktop overlay, so this session runs without a visible border.'
          this.sessionActive = false
          clearTimeout(timer)
          resolve()
        }
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
                  this.helperPid = this.child?.pid ?? undefined
                  writeOverlayRecord({
                    pid: this.child?.pid ?? 0,
                    parentPid: process.pid,
                    startedAt: new Date().toISOString(),
                    monitors: Array.isArray(this.windows) ? this.windows.length : 0,
                  })
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
          // The parent PID is the belt to the socket's braces: a helper that
          // cannot see its server must not keep painting.
          this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', script, '-Port', String(address.port), '-Token', token, '-ParentPid', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
          this.child.stderr?.on('data', (chunk: Buffer) => { this.error = ((this.error ?? '') + chunk.toString()).slice(-3000) })
          this.child.once('error', failed)
          this.child.once('exit', (code) => {
            if (this.stopping) return
            if (this.state === 'starting') {
              // Exit code 3 means another session holds the overlay mutex. That
              // is a normal outcome, not a broken setup.
              if (code === 3) owned()
              else failed(new Error(this.error ?? `Overlay exited with code ${code}`))
            } else if (!this.closed) {
              if (code === 3) { this.state = 'owned-elsewhere'; this.sessionActive = false }
              else { this.state = 'failed'; this.error ??= `Overlay exited with code ${code}` }
            }
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
    if (ending && this.state !== 'running') {
      this.sessionActive = false
      if (event.label !== undefined) this.lastEndReason = event.label === 'Session idle' ? 'idle' : 'explicit'
      return
    }
    // A helper that died is worth one more attempt: a permanently dead overlay
    // for the rest of the process was the old behaviour, and it hid the failure.
    if (!ending && (this.state === 'failed' || this.state === 'owned-elsewhere') && this.restartBudget > 0) {
      this.restartBudget -= 1
      await this.closeHelper()
    }
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

  /**
   * Hide the border and cursor without closing the helper.
   *
   * The border exists so a person can see that an agent is driving their
   * machine. Once the agent has stopped calling tools, leaving it up is a
   * claim that something is still happening.
   */
  async endSession(reason: 'explicit' | 'idle' = 'explicit'): Promise<boolean> {
    const active = this.sessionActive || this.state === 'running'
    if (!active) {
      this.sessionActive = false
      return false
    }
    await this.send({
      ts: new Date().toISOString(),
      tool: 'computer_session',
      phase: 'end',
      pointer: false,
      label: reason === 'idle' ? 'Session idle' : 'Session ended',
    })
    this.sessionActive = false
    this.lastEndReason = reason
    if (reason === 'idle') this.idleEnds += 1
    return true
  }

  /** Close the helper and reset to `idle`, so a later action can start a new one. */
  async closeHelper(): Promise<void> {
    if (this.starting) await this.starting.catch(() => {})
    this.starting = undefined
    this.stopping = true
    for (const complete of this.pending.values()) complete()
    this.pending.clear()
    this.socket?.destroy()
    this.socket = undefined
    this.server?.close()
    this.server = undefined
    const child = this.child
    this.child = undefined
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve() }, 1500)
        child.once('exit', () => { clearTimeout(timer); resolve() })
      })
    }
    this.sessionActive = false
    this.windows = undefined
    this.displayRevision = undefined
    this.rendered = undefined
    this.helperPid = undefined
    this.stopping = false
    if (!this.closed) this.state = 'idle'
    removeOverlayRecord()
  }

  async close(): Promise<void> {
    this.closed = true
    await this.closeHelper()
    this.state = 'closed'
  }
}
