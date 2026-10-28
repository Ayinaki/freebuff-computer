// Two Freebuff sessions must not paint two borders over each other. The second
// helper refuses to start and says why, which the server reports as
// "owned-elsewhere" instead of silently stacking a duplicate overlay.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../native/overlay.ps1', import.meta.url))
const mutex = `Local\\FbcSingleton-${process.pid}`

async function helperHost() {
  const token = randomBytes(12).toString('hex')
  const sockets = []
  let connected = 0
  let resolveHandshake
  const handshake = new Promise((resolve) => {
    resolveHandshake = resolve
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
      connected += 1
      resolveHandshake(message)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    token,
    handshake,
    connected: () => connected,
    close: () => {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

function spawnHelper(host) {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', script,
      '-Port', String(host.port), '-Token', host.token, '-ParentPid', String(process.pid)],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, FBC_OVERLAY_MUTEX: mutex } },
  )
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-3000)
  })
  return { child, stderr: () => stderr }
}

const first = await helperHost()
const second = await helperHost()
const a = spawnHelper(first)
const aExit = once(a.child, 'exit')
void aExit.catch(() => {})

let b
let bExit
try {
  const message = await Promise.race([
    first.handshake,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`first helper never connected: ${a.stderr()}`)), 15000)),
  ])
  assert.ok(message.windows.length > 0)
  assert.equal(a.child.exitCode, null, 'the first helper owns the overlay')

  // Only now does a second session start, so the winner is not a race.
  b = spawnHelper(second)
  bExit = once(b.child, 'exit')
  void bExit.catch(() => {})
  const [code] = await Promise.race([
    bExit,
    new Promise((_, reject) => setTimeout(() => reject(new Error('the second helper did not refuse to start')), 15000)),
  ])
  assert.equal(code, 3, `a second helper must exit with the documented code, got ${code}`)
  assert.match(b.stderr(), /already running/i)
  assert.equal(second.connected(), 0, 'the second helper must not authenticate against its server')
  assert.equal(a.child.exitCode, null, 'the first helper must be left alone')

  console.log('PASS: a second overlay helper refuses to start and says another one is already running')
} finally {
  a.child.kill('SIGKILL')
  b?.child.kill('SIGKILL')
  first.close()
  second.close()
}
