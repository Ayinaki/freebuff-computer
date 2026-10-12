# Bundled Windows driver

Source: [open-computer-use v0.3.6](https://github.com/iFurySt/open-codex-computer-use/tree/v0.3.6/apps/OpenComputerUseWindows),
commit `93b817501e0b9fa04fba155face2630bfcd0322e`, under the included MIT license.
`main.go`, `main_test.go`, `runtime.ps1`, and `go.mod` were copied from
`apps/OpenComputerUseWindows`; `LICENSE` was copied from the repository root.

Freebuff's version is `0.3.6-freebuff.windows.1`. The patch enumerates visible
top-level windows instead of selecting a process's MainWindowHandle. Each app
selector includes process name, PID, window handle, and process creation time.
Resolution validates those fields and rejects ambiguous names and stale selectors.
Snapshots, focused-element lookup, and subsequent actions stay within that window.
The snapshot's Window-ID header also lets the overlay select the same window.
Original upstream tests remain intact; `window_test.go` adds cache-isolation tests.

Build from the repository root with `npm run build`; run native tests with
`npm run test:driver`. Go 1.22+ is a source-build requirement approved for this fix.
The driver uses only the Go standard library and Windows' existing PowerShell/UIA
runtime. Builds disable module downloads and automatic toolchain downloads.
Both Windows x64 and arm64 executables are packaged in `dist/native/`.
Installing a packed package does not compile Go or download a separate driver.

`background-uia.cs` is a Freebuff addition, embedded alongside the PowerShell runtime.
Accessibility mutations use CUIAutomation8 with IUIAutomation2.AutoSetFocus=false,
verified by reading the setting before dispatch. The same client locates the exact
runtime ID within the selected window and obtains the requested pattern. Failures
do not fall back to the managed client's focus-setting mutation path. The small
COM adapter follows Windows SDK UIAutomationClient.h; it adds no runtime package.

The upstream window-message input implementation is preserved. This patch does not
promise that every application's accessibility provider accepts background input,
or that screenshots capture obscured windows: upstream captures screen pixels.
An HWND is not a permanent identifier; process creation time guards PID reuse,
but handle reuse inside the same live process remains an OS-level limitation.

For Windows controls without a native edit handle, the bundled driver can append
text through its background accessibility client. This changes the field value;
it does not generate per-key events. Use indexed `set_value` to choose a particular
field and `press_key` separately for submission. Text/value payloads preserve
leading/trailing whitespace. Set
`OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK=0` in the MCP server environment
to disable this append fallback. External driver overrides are not opted in.


Foreground input extension (October 12, 2026): foreground-input.cs is embedded
alongside the runtime and compiled only on use. The wrapper passes FBC_INPUT_MODE,
defaulting explicitly to background. Human startup opt-in foreground routes
Send-Drag, Send-Key and Send-MouseClick through guarded SendInput. UIA operations
retain the existing client. This adds no runtime dependency. See
../../docs/verification-foreground-input.md for tests and limitations.
