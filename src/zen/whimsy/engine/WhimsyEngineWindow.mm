/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W32 engine seam: the window helpers every engine tab service shares (moved
// whole from nsWhimsyWebKit.mm).

#include "WhimsyEngineWindow.h"

#import <QuartzCore/QuartzCore.h>
#include <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <algorithm>
#include <cmath>

#include "mozilla/ClearOnShutdown.h"
#include "nsCOMPtr.h"
#include "nsCocoaUtils.h"
#include "nsIBaseWindow.h"
#include "nsIDocShell.h"
#include "nsIWidget.h"
#include "nsObjCExceptions.h"
#include "nsPIDOMWindow.h"
#include "nsPIDOMWindowInlines.h"

using namespace mozilla;

namespace whimsy {

namespace {

static NSView* WhimsyChildViewHitTestIMP(NSView* self, SEL _cmd,
                                         NSPoint aPoint) {
  struct objc_super sup = {self, [self superclass]};
  NSView* hit =
      ((NSView * (*)(struct objc_super*, SEL, NSPoint)) objc_msgSendSuper)(
          &sup, _cmd, aPoint);
  if (hit == self) {
    NSArray<NSValue*>* holes =
        objc_getAssociatedObject(self, @selector(whimsyNativeHoles));
    if (holes.count) {
      NSPoint local = [self convertPoint:aPoint fromView:[self superview]];
      for (NSValue* val in holes) {
        if (NSPointInRect(local, [val rectValue])) {
          return nil;
        }
      }
    }
  }
  return hit;
}

}  // namespace

void EnsureChildViewHitTestInstalled(NSView* aChildView) {
  if (!aChildView) {
    return;
  }
  Class cls = [aChildView class];
  IMP childImp = [cls instanceMethodForSelector:@selector(hitTest:)];
  IMP viewImp = [NSView instanceMethodForSelector:@selector(hitTest:)];
  if (childImp == viewImp) {
    class_addMethod(cls, @selector(hitTest:), (IMP)WhimsyChildViewHitTestIMP,
                    "@@:{CGPoint=dd}");
  }
}

namespace {

// Subtract an exclusion rectangle from a list of disjoint rectangles.
static std::vector<NSRect> SubtractRect(const std::vector<NSRect>& aRects,
                                        NSRect aExcl) {
  if (aExcl.size.width <= 0.5 || aExcl.size.height <= 0.5) {
    return aRects;
  }
  std::vector<NSRect> out;
  out.reserve(aRects.size() + 4);
  for (const NSRect& r : aRects) {
    if (!NSIntersectsRect(r, aExcl)) {
      out.push_back(r);
      continue;
    }
    NSRect inter = NSIntersectionRect(r, aExcl);
    // Top band
    if (inter.origin.y - r.origin.y > 0.5) {
      out.push_back(NSMakeRect(r.origin.x, r.origin.y, r.size.width,
                               inter.origin.y - r.origin.y));
    }
    // Bottom band
    if (NSMaxY(r) - NSMaxY(inter) > 0.5) {
      out.push_back(NSMakeRect(r.origin.x, NSMaxY(inter), r.size.width,
                               NSMaxY(r) - NSMaxY(inter)));
    }
    // Left middle band
    if (inter.origin.x - r.origin.x > 0.5 && inter.size.height > 0.5) {
      out.push_back(NSMakeRect(r.origin.x, inter.origin.y,
                               inter.origin.x - r.origin.x, inter.size.height));
    }
    // Right middle band
    if (NSMaxX(r) - NSMaxX(inter) > 0.5 && inter.size.height > 0.5) {
      out.push_back(NSMakeRect(NSMaxX(inter), inter.origin.y,
                               NSMaxX(r) - NSMaxX(inter), inter.size.height));
    }
  }
  return out;
}

// Every engine's holes, by ChildView (weak; owned by widget) and owner.
struct HoleOwner {
  NSView* mChildView = nil;
  const void* mOwner = nullptr;
  std::vector<EngineHole> mHoles;
};

static std::vector<HoleOwner>& HoleOwners() {
  // Never freed: the last engine page can drop its holes during shutdown.
  static auto* sOwners = new std::vector<HoleOwner>();
  return *sOwners;
}

// One finder per engine service.
static constexpr size_t kMaxKeyFinders = 4;
static FocusedEngineTabFinder gKeyFinders[kMaxKeyFinders] = {};
static size_t gKeyFinderCount = 0;
static id gKeyMonitor = nil;

// The engine's view (a WKWebView) sits below Gecko's view, and Gecko paints
// the window's backdrop (the space's theme gradient, the translucent dark
// default, grain, the inactive-window grey) across the whole window, page
// rect included. With nothing else done that paint lands on top of the page
// and dims or tints it. So while an engine page is showing, Gecko's view is
// masked: inside the page's rounded rect only the overlays Whimsy keeps above
// the page (the same exclusions the hit-test honours) are drawn, and
// everywhere else, or with no engine page showing, Gecko draws exactly as
// before.
static void UpdateHoleMask(NSView* aChildView,
                           const std::vector<const EngineHole*>& aShown) {
  CALayer* layer = aChildView.layer;
  if (!layer) {
    return;
  }
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  if (aShown.empty()) {
    layer.mask = nil;
  } else {
    CAShapeLayer* mask = [CAShapeLayer layer];
    mask.frame = layer.bounds;
    mask.fillRule = kCAFillRuleEvenOdd;
    CGMutablePathRef path = CGPathCreateMutable();
    // Reach well past the view's edges so a window that grows before the
    // next layout pass never has its new edge masked away.
    CGPathAddRect(
        path, nullptr,
        CGRectInset(NSRectToCGRect(
                        [aChildView convertRectToLayer:aChildView.bounds]),
                    -16384, -16384));
    for (const EngineHole* entry : aShown) {
      CGRect hole =
          NSRectToCGRect([aChildView convertRectToLayer:entry->mRect]);
      CGFloat radius = std::min({entry->mRadius, hole.size.width / 2,
                                 hole.size.height / 2});
      if (radius > 0) {
        CGPathAddRoundedRect(path, nullptr, hole, radius, radius);
      } else {
        CGPathAddRect(path, nullptr, hole);
      }
      for (const NSRect& excl : entry->mExclusions) {
        CALayer* keep = [CALayer layer];
        keep.frame = [aChildView convertRectToLayer:excl];
        keep.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
        [mask addSublayer:keep];
      }
    }
    mask.path = path;
    CGPathRelease(path);
    layer.mask = mask;
  }
  [CATransaction commit];
}

}  // namespace

NSView* ChildViewForWindow(mozIDOMWindowProxy* aWindow) {
  if (!aWindow) {
    return nil;
  }
  nsCOMPtr<nsPIDOMWindowOuter> outer = nsPIDOMWindowOuter::From(aWindow);
  if (!outer) {
    return nil;
  }
  nsCOMPtr<nsIDocShell> docShell = outer->GetDocShell();
  nsCOMPtr<nsIBaseWindow> baseWin = do_QueryInterface(docShell);
  if (!baseWin) {
    return nil;
  }
  nsCOMPtr<nsIWidget> widget;
  baseWin->GetMainWidget(getter_AddRefs(widget));
  if (!widget) {
    return nil;
  }
  return (NSView*)widget->GetNativeData(NS_NATIVE_WIDGET);
}

nsresult SampleWindowColor(mozIDOMWindowProxy* aWindow, double aX, double aY,
                           double aWidth, double aHeight, nsAString& aOut) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  aOut.Truncate();
  NSView* childView = ChildViewForWindow(aWindow);
  NSWindow* window = [childView window];
  if (!childView || !window || aWidth < 1 || aHeight < 1 ||
      ![NSScreen screens].count) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  // CGWindowListCreateImage is marked unavailable in newer SDKs but still
  // reads back the app's own windows without a Screen Recording grant.
  using CreateImageFn = CGImageRef (*)(CGRect, uint32_t, uint32_t, uint32_t);
  static CreateImageFn sCreateImage =
      (CreateImageFn)dlsym(RTLD_DEFAULT, "CGWindowListCreateImage");
  if (!sCreateImage) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NSRect inWindow =
      [childView convertRect:NSMakeRect(aX, aY, aWidth, aHeight) toView:nil];
  NSRect onScreen = [window convertRectToScreen:inWindow];
  CGFloat primaryTop = NSMaxY([[NSScreen screens][0] frame]);
  CGRect cgRect = CGRectMake(onScreen.origin.x, primaryTop - NSMaxY(onScreen),
                             onScreen.size.width, onScreen.size.height);
  const uint32_t kIncludingWindow = 1 << 3;    // kCGWindowListOptionIncludingWindow
  const uint32_t kIgnoreFraming = 1 << 0;      // kCGWindowImageBoundsIgnoreFraming
  const uint32_t kNominalResolution = 1 << 4;  // kCGWindowImageNominalResolution
  CGImageRef image =
      sCreateImage(cgRect, kIncludingWindow, (uint32_t)[window windowNumber],
                   kIgnoreFraming | kNominalResolution);
  if (!image) {
    return NS_ERROR_FAILURE;
  }
  size_t w = CGImageGetWidth(image);
  size_t h = CGImageGetHeight(image);
  if (!w || !h) {
    CGImageRelease(image);
    return NS_ERROR_FAILURE;
  }
  std::vector<uint8_t> pixels(w * h * 4, 0);
  CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef ctx = CGBitmapContextCreate(
      pixels.data(), w, h, 8, w * 4, srgb,
      kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(srgb);
  if (!ctx) {
    CGImageRelease(image);
    return NS_ERROR_FAILURE;
  }
  CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), image);
  CGContextRelease(ctx);
  CGImageRelease(image);

  double sum[4] = {0, 0, 0, 0};
  int lo = 255;
  int hi = 0;
  for (size_t i = 0; i < w * h; i++) {
    const uint8_t* px = &pixels[i * 4];
    double a = px[3];
    sum[3] += a;
    for (int c = 0; c < 3; c++) {
      int v = a > 0 ? (int)std::lround(std::min(255.0, px[c] * 255.0 / a)) : 0;
      sum[c] += v;
      lo = std::min(lo, v);
      hi = std::max(hi, v);
    }
  }
  double n = (double)(w * h);
  NSString* json = [NSString
      stringWithFormat:@"{\"r\":%.2f,\"g\":%.2f,\"b\":%.2f,\"a\":%.2f,"
                       @"\"min\":%d,\"max\":%d}",
                       sum[0] / n, sum[1] / n, sum[2] / n, sum[3] / n, lo, hi];
  nsCocoaUtils::GetStringForNSString(json, aOut);
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

// Rebuild the associated array of hit-test hole rects on a ChildView from
// every engine's visible "below"-mode pages attached to it, subtracting each
// page's open in-window overlay exclusion rects.
void SetWindowHoles(NSView* aChildView, const void* aOwner,
                    std::vector<EngineHole>&& aHoles) {
  if (!aChildView) {
    return;
  }
  auto& owners = HoleOwners();
  auto it = std::find_if(owners.begin(), owners.end(), [&](const HoleOwner& o) {
    return o.mChildView == aChildView && o.mOwner == aOwner;
  });
  if (aHoles.empty()) {
    if (it != owners.end()) {
      owners.erase(it);
    }
  } else if (it != owners.end()) {
    it->mHoles = std::move(aHoles);
  } else {
    owners.push_back(HoleOwner{aChildView, aOwner, std::move(aHoles)});
  }

  EnsureChildViewHitTestInstalled(aChildView);
  NSMutableArray<NSValue*>* holes = [NSMutableArray array];
  std::vector<const EngineHole*> shown;
  for (const HoleOwner& owner : owners) {
    if (owner.mChildView != aChildView) {
      continue;
    }
    for (const EngineHole& hole : owner.mHoles) {
      if (NSIsEmptyRect(hole.mRect)) {
        continue;
      }
      shown.push_back(&hole);
      std::vector<NSRect> pieces = {hole.mRect};
      for (const NSRect& excl : hole.mExclusions) {
        pieces = SubtractRect(pieces, excl);
      }
      for (const NSRect& piece : pieces) {
        if (piece.size.width > 0.5 && piece.size.height > 0.5) {
          [holes addObject:[NSValue valueWithRect:piece]];
        }
      }
    }
  }
  objc_setAssociatedObject(aChildView, @selector(whimsyNativeHoles),
                           holes.count ? holes : nil,
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  UpdateHoleMask(aChildView, shown);
}

std::vector<ReservedShortcut> ParseReservedShortcuts(const nsAString& aJson) {
  std::vector<ReservedShortcut> out;
  if (aJson.IsEmpty()) {
    return out;
  }
  NSString* jsonStr = nsCocoaUtils::ToNSString(aJson);
  NSData* data = [jsonStr dataUsingEncoding:NSUTF8StringEncoding];
  if (!data) {
    return out;
  }
  id parsed = [NSJSONSerialization JSONObjectWithData:data
                                              options:0
                                                error:nil];
  if (![parsed isKindOfClass:[NSArray class]]) {
    return out;
  }
  for (id item in (NSArray*)parsed) {
    if (![item isKindOfClass:[NSDictionary class]]) {
      continue;
    }
    NSDictionary* dict = (NSDictionary*)item;
    ReservedShortcut shortcut;
    id keyObj = dict[@"key"];
    if ([keyObj isKindOfClass:[NSString class]]) {
      nsCocoaUtils::GetStringForNSString([(NSString*)keyObj lowercaseString],
                                         shortcut.mKey);
    }
    id codeObj = dict[@"keyCode"];
    if ([codeObj respondsToSelector:@selector(unsignedShortValue)]) {
      shortcut.mKeyCode = [codeObj unsignedShortValue];
    }
    shortcut.mCtrl = [dict[@"ctrl"] boolValue];
    shortcut.mShift = [dict[@"shift"] boolValue];
    shortcut.mAlt = [dict[@"alt"] boolValue];
    shortcut.mMeta = [dict[@"meta"] boolValue];
    out.push_back(std::move(shortcut));
  }
  return out;
}

bool MatchesReservedShortcut(const std::vector<ReservedShortcut>& aShortcuts,
                             NSEvent* aEvent) {
  NSEventModifierFlags flags = [aEvent modifierFlags];
  bool cmd = (flags & NSEventModifierFlagCommand) != 0;
  bool ctrl = (flags & NSEventModifierFlagControl) != 0;
  bool opt = (flags & NSEventModifierFlagOption) != 0;
  bool shift = (flags & NSEventModifierFlagShift) != 0;
  unsigned short keyCode = [aEvent keyCode];
  NSString* chars =
      [[aEvent charactersIgnoringModifiers] lowercaseString] ?: @"";
  nsAutoString keyStr;
  nsCocoaUtils::GetStringForNSString(chars, keyStr);

  // Ctrl+Tab and Ctrl+Shift+Tab are always reserved for Whimsy tab switching.
  if (ctrl && !cmd && !opt && keyCode == 48) {
    return true;
  }

  // Dynamic reserved shortcuts discovered from the window's keysets (every
  // Whimsy binding that uses Control, plus any explicit reserved bindings).
  for (const auto& s : aShortcuts) {
    if (s.mCtrl != ctrl || s.mShift != shift || s.mAlt != opt ||
        s.mMeta != cmd) {
      continue;
    }
    if (s.mKeyCode > 0 && s.mKeyCode == keyCode) {
      return true;
    }
    if (!s.mKey.IsEmpty() && s.mKey.Equals(keyStr)) {
      return true;
    }
  }

  // Browser-level Cmd shortcuts (Cmd+L, Cmd+T, Cmd+W, Cmd+K, Cmd+R, Cmd+[,
  // Cmd+], etc.), while leaving standard text-editing Cmd+C/V/X/A/Z to
  // WKWebView when it holds focus.
  if (cmd && !ctrl) {
    bool isEditKey = !opt && ([chars isEqualToString:@"c"] ||
                              [chars isEqualToString:@"v"] ||
                              [chars isEqualToString:@"x"] ||
                              [chars isEqualToString:@"a"] ||
                              [chars isEqualToString:@"z"]);
    if (!isEditKey) {
      return true;
    }
  }

  return false;
}

void EnsureKeyMonitor(FocusedEngineTabFinder aFinder) {
  if (aFinder &&
      std::find(gKeyFinders, gKeyFinders + gKeyFinderCount, aFinder) ==
          gKeyFinders + gKeyFinderCount &&
      gKeyFinderCount < kMaxKeyFinders) {
    gKeyFinders[gKeyFinderCount++] = aFinder;
  }
  if (gKeyMonitor) {
    return;
  }
  gKeyMonitor = [[NSEvent
      addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                   handler:^NSEvent*(NSEvent* aEvent) {
                                     NSWindow* evWin = [aEvent window];
                                     if (!evWin) {
                                       return aEvent;
                                     }
                                     NSView* childView = nil;
                                     const std::vector<ReservedShortcut>*
                                         shortcuts = nullptr;
                                     bool found = false;
                                     for (size_t i = 0; i < gKeyFinderCount;
                                          i++) {
                                       if (gKeyFinders[i](evWin, &childView,
                                                          &shortcuts)) {
                                         found = true;
                                         break;
                                       }
                                     }
                                     if (!found || !childView || !shortcuts) {
                                       return aEvent;
                                     }
                                     if (MatchesReservedShortcut(*shortcuts,
                                                                 aEvent)) {
                                       [childView keyDown:aEvent];
                                       return nil;
                                     }
                                     return aEvent;
                                   }] retain];
  RunOnShutdown([] {
    if (gKeyMonitor) {
      [NSEvent removeMonitor:gKeyMonitor];
      [gKeyMonitor release];
      gKeyMonitor = nil;
    }
    gKeyFinderCount = 0;
  });
}

}  // namespace whimsy
