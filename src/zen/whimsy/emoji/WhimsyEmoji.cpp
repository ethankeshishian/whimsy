/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/whimsy/WhimsyEmoji.h"

#include "mozilla/Utf16.h"
#include "mozilla/dom/Element.h"
#include "nsCRT.h"
#include "nsFrameStateBits.h"
#include "nsGkAtoms.h"
#include "nsIContent.h"
#include "nsIFrame.h"
#include "nsString.h"
#include "nsUnicharUtils.h"
#include "nsUnicodeProperties.h"

namespace mozilla::whimsy {

// Longest alt text, label, file name or class list worth reading.
static constexpr uint32_t kMaxLength = 64;

static bool IsJoiner(uint32_t aCh) {
  // Zero-width joiner, both presentation selectors, the keycap and the tag
  // characters (subdivision flags) sit between the parts of one emoji.
  return aCh == 0x200D || unicode::IsEmojiPresentationSelector(aCh) ||
         aCh == 0x20E3 || (aCh >= 0xE0020 && aCh <= 0xE007F);
}

// Text that is only emoji, like 😅 or 👋🏻 or ❤️.
static bool IsEmojiText(const nsAString& aText) {
  bool emoji = false;
  for (uint32_t i = 0; i < aText.Length(); i++) {
    uint32_t ch = aText[i];
    if (IsHighSurrogate(ch) && i + 1 < aText.Length() &&
        IsLowSurrogate(aText[i + 1])) {
      ch = SurrogateToUCS4(ch, aText[++i]);
    }
    const auto presentation = unicode::GetEmojiPresentation(ch);
    if (ch == unicode::kVariationSelector16 ||
        presentation == unicode::EmojiDefault) {
      emoji = true;
    } else if (presentation == unicode::TextOnly && !IsJoiner(ch)) {
      return false;
    }
  }
  return emoji;
}

static bool IsShortcodeChar(char16_t aCh) {
  return (aCh >= 'a' && aCh <= 'z') || (aCh >= 'A' && aCh <= 'Z') ||
         (aCh >= '0' && aCh <= '9') || aCh == '_' || aCh == '+' || aCh == '-';
}

// Chat apps' shortcodes, like :sweat_smile: or :wave::skin-tone-2:.
static bool IsShortcode(const nsAString& aText) {
  const uint32_t length = aText.Length();
  if (length < 3 || aText[0] != ':' || aText[length - 1] != ':') {
    return false;
  }
  uint32_t i = 0;
  while (i < length) {
    if (aText[i] != ':') {
      return false;
    }
    uint32_t name = ++i;
    while (i < length && IsShortcodeChar(aText[i])) {
      i++;
    }
    if (i == name || i >= length || aText[i] != ':') {
      return false;
    }
    i++;
  }
  return true;
}

static bool IsEmojiLabel(const nsAString& aText) {
  if (aText.IsEmpty() || aText.Length() > kMaxLength) {
    return false;
  }
  nsAutoString text(aText);
  text.Trim(" \t\n\r");
  return IsEmojiText(text) || IsShortcode(text);
}

static bool IsHexDigit(char16_t aCh) {
  return (aCh >= '0' && aCh <= '9') || (aCh >= 'a' && aCh <= 'f') ||
         (aCh >= 'A' && aCh <= 'F');
}

// A name made of an emoji's code points, the way emoji sets name their
// images and sprite symbols: 1f605, 1f44b-1f3fb, 2764-fe0f, emoji_u1f605,
// e-1f605. Text-default symbols alone (2764, 2122) only count when the
// image's address says it's an emoji, since a bare number like 2049 is
// usually something else.
static bool IsCodepointName(const nsAString& aName, bool aEmojiPath) {
  if (aName.IsEmpty() || aName.Length() > kMaxLength) {
    return false;
  }
  bool started = false;
  bool emojiDefault = false;
  bool emoji = false;
  uint32_t i = 0;
  const uint32_t length = aName.Length();
  while (i < length) {
    const uint32_t start = i;
    while (i < length && aName[i] != '-' && aName[i] != '_') {
      i++;
    }
    uint32_t tokenStart = start;
    if (!started && i - start > 1 &&
        (aName[start] == 'u' || aName[start] == 'U')) {
      tokenStart++;  // Noto's emoji_u1f605
    }
    const nsDependentSubstring token(aName, tokenStart, i - tokenStart);
    i++;  // the separator
    bool hex = token.Length() >= 4 && token.Length() <= 6;
    for (uint32_t j = 0; hex && j < token.Length(); j++) {
      hex = IsHexDigit(token[j]);
    }
    if (!hex) {
      if (started) {
        return false;
      }
      continue;  // a prefix like "emoji" or "e"
    }
    started = true;
    nsresult rv;
    const uint32_t ch = PromiseFlatString(token).ToInteger(&rv, 16);
    if (NS_FAILED(rv) || ch > 0x10FFFF) {
      return false;
    }
    const auto presentation = unicode::GetEmojiPresentation(ch);
    if (presentation == unicode::EmojiDefault ||
        ch == unicode::kVariationSelector16) {
      emojiDefault = true;
      emoji = true;
    } else if (presentation == unicode::TextDefault) {
      emoji = true;
    } else if (!IsJoiner(ch)) {
      return false;
    }
  }
  return emojiDefault || (emoji && aEmojiPath);
}

// The last path segment of a URL, without its query, fragment or extension.
static bool IsCodepointUrl(const nsAString& aUrl) {
  if (aUrl.IsEmpty() || StringBeginsWith(aUrl, u"data:"_ns)) {
    return false;
  }
  int32_t end = aUrl.FindCharInSet(u"?#");
  nsDependentSubstring path(aUrl, 0, end < 0 ? aUrl.Length() : end);
  const int32_t slash = path.RFindChar('/');
  nsDependentSubstring file(path, slash + 1);
  const int32_t dot = file.FindChar('.');
  nsDependentSubstring name(file, 0, dot < 0 ? file.Length() : dot);
  nsAutoString lower(path);
  ToLowerCase(lower);
  return IsCodepointName(name, lower.Find(u"emoji") >= 0);
}

static bool EndsWithEmoji(const nsAString& aToken) {
  return aToken.Length() >= 5 &&
         Substring(aToken, aToken.Length() - 5)
             .LowerCaseEqualsLiteral("emoji");
}

// A class like "emoji", "c-emoji" or "twemoji" (not "emoji-button" or
// "emoji-picker", which are controls), or a tag like GitHub's <g-emoji>.
static bool HasEmojiName(const dom::Element* aElement) {
  if (EndsWithEmoji(nsDependentAtomString(aElement->NodeInfo()->NameAtom()))) {
    return true;
  }
  nsAutoString classes;
  if (!aElement->GetAttr(nsGkAtoms::_class, classes)) {
    return false;
  }
  uint32_t i = 0;
  const uint32_t length = classes.Length();
  while (i < length) {
    while (i < length && nsCRT::IsAsciiSpace(classes[i])) {
      i++;
    }
    const uint32_t start = i;
    while (i < length && !nsCRT::IsAsciiSpace(classes[i])) {
      i++;
    }
    if (i > start && EndsWithEmoji(Substring(classes, start, i - start))) {
      return true;
    }
  }
  return false;
}

static bool SaysEmoji(const dom::Element* aElement) {
  nsAutoString text;
  if (aElement->IsHTMLElement(nsGkAtoms::img)) {
    if (aElement->GetAttr(nsGkAtoms::alt, text) && IsEmojiLabel(text)) {
      return true;
    }
    if (aElement->GetAttr(nsGkAtoms::src, text) && IsCodepointUrl(text)) {
      return true;
    }
  }
  if (aElement->GetAttr(nsGkAtoms::aria_label, text) && IsEmojiLabel(text)) {
    return true;
  }
  if (aElement->IsSVGElement(nsGkAtoms::use)) {
    if ((aElement->GetAttr(nsGkAtoms::href, text) ||
         aElement->GetAttr(kNameSpaceID_XLink, nsGkAtoms::href, text)) &&
        !text.IsEmpty()) {
      const int32_t hash = text.FindChar('#');
      if (hash >= 0 &&
          IsCodepointName(Substring(text, hash + 1), /* aEmojiPath */ false)) {
        return true;
      }
    }
  }
  return HasEmojiName(aElement);
}

bool IsEmojiPicture(const nsIContent* aContent) {
  if (!aContent || !aContent->IsElement()) {
    return false;
  }
  if (SaysEmoji(aContent->AsElement())) {
    return true;
  }
  const nsIContent* parent = aContent->GetFlattenedTreeParent();
  return parent && parent->IsElement() && HasEmojiName(parent->AsElement());
}

bool IsInSvgEmoji(const nsIFrame* aFrame) {
  if (!aFrame || !aFrame->HasAnyStateBits(NS_FRAME_SVG_LAYOUT)) {
    return false;
  }
  for (const nsIContent* content = aFrame->GetContent(); content;
       content = content->GetFlattenedTreeParent()) {
    if (!content->IsSVGElement()) {
      return false;
    }
    if (content->IsSVGElement(nsGkAtoms::use) &&
        SaysEmoji(content->AsElement())) {
      return true;
    }
    if (content->IsSVGElement(nsGkAtoms::svg)) {
      const nsIContent* parent = content->GetFlattenedTreeParent();
      if (!parent || !parent->IsSVGElement()) {
        return IsEmojiPicture(content);  // the outer <svg>
      }
    }
  }
  return false;
}

}  // namespace mozilla::whimsy
