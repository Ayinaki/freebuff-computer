# Research: recreating Codex-style computer use for Freebuff

Status: research only. No code written.
Date: 2026-10-07

## 0. Repo and environment state

**`Ayinaki/freebuff-computer` is empty.** `git clone` reports "You appear to have cloned an
empty repository" — no commits, no files, no default branch content. The local checkout
(`/d/Devs/freebuff-computer`) contains exactly one file, `.freebuff/project-id`. This is a
greenfield project, so there is no existing structure to conform to.

Adjacent facts gathered from this machine (Windows 11, `MINGW64_NT-10.0-26200`, Node v24.15,
Python 3.14, **no Docker installed**):

| Thing | Finding |
| --- | --- |
| Freebuff Desktop | Electron app at `%LOCALAPPDATA%/Programs/@codebufffreebuff-desktop`; ships `resources/app.asar`, a native `orchestrator` binary, `bun`, and `elevate.exe` |
| Freebuff config | `~/.freebuff/mcp.json` (339 KB) and `%APPDATA%/Freebuff/mcp-secrets.json` |
| Freebuff MCP model | `mcp.json` shape is `{ "servers": { "<hash>": { configKey, enabled, launchHash, manifestHash, generation, allowedTools, approvedManifest } } }` — i.e. MCP tools are **manifest-approved and hash-pinned** already |
| Freebuff CLI | `npm i -g freebuff`, v0.0.178, repo `CodebuffAI/freebuff` |
| Freebuff repo | TypeScript/Bun monorepo (2078 paths); agents live in `agents/`; tools are a pair: `common/src/tools/params/tool/*.ts` (zod schema) + `packages/agent-runtime/src/tools/handlers/tool/*.ts` (handler) |

The single most important discovery for this project: **Freebuff already ships a
browser-scoped computer-use capability and an MCP-based agent packaging system**, which is
the same shape Codex uses to ship Computer Use.

- `agents/browser-use/browser-use.ts` is an `AgentDefinition` that declares
  `mcpServers: { 'chrome-devtools': { command: 'npx', args: ['-y','chrome-devtools-mcp@latest','--headless','--isolated'] } }`
  and drives it through a snapshot-first, uid-addressed workflow. This is *exactly* the
  packaging pattern we need for computer use.
- `common/src/browser-actions.ts` already defines image tool results
  (`{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }`) and
  `screenshots: { pre, post }` — so returning screenshots from a tool is already a supported contract.
- The agent running this session already exposes browser computer-use primitives
  (verified live): `preview_open`, `preview_snapshot` (accessibility tree with `uid=` handles),
  `preview_screenshot`, `preview_click`, `preview_type`, `preview_press`, `preview_scroll`,
  `preview_navigate`, `preview_evaluate`, `preview_logs` (console + network),
  `preview_recording_start/stop` (WebM), `register_preview`.

---

## 1. How Codex does it

Codex's computer use, shipped 2026-04-16 as "Codex for (almost) everything", decomposes into
five separable layers. Keeping them separate is what makes the system reimplementable.

### 1.1 Product / UX layer

Computer Use is delivered as a **plugin** whose contents are an **MCP server** (`computer-use`)
and a **Skill** ("Computer Use"); the user switches on both toggles. That packaging choice is
the whole architectural tell: the effector is an MCP server, not hard-wired product code.

- Invocation is per-target: mention `@Computer` or `@AppName` in the prompt.
- Settings → Computer use shows app access: "Control Any App", connected browser (via Chrome
  extension), Office add-ins, and an **"Always-allowed apps"** list. Each new app raises a
  permission prompt with Allow / Always allow.
- Policy lives in `$CODEX_HOME/config.toml`:
  `[computer_use.windows] always_allowed_app_ids = ["mspaint.exe"]`, with app ids being an exe
  name or an App User Model ID. Admins can disable the feature entirely via
  `requirements.toml` → `[features].computer_use = false`. Older
  `$CODEX_HOME/computer-use/config.toml` allow-list entries are migrated forward.
