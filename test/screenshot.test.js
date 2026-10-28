import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const stateDir = mkdtempSync(join(tmpdir(), 'fbc-shot-test-'))
process.env.FBC_STATE_DIR = stateDir
process.env.FBC_OVERLAY = '0'
const { createServer } = await import('../dist/server.js')
const { DEFAULT_CONFIG } = await import('../dist/config.js')
const { SnapshotTargets } = await import('../dist/overlay.js')

/**
 * Screenshots are the difference between acting on what is on screen and
 * guessing at coordinates. They are also the largest thing this server sends,
 * so `auto` has to be a real decision rather than "always, filed under a
 * setting".
 */

const PNG = { type: 'image', data: Buffer.from('not-a-real-png-but-fine-for-a-stub').toString('base64'), mimeType: 'image/png' }

function snapshot({ nodes = 12, scale } = {}) {
  return [
    'App=Notepad (pid 4242)',
    'Window: "Untitled - Notepad", App: Notepad.',
    'Window-ID: 99',
    ...(scale === undefined
      ? []
      : [`Screenshot: ${Math.round(1600 * scale)}x${Math.round(1200 * scale)} from 1600x1200 (scale ${scale}, printwindow)`]),
    '\t0 window Untitled - Notepad Frame: {x: 0, y: 0, width: 1600, height: 1200}',
    ...Array.from({ length: nodes }, (_, index) =>
      `\t\t${index + 1} button Control ${index} Frame: {x: 10, y: ${20 + index * 20}, width: 100, height: 18}`),
  ].join('\n')
}

const text = (value) => ({ isError: false, content: [{ type: 'text', text: value }] })

function harness(t, overrides = {}, { nodes = 12, screenshotTool = true, scale } = {}) {
  const calls = []
  const driver = {
    async supportsParam(tool, param) {
      return tool === 'get_app_state' && param === 'include_screenshot'
    },
    async supportsTool(name) {
      return name === 'screenshot' ? screenshotTool : false
    },
    async callTool(name, args) {
      calls.push({ name, args })
      if (name === 'get_app_state') {
        const blocks = [{ type: 'text', text: snapshot({ nodes, scale }) }]
        if (args.include_screenshot === true) blocks.push({ ...PNG })
        return { isError: false, content: blocks }
      }
      if (name === 'screenshot') {
        if (!screenshotTool) return text('unsupported tool screenshot', true)
        return {
          isError: false,
          content: [{ type: 'text', text: snapshot({ nodes: 0, scale: 0.5 }).split('\n').slice(0, 4).join('\n') }, { ...PNG }],
        }
      }
      // An action returns the same tree, which is what "unchanged" looks like.
      return { isError: false, content: [{ type: 'text', text: snapshot({ nodes, scale }) }] }
    },
    async close() {},
  }
  const overlay = {
    async send() {},
    status: () => ({ state: 'disabled', sessionActive: false }),
    async close() {},
  }
  const bundle = createServer({ config: { ...DEFAULT_CONFIG, policyMode: 'open', sessionIdleSeconds: 0, ...overrides }, driver, overlay })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'screenshot-tests', version: '1' })
  t.after(async () => {
    await client.close().catch(() => {})
    await bundle.server.close()
    await bundle.close()
  })
  const ready = bundle.server.connect(serverSide).then(() => client.connect(clientSide))
  return {
    calls,
    bundle,
    call: async (name, args = {}) => {
      await ready
      return client.callTool({ name, arguments: args })
    },
  }
}

const trajectory = (bundle) =>
  readFileSync(bundle.recorder.path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))

const images = (result) => result.content.filter((block) => block.type === 'image')

test('auto attaches an image on a first read and omits it once the tree is known', async (t) => {
  const server = harness(t)

  const first = await server.call('get_app_state', { app: 'Notepad' })
  assert.equal(server.calls[0].args.include_screenshot, true, 'a first read is worth an image')
  assert.equal(images(first).length, 1)

  const second = await server.call('get_app_state', { app: 'Notepad' })
  assert.equal(server.calls[1].args.include_screenshot, false, 'a known, rich tree does not need pixels')
  assert.equal(images(second).length, 0, 'an image the model did not ask for must not be forwarded')

  const record = trajectory(server.bundle).filter((entry) => entry.tool === 'get_app_state' && entry.kind === 'tool_result').at(-1)
  assert.equal(record.result.screenshot.included, false)
})

