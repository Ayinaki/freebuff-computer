# Handoff brief — Freebuff Computer

You are picking up an in-progress project. This document is self-contained: it assumes you
have none of the conversation that produced it. Read it fully before touching anything.

**Your goal:** make Freebuff's Computer Use feature — a Codex-equivalent system that lets any
Freebuff agent see and operate the desktop it runs on — actually finished and trustworthy.

---

> **Current-state correction (October 12, 2026):** This document records the original
> baseline. Read [CURRENT_STATUS.md](CURRENT_STATUS.md) before using its counts,
> setup instructions or open-work list. The wrapper now has 13 tools, a native
> persistent overlay and a bundled patched Windows driver. The original blanket
> claim that Windows input never steals focus or moves the pointer was too broad:
> UIA focus handling needed a fix, and drag still has a physical-pointer caveat.
> The user subsequently approved a human-enabled foreground mode; background remains
> the default. See CURRENT_STATUS.md for its verification limits.
> Preserve the architectural decisions below and the existing uncommitted work.
> Do not commit or stash the prototype unless the user asks.
## 0. Do this first

```bash
git clone https://github.com/Ayinaki/freebuff-computer.git
cd freebuff-computer
npm install          # the prepare script runs the build, producing dist/
npm run typecheck    # expect exit 0
npm test             # expect 26 tests, 26 pass, 0 fail
node dist/cli.js doctor          # expect exit 0, status OK, "contract all 9 tools match"
```

If `doctor` says the driver is NOT FOUND:

```bash
npm install -g open-computer-use
```

**One caveat about the working checkout.** If you are working in the original checkout at
`D:\Devs\freebuff-computer` rather than a fresh clone, note that `prototype/` is **untracked**
and the repo is clean at commit `ee7f6bf`. Commit or stash that directory before starting, or
you will lose the overlay prototype — details in section 5.

---

## 1. What this project is

Freebuff agents could previously reach a machine only through files, shell commands, and APIs.
Anything behind a GUI was unreachable. This project adds a **stdio MCP server** that exposes a
Codex-shaped computer-use surface, backed by an existing MIT-licensed driver rather than a
reimplementation.

The decisive architectural choice: **we wrap `open-computer-use`, we do not rebuild it.** The
expensive, low-differentiation work (macOS SkyLight private APIs, Windows UI Automation, Linux
AT-SPI, background input delivery) is done and MIT-licensed. What this project adds is the
Freebuff-facing contract, snapshot compaction, a policy layer, trajectory recording,
diagnostics, and the agent/skill artifacts.

Read [`docs/research/codex-computer-use.md`](research/codex-computer-use.md) (403 lines) for the
research and the alternatives that were rejected. Do not redo that research.

---

## 2. Verified facts — measured, not assumed

Every row below was measured on Windows 11 with `open-computer-use` 0.3.6. Trust these; do not
re-derive them from memory or from a model's description of its own product.

