import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compactSnapshot, estimateTokens, formatBytes } from '../dist/compact.js'

const FRAME_SAME = 'Frame: {x: 0, y: 0, width: 800, height: 600}'
const FRAME_INNER = 'Frame: {x: 10, y: 10, width: 60, height: 20}'

function lines(out) {
  return out.split('\n')
}

test('preserves every element index and its order', () => {
  const raw = [
    'App=Demo (pid 1)',
    'Window: "Demo", App: Demo.',
    `0 window Demo ${FRAME_SAME}`,
    `\t1 group  ${FRAME_SAME}`,
    `\t\t2 button Save ${FRAME_INNER}`,
    `\t\t3 button Cancel ${FRAME_INNER}`,
    `\t\t\t4 text "a label" ${FRAME_INNER}`,
    `\t5 edit Name Value: hello ${FRAME_INNER}`,
  ].join('\n')

  const { text } = compactSnapshot(raw, { maxBytes: 1024 * 1024 })
  const indexes = lines(text)
    .map((l) => /^(\t*)(\d+)\s/.exec(l))
    .filter(Boolean)
    .map((m) => Number(m[2]))

  assert.deepEqual(indexes, [0, 1, 2, 3, 4, 5], 'indexes must survive compaction untouched and in order')
})

test('drops a Frame that is inherited from the parent and keeps a distinct one', () => {
  const raw = [
    'App=Demo (pid 1)',
    'Window: "Demo", App: Demo.',
    `0 window Demo ${FRAME_SAME}`,
    `\t1 group  ${FRAME_SAME}`,
    `\t\t2 button Save ${FRAME_INNER}`,
  ].join('\n')

  const { text } = compactSnapshot(raw, { maxBytes: 1024 * 1024 })

  assert.ok(lines(text)[2].includes('Frame:'), 'root frame is the reference and must be kept')
  assert.ok(!lines(text)[3].includes('Frame:'), 'child inheriting the parent frame must drop it')
  assert.ok(lines(text)[4].includes('Frame:'), 'a different frame must be kept')
})

test('drops the only-noise ScrollIntoView action but keeps mixed actions', () => {
  const raw = [
    'App=Demo (pid 1)',
    `0 window Demo Secondary Actions: ScrollIntoView ${FRAME_SAME}`,
    `\t1 edit Name Value: hi Secondary Actions: SetValue, ScrollIntoView ${FRAME_INNER}`,
  ].join('\n')

  const { text } = compactSnapshot(raw, { maxBytes: 1024 * 1024 })

  assert.ok(!lines(text)[1].includes('Secondary Actions'), 'a lone ScrollIntoView carries no information')
  assert.ok(lines(text)[2].includes('Secondary Actions: SetValue, ScrollIntoView'), 'mixed actions must survive')
})

test('preserves role, name and value text verbatim', () => {
  const raw = [
    'App=Demo (pid 1)',
    `0 window Demo ${FRAME_SAME}`,
    `\t1 edit Address and search bar Value: https://example.com/a?b=c ${FRAME_INNER}`,
  ].join('\n')

  const { text } = compactSnapshot(raw, { maxBytes: 1024 * 1024 })
  assert.ok(text.includes('edit Address and search bar Value: https://example.com/a?b=c'))
})

test('truncates at the byte cap and says so explicitly', () => {
  const raw = [
    'App=Demo (pid 1)',
    ...Array.from({ length: 400 }, (_, i) => `${i} button ButtonNumber${i} ${FRAME_INNER}`),
  ].join('\n')

  const result = compactSnapshot(raw, { maxBytes: 512 })

  assert.equal(result.truncated, true)
  assert.ok(result.omittedNodes > 0, 'omitted nodes must be counted')
  assert.ok(result.text.includes('[snapshot truncated by Freebuff Computer'), 'truncation must be visible to the model')
  assert.ok(result.text.includes('max_tree_nodes'), 'truncation must tell the model how to get the rest')
  assert.ok(result.compactedBytes < result.originalBytes)
})

test('never renumbers when truncating: surviving indexes are a prefix', () => {
  const raw = [
    'App=Demo (pid 1)',
    ...Array.from({ length: 200 }, (_, i) => `${i} button B${i} ${FRAME_INNER}`),
  ].join('\n')

  const result = compactSnapshot(raw, { maxBytes: 400 })
  const indexes = result.text
    .split('\n')
    .map((l) => /^(\d+)\s/.exec(l))
    .filter(Boolean)
    .map((m) => Number(m[1]))

  assert.ok(indexes.length > 0)
  for (let i = 0; i < indexes.length; i += 1) {
    assert.equal(indexes[i], i, `index ${i} must appear in position ${i}`)
  }
})

test('header lines pass through untouched', () => {
  const raw = ['App=Demo (pid 1)', 'Window: "Demo", App: Demo.', `0 window Demo ${FRAME_SAME}`].join('\n')
  const { text } = compactSnapshot(raw, { maxBytes: 1024 * 1024 })
  assert.equal(lines(text)[0], 'App=Demo (pid 1)')
  assert.equal(lines(text)[1], 'Window: "Demo", App: Demo.')
})

test('reduces a synthetic large tree substantially', () => {
  // Mimics a real toolkit dump: every node repeats its inherited frame, and
  // nearly every node advertises the same ScrollIntoView action.
  const raw = [
    'App=Big (pid 7)',
    `0 window Big ${FRAME_SAME}`,
    ...Array.from(
      { length: 600 },
      (_, i) => `\t${i + 1} ${i % 3 === 0 ? 'button' : 'group'} Label${i} Secondary Actions: ScrollIntoView ${FRAME_SAME}`,
    ),
  ].join('\n')

  const result = compactSnapshot(raw, { maxBytes: 10 * 1024 * 1024 })

  assert.equal(result.truncated, false)
  assert.ok(
    result.savedBytes > result.originalBytes * 0.5,
    `expected to save more than half, saved ${result.savedBytes} of ${result.originalBytes}`,
  )
  assert.equal(result.compactedBytes, Buffer.byteLength(result.text, 'utf8'))
})

test('estimateTokens and formatBytes behave', () => {
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('a'.repeat(400)), 100)
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(2 * 1024 * 1024), '2.00 MB')
})