- UI shows an **agent pointer** gliding to each action, sometimes picture-in-picture. This was a
  deliberate change from the earlier developer-facing version that showed the automation script
  and selectors: same underlying agent architecture, different presentation.
- macOS "**Locked use**": after the Mac locks, an installed Apple authorization plug-in
  participates in the unlock flow; Codex temporarily unlocks, covers every display, and relocks
  if it detects local keyboard/pointer input. Narrow by design, scoped to active turns.
- Constraints: not available in EEA/UK/Switzerland at launch; macOS got background use first,
  Windows is foreground-only.

### 1.2 The model-facing tool contract (two distinct paths)

OpenAI's own API docs describe both, and Codex Desktop uses the same primitives.

**Path A — code execution (OpenAI's recommended path for GPT-6 Astra).**
One function tool named e.g. `exec_py` / `exec_js` with a single `code: string` parameter. The
model writes PyAutoGUI (desktop) or Playwright (browser) code; one call can contain loops and
conditionals. The harness runs it in a **persistent** desktop/browser session and returns text
plus images (`display(pil_image)` / `display(base64)`). The loop is bounded (the sample uses 20
turns) and continues by `previous_response_id`.

**Path B — the structured `computer` tool.** `tools: [{ type: "computer" }]`; the model emits a
`computer_call` containing an **ordered `actions[]` batch**:

```json
{ "type": "computer_call", "call_id": "call_002", "status": "completed",
  "actions": [ { "type": "click", "button": "left", "x": 405, "y": 157 },
               { "type": "type", "text": "penguin" } ] }
```

Action vocabulary: `click`, `double_click`, `drag`, `move`, `scroll`, `keypress`, `type`,
`wait`, `screenshot`. Mouse actions accept an optional `keys: ["SHIFT"]` array for
modifier-held clicks/drags. The first call of a task is often just `screenshot`. The app
executes the batch and answers with `computer_call_output` → `computer_screenshot`
(`image_url` data URL, `detail: "original"`).

Two contract details that bite if ignored:

- **The conversation and the environment have independent state.** Continuing a response does not
  restore a browser session, login state, or runtime variables. The harness must keep the
  environment alive itself.
- **Screenshot resolution is the harness's job.** XGA (1024×768) is the recommendation: downscale
  to it and map model coordinates back proportionally; pad up for smaller displays. Relying on
  server-side image resizing measurably hurts accuracy.

### 1.3 The driver layer — the tool surface Codex's own MCP server exposes

`open-computer-use` (MIT) is an open reimplementation explicitly "inspired by OpenAI's Codex
Computer Use", and its published comparison artifacts show it hitting the **official
`computer-use` MCP tool** alongside its own. Its surface is therefore a good read on Codex's:

`list_apps`, `get_app_state`, `click`, `perform_secondary_action`, `scroll`, `drag`,
`type_text`, `press_key`, `set_value`.

Key properties:

- `get_app_state` returns a **simplified accessibility tree** whose actionable nodes carry an
  `element_index`, plus optional screenshot. Tunables: `text_limit` (for long semantic text such
  as email bodies), `max_tree_nodes`, `max_tree_depth`.
- Actions are **element-index-first**, coordinates only as a fallback for canvas/WebGL surfaces
  that have no AX representation.
- Addressing is bundled with the observation: "Always run `get_app_state` before using
  `element_index`; do not guess indexes across sessions or after large UI changes."
- A code-first escape hatch (`ocu js`, `ocu repl`) exposes the same primitives as a JS API —
  the same duality as OpenAI's "code execution vs computer tool".

The newer `cua-driver` generation generalizes this and adds opaque references that **fail
closed**: `get_window_state` returns `pid` / `window_id` / `element_token` / `observationId`;
coordinate actions must echo the screenshot's `frameId`; a display reconnect or geometry change
invalidates references rather than silently retargeting. Providers advertise which action
families they support, and unsupported actions are **omitted rather than emulated**.

### 1.4 OS mechanics — how "background computer use" actually works

This is the hard part, and Cua's reverse-engineering write-up (Apr 2026) documents it precisely.

The naive path fails in a specific, instructive way:

1. `CGEventPost` of a `LeftMouseDown` at a screen coordinate **moves the real cursor** — it enters
   the same HID stream as your physical mouse.
2. `CGEvent.postToPid` avoids the cursor warp, but **Chromium's renderer-IPC filter silently drops
   the event**, because it lacks the telemetry a real HID gesture carries.
3. Activate-then-click-then-deactivate works, and is what most tools ship — but raising the window
   drags Spaces along and steals focus. That is exactly the behavior "background" is meant to avoid.

The working recipe (macOS):

| Piece | Mechanism |
| --- | --- |
| Focus without raise | `SLPSPostEventRecordTo` ×2 (previous frontmost + target PSN) — flips the app's AppKit-active state for *event routing* without calling `SLPSSetFrontProcessWithOptions`, so the window is never raised and Spaces never switch (yabai's technique) |
| Click delivery | `SLEventPostToPid` (SkyLight private framework, reached by `dlopen`/`dlsym`) — an auth-signed channel that bypasses `IOHIDPostEvent` and apparently carries a trust stamp Chromium's filter reads |
| Chromium user-activation gate | Decoy `LeftMouseDown`/`LeftMouseUp` pair at `(-1, -1)` — no window claims that pixel so the click is discarded, but the gate ticks forward and the real click counts as a trusted continuation |
| Electron AX trees | `_AXObserverAddNotificationAndCheckRemote` (private AX SPI) — keeps Blink's accessibility tree updating when the window is occluded |
| Keyboard | Plain `CGEvent.postToPid` is sufficient; macOS has no global keystroke filter |
| Cursor | A cosmetic painted overlay — the real OS cursor never moves |

