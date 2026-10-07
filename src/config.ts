import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

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

  return config
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
