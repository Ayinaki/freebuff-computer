// Read-only live verification; pass a harmless, already-open app name.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const app = process.argv[2]
const client = new Client({ name: 'verify-cua-subset', version: '1' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'server'],
  env: { ...process.env, FBC_STATE_DIR: mkdtempSync(join(tmpdir(), 'fbc-live-subset-')), FBC_POLICY_MODE: 'audit' },
  stderr: 'inherit',
})
try {
  await client.connect(transport)
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'list_apps', 'get_app_state', 'click', 'set_value', 'type_text', 'press_key',
    'scroll', 'drag', 'perform_secondary_action', 'computer_doctor', 'computer_policy', 'exec_cua_subset', 'computer_session',
  ].sort())
  console.log(`Fresh MCP handshake: ${names.length} tools: ${names.join(', ')}`)
  const code = app
    ? `var app = await cua.getApp(${JSON.stringify(app)}); var state = await app.getAXState({emit:false,maxTreeNodes:40}); nodeRepl.write(state);`
    : 'await cua.listApps();'
  const result = await client.callTool({ name: 'exec_cua_subset', arguments: { code } })
  assert.equal(result.isError, false, JSON.stringify(result.content))
  const text = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  assert.ok(text.trim(), 'The live driver must return content')
  if (app) {
    assert.match(text, /^\t*\d+\s+\S+/m, 'The app must return real indexed accessibility nodes')
    console.log(`Read-only exec_cua_subset against ${app}: ${Buffer.byteLength(text)} bytes, indexed accessibility nodes present; no mutation requested.`)
  } else console.log(text)
  if (process.platform === 'win32' && process.env.FBC_OVERLAY !== '0') {
    const doctor = await client.callTool({name:'computer_doctor',arguments:{}})
    const report = JSON.parse(doctor.content[0].text)
    assert.equal(report.overlay.state,'running',JSON.stringify(report.overlay))
    assert.equal(report.overlay.sessionActive,true,'the visual session remains active after the read finishes')
    assert.equal(report.overlay.error,undefined,'native renderer must acknowledge its paints')
    console.log(`Native activity overlay running on ${report.overlay.windows.length} monitors through the real MCP call path.`)
  }
  const ended = await client.callTool({name:'computer_session',arguments:{action:'end'}})
  assert.equal(ended.isError,false)
  assert.equal(JSON.parse(ended.content[0].text).sessionActive,false,'explicit end must finish the visual session')
} finally {
  await client.close()
  await transport.close()
}
