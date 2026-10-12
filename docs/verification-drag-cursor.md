# Drag cursor verification

October 12, 2026.

The overlay now resolves both drag endpoints from the same exact-window snapshot.
Both must be in bounds. The native renderer checks identity, geometry, visibility
and endpoint occlusion before moving to the start. A separate dispatch event moves
the synthetic cursor toward the destination while the native driver call runs.
A small held-button ring remains until completion or failure. Reduced-motion mode
keeps the held feedback and endpoint placement without spatial animation.

Errors interrupt pending motion and release the held state. Session end and display
changes also clear it. Invalid start resolution prevents destination-only motion.
Policy still runs before any activity or driver input; the exact tool set is unchanged.

This is visual feedback for a requested drag, not telemetry from native mouse events.
The native driver does not report per-step input timing. A painted destination does
not prove an application accepted a drop; agents must observe the result afterward.

Checks run:

| Command | Exit | Evidence |
| --- | --- | --- |
| npm run typecheck | 0 | TypeScript passes. |
| npm test | 0 | 64 Node tests, zero skips, and native Go tests pass. New integration test covers concurrent dispatch, successful completion, returned and thrown driver errors, and audit refusal with zero events/calls. |
| node scripts/verify-coordinate-cursor.mjs | 0 | Paint-only disposable-window run checks start and destination positions, actual cursor pixels, elapsed movement, held state, release, interrupted motion and invalid-start refusal. |
| $env:FBC_REDUCED_MOTION='1'; node scripts/verify-coordinate-cursor.mjs | 0 | Same rendering assertions with reduced motion enabled. The environment override was confined to that test process. |
| node scripts/verify-installed.mjs . | 0 | Fresh MCP handshake from the current build advertises exactly 13 tools; nine-tool native contract, session rendering and cleanup pass. This invocation is not a fresh tarball install. |
| git diff --check | 0 | No whitespace errors. |

No actual drag input was sent in these live rendering checks. Real application
acceptance and physical-pointer preservation during native drag remain unverified.
Both monitors still report scale 1, so mixed-DPI rendering remains unverified.
No dependencies, commit or publication were added.

## October 12: actual drag acceptance fails

A new disposable fixture uses standard Windows Forms MouseDown, MouseMove and
MouseUp events. It accepts a drop only after movement with the left button held
from its source rectangle to the destination. It does not interpret native message
flags itself or substitute a weaker check for the framework event state.

`node scripts/verify-drag-input.mjs` exited **1** on both runs. The second run added
failure diagnostics, retaining the original acceptance condition. The driver
returned success, but the observed app state was:

    Drag state: missed; moves=0 all=12 buttons=None at=275,115

All 12 movement events and the correct release coordinates arrived. No move event
reported the left button held. Actual drop acceptance is therefore **failed**, not
merely unverified. Later sibling/focus/pointer assertions were not reached and must
not be counted as passes. Test windows and the MCP connection were cleaned up.

The bundled Send-Drag implementation posts mouse messages. Current Microsoft
Windows Forms source constructs MouseMove event arguments using the MouseButtons
property, rather than the message's button flag:
https://github.com/dotnet/winforms/blob/main/src/System.Windows.Forms/System/Windows/Forms/Control.cs
This is consistent with the measured failure; the fixture's actual runtime result
is the evidence for this machine, not an assumption that all app frameworks behave
identically.

The tool description now explicitly distinguishes dispatch from drop acceptance.
The regression remains failing and is kept as a separate interactive check, like
the other live desktop scripts. No existing assertion was weakened or suppressed.

A human decision is pending on an optional foreground-input mode. HANDOFF decision
6 requires background input by default. Real input must not be silently introduced
as a fallback, since it could take focus or move the user's pointer. The existing
background path and the policy boundary remain unchanged.
