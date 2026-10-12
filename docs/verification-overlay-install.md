# Windows overlay and local installation verification

Verified on 7 October 2026, Windows, in `D:\Devs\freebuff-computer`.
This extends [the restricted-surface and browser record](verification-cua-subset.md).
The project remains incomplete: a Freebuff-initiated model run and mixed-DPI checks are outstanding.

## Implementation

- `src/overlay.ts` hosts an authenticated loopback channel to a separate native Windows renderer.
  `native/Overlay.cs` draws blue monitor borders, a target rectangle and a synthetic cursor using
  layered, click-through windows. PowerShell compiles and hosts the helper.
- Approved actions emit activity through `TrajectoryRecorder`. Raw snapshot frames supply target
  geometry without changing compaction. Mutations invalidate cached frames. Policy refusals emit
  no activity and invoke no driver action. Overlay messages contain no typed text or key payloads.
- `FBC_OVERLAY=0` disables the helper; reduced motion honors both the environment override and the
  Windows animation preference. Failures are reported to the caller. The driver remains usable.
- Setup can generate a standalone agent with absolute Node and server paths. It refuses to
  overwrite an existing agent. The monorepo agent retains its model-constant import.
- The npm package includes the native renderer sources. Nothing was published or committed.

## Commands and results

Desktop checks ran outside the filesystem sandbox because sandboxed PowerShell contaminates the
driver's JSON stream with an `InitializeDefaultDrives` provider error.

| Command | Exit | Evidence |
| --- | --- | --- |
| `node scripts/verify-native-overlay.mjs` (initial attempt) | 1 | C# compilation failed: a readonly Rectangle field on NativeWindow triggered a compiler warning treated as an error. |
| `powershell.exe -NoProfile -NonInteractive -Command "Add-Type -Path native/Overlay.cs -ReferencedAssemblies System.Drawing,System.Windows.Forms,System.Web.Extensions"` (diagnosis) | 1 | Confirmed the compiler failure; replaced the field with a property. |
| `npm run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node scripts/verify-native-overlay.mjs` (after fix) | 0 | Actual screen pixels, window styles, focus/pointer preservation, idle hiding and shutdown passed. |
| `npm run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node scripts/verify-cua-subset.mjs explorer` | 0 | Exact twelve-tool MCP handshake; indexed Explorer snapshot; renderer running on both monitors. |
| `npm run typecheck; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm test; exit $LASTEXITCODE` (latest run) | 0 | Typecheck 0; all 47 tests passed, zero failed or skipped. Includes the original 26 tests. |
| `freebuff --help` | 0 | Installed client offers interactive operation and `--cwd`/`--trust-agents`; no headless task flag was advertised. |
| `git diff --check` | 0 | No tracked whitespace errors; Git emitted line-ending notices. |

The local package/install command was:

```powershell
$packDir = Join-Path $env:TEMP ('fbc-package-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $packDir | Out-Null; Write-Output "Package directory: $packDir"; npm pack --pack-destination $packDir; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; $tarball = Join-Path $packDir 'freebuff-computer-0.1.0.tgz'; npm install --prefix (Join-Path $packDir 'installed') $tarball; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node (Join-Path $packDir 'installed/node_modules/freebuff-computer/dist/cli.js') doctor; exit $LASTEXITCODE
```

It exited 0: build, pack, install and the installed CLI doctor each succeeded. Doctor matched all
nine native driver tools. The resolved directory was
`C:\Users\Ayin\AppData\Local\Temp\fbc-package-3990c575b5aa48d989113b48d857b223`.
The tarball predates the subsequent README/verifier additions; its production code matches those checks.

The installed package was then checked with these exact commands (both exit 0):

```powershell
node scripts/verify-installed.mjs C:\Users\Ayin\AppData\Local\Temp\fbc-package-3990c575b5aa48d989113b48d857b223\installed\node_modules\freebuff-computer
node scripts/verify-native-overlay.mjs C:\Users\Ayin\AppData\Local\Temp\fbc-package-3990c575b5aa48d989113b48d857b223\installed\node_modules\freebuff-computer
```

