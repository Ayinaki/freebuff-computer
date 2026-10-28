import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const stateDir = mkdtempSync(join(tmpdir(), 'fbc-wait-test-'))
process.env.FBC_STATE_DIR = stateDir
process.env.FBC_OVERLAY = '0'
const { createServer } = await import('../dist/server.js')
const { DEFAULT_CONFIG } = await import('../dist/config.js')

/**
 * Waiting used to be a model writing the same read over and over, paying for a
 * snapshot each time. It is a server-side poll now, so these tests care about
 * three things: the condition, the budget, and how much is returned.
 */

function snapshot(label) {
  return [
    'App=Notepad (pid 4242)',
    'Window: "Untitled - Notepad", App: Notepad.',
    '\t0 window Untitled - Notepad Frame: {x: 0, y: 0, width: 900, height: 600}',
    `\t\t1 edit Search Value: ${JSON.stringify(label)} Frame: {x: 10, y: 40, width: 400, height: 24}`,
    '\t\t2 button Submit Frame: {x: 420, y: 40, width: 60, height: 24}',
    ...Array.from({ length: 8 }, (_, index) => `\t\t${index + 3} text Row ${index} Frame: {x: 0, y: ${80 + index * 10}, width: 200, height: 9}`),
  ].join('\n')
}

const text = (value) => ({ isError: false, content: [{ type: 'text', text: value }] })

function harness(t, driver, config = {}) {
  const bundle = createServer({
    config: { ...DEFAULT_CONFIG, policyMode: 'open', sessionIdleSeconds: 0, ...config },
    driver,
    overlay: { async send() {}, status: () => ({ state: 'disabled', sessionActive: false }), async close() {} },
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'wait-tests', version: '1' })
  t.after(async () => {
    await client.close().catch(() => {})
    await bundle.server.close()
    await bundle.close()
  })
  const ready = bundle.server.connect(serverSide).then(() => client.connect(clientSide))
  return {
    bundle,
    call: async (name, args = {}) => {
      await ready
      return client.callTool({ name, arguments: args })
    },
  }
}

const trajectory = (bundle) =>
  readFileSync(bundle.recorder.path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))

function pollingDriver(labels, extra = {}) {
  const calls = []
  let index = 0
  return {
    calls,
    async supportsParam() {
      return true
    },
    async supportsTool(name) {
      return name === 'screenshot'
    },
    async callTool(name, args) {
      calls.push({ name, args })
      if (name !== 'get_app_state') return text('ok')
      const label = labels[Math.min(index++, labels.length - 1)]
      return { ...text(snapshot(label)), ...extra }
    },
    async close() {},
  }
}

test('waiting for text polls until the element says it, then returns once', async (t) => {
  const driver = pollingDriver(['Loading', 'Loading', 'Ready 3 results'])
  const server = harness(t, driver)

  const result = await server.call('computer_wait', {
    app: 'Notepad', until: 'text', element_index: '1', text: 'Ready', interval_ms: 50, timeout_ms: 2000,
  })

  assert.equal(result.isError, false)
  const line = result.content[0].text
  assert.match(line, /^\[verification: changed\]/)
  assert.match(line, /now contains "Ready"/)
  assert.equal(driver.calls.length, 3, 'it stops as soon as the condition holds')
  assert.equal(driver.calls[0].args.include_screenshot, false, 'a wait must not pay for an image on every poll')
  assert.equal(driver.calls[0].args.max_tree_nodes, DEFAULT_CONFIG.defaultMaxTreeNodes)
})

test('waiting for a value compares against the element it was given', async (t) => {
  const driver = pollingDriver(['typed text'])
  const server = harness(t, driver)
  const hit = await server.call('computer_wait', { app: 'Notepad', until: 'value', element_index: '1', value: 'typed', interval_ms: 50 })
  assert.match(hit.content[0].text, /^\[verification: changed\]/)

  const miss = await server.call('computer_wait', {
    app: 'Notepad', until: 'value', element_index: '1', value: 'something else', interval_ms: 50, timeout_ms: 120,
  })
  assert.match(miss.content[0].text, /^\[verification: unchanged\]/)
})

test('a condition that never holds reports the budget it spent, not a success', async (t) => {
  const driver = pollingDriver(['Still loading'])
  const server = harness(t, driver, {})

  const result = await server.call('computer_wait', {
    app: 'Notepad', until: 'gone', element_index: '1', interval_ms: 50, timeout_ms: 150,
  })

  const line = result.content[0].text
  assert.match(line, /^\[verification: unchanged\]/)
  assert.match(line, /did not hold within 150ms/)
  assert.match(line, /stale/)

  const records = trajectory(server.bundle).filter((entry) => entry.tool === 'computer_wait' && entry.kind === 'tool_result')
  assert.equal(records.length, 1, 'the trajectory gets one entry, not one per poll')
  assert.ok(records[0].result.polls >= 2)
})

test('idle waits for the tree to stop changing', async (t) => {
  const driver = pollingDriver(['Stable'])
  const server = harness(t, driver)
  const result = await server.call('computer_wait', { app: 'Notepad', until: 'idle', interval_ms: 50, timeout_ms: 1000 })
  assert.match(result.content[0].text, /^\[verification: changed\]/)
  assert.match(result.content[0].text, /stopped changing/)
})

test('wait rejects a condition it cannot check instead of returning a false positive', async (t) => {
  const server = harness(t, pollingDriver(['x']))
  const noElement = await server.call('computer_wait', { app: 'Notepad', until: 'present' })
  assert.equal(noElement.isError, true)
  assert.match(noElement.content[0].text, /element_index/)

  const noText = await server.call('computer_wait', { app: 'Notepad', until: 'text', element_index: '1' })
  assert.equal(noText.isError, true)
  assert.match(noText.content[0].text, /text/)

  const badUntil = await server.call('computer_wait', { app: 'Notepad', until: 'eventually', element_index: '1' })
  assert.equal(badUntil.isError, true)
})

test('a wait that cannot read the window fails instead of waiting out its budget', async (t) => {
  const driver = {
    async supportsParam() { return false },
    async supportsTool() { return false },
    async callTool() { throw new Error('driver died') },
    async close() {},
  }
  const server = harness(t, driver)
  const result = await server.call('computer_wait', { app: 'Notepad', until: 'idle', interval_ms: 50, timeout_ms: 500 })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /could not read/)
})
