# Multi-window verification

## Change and evidence

The upstream Windows 0.3.6 driver selected one MainWindowHandle per process. That
made a second Vivaldi window invisible to discovery even though its tab was open.
The approved patch vendors the MIT-licensed driver at commit
93b817501e0b9fa04fba155face2630bfcd0322e and bundles x64/arm64 builds.
Go is needed to build source, not to install a packed release.

The patched discovery listed two Vivaldi windows with PID 16980 on October 8:
the practice page (HWND 2033548) and YouTube (HWND 722904).
These are historical observations, not selectors to reuse after a restart.

Each current selector includes process name, PID, HWND and process creation time.
The driver validates that identity, rejects ambiguous names/PIDs, and binds
snapshots, actions and focused-element lookups to the selected window.
The overlay also matches the explicit HWND. Policy still gates app names/PIDs,
audit-mode mutations, keys and payloads; handles/timestamps do not grant access.
All 13 wrapper tools and the nine native tool schemas are retained.

The disposable two-window regression reached every routing assertion:
independent reads, identical element indexes in separate windows, structured
set_value, restricted-code setValue, malformed/forged identity refusal,
hard-key refusal, and refusal to redirect an action after its window closes.
It did NOT pass overall: the final foreground-preservation assertion failed.
The final idle-desktop run activated test window B; the pointer also differed
by one pixel. The old assertions remain. WPF type_text is explicitly refused
by the existing upstream fallback gate, so successful WPF typing is not claimed.

The earlier attribution to the WPF value setter was premature: the original
test measured foreground only before and after the complete run. The action
causing activation needed to be isolated; the October 12 follow-up below resolves it. No broad guarantee of background input
can be inferred from the driver's choice of UIA or window messages.

## Commands and exit statuses recorded on October 8

| Command | Exit | Evidence |
| --- | --- | --- |
| npm run typecheck | 0 | TypeScript passed. |
| npm test | 0 | 59 Node tests, no skips; native Go tests passed. |
| node dist/cli.js doctor | 0 | Bundled 0.3.6-freebuff.windows.1, all nine native tools match. |
| node scripts/verify-multiwindow.mjs | 1 | Routing assertions reached; final focus assertion failed. |
| npm pack --ignore-scripts --json | 0 | Local tarball created; nothing published. |
| npm install --prefix $installDir $archive --offline | 0 | Packed installation with Go removed from PATH; no network downloads. |
| node scripts/verify-installed.mjs $installedPackage | 0 | Fresh exact 13-tool handshake, bundled-driver version/path, live discovery, two monitor overlays, session end. |
| powershell.exe -NoProfile -NonInteractive -Command 'Add-Type -Path native/Overlay.cs -ReferencedAssemblies System.Drawing,System.Windows.Forms,System.Web.Extensions' | 0 | Native overlay compiled. |
| git diff --check | 0 | No whitespace errors; line-ending notices only. |

The packed installation was
C:/Users/Ayin/AppData/Local/Temp/fbc-multiwindow-package-21bfc44997614542a337f53aa4811039/node_modules/freebuff-computer.
That package check preceded the final removal of an unreachable first-window
fallback from Get-MainElement; typecheck, full tests and doctor were rerun after
that removal. A new package check is required before treating a newer tarball as verified.

Earlier failed attempts are not passes: the initial WinForms/native-control
fixture exposed panes rather than editable controls; speculative UIA provider
registration failed and was reverted; the WPF fixture initially missed a
System.Xaml reference; and an initial full-suite run failed the unchanged
missing-driver hint assertion. The reference and diagnostic text were corrected.
The focus failure was still unresolved on October 8; the October 12 follow-up below records the fix.

## Remaining verification

- Retest through Freebuff using docs/advanced-test-prompt.md and both browser
  windows. Do not move the practice tab or close YouTube to hide the bug.
- The October 12 run resolves the demonstrated focus failure; broader app/provider coverage remains needed.
- Windows arm64 was compiled but not executed. macOS/Linux were not exercised.
- Mixed-DPI and real display hot-plug remain unverified.
- Screenshots still capture desktop pixels and can include occluding windows.
- HWND reuse inside one live process remains a limitation; process creation time
  protects against PID reuse, not every window-lifecycle race.
- The advanced practice-page flow has not passed here. Its earlier browser
  preview rejected file URLs; no alternate route was used around that restriction.