The first generated and imported a `.agents/computer-use.js` file in a separate temporary
workspace, launched exactly its MCP configuration from that workspace, asserted the complete
twelve-tool set, and executed read-only `cua.listApps()` in audit mode. The packaged renderer
acknowledged paints on both monitors. This is an MCP-client integration test, not a Freebuff model run.

The pixel probe measured 6 target-edge pixels, 131 synthetic-cursor pixels, 0 blue interior pixels
and 2 blue border samples on each monitor. Both windows had extended styles `0x080800A8`.
Foreground window and real-pointer coordinates were unchanged. Idle hiding and window destruction
on shutdown passed. Monitor bounds were `(0,0,2560,1440)` and `(-1080,-483,1080,1920)`, both scale 1.

## Unverified or failed checks

- The command `freebuff --cwd C:\Users\Ayin\AppData\Local\Temp\fbc-installed-workspace-WxCyFz --trust-agents`
  opened the real client. Its terminal UI did not establish that the generated agent loaded.
  An attempted menu interaction produced an unknown-command error, not a model task. Exit shortcuts
  did not reliably close it; the specifically identified verification process was stopped and the
  command exited 1. This is **not** a passing Freebuff integration test. No model task was submitted.
- Both monitors use 100% scaling. Negative desktop coordinates are verified; mixed DPI and display
  hot-plug are not. The Windows-only renderer does not establish macOS/Linux behavior.
- Pixel checks prove the tested rendering and window flags. They do not test every desktop app,
  administrator window, remote session or device configuration.
- The browser test's `ctrl+t` shortcut reported success without a tab opening. Clicking New Tab,
  setting the address and pressing Return succeeded. Modifier shortcuts remain an open issue.
- There is no CI run or npm publication. Publishing remains explicitly prohibited without permission.

The browser-test helper processes from the earlier run were explicitly interrupted (exit 1) after
their readline shutdown hung. The successful browser observations remain recorded separately;
process termination is not counted as a passing check.

## Follow-up: workspace registration and real Freebuff discovery

`setup --mcp-file <path>` now writes the shared workspace registration for ordinary Freebuff
agents. It uses absolute executable paths and exclusive creation, never replacing existing
connectors. When requested alongside an agent file, both destination paths are checked for
conflicts before either is written. Tests cover registration contents, preservation of existing
connectors, conflicting destinations and missing option values.

`npm run typecheck; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm test; exit $LASTEXITCODE`
exited 0 after this change: typecheck 0, **49 tests passed, zero failed or skipped**.
`git diff --check` also exited 0.

The updated package was checked with this exact command, exit 0:

```powershell
$packDir = Join-Path $env:TEMP ('fbc-package-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $packDir | Out-Null; Write-Output "Package directory: $packDir"; npm pack --pack-destination $packDir; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm install --prefix (Join-Path $packDir 'installed') (Join-Path $packDir 'freebuff-computer-0.1.0.tgz'); if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node scripts/verify-installed.mjs (Join-Path $packDir 'installed/node_modules/freebuff-computer'); exit $LASTEXITCODE
```

Resolved package directory: `C:\Users\Ayin\AppData\Local\Temp\fbc-package-46ed4e20fdcb4379a2eff7d3bdd70517`.
The verifier generated both `.agents/computer-use.js` and `.agents/mcp.json`, asserted that their
server entries match, and successfully exercised all previous handshake/driver/renderer checks.
Its isolated workspace was `C:\Users\Ayin\AppData\Local\Temp\fbc-installed-workspace-s5DvzI`.

The actual Freebuff UI was launched with:

```powershell
$env:FBC_POLICY_MODE = 'audit'; $env:FBC_STATE_DIR = 'C:\Users\Ayin\AppData\Local\Temp\fbc-installed-workspace-s5DvzI\state'; & C:\Users\Ayin\.config\manicode\freebuff.exe --cwd C:\Users\Ayin\AppData\Local\Temp\fbc-installed-workspace-s5DvzI --trust-agents
```

