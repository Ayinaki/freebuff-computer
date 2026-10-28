// A helper whose server is gone must stop painting even when its socket is
// still open. The socket-EOF path is covered by verify-overlay-exit.mjs; this
// covers the parent watch that exists for a wedged or half-open connection.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../native/overlay.ps1', import.meta.url))
const token = randomBytes(12).toString('hex')
const mutex = `Local\\FbcParentExit-${process.pid}`

let sockets = []
let handshake
const ready = new Promise((resolve) => {
  handshake = resolve
})
const server = createServer((socket) => {
  sockets.push(socket)
  let buffer = ''
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    let message
    try {
      message = JSON.parse(buffer.slice(0, newline))
    } catch {
      return
    }
    if (message.token !== token) return
    handshake(message)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const dummy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true })
const helper = spawn(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', script,
    '-Port', String(port), '-Token', token, '-ParentPid', String(dummy.pid)],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, FBC_OVERLAY_MUTEX: mutex } },
)
let stderr = ''
helper.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-3000)
})
const exited = once(helper, 'exit')
void exited.catch(() => {})

const probe = async (windows) => {
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./probe-overlay.ps1', import.meta.url))],
    { windowsHide: true, timeout: 20000, env: { ...process.env, FBC_OVERLAY_VERIFICATION: JSON.stringify({ windows }) } },
  )
  return JSON.parse(stdout.trim())
}

let windows
try {
  const message = await Promise.race([
    ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`overlay never connected: ${stderr}`)), 15000)),
  ])
  assert.equal(message.token, token)
  windows = message.windows
  assert.ok(windows.length > 0, 'the helper must report at least one monitor surface')

  // A surface is created on connect but only shown when it paints, so send one
  // activity event: the windows must be genuinely visible before the parent
  // dies, or "they are not visible afterwards" would prove nothing.
  const socket = sockets.at(-1)
  socket.write(`${JSON.stringify({
    ts: new Date().toISOString(), tool: 'click', phase: 'begin', pointer: false,
    label: 'Verification', coordinateSpace: 'desktop', seq: 1,
  })}\n`)
  await new Promise((resolve) => setTimeout(resolve, 600))

  const visible = await probe(windows)
  assert.ok(visible.windows.every((window) => window.exists && window.visible), 'the probe must start with visible windows')

  // The screen copy stays open: only the parent watch can end this helper.
  assert.equal(dummy.kill('SIGKILL'), true)
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('the helper outlived its server')), 12000)),
  ])

  const after = await probe(windows)
  assert.ok(
    after.windows.every((window) => !window.exists),
    `windows survived the parent: ${JSON.stringify(after.windows)}`,
  )
  console.log(`PASS: ${windows.length} overlay windows were destroyed after the parent process died with the socket still open`)
} finally {
  if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL')
  dummy.kill('SIGKILL')
  for (const socket of sockets) socket.destroy()
  server.close()
}
