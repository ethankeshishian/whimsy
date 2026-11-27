/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W32 engine seam: the window-level pieces an engine tab service needs, the
// same for every engine (they came out of nsWhimsyWebKit.mm). Objective-C++
// only.

#ifndef mozilla_whimsy_WhimsyEngineWindow_h
#define mozilla_whimsy_WhimsyEngineWindow_h

#import <Cocoa/Cocoa.h>

#include <cstdint>
#include <vector>

#include "nsString.h"

class mozIDOMWindowProxy;

namespace whimsy {

// The Gecko ChildView of a chrome window, or nil.
NSView* ChildViewForWindow(mozIDOMWindowProxy* aWindow);

// Reads back what the window server shows for a rect of aWindow (CSS pixels,
// relative to the window's content) as JSON {r, g, b, a, min, max}.
nsresult SampleWindowColor(mozIDOMWindowProxy* aWindow, double aX, double aY,
                           double aWidth, double aHeight, nsAString& aOut);

// One engine page shown below Gecko's view: its rounded rect in the
// ChildView, and the in-window overlays Whimsy keeps above it.
struct EngineHole {
  NSRect mRect = NSZeroRect;
  CGFloat mRadius = 0;
  std::vector<NSRect> mExclusions;
};

// Sets the holes aOwner (one per engine service) has in aChildView, then
// rebuilds the ChildView's hit-test holes and paint mask from every owner's.
// An empty list drops the owner's holes.
void SetWindowHoles(NSView* aChildView, const void* aOwner,
                    std::vector<EngineHole>&& aHoles);

// Installs the ChildView hit-test override the holes need.
void EnsureChildViewHitTestInstalled(NSView* aChildView);

struct ReservedShortcut {
  nsString mKey;
  uint16_t mKeyCode = 0;
  bool mCtrl = false;
  bool mShift = false;
  bool mAlt = false;
  bool mMeta = false;
};

// The JSON list WhimsyEngineTabs sends ([{key, keyCode, ctrl, shift, alt,
// meta}]).
std::vector<ReservedShortcut> ParseReservedShortcuts(const nsAString& aJson);

// Whether a key down belongs to Whimsy rather than the focused engine page.
bool MatchesReservedShortcut(const std::vector<ReservedShortcut>& aShortcuts,
                             NSEvent* aEvent);

// Finds the engine page holding focus in aWindow: its ChildView and reserved
// shortcuts. Returns false when that engine has none focused there.
using FocusedEngineTabFinder =
    bool (*)(NSWindow* aWindow, NSView** aChildView,
             const std::vector<ReservedShortcut>** aShortcuts);

// Starts the one key monitor (once) and adds aFinder to it. A reserved
// shortcut pressed in a focused engine page goes to Gecko's ChildView
// instead. The monitor is removed at shutdown.
void EnsureKeyMonitor(FocusedEngineTabFinder aFinder);

}  // namespace whimsy

#endif  // mozilla_whimsy_WhimsyEngineWindow_h
