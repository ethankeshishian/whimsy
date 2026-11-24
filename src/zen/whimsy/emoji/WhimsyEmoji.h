/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_whimsy_WhimsyEmoji_h_
#define mozilla_whimsy_WhimsyEmoji_h_

class nsIContent;
class nsIFrame;

namespace mozilla::whimsy {

// Whether aContent draws an emoji as a picture: an <img>, a CSS background,
// or an <svg> that says it's an emoji (emoji or :shortcode: alt text or
// aria-label, an "...emoji" class, or an image named for its code points,
// like Twemoji's 1f605.svg), or sits directly in a wrapper that does.
bool IsEmojiPicture(const nsIContent* aContent);

// Whether aFrame is part of an inline SVG emoji (an <svg> or <use> that
// says it's one), whose fills keep their colours. Cheap for everything that
// isn't SVG.
bool IsInSvgEmoji(const nsIFrame* aFrame);

}  // namespace mozilla::whimsy

#endif
