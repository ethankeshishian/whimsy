/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/whimsy/WhimsyDarkCanvas.h"

#include <algorithm>

#include "mozilla/dom/BrowsingContext.h"
#include "mozilla/dom/CanvasRenderingContext2D.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/HTMLCanvasElement.h"
#include "mozilla/gfx/2D.h"
#include "mozilla/nsZenBoostsBackend.h"
#include "nsIFrame.h"
#include "nsPresContext.h"

namespace mozilla::whimsy {

bool IsDarkInverted(const dom::Document* aDoc) {
  if (!aDoc) {
    return false;
  }
  const dom::BrowsingContext* bc = aDoc->GetBrowsingContext();
  return bc && bc->Top()->IsZenBoostsInverted();
}

nsIFrame* DarkMappingFrame(const dom::HTMLCanvasElement* aCanvas) {
  if (!aCanvas || !IsDarkInverted(aCanvas->OwnerDoc())) {
    return nullptr;
  }
  return aCanvas->GetPrimaryFrame();
}

nscolor MapDarkColor(nscolor aColor, const nsIFrame* aFrame) {
  return aFrame ? zen::nsZenBoostsBackend::ResolveStyleColor(aColor, aFrame)
                : aColor;
}

nscolor DarkShadowColor(nscolor aMapped, nscolor aAuthored,
                        const nsIFrame* aFrame) {
  if (aMapped == aAuthored || !aFrame ||
      !IsDarkInverted(aFrame->PresContext()->Document())) {
    return aMapped;
  }
  auto luma = [](nscolor aColor) {
    return 54 * NS_GET_R(aColor) + 183 * NS_GET_G(aColor) +
           19 * NS_GET_B(aColor);
  };
  return luma(aAuthored) < luma(aMapped) ? aAuthored : aMapped;
}

bool CanvasNeedsDarkFilter(dom::HTMLCanvasElement* aCanvas,
                           const nsIFrame* aFrame) {
  if (!aCanvas || !aFrame) {
    return false;
  }
  const bool inverted = IsDarkInverted(aFrame->PresContext()->Document());
  if (aCanvas->IsOffscreen()) {
    return inverted;
  }
  switch (aCanvas->GetCurrentContextType()) {
    case dom::CanvasContextType::Canvas2D: {
      auto* context = static_cast<dom::CanvasRenderingContext2D*>(
          aCanvas->GetCurrentContext());
      const Maybe<bool> mapped =
          context ? context->WhimsyContentMapped() : Nothing();
      return mapped.isSome() && *mapped != inverted;
    }
    case dom::CanvasContextType::NoContext:
      return false;
    default:
      return inverted;
  }
}

already_AddRefed<gfx::SourceSurface> DarkFiltered(gfx::SourceSurface* aSurface) {
  if (!aSurface) {
    return nullptr;
  }
  RefPtr<gfx::DataSourceSurface> source = aSurface->GetDataSurface();
  if (!source || (source->GetFormat() != gfx::SurfaceFormat::B8G8R8A8 &&
                  source->GetFormat() != gfx::SurfaceFormat::B8G8R8X8)) {
    return nullptr;
  }
  const bool opaque = source->GetFormat() == gfx::SurfaceFormat::B8G8R8X8;
  const gfx::IntSize size = source->GetSize();
  RefPtr<gfx::DataSourceSurface> result =
      gfx::Factory::CreateDataSourceSurface(size, source->GetFormat());
  if (!result) {
    return nullptr;
  }
  gfx::DataSourceSurface::ScopedMap in(source, gfx::DataSourceSurface::READ);
  gfx::DataSourceSurface::ScopedMap out(result, gfx::DataSourceSurface::WRITE);
  if (!in.IsMapped() || !out.IsMapped()) {
    return nullptr;
  }
  // invert(1) then hue-rotate(180deg), on unpremultiplied colour: the same
  // lightness flip the WebRender path applies as filters.
  auto channel = [](float aValue) -> uint8_t {
    return uint8_t(std::clamp(aValue, 0.0f, 1.0f) * 255.0f + 0.5f);
  };
  for (int32_t y = 0; y < size.height; y++) {
    const uint8_t* from = in.GetData() + y * in.GetStride();
    uint8_t* to = out.GetData() + y * out.GetStride();
    for (int32_t x = 0; x < size.width; x++, from += 4, to += 4) {
      // B8G8R8A8 is premultiplied, stored B, G, R, A; X8's fourth byte is
      // unused.
      const uint8_t alpha = opaque ? 255 : from[3];
      if (alpha == 0) {
        to[0] = to[1] = to[2] = to[3] = 0;
        continue;
      }
      const float a = alpha / 255.0f;
      const float b = std::min(from[0] / 255.0f / a, 1.0f);
      const float g = std::min(from[1] / 255.0f / a, 1.0f);
      const float r = std::min(from[2] / 255.0f / a, 1.0f);
      const float outR = 1.0f + 0.574f * r - 1.430f * g - 0.144f * b;
      const float outG = 1.0f - 0.426f * r - 0.430f * g - 0.144f * b;
      const float outB = 1.0f - 0.426f * r - 1.430f * g + 0.856f * b;
      to[0] = channel(std::clamp(outB, 0.0f, 1.0f) * a);
      to[1] = channel(std::clamp(outG, 0.0f, 1.0f) * a);
      to[2] = channel(std::clamp(outR, 0.0f, 1.0f) * a);
      to[3] = alpha;
    }
  }
  return result.forget();
}

}  // namespace mozilla::whimsy
