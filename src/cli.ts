#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { COMPUTER_TOOLS } from './contract.js'
import {
  DEFAULT_CONFIG,
  STATE_DIR,
  configPath,
  driverCommand,
  loadConfig,
  saveConfig,
} from './config.js'
import { formatBytes } from './compact.js'
import { ComputerDriver } from './driver.js'
import { describePolicy } from './policy.js'
import { buildDoctorReport, runStdioServer, SERVER_VERSION } from './server.js'
import { stateSubdir } from './config.js'

const HELP = `freebuff-computer ${SERVER_VERSION}

Computer Use for Freebuff agents — see and operate the computer the agent runs on.

Usage:
  fbc server            Start the stdio MCP server (this is what Freebuff runs)
  fbc doctor            Check the driver, the contract, and the active policy
  fbc setup             Write a default config and print the Freebuff wiring
  fbc stats             Summarise recorded trajectories and snapshot savings
  fbc policy [args]     Show or change the safety policy
  fbc help              Show this help
  fbc version           Print the version

Options for setup:
  --install-driver      Also run: npm install -g open-computer-use

Tools exposed to the agent (Codex-compatible surface):
  ${COMPUTER_TOOLS.map((t) => t.name).join(', ')}
  computer_doctor, computer_policy
`

function findOnPath(names: string[]): string | null {
  const pathValue = process.env.PATH ?? ''
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat', '.ps1'] : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      for (const ext of exts) {
        const candidate = join(dir, name + ext)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

async function cmdDoctor(): Promise<number> {
  const config = loadConfig()
  const driver = new ComputerDriver()
  console.log(`freebuff-computer ${SERVER_VERSION}`)
  console.log(`platform          ${process.platform} ${process.arch}`)
  console.log(`config            ${configPath()}`)

  const resolved = findOnPath(['ocu', 'open-computer-use'])
  console.log(`driver binary     ${resolved ?? 'NOT FOUND'}`)
  if (!resolved) {
    console.log('\nThe computer-use driver is not installed. Install it once with:')
    console.log('  npm install -g open-computer-use\n')
  }

  try {
    const report = await buildDoctorReport(driver, config)
    console.log(`status            ${report.status.toUpperCase()}`)
    if (report.driver.serverVersion) {
      console.log(`driver server     ${report.driver.serverName} ${report.driver.serverVersion}`)
    }
    if (report.contract) {
      console.log(
        `contract           ${report.contract.ok ? 'all 9 tools match' : 'MISMATCH'}` +
          (report.contract.extraTools.length > 0
            ? ` (driver also offers: ${report.contract.extraTools.join(', ')})`
            : ''),
      )
    }
    if (report.hints.length > 0) {
      console.log('\nnotes:')
      for (const hint of report.hints) console.log(`  - ${hint}`)
    }
    console.log('\npolicy:')
    console.log(JSON.stringify(describePolicy(config), null, 2))
    return report.status === 'failed' ? 1 : 0
  } catch (error) {
    console.log(`status            FAILED`)
    console.log(`  ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    await driver.close()
  }
}

function mcpSnippet(): string {
  const entry = { command: 'npx', args: ['-y', 'freebuff-computer', 'server'] }
  // Freebuff's mcp.json reader expects the standard MCP file format, keyed by
  // `mcpServers` -- the same shape it looks for at {cwd}/.agents/mcp.json. An
  // entry without that wrapper is rejected.
  return JSON.stringify({ mcpServers: { 'freebuff-computer': entry } }, null, 2)
}

function cmdSetup(argv: string[]): number {
  const installDriver = argv.includes('--install-driver')

  if (!existsSync(configPath())) {
    saveConfig(DEFAULT_CONFIG)
    console.log(`Wrote default config to ${configPath()}`)
  } else {
    console.log(`Config already present at ${configPath()} (left unchanged)`)
  }

  const resolved = findOnPath(['ocu', 'open-computer-use'])
  if (!resolved) {
    if (installDriver) {
      console.log('Installing the computer-use driver: npm install -g open-computer-use')
      const result = spawnSync('npm', ['install', '-g', 'open-computer-use'], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
      if (result.status !== 0) {
        console.error('Driver install failed. Run it yourself: npm install -g open-computer-use')
      }
    } else {
      console.log('\nThe computer-use driver is not installed yet. Run:')
      console.log('  npm install -g open-computer-use')
      console.log('or re-run:  fbc setup --install-driver\n')
    }
  } else {
    console.log(`Driver found at ${resolved}`)
  }

  console.log('\nAdd this to Freebuff as a local MCP server (Connectors -> add custom server):\n')
  console.log(mcpSnippet())
  console.log(
    '\nThe same block is what Freebuff reads from .agents/mcp.json in a workspace root, so you can\n' +
      'commit it there instead of registering by hand. Note that npx -y freebuff-computer only works\n' +
      'once the package is published; from a checkout, use "command": "node", "args": ["dist/cli.js", "server"].',
  )
  console.log(
    '\nNo arguments are needed on the server side; Freebuff launches it and speaks MCP over stdio.\n' +
      'Freebuff Computer does not write into ~/.freebuff/mcp.json itself: that file is hash-verified\n' +
      'by the Freebuff client and a hand-written entry would be rejected.',
  )
  console.log(`\nState directory: ${STATE_DIR}`)
  return 0
}

function cmdStats(): number {
  const dir = join(STATE_DIR, 'trajectories')
  if (!existsSync(dir)) {
    console.log('No trajectories recorded yet.')
    return 0
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  if (files.length === 0) {
    console.log('No trajectories recorded yet.')
    return 0
  }

  let original = 0
  let compacted = 0
  let snapshots = 0
  let calls = 0
  let refusals = 0

  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let entry: { kind?: string; tool?: string; result?: Record<string, unknown> }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.tool !== undefined) calls += 1
      if (entry.result?.['refused']) refusals += 1
      if (typeof entry.result?.['originalBytes'] === 'number') {
        snapshots += 1
        original += entry.result['originalBytes'] as number
        compacted += entry.result['compactedBytes'] as number
      }
    }
  }

  const saved = original - compacted
  const pct = original > 0 ? ((saved / original) * 100).toFixed(1) : '0.0'
  console.log(`sessions          ${files.length}`)
  console.log(`tool calls        ${calls}`)
  console.log(`refusals          ${refusals}`)
  console.log(`snapshots         ${snapshots}`)
  console.log(`snapshot bytes    ${formatBytes(original)} -> ${formatBytes(compacted)}`)
  console.log(`saved             ${formatBytes(saved)} (${pct}% reduction)`)
  return 0
}

function cmdPolicy(argv: string[]): number {
  const config = loadConfig()
  const modeIndex = argv.indexOf('--mode')
  const allowIndex = argv.indexOf('--allow')
  if (modeIndex >= 0) {
    const mode = argv[modeIndex + 1]
    if (mode !== 'open' && mode !== 'allowlist' && mode !== 'audit') {
      console.error('--mode must be one of: open, allowlist, audit')
      return 1
    }
    config.policyMode = mode
  }
  if (allowIndex >= 0) {
    config.allowedApps = argv
      .slice(allowIndex + 1)
      .filter((a) => !a.startsWith('--'))
      // Accept both `--allow A B` and `--allow A,B` / `--allow "A, B"`.
      .flatMap((a) => a.split(','))
      .map((a) => a.trim())
      .filter(Boolean)
  }
  if (modeIndex >= 0 || allowIndex >= 0) {
    saveConfig(config)
    console.log(`Updated ${configPath()}`)
  }
  console.log(JSON.stringify(describePolicy(config), null, 2))
  return 0
}

async function main(): Promise<void> {
  const [, , command = 'server', ...rest] = process.argv

  switch (command) {
    case 'server':
    case 'mcp':
      await runStdioServer()
      return
    case 'doctor': {
      process.exitCode = await cmdDoctor()
      return
    }
    case 'setup': {
      process.exitCode = cmdSetup(rest)
      return
    }
    case 'stats': {
      process.exitCode = cmdStats()
      return
    }
    case 'policy': {
      process.exitCode = cmdPolicy(rest)
      return
    }
    case 'help':
    case '--help':
    case '-h': {
      console.log(HELP)
      return
    }
    case 'version':
    case '--version':
    case '-v': {
      console.log(SERVER_VERSION)
      return
    }
    default: {
      console.error(`Unknown command: ${command}\n`)
      console.log(HELP)
      process.exitCode = 1
    }
  }
}

void main()
