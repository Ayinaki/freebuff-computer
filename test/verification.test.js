import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const stateDir = mkdtempSync(join(tmpdir(), 'fbc-verify-test-'))
process.env.FBC_STATE_DIR = stateDir
process.env.FBC_OVERLAY = '0'
const { createServer } = await import('../dist/server.js')
const { DEFAULT_CONFIG } = await import('../dist/config.js')
const { classifyChange, nodeIdentity, parseVerification, snapshotFingerprint, snapshotNodeLines, readBackValue } =
  await import('../dist/overlay.js')

/**
 * These tests exist because the driver reports success when a dispatch did not
 * throw, which is not the same as the app having done anything. The wrapper has
 * to supply the difference, and every claim here is about evidence: a no-op
 * must never come back looking like a completed action.
 */

/** A snapshot in the shape the bundled Windows driver renders. */
function snapshot(nodes) {
  return [
    'App=Notepad (pid 4242)',
    'Window: "Untitled - Notepad", App: Notepad.',
    '\t0 window Untitled - Notepad Frame: {x: 0, y: 0, width: 900, height: 600}',
    ...nodes.map((line, index) => `\t\t${index + 1} ${line}`),
  ].join('\n')
}

const BEFORE = snapshot([
  'edit Address and search bar Value: old text Frame: {x: 10, y: 40, width: 400, height: 24}',
  'button Submit Frame: {x: 420, y: 40, width: 60, height: 24}',
])

/** The same tree with one node changed. */
const AFTER = snapshot([
  'edit Address and search bar Value: new text Frame: {x: 10, y: 40, width: 400, height: 24}',
  'button Submit Frame: {x: 420, y: 40, width: 60, height: 24}',
])

/** A tree that changed only past the first node, for the bounded comparison. */
const DEEP = snapshot([
  'edit Address and search bar Value: old text Frame: {x: 10, y: 40, width: 400, height: 24}',
  'button Submit Frame: {x: 420, y: 40, width: 60, height: 24}',
  'text A new panel appeared Frame: {x: 0, y: 80, width: 900, height: 400}',
])

const text = (value) => ({ isError: false, content: [{ type: 'text', text: value }] })

async function harness(t, response, overlay) {
  const calls = []
  const driver = {
    async callTool(name, args) {
      calls.push({ name, args })
      return response(name, args, calls)
    },
    async close() {},
  }
  const bundle = createServer({ config: { ...DEFAULT_CONFIG, policyMode: 'open' }, driver, overlay })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'verification-tests', version: '1' })
  await bundle.server.connect(serverSide)
  await client.connect(clientSide)
  t.after(async () => {
    await client.close()
    await bundle.server.close()
    await bundle.close()
  })
  const call = (name, args) => client.callTool({ name, arguments: args })
  return {
    calls,
    bundle,
    client,
    call,
    /** Read the window first, so the action has a baseline to be verified against. */
    observe: () => call('get_app_state', { app: 'Notepad' }),
    lastText: (result) => result.content.filter((block) => block.type === 'text').at(-1).text,
  }
}

