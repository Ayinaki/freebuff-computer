# Screenshot capture, scale and budget verification

Verified locally on Windows on 2026-10-28. No commit was made before this record.

## Change

`get_app_state` used to return a full-window PNG on every read and on every action, captured with
`Graphics.CopyFromScreen`. That is expensive twice over: the image is a screen copy, so a covered
window returns whatever is covering it, and there is no budget or switch, so a helper click cost the
same pixels as a deliberate look.

What changed:

- The bundled driver captures with `PrintWindow(PW_RENDERFULLCONTENT)` first, validates that the
  bitmap is not a single flat colour, and falls back to a screen copy. The method is reported.
- Captures are downscaled to a maximum dimension (1280 by default). The outline states the image
  size, the window size, the scale between them, and the method:
  `Screenshot: 1280x960 from 1600x1200 (scale 0.8, printwindow)`.
- `include_screenshot` lets the wrapper skip a capture entirely on a driver that advertises it.
  Action results no longer carry an image by default, because verification compares text.
- `click` and `drag` coordinates are in the image's pixel space. `toWindowPoint` divides by the
  reported scale before the driver posts input, and the overlay cursor divides by the same factor so
  it points at the place the click landed.
- New tool `computer_screenshot` captures without re-reading or renumbering the tree, saves the PNG
  under `<state>/screenshots/`, and enforces `maxScreenshotBytes` by shrinking and then refusing.
- `get_app_state` takes `screenshot: auto | always | never`. `auto` captures when the tree has fewer
  than eight nodes, on the first read of a window, or after an action that changed nothing visible.

## Commands and results

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | Passed. |
| `npm test` | 0 | 103 Node tests, zero failures, plus the native Go tests. |
| `node dist/cli.js doctor` | 0 | Status OK, contract matches. |
| `node scripts/verify-screenshot-capture.mjs` | 0 | Real window captured: 640x338 from 3640x1923, scale 0.1758, method `printwindow`, 317 KB PNG with a valid PNG header. The same window read with `include_screenshot: false` returned no image block and no `Screenshot:` line. |

The Go tests cover the conversion directly, including the identity case and a scale of 0:

| Case | Input | Output |
| --- | --- | --- |
| no scaling | (100, 50), scale 1 | (100, 50) |
| unknown scale | (100, 50), scale 0 | (100, 50) |
| 1280 image of 1600 | (800, 480), scale 0.8 | (1000, 600) |
| 1280 image of 2560 | (640, 480), scale 0.5 | (1280, 960) |

Node tests cover the wrapper side: `auto` inclusion rules (first read, thin tree, after a dead
action), `never` and `always`, stripping an image the model did not ask for, the byte budget with a
bounded number of shrink attempts, saving to disk, and the cursor remap at scale 0.8.

## What this does not establish

- **That a Freebuff model receives the image.** MCP permits an image content block in a tool result;
  whether a host forwards it is a host property. The measured run above proves the driver produces a
  correct PNG and states its geometry. It does not prove delivery into a chat.
- **Mixed-DPI capture.** The measured desktop reports scale 1 on both monitors. The capture compares
  its bitmap against the window rectangle before reporting a scale, but no mixed-DPI run exists.
- **A live coordinate round trip.** The conversion is unit-tested and the cursor remap is unit-tested;
  no disposable-window fixture clicks a downscaled coordinate and reads the hit point back yet.
- **PrintWindow for every app.** One real window (the Windows shell) captured through PrintWindow. A
  GPU-composited app can refuse it, which is why the fallback exists and reports itself.