| Fact | Evidence |
| --- | --- |
| Driver exposes exactly 9 tools | Live `tools/list` over MCP stdio |
| Tool set | `list_apps`, `get_app_state`, `click`, `set_value`, `type_text`, `press_key`, `scroll`, `drag`, `perform_secondary_action` |
| `element_index` is **session-scoped** | Driver contract; indexed state lives in the MCP session, so one long-lived connection is mandatory, not an optimisation |
| Windows supports neither `sky_click` nor `global` click methods | Driver's own `click_method` documentation |
| Windows runtime input path | UI Automation + Win32 window messages. The real pointer does not move and foreground focus is not stolen |
| Windows binary has **no** overlay/cursor code | No `overlay`/`indicator`/`cursor_overlay`/`virtual_cursor` strings in `dist/windows/{amd64,arm64}/open-computer-use.exe` |
| A visual cursor overlay **does** exist — **macOS only** | `references/usage.md`: "The visual cursor overlay is part of the Open Computer Use experience and can be disabled by the surrounding runtime only when needed." **There is no env var to control it** |
| Driver env vars | Only `ACTION_READ_BACK`, `ALLOW_GLOBAL_POINTER_FALLBACKS`, `COMMAND`, `NATIVE_ARGS`, `NATIVE_COMMAND` |
| Per-element geometry **is** available on Windows | `Frame: {x, y, width, height}` on **1193/1204** nodes (Vivaldi), **1176/1231** (Discord), 8/10 (Freebuff) |
| There is **no** structured JSON rect API | `app.getAXState()` returns the same indented outline text as the CLI |
| `ocu js` returns values via `nodeRepl.write(x)` | Not `console.log`, not a completion value. A bare expression yields `(no output)` |
| `cua` API surface | `getApp`, `getState`, `listApps`, `rewriteDocumentation`. Per-app: `getAXState`, `getScreenshot`, `getAXStateAndScreenshot`, `click`, `scroll`, `drag`, `typeText`, `pressKey`, `setValue`, `performSecondaryAction` |
| Compaction win | 147.7 KB driver defaults → 25.7 KB tuned limits → **19.7 KB** compacted = **86.7% reduction**, no node omitted by the byte cap |
| Codex is foreground-only on Windows | Recorded in our research doc; Codex's Windows answer is "keep the app visible, or use a VM" |
| Codex's cursor is synthetic too | Research doc: "**Cursor** \| A cosmetic painted overlay — the real OS cursor never moves" |
| Codex's UI shows "an agent pointer gliding to each action" | Research doc (line 71) — a deliberate change from showing the raw script and selectors |

### Freebuff host facts (extracted from the installed client, v0.0.178)

| Fact | Evidence |
| --- | --- |
| Freebuff loads MCP servers from **project-local** `.agents/mcp.json` | Searched at `{cwd}/.agents`, `{cwd}/../.agents`, `~/.agents`; later dirs win |
| File format | `{ "mcpServers": { "<name>": <config> } }` |
| Stdio config is a **strictObject** | `{ type: "stdio", command, args, env }` — **extra keys are rejected**. No `cwd`, no `enabled` |
| `~/.freebuff/mcp.json` is different and hash-verified | Contains `configKey`/`launchHash`/`manifestHash`/`approvedManifest`. A hand-written entry there is rejected — do not try |
| Freebuff loads **user agent files** from `.agents/` | Recursive over `.ts`/`.js`; skips `node_modules`, `scripts`, `skills`, `skills-*`; skips `.d.ts`, `test`, `spec` |
| Agent files are imported **raw** | `import(pathToFileURL(fullPath))` — so bare *value* imports must resolve from the checkout's own `node_modules` |
| An agent needs only `id` and `model` | Everything else optional |
| Skill frontmatter `name` must equal its **directory** name | Otherwise the skill is silently dropped |

---

## 3. What is already built and working

22 files, committed and pushed. Repo: `https://github.com/Ayinaki/freebuff-computer` (public,
default branch `main`, HEAD `ee7f6bf`).

| Path | Role |
| --- | --- |
| `src/contract.ts` | Frozen spec for the 9 Codex tools + `computer_doctor` + `computer_policy` = 11. Also `ALWAYS_BLOCKED_KEYS` and `BLOCKED_TEXT_PATTERNS` |
| `src/driver.ts` | `ComputerDriver`: persistent `Client` + `StdioClientTransport`, `verifyContract()` comparing advertised vs frozen contract |
| `src/compact.ts` | `compactSnapshot()` — structure-preserving; never renumbers, reorders, adds, or drops a node line |
| `src/policy.ts` | `checkAction()`, `checkPolicyMutation()` (an agent may not widen its own policy), `describePolicy()` |
| `src/server.ts` | MCP wiring, `INSTRUCTIONS` prompt, `buildDoctorReport()` (`failed` vs `degraded`), `createServer()` |
| `src/trajectory.ts` | `TrajectoryRecorder` → JSONL under `<STATE_DIR>/trajectories/` |
| `src/config.ts` | `DEFAULT_CONFIG`, `loadConfig()`, `driverCommand()`, `STATE_DIR` |
| `src/cli.ts` | `server`/`mcp`, `doctor`, `setup`, `stats`, `policy`, `help`, `version` |
| `.agents/mcp.json` | Project-local registration — this is what makes the server load with no manual step |
| `agents/computer-use.ts` | Agent definition **for the Freebuff monorepo**; see the trap in section 7 |
| `skills/computer-use/SKILL.md` | Operator's guide skill |
| `test/*.test.js` | 26 tests: compaction, policy, and e2e over real MCP stdio with the real driver |

