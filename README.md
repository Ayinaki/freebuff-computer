# Freebuff Computer

Computer Use for Freebuff agents. It gives an agent the ability to see and operate the computer it
is running on — real windows, real apps, real clicks — instead of being limited to files, shell
commands, and APIs. The tool surface is deliberately the same shape as Codex's computer use, so the
prompt habits and workflows that work there transfer here, and the native effector underneath is an
existing open-source driver rather than a reimplementation.

## Requirements

- **Node 18 or newer** (the same Node that runs Freebuff is fine).
- **Windows:** the package includes a patched open-computer-use driver for x64 and arm64.
  Building this repository needs **Go 1.22+** in addition to Node. Installing a packed package
  needs no Go installation. Source and MIT license are in `vendor/open-computer-use-windows`.
- **macOS/Linux:** install the external driver once:

  ```bash
  npm install -g open-computer-use
  ```

Platform notes:

- **macOS 14+** — grant **Accessibility** and **Screen Recording** to the driver when prompted.
  Without both, actions are refused or the accessibility tree comes back empty.
- **Windows** — must be running inside the signed-in desktop session. A service, a Session 0
  context, or an SSH session without a desktop cannot drive UI.
- **Linux** — needs AT-SPI enabled (default on GNOME, KDE, Xfce) and either an X11 display or an
  XWayland bridge for Wayland sessions.

Actions are delivered in the background: the agent's clicks and keystrokes are routed to the target
app without moving your cursor or stealing keyboard focus, so you can keep working while it does
its thing. Two honest exceptions: `drag` on Windows drives a window-server drag and can move the
real pointer, and some custom-drawn apps (games, 3D and video tools) expose no accessibility nodes
and need a brief foreground activation to accept input.

Windows accessibility clients enable automatic focus by default. The bundled driver disables
that setting for its accessibility actions. The two-window WPF regression now passes with
foreground focus and the real pointer unchanged. An app can still implement its own activation
behavior, so this is evidence for the tested path, not a guarantee for every app.
See [multi-window verification](docs/verification-multiwindow.md) for the evidence and limits.

## Optional foreground input on Windows

Background input remains the default. If an app requires real mouse-button or
modifier-key state, a human can add `"FBC_INPUT_MODE": "foreground"` to the
Freebuff MCP registration's `env` object, then restart that MCP connection.
Remove the setting or set it to `"background"` to return to background input.
No agent tool can change this startup setting.

Foreground mode currently uses real Windows input for drags, key combinations and
coordinate/window-message clicks. Accessibility clicks, set-value, value-based
typing and scrolling retain their existing paths. This is not a universal
foreground replacement for every tool. It applies only to the bundled Windows
driver; external drivers retain their own configuration.

The overlay displays **Foreground**, and `computer_doctor` reports the mode.
Real input can take focus and move your mouse. The driver refuses input while a
mouse button or modifier is already held, stops if focus changes, and checks that
pointer targets remain visible in the selected window. It attempts to release
every button/key it pressed even on failure. Windows may deny activation or input
to elevated apps; the driver reports that failure instead of bypassing it.
Policy allowlists, audit mode and hard blocks still apply.

The first disposable-window foreground drag test passed. Expanded shortcut and
right-click verification is recorded in
[foreground verification](docs/verification-foreground-input.md).
Background drag remains incompatible with the tested Windows Forms control.

## Install and wire into Freebuff

### From this repository (works today)

This repository ships a project-local MCP registration at `.agents/mcp.json`. Build the server
before opening the workspace in Freebuff:

```bash
git clone https://github.com/Ayinaki/freebuff-computer.git
cd freebuff-computer
npm install        # the prepare script runs the build, producing dist/
node dist/cli.js doctor  # confirm the driver is present and the contract matches
```

The entry Freebuff launches is:

```json
{
  "mcpServers": {
    "freebuff-computer": {
      "command": "node",
      "args": ["dist/cli.js", "server"]
    }
  }
}
```

`mcpServers` is the standard MCP file format. A registration file alone does not prove that the
server is available in a Freebuff chat: repository trust and connection review may still be
required. In the tested Desktop session, this project's entry was absent from the connected
tools. Adding an absolute-path entry to the user-level registration made it available for review;
approval and a new client session were still required before testing tool calls.

