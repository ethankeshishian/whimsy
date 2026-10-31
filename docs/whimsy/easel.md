# Easel (Arc's Easels)

Whimsy's Easel copies Arc's Easels: a canvas for collecting what you find on the
web and writing and drawing around it. This file lists what Arc does and what
Whimsy does instead, so gaps stay visible.

Sources: Arc release notes (start.arc.net/release-notes, Dec 2021 to Jun 2023),
start.arc.net/paint-the-internet, the Arc Help Center article on Easels, and
reviews (allthings.how, popsci). Arc.app itself was not inspected.

## Parity table

| Area | Arc | Whimsy |
| --- | --- | --- |
| Create | Command bar "New Easel", sidebar + → New Easel, File → New Easel (Ctrl+Shift+E) | Command bar "New Easel", Ctrl+Shift+E (macOS), `whimsy://easel`, Library → Easels (empty state), capture toolbar → Add to Easel → New Easel |
| Where it lives | Opens as a pinned tab in the current space; archived easels are in Library → Easels & Notes | Opens as a pinned tab (`about:whimsy?easel&id=…`); every easel is in Library → Easels, newest first, searchable by title and text. Notes keep their own Library section |
| Rename | Title at the top of the easel | Title field at the top left; it names the tab |
| Canvas | Large canvas, pinch / Cmd+= / Cmd+− zoom | Infinite canvas with a dot grid. Scroll or Space-drag (or middle-drag) pans; pinch, Cmd+scroll, Cmd+= / Cmd+− zoom; Cmd+0 is 100%, Shift+1 fits everything |
| Text | Text boxes; fonts and colours remembered (Apr 2022) | Text tool (T), or double-click the canvas. Four fonts (Sans, Serif, Mono, Round), three sizes, nine colours; the last font, size and colour are remembered |
| Drawing | Freehand drawing; colours changed by selecting | Pen (P) and Highlighter (H); colour and size apply to the selection, like Arc |
| Shapes | Circles, squares, arrows | Rectangle (R), Ellipse (O), Line (L), Arrow (A); Shift keeps squares, circles and 45° lines; Fill toggles a tint |
| Images | Upload from the device, drop or paste | Image tool (I) opens a file picker; drop or paste images; drop captures from Library → Captures |
| Links | Paste or drop links | Pasting or dropping a URL (or a tab from the sidebar) makes a link card; double-click opens it |
| Captures | Capture tool (Cmd+Shift+2) → Add to Easel → new or existing easel | Cmd+Shift+2 (Firefox Screenshots), drag a region, **Add to Easel** (beside Copy) → menu of New Easel and recent easels. The capture keeps its page, crop and container |
| Live Captures | Play turns a capture into a live, interactive view; Pause goes back; Cmd+R refreshes all | Play (selection bar, or double-click) loads the page in a sandboxed browser in the same container, cropped to the region, refreshed every time the easel opens; Pause goes back; Cmd+R refreshes all. Double-click enters a live capture to use it; Escape or a click outside leaves |
| Private tabs | n/a | Captures from private tabs are refused; in a private window live captures stay paused |
| Arrange | Drag, resize, Delete, Cmd+Z | Drag, resize from eight handles (lines: their two ends), snapping to other items' edges and centres with guides (hold Option to place freely), marquee and Shift-click selection, arrow-key nudging (Shift: 10px) and Option+arrow resizing, Cmd+D duplicate, Cmd+] / Cmd+[ forward/backward, Shift+Cmd+] / [ front/back, Cmd+C / X / V across easels |
| Undo | Cmd+Z | Cmd+Z / Shift+Cmd+Z, and buttons in the top bar; every change is one step |
| Sharing | Private, view-only or editable public links on arc.net; links get preview images | **No public links**: Whimsy has no server. Export menu: Copy Link (the easel's own address; opens it on your devices that sync), Copy as Image, Save as PNG (Light / Dark), Save as PDF (the print dialog). Shift+Cmd+S saves a PNG, like Arc's Save As |
| Export | Save As (Shift+Cmd+S) as PNG, light or dark | Same, plus PDF. Live captures export as their still image |
| Storage | Arc's servers, synced | The profile: `whimsy-easels.json` and `whimsy-easels/<id>/` image files. Firefox Sync's prefs engine carries a copy (`WhimsyEaselSync`, `whimsy.easel.sync`): text, shapes, drawings, links and captures' pages, never images; at most 16 KB per easel (longest drawings dropped first) and 64 KB in all, newest first; deletions sync as tombstones |
| Theme | Follows the Space's colours (Sep 2022) | Follows the space's first theme colour (accent, selection, a faint canvas wash), and light and dark; item colours are stored as names (ink, red…) so drawings stay legible in both |
| Delete | From the Library | Library → Easels → Delete, with Undo in the toast for 8 seconds (images are kept 30 seconds) |

## Keyboard

V select, T text, P pen, H highlighter, R rectangle, O ellipse, L line, A arrow,
I image. Enter adds text or a shape at the centre, or opens the selected item
(edits text, enters a live capture, opens a link). Tab and Shift+Tab walk
through items; past the last one focus leaves the canvas. The toolbars are one
tab stop each, with arrow keys inside. Escape leaves a live capture, then clears
the selection, then returns to the pointer.

## Gaps (known)

- Public share links, collaborators and link preview images (needs a server).
- Arc's per-tool shortcuts aren't documented anywhere we found; the single-letter
  tool keys are Whimsy's.
- Screenshots' Full Page and Visible buttons don't offer Add to Easel; "Add Page
  to Easel" (command bar) captures the whole page (up to 12,000 px tall) instead.
- Line and arrow ends don't snap.
- Images don't sync (Sync's record size); an image item stays on its Mac.
- Arc showed easels read-only on iOS; there's no Whimsy mobile app.

## Code

- `src/zen/whimsy/WhimsyEasel.sys.mjs`: store, New Easel, View Easels…, Add Page to Easel, opening, capture flow, picker.
- `WhimsyEaselSync.sys.mjs`: Sync over the prefs engine, with the size caps.
- `WhimsyEaselChild.sys.mjs` / `WhimsyEaselParent.sys.mjs`: the Add to Easel button in Screenshots' toolbar.
- `content/whimsy-easel.{html,css,mjs}` and `whimsy-easel-model.mjs`: the page.
- `content/whimsy-library-easels.mjs`: Library → Easels.
- Live captures reuse `createLiveBrowser` from `content/whimsy-note-blocks.mjs`.
- Switch: `whimsy.feature.easel` (Settings, under Notes). Off hides the command,
  the capture button and the Library section; open easels say they're off; data stays.
- Tests: `tests/browser_whimsy_easel.js`; screenshots `wave5-easel-*` in `browser_whimsy_screens.js`.