const trajectory = (bundle) =>
  readFileSync(bundle.recorder.path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

test('an action the app ignored is reported as no observable change, not as success', async (t) => {
  const server = await harness(t, (name) => text(name === 'get_app_state' ? BEFORE : BEFORE))
  await server.observe()

  const result = await server.call('press_key', { app: 'Notepad', key: 'ctrl+t' })
  assert.notEqual(result.isError, true)

  const line = server.lastText(result)
  assert.match(line, /^\[verification: unchanged\]/)
  assert.match(line, /may have ignored the input/)
  assert.equal(parseVerification(line), 'unchanged')

  // The driver samples 120 ms after dispatch, so one re-read is allowed to
  // rescue a slow repaint, and only one.
  assert.deepEqual(server.calls.map((entry) => entry.name), ['get_app_state', 'press_key', 'get_app_state'])
  assert.deepEqual(server.calls[2].args, { app: 'Notepad' })
  assert.ok(
    trajectory(server.bundle).some((entry) => entry.kind === 'note' && /verification re-read .* unchanged/.test(String(entry.result))),
    'the extra read must be visible in the trajectory, where fbc stats can count it',
  )
})

test('a changed tree is reported as changed, without spending an extra read', async (t) => {
  const server = await harness(t, (name) => text(name === 'get_app_state' ? BEFORE : AFTER))
  await server.observe()

  const result = await server.call('click', { app: 'Notepad', element_index: '1' })
  assert.match(server.lastText(result), /^\[verification: changed\]/)
  assert.deepEqual(server.calls.map((entry) => entry.name), ['get_app_state', 'click'])
})

test('a value that reads back as requested is confirmed', async (t) => {
  const server = await harness(t, (name) => text(name === 'get_app_state' ? BEFORE : AFTER))
  await server.observe()

  const result = await server.call('set_value', { app: 'Notepad', element_index: '1', value: 'new text' })
  assert.match(server.lastText(result), /^\[verification: confirmed\]/)
  assert.match(server.lastText(result), /reads back the requested value/)
})

test('a value the control clamped is reported as differing, never as success', async (t) => {
  const clamped = snapshot([
    'edit Address and search bar Value: new Frame: {x: 10, y: 40, width: 400, height: 24}',
    'button Submit Frame: {x: 420, y: 40, width: 60, height: 24}',
  ])
  const server = await harness(t, (name) => text(name === 'get_app_state' ? BEFORE : clamped))
  await server.observe()

  const result = await server.call('set_value', { app: 'Notepad', element_index: '1', value: 'new text' })
  const line = server.lastText(result)
  assert.match(line, /^\[verification: differs\]/)
  assert.match(line, /requested "new text", but the element now reads "new"/)
  assert.match(line, /clamped or rejected/)
})

test('an action with nothing to compare against is reported as unverified', async (t) => {
  const server = await harness(t, (name) => text(name === 'get_app_state' ? BEFORE : 'ok'))

  // No prior read of this window, so there is no baseline and no honest claim.
  const result = await server.call('press_key', { app: 'Notepad', key: 'Return' })
  const line = server.lastText(result)
  assert.match(line, /^\[verification: unverified\]/)
  assert.match(line, /no earlier snapshot of that window/)
  assert.deepEqual(server.calls.map((entry) => entry.name), ['press_key'], 'an unverified action must not spend a re-read')
})

test('a different window is never compared against another app snapshot', async (t) => {
  const server = await harness(t, (name) => text(name === 'get_app_state' ? BEFORE : AFTER))
  await server.observe()

  const result = await server.call('click', { app: 'Other', element_index: '1' })
  assert.match(server.lastText(result), /^\[verification: unverified\]/)
})

test('a driver failure still states that nothing was confirmed', async (t) => {
  const server = await harness(t, (name) => {
    if (name === 'get_app_state') return text(BEFORE)
    throw new Error('driver died')
  })
  await server.observe()

  const result = await server.call('click', { app: 'Notepad', element_index: '1' })
  assert.equal(result.isError, true)
  assert.ok(
    server.lastText(result).includes('[verification: unverified] the driver call failed, so this action was not confirmed.'),
    'a failed dispatch must not leave the model guessing whether anything happened',
  )
})

test('refusals carry no verification line, because nothing was dispatched', async (t) => {
  const server = await harness(t, () => text(BEFORE))
  const result = await server.call('press_key', { app: 'Notepad', key: 'ctrl+alt+delete' })
  assert.equal(result.isError, true)
  assert.equal(parseVerification(result.content[0].text), undefined)
  assert.deepEqual(server.calls, [], 'a refused action must not reach the driver at all')
})

test('computer_policy persists an announced change and names the file it wrote', async (t) => {
  const server = await harness(t, () => text(BEFORE))
  const result = await server.call('computer_policy', { policyMode: 'allowlist', allowedApps: ['Notepad'] })
  const response = JSON.parse(result.content[0].text)

  assert.equal(response.policyMode, 'allowlist')
  assert.equal(response.persisted, true)
  assert.equal(response.configPath, join(stateDir, 'config.json'))
  assert.ok(existsSync(response.configPath))
  const saved = JSON.parse(readFileSync(response.configPath, 'utf8'))
  assert.equal(saved.policyMode, 'allowlist', 'a mode a restart forgets is a false promise')
  assert.deepEqual(saved.allowedApps, ['Notepad'])
})

test('reading the policy never writes the config file', async (t) => {
  const server = await harness(t, () => text(BEFORE))
  const changed = JSON.parse((await server.call('computer_policy', { policyMode: 'audit' })).content[0].text)
  const written = readFileSync(changed.configPath, 'utf8')

  const read = JSON.parse((await server.call('computer_policy')).content[0].text)
  assert.equal(read.policyMode, 'audit', 'a read reports what is actually in force')
  assert.equal('persisted' in read, false)
  assert.equal(readFileSync(read.configPath, 'utf8'), written, 'a read must not rewrite the file')
})

test('a session that cannot paint says so instead of implying something is visible', async (t) => {
  const overlay = { async send() {}, status: () => ({ state: 'unsupported' }), async close() {} }
  const server = await harness(t, () => text(BEFORE), overlay)

  const result = await server.call('computer_session', { action: 'begin' })
  assert.notEqual(result.isError, true, 'no overlay is not an error, but it is not a visible session either')
  // Hosts and scripts parse this result, so the explanation travels inside the
  // payload instead of trailing it.
  const payload = JSON.parse(result.content[0].text)
  assert.equal(payload.state, 'unsupported')
  assert.match(payload.note, /no visible indication/)
  assert.match(payload.note, /Do not tell the user to watch the screen/)

  const disabled = { async send() {}, status: () => ({ state: 'disabled' }), async close() {} }
  const offline = await harness(t, () => text(BEFORE), disabled)
  const offResult = await offline.call('computer_session', { action: 'status' })
  assert.match(JSON.parse(offResult.content[0].text).note, /FBC_OVERLAY=0/)
})

test('the exact fifteen-tool surface is unchanged by verification', async (t) => {
  const server = await harness(t, () => text(BEFORE))
  const listed = (await server.client.listTools()).tools
  assert.equal(listed.length, 15)
  for (const name of ['click', 'set_value', 'press_key', 'scroll', 'drag', 'exec_cua_subset']) {
    const tool = listed.find((entry) => entry.name === name)
    assert.match(tool.description, /verification/, `${name} must tell the model how its result is verified`)
  }
})

test('fingerprints are bounded, order-sensitive and comparable across tree limits', () => {
  assert.equal(snapshotFingerprint(BEFORE), snapshotFingerprint(BEFORE))
  assert.notEqual(snapshotFingerprint(BEFORE), snapshotFingerprint(AFTER))
  assert.equal(snapshotNodeLines(BEFORE).length, 3)
  assert.equal(nodeIdentity('\t\t7 edit Address and search bar Value: old text Frame: {x: 1}'), 'edit Address and search bar')

  // A change past the model's cut-off is invisible at that limit and detected
  // without one, which is exactly why the comparison is bounded on both sides.
  assert.equal(snapshotFingerprint(BEFORE, 2), snapshotFingerprint(DEEP, 2))
  assert.notEqual(snapshotFingerprint(BEFORE), snapshotFingerprint(DEEP))
})

test('change classification refuses to guess without a baseline', () => {
  const before = { nodes: 3, fingerprint: snapshotFingerprint(BEFORE), lineFor: () => undefined }
  assert.deepEqual(classifyChange(before, BEFORE), { state: 'unchanged', nodes: 3 })
  assert.deepEqual(classifyChange(before, AFTER), { state: 'changed', nodes: 3 })
  assert.equal(classifyChange(before, undefined).state, 'unverified')
  assert.equal(classifyChange(undefined, BEFORE).state, 'unverified')
  assert.match(classifyChange(undefined, BEFORE).reason, /no earlier snapshot/)
  assert.equal(classifyChange({ nodes: 0, fingerprint: '', lineFor: () => undefined }, BEFORE).state, 'unverified')
})

test('value readback reports ambiguity rather than inventing a result', () => {
  const line = snapshotNodeLines(BEFORE)[1]
  assert.deepEqual(readBackValue(line, AFTER, 'new text'), { state: 'confirmed' })
  assert.deepEqual(readBackValue(line, AFTER, 'something else'), { state: 'differs', observed: 'new text' })
  assert.equal(readBackValue(undefined, AFTER, 'new text').state, 'unreadable')
  assert.equal(readBackValue(line, snapshot(['button Submit Frame: {x: 1, y: 2, width: 3, height: 4}']), 'new text').state, 'unreadable')
  // Long values arrive truncated with an ellipsis; that is not a mismatch.
  const long = 'x'.repeat(600)
  assert.deepEqual(readBackValue(line, snapshot([`edit Address and search bar Value: ${'x'.repeat(500)}...`]), long), {
    state: 'confirmed',
  })
})
