/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/whimsy/WhimsyDarkCanvas.h"

#include "mozilla/dom/BrowsingContext.h"
#include "mozilla/dom/CanvasRenderingContext2D.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/HTMLCanvasElement.h"
#include "mozilla/gfx/2D.h"
#include "mozilla/gfx/Filters.h"
#include "mozilla/gfx/Matrix.h"
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

already_AddRefed<gfx::SourceSurface> DarkFiltered(gfx::DrawTarget& aTarget,
                                                  gfx::SourceSurface* aSurface) {
  if (!aSurface) {
    return nullptr;
  }
  const gfx::IntSize size = aSurface->GetSize();
  RefPtr<gfx::DrawTarget> target =
      aTarget.CreateSimilarDrawTarget(size, gfx::SurfaceFormat::B8G8R8A8);
  if (!target) {
    return nullptr;
  }
  RefPtr<gfx::FilterNode> filter =
      target->CreateFilter(gfx::FilterType::COLOR_MATRIX);
  if (!filter) {
    return nullptr;
  }
  // invert(1) then hue-rotate(180deg) (the CSS filter functions' matrices):
  // each channel is 1 - (hue-rotate row . colour). Rows are inputs, columns
  // outputs, the last row the offsets.
  const gfx::Matrix5x4 matrix(0.574f, -0.426f, -0.426f, 0.0f,   //
                              -1.430f, -0.430f, -1.430f, 0.0f,  //
                              -0.144f, -0.144f, 0.856f, 0.0f,   //
                              0.0f, 0.0f, 0.0f, 1.0f,           //
                              1.0f, 1.0f, 1.0f, 0.0f);
  filter->SetAttribute(gfx::ATT_COLOR_MATRIX_MATRIX, matrix);
  filter->SetAttribute(gfx::ATT_COLOR_MATRIX_ALPHA_MODE,
                       (uint32_t)gfx::ALPHA_MODE_STRAIGHT);
  filter->SetInput(gfx::IN_COLOR_MATRIX_IN, aSurface);
  target->DrawFilter(filter,
                     gfx::Rect(0, 0, float(size.width), float(size.height)),
                     gfx::Point(0, 0));
  return target->Snapshot();
}

}  // namespace mozilla::whimsy
