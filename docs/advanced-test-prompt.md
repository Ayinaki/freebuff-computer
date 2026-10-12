# Advanced Freebuff computer test

Reconnect Freebuff's MCP server to load the current build. Open `docs/computer-use-practice.html`
in your browser yourself, then give Freebuff the prompt below. This page is self-contained, makes
no network requests, and stores nothing outside its current tab. Refresh to start over.

This is a proposed next integration test, not a recorded pass. The page has not been interactively
verified here because the browser preview tool rejected the local-file URL; no alternative route
was used to circumvent that restriction.

## Prompt

Use only the freebuff-computer MCP for all computer observation and interaction. Work in the
already-open “Freebuff computer practice” tab. Preserve all other tabs. Do not use terminal,
browser automation, direct DOM access, file edits, or another computer provider to complete steps.

Begin one computer_session and keep it active for the entire task. End it when finished or
blocked. Use fresh accessibility observations and re-derive indexes after UI changes. Snapshots
returned by actions count as observations; do not reuse old indexes blindly. Report tool failures
and actual observed results rather than assuming success.

Call list_apps and inspect every relevant browser window, including windows sharing the same
process ID. Select the entry titled “Freebuff computer practice” and copy its complete app
selector unchanged into all observations and actions. Do not conclude the tab is absent after
inspecting one window. If titles are inconclusive, observe each browser window using its own
selector. Leave the YouTube window and all unrelated tabs untouched. An MCP restart clears
observations and session state; it does not close browser tabs.

1. Enter delivery name “Overlay trial”, select priority “Urgent”, enter notes “Leave at the front
   desk”, and enable “Handle with care”. Verify those values.
2. Add “Notebook”, “USB cable”, and “Travel mug” to the packing list. Use the Add item button for
   at least two items and the Return key in New item for one. Verify there are exactly three items.
3. Mark Notebook and USB cable as packed. Verify “3 items, 2 packed”.
4. Filter for “mug”. Verify Travel mug is the only visible item. Clear the filter and verify all
   three items return with their checked states preserved.
5. Scroll down to “Review the delivery” and click Generate receipt.
6. Read the receipt and verify these exact facts: Overlay trial; Urgent; Leave at the front desk;
   Handle with care: Yes; all three items; only Notebook and USB cable packed.
7. End the session and leave the receipt visible. Report which tools were exercised, any retries
   or unexpected behavior, and which assertions actually passed. Do not claim cursor animation
   or pixel alignment was independently measured unless you have evidence for it.

Human visual checks: the cursor should begin in the centre, remain visible throughout, glide to
each visible measured target before its action, and disappear only when the session ends. The
status should describe actions and outcomes. The real mouse and keyboard focus should not be
seized by the overlay. A dropdown or scrolling failure is a useful finding, not a reason to bypass
the MCP or silently omit that part of the test.