Check Freebuff's MCP settings for `freebuff-computer`, review and enable the connection, then
start a fresh chat. If it is not listed, run `node dist/cli.js setup` and register the printed
absolute-path entry through Freebuff's custom-server settings. If merging it manually into
`~/.agents/mcp.json`, preserve existing entries; do not edit `~/.freebuff/mcp.json`, the approval
store. The loader's directory precedence alone does not establish why a Desktop session omitted
a project registration.

Freebuff speaks MCP over stdio. `dist/` is gitignored, so a fresh clone needs the `npm install`
above first. Confirm that `computer_doctor`, `computer_policy` and `exec_cua_subset` are callable
in the actual chat before attempting desktop actions.

### Globally, from npm (once published)

```bash
npm install -g freebuff-computer
fbc setup
```

`fbc setup` writes a default config and checks for the driver. On macOS/Linux, add `--install-driver` to run
`npm install -g open-computer-use` for you. It prints an MCP entry using the absolute paths of
your Node executable and installed server. Add that output in Freebuff under
Connectors → add custom server, or save it in your workspace's `.agents/mcp.json`. For example:

```json
{
  "mcpServers": {
    "freebuff-computer": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/freebuff-computer/dist/cli.js", "server"]
    }
  }
}
```

**`freebuff-computer` is not yet published to npm**, so `npm install -g freebuff-computer` and the
`npx -y freebuff-computer` form both fail with a 404 today. Until it is published, use the repository
route above, or install straight from the checkout:

```bash
npm install -g .        # from inside the clone
```

