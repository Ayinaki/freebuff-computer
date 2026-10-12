// Real inputs go only to two disposable, test-owned windows in one process.
import assert from 'node:assert/strict'
import {verifyPatterns} from './verify-patterns.mjs'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'

const path=name=>fileURLToPath(new URL(name,import.meta.url))
const tag=`FBC routing ${Date.now()}`
const fixture=spawn('powershell.exe',['-NoProfile','-NonInteractive','-STA','-File',path('./window-fixture.ps1'),'-ParentId',String(process.pid),'-Tag',tag],{windowsHide:true,stdio:['ignore','pipe','pipe']})
let stderr=''
const trace=process.argv.includes('--trace')
fixture.stderr.on('data',chunk=>{stderr+=chunk;if(trace) process.stderr.write(chunk)})
const client=new Client({name:'verify-multiwindow',version:'1'})
const transport=new StdioClientTransport({command:process.execPath,args:[path('../dist/cli.js'),'server'],env:{...process.env,FBC_STATE_DIR:mkdtempSync(join(tmpdir(),'fbc-windows-')),FBC_POLICY_MODE:'allowlist',FBC_ALLOWED_APPS:'powershell',FBC_OVERLAY:'0'},stderr:'inherit'})
const text=result=>result.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
const call=async(name,args)=>{
  if(trace) console.log(`BEGIN ${name} ${args.app ?? ''}`)
  const result=await client.callTool({name,arguments:args})
  if(trace) console.log(`END ${name} error=${!!result.isError}`)
  return result
}
const read=async app=>{const result=await call('get_app_state',{app,max_tree_nodes:process.argv.includes('--patterns')?300:80});assert.equal(result.isError,false,text(result));return text(result)}
const edit=tree=>{const match=/^\t*(\d+) edit Note\b/m.exec(tree);assert.ok(match,tree);return match[1]}
try {
  const ready=await new Promise((resolve,reject)=>{
    let buffer='';const timer=setTimeout(()=>reject(new Error(`Fixture startup timed out: ${stderr}`)),15000)
    fixture.once('error',error=>{clearTimeout(timer);reject(error)})
    fixture.once('exit',code=>{clearTimeout(timer);reject(new Error(`Fixture exited ${code}: ${stderr}`))})
    fixture.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(buffer.split('\n')[0].trim()))}catch(error){reject(error)}}})
  })
  await client.connect(transport)
  const listed=await call('list_apps',{})
  assert.equal(listed.isError,false,text(listed))
  const rows=text(listed).split('\n').filter(line=>line.includes(tag))
  assert.equal(rows.length,2,'both windows of the same process must be discovered')
  const a=rows.find(line=>line.includes(`${tag} A`)).split(' -- ')[0]
  const b=rows.find(line=>line.includes(`${tag} B`)).split(' -- ')[0]
  assert.notEqual(a,b)
  assert.ok(a.includes(`@window:${ready.pid}:${ready.a}:`) && b.includes(`@window:${ready.pid}:${ready.b}:`))
  const ambiguous=await call('get_app_state',{app:String(ready.pid)})
  // This server allowlist intentionally excludes numeric PIDs; use the shared
  // process name for the native ambiguity regression instead.
  assert.equal(ambiguous.isError,true)
  const shared=await call('get_app_state',{app:'powershell'})
  assert.equal(shared.isError,true)
  assert.match(text(shared),/Ambiguous app/)
  const first=await read(a),second=await read(b)
  assert.match(first,/First original/);assert.doesNotMatch(first,/Second original/)
  assert.match(second,/Second original/);assert.doesNotMatch(second,/First original/)
  if(process.argv.includes('--patterns')) await verifyPatterns(call,read,a,b,text)
  const ai=edit(await read(a)),bi=edit(await read(b))
  assert.equal(ai,bi,'fixture must exercise equal numeric indexes in different windows')
  const changed=await call('set_value',{app:a,element_index:ai,value:'First changed'})
  assert.equal(changed.isError,false,text(changed))
  assert.match(text(changed),/First changed/)
  assert.match(await read(b),/Second original/,'first-window edit must not affect the second')
  const appended=await call('type_text',{app:a,text:' appended'})
  // WPF edits have no native EDIT handle. Exercise the background value
  // fallback and require observable append behavior, with sibling isolation.
  assert.equal(appended.isError,false,text(appended))
  assert.match(await read(a),/Value: First changed appended(?:\s|$)/)
  assert.match(await read(b),/Second original/)
  const code=`var target=await cua.getApp(${JSON.stringify(b)}); await target.setValue(${JSON.stringify(bi)},"Second changed");`
  const batch=await call('exec_cua_subset',{code})
  assert.equal(batch.isError,false,text(batch))
  assert.match(await read(b),/Second changed/)
  assert.match(await read(a),/Value: First changed appended(?:\s|$)/)
  const blocked=await call('press_key',{app:a,key:'win+l'})
  assert.equal(blocked.isError,true);assert.match(text(blocked),/blocked-key/)
  const forged=a.replace(/^powershell@/,'powershell-fake@')
  const fake=await call('get_app_state',{app:forged})
  assert.equal(fake.isError,true);assert.match(text(fake),/identity changed/)
  const finalA=await read(a)
  const close=/^\t*(\d+) button Close test window\b/m.exec(finalA)
  assert.ok(close,finalA)
  const closed=await call('click',{app:a,element_index:close[1]})
  assert.equal(closed.isError,true,'post-action snapshot must report the selected window closed')
  assert.match(text(closed),/gone|identity changed/)
  const stale=await call('set_value',{app:a,element_index:ai,value:'must not reach B'})
  assert.equal(stale.isError,true)
  assert.match(await read(b),/Second changed/,'closed-window actions must never fall through to its sibling')
  console.log('PASS: same-process discovery, ambiguity refusal, independent snapshots, equal-index edits, restricted-code routing, background typing, forged-identity refusal, hard blocks and closed-window isolation')
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-File',path('./probe-overlay.ps1')],{windowsHide:true,timeout:15000,env:{...process.env,FBC_OVERLAY_VERIFICATION:'{}'}})
  const after=JSON.parse(stdout)
  console.log(JSON.stringify({ready,afterForeground:after.foreground,afterCursor:after.cursor}))
  assert.equal(after.foreground,ready.foreground,'fixture and inputs must preserve foreground focus')
  assert.deepEqual(after.cursor,ready.cursor,'fixture and inputs must preserve the real pointer')
  console.log('PASS: foreground focus and physical pointer preserved')
} finally {
  await client.close().catch(()=>{});await transport.close().catch(()=>{})
  if(fixture.exitCode===null) fixture.kill()
}
