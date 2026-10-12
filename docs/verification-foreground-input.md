# Optional foreground input verification

October 12, 2026. The user explicitly approved optional foreground input while
keeping background input as the default.

FBC_INPUT_MODE is a human-owned startup environment setting: background (default)
or foreground. Invalid settings fail driver startup. It is forwarded only to the
bundled Windows driver, is reported in driver diagnostics, and appears in the
visible overlay label. No MCP tool exposes a mode mutation.

The implementation uses SendInput for drag, press_key and the existing
window-message click path. It does not replace UIA set-value, accessibility clicks,
value-based typing or scrolling. Input must target the resolved window. Focus,
held buttons/modifiers, geometry and point occlusion are checked. Key/button release
is attempted in finally blocks; foreground activation denial produces an error.
There is no silent foreground fallback in background mode.

Observed checks so far:

- npm run build: exit 0; x64 and arm64 binaries rebuilt.
- npm run typecheck: exit 0.
- npm test: exit 0; 66 Node tests, zero skips, and native Go tests passed.
- First node scripts/verify-drag-input.mjs --foreground: exit 0. The formerly
  failing acceptance assertion passed; sibling remained untouched. Focus changed
  from HWND 1511510 to the selected fixture HWND 4260122 and real pointer moved
  from (-144,1183) to (483,546), as expected for this explicit mode.
- Expanded node scripts/verify-drag-input.mjs --foreground: exit 1 because the
  selected window was not foreground when checked. Shortcut/right-click checks
  were not reached. A hands-off rerun has been requested; it is not a pass yet.

The script retains the original background acceptance and focus/pointer assertions
when --foreground is absent. Its known background failure is not skipped or
reclassified as success. Foreground mode is tested through the wrapper MCP and its
policy rather than a direct helper invocation.

Real-browser Ctrl+T, elevated apps, mixed-DPI foreground input, native arm64
execution and arbitrary third-party app acceptance remain unverified. A successful
input dispatch is not proof of a UI result; observe a fresh snapshot afterward.
No user's Freebuff registration was changed, and nothing was committed or published.

The user chose to defer the hands-off rerun. No further foreground input was sent.
Final npm run typecheck and npm test each exited 0 (66 Node tests and Go tests).
powershell -NoProfile -NonInteractive -File scripts/verify-package.ps1 exited 0:
no-Go offline install, asset hashes, default inputMode=background, exact 13-tool
handshake, native contract and overlay lifecycle passed. Installed location:
C:/Users/Ayin/AppData/Local/Temp/fbc-package-cbd83740a7364435a161ffc2f18ac641/node_modules/freebuff-computer.
git diff --check exited 0 with line-ending notices only.

The expanded foreground live test remains pending; its earlier focus-check failure
is retained above. Enabling the setting in the user's Freebuff registration is a
separate human action and has not been performed by this implementation task.
