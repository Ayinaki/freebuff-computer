// Actual drag input is confined to two disposable test-owned windows.
import assert from 'node:assert/strict'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
const path=name=>fileURLToPath(new URL(name,import.meta.url))
const foreground=process.argv.includes('--foreground')
const tag='FBC drag '+Date.now()
const fixture=spawn('powershell.exe',['-NoProfile','-NonInteractive','-STA','-File',path('./drag-fixture.ps1'),'-ParentId',String(process.pid),'-Tag',tag],{windowsHide:true,stdio:['ignore','pipe','pipe']})
let errors=''
fixture.stderr.on('data',chunk=>{errors+=chunk})
const client=new Client({name:'verify-drag-input',version:'1'})
const transport=new StdioClientTransport({command:process.execPath,args:[path('../dist/cli.js'),'server'],env:{...process.env,FBC_STATE_DIR:mkdtempSync(join(tmpdir(),'fbc-drag-')),FBC_POLICY_MODE:'allowlist',FBC_ALLOWED_APPS:'powershell',FBC_INPUT_MODE:foreground?'foreground':'background'},stderr:'inherit'})
const text=result=>result.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
const call=async(name,args)=>{
  const result=await client.callTool({name,arguments:args})
  assert.equal(result.isError,false,text(result))
  return text(result)
}
try {
  const ready=await new Promise((resolve,reject)=>{
    let buffer=''
    const timer=setTimeout(()=>reject(new Error('Fixture startup timeout: '+errors)),15000)
    fixture.once('error',error=>{clearTimeout(timer);reject(error)})
    fixture.once('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exited '+code+': '+errors))})
    fixture.stdout.on('data',chunk=>{
      buffer+=chunk
      if(buffer.includes('\n')) {clearTimeout(timer);try {resolve(JSON.parse(buffer.split('\n')[0]))}catch(error){reject(error)}}
    })
  })
  await client.connect(transport)
  const rows=(await call('list_apps',{})).split('\n').filter(row=>row.includes(tag))
  assert.equal(rows.length,2)
  const a=rows.find(row=>row.includes(tag+' A')).split(' -- ')[0]
  const b=rows.find(row=>row.includes(tag+' B')).split(' -- ')[0]
  assert.ok(a.includes(':'+ready.a.hwnd+':'))
  assert.ok(b.includes(':'+ready.b.hwnd+':'))
  assert.match(await call('get_app_state',{app:b}),/Drag state: untouched/)
  assert.match(await call('get_app_state',{app:a}),/Drag state: untouched/)
  const {hwnd,...coordinates}=ready.a
  const result=await call('drag',{app:a,...coordinates})
  assert.match(result,/Drag state: accepted/,'native drag must actually reach the destination while held')
  assert.match(await call('get_app_state',{app:b}),/Drag state: untouched/,'sibling window must not receive the drag')
  assert.match(await call('get_app_state',{app:a}),/Drag state: accepted/)
  if(foreground) {
    assert.match(await call('press_key',{app:a,key:'ctrl+k'}),/Shortcut: accepted/)
    await call('get_app_state',{app:a})
    assert.match(await call('click',{app:a,x:coordinates.to_x,y:coordinates.to_y,mouse_button:'right',click_method:'app_post'}),/Right click: accepted/)
    const sibling=await call('get_app_state',{app:b})
    assert.match(sibling,/Shortcut: untouched/)
    assert.match(sibling,/Right click: untouched/)
    const blocked=await client.callTool({name:'press_key',arguments:{app:a,key:'win+l'}})
    assert.equal(blocked.isError,true,'foreground mode must retain hard-key policy')
  }
  await call('computer_session',{action:'end'})
  const after=JSON.parse((await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-File',path('./probe-overlay.ps1')],{windowsHide:true,timeout:15000,env:{...process.env,FBC_OVERLAY_VERIFICATION:'{}'}})).stdout)
  console.log(JSON.stringify({beforeForeground:ready.foreground,afterForeground:after.foreground,beforeCursor:ready.cursor,afterCursor:after.cursor,coordinates}))
  if(foreground) {
    assert.equal(after.foreground,ready.a.hwnd,'foreground mode must target the requested window')
    assert.notDeepEqual(after.cursor,ready.cursor,'real input should move the pointer in this fixture')
  } else {
    assert.equal(after.foreground,ready.foreground,'drag must preserve foreground focus')
    assert.deepEqual(after.cursor,ready.cursor,'drag must preserve the real pointer')
  }
  console.log('PASS: actual mouse-event drag accepted, sibling untouched; input mode='+ (foreground?'foreground':'background'))
} finally {
  await client.close().catch(()=>{});await transport.close().catch(()=>{})
  if(fixture.exitCode===null) fixture.kill()
}
