# Current implementation and remaining verification

Updated October 12, 2026. This supplements the original HANDOFF.md baseline;
verification records retain earlier failures and the subsequent fixes.

## Implemented and verified

- Exactly 13 MCP tools: the original nine, computer_doctor, computer_policy,
  exec_cua_subset and computer_session. The exact tool-set assertion remains.
- Restricted code is parsed into a complete literal action list, preflighted
  through policy, then dispatched through the native driver. Submitted source
  never enters the unrestricted Node evaluator. Acorn was explicitly approved.
- Persistent monitor outlines, action labels and a synthetic cursor that starts
  in the primary display centre, remains visible between actions, glides to
  measured click targets and clears at session end. Coordinate and indexed
  targets use validated window identity. Pixel checks cover actual rendering.
- Bundled Windows driver enumerates windows separately within a process, refuses
  ambiguous/stale selectors and keeps indexed state bound to the selected window.
  The user approved patching and bundling this driver and Go as a build requirement.
- Background UIA mutations use AutoSetFocus=false. Disposable-window tests prove
  actual edits, typing, mapped UIA patterns, sibling isolation and unchanged
  foreground/pointer for those exercised operations. These are bounded results,
  not a guarantee about every third-party accessibility provider.
- Local package installation and a fresh MCP handshake passed. Package users need
  no Go installation. Source builds need Go; external-driver overrides remain.

Every mutating tool result now ends with one `[verification: ...]` line separating dispatch from
observed effect, because the driver reports success whenever a call did not throw. A `set_value`
value is read back, an action that moved nothing is re-read once after 250 ms, and a batch reports
per-action outcomes. `computer_policy` writes the config file rather than announcing a mode a
restart forgets. Evidence: [action verification](verification-action-verification.md). This does
not fix modifier delivery or drag acceptance, and it does not detect a change below the node the
model read; it makes both failures reportable instead of silent.

Drag-path feedback is now implemented and verified in normal/reduced-motion modes; see [drag cursor checks](verification-drag-cursor.md). The subsequent live drag test failed on Windows Forms: movement arrived without held-button state.

Evidence: [multi-window and input checks](verification-multiwindow.md),
[coordinate cursor](verification-coordinate-cursor.md),
[persistent cursor](verification-persistent-cursor.md),
[restricted code](verification-cua-subset.md), and
[package/overlay installation](verification-overlay-install.md).

The latest recorded full suite passed 66 Node tests with no skips plus the native
Go tests. Typecheck passed. The final hands-off multi-window rerun exited 0:
foreground HWND 1511510 and real pointer (-545,76) were unchanged.

A clean source copy with no dist or node_modules also passed npm ci --offline,
npm run typecheck, npm test (62 Node tests plus Go), and node dist/cli.js doctor,
each exit 0. Its directory was
C:/Users/Ayin/AppData/Local/Temp/fbc-clean-source-87eb5c22b74c4a1ba8281bbff81f6a19.
This was a copy of the uncommitted source, not proof of a fresh remote Git clone.
Offline installation used the local dependency cache.

Optional foreground input is now implemented with explicit user approval. Background remains the default. A real foreground drag passed; the expanded shortcut/right-click run stopped on a focus check and the user deferred its rerun. See [foreground verification](verification-foreground-input.md) for scope, startup configuration and exact results.

## Still incomplete or unverified

- Advanced practice-page flow through Freebuff with both browser windows open.
  Earlier user reports verified Google search and explicit session begin/end.
  Use advanced-test-prompt.md for the broader run; inspect every browser window.
- Real mixed-DPI rendering. Current measured displays both report scale 1.
- Actual drag acceptance fails in the new Windows Forms fixture (12 move events, no held-button state). The existing
  drag contract explicitly warns that it may move the physical pointer.
- Modifier shortcuts: ctrl+t still does not open a tab, because the browser ignores the posted
  window messages. It now returns `[verification: unchanged]` instead of claiming success, which
  makes the delivery gap visible but does not close it.
- Change detection is bounded by the nodes the model read, so a redraw that leaves the
  accessibility tree identical (canvas, 3D, video) still reports no observable change.
- Offscreen/occluded screenshots: desktop capture can include overlapping windows.
- Virtualized-list coverage and broad third-party accessibility compatibility.
- Hosted CI execution, Windows arm64 execution, and macOS/Linux live verification.
  Building an arm64 binary is not evidence of running it.
- Publication is not authorized. Local installation works; npm-based examples
  requiring a published release are not yet a distribution path.

No commit, push or publication has been performed. Do not discard untracked work.
The overall goal remains incomplete while these functional and verification gaps
remain; a narrow passing fixture does not establish complete desktop control.