The `agents/computer-use.ts` and `skills/computer-use/SKILL.md` files in this repository are drop-in
artifacts for the Freebuff repository itself — an agent definition that declares this server plus a
skill that describes the workflow. They are templates, not part of this package's build, and
`agents/computer-use.ts` is written for the Freebuff monorepo's import layout, so it is not loadable
as a user agent file from `.agents/` without the change described in
[Known gaps](#known-gaps).

For a standalone computer-use agent, run this from the checkout:

```bash
node dist/cli.js setup --agent-file .agents/computer-use.js
```

The generated agent imports no Freebuff-monorepo packages. It uses the installed Node executable
and this server's absolute path, so it works when launched from another working directory. Pass
`--model <provider/model>` to choose its model. Existing agent files are never overwritten.
The original `agents/computer-use.ts` remains the Freebuff-monorepo drop-in.

To make the computer tools available to ordinary Freebuff agents in another workspace, write
that workspace's registration instead:

```bash
node dist/cli.js setup --mcp-file /path/to/workspace/.agents/mcp.json
```

Restart Freebuff in that workspace and approve its repository trust prompt. The file uses this
installation's absolute paths. Setup never replaces an existing registration, so other connectors
stay intact. If the file already exists, run setup without file options and merge the printed
`freebuff-computer` entry into its `mcpServers` object. You can combine `--agent-file` and
`--mcp-file` when creating both files in a fresh workspace.

`fbc setup` now prints an MCP entry pointing at the current installation, so it needs no npm
publication. Regenerate the entry or agent file if you move this installation. It does not write
into `~/.freebuff/mcp.json`. That file is hash-verified by the Freebuff
client, so a hand-written entry there would be rejected; registering the server through the UI is
the supported path.

## Verify

```bash
fbc doctor
```

`fbc doctor` prints, in order:

- `driver binary` — the resolved path of `ocu` / `open-computer-use`, or `NOT FOUND` with the install
  command. `NOT FOUND` is the single most common cause of a broken setup.
- `status` — `OK`, `DEGRADED`, or `FAILED`.
- `driver server` — the driver's own name and version.
- `contract` — `all 9 tools match` when the installed driver still advertises every tool and
  parameter this server exposes, or `MISMATCH` when it has drifted. Because this project wraps a
  third-party driver, drift is reported loudly rather than turning into a tool that silently does
  nothing. A mismatch means: `npm install -g open-computer-use@latest`.
- `notes` — anything else worth acting on, for example stderr output from the driver, or a reminder
  that policy mode is `open`.
- `policy` — the active safety policy.

`fbc doctor` exits non-zero when something is wrong (status `FAILED`), so it is safe to use in a
setup script or a support conversation.

After you have used the agent for a while:

```bash
fbc stats
```

This summarises the recorded sessions: tool calls, refusals, and how many bytes of accessibility
snapshots were sent to the model versus how many were actually necessary. If a session felt slow or
expensive, this is where you find out why.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_apps` | List available apps; on Windows, each window has its own exact app selector, pid and title. |
| `get_app_state` | Read an app's accessibility tree as an indented outline. Every actionable node carries an `element_index`. |
| `click` | Click an element by `element_index`, or by x/y coordinates for surfaces with no accessibility node. |
| `set_value` | Set an editable control's value directly. Exact and atomic; preferred over typing. |
| `type_text` | Type literal text into the app that has keyboard focus. |
| `press_key` | Press a key or combination, such as `Return` or `ctrl+s`. |
| `scroll` | Scroll a container element by pages in a direction. |
| `drag` | Drag from one coordinate to another. |
| `perform_secondary_action` | Invoke a named accessibility action on an element, such as `SetValue` or `ExpandCollapse`. |
| `computer_doctor` | Report the health of the setup from inside the agent's own turn. |
| `computer_policy` | Read or change the safety policy. A change is written to the config file, so it survives a restart. |
| `exec_cua_subset` | Execute a statically enumerable batch written in a restricted `cua` JavaScript subset. |
| `computer_session` | Begin, inspect or end the persistent visual computer-use session. |

### Reading an action result

The driver reports that a dispatch did not throw, which is not the same as the app having
acted. Every mutating tool therefore ends its result with one line that says what could
actually be observed afterwards:

| Line | Meaning |
| --- | --- |
| `[verification: changed]` | The window's accessibility tree differs from the snapshot taken before the call. |
| `[verification: confirmed]` | `set_value` only: the element reads back the value that was requested. |
| `[verification: differs]` | `set_value` only: the element holds a different value, so the control clamped or rejected it. |
| `[verification: unchanged]` | The action was dispatched, but the tree is identical. The app may have ignored the input. |
| `[verification: unverified]` | There was nothing to compare against, or no new snapshot arrived. |

Detection is bounded by the nodes the model actually read, so `unchanged` means "nothing
changed in the part of the tree you saw", not "nothing happened". When a dispatch appears
to have moved nothing, the wrapper re-reads the window once after 250 ms, because the
driver samples a fixed instant after dispatch and a slow app has not repainted yet by
then. That extra read is recorded in the trajectory, so `fbc stats` shows what it cost.

`exec_cua_subset` never echoes a mutating step's own result, so its batch ends with a
`[verification: batch]` summary instead: a batch that changed nothing on screen must not
read as a successful one.

On Windows, `list_apps` returns one entry per visible top-level window. Copy the complete
selector, such as `vivaldi@window:16980:2033548:639270107124352414`, into the `app` argument.
Two windows of the same browser share a process but have separate snapshots and indexes.
Ambiguous bare names/PIDs are refused; closed or mismatched selectors never select a sibling
as a fallback. The allowlist still checks the app name or PID, not the window handle.
Inspect every relevant browser window before concluding a tab is absent. Restarting Freebuff
does not close browser tabs, but it does invalidate the MCP session's observations.

Windows value-based typing appends through the bundled background accessibility client when no native edit handle is available. It preserves whitespace but does not generate per-key events. Prefer indexed `set_value` when choosing among fields; use `press_key` separately to submit. Set `OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK=0` in the MCP environment to opt out.

The first nine names keep the native driver contract. This project adds diagnostics, policy
inspection, the restricted code surface and session visibility, for an exact total of thirteen tools.

### Restricted code surface

`exec_cua_subset` accepts a `code` string, for example:

```javascript
var app = await cua.getApp("Notepad");
var state = await app.getAXState({emit: false, maxTreeNodes: 40});
nodeRepl.write(state);
```

The goal is a statically enumerable action set: the server must know every native call and its
literal arguments before anything executes. Acorn parses the source into an AST; an allowlist
visitor translates accepted nodes into a complete action list. `src/policy.ts` checks every
action. If parsing, argument validation, or any policy check fails, **nothing in that batch runs**,
including earlier reads. Refusals identify the offending statement or action.

The server never forwards submitted source to `ocu js` or any JavaScript evaluator. It translates
the supported `cua` methods into the same native driver calls used by the structured tools. Both
surfaces share one persistent driver session, snapshot defaults, compaction, and trajectories.
This follows the driver's `cua` method shapes without exposing its unrestricted Node.js runtime.

Supported forms:

- `await cua.getApp("App")`, `await cua.listApps()`, and `await cua.getState()`.
- Awaited app methods: `getAXState`, `click`, `setValue`, `typeText`, `pressKey`, `scroll`, `drag`,
  and `performSecondaryAction`. Arguments must be literal strings, finite numbers, booleans,
  nulls, arrays, or plain objects, and must match the native tool's schema. Element indexes are
  strings; coordinate pairs use `[x, y]`.
- One `var`, `let`, or `const` binding per statement, initialized by an awaited app binding or
  observation. Bindings exist only within that batch; rebind the app in the next call.
- `nodeRepl.write(result)` or `nodeRepl.write(literal)`. Observation results are returned text,
  including for `listApps` and `getState`; this subset does not expose the adapter's result objects.
  Reads emit driver content by default. `emit:false` suppresses output on `getAXState`, `listApps`,
  and `getState`.
- Snapshot options: `textLimit`, `maxTreeNodes`, `maxTreeDepth`, `emit`. Click options:
  `mouseButton`, `clickCount`, `clickMethod`. The existing platform caveats still apply.

Loops, branches, functions, assignments, imports, computed properties, dynamic expressions,
spread, getters, and arbitrary globals are rejected. Screenshot helpers and `rewriteDocumentation`
are not supported. Each call allows at most 32,768 source characters and 128 statements.

Execution is sequential. A driver failure stops the remaining actions, but completed actions are
not rolled back. Batch calls are serialized with structured calls and policy changes. Plan actions
only from a fresh snapshot; when an action changes the UI, read again before choosing new indexes.

Acorn is a runtime dependency because parsing is part of the policy boundary. General JavaScript
requires a separate isolation provider and is outside this tool's scope.

To verify the exact MCP surface and perform a read-only demonstration against an already-open,
harmless app (replace `Notepad` with its actual name):

```bash
npm run typecheck
npm test
node scripts/verify-cua-subset.mjs Notepad
```

The verification script starts a fresh server in audit mode and asserts all thirteen tool names.
Without an app argument it lists apps through `exec_cua_subset`.

## Visible activity on Windows

The server starts a separate, click-through native overlay when an approved native call begins,
or when `computer_session` receives `{"action":"begin"}`. A thin blue border marks each monitor;
one compact status capsule on the primary monitor describes the action and its outcome: Reading
app / View captured, Clicking / Click sent, Setting text / Text set, Sending key / Key sent, or
a specific failure. It does not pretend to know whether the model is thinking. App titles and
raw tool names are not displayed. A small dark cursor with a white edge glides between measured targets.
The driver waits for the cursor to arrive before dispatching the action. Reduced motion places
the cursor directly at the target.

**The visual session and cursor persist between tool calls**, including thinking pauses. The cursor
starts at the primary monitor's centre and glides from its current position to each verified target
before the driver acts. A successful click has a brief pulse. Reads, keyboard actions, errors and
unknown targets leave it at its resting position; they do not invent a new target. There is no
target rectangle. Reduced motion places the cursor directly at verified targets.
Always call `computer_session` with `{"action":"end"}`
when finished, cancelled, blocked, or returning control to the user. Do not end between steps.
This hides all monitor overlays and clears cached target geometry; it does not change policy or
undo app actions. `{"action":"status"}` reads visibility without starting the helper. The next
approved native call begins a new visible session automatically. Disconnecting the MCP server
also removes the overlay. There is no short idle timer: a host that keeps its server alive must
send the explicit end signal when the task ends.

Events are pushed over an authenticated loopback connection from the trajectory recorder; there
is no watched file. The overlay receives one rectangle, app, action, timestamp and phase, plus
the snapshot's window handle, process ID, window title and dimensions for private window matching. The title is
neither displayed nor stored in activity records. It never receives typed text, key payloads or
the accessibility tree. Geometry is cached before compaction, including fresh snapshots returned
by actions, and discarded when an action returns no snapshot or a display change invalidates it.

Coordinate clicks also move the cursor when the snapshot contains an exact window handle and the point is within its bounds. Unverified coordinates leave it at rest. See [coordinate cursor verification](docs/verification-coordinate-cursor.md).

**Windows driver frames are window-relative, not desktop coordinates.** The renderer resolves
one visible window with the matching handle, process, title and dimensions, then adds its physical origin.
It leaves the pointer at rest if identity or geometry is missing, the window is minimized or resized,
the target is covered, or the coordinate transform is unknown. If the target window moves or becomes
covered during travel, movement stops and the target is withdrawn. It never selects the first
ambiguous window or guesses a screenshot transform. A resting cursor is not a verified action target.

`FBC_OVERLAY=0` disables the helper. `FBC_REDUCED_MOTION=1` removes cursor travel; the Windows
client-area animation preference is also respected. `computer_doctor` reports renderer status,
and tool responses warn when it cannot paint. Driver calls continue if the overlay is unavailable.

The renderer uses physical desktop pixels and one layered Win32 window per monitor. The live
verification passed on a dual-monitor desktop with a negative monitor origin, at 100% scaling.
Mixed-DPI, display hot-plug, and non-Windows overlays are not yet verified. Windows PowerShell
and the built-in .NET Framework compile the bundled native helper on startup; no Electron download
or additional npm dependency is required. Environments that block PowerShell or Add-Type will
report an overlay failure.

```bash
node scripts/verify-native-overlay.mjs
node scripts/verify-overlay-exit.mjs
node scripts/verify-window-target.mjs vivaldi
```

The first probe briefly draws test activity and checks actual screen pixels, native window styles,
focus and real-pointer preservation, rebuilding after a display-change notification, persistence
through a thinking pause, cursor travel, explicit session end and window cleanup. The second terminates its own test host while the overlay is active and checks
that the helper destroys its windows. Neither sends input to another app or changes display settings.
The third reads Vivaldi's New Tab element, compares the converted driver frame with independently
measured UI Automation desktop bounds, then checks actual cursor pixels at that location without
clicking. It also asserts that missing or mismatched window identities do not move the resting pointer.
Notification handling is verified; physical monitor hot-plug and mixed-DPI still need hardware tests.
The older `prototype/` remains an experimental reference, not the runtime.

Run the desktop probe while the real mouse and keyboard are idle: concurrent user input makes its
before/after preservation comparisons inconclusive. Such failures still produce a nonzero exit.
For a static preview drawn by the same renderer, run
`powershell.exe -NoProfile -NonInteractive -File scripts/preview-overlay.ps1`.

See [action verification](docs/verification-action-verification.md) for how an action result
distinguishes dispatch from an observed effect, and what that check cannot see.
See [the cursor correction verification](docs/verification-cursor-targets.md) for measured offsets,
test results, and the differences from the currently bundled OpenAI Computer Use plugin.
The [persistent-cursor follow-up](docs/verification-persistent-cursor.md) records the subsequent
centre-start and always-visible behavior. For a more demanding Freebuff run, use the
[local practice page](docs/computer-use-practice.html) and its [test prompt](docs/advanced-test-prompt.md).

To check a locally installed tarball, pass its package directory to
`node scripts/verify-installed.mjs <installed-package-root>`. This creates an isolated workspace,
generates a standalone agent, launches its exact MCP configuration, asserts all thirteen tools,
and runs read-only app discovery with the packaged renderer. It does not run a Freebuff model.
The pixel probe also accepts that directory: `node scripts/verify-native-overlay.mjs <installed-package-root>`.

## Safety

Computer Use affects real apps and real accounts on the machine it runs on. Three policy modes,
settable in the config file or from the CLI:

| Mode | Behaviour |
| --- | --- |
| `open` (default) | Every action is allowed. |
| `allowlist` | Only the apps you list may be read or acted on. Reading counts as access, so `get_app_state` is gated too. |
| `audit` | Observation is allowed; every action that would change the machine is refused. |

```bash
fbc policy --mode allowlist --allow Notepad Spotify
```

`--allow` takes a list of app names, separated by spaces or commas, matched as a case-insensitive
substring against the app name or its window title.

Independent of the mode, a few things are always refused: key combinations that can lock, log out
of, or seize the machine (`ctrl+alt+delete`, `win+l`, and similar), and text payloads that look like
a destructive shell command such as `rm -rf /` or a download piped into a shell. The agent's own
instructions also forbid it from typing passwords, API keys, or tokens, and require it to confirm
with you before anything consequential — sending a message, submitting a form, completing a
purchase, deleting data, or changing account and security settings.

Every session is recorded as JSONL under the state directory, so a run can be reviewed afterwards.
Snapshots are stored as metadata (sizes and node counts) rather than full payloads. To turn
recording off, set `recordTrajectory` to `false` in the config file.

Two things worth being blunt about:

- **This drives your real session.** A wrong click lands on a real app, and if you are signed into
  something in that app, it acts as you. There is no sandbox here. For unattended, scheduled, or
  untrusted work — or anything touching accounts you care about — use a dedicated OS user account
  that is isolated from your primary one, and prefer `allowlist` or `audit` mode.
- **Anything on screen is untrusted input.** Text in an app, a web page, or a document can try to
  instruct the agent to do something you did not ask for. The agent is told to treat that content as
  data, never as permission, and to stop and tell you if it happens. That mitigation is a prompt,
  not a guarantee, which is the case for every computer-use system today.

## Configuration

The config lives at `~/.freebuff-computer/config.json` and is created by `fbc setup`.

| Key | Default | Meaning |
| --- | --- | --- |
| `policyMode` | `"open"` | `open`, `allowlist`, or `audit`. |
| `allowedApps` | `[]` | Apps permitted in `allowlist` mode; case-insensitive substring match. |
| `blockedKeys` | lock/logout/seize combinations | Additional key combinations to refuse, on top of the built-in ones. |
| `recordTrajectory` | `true` | Write JSONL trajectories under the state directory. |
| `defaultMaxTreeNodes` | `200` | Accessibility tree nodes requested by default. The main size lever; the driver's own default is 1200. |
| `defaultMaxTreeDepth` | `32` | Accessibility tree depth requested by default. The driver's own default is 64. |
| `maxSnapshotBytes` | `65536` | Hard cap on a single snapshot sent to the model. When it is hit, the outline says so explicitly. |

Environment variables:

| Variable | Effect |
| --- | --- |
| `FBC_STATE_DIR` | Move the state directory (config, trajectories) somewhere else. |
| `FBC_DRIVER_CMD` | Override the driver command, for example `FBC_DRIVER_CMD="node ./my-driver.js"`. Mainly for testing a different driver. |
| `FBC_POLICY_MODE` | Pin the session to `open`, `allowlist`, or `audit` without editing the config file. |
| `FBC_ALLOWED_APPS` | Comma-separated allowlist, for example `FBC_ALLOWED_APPS="Notepad,Spotify"`. Overrides `allowedApps`. |

## Architecture

Four decisions shape this project; the [research write-up](docs/research/codex-computer-use.md)
covers the alternatives that were rejected.

**One long-lived driver session.** `element_index` values are scoped to the session that produced
them. Starting a fresh driver for each action would silently invalidate every index the model is
holding, turning correct-looking clicks into wrong ones. So the server holds a single persistent MCP
connection to the driver for the lifetime of the Freebuff session and routes every call through it.

**Snapshot compaction.** A single accessibility snapshot is the largest payload this server sends.
Compaction strips redundant decoration — geometry that a node simply inherited from its parent,
and the `ScrollIntoView`-only action lists that nearly every node carries — while never renumbering,
reordering, adding, or dropping a node line, so every index the model sees still addresses the
element the driver meant. Volume is controlled separately through the driver's own documented
`max_tree_nodes` and `max_tree_depth` knobs, with tuned defaults, plus a hard byte cap.

Measured on one Windows 11 machine against Spotify, the largest accessibility tree available at the
time: the driver's own defaults produced a 147.7 KB outline (roughly 38,000 tokens), the tuned tree
limits brought that to 25.7 KB, and compaction brought it to 19.7 KB (roughly 5,000 tokens) — an
86.7% reduction, with no node dropped by the byte cap, so nothing was lost to reach it. How big the
win is depends entirely on the app. `fbc stats` reports the real figures for your own sessions
rather than these.

**A policy layer in front of the driver.** Every call passes through the allowlist check, the
audit-mode gate, and the hard-blocked keys and payload patterns before it reaches the driver,and refusals come back to the model as an explained error rather than a silent no-op. A restrictive
mode is a boundary the human set, so the agent cannot widen its own policy: `computer_policy` will
refuse to change anything while the mode is `allowlist` or `audit`, and the change has to come from
the user through `fbc policy`.

**Trajectory recording.** Every call, refusal, and snapshot measurement is appended as JSONL, which
is what makes a session debuggable after the fact and makes the snapshot savings measurable via
`fbc stats`.

The native effector is the MIT-licensed
[open-computer-use](https://github.com/iFurySt/open-codex-computer-use) driver, reached over MCP. The
per-platform work — macOS accessibility and background event delivery, Windows UI Automation and
window-message input, Linux AT-SPI — is what makes background computer use hard, and reimplementing
it would be the most expensive and least differentiated part of this project. What this project adds
is the Freebuff-facing contract, compaction, policy, recording, diagnostics, and the agent and skill
artifacts.

## Known gaps

Honest list of what is not done yet.

- **Not published to npm.** The `npx -y freebuff-computer` examples and the monorepo agent's
  registration still require publication. The repository registration and `setup` output use local
  paths and need no publish.
- **`agents/computer-use.ts` only loads inside the Freebuff monorepo.** Freebuff loads user agent
  files from `.agents/*.ts` and imports them raw, so a bare value import such as
  `@codebuff/common/constants/gemini` has to resolve from the checkout's own `node_modules`, which
  it does not in a standalone clone. Use `setup --agent-file .agents/computer-use.js` for the
  standalone version; the monorepo drop-in keeps its constant import. Generated-agent import and
  configuration are tested. The installed Freebuff client lists the generated `@computer-use`
  agent in autocomplete. The user's Freebuff browser test successfully opened a new tab, searched
  Google, verified results and preserved existing tabs. The user also reported successful
  explicit session begin/end runs with a persistent outline. The advanced practice-page run
  across two browser windows still needs verification through Freebuff.
- **Live mutations are not part of the unattended suite.** A user-authorized Google search in
  Vivaldi verified New Tab clicking, address-field set-value, Return dispatch, and reading results
  through the subset tool. `ctrl+t` reported success without opening a tab. The delivery gap it
  exposes is still open: modifier chords are posted as window messages that a browser ignores.
  What changed is that such an action can no longer be mistaken for a success, because every
  action result now reports what was observed afterwards and `ctrl+t` returns
  `[verification: unchanged]`. Unattended tests use a stub for mutation dispatch to avoid driving
  whatever the user has open. Separate interactive regressions use disposable test-owned
  windows to verify window isolation, real value changes, UIA actions, focus and pointer
  preservation; see [current status](docs/CURRENT_STATUS.md).
- **Verified on Windows 11 only.** The macOS and Linux notes come from the driver's own
  documentation, not from a run on those systems.
- **Hosted CI is not yet verified.** `.github/workflows/verify.yml` runs the full suite with the
  verified Windows driver, compiles the overlay, and checks a packed installation on Node 18, 22
  and 24. The workflow has not run on GitHub yet. Interactive pixel/focus and mixed-DPI tests
  require a real desktop and are separate from CI.

## Development

```bash
npm run build       # compile src/ to dist/
npm run typecheck   # tsc --noEmit
npm test            # build, then run the test suite
```

## License

MIT. See [LICENSE](LICENSE).
