# Action verification

October 12, 2026. An audit of the tool surface found one class of false success running
through every mutating tool, so this records what was changed and what was measured.

## The finding

The bundled Windows runtime sets `ok = $true` after a dispatch does not throw: it posts the
input, sleeps a fixed 120 ms, and returns a fresh snapshot (`runtime.ps1`, the `press_key`
and other action branches). The Go layer turns that into a normal result, and `server.ts`
passed it straight through. A model therefore read `isError: false` as "the app did
something", while it only meant "the call returned".

That is exactly the recorded `ctrl+t` failure: the chord was posted as window messages, the
browser ignored all of them, and the tool reported success. `drag` already carried an honest
caveat in its description and was the only tool that did.

## The change

The wrapper cannot change what the driver reports, so it supplies the difference itself. It
already held both halves: the tree the model last read, and the tree returned with the
action.

- `src/overlay.ts` gained snapshot fingerprints and a value readback. Fingerprints are
  bounded projections of node lines only, so a snapshot rendered at the model's tree limits
  can be compared with one rendered at the driver's defaults. Rendered identity, not the
  node index, is what a value is matched on, because an action renumbers nodes.
- `src/server.ts` appends exactly one `[verification: ...]` line to every mutating result,
  reads a value back for `set_value`, and re-reads the window once (250 ms later) when
  nothing appears to have moved.
- `src/cua-subset.ts` reports a batch summary, because a mutating step's result is never
  echoed and its verification line would otherwise be invisible.
- `computer_policy` now writes the config file instead of announcing a mode that a restart
  forgets, and `computer_session` says plainly when nothing on this platform can paint.
- Tool descriptions now state what is guaranteed and what is not, including that a modifier
  chord, value-based typing, the wheel-message scroll fallback and a coordinate click are
  dispatch, not effect.

No file under `vendor/` changed, so the pinned upstream driver needs no patch replayed.

## Checks run

| Command | Exit | Evidence |
| --- | --- | --- |
| `npm run typecheck` | 0 | TypeScript passes. |
| `npm test` | 0 | 81 Node tests, zero skips, plus the native Go tests. 15 are new and cover change detection, value readback, the bounded re-read, policy persistence, session honesty, and the thirteen-tool surface. |
| `node dist/cli.js doctor` | 0 | Status OK, `contract all 9 tools match`, bundled driver present. |
| `node scripts/verify-cua-subset.mjs` | 0 | Real MCP handshake asserting all thirteen tools, read-only app discovery through the restricted subset, overlay lifecycle. |
| `node scripts/verify-multiwindow.mjs` | 0 | The existing regression still passes: two disposable windows, equal-index edits, restricted-code routing, forged-identity refusal, hard blocks, and foreground focus HWND 5177396 with the pointer at (1064,228) unchanged. |
| live no-op against a disposable fixture | 0 | See below. |

## Live evidence

A temporary script drove the real driver through the real MCP stdio path against two
disposable, test-owned PowerShell windows, the same fixture the multi-window regression
uses. It was deleted after the run; nothing was sent to any app the user has open.

```
no-op press_key -> [verification: unchanged] the action was dispatched, but this window's
                   accessibility tree is unchanged even after a re-read. The app may have
                   ignored the input. Read a fresh snapshot before repeating it.
real click     -> [verification: changed] the window tree changed after click.
set_value      -> [verification: confirmed] the element now reads back the requested value.
```

The no-op was a key the fixture does not handle, and the click was a real toggle whose
scripted result changed from `Care: off` to `Care: on`. So the distinction this change is
for is observable on a real desktop, not only against a stub.

## Limits

- Change detection cannot tell "the app ignored the input" from "the app reacted without
  altering the accessibility tree". A canvas or 3D view that redraws reports `unchanged`.
  The signal is therefore evidence about the tree, and the wording never claims more.
- Comparison is bounded by the node count of the snapshot the model read. A change below
  that cut is invisible and is reported as `unchanged`, not as "nothing happened".
- The 120 ms sampling delay still exists in the driver. The re-read narrows the race; it
  does not remove it, and it costs one extra driver round trip on an unchanged action.
- `type_text` has no `element_index` in the tool contract, so it has no element to read a
  value back from. It is verified from the tree alone. The earlier plan to read `type_text`
  back was dropped for this reason.
- Verification was exercised against a disposable fixture and a scripted driver. It has not
  been run against the user's own apps, and it does not fix drag acceptance or modifier
  delivery, which both remain open.

No commit, push or publication was performed. Existing untracked work is preserved.