Cua exposes three capture modes, which is the cleanest articulation of the observation tradeoff:

- `ax` — AX tree only as a Markdown outline with per-node indices. **No Screen Recording
  permission needed.** Best for AppKit/SwiftUI/system apps.
- `vision` — PNG only. Smallest payload, fastest, but the model does all spatial reasoning.
- `som` — **set-of-mark** (default): AX tree + screenshot. The tree says what is clickable, the
  screenshot disambiguates repeated/empty labels. Enables element-indexed clicks immediately and
  gives visual confirmation for free.

Known unfixable gaps, worth recording because they bound any implementation:

- Chromium coerces synthetic **right-clicks** on web content to left-clicks (a browser extension
  would be required to fix it, which breaks the drop-in-driver design).
- **Canvas apps** (Blender, Unity, games) filter per-pid routes entirely and need a brief
  frontmost activation — backgrounding is broken for that one category.

Requirements: macOS 14+, **Accessibility + Screen Recording** TCC grants, and a **stable signed
bundle identity** so grants attribute correctly and don't reset (this is why drivers ship as a
`.app` and launch through it rather than as a bare binary).

Historical note that explains the macOS-first polish: OpenAI acquired Software Applications Inc.
(the "Sky" team — largely ex-Apple, including people behind Shortcuts), which is plausibly why
Codex's macOS background story landed first and worked well.

### 1.5 Cross-platform matrix and its consequences

| Platform | Accessibility tree | Input dispatch |
| --- | --- | --- |
| macOS | AX (private SkyLight SPIs) | `SLPSPostEventRecordTo` — pid-scoped, no cursor warp |
| Windows | UIAutomation | `SendInput` + `PostMessage` — no focus steal |
| Linux | AT-SPI (X11 + Wayland) | XTest (X11) / virtual-keyboard (Wayland) |

Consequences and hard limits:

- **Latency**: background routing costs ~5–20 ms (macOS AX), ~3–10 ms (Windows UIA), ~5–15 ms
  (Linux AT-SPI), versus direct HID posting. Fine for agent-speed clicking.
- **Sparse AX trees**: Windows UWP apps, Electron < 28 on Linux, and custom-drawn macOS apps
  (Logic, Final Cut, games) expose little or nothing. Fall back to pixels or skip.
