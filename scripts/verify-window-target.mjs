// Read-only: measure a real element and paint the target; never send browser input.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {ComputerDriver} from '../dist/driver.js'
import {DesktopOverlay, SnapshotTargets} from '../dist/overlay.js'

const app=process.argv[2] ?? 'vivaldi'
const elementName=process.argv[3] ?? 'New Tab'
const driver=new ComputerDriver(), overlay=new DesktopOverlay()
const exec=promisify(execFile)
try {
  const state=await driver.callTool('get_app_state',{app,max_tree_nodes:150})
  assert.equal(state.isError,false)
  const text=state.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
  const node=text.split(/\r?\n/).find(line=>line.includes(`button ${elementName} `))
  assert.ok(node,'real snapshot must contain the requested named button')
  const index=/^\t*(\d+)\s/.exec(node)[1]
  const targets=new SnapshotTargets()
  targets.observe(app,text)
  const target=targets.target({app,element_index:index})
  assert.equal(target.coordinateSpace,'window')
  assert.ok(target.window)
  const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./probe-window-target.ps1',import.meta.url))],{
    windowsHide:true,timeout:20000,env:{...process.env,FBC_WINDOW_VERIFICATION:JSON.stringify({window:target.window,elementName})},
  })
  const measured=JSON.parse(stdout)
  const expected={...target.rect,x:measured.window.x+target.rect.x,y:measured.window.y+target.rect.y}
  for(const key of ['x','y','width','height']) assert.ok(Math.abs(expected[key]-measured.target[key])<=1,`${key}: converted driver frame must agree with independent physical UIA bounds`)
  const event={ts:new Date().toISOString(),tool:'click',app,phase:'begin',...target}
  await overlay.send(event)
  assert.equal(overlay.status().error,undefined)
  assert.equal(overlay.status().rendered.targetStatus,'window','real target must be visible; an occluded target cannot count as this verification passing')
  assert.deepEqual(overlay.status().rendered.pointer,{x:expected.x+expected.width/2,y:expected.y+expected.height/2})
  const pixels=JSON.parse((await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./probe-overlay.ps1',import.meta.url))],{
    windowsHide:true,timeout:15000,env:{...process.env,FBC_OVERLAY_VERIFICATION:JSON.stringify({rect:expected,windows:overlay.status().windows})},
  })).stdout)
  assert.ok(pixels.cursorHits>=20 && pixels.whiteHits>=10,'actual dark cursor with white edge must paint at the corrected target')
  console.log('PASS: driver window-relative frame matches independent physical UIA bounds and real cursor pixels',JSON.stringify({relative:target.rect,origin:measured.window,physical:expected,pointer:overlay.status().rendered.pointer,cursorPixels:pixels.cursorHits}))
  const lastPosition=overlay.status().rendered.pointer
  for(const window of [undefined,{...target.window,pid:0},{...target.window,width:target.window.width+40},{...target.window,title:'No matching test window'}]) {
    await overlay.send({...event,window})
    assert.deepEqual(overlay.status().rendered.pointer,lastPosition,'missing, mismatched or stale identity must retain the resting cursor without guessing a destination')
    assert.equal(overlay.status().rendered.targetStatus,'unavailable')
  }
  console.log('PASS: missing identity, wrong process, resized window and mismatched title preserve position without guessing a target')
} finally { await overlay.close(); await driver.close() }
