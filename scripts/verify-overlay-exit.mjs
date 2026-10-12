// Kill only a test-owned overlay host while it is active; its renderer must exit on socket EOF.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const moduleUrl = new URL('../dist/overlay.js', import.meta.url).href
const child = spawn(process.execPath, ['--input-type=module', '-e', `
  import { DesktopOverlay } from ${JSON.stringify(moduleUrl)};
  const overlay = new DesktopOverlay();
  await overlay.send({ts:new Date().toISOString(),tool:'click',app:'Shutdown verification',phase:'begin',pointer:false});
  console.log(JSON.stringify(overlay.status()));
`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const exited = once(child, 'exit')
// Attach a rejection handler immediately, including when spawning fails.
void exited.catch(() => {})
let windows
let stderr = ''
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
try {
  const status = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`Test host startup timed out: ${stderr}`)), 15000)
    child.once('error', reject)
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Test host exited before ready: ${stderr}`)) })
    child.stdout.on('data', chunk => {
      output += chunk
      if (output.includes('\n')) {
        clearTimeout(timer)
        try { resolve(JSON.parse(output.slice(0, output.indexOf('\n')))) } catch (error) { reject(error) }
      }
    })
  })
  assert.equal(status.state, 'running', JSON.stringify(status))
  assert.equal(status.error, undefined)
  windows = status.windows
  assert.ok(windows.length > 0)
  assert.equal(child.kill('SIGKILL'), true, 'terminate only the test-owned host')
  await exited
  // Compile/start the probe after termination; this also allows the helper's UI thread to process EOF.
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./probe-overlay.ps1', import.meta.url))], {
    windowsHide: true, timeout: 15000,
    env: { ...process.env, FBC_OVERLAY_VERIFICATION: JSON.stringify({ windows }) },
  })
  const result = JSON.parse(stdout.trim())
  assert.ok(result.windows.every(window => !window.exists), 'abrupt host exit must destroy all overlay windows')
  console.log(`PASS: ${windows.length} active overlay windows were destroyed after abrupt host termination`)
} finally {
  if (child.exitCode === null && child.signalCode === null && child.pid) child.kill('SIGKILL')
}