Entering `@computer` without submitting a prompt displayed **`@computer-use`** in the agent
autocomplete, alongside the file suggestion `@.agents\computer-use.js`. This establishes actual
client discovery and supersedes that part of the earlier inconclusive check. No model task was
submitted. Execution through a Freebuff model remains unverified and awaits authorization.
The terminal's repeated exit shortcuts did not close the client; its specifically scoped test
process was stopped instead; the command exited 1. That shutdown is not a passing exit-code check.

Version correction: `& C:\Users\Ayin\.config\manicode\freebuff.exe --version` exited 0 and returned
**0.2.21**, while the installed npm launcher package reports **0.0.178**. The handoff's older host
facts should not be mistaken for this binary's version. Its bundled loader accepts `.ts`, `.tsx`,
`.js`, `.mjs`, and `.cjs`, rather than only the `.ts`/`.js` examples in the handoff.

## Follow-up: display changes and abrupt host shutdown

The renderer now reports updated monitor windows and a display revision after rebuilding.
The server discards cached target frames when that revision changes, including during a snapshot
read. A stable new snapshot is required before the synthetic cursor can use those frames again.
The renderer also clears its old target when rebuilding and checks its input queue and socket EOF
from the UI timer: a wake posted to a window being destroyed can no longer strand the helper.

The live probe sends `WM_DISPLAYCHANGE` only to its own overlay window. It verifies that the
reported revision increases, new windows exist and paint, and a subsequent action still renders
the target and cursor without stealing focus or moving the real pointer. This does **not** change
the user's display configuration or prove physical hot-plug/mixed-DPI correctness.

`node scripts/verify-overlay-exit.mjs` starts a separate test-owned host, paints active activity,
terminates that host abruptly and checks that both native overlay windows disappear. It exited 0.

After adding the coordinate-invalidation regression test, this exact combined command exited 0:

```powershell
npm run typecheck; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node scripts/verify-native-overlay.mjs; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node scripts/verify-overlay-exit.mjs; exit $LASTEXITCODE
```

Typecheck exited 0; **50 tests passed, zero failed or skipped**. Both live verifiers exited 0.
The renderer reported display revision 1 before the notification and 2 after it. Both monitor
borders, the target and cursor, transparency, focus/pointer preservation, idle hiding and normal
shutdown passed. Abrupt termination removed both active overlay windows as well.
The earlier installed tarballs do not contain this later display-lifecycle change; these checks
ran against the current source build. No additional package-install claim is made for it.

## Follow-up: CI definition and latest packed build

Added `.github/workflows/verify.yml` for Windows with Node 18, 22 and 24. It installs the locked
dependencies and verified `open-computer-use@0.3.6`, requires the driver on PATH, checks doctor,
runs typecheck and every test, compiles the native overlay, and verifies a packed installation.
The workflow has read-only repository permissions. It disables drawing on the hosted runner;
interactive pixel, focus and display-configuration checks remain desktop-only checks.
No commit or push was made, so **the GitHub workflow and Node 18/22 jobs have not run**.

The installation verifier now generates an explicit `.mjs` agent, which both the installed
Freebuff loader and Node 18 accept without newer Node syntax-detection behavior. The prior actual
Freebuff discovery check used `.js`; no model execution is claimed for either extension.

These local equivalents ran on Node 24 and exited 0:

```powershell
powershell.exe -NoProfile -NonInteractive -Command 'Add-Type -Path native/Overlay.cs -ReferencedAssemblies System.Drawing,System.Windows.Forms,System.Web.Extensions -ErrorAction Stop'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; $env:FBC_OVERLAY = '0'; $packDir = Join-Path $env:TEMP ('fbc-ci-install-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $packDir | Out-Null; $package = npm pack --ignore-scripts --pack-destination $packDir --json | ConvertFrom-Json; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; $installDir = Join-Path $packDir 'installed'; npm install --prefix $installDir (Join-Path $packDir $package[0].filename); if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node scripts/verify-installed.mjs (Join-Path $installDir 'node_modules/freebuff-computer'); exit $LASTEXITCODE
```

