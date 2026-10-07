# Freebuff Computer

Computer Use for Freebuff agents. It gives an agent the ability to see and operate the computer it
is running on — real windows, real apps, real clicks — instead of being limited to files, shell
commands, and APIs. The tool surface is deliberately the same shape as Codex's computer use, so the
prompt habits and workflows that work there transfer here, and the native effector underneath is an
existing open-source driver rather than a reimplementation.

## Requirements

- **Node 18 or newer** (the same Node that runs Freebuff is fine).
- **The computer-use driver**, installed once:

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

## Install and wire into Freebuff

### From this repository (works today)

This repository ships a project-local MCP registration at `.agents/mcp.json`. Freebuff reads
`.agents/mcp.json` from the workspace root (and from `..`, then `~`), so cloning the repo and opening
it in Freebuff registers the server with no manual step:

```bash
git clone https://github.com/Ayinaki/freebuff-computer.git
cd freebuff-computer
npm install        # the prepare script runs the build, producing dist/
fbc doctor         # confirm the driver is present and the contract matches
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

`mcpServers` is the standard MCP file format, and that is the key Freebuff reads. Repository-scoped
`.agents` content is gated behind your consent, so Freebuff asks before it trusts this file — this is
why the path is safe to commit. Freebuff speaks MCP to that command over stdio; the server takes no
arguments. `dist/` is gitignored, so a fresh clone needs the `npm install` above first.

### Globally, from npm (once published)

```bash
npm install -g freebuff-computer
fbc setup
```

`fbc setup` writes a default config and checks for the driver. Add `--install-driver` to have it run
`npm install -g open-computer-use` for you. It then prints the MCP entry to add in Freebuff under
Connectors → add custom server:

```json
{
  "mcpServers": {
    "freebuff-computer": {
      "command": "npx",
      "args": ["-y", "freebuff-computer", "server"]
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

`fbc setup` does not write into `~/.freebuff/mcp.json`. That file is hash-verified by the Freebuff
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
| `list_apps` | List the apps Computer Use can drive, with pid and window title. |
| `get_app_state` | Read an app's accessibility tree as an indented outline. Every actionable node carries an `element_index`. |
| `click` | Click an element by `element_index`, or by x/y coordinates for surfaces with no accessibility node. |
| `set_value` | Set an editable control's value directly. Exact and atomic; preferred over typing. |
| `type_text` | Type literal text into the app that has keyboard focus. |
| `press_key` | Press a key or combination, such as `Return` or `ctrl+s`. |
| `scroll` | Scroll a container element by pages in a direction. |
| `drag` | Drag from one coordinate to another. |
| `perform_secondary_action` | Invoke a named accessibility action on an element, such as `SetValue` or `ExpandCollapse`. |
| `computer_doctor` | Report the health of the setup from inside the agent's own turn. |
| `computer_policy` | Read or change the safety policy. |

The first nine names are intentionally identical to Codex's computer-use tools. The last two are
additions from this project so the agent can diagnose and configure itself without the user leaving
the chat.

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

- **Not published to npm.** Every `npx -y freebuff-computer` instruction — `README.md`, the snippet
  `fbc setup` prints, and `mcpServers` in `agents/computer-use.ts` — 404s until `npm publish`
  happens. The `.agents/mcp.json` route in this repository works today and needs no publish.
- **`agents/computer-use.ts` only loads inside the Freebuff monorepo.** Freebuff loads user agent
  files from `.agents/*.ts` and imports them raw, so a bare value import such as
  `@codebuff/common/constants/gemini` has to resolve from the checkout's own `node_modules`, which
  it does not in a standalone clone. To make it load here, either inline the model id literal
  (`'google/gemini-3.5-flash-lite'`) or add a `.agents/computer-use.ts` that re-exports it. The
  monorepo drop-in keeps the constant so it tracks model renames, which is why it is written that
  way.
- **No live mutation test.** The suite exercises observation, compaction, policy refusals and
  diagnostics against the real driver, but no test performs an actual `click`, `type_text` or
  `set_value` on a real app — doing that would drive whatever the user has open. The mutation path
  is covered by policy unit tests and contract verification only.
- **Verified on Windows 11 only.** The macOS and Linux notes come from the driver's own
  documentation, not from a run on those systems.
- **No CI.** There is no workflow file; `npm run typecheck` and `npm test` are run by hand.

## Development

```bash
npm run build       # compile src/ to dist/
npm run typecheck   # tsc --noEmit
npm test            # build, then run the test suite
```

## License

MIT. See [LICENSE](LICENSE).
