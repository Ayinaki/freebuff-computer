#!/usr/bin/env node
/**
 * End-to-end demo: point the overlay at real elements of a real app.
 *
 * This is the thing the whole exercise is for -- watching a highlight land on the
 * control the agent is about to act on, with a synthetic cursor because our real
 * pointer deliberately never moves.
 *
 * Usage:
 *   node prototype/demo.mjs [app] [--hold 1500] [--element 10]
 *
 * Requires prototype/overlay.ps1 to be startable (Windows, PowerShell, WPF).
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseFrames, snapshot } from './frames.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const out = { app: 'Vivaldi', hold: 1500, element: null, limit: 80 }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--hold') out.hold = Number(argv[++i])
    else if (a === '--element') out.element = Number(argv[++i])
    else if (a === '--limit') out.limit = Number(argv[++i])
    else positional.push(a)
  }
  if (positional[0]) out.app = positional[0]
  return out
}

const { app, hold, element, limit } = parseArgs(process.argv.slice(2))

const raw = snapshot(app, { limit })
const all = parseFrames(raw)

// Interesting = a real control with a real box, not a full-window container and
// not a 9px sliver of decoration.
let targets = all.filter((f) => f.w >= 14 && f.h >= 14 && f.w <= 900 && f.h <= 260)

if (element !== null) {
  targets = targets.filter((t) => t.index === element)
  if (targets.length === 0) {
    const exists = all.find((f) => f.index === element)
    if (!exists) {
      console.error(`element ${element} not found in ${app}'s snapshot (${all.length} framed nodes)`)
      process.exit(1)
    }
    targets = [exists]
  }
}

// Prefer a spread across the window rather than many nodes stacked at the same
// origin (accessibility trees repeat identical frames up the ancestor chain).
const seen = new Set()
const picked = []
for (const t of targets) {
  const key = `${t.x},${t.y},${t.w},${t.h}`
  if (seen.has(key)) continue
  seen.add(key)
  picked.push(t)
  if (picked.length >= 6) break
}

if (picked.length === 0) {
  console.error(`no box-sized elements found in ${app}; try a larger --limit or another app`)
  process.exit(1)
}

console.log(`${app}: ${all.length} framed nodes, driving the overlay at ${picked.length} target(s)`)

const dir = mkdtempSync(join(tmpdir(), 'fbc-demo-'))
const watch = join(dir, 'target.json')
writeFileSync(watch, JSON.stringify({ clear: true }))

const overlay = spawn(
  'powershell',
  ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'overlay.ps1'),
   '-WatchFile', watch, '-DurationSec', String(Math.ceil((picked.length * (hold + 400)) / 1000) + 6)],
  { stdio: ['ignore', 'inherit', 'inherit'], shell: false },
)

overlay.on('error', (e) => {
  console.error('failed to start overlay:', e.message)
  process.exitCode = 1
})

// Give the window time to construct and lay out before the first target.
await sleep(2500)

let seq = 0
for (const t of picked) {
  const label = `${t.role}${t.name ? ` "${t.name.slice(0, 30)}"` : ''}  [${t.index}]`
  writeFileSync(
    watch,
    JSON.stringify({ x: t.x, y: t.y, w: t.w, h: t.h, label, seq: ++seq }),
  )
  console.log(`  -> [${String(t.index).padStart(3)}] ${t.role.padEnd(9)} ${(t.name || '').slice(0, 30).padEnd(30)} ${t.w}x${t.h} @ ${t.x},${t.y}`)
  await sleep(hold)
}

writeFileSync(watch, JSON.stringify({ clear: true, seq: ++seq }))
await sleep(400)

try { overlay.kill() } catch { }
rmSync(dir, { recursive: true, force: true })
console.log('done')