- **Windows UIPI**: a Medium-integrity process cannot enumerate the UIA tree of, or inject mouse
  input into, a High-integrity (Administrator) window. `capture` returns 0 elements and `click`
  reports success while doing nothing; the screenshot still renders because GDI capture sits below
  the integrity check. Keyboard events partially bypass UIPI. This is an OS constraint.
- **Windows Session 0 isolation**: driving over SSH (not RDP/console) needs an autostart proxy
  between Session 0 and Session 1+. Codex's own answer for Windows is cruder: keep the target app
  visible on the active desktop, or run the app inside a Windows VM.
- **Wayland** needs XWayland/portals for capture; AT-SPI must be enabled.

### 1.6 The sandboxed/VM alternative (and why it exists)

Because desktop input is synchronous and singular (one cursor, one keyboard, one focused window),
the historically safe answer is to give the agent its *own* desktop:

- **Anthropic's reference implementation**: Docker + Xvfb + xfce4 + x11vnc (+ noVNC) with
  `xdotool` for input and ImageMagick `import` for capture; ports 5900 (VNC), 6080 (noVNC),
  8501 (UI), 8080 (combined). Explicitly a minimal containerized reference.
- **OpenAI's recipe**: near-identical Dockerfile (ubuntu 22.04, Xvfb, x11vnc, xdotool,
  firefox-esr) with `docker exec` action handlers; or a **Playwright browser** when the task is
  web-only, launched with `env: {}`, `chromiumSandbox: true`,
  `--disable-extensions --disable-file-system` to avoid inheriting host state.
- **Cloud worker desktop** (OpenClaw/Crabbox): a per-session desktop shown in a web panel, with
  programmatic `take_control` handoff, view-only reciprocal mode, and provider-issued frame ids
  so that human takeover invalidates stale coordinate references.

Freebuff's own Web/Cloud already provide "sandboxes, previews, terminals" — so this approach
slots into an existing product shape, unlike for Codex.

### 1.7 Safety model (vendors converge on the same list)

- Isolate the environment; allowlist sites/apps; bound the run (step/time/cost limits) and support
  cancellation.
- **Treat all screen content as untrusted input** — text in a page or document cannot grant
  permission or override the user's instruction. Every vendor calls out prompt injection here.
- Confirm consequential/irreversible actions; "typing sensitive information into a form counts as
  transmission."
- Never type passwords: use OS autofill (Keychain / Credential Manager / GNOME Keyring).
- Hard-block a few key combos (empty trash, force delete, log out) and payload patterns
  (`curl | bash`, `sudo rm -rf /`, fork bombs).
- **A dedicated OS user account** is the mitigation for the real risk: the agent inherits the full
  session privileges of every logged-in app, so a wrong click can send real email or hit live data.
- Codex additionally refuses to automate terminal apps or itself, and won't authenticate as admin
  or approve security/privacy prompts.
- **Token economics matter**: screenshots dominate context. Hermes reports ~30K tokens for a
  20-action session once screenshots are evicted, vs ~600K naive; OpenClaw returns
  "screen unchanged since previous frame" metadata instead of re-sending a duplicate frame.

---

## 2. What this implies for Freebuff

Freebuff's architecture already contains every seam we need:

1. **Per-agent MCP servers** — proven in-tree by `browser-use`. A computer-use driver can be a
   stdio MCP server declared by an agent definition, with **zero runtime changes**.
2. **Image tool results** — already in the browser tool result schema.
3. **Manifest approval + hash pinning for MCP tools** — `approvedManifest`, `allowedTools`,
   `launchHash`, `manifestHash`. This is Codex's "Always allow" primitive, already built.
4. **A browser surface with accessibility-tree addressing** — `preview_snapshot` returns uid-tagged
   nodes; `preview_screenshot/click/type/logs/recording` exist. This is Freebuff's equivalent of
   Codex's in-app browser (Atlas), and it is the "browser provider" for free.