test('auto attaches an image when the tree is too thin to act on', async (t) => {
  const server = harness(t, {}, { nodes: 3 })
  await server.call('get_app_state', { app: 'Notepad', screenshot: 'never' })
  const thin = await server.call('get_app_state', { app: 'Notepad' })

  assert.equal(server.calls[1].args.include_screenshot, true, 'three nodes for a 1600x1200 window is not enough to click on')
  assert.equal(images(thin).length, 1)
})

test('auto attaches an image after an action that changed nothing', async (t) => {
  const server = harness(t)
  await server.call('get_app_state', { app: 'Notepad', screenshot: 'never' })

  const click = await server.call('click', { app: 'Notepad', element_index: '1' })
  assert.ok(
    click.content.some((block) => /^\[verification: unchanged\]/m.test(block.text ?? '')),
    'the fixture returns an identical tree, so the action must read as no observable change',
  )

  const after = await server.call('get_app_state', { app: 'Notepad' })
  assert.equal(server.calls.at(-1).args.include_screenshot, true, 'a dead action is a reason to look, not to read the same tree again')
  assert.equal(images(after).length, 1)
})

test('screenshot never and always are honoured regardless of auto rules', async (t) => {
  const server = harness(t)
  const never = await server.call('get_app_state', { app: 'Notepad', screenshot: 'never' })
  assert.equal(server.calls[0].args.include_screenshot, false)
  assert.equal(images(never).length, 0)

  const always = await server.call('get_app_state', { app: 'Notepad', screenshot: 'always' })
  assert.equal(server.calls[1].args.include_screenshot, true)
  assert.equal(images(always).length, 1)
  assert.equal('screenshot' in server.calls[1].args, false, 'the wrapper-only switch must not reach the driver')
})

test('the cursor follows the scale the snapshot reported', () => {
  const targets = new SnapshotTargets()
  targets.observe('Notepad', snapshot({ scale: 0.8 }))
  assert.equal(targets.screenshotScale(), 0.8)

  // The model points at (800,480) in a 1280x960 image of a 1600x1200 window.
  const target = targets.target({ app: 'Notepad', x: 800, y: 480 })
  assert.equal(target.pointer, true)
  assert.equal(target.rect.x + target.rect.width / 2, 1000)
  assert.equal(target.rect.y + target.rect.height / 2, 600)

  // A point outside the window is still refused, never clamped into view.
  assert.equal(targets.target({ app: 'Notepad', x: 1500, y: 480 }).pointer, false)
})

test('computer_screenshot returns the image, states the scale, and saves it for the user', async (t) => {
  const server = harness(t)
  const shot = await server.call('computer_screenshot', { app: 'Notepad' })

  assert.equal(images(shot).length, 1)
  const summary = shot.content.filter((block) => block.type === 'text').at(-1).text
  assert.match(summary, /scale 0\.5/)
  assert.match(summary, /Saved to /)
  const saved = /Saved to (.+\.png)/.exec(summary)[1]
  assert.equal(existsSync(saved), true, 'the file must exist at the path the model and the user are told about')
  assert.match(summary, /pixel space/)

  const record = trajectory(server.bundle).filter((entry) => entry.tool === 'computer_screenshot' && entry.kind === 'tool_result').at(-1)
  assert.ok(record.result.bytes > 0)
})

test('a driver without a screenshot tool is told apart from a failed capture', async (t) => {
  const server = harness(t, {}, { screenshotTool: false })
  const shot = await server.call('computer_screenshot', { app: 'Notepad' })
  assert.equal(shot.isError, true)
  assert.match(shot.content[0].text, /no separate screenshot tool/)
  assert.match(shot.content[0].text, /renumbers element_index/, 'the reason not to retry through get_app_state must be stated')
})

test('an image over the byte budget is shrunk, then refused with the size it reached', async (t) => {
  const server = harness(t, { maxScreenshotBytes: 4 })
  const shot = await server.call('computer_screenshot', { app: 'Notepad' })
  assert.equal(shot.isError, true)
  assert.match(shot.content[0].text, /over this server's/)
  assert.equal(images(shot).length, 0, 'an over-budget image must not be sent anyway')
  assert.equal(server.calls.filter((entry) => entry.name === 'screenshot').length, 3, 'shrinking is bounded, not a retry loop')
})
