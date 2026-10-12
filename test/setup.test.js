import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url))
const run=(args,state)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{...process.env,FBC_STATE_DIR:state}})

test('setup creates an importable standalone agent with working absolute MCP paths',async()=>{
  const state=mkdtempSync(join(tmpdir(),'fbc-setup-'))
  const agent=join(state,'.agents','computer-use.mjs')
  const result=run(['setup','--agent-file',agent,'--model','test/model'],state)
  assert.equal(result.status,0,result.stderr)
  const definition=(await import(pathToFileURL(agent).href)).default
  assert.equal(definition.id,'computer-use')
  assert.equal(definition.model,'test/model')
  const server=definition.mcpServers['freebuff-computer']
  assert.deepEqual(server,{command:process.execPath,args:[cli,'server']})
  assert.ok(isAbsolute(server.args[0]))
  assert.doesNotMatch(readFileSync(agent,'utf8'),/@codebuff\/common|npx/)
  assert.match(result.stdout,/does not require an npm publication/)
  const again=run(['setup','--agent-file',agent],state)
  assert.equal(again.status,1,'existing agent files must never be replaced')
  assert.equal((await import(pathToFileURL(agent).href)).default.model,'test/model')
})

test('setup rejects incomplete options',()=>{
  const state=mkdtempSync(join(tmpdir(),'fbc-setup-'))
  assert.equal(run(['setup','--agent-file'],state).status,1)
  assert.equal(run(['setup','--model'],state).status,1)
  assert.equal(run(['setup','--mcp-file'],state).status,1)
})

test('setup writes shared MCP registration without replacing existing connectors',()=>{
  const state=mkdtempSync(join(tmpdir(),'fbc-setup-mcp-'))
  const path=join(state,'.agents','mcp.json')
  const result=run(['setup','--mcp-file',path],state)
  assert.equal(result.status,0,result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(path,'utf8')), {
    mcpServers: {'freebuff-computer': {command:process.execPath,args:[cli,'server']}},
  })
  const existing=JSON.stringify({mcpServers:{other:{command:'other-server',args:[]}}})
  writeFileSync(path,existing)
  const agent=join(state,'.agents','computer-use.js')
  const conflict=run(['setup','--agent-file',agent,'--mcp-file',path],state)
  assert.equal(conflict.status,1)
  assert.match(conflict.stderr,/left unchanged/)
  assert.equal(readFileSync(path,'utf8'),existing,'other connectors must remain byte-for-byte unchanged')
  assert.equal(existsSync(agent),false,'validate every destination before writing any output')
})

test('setup refuses using the same destination for an agent and MCP registration',()=>{
  const state=mkdtempSync(join(tmpdir(),'fbc-setup-conflict-'))
  const path=join(state,'output.js')
  const result=run(['setup','--agent-file',path,'--mcp-file',path],state)
  assert.equal(result.status,1)
  assert.equal(existsSync(path),false)
})

test('stats counts calls once and excludes overlay activity events',()=>{
  const state=mkdtempSync(join(tmpdir(),'fbc-stats-'))
  mkdirSync(join(state,'trajectories'))
  writeFileSync(join(state,'trajectories','test.jsonl'),[
    {kind:'tool_call',tool:'click'}, {kind:'activity',tool:'click'},
    {kind:'tool_result',tool:'click',result:{}}, {kind:'activity',tool:'click'},
  ].map(entry=>JSON.stringify(entry)).join('\n'))
  const result=run(['stats'],state)
  assert.equal(result.status,0,result.stderr)
  assert.match(result.stdout,/tool calls\s+1\b/)
})

test('missing driver leaves setup destinations untouched so setup can be retried',()=>{
  const state=mkdtempSync(join(tmpdir(),'fbc-setup-missing-'))
  const agent=join(state,'.agents','computer-use.mjs')
  const mcp=join(state,'.agents','mcp.json')
  const args=['setup','--agent-file',agent,'--mcp-file',mcp]
  const failed=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',
    env:{...process.env,FBC_STATE_DIR:state,FBC_DRIVER_CMD:'fbc-driver-that-does-not-exist-598173 mcp'}})
  assert.equal(failed.status,1)
  assert.match(failed.stderr,/FBC_DRIVER_CMD was not found/)
  for(const file of [agent,mcp,join(state,'config.json')])
    assert.equal(existsSync(file),false,'missing driver must not leave '+file)
  const retried=run(args,state)
  assert.equal(retried.status,0,retried.stderr)
  assert.equal(existsSync(agent),true)
  assert.equal(existsSync(mcp),true)
})

