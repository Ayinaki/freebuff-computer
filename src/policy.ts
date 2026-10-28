import { ALWAYS_BLOCKED_KEYS, BLOCKED_TEXT_PATTERNS, findTool } from './contract.js'
import type { FbcConfig } from './config.js'
import { parseCuaSubset, type CuaPlan } from './cua-subset.js'

export interface PolicyDecision {
  allowed: boolean
  /** Machine-readable reason code, useful in tests and trajectories. */
  code?:
    | 'blocked-key'
    | 'blocked-payload'
    | 'app-not-allowed'
    | 'audit-mode-read-only'
    | 'unknown-tool'
    | 'invalid-cua-subset'
    | 'invalid-session'
    | 'invalid-screenshot'
    | 'invalid-wait'
    | 'invalid-window-selector'
  reason?: string
}

const ALLOW: PolicyDecision = { allowed: true }

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/\s+/g, '').replace(/cmd|command|meta|super/g, 'cmd').replace(/control/g, 'ctrl').replace(/alt|option/g, 'alt')
}

function matchApp(app: string, allowed: string[]): boolean {
  const selector = /^(.+)@window:([1-9][0-9]*):[1-9][0-9]*:[1-9][0-9]*$/.exec(app)
  // Window handles and creation timestamps are not app identities. The driver
  // independently verifies the claimed process name/PID before accessing a window.
  const needle = (selector?.[1] ?? app).toLowerCase()
  return allowed.some((entry) => {
    const candidate = entry.trim().toLowerCase()
    return candidate.length > 0 && (needle.includes(candidate) || selector?.[2] === candidate)
  })
}

/**
 * Decide whether a tool call may run. Read-only tools are never blocked by
 * audit or allowlist mode, so the agent can always explain what it sees.
 */
export function checkAction(
  toolName: string,
  args: Record<string, unknown>,
  config: FbcConfig,
): PolicyDecision {
  const tool = findTool(toolName)
  if (!tool) return { allowed: false, code: 'unknown-tool', reason: `Unknown tool: ${toolName}` }
  if (toolName === 'exec_cua_subset') return checkCuaSubset(args['code'], config).decision
  if (toolName === 'computer_session' && (typeof args['action'] !== 'string' || !['begin', 'end', 'status'].includes(args['action']) || Object.keys(args).some(key => key !== 'action'))) {
    return { allowed: false, code: 'invalid-session', reason: 'computer_session accepts only action: "begin", "end", or "status".' }
  }

  if (toolName === 'computer_screenshot') {
    const extra = Object.keys(args).filter((key) => !['app', 'max_dimension'].includes(key))
    if (typeof args['app'] !== 'string' || args['app'].trim() === '') {
      return { allowed: false, code: 'invalid-screenshot', reason: 'computer_screenshot needs the app selector from list_apps.' }
    }
    const dimension = args['max_dimension']
    if (dimension !== undefined && (typeof dimension !== 'number' || !Number.isFinite(dimension) || dimension < 320)) {
      return { allowed: false, code: 'invalid-screenshot', reason: 'max_dimension must be a number of at least 320 pixels.' }
    }
    if (extra.length > 0) {
      return { allowed: false, code: 'invalid-screenshot', reason: `computer_screenshot does not accept: ${extra.join(', ')}.` }
    }
  }

  if (toolName === 'computer_wait') {
    const until = args['until']
    const allowedUntil = ['present', 'gone', 'text', 'value', 'idle']
    if (typeof until !== 'string' || !allowedUntil.includes(until)) {
      return { allowed: false, code: 'invalid-wait', reason: `computer_wait until must be one of: ${allowedUntil.join(', ')}.` }
    }
    const extra = Object.keys(args).filter((key) =>
      !['app', 'until', 'element_index', 'text', 'value', 'timeout_ms', 'interval_ms'].includes(key),
    )
    if (extra.length > 0) {
      return { allowed: false, code: 'invalid-wait', reason: `computer_wait does not accept: ${extra.join(', ')}.` }
    }
    if (until !== 'idle' && typeof args['element_index'] !== 'string') {
      return { allowed: false, code: 'invalid-wait', reason: `until="${until}" needs the element_index of the element to watch.` }
    }
    if (until === 'text' && typeof args['text'] !== 'string') {
      return { allowed: false, code: 'invalid-wait', reason: 'until="text" needs the text to look for.' }
    }
    if (until === 'value' && typeof args['value'] !== 'string') {
      return { allowed: false, code: 'invalid-wait', reason: 'until="value" needs the value to compare against.' }
    }
    const timeout = args['timeout_ms']
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 100)) {
      return { allowed: false, code: 'invalid-wait', reason: 'timeout_ms must be a number of at least 100 milliseconds.' }
    }
    const interval = args['interval_ms']
    if (interval !== undefined && (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 50)) {
      return { allowed: false, code: 'invalid-wait', reason: 'interval_ms must be a number of at least 50 milliseconds.' }
    }
  }

  const app = typeof args['app'] === 'string' ? args['app'] : undefined
  if (app?.includes('@window:') && !/^.+@window:[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*$/.test(app)) {
    return { allowed: false, code: 'invalid-window-selector', reason: 'Invalid window selector. Copy the exact app selector from list_apps.' }
  }

  // Hard blocks apply in every mode, including `open`.
  if (toolName === 'press_key' && typeof args['key'] === 'string') {
    const key = normalizeKey(args['key'])
    const blocked = new Set([...ALWAYS_BLOCKED_KEYS, ...config.blockedKeys].map(normalizeKey))
    if (blocked.has(key)) {
      return {
        allowed: false,
        code: 'blocked-key',
        reason: `Refusing to press "${args['key']}": this key combination is hard-blocked because it can lock, log out of, or seize the machine.`,
      }
    }
  }

  const payload = toolName === 'type_text' ? args['text'] : toolName === 'set_value' ? args['value'] : undefined
  if (typeof payload === 'string') {
    for (const { pattern, reason } of BLOCKED_TEXT_PATTERNS) {
      if (pattern.test(payload)) {
        return {
          allowed: false,
          code: 'blocked-payload',
          reason: `Refusing to send this text: it looks like ${reason}.`,
        }
      }
    }
  }

  if (config.policyMode === 'audit' && tool.mutating) {
    return {
      allowed: false,
      code: 'audit-mode-read-only',
      reason: 'Policy mode is "audit": observing is allowed but every action that would change the machine is refused. Ask the user to switch modes to act.',
    }
  }

  if (config.policyMode === 'allowlist' && app !== undefined && !matchApp(app, config.allowedApps)) {
    return {
      allowed: false,
      code: 'app-not-allowed',
      reason: `App "${app}" is not in the allowlist (${config.allowedApps.join(', ') || 'empty'}). Ask the user to add it, or call computer_policy with allowedApps.`,
    }
  }

  return ALLOW
}

