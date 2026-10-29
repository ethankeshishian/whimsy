# Overnight log (Oct 29) — lead updates after each batch

- Batch 1 (01:20–): Copy & share DONE 331e019 (rich link, multi-tab, Copy Links menu, toast). Strip tracking DONE 596ab90 (on by default, Privacy toggle). Cookie banners: Firefox 159 removed its built-in handler → requeued as bundling DuckDuckGo autoconsent (MPL-2.0). Zen #8894 (sites eat Cmd+Shift+C) open, untouched.
- Batch 2: ALL DONE. Cookie banners f983365 (vendored DDG autoconsent 17.0.0 as hidden built-in add-on; whimsy/update-autoconsent.sh; engine_overrides copies addon files into engine/). Private indicator b34d62e (violet). AI kill switch 31abe45 (Privacy; translations stay on). Duplicate Cmd+Shift+D 6197c0a (Arc call: Pin/Unpin -> Cmd+D, Bookmark loses Cmd+D). New tabs below + in folder 1f12361. Dim sleeping 778c58d (off). Title lines 0506501.
- Batch 3: New-tab dock at bottom 01df3f3 (toggle OFF: Arc keeps New Tab at top). Collapse pinned: existed, test fb1e687. Folder colors fd7d2e4. Loading line 97c8f22. A/V badges: existed, test d14431c. Unread badges/dots 7de9553 (title-based). Rename: existed ("Change Label…"), test 364beb2. Group by domain 8bba8b0.
- Shipped 1.24b-w2-dev.32 at 02:49 (batches 1–2). Hit a session limit after batch 3; user said continue.
- Shipped 1.24b-w2-dev.41 at 07:21 (batches 1–3).
- Batch 4: drop tabs on space icons 0af5ef0 (gap: Zen may select another tab after drop; real drag untested). Last tab per space f163197. Emoji search polish 094a978 (Zen PR #16055). Hide switcher 920de53 (OFF). Reorder spaces existed, test 1b3e61a. Open Link in Space 7a193c1. Hex colors dfaf279. Transparency 5a19664 (check on real window). Menu icons c2d3e90. Interface font 043502e. Site-tinted toolbar DROPPED (window never tints).
- Fixed whimsy.folders.colors default that broke firefox.js parsing.
- Scouts (read-only research) in docs/whimsy/scout/batch5–8.md.