5. **Hosted sandboxes** in Web/Cloud — the container-desktop provider has a home.
6. **An existing UX vocabulary** for approvals (`ask_user`, per-tool gating, `request_elevation`).

The gap is purely the **native desktop provider**: reading and driving real OS windows.

---

## 3. Approaches

### A. Browser-scoped computer use (extend what exists)

Treat the Preview/Chromium surface as the computer: snapshot (AX tree with uids) → act → verify.

- **Pros**: no OS permissions, no native code, browser-sandbox safe, works across CLI/Web/Cloud/
  Desktop, and Freebuff has ~80% of it today. Matches OpenAI's own "use the built-in browser first"
  guidance for local web apps.
- **Cons**: cannot touch native apps — which is the entire point of Codex's computer use
  (Figma, Notion, Excel, a macOS/Win app under test).
- **Dependencies**: none new. Note this lives in the `CodebuffAI/freebuff` repo, not this one.

### B. Native desktop driver as a standalone MCP server (Codex-equivalent)

Expose the Codex-shaped surface — `list_apps`, `get_app_state`, `click`, `set_value`, `type_text`,
`press_key`, `scroll`, `drag`, `perform_secondary_action` — backed by per-OS AX + input stacks.

**B1. Wrap an existing open-source driver (adapter).**
Use `cua-driver` (MIT; background delivery on macOS/Windows/Linux; ~49 MCP tools; ships as a
signed `.app` on macOS with a `doctor` health matrix) or `open-computer-use` (MIT; npm; the
9-tool surface above; macOS/Windows/Linux runtimes). We add normalization to a single Freebuff
contract, Freebuff-specific policy, and the agent/skill layer.
- **Pros**: measured in days. The SkyLight reverse-engineering and the Windows UIA work are done
  and maintained by someone else. Matches how Codex itself is packaged (MCP server as effector).
- **Cons**: a third-party binary becomes part of our trust boundary (mitigated by the hash pinning
  Freebuff already performs); we inherit its version churn and its gaps (Chromium right-click,
  canvas apps); the upstream surface is a superset, so a mapping layer is required.

**B2. Write our own driver.**
Swift/ObjC (SkyLight SPIs + AX) on macOS, Win32/C# (UIA + `SendInput`/`PostMessage` + DXGI/GDI) on
Windows, Go/C (AT-SPI + XTest/portal) on Linux.
- **Pros**: full control, no third-party binary, no upstream gaps we can't fix, our own signing
  identity.
- **Cons**: this is the multi-month path — private SPI reverse-engineering, per-app quirks,
  notarization and TCC identity plumbing, three CI matrices. Realistic parity across three
  platforms is on the order of 6–12 engineer-months, and it is the least differentiated work in
  the project.

### C. Sandboxed / isolated desktop (container or VM) as the agent's computer

Xvfb + xfce + x11vnc/noVNC + xdotool + a browser, with the driver inside; humans observe over VNC.
Cloud flavor: one desktop per thread, with a web panel and view-only/take-control arbitration.

- **Pros**: strongest safety story — nothing touches the user's real session, so prompt injection
  has a bounded blast radius; perfectly reproducible; ideal for Freebuff Cloud/Web and CI; no TCC
  or UIPI headaches; trajectories are trivially recordable, which makes evals possible.
- **Cons**: does not serve "operate my Figma / test my macOS app"; needs image + orchestration
  infrastructure; Docker is **not installed on this machine**, so a local dev flow needs WSL2 or
  remote infra.

### D. Hybrid — one contract, three providers (recommended)

Define a single Freebuff Computer Use contract and implement it over three interchangeable
providers, selected per session:

1. **Browser** — the existing Preview/Chromium surface.
2. **Local desktop** — a native background driver (approach B1 first).
3. **Sandbox** — container/cloud desktop for Web/Cloud/CI and for untrusted targets (approach C).

Design the contract on where the ecosystem has converged, not on guesswork:

- **Observation**: accessibility tree + optional screenshot, with per-node indices (set-of-mark),
  plus tunables for text length and tree size.
- **Addressing**: element token/index **first**; pixel coordinates as a declared fallback for
  canvas surfaces.