Restarting the MCP discards observations and visual session state; it does not
close browser tabs. The historical handoff's unconditional focus claim is
contradicted by the live fixture result. Its 26-test/11-tool counts also describe
the original baseline, not the current implementation.

## October 12: automatic focus fixed

Action tracing reproduced activations during structured set_value, restricted-code
setValue, and the close-button click. Microsoft's IUIAutomation2 documentation
explains that action patterns set focus automatically by default:
[AutoSetFocus](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-put_autosetfocus).

The driver now obtains action patterns through a CUIAutomation8 client configured
with AutoSetFocus=false. It reads that flag back before dispatch and finds the
exact runtime ID only within the selected window. Managed UIA observations remain
unchanged. The new adapter covers Invoke, Value, SelectionItem, Toggle,
ExpandCollapse, ScrollItem and Scroll patterns; there is no fallback to the old
automatic-focus mutation path when this client fails.

The live regression exercised Value and Invoke through the new adapter. It kept
all existing assertions, including final focus and pointer equality. Other mapped
pattern methods still need live interaction coverage. WPF type_text retains the
upstream opt-in fallback gate and was tested as an explicit refusal.

| Command | Exit | Result |
| --- | --- | --- |
| node scripts/verify-multiwindow.mjs --trace (before fix) | 1 | Both value setters and the click emitted fixture activation events; focus assertion failed. |
| npm run build | 0 | Rebuilt x64 and arm64 binaries with the embedded action adapter. |
| node scripts/verify-multiwindow.mjs --trace (first fixed run) | 1 | Routing and focus passed; pointer differed while the desktop was in use. This was not a passing full run. |
| node scripts/verify-multiwindow.mjs --trace (user-confirmed idle run) | 0 | Every routing, refusal, focus and pointer assertion passed. No fixture activation events were observed. Foreground stayed 1511510; pointer stayed (-244,1271). |
| npm run typecheck | 0 | TypeScript passed. |
| npm test | 0 | All 59 Node tests passed, zero skipped; native Go tests passed. |
| git diff --check | 0 | No whitespace errors; CRLF notices only. |

The historical handoff's unconditional focus claim was wrong for the default
managed UIA mutation client. This patch fixes the automatic-focus mechanism, but
does not prove that every third-party app refrains from activating itself.

The final package was checked after the focus fix:

| Command | Exit | Result |
| --- | --- | --- |
| npm pack --ignore-scripts --json | 0 | Created the final local tarball; no publication. |
| npm install --prefix $installDir $archive --offline | 0 | Installed with Go removed from PATH. |
| node scripts/verify-installed.mjs $installedPackage | 0 | Fresh exact 13-tool handshake, bundled driver, discovery, two overlays, session end. |
| node dist/cli.js doctor | 0 | Status OK; bundled driver; all nine native tools match. |
| Get-FileHash for the built and installed x64 driver, followed by an equality assertion | 0 | Both SHA256 hashes were E1BAB012016BFD3B50B4625B22D0DEFB3FF449C1E183AEA79B36265B28671087. |

For those commands, $archive was D:/Devs/freebuff-computer/freebuff-computer-0.1.0.tgz,
$installDir was C:/Users/Ayin/AppData/Local/Temp/fbc-background-package-cfc7019971984d91980a3b49497133f5,
and $installedPackage was its node_modules/freebuff-computer directory.
The packaged binary is byte-identical to the driver used in the passing live
mutation test. Package smoke checks observe the desktop; they do not repeat mutations.

No commit, push, or npm publication was performed. The overall project goal remains
active: the advanced Freebuff browser flow, other newly mapped UIA patterns, and
mixed-DPI behavior still need direct verification.

## October 12: remaining pattern coverage

The disposable fixture now includes a checkbox, expandable details, a priority
list, a real ComboBox popup, and a 40-item scrollable list. It reports actual
selection, checkbox and scroll-offset changes as visible accessibility text.
The original two-window edits, refusal, closed-window, focus and pointer
assertions remain in the regression.

Command: `node scripts/verify-multiwindow.mjs --patterns --trace`.

The final run exited 0 and verified:

- Click toggled Handle with care on; secondary Toggle turned it off.
- Expand and Collapse changed the details control's advertised state.
- SelectionItem selected Urgent in the priority list.
- The dropdown opened, selected Express delivery, and closed again.
- Scroll changed the list's real vertical offset.
- ScrollIntoView brought Row 40 into view; scrolling up restored offset zero.
- Every corresponding sibling-window value/offset remained unchanged.
- Both ordinary and restricted-code value edits still reached the chosen window.
- Hard-key, forged-identity and closed-window refusals still held.
- Foreground remained 1511510 and the real pointer remained (-535,79).
- The trace contained no fixture activation events.

