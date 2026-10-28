# Idle session end, orphan safety and single-instance overlay

Verified locally on Windows on 2026-10-28.

## Why

The session that produced this work made 79 tool calls and never called `computer_session`. The
border and cursor stayed on two monitors after the user had moved on, and only a server process
death would have removed them. Cleanup depends on the model remembering a ritual it never used.

## Change

- Two idle budgets: `sessionIdleSeconds` (default 120) hides the border and clears cached target
  geometry; `sessionIdleCloseSeconds` (default 600) closes the helper process and returns it to a
  restartable idle state. The watchdog never fires while a call is in flight.
- The next tool result carries one line saying the previous visible session ended and a new one
  started. It appears once, not on every later call.
- The helper receives the server's PID and checks it every two seconds. A helper whose server is
  gone exits even if its socket is still open.
- A named mutex makes one helper authoritative per desktop session. A second helper exits with code
  3, and the second server reports `owned-elsewhere` instead of painting a second border.
- `~/.freebuff-computer/overlay.json` records the helper so `fbc cleanup` can find it and verify its
  command line before stopping it. `fbc doctor` reports a running or stale helper.
- A failed overlay is retried a bounded number of times per process. Previously one failure disabled
  the overlay for the life of the server.

## Commands and results

| Command | Exit | Result |
| --- | --- | --- |
| `npm test` | 0 | 103 Node tests, including five idle-lifecycle tests. |
| `node scripts/verify-overlay-idle.mjs` | 0 | Real server, real overlay, real pixels. With no session call from the agent and a 10 s budget, both monitor surfaces were visible before the budget and not visible after it; the idle end appears once in the trajectory. |
| `node scripts/verify-overlay-parent-exit.mjs` | 0 | Two monitor surfaces were visible, the parent process was killed while the socket stayed open, and both windows were destroyed. Only the parent watch can explain that result. |
| `node scripts/verify-overlay-singleton.mjs` | 0 | A second helper exited with code 3, wrote "Another Freebuff Computer overlay is already running", never authenticated, and left the first helper running. |
| `node dist/cli.js doctor` | 0 | Status OK; reports a running or stale overlay helper when one is recorded. |

## Notes and limits

- The verification scripts set `FBC_OVERLAY_MUTEX` to a unique name so they can run while a real
  Freebuff session owns the default mutex. The mutex code path is identical; only the name differs.
- Pixel assertions are skipped when no display is available, which cannot happen on the desktop this
  project targets.
- `fbc cleanup` was not exercised against a live stray helper in this run: the helper from the
  reported session had already exited by the time the fix was built. Its logic is a command-line
  check followed by `Stop-Process`, and it refuses any process that is not this project's
  `overlay.ps1`. A live stray run is still worth doing on the next occurrence.