- **Freshness**: bind actions to the observation that produced them (frame/observation id) and
  **fail closed** when the binding is stale — never silently retarget.
- **Delivery**: background by default; an explicit, audited foreground escape hatch, and a
  per-platform capability descriptor so unsupported actions are omitted rather than faked.
- **Policy**: per-app/site allowlist, per-action approval reusing Freebuff's approval UX, hard-block
  list, screenshot eviction, and a "doctor" diagnostics surface.

---

## 4. Recommendation

**Take approach D, staged, with B1 as the first native step.**

1. **Phase 0 — contract and skeleton (this repo).** A stdio MCP server
   (`freebuff-computer`) plus a `computer-use` `AgentDefinition` modeled directly on
   `agents/browser-use/browser-use.ts`, and a README/skill that encodes the
   snapshot → plan → act → verify discipline. No native code yet; the browser provider can be
   wired first to validate the contract cheaply.
2. **Phase 1 — native desktop via a wrapped driver.** Normalize `cua-driver` or
   `open-computer-use` into the contract; add app allowlist, approvals, screenshot eviction,
   `doctor`, and background-by-default delivery.
3. **Phase 2 — sandbox provider.** Container desktop for Freebuff Cloud/Web/CI and for
   untrusted targets, reusing the same contract.
4. **Phase 3 — only if justified.** Replace the wrapped driver with our own where the upstream
   gaps actually block users (Chromium right-click, canvas apps), rather than preemptively.

Why this order:

- **It matches Codex's architecture without copying its closed parts.** Codex ships Computer Use as
  an MCP server + Skill; Freebuff already supports per-agent MCP servers, image tool results, and
  manifest-approved hash-pinned MCP tools. The packaging half is a solved problem for us.
- **The expensive part is already solved and MIT-licensed.** Background input on macOS (SkyLight
  SPIs) and UIA injection on Windows are the highest-cost, lowest-differentiation work, and they
  depend on private APIs that must be re-validated on every OS update. Rebuilding them buys
  control we don't yet need.
- **It plays to Freebuff's actual differentiator**: the agent, the orchestration, and the safety
  UX — not the window-server plumbing.
- **Windows-first is a genuine win here.** This machine is Windows 11, and Codex itself is
  *foreground-only* on Windows. The `SendInput + PostMessage` path delivers background,
  no-focus-steal operation on Windows — which is arguably better than the product we are
  imitating.
- **Sandbox later covers the safety story** for Cloud/Web/CI with no contract changes.

Risks to accept explicitly: a third-party driver in the trust boundary (mitigated by hash pinning
and pinning versions), undocumented Apple private APIs (upstream's problem in Phase 1, ours in
Phase 3), regional/platform availability questions, and prompt injection from screen content
(mitigated by approvals plus a dedicated-account recommendation).

---

## 5. Source list

Codex product and model contract:
- https://openai.com/index/codex-for-almost-everything/ (403 to fetch; covered via secondary sources)
- https://learn.chatgpt.com/docs/computer-use
- https://developers.openai.com/api/docs/guides/tools-computer-use
- https://developers.openai.com/api/docs/guides/tools-computer-use-integration
- https://www.digitalapplied.com/blog/openai-codex-desktop-computer-use-plugins-guide
- https://www.mindstudio.ai/blog/openai-codex-computer-use-agents

OS mechanics and open drivers:
- https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md
- https://cua.ai/docs/reference/cua-driver/ (MCP tool reference, JS-rendered)
- https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use
- https://github.com/ifuryst/open-codex-computer-use (README, `skills/open-computer-use/SKILL.md`)
- https://docs.openclaw.ai/nodes/computer-use

Sandboxed reference implementations:
- https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo

Freebuff:
- https://github.com/CodebuffAI/freebuff (`agents/browser-use/browser-use.ts`,
  `common/src/browser-actions.ts`, `common/src/mcp/*`, `packages/agent-runtime/src/mcp.ts`)
- https://freebuff.com/blog/freebuff-launch
