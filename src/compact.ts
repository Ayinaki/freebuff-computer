/**
 * Snapshot compaction.
 *
 * An accessibility snapshot is the single largest thing this server sends to a
 * model. Measured on win32-x64 with the default driver limits, one Spotify
 * window produced a 977,000-byte outline — enough to blow a model's context on
 * its own. Two independent levers reduce that:
 *
 *   1. Volume — ask for fewer nodes/depth (handled in contract.ts defaults, and
 *      it uses the driver's own documented knobs, so element indexes stay valid).
 *   2. Redundancy — drop information the outline repeats (this file).
 *
 * Compaction here is deliberately *structure-preserving*: it never renumbers,
 * reorders, adds, or drops a node line, so every `element_index` the model sees
 * still addresses the element the driver meant. Only redundant decorations are
 * removed.
 */

export interface CompactOptions {
  /** Hard cap on the returned payload. */
  maxBytes: number
}

export interface CompactResult {
  text: string
  originalBytes: number
  compactedBytes: number
  /** Bytes saved by dropping redundant frames and secondary actions. */
  savedBytes: number
  /** Nodes dropped because the byte cap was reached (the tail of the outline). */
  omittedNodes: number
  /** True when maxBytes cut the outline short. */
  truncated: boolean
  /** Rough token estimate for the returned text (chars / 4). */
  estimatedTokens: number
}

const FRAME_RE = /\s+Frame:\s*\{([^}]*)\}\s*$/
const ACTIONS_RE = /\s+Secondary Actions:\s*(.*?)(?=\s+Frame:|$)/

/** Only-scroll actions carry no information: nearly every node has one. */
function isNoiseActions(actions: string): boolean {
  const parts = actions
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
  return parts.length === 1 && parts[0] === 'ScrollIntoView'
}

export function compactSnapshot(raw: string, options: CompactOptions): CompactResult {
  const originalBytes = Buffer.byteLength(raw, 'utf8')
  const lines = raw.split('\n')

  const out: string[] = []
  let bytes = 0
  let omittedNodes = 0
  let truncated = false

  // frameStack[depth] = the Frame string last emitted at that depth, so a child
  // can tell whether its geometry is simply inherited from its parent.
  const frameStack: Array<string | null> = []

  for (const line of lines) {
    const match = /^(\t*)(\d+)\s(.*)$/.exec(line)

    if (!match) {
      // Header lines (`App=...`, `Window: ...`) or blank lines pass through.
      const cost = Buffer.byteLength(line, 'utf8') + 1
      if (bytes + cost > options.maxBytes && out.length > 0) {
        truncated = true
        break
      }
      out.push(line)
      bytes += cost
      continue
    }

    const depth = match[1]!.length
    const index = match[2]!
    let body = match[3]!

    // Pull off the two decorations we may drop.
    let frame: string | null = null
    const frameMatch = FRAME_RE.exec(body)
    if (frameMatch) {
      frame = frameMatch[1]!.trim()
      body = body.slice(0, frameMatch.index)
    }

    let actions: string | null = null
    const actionsMatch = ACTIONS_RE.exec(body)
    if (actionsMatch) {
      actions = actionsMatch[1]!.trim()
      body = body.slice(0, actionsMatch.index)
    }

    const keepFrame = frame !== null && frameStack[depth - 1] !== frame
    const keepActions = actions !== null && !isNoiseActions(actions)

    body = body.trimEnd()

    let rebuilt = `${'\t'.repeat(depth)}${index} ${body}`
    if (keepActions) rebuilt += ` Secondary Actions: ${actions}`
    if (keepFrame) rebuilt += ` Frame: {${frame}}`

    const cost = Buffer.byteLength(rebuilt, 'utf8') + 1
    if (bytes + cost > options.maxBytes && out.length > 0) {
      truncated = true
      // Every remaining node line counts as omitted.
      omittedNodes += 1
      continue
    }

    frameStack.length = depth + 1
    frameStack[depth] = frame
    if (!keepFrame) frameStack[depth] = frameStack[depth - 1] ?? null
    out.push(rebuilt)
    bytes += cost
  }

  if (truncated) {
    out.push(
      '',
      `[snapshot truncated by Freebuff Computer at ${options.maxBytes} bytes; ${omittedNodes} further node(s) omitted]`,
      'Call get_app_state again with a larger max_tree_nodes, or target a narrower app/window.',
    )
  }

  const text = out.join('\n')
  const compactedBytes = Buffer.byteLength(text, 'utf8')
  return {
    text,
    originalBytes,
    compactedBytes,
    savedBytes: originalBytes - compactedBytes,
    omittedNodes,
    truncated,
    estimatedTokens: Math.ceil(text.length / 4),
  }
}

/** Estimate tokens for any payload, using the same crude heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
