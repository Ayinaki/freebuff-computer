// Verify a locally packed/installed release without publishing or modifying a user's config.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

assert.ok(process.argv[2], 'Usage: node scripts/verify-installed.mjs <installed-package-root>')
const root = resolve(process.argv[2])
const workspace = mkdtempSync(join(tmpdir(), 'fbc-installed-workspace-'))
// Explicit ESM also works on Node 18, without relying on newer syntax detection.
// The installed Freebuff loader accepts .mjs as well as .js and .ts.
const agent = join(workspace, '.agents', 'computer-use.mjs')
const registration = join(workspace, '.agents', 'mcp.json')
const env = { ...process.env, FBC_STATE_DIR: join(workspace, 'state'), FBC_POLICY_MODE: 'audit' }
const exec = promisify(execFile)
await exec(process.execPath, [join(root, 'dist', 'cli.js'), 'setup', '--agent-file', agent, '--mcp-file', registration],
  { cwd: workspace, env, windowsHide: true, timeout: 30000 })
const definition = (await import(pathToFileURL(agent).href)).default
assert.equal(definition.id, 'computer-use')
const config = definition.mcpServers['freebuff-computer']
assert.deepEqual(JSON.parse(readFileSync(registration, 'utf8')).mcpServers['freebuff-computer'], config)
assert.deepEqual(config, { command: process.execPath, args: [join(root, 'dist', 'cli.js'), 'server'] })
const transport = new StdioClientTransport({ ...config, cwd: workspace, env, stderr: 'inherit' })
const client = new Client({ name: 'verify-installed', version: '1' })
try {
  await client.connect(transport)
  const names = (await client.listTools()).tools.map(tool => tool.name).sort()
  assert.deepEqual(names, ['list_apps', 'get_app_state', 'click', 'set_value', 'type_text', 'press_key',
    'scroll', 'drag', 'perform_secondary_action', 'computer_doctor', 'computer_policy', 'exec_cua_subset',
    'computer_session', 'computer_screenshot', 'computer_wait'].sort())
  const result = await client.callTool({ name: 'exec_cua_subset', arguments: { code: 'await cua.listApps();' } })
  assert.equal(result.isError, false, JSON.stringify(result.content))
  assert.ok(result.content.some(block => block.type === 'text' && block.text.trim()), 'live discovery must return content')
  const doctor = await client.callTool({ name: 'computer_doctor', arguments: {} })
  const report = JSON.parse(doctor.content[0].text)
  assert.notEqual(report.status, 'failed', JSON.stringify(report))
  assert.equal(report.contract.ok, true)
  if (process.platform === 'win32' && !process.env.FBC_DRIVER_CMD) {
    assert.equal(report.driver.serverVersion, '0.3.6-freebuff.windows.1')
    assert.ok(report.driver.command.startsWith(join(root, 'dist', 'native')), JSON.stringify(report.driver))
  }
  if (process.platform === 'win32' && process.env.FBC_OVERLAY !== '0') {
    assert.equal(report.overlay.state, 'running', JSON.stringify(report.overlay))
    assert.equal(report.overlay.sessionActive, true)
    assert.equal(report.overlay.error, undefined)
    assert.ok(report.overlay.windows.length > 0)
  }
  console.log(JSON.stringify({ packageRoot: root, workspace, tools: names,
    driver: report.driver, driverContract: report.contract.ok, overlay: report.overlay, result: 'PASS' }, null, 2))
  const ended = await client.callTool({name:'computer_session',arguments:{action:'end'}})
  assert.equal(ended.isError,false)
  assert.equal(JSON.parse(ended.content[0].text).sessionActive,false)
} finally {
  await client.close()
  await transport.close()
}