/** Preflight the complete, statically enumerable batch. No driver is involved. */
export function checkCuaSubset(code: unknown, config: FbcConfig): { decision: PolicyDecision; plan?: CuaPlan } {
  let plan: CuaPlan
  try {
    plan = parseCuaSubset(code)
  } catch (error) {
    return { decision: { allowed: false, code: 'invalid-cua-subset', reason: `${error instanceof Error ? error.message : String(error)}. Nothing in this batch ran.` } }
  }
  for (const [index, action] of plan.actions.entries()) {
    const decision = checkAction(action.tool, action.args, config)
    if (!decision.allowed) {
      return { decision: { ...decision, reason: `Action ${index + 1} (${action.tool}, statement ${action.statement}): ${decision.reason} Nothing in this batch ran.` } }
    }
  }
  return { decision: ALLOW, plan }
}

/**
 * Guard for agent-initiated policy changes.
 *
 * `audit` and `allowlist` exist to be a boundary the *human* set. If the agent
 * could call `computer_policy` to widen its own limits, neither mode would
 * mean anything — it could simply unlock itself and act. So an agent may only
 * change policy while the mode is already `open`; otherwise the user makes the
 * change out of band with `fbc policy`.
 */
export function checkPolicyMutation(
  args: Record<string, unknown>,
  config: FbcConfig,
): PolicyDecision {
  const wantsChange = args['policyMode'] !== undefined || args['allowedApps'] !== undefined
  if (!wantsChange) return ALLOW
  if (config.policyMode === 'open') return ALLOW
  return {
    allowed: false,
    code: 'audit-mode-read-only',
    reason:
      `Policy mode is "${config.policyMode}", so this server will not let an agent widen its own ` +
      'limits. Ask the user to change the policy themselves, for example ' +
      '`fbc policy --mode open`, or to add the app with `fbc policy --allow <app>`.',
  }
}

export function describePolicy(config: FbcConfig): Record<string, unknown> {
  return {
    policyMode: config.policyMode,
    allowedApps: config.allowedApps,
    blockedKeys: [...new Set([...ALWAYS_BLOCKED_KEYS, ...config.blockedKeys])],
    recordTrajectory: config.recordTrajectory,
    defaultMaxTreeNodes: config.defaultMaxTreeNodes,
    defaultMaxTreeDepth: config.defaultMaxTreeDepth,
    maxSnapshotBytes: config.maxSnapshotBytes,
    notes: [
      'list_apps, computer_doctor and computer_policy are never blocked: they do not name an app.',
      'In allowlist mode get_app_state is gated too, because reading an app is itself a privacy decision.',
      'In audit mode observation is allowed and every action that would change the machine is refused.',
      'Hard-blocked key combinations and shell payloads are refused in every mode, including "open".',
      'This server never types passwords: use the OS credential store or autofill instead.',
    ],
  }
}
