// Paint only: no click, key or text input is sent to any app.
import assert from 'node:assert/strict'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {ComputerDriver} from '../dist/driver.js'
import {DesktopOverlay,SnapshotTargets} from '../dist/overlay.js'
const path=name=>fileURLToPath(new URL(name,import.meta.url))
const tag=`FBC coordinate ${Date.now()}`
const fixture=spawn('powershell.exe',['-NoProfile','-NonInteractive','-STA','-File',path('./window-fixture.ps1'),'-ParentId',String(process.pid),'-Tag',tag],{windowsHide:true,stdio:['ignore','pipe','pipe']})
let errors=''
fixture.stderr.on('data',chunk=>{errors+=chunk})
const driver=new ComputerDriver(),overlay=new DesktopOverlay(),exec=promisify(execFile)
try {
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Fixture startup timeout: '+errors)),15000)
    fixture.once('error',error=>{clearTimeout(timer);reject(error)})
    fixture.once('exit',code=>{clearTimeout(timer);reject(new Error(`Fixture exited ${code}: ${errors}`))})
    fixture.stdout.once('data',()=>{clearTimeout(timer);resolve()})
  })
  const listed=await driver.callTool('list_apps',{})
  assert.equal(listed.isError,false)
  const listing=listed.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
  const app=listing.split('\n').find(row=>row.includes(tag+' A')).split(' -- ')[0]
  const result=await driver.callTool('get_app_state',{app,max_tree_nodes:100})
  assert.equal(result.isError,false)
  const text=result.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
  const index=/^\t*(\d+) list view Priority\b/m.exec(text)?.[1]
  assert.ok(index,text)
  const targets=new SnapshotTargets()
  targets.observe(app,text)
  const indexed=targets.target({app,element_index:index})
  const x=indexed.rect.x+indexed.rect.width/2,y=indexed.rect.y+indexed.rect.height/2
  const target=targets.target({app,x,y})
  assert.equal(target.pointer,true)
  const measurement=JSON.parse((await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',path('./probe-window-target.ps1')],{
    windowsHide:true,timeout:20000,env:{...process.env,FBC_WINDOW_VERIFICATION:JSON.stringify({window:target.window,elementName:'Priority'})},
  })).stdout)
  const expected={x:measurement.window.x+x,y:measurement.window.y+y}
  assert.ok(Math.abs(expected.x-(measurement.target.x+measurement.target.width/2))<=1)
  assert.ok(Math.abs(expected.y-(measurement.target.y+measurement.target.height/2))<=1)
  await overlay.send({ts:new Date().toISOString(),tool:'click',phase:'begin',app,...target})
  assert.equal(overlay.status().rendered.targetStatus,'window')
  assert.deepEqual(overlay.status().rendered.pointer,expected)
  const pixels=JSON.parse((await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',path('./probe-overlay.ps1')],{
    windowsHide:true,timeout:15000,env:{...process.env,FBC_OVERLAY_VERIFICATION:JSON.stringify({rect:{x:expected.x-.5,y:expected.y-.5,width:1,height:1},windows:overlay.status().windows})},
  })).stdout)
  assert.ok(pixels.cursorHits>=20 && pixels.whiteHits>=10,'painted cursor must land at the coordinate target')
  for(const args of [{app,x:-1,y},{app,x:target.window.width,y},{app:'wrong',x,y}]) {
    await overlay.send({ts:new Date().toISOString(),tool:'click',phase:'begin',...targets.target(args)})
    assert.deepEqual(overlay.status().rendered.pointer,expected,'unverified coordinates must retain the resting position')
  }
  const drag=targets.target({app,from_x:x-50,from_y:y,to_x:x+50,to_y:y},'drag')
  assert.equal(drag.pointer,true)
  const event={ts:new Date().toISOString(),tool:'drag',app,...drag}
  await overlay.send({...event,phase:'begin'})
  assert.deepEqual(overlay.status().rendered.pointer,{x:expected.x-50,y:expected.y})
  const started=performance.now()
  await overlay.send({...event,phase:'dispatch',rect:drag.dragTo})
  assert.equal(overlay.status().rendered.dragging,true)
  assert.deepEqual(overlay.status().rendered.pointer,{x:expected.x+50,y:expected.y})
  if(!overlay.status().reducedMotion) assert.ok(performance.now()-started>=150,'drag must visibly traverse the path')
  const dragPixels=JSON.parse((await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',path('./probe-overlay.ps1')],{
    windowsHide:true,timeout:15000,env:{...process.env,FBC_OVERLAY_VERIFICATION:JSON.stringify({rect:{x:expected.x+49.5,y:expected.y-.5,width:1,height:1},windows:overlay.status().windows})},
  })).stdout)
  assert.ok(dragPixels.cursorHits>=20 && dragPixels.whiteHits>=10,'drag destination must contain the painted cursor')
  await overlay.send({...event,phase:'end'})
  assert.equal(overlay.status().rendered.dragging,false)
  // Error must interrupt motion and release the held-button feedback.
  await overlay.send({...event,phase:'begin'})
  const interrupted=overlay.send({...event,phase:'dispatch',rect:drag.dragTo})
  await new Promise(resolve=>setTimeout(resolve,30))
  await overlay.send({...event,phase:'error'})
  await interrupted
  assert.equal(overlay.status().rendered.dragging,false)
  assert.equal(overlay.status().rendered.targetStatus,'idle')
  assert.equal(overlay.status().error,undefined)
  // A rejected start must not animate a valid destination by itself.
  await overlay.send({...event,phase:'begin',window:{...drag.window,title:'not the fixture'}})
  const resting=overlay.status().rendered.pointer
  await overlay.send({...event,phase:'dispatch',rect:drag.dragTo})
  assert.deepEqual(overlay.status().rendered.pointer,resting)
  assert.equal(overlay.status().rendered.dragging,false)
  console.log('PASS: drag start, destination pixels, held state, release, interruption and invalid-start refusal; reducedMotion='+overlay.status().reducedMotion)
  console.log('PASS: coordinate mapping matches independent physical UIA bounds, actual cursor pixels appear at the requested point, invalid targets preserve position',JSON.stringify({expected,cursorPixels:pixels.cursorHits,whitePixels:pixels.whiteHits}))
} finally {
  await overlay.close();await driver.close()
  if(fixture.exitCode===null) fixture.kill()
}
