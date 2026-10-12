import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateSubdir, type FbcConfig } from './config.js'
import { activityLabel, type Activity, type OverlaySink, type Target } from './overlay.js'

export interface TrajectoryEntry {
  ts: string
  kind: 'tool_call' | 'tool_result' | 'note' | 'activity'
  tool?: string
  /** Truncated arguments, or the reason a call was refused. */
  args?: unknown
  /** Result summary: sizes and outcome, not the full snapshot. */
  result?: unknown
}

/**
 * Records what the agent observed and did, as JSONL.
 *
 * A trajectory is what makes a Computer Use session debuggable after the fact
 * and demoable on a call. Snapshots are recorded as metadata (sizes, node
 * counts) rather than full payloads, so a session does not balloon to hundreds
 * of megabytes; the raw outline is what the model saw, not a record of state.
 */
export class TrajectoryRecorder {
  readonly path: string
  private readonly enabled: boolean

  constructor(config: FbcConfig, sessionId: string, private readonly overlay?: OverlaySink) {
    this.enabled = config.recordTrajectory
    this.path = join(stateSubdir('trajectories'), `${sessionId}.jsonl`)
  }

  record(entry: TrajectoryEntry): void {
    if (!this.enabled) return
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      // Recording must never break a Computer Use session.
    }
  }

  note(message: string): void {
    this.record({ ts: new Date().toISOString(), kind: 'note', result: message })
  }

  async activity(phase: Activity['phase'], tool: string, args: Record<string, unknown>, target: Target): Promise<void> {
    // A window title is used only for private native identity matching, never
    // displayed or recorded. Typed text, key payloads and node labels stay out.
    const event: Activity = { ts: new Date().toISOString(), tool, phase, label: activityLabel(tool, phase), app: typeof args['app'] === 'string' ? args['app'] : undefined, ...target }
    this.record({ ts: event.ts, kind: 'activity', tool, result: { ...event, ...(event.window ? {window: {...event.window, title: undefined}} : {}) } })
    try { await this.overlay?.send(event) }
    catch (error) { this.note(`Overlay unavailable: ${error instanceof Error ? error.message : String(error)}`) }
  }
}

/** Keep recorded argument payloads bounded. */
export function summarizeArgs(args: unknown, limit = 2000): unknown {
  if (args === null || typeof args !== 'object') return args
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > limit) {
      out[key] = `${value.slice(0, limit)}… [${value.length} chars total]`
    } else {
      out[key] = value
    }
  }
  return out
}