Config defaults (`~/.freebuff-computer/config.json`): `policyMode: "open"`, `allowedApps: []`,
`recordTrajectory: true`, `defaultMaxTreeNodes: 200`, `defaultMaxTreeDepth: 32`,
`maxSnapshotBytes: 65536`.

Env overrides: `FBC_STATE_DIR`, `FBC_DRIVER_CMD`, `FBC_POLICY_MODE`, `FBC_ALLOWED_APPS`.

---

## 4. Decisions already made — do not relitigate these

1. **Wrap the driver.** Do not reimplement platform input. Says so in the research doc.
2. **One long-lived driver session.** `element_index` values are session-scoped; a fresh
   connection per action silently invalidates every index the model holds and turns
   correct-looking clicks into wrong ones.
3. **Compaction preserves node identity absolutely.** Stripping redundant decoration is fine;
   renumbering, reordering, adding or dropping a node line is not. Every index the model sees
   must still address the element the driver meant. There are tests asserting this — keep them.
4. **A restrictive policy must be human-only to widen.** `computer_policy` refuses to change
   anything while the mode is `allowlist` or `audit`. This asymmetry is the whole point.
5. **Hard blocks apply in every mode**, including `open`: lock/logout/seize key combinations and
   destructive shell payloads.
6. **Background by default.** Actions must not steal focus or move the real pointer. This is the
   product's differentiator against Codex on Windows.
7. **No new dependencies without a strong reason.** The current runtime deps are
   `@modelcontextprotocol/sdk` and `zod`, and that is deliberate.

---

## 5. Open work, in priority order

### 5a. The visibility overlay — prototype works, needs wiring

**Context:** we chose an invisible agent (see decision 6) and then failed to build the
visibility layer that makes invisibility safe. The user gets **zero** indication that an agent
is driving their machine. Codex, by contrast, paints an agent pointer gliding to each action.
That gap is real and is the highest-value thing to close.

**A prototype exists and is verified.** In `prototype/` (currently **untracked** — commit it
first):

| File | Role |
| --- | --- |
| `prototype/overlay.ps1` | Transparent, click-through, always-on-top WPF window spanning the virtual desktop. Draws a highlight box, a label chip, and an eased synthetic cursor. Watches a JSON file (`{x,y,w,h,label,seq}`) |
| `prototype/frames.mjs` | Parses real element frames out of a live `ocu snapshot` |
| `prototype/demo.mjs` | Drives the overlay from a real app's real elements |
| `prototype/verify-overlay.ps1` | The verification harness — proves the claims rather than asserting them |

Measured result from `powershell -STA -NoProfile -ExecutionPolicy Bypass -File prototype/verify-overlay.ps1 -App Vivaldi -Element 13` (exit 0):

```
target      real element from Vivaldi: [13] tab "Tabs"
overlay     launching (target 49,8 720x30 on a 3640x1923 virtual screen)
window      hwnd=460144 visible=True exstyle=0x80800A8
            click-through(WS_EX_TRANSPARENT)=True layered=True toolwindow=True noactivate=True
focus       foreground before=66704 after=66704  unchanged=True
render      accent pixels found in a 7px band on the top edge: 18
cursor      accent pixels within 14px of the target centre: 211
transparent 0 of 9 interior samples read as solid accent (want 0)
```

