# Review leftovers (wave7/ux, 2026-10-30)

Status of every finding in `review/design-hig.md` (HIG) and `review/ux-all.md` (UX) after `dev` (wave5/uxfix merged) and the unmerged branches wave6/parity, fix7/settings, fix7/tabs, fix7/mini and fix/panes. "wave7/ux" means this branch fixed it.

| Finding | Status |
|---|---|
| HIG 1 Fire: one key wipes data | Fixed: dev 6d0baa1 (scope rows, explicit red Forget button, result toast) and 817cfc7 (flash). wave7/ux: Forget Everything asks once more, with Cancel as the default. |
| HIG 1b Delete Space as an Undo toast | User: keep the modal. |
| HIG 2 Screenshot harness can't see sheets | Fixed: dev 6c0d317. fix7/tabs adds shots. The pixel-diff gate is still open (lead/harness). |
| HIG 3 Tab badge contrast and clipping | Fixed: dev 13c0b2e, plus fix7/tabs 09cc861. |
| HIG 4 Keep Scratch asks in a toast | Fixed: dev ff9616d. |
| HIG 5 Motion system | Skipped: tokens pass (dev e2019de started it). |
| HIG 6 Mini open motion | Skipped: Mini writer (dev e2019de, wave6 11bcd61). |
| HIG 7 Duplicate Settings panes, scattered rows | fix/panes 63d5cdc. Links pane: dev 1331598. Label length: open, after fix/panes. |
| HIG 8 Names: Folders/Screenshots | Fixed: dev 4f88498. Empty dropdown: dev 3e04bd9. |
| HIG 8 "Notes" vs "New Note" | wave7/ux: the command is now "New Document", and the setting is "New Document app", with Off, Notion, Google Docs and Word. |
| HIG 9 Archive tab | Fixed: dev 6dbb7cb (merged into History filters). fix7/settings 2412971 shortens the intro. |
| HIG 10 Undo isn't offered | Fixed for Snooze and Hide Space: dev 8d216f4. Archive sweep: open (wave6 rewrites WhimsyArchive). |
| HIG 11 Private page copy | wave7/ux: says "close your last private tab" (engine text fix). Card-in-card: open (visual). |
| HIG 12 Startup work before first paint | Deferred: risky to land untested. Needs a profiling pass. |
| HIG 13 Competing hover popovers | wave7/ux 66f3846 (user's call): one host, WhimsyLinkHover. The People card or a link card comes first, and the AI summary is stacked beneath it. Both share a 500 ms delay in, 180 ms out, and one transition. Conflicts with fix7/tabs' People card redesign: port its person card into the host's `#peopleCard`. |
| HIG 14 Tree-tab glitches | Open: needs a visual pass with fresh shots. |
| HIG 15 Folder colours | User: keep the space-accent default. The divider "cutting" a folder was the shot catching it mid-expansion. wave7/ux adds a settled-layout test and makes the shot wait. |
| HIG 16 Updated notice | wave7/ux: "Update settings" replaces "Something broke? Roll back" (Roll back is in Settings). Title alignment is Zen's component. Dev IDs: open. |
| HIG 17 Type and z-index sprawl | Skipped: tokens pass. |
| UX 1–4 Commands and about:keyboard | Fixed: dev 47d6b27, e12b019, 951050f, d839358. |
| UX 5 Private-mode naming | Partly: wave6 d03d96e (Cmd+Shift+N is Scratch). User: Scratch keeps its name. |
| UX 6 Archive naming | Fixed: "View Archive…", "Open in Wayback Machine", Clear Archive (wave6 291b6ac). |
| UX 7 Mini dark only | Skipped: Mini writer (dev 8019eee). |
| UX 8 Native modal prompts | Fixed: dev 319e1b1 (in-window sheet prompts). |
| UX 9 Two Settings vocabularies | Open: 9 Privacy cards remain. Wait for fix/panes, since it rewrites Settings. |
| UX 10 Feature switches | Fixed: dev 3e04bd9 (collapsed "On-demand features"). |
| UX 11 Next Meeting placement | Fixed: dev f79eda1 (moved to General). No Library tab since dev 0553632, which browser_whimsy_next_meeting.js checks. The leftover sprite CSS is harmless. |
| UX 12 Vague labels | Fixed: dev e12b019 and wave6. |
| UX 13 Split command sprawl | Fixed: wave6 2d30723. |
| UX 14 Duplicate controls | Archive: fixed (dev 6dbb7cb). VPN: fix7/settings 4a8d679. Confirm it still has one place. |
| UX 15 Focus rings | Fixed: dev b59e1d3. |
| UX 16 Raw colours and radii | Skipped: tokens pass. |
| UX 17 Shortcut doc mismatch | Skipped: shortcuts writer (fix7/mini 7bfe2e2). |
| UX 18 Dead cheat-sheet strings | Open: `whimsy-cheatsheet-no-match` and `-group-tabs/sidebar/split/page/windows` are unused. Left alone to avoid conflicts with wave6's ftl edits. Delete them after the merge. |
| UX 19 Wordy help | Mostly fixed. 3 descriptions still run 3 sentences (private in-window, Claude space, AI preview). |
| UX 20 Live folder states | Partly: Zen's inline error button shows Jira and Linear errors. The loading skeleton is open. |
| UX 21 Fire flash z-index | Fixed: dev 817cfc7. |
| UX 22 Panels outside WhimsyPanels | Page Watch uses Firefox's notification bar, which has a Dismiss. The reduced-motion and Esc audit of the hover card and AI preview is open. |
