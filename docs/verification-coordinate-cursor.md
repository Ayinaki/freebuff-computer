# Coordinate cursor verification

October 12, 2026.

Coordinate clicks now use the snapshot's window-relative pixel space when an exact
Window-ID is available. The cursor marker is centred on the requested point and
uses the existing glide and pulse behavior. The renderer still validates HWND,
PID, title, size, visibility and occlusion before painting a destination.
Element indexes retain precedence over coordinates, matching the driver's dispatch.

Missing identities, invalid numbers, out-of-bounds coordinates and wrong-window
requests do not invent a destination. No native input or policy behavior changed.
Drag-path animation remains separate unfinished work.

| Command | Exit | Result |
| --- | --- | --- |
| npm run typecheck | 0 | TypeScript passed. |
| npm test | 0 | All 62 Node tests and native Go tests passed; zero skips. |
| node scripts/verify-coordinate-cursor.mjs | 0 | Independent UIA/Win32 measurement matched the coordinate target at (420,582.5); screen pixels contained the dark cursor and white edge there. Invalid targets retained the resting pointer. |
| git diff --check | 0 | No whitespace errors; line-ending notices only. |

The visual check created disposable windows and painted an overlay; it sent no
clicks, keys or text. It observed 76 dark cursor pixels and 722 white pixels in the
probe region. Existing cursor shape, easing, reduced-motion behavior and monitor
border styling were retained. This was a scoped behavioral refinement, not a
visual redesign.

The desktop currently reports both monitors at scale 1. Mixed-DPI placement is
not proven by this result. The advanced Freebuff browser flow is also still
unverified. No commit, push or publication was performed.
Package verification also passed: npm pack --ignore-scripts --json (0), npm install --prefix $installDir $archive --offline (0), and node scripts/verify-installed.mjs $installedPackage (0). Here $archive was D:/Devs/freebuff-computer/freebuff-computer-0.1.0.tgz, $installDir was C:/Users/Ayin/AppData/Local/Temp/fbc-coordinate-package-29848ea20f0546d696b84d2b3339fdae, and $installedPackage was its node_modules/freebuff-computer directory. The fresh handshake advertised exactly 13 tools; both monitor overlays and session cleanup passed.
