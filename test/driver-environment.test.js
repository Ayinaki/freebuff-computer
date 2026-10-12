import {test} from 'node:test'
import assert from 'node:assert/strict'
import {backgroundTypingEnvironment} from '../dist/driver.js'

test('background value typing is enabled only for the bundled Windows driver',()=>{
  assert.equal(backgroundTypingEnvironment('win32',{}).OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK,'1')
  assert.equal(backgroundTypingEnvironment('win32',{FBC_DRIVER_CMD:'ocu mcp'}),undefined)
  assert.equal(backgroundTypingEnvironment('linux',{}),undefined)
  assert.equal(backgroundTypingEnvironment('darwin',{}),undefined)
})
test('explicit human opt-out of value-based typing is retained',()=>{
  assert.equal(backgroundTypingEnvironment('win32',{OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK:'0'}).OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK,'0')
})

test('foreground input requires an explicit valid startup setting for the bundled driver',()=>{
  assert.equal(backgroundTypingEnvironment('win32',{}).FBC_INPUT_MODE,'background')
  assert.equal(backgroundTypingEnvironment('win32',{FBC_INPUT_MODE:'foreground'}).FBC_INPUT_MODE,'foreground')
  assert.equal(backgroundTypingEnvironment('win32',{FBC_INPUT_MODE:'background'}).FBC_INPUT_MODE,'background')
  assert.throws(()=>backgroundTypingEnvironment('win32',{FBC_INPUT_MODE:'foregound'}),/must be background or foreground/)
  assert.equal(backgroundTypingEnvironment('win32',{FBC_DRIVER_CMD:'custom',FBC_INPUT_MODE:'foreground'}),undefined)
})
