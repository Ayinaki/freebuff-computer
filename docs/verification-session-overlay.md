# Persistent session overlay verification

Verified locally on Windows on 2026-10-08. No commit, push, or publication was performed.

## Change

The outline and custom cursor now persist across tool calls and model thinking pauses. `computer_session` provides begin, end, and status controls. Approved native activity also begins a session automatically. End hides the overlay and clears cached target geometry; disconnect removes its windows. Models must end the session when finished, blocked, cancelled, or handing control back. There is deliberately no short inactivity timeout.

The renderer uses a thin blue rounded border, one compact status capsule on the primary monitor, and a blue arrow with a white outline. Reads retain the last cursor position. Subsequent known targets animate before the driver action begins; reduced motion disables travel animation.

Session controls pass through `checkAction()`, accept only the documented literal action, and do not call the driver or change permissions. The exact advertised tool assertion now includes all 13 tools. The existing tools and restricted AST execution boundary remain intact.

## Commands and results

These are the individual verification commands; guards in the execution shell stopped later commands after failures unless explicitly noted.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | Final TypeScript check passed. |
| `npm test` | 0 | Final build and all 52 tests passed; zero failures, cancellations, or skips. Includes two new session-policy/cache tests. |
| `node scripts/verify-cua-subset.mjs explorer` | 0 | Fresh handshake advertised exactly 13 tools. Real read-only restricted call returned indexed Explorer nodes. Overlay ran on two monitors; session active/end state assertions passed. |
| `powershell.exe -NoProfile -NonInteractive -File scripts/preview-overlay.ps1` | 0 | Native renderer compiled and generated the neutral render preview. |
| `node scripts/verify-native-overlay.mjs` | 1 | Completed run verified persistent borders/cursor, animation, display rebuild, explicit end, and shutdown, but real-pointer preservation assertions failed. This check is not a pass. |
| `node scripts/verify-overlay-exit.mjs` | 0 | Independently verified that both overlay windows disappear after its own test host is killed. |
| `git diff --check` | 0 | No whitespace errors in tracked changes; Git emitted line-ending notices. |

Earlier native-overlay attempts also exited 1: two detected real-pointer movement, and one detected insufficient opaque blue border pixels. The border raster alignment was corrected; the completed run measured two blue border rows on each monitor. One guarded exit-cleanup check did not run after that earlier border failure; it was subsequently run independently and passed.

The completed native probe measured a four-second idle period with both borders still visible, cursor retention across reads, approximately 429 ms travel to the next target, and disappearance after explicit end. Focus remained unchanged in that completed run. The real pointer changed from the baseline during the interactive desktop run, so pointer preservation remains unverified; the script retained the failures and exited 1. It aggregates these failures only so the remaining lifecycle checks can still run.

## User integration evidence and remaining limits

The user's Freebuff transcript confirmed real MCP calls opened a new Vivaldi tab, searched Google for `Freebuff computer test`, and observed the results while preserving the six existing tabs. The user also directly observed the old overlay flashing between calls. That successful browser run preceded this persistent-session update; it is not evidence that Freebuff has loaded or followed the new session controls.

Reconnect the Freebuff MCP server to load the new build and tool schema, then repeat the browser task with explicit session begin/end instructions. End-to-end Freebuff verification of the updated visual experience remains outstanding. Mixed-DPI behavior and a new packed-install check for this update were not run. The generated preview is a neutral render, not a capture of the user's desktop or proof of live behavior.