**Your job:** replace the polled file with a real push channel and wire it to the server.

- The server already sees every action and every snapshot measurement in `src/trajectory.ts`.
  Emit action events (tool, app, target rect, timestamp) from there.
- Transport: a named pipe or a loopback socket. Do **not** keep the file poll.
- The overlay needs **one rect per action**, not the whole tree. Look up the target node's
  `Frame` at action time and forward that single rect. **Do not** change `src/compact.ts` to
  retain all frames — it correctly strips inherited duplicates, and the overlay does not need
  them.
- Add an env-var kill switch, e.g. `FBC_OVERLAY=0`.
- Remember the server is a headless stdio child of Freebuff: it cannot draw. The overlay must be
  a separate process. PowerShell/WPF proves the concept; a shipping version should be Electron
  (Freebuff Desktop is already Electron: `transparent`, `setIgnoreMouseEvents`, `setAlwaysOnTop`)
  or a native Win32 layered window.

### 5b. Code-first surface for code-execution-first models

Our research doc records that OpenAI's **recommended path for GPT-6 Astra is code execution**
(Path A: one `exec_py`/`exec_js` tool, model writes PyAutoGUI/Playwright) rather than the
structured `computer` tool (Path B — what we implement).

The driver already ships a code-first adapter that its own bundled Codex plugin uses *instead*
of the nine tools, advertising only `js` and `js_reset`. `ocu js` and the `cua` API are verified
working (see the table in section 2).

**Your job:** expose an `exec_js`-shaped tool on the server, backed by the driver's code-first
path. Route it through the same policy layer as everything else — a code-execution surface must
not become a bypass around the allowlist, the audit gate, or the hard blocks.

### 5c. Mixed-DPI correctness

The prototype maps 1:1 on this machine (a driver coordinate of `49,8` landed exactly), but that
is one display configuration. The same desktop reports windows at `2576×1408` and `1094×1597` on
a `3640×1923` virtual screen, which suggests mixed scale factors. **This is the most likely place
for the overlay to be subtly wrong.** Verify on a mixed-DPI setup and fix any offset.

### 5d. Remaining gaps

- **Not published to npm.** `npm view freebuff-computer` → 404. Every `npx -y freebuff-computer`
  reference 404s. **Do not run `npm publish`** without explicit human authorisation — it is
  irreversible and needs their credentials. Note that `fbc` and `freebuff-computer` are **not**
  on PATH, so the README's `fbc doctor` needs `npm install -g .` first.
- **`agents/computer-use.ts` cannot load outside the Freebuff monorepo** — see the trap below.
- **No live mutation test.** No test performs a real `click`/`type_text`/`set_value` on a real
  app, deliberately: it would drive whatever the user has open. The mutation path is covered by
  policy unit tests and contract verification only. If you add one, ask the human to nominate a
  harmless app first.
- **No CI.** No workflow file.
- **Verified on Windows 11 only.** macOS and Linux notes come from the driver's documentation,
  not from a run.

---

## 6. How to verify your work

Do not claim success from a build or an exit code. The whole project history contains bugs that
passed a build and only failed behaviourally.

```bash
npm run typecheck                # exit 0
npm test                         # 26 tests, 26 pass, 0 fail, exit 0
node dist/cli.js doctor          # exit 0, status OK, "contract all 9 tools match"
FBC_DRIVER_CMD="nope-not-real mcp" node dist/cli.js doctor   # expect exit 1, status FAILED
```

Then verify through the interface the user actually touches:

- **MCP handshake:** spawn the server as `.agents/mcp.json` does (`node dist/cli.js server`),
  send `initialize` then `tools/list`, and assert **11** tool names. Read the exit status, not
  just the output.
- **Fresh clone:** `git clone` into a temp dir, `npm install`, `npm run typecheck`, `npm test`.
  This is what catches packaging mistakes.
