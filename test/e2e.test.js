import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'dist', 'cli.js')

/** The nine tool names Codex exposes, which this server must reproduce exactly. */
const CODEX_TOOLS = [
  'list_apps',
  'get_app_state',
  'click',
  'set_value',
  'type_text',
  'press_key',
  'scroll',
  'drag',
  'perform_secondary_action',
]

function driverOnPath() {
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of ['ocu', 'open-computer-use']) {
      for (const ext of exts) {
        if (existsSync(join(dir, name + ext))) return true
      }
    }
  }
  return false
}

const HAS_DRIVER = driverOnPath()

/**
 * Minimal MCP client over stdio. Deliberately hand-rolled rather than using the
 * SDK, so these tests exercise the wire protocol the way a host application
 * would and cannot hide a framing bug behind a shared library.
 */
function startServer(env = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'fbc-test-'))
  const child = spawn(process.execPath, [CLI, 'server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FBC_STATE_DIR: stateDir, ...env },
  })

  let buffer = ''
  let stderr = ''
  let exited = null
  const pending = new Map()
  let id = 0

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = message.id !== undefined ? pending.get(message.id) : undefined
      if (waiter && message.id !== undefined) {
        pending.delete(message.id)
        clearTimeout(waiter.timer)
        waiter.resolve(message)
      }
    }
  })

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  // Settle pending requests as soon as the server dies, instead of making every
  // caller wait out its own timeout and burying the real error.
  child.on('exit', (code) => {
    exited = code
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`server exited with code ${code}; stderr=${stderr}`))
    }
    pending.clear()
  })

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      if (exited !== null) {
        reject(new Error(`server already exited with code ${exited}; stderr=${stderr}`))
        return
      }
      const mid = ++id
      const timer = setTimeout(() => {
        pending.delete(mid)
        reject(new Error(`timed out waiting for ${method}; stderr=${stderr}`))
      }, 60_000)
      pending.set(mid, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })}\n`)
    })

  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)

  const close = () =>
    new Promise((resolve) => {
      if (exited !== null) {
        resolve()
        return
      }
      const fallback = setTimeout(() => {
        child.kill()
        resolve()
      }, 5000)
      child.once('exit', () => {
        clearTimeout(fallback)
        resolve()
      })
      child.stdin.end()
    })

  return {
    stateDir,
    child,
    request,
    notify,
    close,
    stderr: () => stderr,
    initialize: async () => {
      const response = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fbc-e2e', version: '1.0.0' },
      })
      notify('notifications/initialized', {})
      return response.result
    },
    callTool: (name, args = {}) => request('tools/call', { name, arguments: args }),
  }
}

test('initializes and advertises the Codex-compatible tool surface', async () => {
  const server = startServer()
  try {
    const init = await server.initialize()

    assert.equal(init.serverInfo.name, 'freebuff-computer')
    assert.ok(
      typeof init.instructions === 'string' && init.instructions.length > 200,
      'must ship usage instructions for the model',
    )

    const listed = (await server.request('tools/list', {})).result.tools
    const names = listed.map((t) => t.name)

    for (const name of CODEX_TOOLS) {
      assert.ok(names.includes(name), `missing Codex tool: ${name}`)
    }
    assert.ok(names.includes('computer_doctor'))
    assert.ok(names.includes('computer_policy'))
    assert.equal(names.length, 11)

    for (const tool of listed) {
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description`)
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} needs a JSON Schema object`)
    }

    const getAppState = listed.find((t) => t.name === 'get_app_state')
    assert.equal(getAppState.inputSchema.required[0], 'app')
    assert.ok('max_tree_nodes' in getAppState.inputSchema.properties)
    assert.ok(
      getAppState.inputSchema.properties.max_tree_nodes.description.includes('200'),
      'the tuned default must be documented in the schema the model actually reads',
    )
  } finally {
    await server.close()
  }
})

test('computer_policy reads the active policy without touching the driver', async () => {
  const server = startServer()
  try {
    await server.initialize()
    const result = await server.callTool('computer_policy')
    assert.notEqual(result.result.isError, true, server.stderr())
    const policy = JSON.parse(result.result.content[0].text)
    assert.equal(policy.policyMode, 'open')
    assert.ok(policy.blockedKeys.includes('ctrl+alt+delete'))
  } finally {
    await server.close()
  }
})

test('refuses a hard-blocked key combination with a policy error', async () => {
  const server = startServer()
  try {
    await server.initialize()
    const result = await server.callTool('press_key', { app: 'Notepad', key: 'ctrl+alt+delete' })
    assert.equal(result.result.isError, true)
    assert.match(result.result.content[0].text, /hard-blocked/)
    assert.match(result.result.content[0].text, /refused by Freebuff Computer policy: blocked-key/)
  } finally {
    await server.close()
  }
})

test('audit mode refuses actions and will not let the agent unlock itself', async () => {
  const server = startServer({ FBC_POLICY_MODE: 'audit' })
  try {
    await server.initialize()

    const read = await server.callTool('computer_policy')
    assert.equal(JSON.parse(read.result.content[0].text).policyMode, 'audit')

    const click = await server.callTool('click', { app: 'Notepad', element_index: '1' })
    assert.equal(click.result.isError, true)
    assert.match(click.result.content[0].text, /refused by Freebuff Computer policy: audit-mode-read-only/)

    // A restrictive mode is a boundary the human set, so the agent must not be
    // able to widen it.
    const widen = await server.callTool('computer_policy', { policyMode: 'open' })
    assert.equal(widen.result.isError, true)
    assert.match(widen.result.content[0].text, /will not let an agent widen its own limits/)
  } finally {
    await server.close()
  }
})

test('allowlist mode refuses apps the user did not permit', async () => {
  const server = startServer({ FBC_POLICY_MODE: 'allowlist', FBC_ALLOWED_APPS: 'Spotify, Notepad' })
  try {
    await server.initialize()

    const blocked = await server.callTool('get_app_state', { app: 'Calculator' })
    assert.equal(blocked.result.isError, true)
    assert.match(blocked.result.content[0].text, /not in the allowlist/)

    // A permitted app gets past policy. Whether the driver can read it depends
    // on the platform and the app, so only assert that policy did not refuse it.
    const permitted = await server.callTool('get_app_state', { app: 'Spotify' })
    assert.doesNotMatch(permitted.result.content[0].text, /not in the allowlist/)
  } finally {
    await server.close()
  }
})

test('reports a missing driver as a diagnosis instead of crashing', async () => {
  const server = startServer({ FBC_DRIVER_CMD: 'definitely-not-a-real-driver-binary mcp' })
  try {
    await server.initialize()

    const doctor = await server.callTool('computer_doctor')
    const report = JSON.parse(doctor.result.content[0].text)
    assert.equal(report.status, 'failed')
    assert.ok(
      report.hints.some((h) => h.includes('npm install -g open-computer-use')),
      `expected an install hint, got ${JSON.stringify(report.hints)}`,
    )

    const call = await server.callTool('list_apps')
    assert.equal(call.result.isError, true)
    assert.match(call.result.content[0].text, /computer_doctor/)
  } finally {
    await server.close()
  }
})

test(
  'drives the real driver: list_apps, contract check, compaction and trajectory',
  { skip: HAS_DRIVER ? false : 'computer-use driver not installed' },
  async () => {
    const server = startServer()
    try {
      await server.initialize()

      const doctor = await server.callTool('computer_doctor')
      const report = JSON.parse(doctor.result.content[0].text)
      assert.notEqual(report.status, 'failed', JSON.stringify(report.hints))
      assert.equal(
        report.contract.ok,
        true,
        `the installed driver drifted from the contract: ${JSON.stringify(report.contract)}`,
      )

      const listed = await server.callTool('list_apps')
      assert.equal(listed.result.isError, false, `list_apps failed: ${listed.result.content[0].text}`)
      const text = listed.result.content[0].text
      assert.ok(text.length > 0, 'list_apps must return something')

      const app = /^([^\s]+)\s/m.exec(text)?.[1]
      assert.ok(app, `could not read an app name from list_apps output: ${text.slice(0, 200)}`)

      const snapshot = await server.callTool('get_app_state', { app })
      assert.ok(Array.isArray(snapshot.result.content))
      assert.ok(snapshot.result.content[0].text.length > 0)

      const files = readdirSync(join(server.stateDir, 'trajectories'))
      assert.equal(files.length, 1, 'a trajectory file must be written')
      const entries = readFileSync(join(server.stateDir, 'trajectories', files[0]), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))

      const toolCalls = entries.filter((e) => e.kind === 'tool_call').map((e) => e.tool)
      assert.ok(toolCalls.includes('list_apps'))
      assert.ok(toolCalls.includes('get_app_state'))

      const recorded = entries.find(
        (e) => e.tool === 'get_app_state' && e.result?.originalBytes !== undefined,
      )
      assert.ok(recorded, 'the snapshot must be recorded with its byte accounting')
      assert.ok(recorded.result.originalBytes > 0)
      assert.ok(recorded.result.compactedBytes <= recorded.result.originalBytes)
    } finally {
      await server.close()
    }
  },
)
