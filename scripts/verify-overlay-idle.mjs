// The border must disappear on its own once the agent stops calling tools.
// This drives a real server, a real overlay and a real screen, then checks the
// pixels rather than the status field alone.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const stateDir = mkdtempSync(join(tmpdir(), 'fbc-idle-verify-'))
process.env.FBC_STATE_DIR = stateDir
delete process.env.FBC_OVERLAY
// The probe itself takes a few seconds to compile and sample pixels, so the
// budget has to be long enough to observe the visible state first.
process.env.FBC_SESSION_IDLE_CLOSE_SECONDS = '600'
// Runs beside any live session instead of failing on its overlay mutex.
process.env.FBC_OVERLAY_MUTEX = `Local\\FbcIdleVerify-${process.pid}`

const { createServer } = await import('../dist/server.js')
const { DEFAULT_CONFIG } = await import('../dist/config.js')

const SNAPSHOT = [
  'App=IdleVerification (pid 4242)',
  'Window: "Idle verification", App: IdleVerification.',
  '\t0 window Idle verification Frame: {x: 0, y: 0, width: 800, height: 600}',
  '\t\t1 button Continue Frame: {x: 40, y: 40, width: 120, height: 32}',
].join('\n')

const driver = {
  async callTool() {
    return { isError: false, content: [{ type: 'text', text: SNAPSHOT }] }
  },
  async close() {},
  async supportsParam() {
    return false
  },
  async supportsTool() {
    return false
  },
}

const IDLE_SECONDS = 10
const bundle = createServer({ config: { ...DEFAULT_CONFIG, policyMode: 'open', sessionIdleSeconds: IDLE_SECONDS }, driver })
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: 'idle-verification', version: '1' })
await bundle.server.connect(serverSide)
await client.connect(clientSide)

const probe = async (windows) => {
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./probe-overlay.ps1', import.meta.url))],
    { windowsHide: true, timeout: 20000, env: { ...process.env, FBC_OVERLAY_VERIFICATION: JSON.stringify({ windows }) } },
  )
  return JSON.parse(stdout.trim())
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  await client.callTool({ name: 'get_app_state', arguments: { app: 'IdleVerification' } })
  await client.callTool({ name: 'click', arguments: { app: 'IdleVerification', element_index: '1' } })

  const status = bundle.overlay.status()
  assert.equal(status.state, 'running', `overlay did not start: ${JSON.stringify(status)}`)
  assert.equal(status.sessionActive, true)
  const windows = status.windows
  assert.ok(Array.isArray(windows) && windows.length > 0)

  const painted = await probe(windows)
  assert.ok(
    painted.windows.every((window) => window.visible),
    `the border must be on screen before the idle budget passes: ${JSON.stringify({ status: bundle.overlay.status(), probe: painted })}`,
  )

  await wait(IDLE_SECONDS * 1000 + 1500)

  const afterStatus = bundle.overlay.status()
  assert.equal(afterStatus.sessionActive, false, 'the idle timer must hide the visible session')
  assert.equal(afterStatus.lastEndReason, 'idle')

  const hidden = await probe(windows)
  assert.ok(
    hidden.windows.every((window) => !window.visible),
    `overlay windows are still visible: ${JSON.stringify(hidden.windows)}`,
  )

  const notes = readFileSync(bundle.recorder.path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === 'note' && /idle: visible session ended/.test(String(entry.result)))
  assert.equal(notes.length, 1, 'the idle end must be recorded, and recorded once')

  console.log(`PASS: ${windows.length} overlay windows hid themselves after the idle budget, with no session call from the agent`)
} finally {
  await client.close().catch(() => {})
  await bundle.server.close()
  await bundle.close()
}

