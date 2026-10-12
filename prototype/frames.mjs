#!/usr/bin/env node
/**
 * Extract per-element geometry from a live accessibility snapshot.
 *
 * The driver's JS API (`app.getAXState()`) returns the same indented outline as
 * the CLI, so geometry arrives as text -- there is no structured rect object to
 * read. That is fine: `Frame: {x, y, width, height}` appears on nearly every
 * node line, including interactive ones, so it parses reliably.
 *
 * Usage:
 *   node prototype/frames.mjs <app> [--limit 80] [--json]
 *   node prototype/frames.mjs <app> --element 10
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const FRAME = /Frame:\s*\{x:\s*(-?\d+),\s*y:\s*(-?\d+),\s*width:\s*(-?\d+),\s*height:\s*(-?\d+)\}/

export function parseFrames(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const m = FRAME.exec(line)
    if (!m) continue
    const indent = (/^(\t*)/.exec(line) ?? [''])[1].length
    const body = line.replace(/\t/g, '').trim()
    // "<index> <role> <name...> [Value: ...] [Secondary Actions: ...] Frame: {...}"
    const head = /^(\d+)\s+([A-Za-z_]+)\s*(.*?)\s*(?:Value:|Secondary Actions:|Frame:)/.exec(body)
    if (!head) continue
    const index = Number(head[1])
    const role = head[2]
    const name = (head[3] ?? '').replace(/\s+/g, ' ').trim()
    out.push({
      index,
      depth: indent,
      role,
      name,
      x: Number(m[1]),
      y: Number(m[2]),
      w: Number(m[3]),
      h: Number(m[4]),
    })
  }
  return out
}

/**
 * The npm `ocu` entry point is a .cmd shim, which on Windows can only be run
 * through a shell -- and passing args with `shell: true` triggers Node's
 * DEP0190. The shim only launches the platform binary, so prefer calling that
 * binary directly and keep the shell as a last resort.
 */
function resolveOcu() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
    const exe = join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      'open-computer-use',
      'dist',
      'windows',
      arch,
      'open-computer-use.exe',
    )
    if (existsSync(exe)) return { cmd: exe, shell: false }
  }
  return { cmd: 'ocu', shell: true }
}

export function snapshot(app, { limit = 80, timeout = 60000 } = {}) {
  // A fresh snapshot per call: element indexes are scoped to the session that
  // produced them, exactly as the server must treat them.
  const { cmd, shell } = resolveOcu()
  return execFileSync(
    cmd,
    ['snapshot', '--max-tree-nodes', String(limit), '--max-tree-depth', '32', app],
    { encoding: 'utf8', timeout, shell },
  )
}

function main() {
  const [, , app, ...rest] = process.argv
  if (!app) {
    console.error('usage: node prototype/frames.mjs <app> [--limit N] [--json] [--element N]')
    process.exit(2)
  }
  const limitArg = rest.indexOf('--limit')
  const limit = limitArg >= 0 ? Number(rest[limitArg + 1]) : 80
  const elArg = rest.indexOf('--element')
  const wantIndex = elArg >= 0 ? Number(rest[elArg + 1]) : null

  const frames = parseFrames(snapshot(app, { limit }))
  const chosen = wantIndex === null ? frames : frames.filter((f) => f.index === wantIndex)

  if (rest.includes('--json')) {
    console.log(JSON.stringify(chosen, null, 2))
  } else {
    const interesting = chosen.filter((f) => f.w > 8 && f.h > 8 && f.w < 1200 && f.h < 400)
    console.log(`${app}: ${frames.length} nodes with frames, ${interesting.length} box-sized`)
    for (const f of interesting.slice(0, 14)) {
      console.log(
        `  [${String(f.index).padStart(3)}] ${f.role.padEnd(9)} ${String(f.name).slice(0, 34).padEnd(34)} ` +
          `${f.w}x${f.h} @ ${f.x},${f.y}`,
      )
    }
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('frames.mjs')) {
  main()
}
