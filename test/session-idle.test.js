import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const stateDir = mkdtempSync(join(tmpdir(), 'fbc-idle-test-'))
process.env.FBC_STATE_DIR = stateDir
process.env.FBC_OVERLAY = '0'
const { createServer } = await import('../dist/server.js')
const { DEFAULT_CONFIG } = await import('../dist/config.js')

/**
 * The border is a claim that an agent is driving the machine. A real session
 * showed the cost of making that claim depend on the model: 79 tool calls,
 * zero `computer_session` calls, and a border left on two monitors after the
 * user had moved on. These tests pin the behaviour that replaces it.
 */

const SNAPSHOT = [
  'App=Notepad (pid 4242)',
  'Window: "Untitled - Notepad", App: Notepad.',
  '\t0 window Untitled - Notepad Frame: {x: 0, y: 0, width: 900, height: 600}',
  ...Array.from({ length: 12 }, (_, index) => `\t\t${index + 1} button Control ${index} Frame: {x: 10, y: ${20 + index * 20}, width: 100, height: 18}`),
].join('\n')

const text = (value) => ({ isError: false, content: [{ type: 'text', text: value }] })

function fakeOverlay() {
  const state = { sessionActive: false, ends: [], closed: 0 }
  return {
    state,
    async send(event) {
      // Only a computer_session end closes the visible session. An action's own
      // 'end' phase means the call finished.
      if (event.phase === 'end' && event.tool === 'computer_session') {
        state.sessionActive = false
        state.ends.push(event.label)
      } else if (event.phase !== 'error') {
        state.sessionActive = true
      }
    },
    status: () => ({ state: state.sessionActive ? 'running' : 'idle', sessionActive: state.sessionActive }),
    async close() {},
    async endSession(reason) {
      if (!state.sessionActive) return false
      state.sessionActive = false
      state.ends.push(reason === 'idle' ? 'Session idle' : 'Session ended')
      return true
    },
    async closeHelper() {
      state.closed += 1
      state.sessionActive = false
    },
  }
}

function harness(t, config, driverDelayMs = 0) {
  const calls = []
  const driver = {
    async callTool(name, args) {
      calls.push({ name, args })
      if (driverDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, driverDelayMs))
      return text(SNAPSHOT)
    },
    async close() {},
  }
  const overlay = fakeOverlay()
  const bundle = createServer({
    config: { ...DEFAULT_CONFIG, policyMode: 'open', ...config },
    driver,
    overlay,
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'idle-tests', version: '1' })
  const ready = bundle.server.connect(serverSide).then(() => client.connect(clientSide))
  t.after(async () => {
    await ready.catch(() => {})
    await client.close().catch(() => {})
    await bundle.server.close()
    await bundle.close()
  })
  return { calls, overlay, bundle, ready, call: async (name, args = {}) => { await ready; return client.callTool({ name, arguments: args }) } }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const trajectory = (bundle) =>
  readFileSync(bundle.recorder.path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))

test('an idle session hides itself and the next call says so exactly once', async (t) => {
  const server = harness(t, { sessionIdleSeconds: 0.05, sessionIdleCloseSeconds: 0 })

  await server.call('get_app_state', { app: 'Notepad', screenshot: 'never' })
  assert.equal(server.overlay.state.sessionActive, true, 'an approved desktop call starts a session')

  await wait(120)
  assert.deepEqual(server.overlay.state.ends, ['Session idle'])
  assert.equal(server.overlay.state.sessionActive, false)
  assert.ok(
    trajectory(server.bundle).some((entry) => entry.kind === 'note' && /idle: visible session ended/.test(String(entry.result))),
    'the idle end must be visible in the trajectory, where fbc stats can count it',
  )

  // The next call carries the explanation, and only that one.
  const next = await server.call('computer_policy')
  const note = next.content.find((block) => /without a tool call/.test(block.text ?? ''))
  assert.ok(note, `expected an idle note, got ${JSON.stringify(next.content.map((b) => b.text))}`)
  assert.match(note.text, /started a new one/)
  assert.match(note.text, /do not tell the user/i)

  const after = await server.call('computer_policy')
  assert.equal(
    after.content.some((block) => /without a tool call/.test(block.text ?? '')),
    false,
    'the note must not repeat on every later call',
  )
})

test('the idle timer never fires in the middle of a call', async (t) => {
  // 150 ms of driver work against a 50 ms idle budget.
  const server = harness(t, { sessionIdleSeconds: 0.05, sessionIdleCloseSeconds: 0 }, 150)

  const result = await server.call('get_app_state', { app: 'Notepad', screenshot: 'never' })
  assert.notEqual(result.isError, true)
  assert.deepEqual(server.overlay.state.ends, [], 'the border must not vanish while the agent is still acting')
  assert.equal(server.overlay.state.sessionActive, true)
})

test('a session that ends on its own does not close the helper immediately', async (t) => {
  const server = harness(t, { sessionIdleSeconds: 0.05, sessionIdleCloseSeconds: 1 })
  await server.call('get_app_state', { app: 'Notepad', screenshot: 'never' })
  await wait(120)
  assert.equal(server.overlay.state.sessionActive, false)
  assert.equal(server.overlay.state.closed, 0, 'hiding the border is not a reason to pay to restart the helper')
})

test('the helper is closed after the longer idle budget, and only then', async (t) => {
  const server = harness(t, { sessionIdleSeconds: 0.03, sessionIdleCloseSeconds: 0.08 })
  await server.call('get_app_state', { app: 'Notepad', screenshot: 'never' })
  await wait(200)
  assert.ok(server.overlay.state.closed >= 1, 'a helper nobody is using should not hold a process for hours')
})

test('an explicit end is not counted as an idle end, and status reports the budget', async (t) => {
  const server = harness(t, { sessionIdleSeconds: 120, sessionIdleCloseSeconds: 600 })
  await server.call('computer_session', { action: 'begin' })
  await server.call('computer_session', { action: 'end' })

  // A status read appends a plain-language note after the JSON.
  const rawStatus = (await server.call('computer_session', { action: 'status' })).content[0].text
  const status = JSON.parse(rawStatus.slice(0, rawStatus.indexOf('\n\n') === -1 ? undefined : rawStatus.indexOf('\n\n')))
  assert.equal(status.sessionActive, false)
  assert.equal(status.idleTimeoutSeconds, 120)
  assert.equal(status.autoEndedSessions, 0)
  assert.equal(typeof status.lastActivitySecondsAgo, 'number')
})
