# Persistent cursor follow-up

2026-10-08. The user confirmed the prior cursor styling and targeting fixes through a successful
Freebuff browser run, then requested that the pointer remain visible and start at the centre.
This intentionally supersedes the cursor-hiding behavior in verification-cursor-targets.md.

The native renderer now initializes the pointer at the primary monitor's centre, glides from
there on the first targeted action, and retains its position across reads, keyboard actions,
thinking pauses, unknown targets and errors. Geometry remains independently validated. An
unknown target does not move the resting cursor or trigger a click pulse. Window movement or
occlusion during travel stops that travel without removing the session pointer. End removes it;
a subsequent session begins at the centre again. A display rebuild preserves an on-screen
position, or recentres if its monitor disappeared. Reduced motion still disables travel/pulse.

No tools, policy permissions, or dependencies were added. No commit, push, or publication.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | TypeScript check passed. |
| `npm test` | 0 | All 55 tests passed; zero skipped. |
| `node scripts/verify-native-overlay.mjs` | 0 | Screen pixels verified centre start, persistent cursor through reads and a four-second pause, first-action glide, later travel (~411 ms), labels, no target rectangle, transparency, monitor borders, display rebuild, session end/restart, and cleanup. Foreground focus and real pointer stayed unchanged. |
| `node scripts/verify-window-target.mjs vivaldi` | 0 | Independent physical UIA measurement and actual pointer pixels agreed at the real New Tab button. Missing/mismatched identity retained the resting position without guessing. No browser input was sent. |
| `node scripts/verify-cua-subset.mjs explorer` | 0 | Fresh exact 13-tool handshake, real read-only restricted call, two monitor overlays, and session end checks passed. |
| `node scripts/verify-overlay-exit.mjs` | 0 | Both native windows disappeared after abrupt test-host termination. |
| `git diff --check` | 0 | No whitespace errors; Git emitted line-ending notices. |
| `node --input-type=module -e $syntaxCheck` | 0 | Practice-page JavaScript parsed; this is not a browser behavior test. |

The PowerShell variable for the syntax check contained exactly:

```javascript
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
const html=readFileSync('docs/computer-use-practice.html','utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
new Script(source,{filename:'computer-use-practice.html'});
console.log('Practice-page JavaScript syntax passed; no browser interaction tested.');
```

Native lifecycle assertions were changed to require the new persistent behavior rather than the
previous hide-on-read behavior. The window-identity negative cases still require no invented
destination. The first-action timing assertion now checks travel from the initial centre as well
as travel between later targets.

The added practice page and advanced-test prompt cover text fields, a dropdown, checkboxes,
dynamic list insertion, keyboard submission, filtering, scrolling, and final result verification.
They are prepared for the next Freebuff run, not reported as a successful integration test.
The browser preview tool rejected `file:` navigation, so interactive practice-page verification
was not performed and no workaround was attempted. Mixed-DPI and physical display hot-plug
remain unverified. The newest persistent-cursor behavior still needs the user’s Freebuff retest.
