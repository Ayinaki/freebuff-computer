import {test} from 'node:test'
import assert from 'node:assert/strict'
import {checkAction} from '../dist/policy.js'
import {DEFAULT_CONFIG} from '../dist/config.js'

const app='vivaldi@window:16980:722904:639270107124352414'
const config=(allowedApps,policyMode='allowlist')=>({...DEFAULT_CONFIG,allowedApps,policyMode})
test('window selectors retain app and PID allowlist gates without granting authority from handle or timestamp',()=>{
  for(const allowed of ['vivaldi','16980']) assert.equal(checkAction('get_app_state',{app},config([allowed])).allowed,true)
  for(const allowed of ['notepad','722904','639270107124352414']) assert.equal(checkAction('get_app_state',{app},config([allowed])).code,'app-not-allowed')
  assert.equal(checkAction('get_app_state',{app},config([])).code,'app-not-allowed')
})
test('window selectors retain audit, hard-key, payload, and complete code-batch preflight protections',()=>{
  assert.equal(checkAction('set_value',{app,element_index:'1',value:'hello'},config([],'audit')).code,'audit-mode-read-only')
  for(const mode of ['open','audit','allowlist']) {
    assert.equal(checkAction('press_key',{app,key:'win+l'},config(['vivaldi'],mode)).code,'blocked-key')
    assert.equal(checkAction('set_value',{app,element_index:'1',value:'rm -rf /'},config(['vivaldi'],mode)).code,'blocked-payload')
  }
  const code=`var a=await cua.getApp(${JSON.stringify(app)}); await a.getAXState(); var b=await cua.getApp("notepad@window:50:51:52");`
  assert.equal(checkAction('exec_cua_subset',{code},config(['vivaldi'])).code,'app-not-allowed')
})
test('malformed window selectors fail policy before native calls',()=>{
  for(const app of ['vivaldi@window:1:2','vivaldi@window:0:2:3','vivaldi@window:1:-2:3','vivaldi@window:1:2:3 trailing']) {
    assert.equal(checkAction('get_app_state',{app},config([],'open')).code,'invalid-window-selector')
  }
})
