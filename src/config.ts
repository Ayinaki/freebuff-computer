import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Everything Freebuff Computer writes lives under one directory so a user can
 * inspect or delete it in one step. We never write into Freebuff's own state
 * (`~/.freebuff/mcp.json`), which is hash-verified by the Freebuff client and
 * would be corrupted by a hand-written entry.
 */
export const STATE_DIR = process.env.FBC_STATE_DIR ?? join(homedir(), '.freebuff-computer')

export type PolicyMode = 'open' | 'allowlist' | 'audit'

export interface FbcConfig {
  /**
   * `open`      — allow every action (default).
   * `allowlist` — only apps listed in `allowedApps` may be touched.
   * `audit`     — observe freely, refuse every mutating action.
   */
  policyMode: PolicyMode
  /** App names / pids permitted in `allowlist` mode (case-insensitive substring). */
  allowedApps: string[]
  /** Hard-blocked key combos, checked before any key can be sent. */
  blockedKeys: string[]
  /** Record every observation and action as JSONL under the state dir. */
  recordTrajectory: boolean
  /** Accessibility tree nodes requested by default — the main token lever. */
  defaultMaxTreeNodes: number
  /** Accessibility tree depth requested by default. */
  defaultMaxTreeDepth: number
  /** Hard byte cap on a single snapshot returned to the model. */
  maxSnapshotBytes: number
  /**
   * Seconds without a tool call before the visible session hides itself.
   *
   * An earlier design required the model to call `computer_session` end, and a
   * real session showed why that is not enough: 79 tool calls, zero session
   * calls, and a blue border left on both monitors. The border is a courtesy to
   * the person watching, so it must not depend on the model remembering.
   * `0` disables the idle end.
   */
  sessionIdleSeconds: number
  /** Seconds without a tool call before the overlay helper process is closed. `0` disables it. */
  sessionIdleCloseSeconds: number
  /** `auto` sends a screenshot only when the tree is thin or an action just failed to show an effect. */
  screenshotMode: 'auto' | 'always' | 'never'
  /** Longest edge of a screenshot, in pixels. Anthropic warns above WXGA because hosts resize. */
  screenshotMaxDimension: number
  /** Hard cap on one screenshot sent to the model; a larger capture is retried smaller. */
  maxScreenshotBytes: number
}

export const DEFAULT_CONFIG: FbcConfig = {
  policyMode: 'open',
  allowedApps: [],
  blockedKeys: [
    'ctrl+alt+delete',
    'cmd+ctrl+q',
    'ctrl+shift+escape',
    'cmd+shift+q',
    'cmd+ctrl+power',
    'win+l',
    'ctrl+alt+end',
  ],
  recordTrajectory: true,
  defaultMaxTreeNodes: 200,
  defaultMaxTreeDepth: 32,
  maxSnapshotBytes: 64 * 1024,
  sessionIdleSeconds: 120,
  sessionIdleCloseSeconds: 600,
  screenshotMode: 'auto',
  screenshotMaxDimension: 1280,
  maxScreenshotBytes: 1_500_000,
}

export function configPath(): string {
  return join(STATE_DIR, 'config.json')
}

/**
 * Read config, tolerating a missing or partially written file.
 *
 * `FBC_POLICY_MODE` and `FBC_ALLOWED_APPS` override the file, so a host can
 * pin a session to a locked-down policy without editing anything on disk.
 */
export function loadConfig(): FbcConfig {
  let config: FbcConfig = { ...DEFAULT_CONFIG }
  try {
    if (existsSync(configPath())) {
      const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<FbcConfig>
      config = { ...DEFAULT_CONFIG, ...raw }
    }
  } catch {
    config = { ...DEFAULT_CONFIG }
  }

  const envMode = process.env.FBC_POLICY_MODE
  if (envMode === 'open' || envMode === 'allowlist' || envMode === 'audit') {
    config.policyMode = envMode
  }
  const envApps = process.env.FBC_ALLOWED_APPS
  if (envApps !== undefined) {
    config.allowedApps = envApps
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
  }

  config.sessionIdleSeconds = envNumber('FBC_SESSION_IDLE_SECONDS', config.sessionIdleSeconds)
  config.sessionIdleCloseSeconds = envNumber('FBC_SESSION_IDLE_CLOSE_SECONDS', config.sessionIdleCloseSeconds)
  config.screenshotMaxDimension = envNumber('FBC_SCREENSHOT_MAX_DIMENSION', config.screenshotMaxDimension)
  const envScreenshot = process.env.FBC_SCREENSHOT_MODE
  if (envScreenshot === 'auto' || envScreenshot === 'always' || envScreenshot === 'never') {
    config.screenshotMode = envScreenshot
  }

  return config
}

/** A bad or negative number in the environment must not silently disable a safety net. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

export function saveConfig(config: FbcConfig): string {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return configPath()
}

/** The command used to start the computer-use driver, overridable for testing. */
export function driverCommand(): { command: string; args: string[] } {
  const override = process.env.FBC_DRIVER_CMD
  if (override) {
    const parts = override.split(' ').filter(Boolean)
    return { command: parts[0] ?? 'ocu', args: parts.slice(1) }
  }
  if (process.platform === 'win32') {
    return { command: fileURLToPath(new URL(`./native/win32-${process.arch}/open-computer-use.exe`, import.meta.url)), args: ['mcp'] }
  }
  return { command: 'ocu', args: ['mcp'] }
}

export function stateSubdir(name: string): string {
  const dir = join(STATE_DIR, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function platformLabel(): string {
  return platform()
}
