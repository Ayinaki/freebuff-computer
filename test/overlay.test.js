import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SnapshotTargets, DesktopOverlay, activityLabel } from '../dist/overlay.js'

test('overlay geometry preserves native indexes, negative origins and fractional coordinates', () => {
  const targets = new SnapshotTargets()
  targets.observe('Editor', '0 window Editor Frame: {x: -1920, y: 40, width: 1200, height: 900}\n\t17 edit Input Frame: {x: -1800.5, y: 62, width: 120, height: 24.5}\n\t23 button Missing frame')
  assert.deepEqual(targets.target({app:'editor',element_index:'17'}), {rect:{x:-1800.5,y:62,width:120,height:24.5},pointer:true})
  assert.deepEqual(targets.target({app:'editor',element_index:'23'}), {rect:undefined,pointer:false})
  assert.deepEqual(targets.target({app:'Other',element_index:'17'}), {pointer:false})
  assert.equal(targets.target({app:'Editor',x:10,y:20}).pointer,false,'never guess a screenshot-to-desktop transform')
})

test('new snapshots and mutations discard stale target geometry', () => {
  const targets = new SnapshotTargets()
  targets.observe('App','7 button Old Frame: {x: 1, y: 2, width: 3, height: 4}')
  targets.observe('App','9 button New Frame: {x: 10, y: 20, width: 30, height: 40}')
  assert.equal(targets.target({app:'App',element_index:'7'}).pointer,false)
  assert.equal(targets.target({app:'App',element_index:'9'}).pointer,true)
  targets.clear()
  assert.equal(targets.target({app:'App',element_index:'9'}).pointer,false)
})

test('invalid and non-node frames cannot position the overlay cursor', () => {
  const targets = new SnapshotTargets()
  targets.observe('App','Header Frame: {x: 1, y: 2, width: 3, height: 4}\n1 button Frame: {x: 1, y: 2, width: -3, height: 4}\n2 button Frame: {x: 1, y: 2, width: 0, height: 4}')
  for (const element_index of ['0','1','2']) assert.equal(targets.target({app:'App',element_index}).pointer,false)
})

test('FBC_OVERLAY=0 keeps activity calls inert without launching a helper', async () => {
  const previous = process.env.FBC_OVERLAY
  process.env.FBC_OVERLAY='0'
  try {
    const overlay = new DesktopOverlay()
    await overlay.send({ts:new Date().toISOString(),tool:'click',phase:'begin',pointer:false})
    assert.deepEqual(overlay.status(),{state:'disabled',error:undefined,windows:undefined,sessionActive:false,idleEnds:0})
    await overlay.close()
    assert.equal(overlay.status().state,'closed')
  } finally {
    if(previous===undefined) delete process.env.FBC_OVERLAY
    else process.env.FBC_OVERLAY=previous
  }
})

test('Windows frames carry a uniquely identified window, never an invented desktop origin', () => {
  const targets = new SnapshotTargets()
  const text='App=vivaldi (pid 16980)\nWindow: "Browser", App: vivaldi.\n\t0 window Browser Frame: {x: 0, y: 0, width: 1294, height: 1399}\n\t\t31 button New Tab Frame: {x: 1048, y: 6, width: 30, height: 30}'
  assert.equal(SnapshotTargets.isSnapshot(text),true)
  targets.observe('vivaldi',text)
  assert.deepEqual(targets.target({app:'vivaldi',element_index:'31'}),{
    rect:{x:1048,y:6,width:30,height:30},pointer:true,coordinateSpace:'window',
    window:{pid:16980,title:'Browser',width:1294,height:1399},
  })
  targets.observe('vivaldi',text+'\nWindow: "Another", App: vivaldi.')
  assert.equal(targets.target({app:'vivaldi',element_index:'31'}).window,undefined,'ambiguous identities must not be resolved')
  for(const ack of ['Clicked element 31','0 window Fake Frame: {x: 0, y: 0, width: 100, height: 100}']) {
    assert.equal(SnapshotTargets.isSnapshot(ack),false)
  }
})

