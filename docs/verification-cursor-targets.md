# Window-relative cursor and action status correction

Verified on Windows, 2026-10-08. No new dependencies, commit, push, or publication.

## User evidence and root causes

The user confirmed the persistent-session version worked through Freebuff. Their transcript used
`computer_session`, `list_apps`, `get_app_state`, `click`, `set_value`, and `press_key`; it opened a
Google results tab while preserving seven existing tabs. They then reported a misplaced cursor,
an irrelevant blue rectangle, and a status label that seemed stuck on Thinking.

The actual trajectory corroborated the defects: the click aimed at the raw window-relative
rectangle `(1048, 6, 30, 30)`, then `set_value` had no geometry because the server discarded the
fresh snapshot returned by the click. The renderer kept the old marker visible. Every action
completion replaced its label with Thinking, despite the server having no model-thinking signal.

**Correction to the earlier handoff/prototype assumption:** raw Windows driver `Frame` values
are not physical desktop coordinates. A 1:1 scale alone does not establish a correct mapping;
the app window's origin must also be applied. The old synthetic pixel probe proved rendering
at its supplied coordinates, not agreement with a real app element. The new live test independently
measures a real element's physical UI Automation bounds and checks cursor pixels there.

## Changes

- Match the snapshot's process ID, exact window title, and dimensions to one visible native
  window. Add its physical origin to the relative element rectangle. Do not select among
  ambiguous matches, guess missing identity, or scale a resized window's stale snapshot.
- Suppress the cursor when the element is covered or its window is minimized; stop an active
  marker if the window moves, changes size, or becomes covered. Background driver actions remain
  available; the overlay does not activate an app or move the real pointer.
- Preserve fresh post-action snapshot geometry for subsequent indexed calls. Plain
  acknowledgements, errors, session end, and display changes still invalidate cached geometry.
- Replace the large blue arrow with a small rounded dark arrowhead and white outline, using
  the user's reference image as the visual direction. Its tip marks the element centre. Remove
  the rectangular target highlight. A successful click has a brief pulse; reduced motion
  disables travel and pulse. Completed pointers disappear after 800 ms; new observations,
  failures, and actions without a located target clear them immediately. The session border stays.
- Show observable actions and outcomes: Reading app / View captured, Clicking / Click sent,
  Setting text / Text set, Sending key / Key sent, and specific failures. Do not invent a
  Thinking state. Typed payloads and keys are excluded. Window titles travel only over the
  private native channel for matching, never into the displayed label or activity log.

All existing tool names and policy checks remain intact. There are still exactly 13 tools.

## Checks

| Command | Exit | Evidence |
| --- | --- | --- |
| `npm run typecheck` | 0 | TypeScript passed. |
| `npm test` | 0 | All 55 tests passed, zero skipped. Three new tests cover window identity, action labels, and post-action snapshot reuse; existing assertions remain. |
| `powershell.exe -NoProfile -NonInteractive -File scripts/preview-overlay.ps1` | 0 | Compiled native renderer and generated the preview; visually inspected once. |
| `node scripts/verify-window-target.mjs vivaldi` | 0 | Read-only real driver snapshot, independent physical UIA measurement, native window resolution and real cursor pixels agreed. No click or other input was sent. |
| `node scripts/verify-native-overlay.mjs` | 0 | Both monitor borders, dark/white cursor, absence of the old box, transparency, window flags, status labels, display rebuild, four-second session persistence, stale-pointer clearing, animation, explicit end and shutdown passed. Focus and real pointer were unchanged. |
| `node scripts/verify-overlay-exit.mjs` | 0 | Both overlay windows disappeared after abruptly terminating the test-owned host. |
| `node scripts/verify-cua-subset.mjs explorer` | 0 | Final fresh MCP handshake asserted all 13 tools; a real read-only restricted call and session begin/end state checks passed with two overlay monitors. |
| `git diff --check` | 0 | No whitespace errors in tracked changes; Git emitted line-ending notices. |

The real Vivaldi measurement was:

```text
window bounds       x=1273, y=0, width=1294, height=1399
New Tab driver rect x=412,  y=6, width=30,   height=30
physical UIA rect   x=1685, y=6, width=30,   height=30
rendered cursor tip x=1700, y=21
dark cursor pixels  77 (plus the white edge)
```

The live test also refused to paint a pointer for missing identity, the wrong process, stale
dimensions, and a mismatched title. The general pixel probe measured 77 dark cursor pixels,
39 white pixels, zero target-box pixels, two blue border samples per monitor, and approximately
411 ms cursor travel. Its old assertions requiring a blue cursor and target rectangle were
replaced with positive checks for the requested dark/white cursor and absence of the removed
rectangle. No checks were skipped or errors swallowed to obtain a pass.

## Relationship to the installed Computer Use plugin

This comparison uses the installed `computer-use` plugin version `26.930.61225`, specifically
its `skills/computer-use/SKILL.md`, `docs/guidance.md`, and `docs/api.md`. The prior research was
not redone, and no private rendering implementation was inferred.

Both systems can observe screenshots and indexed accessibility trees, act on an element or a
coordinate, and refresh state to verify the result. Freebuff already passes through the driver's
screenshots; its indexed actions are not derived solely from screenshot interpretation.

The current OpenAI Windows plugin exposes `@oai/sky` through a persistent JavaScript session.
Its documented workflow selects an explicit returned window and uses screenshot IDs for
screenshot-backed coordinate actions. It documents UI Automation, SendInput, Windows.Graphics.Capture,
and automatic target-window activation for input. Freebuff uses the separate `open-computer-use`
driver with background UIA/window-message actions, an app-oriented contract, a policy-enforced
restricted code subset, and our own renderer. Similar interaction concepts do not make these
the same implementation. The user-supplied cursor screenshot guides appearance; the native
OpenAI overlay source and its internal lifecycle are not available here.

## Limits

The updated visuals still require a Freebuff MCP reconnect and a user-run end-to-end retest.
The successful Freebuff transcript above predates this correction. No new browser mutation was
performed during this repair. Real mixed-DPI, physical monitor hot-plug, and non-Windows rendering
remain unverified. Coordinate-only actions without a verified screenshot transform intentionally
do not get a guessed pointer. No new packed-install or hosted CI run was performed for this update.
