import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'

// An installed package root verifies that the tarball contains the renderer assets.
const root = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('..', import.meta.url))
const { DesktopOverlay } = await import(pathToFileURL(join(root, 'dist', 'overlay.js')).href)

const exec = promisify(execFile)
const probe = async (request={}) => {
  const {stdout} = await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./probe-overlay.ps1',import.meta.url))],
    {windowsHide:true,env:{...process.env,FBC_OVERLAY_VERIFICATION:JSON.stringify(request)},timeout:15000})
  return JSON.parse(stdout.trim())
}
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms))
const before = await probe()
const overlay = new DesktopOverlay()
const preservationFailures=[]
const checkPreservation=check=>{
  try { check() } catch(error) {
    preservationFailures.push(error)
    console.error(`FAILED desktop-preservation check (retained for final exit status): ${error.message}`)
  }
}
let windows
try {
  await overlay.send({ts:new Date().toISOString(),tool:'computer_session',phase:'begin',pointer:false})
  const initial=overlay.status()
  const primary=initial.windows.find(window=>window.x===0 && window.y===0)
  const centre={x:primary.x+primary.width/2,y:primary.y+primary.height/2}
  assert.deepEqual(initial.rendered.pointer,centre,'session cursor must start at the primary screen centre')
  const centrePixels=await probe({rect:{x:centre.x-15,y:centre.y-15,width:30,height:30},windows:initial.windows})
  assert.ok(centrePixels.cursorHits>=20 && centrePixels.whiteHits>=10,'initial centre cursor must actually render')
  const event={ts:new Date().toISOString(),tool:'click',app:'Overlay verification',phase:'begin',rect:before.rect,pointer:true,coordinateSpace:'desktop'}
  const firstStarted=performance.now()
  await overlay.send(event)
  const status=overlay.status()
  console.log('Overlay status:',JSON.stringify(status))
  assert.equal(status.state,'running',JSON.stringify(status))
  assert.equal(status.error,undefined,'paint must be acknowledged')
  if(!status.reducedMotion) assert.ok(performance.now()-firstStarted>=150,'first action must glide from the centre rather than teleport')
  windows=status.windows
  const drawn=await probe({rect:before.rect,windows})
  console.log('Initial pixel and focus measurements:',JSON.stringify(drawn))
  checkPreservation(()=>assert.equal(drawn.foreground,before.foreground,'overlay must not steal focus'))
  checkPreservation(()=>assert.deepEqual(drawn.cursor,before.cursor,'overlay must not move the real pointer'))
  for(const window of drawn.windows) {
    assert.ok(window.exists && window.visible,'each monitor must have a visible overlay')
    assert.equal(window.style & 0x080800A8,0x080800A8,'layered, click-through, no-activate, toolwindow and topmost flags')
    assert.ok(window.borderHits>=2,`blue monitor border must appear in captured pixels: ${JSON.stringify(window)}`)
  }
  assert.equal(status.rendered.label,'Freebuff · Clicking')
  assert.ok(drawn.edgeHits<=before.edgeHits,'the removed target box must not be painted')
  assert.ok(drawn.cursorHits>=20 && drawn.cursorHits>before.cursorHits,'synthetic cursor must render over baseline')
  assert.ok(drawn.whiteHits>=10,'the dark cursor must have a visible white edge')
  assert.ok(drawn.interiorHits<=before.interiorHits,'target interior must remain transparent')
  console.log('Visible pixel and focus checks:',JSON.stringify(drawn))
  const revision=status.displayRevision
  assert.ok(Number.isInteger(revision),'renderer must report its display revision')
  await probe({rebuildWindow:windows[0].hwnd})
  const deadline=Date.now()+5000
  while(overlay.status().displayRevision===revision && Date.now()<deadline) await delay(25)
  const rebuilt=overlay.status()
  assert.ok(rebuilt.displayRevision>revision,'display change must rebuild and report fresh window handles')
  windows=rebuilt.windows
  await overlay.send(event)
  assert.equal(overlay.status().error,undefined,'actions must still paint after a window rebuild')
  const afterRebuild=await probe({rect:before.rect,windows})
  checkPreservation(()=>assert.equal(afterRebuild.foreground,before.foreground,'rebuild must not steal focus'))
  checkPreservation(()=>assert.deepEqual(afterRebuild.cursor,before.cursor,'rebuild must not move the real pointer'))
  assert.ok(afterRebuild.windows.every(window=>window.exists && window.visible && window.borderHits>=2))
  assert.ok(afterRebuild.edgeHits<=before.edgeHits && afterRebuild.cursorHits>=20,'the cursor must survive rebuilding without restoring the removed box')
  console.log('Display-change notification check:',JSON.stringify({displayRevision:rebuilt.displayRevision,windows}))
  await overlay.send({...event,phase:'end'})
  assert.equal(overlay.status().rendered.label,'Freebuff · Click sent')
  await overlay.send({ts:new Date().toISOString(),tool:'get_app_state',phase:'begin',pointer:false})
  await overlay.send({ts:new Date().toISOString(),tool:'get_app_state',phase:'end',pointer:false})
  assert.equal(overlay.status().rendered.label,'Freebuff · View captured')
  const resting={x:before.rect.x+before.rect.width/2,y:before.rect.y+before.rect.height/2}
  assert.deepEqual(overlay.status().rendered.pointer,resting,'observations must retain the session cursor position')
  assert.equal(overlay.status().rendered.targetStatus,'idle','resting position must not be treated as a fresh target')
  await delay(4000)
  const idle=await probe({rect:before.rect,windows})
  assert.ok(idle.windows.every(window=>window.visible && window.borderHits>=2),'border must persist between tool calls beyond the old idle timeout')
  assert.ok(idle.cursorHits>=20 && idle.whiteHits>=10,'cursor and borders must remain visible through thinking pauses')
  await overlay.send({ts:new Date().toISOString(),tool:'press_key',phase:'begin',pointer:false})
  await overlay.send({ts:new Date().toISOString(),tool:'press_key',phase:'end',pointer:false})
  assert.deepEqual(overlay.status().rendered.pointer,resting,'keyboard actions must not remove or relocate the pointer')
  const destination={...before.rect,x:before.rect.x+600,y:before.rect.y+240}
  const started=performance.now()
  await overlay.send({...event,rect:destination})
  const travelMs=performance.now()-started
  assert.equal(overlay.status().error,undefined,'travel must be acknowledged before the driver acts')
  if(!status.reducedMotion) assert.ok(travelMs>=150 && travelMs<1000,`expected a visible glide, got ${travelMs}ms`)
  const arrived=await probe({rect:destination,windows})
  assert.ok(arrived.cursorHits>=20,'cursor must arrive at the new target')
  await overlay.send({...event,rect:destination,phase:'error'})
  assert.equal(overlay.status().rendered.label,'Freebuff · Click failed')
  assert.deepEqual(overlay.status().rendered.pointer,{x:destination.x+destination.width/2,y:destination.y+destination.height/2},'errors must retain the session pointer')
  assert.equal(overlay.status().rendered.targetStatus,'idle','errors must withdraw the target without pretending a click succeeded')
  console.log('Persistent session and cursor travel:',JSON.stringify({idleWaitMs:4000,travelMs,reducedMotion:status.reducedMotion}))
  await overlay.send({ts:new Date().toISOString(),tool:'computer_session',phase:'end',pointer:false})
  const ended=await probe({rect:destination,windows})
  assert.ok(ended.windows.every(window=>!window.visible),'explicit session end must hide all monitor windows')
  assert.equal(overlay.status().sessionActive,false)
  assert.equal(overlay.status().rendered.pointer,null,'only session end removes the cursor')
  await overlay.send({ts:new Date().toISOString(),tool:'computer_session',phase:'begin',pointer:false})
  assert.deepEqual(overlay.status().rendered.pointer,centre,'a new session must reset to the centre')
  await overlay.send({ts:new Date().toISOString(),tool:'computer_session',phase:'begin',pointer:false})
  assert.deepEqual(overlay.status().rendered.pointer,centre,'repeated begin is harmless')
  await overlay.send({ts:new Date().toISOString(),tool:'computer_session',phase:'end',pointer:false})
} finally { await overlay.close() }
const closed=await probe({rect:before.rect,windows})
assert.ok(closed.windows.every(window=>!window.exists),'overlay windows must be destroyed on shutdown')
console.log('PASS: centre start, first-action glide, persistent cursor during reads/keys/idle/errors, monitor borders, no target box, dark outlined cursor, transparency, click-through flags, display rebuild, action labels, cursor travel, session end/restart and shutdown')
if(preservationFailures.length) throw new AggregateError(preservationFailures,'Desktop focus/pointer preservation checks failed; all failures retained. Run on an idle desktop to distinguish overlay effects from concurrent user input.')
console.log('PASS: foreground focus and real pointer preserved')