test('overlay status describes each action and its outcome without claiming model thinking', () => {
  assert.equal(activityLabel('get_app_state','begin'),'Reading app')
  assert.equal(activityLabel('get_app_state','end'),'View captured')
  assert.equal(activityLabel('click','begin'),'Clicking')
  assert.equal(activityLabel('click','end'),'Click sent')
  // Completion labels describe dispatch, not effect: the overlay reports when a
  // driver call returned, which is before anything has been verified.
  assert.equal(activityLabel('set_value','end'),'Text sent')
  for(const tool of ['click','set_value','type_text','press_key','scroll','drag']) {
    assert.doesNotMatch(activityLabel(tool,'end'),/^Text set$/,`${tool} must not claim an effect nobody measured`)
  }
  assert.equal(activityLabel('press_key','end'),'Key sent')
  assert.equal(activityLabel('click','error'),'Click failed')
  assert.equal(activityLabel('computer_session','begin'),'Session active')
})

test('explicit window handles disambiguate identical titles for overlay matching',()=>{
  const targets=new SnapshotTargets()
  targets.observe('app@window:42:200:123','App=app@window:42:200:123 (pid 42)\nWindow: "Same title", App: app.\nWindow-ID: 200\n0 window Same title Frame: {x: 0, y: 0, width: 800, height: 600}\n\t7 button Frame: {x: 20, y: 30, width: 40, height: 50}')
  assert.equal(targets.target({app:'app@window:42:200:123',element_index:'7'}).window.hwnd,'200')
  assert.equal(targets.target({app:'app@window:42:100:123',element_index:'7'}).pointer,false)
})

test('coordinate clicks use only an exact window-bound snapshot and preserve the requested point',()=>{
  const targets=new SnapshotTargets()
  const app='app@window:42:200:123'
  const snapshot='App='+app+' (pid 42)\nWindow: "Canvas", App: app.\nWindow-ID: 200\n0 window Canvas Frame: {x: 0, y: 0, width: 800, height: 600}'
  targets.observe(app,snapshot)
  for(const [x,y] of [[0,0],[799,599],[20.25,30.75]]) {
    const target=targets.target({app,x,y})
    assert.equal(target.pointer,true)
    assert.equal(target.coordinateSpace,'window')
    assert.equal(target.window.hwnd,'200')
    assert.equal(target.rect.x+target.rect.width/2,x)
    assert.equal(target.rect.y+target.rect.height/2,y)
  }
  for(const [x,y] of [[-1,0],[800,0],[0,600],[NaN,10],[Infinity,10],['20',30],[20,undefined]]) {
    assert.equal(targets.target({app,x,y}).pointer,false)
  }
  assert.equal(targets.target({app:'other',x:20,y:30}).pointer,false)
  assert.equal(targets.target({app,element_index:'missing',x:20,y:30}).pointer,false,'index takes precedence just as it does in the driver')
  targets.observe(app,snapshot.replace('Window-ID: 200\n',''))
  assert.equal(targets.target({app,x:20,y:30}).pointer,false,'legacy or unbound snapshots cannot establish the pixel transform')
  targets.clear()
  assert.equal(targets.target({app,x:20,y:30}).pointer,false)
})

test('drag feedback requires two valid endpoints in the same exact snapshot window',()=>{
  const targets=new SnapshotTargets(), app='canvas'
  targets.observe(app,'App=canvas (pid 42)\nWindow: "Canvas", App: canvas.\nWindow-ID: 200\n0 window Canvas Frame: {x: 0, y: 0, width: 800, height: 600}')
  const args={app,from_x:20.5,from_y:30,to_x:799,to_y:599}
  const target=targets.target(args,'drag')
  assert.equal(target.pointer,true)
  assert.deepEqual(target.rect,{x:20,y:29.5,width:1,height:1})
  assert.deepEqual(target.dragTo,{x:798.5,y:598.5,width:1,height:1})
  for(const bad of [{from_x:-1},{to_x:800},{to_y:NaN},{from_y:'30'},{app:'other'}])
    assert.deepEqual(targets.target({...args,...bad},'drag'),{pointer:false})
  targets.clear()
  assert.deepEqual(targets.target(args,'drag'),{pointer:false})
  assert.equal(activityLabel('drag','dispatch'),'Dragging')
})
