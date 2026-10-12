# Restricted cua surface: verification record

Verified on 7 October 2026 in `D:\Devs\freebuff-computer`, Windows, Node v24.15.0.
The user approved a restricted AST-based surface and a parser dependency after the initial brief.

## Changes

- Added `exec_cua_subset` alongside the existing eleven tools. The end-to-end handshake assertion
  compares the entire sorted set of twelve names for equality.
- Added Acorn as a runtime dependency. An AST allowlist compiles accepted source into a complete
  list of native calls with literal arguments. No submitted JavaScript is evaluated.
- `src/policy.ts` preflights every native call. An invalid statement or policy refusal prevents
  the entire batch from running. Each executed action also uses the existing policy path.
- Kept one persistent driver connection shared by both surfaces, with existing snapshot defaults,
  compaction, and trajectory recording. Serialized requests prevent other calls from changing
  policy or native snapshot state during a batch.
- Added thirteen tests covering static enumeration, all policy modes, escaped hard blocks,
  malformed arguments, AST escape attempts, zero execution on late refusal, output bindings,
  compaction, trajectory recording, runtime failure, and concurrent requests.
- Added a read-only live verification script. No app mutation was performed.

## Commands and exit statuses

Commands below ran from the working checkout unless a `--prefix` is shown. Desktop-driver checks
required execution outside the filesystem sandbox; sandboxed PowerShell emitted a provider error
that contaminated the native driver's JSON.

| Exact command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` (baseline) | 0 | Original checkout typechecked. |
| `npm test` (baseline, sandboxed) | 1 | 25 passed, 1 failed: `InitializeDefaultDrives` output broke driver JSON. No test was skipped. |
| `npm test` (baseline, outside sandbox) | 0 | Original 26 tests passed, zero skipped. |
| `node dist/cli.js doctor` (outside sandbox) | 0 | Status OK; all nine driver tools matched. |
| `$env:FBC_DRIVER_CMD = 'nope-not-real mcp'; node dist/cli.js doctor` | 1 | Expected negative check: status FAILED, install hint supplied. Environment override was confined to that shell. |
| `npm install acorn` (sandboxed) | 1 | Registry DNS lookup failed with ENOTFOUND. |
| `npm install acorn` (outside sandbox) | 0 | Added Acorn 8.19.0; audit reported zero vulnerabilities. |
| `npm run typecheck` (first implementation check) | 1 | MCP handler return type needed a structural object result; fixed before further validation. |
| `npm run typecheck` (after fix, and final rerun) | 0 | Typecheck passed on both runs. |
| `npm test` (implementation and final rerun, outside sandbox) | 0 | 39 passed, zero failed, zero skipped on both runs. Final rerun included stronger zero-execution and compaction assertions. |
| `node scripts/verify-cua-subset.mjs` (outside sandbox) | 0 | Fresh MCP handshake asserted the exact twelve tools; real `cua.listApps()` subset call succeeded in audit mode. |
| `node scripts/verify-cua-subset.mjs explorer` (first run, outside sandbox) | 1 | Driver read succeeded, but the new harness incorrectly expected bracketed indexes. Actual driver nodes use an indented integer followed by the role. |
| `node scripts/verify-cua-subset.mjs explorer` (corrected harness, outside sandbox) | 0 | Fresh exact twelve-tool handshake and real read-only Explorer call succeeded; 217 bytes and indexed accessibility nodes verified. The node check matches the format already parsed by `src/compact.ts`. |
| `git diff --check` | 0 | No whitespace errors in the tracked diff. |

The successful live app call submitted this source through MCP:

```javascript
var app = await cua.getApp("explorer");
var state = await app.getAXState({emit:false,maxTreeNodes:40});
nodeRepl.write(state);
```

## Clean install

The uncommitted source was copied into a new temporary directory without `node_modules` or `dist`.
This verifies the new dependency and build from the current changes without committing them.
The exact PowerShell invocation was:

```powershell
$verifyDir = Join-Path $env:TEMP ('fbc-clean-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $verifyDir | Out-Null; Copy-Item -LiteralPath src,test,scripts,package.json,package-lock.json,tsconfig.json -Destination $verifyDir -Recurse; Write-Output "Clean source copy: $verifyDir"; npm ci --prefix $verifyDir; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run typecheck --prefix $verifyDir; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm test --prefix $verifyDir; exit $LASTEXITCODE
```

The resolved directory was `C:\Users\Ayin\AppData\Local\Temp\fbc-clean-c3b65005e1e445eeb30aac836c92e605`.
The invocation exited 0. `npm ci --prefix $verifyDir`, `npm run typecheck --prefix $verifyDir`, and
`npm test --prefix $verifyDir` each exited 0. The clean test run passed all 39 tests with zero skips.

## Limits and factual corrections

- Live verification covered reads on Windows only. No live click, typing, value change, drag,
  macOS, or Linux test was performed. Mutation dispatch and refusals are covered with a stubbed
  driver through the real MCP handler.
- This is a restricted, call-local syntax, not general JavaScript. Screenshot helpers and
  `rewriteDocumentation` are not supported. Observation variables hold returned text, rather
  than adapter result objects. These differences are documented in the tool schema and README.
- Policy and syntax refusals run nothing. Runtime driver failures can occur after earlier actions
  have completed; there is no rollback.
- A fresh remote clone and npm package installation were not tested. The clean source-copy check
  exercises these uncommitted changes; a remote clone would still contain the prior revision.
- The handoff's environment-variable table is incomplete for the JavaScript adapter: the installed
  adapter also reads `OPEN_COMPUTER_USE_NATIVE_COMMAND` and `OPEN_COMPUTER_USE_NATIVE_ARGS`.
- The handoff itself was untracked alongside `prototype/`; both were preserved.
- No commit, push, publish, or change to the frozen nine native tool schemas was made.

## Follow-up: user-authorized browser mutation test

On 7 October 2026 the user requested a real Google search in their browser. A temporary MCP
client was run with `node scripts/browser-test-session.mjs` outside the filesystem sandbox.
It kept one server/driver connection throughout the browser actions and called
`exec_cua_subset` for every observation and input. The temporary helper was removed afterwards.

- `cua.listApps()` identified Vivaldi, and `cua.getApp("vivaldi")` read its accessibility tree.
- `app.pressKey("ctrl+t")` returned success but did not open a tab. This is a failed behavioral
  check, despite the successful tool response. `computer_doctor` then reported status OK and a
  matching nine-tool contract.
- `app.click("22")`, targeting the observed New Tab button, opened a third tab. The next snapshot
  showed Start Page and focus in the address field. The existing two tabs remained present.
- `app.setValue("46", "https://www.google.com/search?q=London+weather")` set the observed address
  field. A fresh snapshot confirmed the exact URL and address-field focus.
- `app.pressKey("Return")` navigated successfully. The following `app.getAXState({maxTreeNodes:140})`
  returned the page title `London weather - Google Search`, the Google search URL, the search field
  value `London weather`, and a `Weather result` heading with weather content.

All successful steps above used the new subset tool through MCP, not another browser automation
provider. No production source changed during this test. The Google results tab was left open.
This follow-up verifies real click, set-value and Return-key dispatch on Windows; it does not
verify drag, arbitrary typing, or reliable modifier-key shortcuts. It supersedes the initial
read-only limitation above for those specific actions.