- **Overlay:** run `prototype/verify-overlay.ps1`, with and without `-App`/`-Element`.

When filtering output through a pipe, preserve the tested command's exit status (`${PIPESTATUS[0]}`
in bash). A successful `tail` is not a passing test. And if a check fails, fix the cause — do not
weaken an assertion, skip a test, or swallow an error to make it green.

---

## 7. Traps — things that look right and are wrong

These are all mistakes that were made or nearly made during development. Each wasted real time.

1. **Do not add a `mcpServers` entry without the wrapper.** The correct shape is
   `{ "mcpServers": { "freebuff-computer": { "command": "...", "args": [...] } } }`. A bare
   `{ "freebuff-computer": {...} }` is rejected by the strict schema. An earlier version of
   `fbc setup` printed the malformed form.
2. **Do not "fix" `agents/computer-use.ts` by inlining the model id.** It value-imports
   `GEMINI_3_5_FLASH_LITE_MODEL_ID` (`'google/gemini-3.5-flash-lite'`) so it tracks model renames
   inside the Freebuff monorepo, which is its purpose. Making it loadable as a user agent file
   requires a *separate* `.agents/computer-use.ts`; the monorepo drop-in should keep the constant.
   Also note it is deliberately **outside `tsconfig.json`** — it is not part of this package's build.
3. **Do not try to mirror a real cursor on Windows.** Nothing moves: input goes via UIA patterns
   and window messages and never enters the HID stream. A synthetic painted cursor is the correct
   design, and it is what Codex does too.
4. **Do not ask a model how its own computer use works and treat the answer as fact.** Codex's
   overlay is closed source. Asking produces confident invention. Use the measured table in
   section 2.
5. **Do not assume the Windows driver has an overlay.** It does not; the macOS one does, with no
   env var to control it.
6. **Do not re-derive the tool contract by hand.** Read `src/contract.ts` and rely on
   `verifyContract()` to fail loudly on drift. Retyping the schemas is how drift gets introduced.
7. **Do not treat `element_index` as stable across snapshots or sessions.** Take a fresh
   `get_app_state` before acting, and again after anything that changes the UI. The tests in
   `test/compact.test.js` deliberately assert that indexes survive compaction and truncation.
8. **Do not assume `spawn('ocu')` works on Windows** — `ocu` is a `.cmd` shim, so it needs a
   shell (the MCP SDK uses `cross-spawn`, which handles it). Passing args with `shell: true`
   triggers Node's DEP0190; `prototype/frames.mjs` resolves and calls the native `.exe` directly
   to avoid it.
9. **Do not assume `ocu js` returns a value.** Use `nodeRepl.write(x)`.
10. **Do not publish, force-push, or discard work you did not create.** Ask first.

---

## 8. If you are a code-first model (e.g. GPT-6 Astra)

The most useful thing you can do is section 5b: make this server speak the surface your
ecosystem expects (`exec_js` over the driver's `cua` API), routed through the existing policy
layer. You can drive the driver today with:

```bash
ocu js 'var app = await cua.getApp("Notepad"); var s = await app.getAXState({emit:false, maxTreeNodes:40}); nodeRepl.write(s)'
```

For the overlay work, prefer verifying by **sampling actual screen pixels** (as
`prototype/verify-overlay.ps1` does) over reasoning about whether the window should be visible.
A window that fails to render and a window that renders both produce a zero exit code.

---

## 9. Working agreements

- Match existing conventions; the codebase is small (8 source files) and consistent — read a
  neighbouring file before adding to it.
- Prefer editing existing files over creating new ones.
- Keep comments explaining *why*, as the existing code does. Several non-obvious decisions
  (session-scoped indexes, structure-preserving compaction, the policy asymmetry) are documented
  inline precisely because they look wrong without the reason.
- Do not commit, push, or open a PR unless asked.
- Report checks that failed or could not run as limitations, never as passes.