An earlier expanded run without the ComboBox also exited 0. The richer final run
covers all pattern families mapped by background-uia.cs: Value, Invoke, Toggle,
ExpandCollapse, SelectionItem, Scroll and ScrollItem.

This is real MCP-to-Windows interaction, not a fake driver test. It does not
prove a full Freebuff browser workflow, arbitrary third-party provider behavior,
virtualized-list handling, or mixed-DPI alignment. Overlay rendering was disabled
for this input-isolation test; the earlier overlay pixel tests remain separate.
WPF type_text still exercises the upstream fallback refusal, not successful typing.

To rerun, leave the mouse and keyboard idle for the test duration, build first,
then run the command above. Only two disposable test-owned windows are mutated;
they are closed on success or failure.

After the expanded fixture was saved, npm run typecheck, npm test (59 Node tests plus native Go tests, zero skips), and git diff --check each exited 0. No production driver code changed in this coverage follow-up; no commit or publication was made.

## October 12: background typing and exact text payloads

The bundled driver's value-based typing path now appends through the same
AutoSetFocus=false client used by set_value. Freebuff opts into that path only
when it launches its bundled Windows driver. An external FBC_DRIVER_CMD keeps
its prior environment behavior. Setting
OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK=0 explicitly disables the path.
The standalone native driver's opt-in gate and original upstream tests remain intact.

The first live attempt exposed a second bug: the upstream MCP dispatcher trimmed
text/value payloads. A requested leading space was lost. Text and values now pass
through unchanged; app/key identifiers retain their existing normalization.
A new native dispatch test checks leading/trailing whitespace, whitespace-only
payloads and Unicode, plus preservation of the selected-window identity.
A failed read of the existing value now aborts rather than overwriting it with
only the appended text.

Verification:
- The first live typing run exited 1 because " appended" lost its leading space.
- The first full suite after removing the standalone opt-in gate exited 1 on the
  unchanged upstream opt-in test. The gate was restored; enablement is now scoped
  to the wrapper's bundled driver. That failed design was not retained.
- npm run typecheck exited 0.
- npm test exited 0 with 59 Node tests and the new native payload test.
- node scripts/verify-multiwindow.mjs --trace exited 0: First changed became
  First changed appended; the sibling stayed unchanged; restricted-code edits,
  hard blocks, identity checks and closed-window isolation passed.
  Foreground stayed 1511510 and pointer stayed (-545,76).

The typing assertion now requires successful observable append behavior, replacing
the earlier expected refusal. All original focus, pointer and isolation assertions
remain. This append path updates the accessible value; it does not synthesize a
sequence of keyboard events or implement arbitrary caret/selection editing.
Prefer indexed set_value when choosing among multiple text fields.

Final checks after adding the bundled-driver/opt-out unit tests:
npm run typecheck, npm test (61 Node tests, zero skips, plus native Go tests),
and git diff --check each exited 0.

The updated package also passed npm pack --ignore-scripts --json (exit 0),
npm install --prefix $installDir $archive --offline (exit 0, Go removed from PATH),
and node scripts/verify-installed.mjs $installedPackage (exit 0).
Here $archive was D:/Devs/freebuff-computer/freebuff-computer-0.1.0.tgz,
$installDir was C:/Users/Ayin/AppData/Local/Temp/fbc-typing-package-41cc5d8baa0c4beeb22181aea11d00ce,
and $installedPackage was its node_modules/freebuff-computer directory.
The fresh handshake retained all 13 tools, the nine-tool driver contract, two
monitor overlays, and session cleanup. No publication or commit was performed.

### Final user-approved hands-off rerun (2026-10-12)

Command: `node scripts/verify-multiwindow.mjs --trace` — exit **0**.
The existing focus and physical-pointer assertions were unchanged. Foreground HWND
was `1511510` before and after; physical pointer was `(-545, 76)` before and after.
Both disposable windows were discovered separately. Independent snapshots,
equal-index edits, background typing, restricted-code routing, ambiguity refusal,
forged-identity refusal, hard blocks, and closed-window isolation all passed.
The fixture was cleaned up. This run did not exercise the real browser practice
flow, mixed-DPI rendering, or the optional expanded UIA-pattern suite.
