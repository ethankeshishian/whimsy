/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_whimsy_WhimsyDarkCanvas_h_
#define mozilla_whimsy_WhimsyDarkCanvas_h_

#include "mozilla/AlreadyAddRefed.h"
#include "nsColor.h"

class nsIFrame;

namespace mozilla {
namespace dom {
class Document;
class HTMLCanvasElement;
}  // namespace dom
namespace gfx {
class SourceSurface;
}  // namespace gfx

namespace whimsy {

// W30 canvas dark pages. A 2D canvas on a page that adaptive dark (or a Zen
// Boosts inversion) recolours gets its colours recoloured as it draws, the
// way the paint-time StyleColor mapping recolours CSS colours: fills,
// strokes, text, shadows and gradient stops. Colour-font glyphs (emoji)
// ignore the fill colour, and images keep their pixels, as <img> does.

// Whether the page aDoc belongs to is recoloured (its top browsing context
// is inverted).
bool IsDarkInverted(const dom::Document* aDoc);

// The frame a 2D canvas maps its colours through: its own primary frame
// while the page is recoloured, else null (no mapping). A canvas that isn't
// rendered (detached, display: none, a worker's) draws its colours as given,
// so hidden hit-testing canvases read back what they drew.
nsIFrame* DarkMappingFrame(const dom::HTMLCanvasElement* aCanvas);

// aColor through the page's mapping for aFrame (DarkMappingFrame's result);
// unchanged for a null frame.
nscolor MapDarkColor(nscolor aColor, const nsIFrame* aFrame);

// W31 box shadows on a recoloured page. A blurred shadow is a shadow, not a
// colour the page shows: inverting a dark one turns it into a light halo
// around its box. It stays a dark shadow of the same shape: the darker of
// its authored colour (aAuthored) and its recoloured one (aMapped). Returns
// aMapped unchanged when the page isn't recoloured.
nscolor DarkShadowColor(nscolor aMapped, nscolor aAuthored,
                        const nsIFrame* aFrame);

// Display time: whether this canvas's pixels still need the lightness flip
// as a filter. Contexts that can't recolour as they draw (WebGL, WebGPU,
// bitmap renderer, a worker's canvas) keep the old filter on a recoloured
// page, and a 2D canvas whose pixels were drawn in the other mode (before
// the page switched, or a print copy of a recoloured canvas) gets it until
// it next draws.
bool CanvasNeedsDarkFilter(dom::HTMLCanvasElement* aCanvas,
                           const nsIFrame* aFrame);

// aSurface through invert(1) hue-rotate(180deg), for the software paint
// path, keeping each pixel's alpha (a transparent canvas stays
// transparent); null if it couldn't be made.
already_AddRefed<gfx::SourceSurface> DarkFiltered(gfx::SourceSurface* aSurface);

}  // namespace whimsy
}  // namespace mozilla

#endif
