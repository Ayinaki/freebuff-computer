// A screenshot is only useful if the model can trust two numbers: how big the
// image is, and how to get from its pixels back to the window's. This checks the
// bundled driver on a real window, read-only.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const { ComputerDriver } = await import('../dist/driver.js')

const driver = new ComputerDriver()
const HEADER = /^Screenshot: (\d+)x(\d+) from (\d+)x(\d+) \(scale ([0-9.]+), ([a-z]+)\)$/m

try {
  const listing = await driver.callTool('list_apps', {})
  const text = listing.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
  const candidates = [...text.matchAll(/^(\S+)\s/gm)].map((match) => match[1]).slice(0, 6)
  assert.ok(candidates.length > 0, `no app to read: ${text.slice(0, 200)}`)

  // Pick the largest window available: a capture smaller than the requested
  // dimension would never exercise the downscale path this check exists for.
  let app = candidates[0]
  let largest = 0
  for (const candidate of candidates) {
    const probe = await driver.callTool('get_app_state', {
      app: candidate,
      include_screenshot: false,
      max_tree_nodes: 4,
      max_tree_depth: 3,
    })
    if (probe.isError) continue
    const probeText = probe.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
    const frame = /Frame: \{x: -?[\d.]+, y: -?[\d.]+, width: ([\d.]+), height: ([\d.]+)\}/.exec(probeText)
    const size = frame === null ? 0 : Math.max(Number(frame[1]), Number(frame[2]))
    if (size > largest) {
      largest = size
      app = candidate
    }
  }
  assert.ok(largest > 640, `no window larger than 640 pixels was available (largest ${largest})`)

  const withImage = await driver.callTool('get_app_state', {
    app,
    include_screenshot: true,
    screenshot_max_dimension: 640,
    max_tree_nodes: 40,
  })
  assert.equal(withImage.isError, false, JSON.stringify(withImage.content))

  const body = withImage.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
  const match = HEADER.exec(body)
  assert.ok(match, `the outline must state the image size and scale, got: ${body.split('\n').slice(0, 5).join(' | ')}`)
  const [imageWidth, imageHeight, windowWidth, windowHeight, scale, capture] = [
    Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), match[6],
  ]
  assert.ok(['printwindow', 'screen'].includes(capture), `unknown capture method ${capture}`)
  assert.ok(scale > 0 && scale <= 1, `scale must be a fraction of the window, got ${scale}`)
  assert.ok(Math.abs(imageWidth - windowWidth * scale) <= 2, `${imageWidth} != ${windowWidth} * ${scale}`)
  assert.ok(Math.abs(imageHeight - windowHeight * scale) <= 2, `${imageHeight} != ${windowHeight} * ${scale}`)
  assert.ok(Math.max(imageWidth, imageHeight) <= 640, 'the requested dimension must be respected')

  const image = withImage.content.find((block) => block.type === 'image')
  assert.ok(image, 'the driver must return an image block when asked')
  const bytes = Buffer.from(String(image.data), 'base64')
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'the payload must be a real PNG')
  assert.equal(image.mimeType, 'image/png')

  const withoutImage = await driver.callTool('get_app_state', { app, include_screenshot: false, max_tree_nodes: 40 })
  const quiet = withoutImage.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
  assert.equal(withoutImage.content.some((block) => block.type === 'image'), false, 'include_screenshot=false must not capture')
  assert.doesNotMatch(quiet, /^Screenshot:/m, 'a text-only read must not claim an image')

  console.log(
    `PASS: ${app} captured ${imageWidth}x${imageHeight} from ${windowWidth}x${windowHeight} ` +
    `(scale ${scale}, ${capture}, ${Math.round(bytes.length / 1024)} KB); a text-only read carries no image`,
  )
} finally {
  await driver.close()
}
