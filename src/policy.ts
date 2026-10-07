import { ALWAYS_BLOCKED_KEYS, BLOCKED_TEXT_PATTERNS, findTool } from './contract.js'
import type { FbcConfig } from './config.js'

export interface PolicyDecision {
  allowed: boolean
  /** Machine-readable reason code, useful in tests and trajectories. */
  code?:
    | 'blocked-key'
    | 'blocked-payload'
    | 'app-not-allowed'
    | 'audit-mode-read-only'
    | 'unknown-tool'
  reason?: string
}

const ALLOW: PolicyDecision = { allowed: true }

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/\s+/g, '').replace(/cmd|command|meta|super/g, 'cmd').replace(/control/g, 'ctrl').replace(/alt|option/g, 'alt')
}

function matchApp(app: string, allowed: string[]): boolean {
  const needle = app.toLowerCase()
  return allowed.some((entry) => {
    const candidate = entry.trim().toLowerCase()
    return candidate.length > 0 && needle.includes(candidate)
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

  const app = typeof args['app'] === 'string' ? args['app'] : undefined

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