Resolved directory: `C:\Users\Ayin\AppData\Local\Temp\fbc-ci-install-e35b8bd59b234cd6988dc4f24274f122`.
This package contains the later display-lifecycle changes. Native compilation, pack, install,
generated registration/import, the exact twelve-tool handshake and real read-only driver discovery
passed. The overlay was deliberately disabled for this CI-equivalent check; it is not another
pixel-test pass. The prior source-build rendering/lifecycle checks remain the visual evidence.

## 8 October: user-run Freebuff test stopped at connection discovery

The user supplied Freebuff's report from the requested browser test. It reported that
`call_mcp_tool(server="freebuff-computer", tool="computer_doctor")` failed with
`No MCP server named "freebuff-computer" is configured.` No browser action ran. This is a failed
connection/integration check, not a policy refusal or evidence of a driver failure.

Freebuff subsequently reported adding a user-level registration and successfully listing all
twelve tools through a separate stdio client. An independent read here confirmed that
`~/.agents/mcp.json` contains this entry:

```json
{"command":"node","args":["D:/Devs/freebuff-computer/dist/cli.js","server"]}
```

The read found no record with `configKey: "freebuff-computer"` in the approval store. No user
configuration or approval record was edited here. The user must review/enable the connection
inside Freebuff, reload the client if necessary, and test from a fresh chat. The exact Desktop
code path that omitted the original project registration remains unproven; per-key directory
precedence does not by itself explain omission of a unique server name.

Corrections to statements in the supplied report:

- The overlay has been exercised through the real MCP server path, as recorded above. A
  Freebuff-initiated browser task is the missing check.
- `ComputerDriver.callTool()` and `listDriverTools()` call `start()` too; startup is not reachable
  only through doctor. The initialize/tools-list-only handshake still does not invoke the driver.
- The claim that every build invalidates Freebuff approval has not been verified. The existence
  of launch/manifest hashes alone does not establish whether source-file bytes are included.

README setup instructions now distinguish registration from an approved, connected server.
No production source or build output changed for this documentation correction, and the test
suite was not rerun. Previous passing results remain historical results, not a passing Freebuff
browser test.

## October 12: reproducible no-Go package verification

Added scripts/verify-package.ps1 and replaced the CI inline packaging commands with
that shared check. It builds no source and publishes nothing: run npm run build
first. It packs the current build, removes Go-containing PATH entries, asserts Go
cannot be resolved, installs the tarball offline in a unique temporary folder,
compares SHA-256 hashes of both Windows binaries and the server/overlay assets,
and runs the installed-package MCP verifier. PATH is restored in finally.

Command: powershell -NoProfile -NonInteractive -File scripts/verify-package.ps1
Exit: **0**. Its npm pack --ignore-scripts --json, npm install --prefix ... --offline,
and node scripts/verify-installed.mjs ... commands each exited 0.

Installed location:
C:/Users/Ayin/AppData/Local/Temp/fbc-package-77a0be0cbbe94231a24a502c8d37859b/node_modules/freebuff-computer

The installed MCP advertised exactly 13 tools, used its own bundled native driver,
matched all nine native tools, displayed two monitor overlays and ended its session.
Both monitors reported scale 1. The read-only restricted-code discovery call passed.
This validates the latest packaged build, not a remote clone or a published release.
Offline dependencies came from the local npm cache. Hosted CI has not run.

This does not change the failing live drag result or verify the advanced Freebuff
browser run. No commit, push or publication was made.

## Setup failure leaves no registration files

A missing FBC_DRIVER_CMD used to return exit 1 after writing the agent, MCP
registration and default config. Retry then refused the files it had just created.
Driver preflight now runs before those writes. A regression verifies the failure
creates none of the three files and that retry with the available driver succeeds.

The new targeted regression initially exited 1, reproducing the bug. After the fix,
npm run typecheck and npm test exited 0 (65 Node tests, zero skips, plus Go tests).
powershell -NoProfile -NonInteractive -File scripts/verify-package.ps1 and
git diff --check also exited 0. The latest installed test package is
C:/Users/Ayin/AppData/Local/Temp/fbc-package-0cd29d4c25cc493fa17eb787330f783e/node_modules/freebuff-computer.
The installed setup, exact 13-tool handshake, native contract, overlay session and
cleanup passed. The separate live drag acceptance failure remains unresolved.
