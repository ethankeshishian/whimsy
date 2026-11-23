/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsWhimsyWebKit.h"

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <cmath>
#include <vector>

#include "gfxPlatform.h"
#include "js/Conversions.h"
#include "js/RootingAPI.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/RefPtr.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/dom/Promise.h"
#include "nsCOMPtr.h"
#include "nsCocoaUtils.h"
#include "nsIBaseWindow.h"
#include "nsIDocShell.h"
#include "nsIGlobalObject.h"
#include "nsIWidget.h"
#include "nsObjCExceptions.h"
#include "nsPIDOMWindow.h"
#include "nsPIDOMWindowInlines.h"
#include "nsString.h"
#include "nsTArray.h"
#include "nsXULAppAPI.h"

using namespace mozilla;
using namespace mozilla::dom;

// Dynamically load WebKit.framework so we don't need moz.build OS_LIBS changes
// across Gecko's static link config. All WK* interactions go through the Obj-C
// runtime and KVC.
static bool EnsureWebKitLoaded() {
  static bool sTried = false;
  static bool sLoaded = false;
  if (!sTried) {
    sTried = true;
    void* handle = dlopen("/System/Library/Frameworks/WebKit.framework/WebKit",
                          RTLD_LAZY | RTLD_LOCAL);
    sLoaded = handle != nullptr &&
              NSClassFromString(@"WKWebView") != nil &&
              NSClassFromString(@"WKWebViewConfiguration") != nil &&
              NSClassFromString(@"WKWebsiteDataStore") != nil;
  }
  return sLoaded;
}

// Persistent per-profile data stores require +[WKWebsiteDataStore
// dataStoreForIdentifier:], available on macOS 14+.
static bool HasPersistentDataStoreAPI() {
  if (!EnsureWebKitLoaded()) {
    return false;
  }
  Class storeClass = NSClassFromString(@"WKWebsiteDataStore");
  return storeClass != nil &&
         [storeClass respondsToSelector:@selector(dataStoreForIdentifier:)];
}

static BOOL WhimsyAcceptsFirstMouseIMP(id self, SEL _cmd, NSEvent* aEvent) {
  return YES;
}

static void EnsureViewClassAcceptsFirstMouse(Class aCls) {
  if (!aCls) {
    return;
  }
  NSString* name = NSStringFromClass(aCls);
  if (![name hasPrefix:@"WK"] && ![name hasPrefix:@"Whimsy"]) {
    return;
  }
  Method m = class_getInstanceMethod(aCls, @selector(acceptsFirstMouse:));
  if (!m || method_getImplementation(m) != (IMP)WhimsyAcceptsFirstMouseIMP) {
    if (!class_addMethod(aCls, @selector(acceptsFirstMouse:),
                         (IMP)WhimsyAcceptsFirstMouseIMP, "c@:@")) {
      method_setImplementation(m, (IMP)WhimsyAcceptsFirstMouseIMP);
    }
  }
}

static void EnsureViewHierarchyAcceptsFirstMouse(NSView* aView) {
  if (!aView) {
    return;
  }
  EnsureViewClassAcceptsFirstMouse([aView class]);
  for (NSView* sub in [aView subviews]) {
    EnsureViewHierarchyAcceptsFirstMouse(sub);
  }
}

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

static void EnsureChildViewHitTestInstalled(NSView* aChildView) {
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

// Container view that clips the WKWebView to a rounded rect matching Zen's
// browser card and accepts first-mouse clicks in an inactive window.
@interface WhimsyWebKitHost : NSView
@property(nonatomic, assign) CGFloat cornerRadius;
@end

@implementation WhimsyWebKitHost

- (instancetype)initWithFrame:(NSRect)aFrame {
  if ((self = [super initWithFrame:aFrame])) {
    self.wantsLayer = YES;
    self.layer.masksToBounds = YES;
    self.layer.cornerCurve = kCACornerCurveContinuous;
  }
  return self;
}

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)acceptsFirstMouse:(NSEvent*)aEvent {
  return YES;
}

- (void)setCornerRadius:(CGFloat)aRadius {
  _cornerRadius = aRadius;
  self.layer.cornerRadius = aRadius;
}

@end

namespace {

struct ReservedShortcut {
  nsString mKey;
  uint16_t mKeyCode = 0;
  bool mCtrl = false;
  bool mShift = false;
  bool mAlt = false;
  bool mMeta = false;
};

struct TabEntry {
  uint32_t mId = 0;
  bool mBelow = false;
  bool mVisible = true;
  NSRect mHoleInChild = NSZeroRect;
  std::vector<NSRect> mExclusionsInChild;
  std::vector<ReservedShortcut> mReservedShortcuts;
  NSView* mChildView = nil;      // weak; owned by widget
  WhimsyWebKitHost* mHost = nil; // retained
  NSView* mWebView = nil;        // retained (WKWebView*)
  id mObserver = nil;            // retained (WhimsyWebKitObserver*)
  nsCOMPtr<nsIWhimsyWebKitListener> mListener;
};

static StaticAutoPtr<nsTArray<TabEntry>> gTabs;
static uint32_t gNextId = 1;
static id gKeyMonitor = nil;

static TabEntry* FindEntry(uint32_t aId) {
  if (!gTabs) {
    return nullptr;
  }
  for (auto& entry : *gTabs) {
    if (entry.mId == aId) {
      return &entry;
    }
  }
  return nullptr;
}

static void NotifyListener(uint32_t aId, const char* aType,
                           NSString* aData = @"") {
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mListener) {
    return;
  }
  nsCOMPtr<nsIWhimsyWebKitListener> listener = entry->mListener;
  nsAutoString typeStr;
  typeStr.AssignASCII(aType);
  nsAutoString dataStr;
  if (aData) {
    nsCocoaUtils::GetStringForNSString(aData, dataStr);
  }
  listener->OnEvent(aId, typeStr, dataStr);
}

static void EmitHistoryState(uint32_t aId, NSView* aWebView) {
  if (!aWebView) {
    return;
  }
  BOOL back = [[aWebView valueForKey:@"canGoBack"] boolValue];
  BOOL forward = [[aWebView valueForKey:@"canGoForward"] boolValue];
  NSString* json = [NSString
      stringWithFormat:@"{\"canGoBack\":%@,\"canGoForward\":%@}",
                       back ? @"true" : @"false", forward ? @"true" : @"false"];
  NotifyListener(aId, "history", json);
}

}  // namespace

@interface WhimsyWebKitObserver : NSObject {
  uint32_t _tabId;
  NSView* _webView;  // unretained
  bool _observing;
}
- (instancetype)initWithTabId:(uint32_t)aTabId webView:(NSView*)aWebView;
- (void)detach;
@end

@implementation WhimsyWebKitObserver

- (instancetype)initWithTabId:(uint32_t)aTabId webView:(NSView*)aWebView {
  if ((self = [super init])) {
    _tabId = aTabId;
    _webView = aWebView;
    _observing = true;
    NSKeyValueObservingOptions opts = NSKeyValueObservingOptionNew;
    [_webView addObserver:self forKeyPath:@"title" options:opts context:nil];
    [_webView addObserver:self forKeyPath:@"URL" options:opts context:nil];
    [_webView addObserver:self forKeyPath:@"loading" options:opts context:nil];
    [_webView addObserver:self
               forKeyPath:@"canGoBack"
                  options:opts
                  context:nil];
    [_webView addObserver:self
               forKeyPath:@"canGoForward"
                  options:opts
                  context:nil];
  }
  return self;
}

- (void)detach {
  if (!_observing || !_webView) {
    return;
  }
  _observing = false;
  @try {
    [_webView removeObserver:self forKeyPath:@"title"];
    [_webView removeObserver:self forKeyPath:@"URL"];
    [_webView removeObserver:self forKeyPath:@"loading"];
    [_webView removeObserver:self forKeyPath:@"canGoBack"];
    [_webView removeObserver:self forKeyPath:@"canGoForward"];
    [_webView setValue:nil forKey:@"navigationDelegate"];
    [_webView setValue:nil forKey:@"UIDelegate"];
  } @catch (NSException* ex) {
  }
  _webView = nil;
}

- (void)dealloc {
  [self detach];
  [super dealloc];
}

- (void)observeValueForKeyPath:(NSString*)aKeyPath
                      ofObject:(id)aObject
                        change:(NSDictionary*)aChange
                       context:(void*)aContext {
  if (!_observing || !_webView) {
    return;
  }
  if ([aKeyPath isEqualToString:@"title"]) {
    NSString* title = [_webView valueForKey:@"title"];
    NotifyListener(_tabId, "title",
                   [title isKindOfClass:[NSString class]] ? title : @"");
  } else if ([aKeyPath isEqualToString:@"URL"]) {
    NSURL* url = [_webView valueForKey:@"URL"];
    NSString* spec = [url isKindOfClass:[NSURL class]] ? [url absoluteString]
                                                       : @"";
    NotifyListener(_tabId, "location", spec ?: @"");
    EmitHistoryState(_tabId, _webView);
  } else if ([aKeyPath isEqualToString:@"loading"]) {
    BOOL loading = [[_webView valueForKey:@"loading"] boolValue];
    NotifyListener(_tabId, "loading", loading ? @"true" : @"false");
    EmitHistoryState(_tabId, _webView);
  } else if ([aKeyPath isEqualToString:@"canGoBack"] ||
             [aKeyPath isEqualToString:@"canGoForward"]) {
    EmitHistoryState(_tabId, _webView);
  }
}

// WKNavigationDelegate

- (void)webView:(id)aWebView
    decidePolicyForNavigationAction:(id)aNavigationAction
                    decisionHandler:(void (^)(NSInteger))aDecisionHandler {
  if (!_observing) {
    if (aDecisionHandler) {
      aDecisionHandler(0);
    }
    return;
  }
  id targetFrame = [aNavigationAction valueForKey:@"targetFrame"];
  if (!targetFrame) {
    NSURLRequest* req = [aNavigationAction valueForKey:@"request"];
    NSURL* url = [req isKindOfClass:[NSURLRequest class]] ? [req URL] : nil;
    NSString* spec = [url absoluteString];
    if (spec.length > 0) {
      NotifyListener(_tabId, "newwindow", spec);
    }
    if (aDecisionHandler) {
      aDecisionHandler(0);  // WKNavigationActionPolicyCancel
    }
    return;
  }
  if (aDecisionHandler) {
    aDecisionHandler(1);  // WKNavigationActionPolicyAllow
  }
}

- (void)webView:(id)aWebView
    didStartProvisionalNavigation:(id)aNavigation {
  if (!_observing) {
    return;
  }
  EnsureViewHierarchyAcceptsFirstMouse(_webView);
  NotifyListener(_tabId, "loading", @"true");
}

- (void)webView:(id)aWebView didCommitNavigation:(id)aNavigation {
  if (!_observing || !_webView) {
    return;
  }
  EnsureViewHierarchyAcceptsFirstMouse(_webView);
  NSURL* url = [_webView valueForKey:@"URL"];
  if ([url isKindOfClass:[NSURL class]] && [url absoluteString].length > 0) {
    NotifyListener(_tabId, "location", [url absoluteString]);
  }
  EmitHistoryState(_tabId, _webView);
}

- (void)webView:(id)aWebView didFinishNavigation:(id)aNavigation {
  if (!_observing || !_webView) {
    return;
  }
  EnsureViewHierarchyAcceptsFirstMouse(_webView);
  NSURL* url = [_webView valueForKey:@"URL"];
  if ([url isKindOfClass:[NSURL class]] && [url absoluteString].length > 0) {
    NotifyListener(_tabId, "location", [url absoluteString]);
  }
  NSString* title = [_webView valueForKey:@"title"];
  if ([title isKindOfClass:[NSString class]]) {
    NotifyListener(_tabId, "title", title);
  }
  EmitHistoryState(_tabId, _webView);
  NotifyListener(_tabId, "loading", @"false");

  // Discover the page's favicon link if present.
  uint32_t tabId = _tabId;
  NSString* iconScript =
      @"(() => {"
       "  const el = document.querySelector("
       "    'link[rel~=\"icon\"][href], link[rel=\"shortcut icon\"][href], "
       "link[rel=\"apple-touch-icon\"][href]'"
       "  );"
       "  return el && el.href ? String(el.href) : '';"
       "})()";
  void (^handler)(id, NSError*) = ^(id aResult, NSError* aError) {
    if (!aError && [aResult isKindOfClass:[NSString class]]) {
      NotifyListener(tabId, "favicon", (NSString*)aResult);
    }
  };
  SEL evalSel = @selector(evaluateJavaScript:completionHandler:);
  if ([_webView respondsToSelector:evalSel]) {
    ((void (*)(id, SEL, NSString*, void (^)(id, NSError*)))objc_msgSend)(
        _webView, evalSel, iconScript, handler);
  }
}

- (void)webView:(id)aWebView
    didFailNavigation:(id)aNavigation
            withError:(NSError*)aError {
  if (!_observing || !_webView) {
    return;
  }
  EmitHistoryState(_tabId, _webView);
  NotifyListener(_tabId, "loading", @"false");
}

- (void)webView:(id)aWebView
    didFailProvisionalNavigation:(id)aNavigation
                       withError:(NSError*)aError {
  if (!_observing || !_webView) {
    return;
  }
  EmitHistoryState(_tabId, _webView);
  NotifyListener(_tabId, "loading", @"false");
}

// WKUIDelegate: handle window.open() and target="_blank" requests.
- (id)webView:(id)aWebView
    createWebViewWithConfiguration:(id)aConfiguration
               forNavigationAction:(id)aNavigationAction
                    windowFeatures:(id)aWindowFeatures {
  if (_observing) {
    NSURLRequest* req = [aNavigationAction valueForKey:@"request"];
    NSURL* url = [req isKindOfClass:[NSURLRequest class]] ? [req URL] : nil;
    NSString* spec = [url absoluteString];
    if (spec.length > 0) {
      NotifyListener(_tabId, "newwindow", spec);
    }
  }
  return nil;
}

@end

namespace {

static NSView* ChildViewForWindow(mozIDOMWindowProxy* aWindow) {
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

static bool IsEntryFocused(const TabEntry& aEntry) {
  if (!aEntry.mHost) {
    return false;
  }
  NSWindow* win = [aEntry.mHost window];
  if (!win) {
    return false;
  }
  NSResponder* first = [win firstResponder];
  if (![first isKindOfClass:[NSView class]]) {
    return false;
  }
  return [(NSView*)first isDescendantOf:aEntry.mHost];
}

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

// Rebuild the associated array of hit-test hole rects on a ChildView from
// all visible "below"-mode tabs attached to it, subtracting each tab's open
// in-window overlay exclusion rects.
static void UpdateHoles(NSView* aChildView) {
  if (!aChildView) {
    return;
  }
  EnsureChildViewHitTestInstalled(aChildView);
  NSMutableArray<NSValue*>* holes = [NSMutableArray array];
  if (gTabs) {
    for (const auto& entry : *gTabs) {
      if (entry.mChildView == aChildView && entry.mBelow && entry.mVisible &&
          !NSIsEmptyRect(entry.mHoleInChild)) {
        std::vector<NSRect> pieces = {entry.mHoleInChild};
        for (const NSRect& excl : entry.mExclusionsInChild) {
          pieces = SubtractRect(pieces, excl);
        }
        for (const NSRect& piece : pieces) {
          if (piece.size.width > 0.5 && piece.size.height > 0.5) {
            [holes addObject:[NSValue valueWithRect:piece]];
          }
        }
      }
    }
  }
  objc_setAssociatedObject(aChildView, @selector(whimsyNativeHoles),
                           holes.count ? holes : nil,
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

static bool MatchesReservedShortcut(const TabEntry& aEntry, NSEvent* aEvent) {
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
  for (const auto& s : aEntry.mReservedShortcuts) {
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

static void EnsureKeyMonitor() {
  if (gKeyMonitor) {
    return;
  }
  gKeyMonitor = [[NSEvent
      addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                   handler:^NSEvent*(NSEvent* aEvent) {
                                     if (!gTabs) {
                                       return aEvent;
                                     }
                                     NSWindow* evWin = [aEvent window];
                                     if (!evWin) {
                                       return aEvent;
                                     }
                                     TabEntry* target = nullptr;
                                     for (auto& entry : *gTabs) {
                                       if (entry.mVisible && entry.mChildView &&
                                           [entry.mChildView window] == evWin &&
                                           IsEntryFocused(entry)) {
                                         target = &entry;
                                         break;
                                       }
                                     }
                                     if (!target) {
                                       return aEvent;
                                     }
                                     if (MatchesReservedShortcut(*target,
                                                                 aEvent)) {
                                       [target->mChildView keyDown:aEvent];
                                       return nil;
                                     }
                                     return aEvent;
                                   }] retain];
}

static void DestroyEntry(TabEntry& aEntry) {
  NSView* child = aEntry.mChildView;
  if (IsEntryFocused(aEntry) && child) {
    [[child window] makeFirstResponder:child];
  }
  if (aEntry.mObserver) {
    [(WhimsyWebKitObserver*)aEntry.mObserver detach];
    [aEntry.mObserver release];
    aEntry.mObserver = nil;
  }
  if (aEntry.mWebView) {
    [aEntry.mWebView removeFromSuperview];
    [aEntry.mWebView release];
    aEntry.mWebView = nil;
  }
  if (aEntry.mHost) {
    [aEntry.mHost removeFromSuperview];
    [aEntry.mHost release];
    aEntry.mHost = nil;
  }
  aEntry.mListener = nullptr;
  aEntry.mChildView = nil;
  aEntry.mHoleInChild = NSZeroRect;
  aEntry.mExclusionsInChild.clear();
  aEntry.mReservedShortcuts.clear();
  if (child) {
    UpdateHoles(child);
  }
}

// W30 cookie copy: the WKHTTPCookieStore of one persistent per-profile data
// store. Only a UUID names one; the ephemeral store (and so anything private)
// is never read or written.
static id CookieStoreForDataStoreId(const nsAString& aDataStoreId) {
  if (!EnsureWebKitLoaded() || !HasPersistentDataStoreAPI()) {
    return nil;
  }
  NSString* uuidStr = nsCocoaUtils::ToNSString(aDataStoreId);
  NSUUID* uuid = [[[NSUUID alloc] initWithUUIDString:uuidStr] autorelease];
  if (!uuid) {
    return nil;
  }
  Class storeClass = NSClassFromString(@"WKWebsiteDataStore");
  id store = ((id (*)(id, SEL, NSUUID*))objc_msgSend)(
      storeClass, @selector(dataStoreForIdentifier:), uuid);
  if (!store || ![store respondsToSelector:@selector(httpCookieStore)]) {
    return nil;
  }
  return [store performSelector:@selector(httpCookieStore)];
}

// A cookie belongs to the site when its domain (leading dot dropped) is the
// site's registrable domain or a subdomain of it.
static bool CookieDomainInSite(NSString* aDomain, NSString* aBaseDomain) {
  if (!aDomain.length || !aBaseDomain.length) {
    return false;
  }
  NSString* domain = [aDomain lowercaseString];
  if ([domain hasPrefix:@"."]) {
    domain = [domain substringFromIndex:1];
  }
  NSString* base = [aBaseDomain lowercaseString];
  return [domain isEqualToString:base] ||
         [domain hasSuffix:[@"." stringByAppendingString:base]];
}

// CHIPS cookies carry a storage partition; they belong to an embedding site,
// so they never travel.
static bool IsPartitionedCookie(NSHTTPCookie* aCookie) {
  SEL sel = NSSelectorFromString(@"_storagePartition");
  if (![aCookie respondsToSelector:sel]) {
    return false;
  }
  id partition = [aCookie performSelector:sel];
  return [partition isKindOfClass:[NSString class]] &&
         [(NSString*)partition length] > 0;
}

static NSDictionary* CookieToDict(NSHTTPCookie* aCookie) {
  NSDate* expires = aCookie.sessionOnly ? nil : aCookie.expiresDate;
  NSString* sameSite = @"";
  if (@available(macOS 10.15, *)) {
    NSString* policy = aCookie.sameSitePolicy;
    if ([policy isEqualToString:NSHTTPCookieSameSiteLax]) {
      sameSite = @"lax";
    } else if ([policy isEqualToString:NSHTTPCookieSameSiteStrict]) {
      sameSite = @"strict";
    }
  }
  return @{
    @"name" : aCookie.name ?: @"",
    @"value" : aCookie.value ?: @"",
    @"domain" : aCookie.domain ?: @"",
    @"path" : aCookie.path.length ? aCookie.path : @"/",
    @"expires" : @(expires ? llround([expires timeIntervalSince1970] * 1000.0)
                           : 0),
    @"secure" : @(aCookie.secure),
    @"httpOnly" : @(aCookie.HTTPOnly),
    @"sameSite" : sameSite,
  };
}

static NSHTTPCookie* CookieFromDict(NSDictionary* aDict) {
  NSString* name = aDict[@"name"];
  NSString* value = aDict[@"value"];
  NSString* domain = aDict[@"domain"];
  NSString* path = aDict[@"path"];
  if (![name isKindOfClass:[NSString class]] || !name.length ||
      ![value isKindOfClass:[NSString class]] ||
      ![domain isKindOfClass:[NSString class]] || !domain.length) {
    return nil;
  }
  NSMutableDictionary* props = [NSMutableDictionary dictionary];
  props[NSHTTPCookieName] = name;
  props[NSHTTPCookieValue] = value;
  // A leading dot makes a domain cookie; without one NSHTTPCookie is
  // host-only, matching Gecko's host/isDomain split.
  props[NSHTTPCookieDomain] = domain;
  props[NSHTTPCookiePath] =
      [path isKindOfClass:[NSString class]] && path.length ? path : @"/";
  NSNumber* expires = aDict[@"expires"];
  if ([expires isKindOfClass:[NSNumber class]] && expires.doubleValue > 0) {
    props[NSHTTPCookieExpires] =
        [NSDate dateWithTimeIntervalSince1970:expires.doubleValue / 1000.0];
  } else {
    props[NSHTTPCookieDiscard] = @"TRUE";
  }
  if ([aDict[@"secure"] boolValue]) {
    props[NSHTTPCookieSecure] = @"TRUE";
  }
  if ([aDict[@"httpOnly"] boolValue]) {
    // Foundation has no public constant for this key; "HttpOnly" is the one
    // NSHTTPCookie reads.
    props[@"HttpOnly"] = @"TRUE";
  }
  if (@available(macOS 10.15, *)) {
    NSString* sameSite = aDict[@"sameSite"];
    if ([sameSite isEqual:@"lax"]) {
      props[NSHTTPCookieSameSitePolicy] = NSHTTPCookieSameSiteLax;
    } else if ([sameSite isEqual:@"strict"]) {
      props[NSHTTPCookieSameSitePolicy] = NSHTTPCookieSameSiteStrict;
    }
  }
  return [NSHTTPCookie cookieWithProperties:props];
}

}  // namespace

namespace whimsy {

NS_IMPL_ISUPPORTS(nsWhimsyWebKit, nsIWhimsyWebKit)

nsWhimsyWebKit::~nsWhimsyWebKit() {
  if (gTabs) {
    for (auto& entry : *gTabs) {
      DestroyEntry(entry);
    }
  }
}

NS_IMETHODIMP
nsWhimsyWebKit::Available(mozIDOMWindowProxy* aWindow, bool* aOut) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  NS_ENSURE_ARG_POINTER(aOut);
  *aOut = false;
  if (!XRE_IsParentProcess() || gfxPlatform::IsHeadless()) {
    return NS_OK;
  }
  if (!EnsureWebKitLoaded() || !HasPersistentDataStoreAPI()) {
    return NS_OK;
  }
  if (aWindow && ChildViewForWindow(aWindow) == nil) {
    return NS_OK;
  }
  *aOut = true;
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::CreateTab(mozIDOMWindowProxy* aWindow,
                          const nsAString& aDataStoreId,
                          const nsAString& aLayerMode,
                          nsIWhimsyWebKitListener* aListener,
                          uint32_t* aOutId) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  NS_ENSURE_ARG_POINTER(aOutId);
  *aOutId = 0;

  if (!XRE_IsParentProcess() || gfxPlatform::IsHeadless() ||
      !EnsureWebKitLoaded() || !HasPersistentDataStoreAPI()) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NSView* childView = ChildViewForWindow(aWindow);
  if (!childView) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  if (!gTabs) {
    gTabs = new nsTArray<TabEntry>();
    RunOnShutdown([] {
      if (gKeyMonitor) {
        [NSEvent removeMonitor:gKeyMonitor];
        [gKeyMonitor release];
        gKeyMonitor = nil;
      }
      if (gTabs) {
        for (auto& entry : *gTabs) {
          DestroyEntry(entry);
        }
        gTabs = nullptr;
      }
    });
  }
  EnsureKeyMonitor();

  bool below = aLayerMode.EqualsLiteral("below");
  NSRect initial = NSMakeRect(0, 0, 10, 10);
  WhimsyWebKitHost* host =
      [[WhimsyWebKitHost alloc] initWithFrame:initial];
  host.autoresizingMask = NSViewNotSizable;

  Class configClass = NSClassFromString(@"WKWebViewConfiguration");
  Class storeClass = NSClassFromString(@"WKWebsiteDataStore");
  Class webViewClass = NSClassFromString(@"WKWebView");
  if (!configClass || !storeClass || !webViewClass) {
    [host release];
    return NS_ERROR_NOT_AVAILABLE;
  }

  EnsureViewClassAcceptsFirstMouse(webViewClass);

  id config = [[configClass alloc] init];
  if (!aDataStoreId.IsEmpty()) {
    NSString* uuidStr = nsCocoaUtils::ToNSString(aDataStoreId);
    NSUUID* uuid = [[[NSUUID alloc] initWithUUIDString:uuidStr] autorelease];
    if (uuid &&
        [storeClass respondsToSelector:@selector(dataStoreForIdentifier:)]) {
      id store = ((id (*)(id, SEL, NSUUID*))objc_msgSend)(
          storeClass, @selector(dataStoreForIdentifier:), uuid);
      if (store) {
        [config setValue:store forKey:@"websiteDataStore"];
      }
    } else if (aDataStoreId.EqualsLiteral("ephemeral")) {
      id store = [storeClass performSelector:@selector(nonPersistentDataStore)];
      if (store) {
        [config setValue:store forKey:@"websiteDataStore"];
      }
    }
  }

  // Safari-style Version/x Safari/y user-agent suffix so sites recognize
  // WebKit as Safari rather than an embedded web view.
  @try {
    [config setValue:@"Version/17.6 Safari/605.1.15"
              forKey:@"applicationNameForUserAgent"];
    id prefs = [config valueForKey:@"preferences"];
    if (prefs) {
      [prefs setValue:@YES forKey:@"javaScriptCanOpenWindowsAutomatically"];
    }
  } @catch (NSException* ex) {
  }

  SEL initSel = @selector(initWithFrame:configuration:);
  id rawWebView = [webViewClass alloc];
  NSView* webView = ((NSView * (*)(id, SEL, NSRect, id)) objc_msgSend)(
      rawWebView, initSel, host.bounds, config);
  [config release];
  if (!webView) {
    [host release];
    return NS_ERROR_FAILURE;
  }
  webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  EnsureViewHierarchyAcceptsFirstMouse(webView);
  [host addSubview:webView];

  if (below) {
    EnsureChildViewHitTestInstalled(childView);
    NSView* parent = [childView superview] ?: childView;
    if (parent != childView) {
      [parent addSubview:host
              positioned:NSWindowBelow
              relativeTo:childView];
    } else {
      [childView addSubview:host];
    }
  } else {
    [childView addSubview:host];
  }

  uint32_t id = gNextId++;
  WhimsyWebKitObserver* observer =
      [[WhimsyWebKitObserver alloc] initWithTabId:id webView:webView];
  @try {
    [webView setValue:observer forKey:@"navigationDelegate"];
    [webView setValue:observer forKey:@"UIDelegate"];
  } @catch (NSException* ex) {
  }

  TabEntry entry;
  entry.mId = id;
  entry.mBelow = below;
  entry.mVisible = true;
  entry.mChildView = childView;
  entry.mHost = host;
  entry.mWebView = webView;
  entry.mObserver = observer;
  entry.mListener = aListener;
  gTabs->AppendElement(std::move(entry));

  *aOutId = id;
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::SetFrame(uint32_t aId, double aX, double aY, double aWidth,
                         double aHeight, double aRadius,
                         const nsAString& aExclusionsJson) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mHost || !entry->mChildView) {
    return NS_ERROR_INVALID_ARG;
  }
  CGFloat w = std::max(0.0, aWidth);
  CGFloat h = std::max(0.0, aHeight);
  NSRect rectInChild = NSMakeRect(aX, aY, w, h);
  entry->mHoleInChild = rectInChild;

  entry->mExclusionsInChild.clear();
  if (!aExclusionsJson.IsEmpty()) {
    NSString* jsonStr = nsCocoaUtils::ToNSString(aExclusionsJson);
    NSData* data = [jsonStr dataUsingEncoding:NSUTF8StringEncoding];
    if (data) {
      id parsed = [NSJSONSerialization JSONObjectWithData:data
                                                  options:0
                                                    error:nil];
      if ([parsed isKindOfClass:[NSArray class]]) {
        for (id item in (NSArray*)parsed) {
          if ([item isKindOfClass:[NSArray class]] &&
              [(NSArray*)item count] >= 4) {
            NSArray* arr = (NSArray*)item;
            double ex = [arr[0] doubleValue];
            double ey = [arr[1] doubleValue];
            double ew = [arr[2] doubleValue];
            double eh = [arr[3] doubleValue];
            if (ew > 0.5 && eh > 0.5) {
              entry->mExclusionsInChild.push_back(NSMakeRect(ex, ey, ew, eh));
            }
          }
        }
      }
    }
  }

  NSView* hostParent = [entry->mHost superview];
  NSRect frameInParent = rectInChild;
  if (hostParent && hostParent != entry->mChildView) {
    frameInParent = [entry->mChildView convertRect:rectInChild
                                            toView:hostParent];
  }
  [entry->mHost setFrame:frameInParent];
  [entry->mHost setCornerRadius:std::max(0.0, aRadius)];
  if (entry->mBelow) {
    UpdateHoles(entry->mChildView);
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::SetVisible(uint32_t aId, bool aVisible) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mHost) {
    return NS_ERROR_INVALID_ARG;
  }
  if (!aVisible && IsEntryFocused(*entry) && entry->mChildView) {
    [[entry->mChildView window] makeFirstResponder:entry->mChildView];
  }
  entry->mVisible = aVisible;
  [entry->mHost setHidden:!aVisible];
  if (entry->mBelow) {
    UpdateHoles(entry->mChildView);
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::LoadURL(uint32_t aId, const nsAString& aURL) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mWebView) {
    return NS_ERROR_INVALID_ARG;
  }
  NSString* spec = nsCocoaUtils::ToNSString(aURL);
  NSURL* url = [NSURL URLWithString:spec];
  if (!url) {
    return NS_ERROR_MALFORMED_URI;
  }
  NSURLRequest* req = [NSURLRequest requestWithURL:url];
  SEL sel = @selector(loadRequest:);
  if ([entry->mWebView respondsToSelector:sel]) {
    ((id (*)(id, SEL, id))objc_msgSend)(entry->mWebView, sel, req);
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::LoadHTML(uint32_t aId, const nsAString& aHTML,
                         const nsAString& aBaseURL) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mWebView) {
    return NS_ERROR_INVALID_ARG;
  }
  NSString* html = nsCocoaUtils::ToNSString(aHTML);
  NSURL* base =
      aBaseURL.IsEmpty()
          ? nil
          : [NSURL URLWithString:nsCocoaUtils::ToNSString(aBaseURL)];
  SEL sel = @selector(loadHTMLString:baseURL:);
  if ([entry->mWebView respondsToSelector:sel]) {
    ((id (*)(id, SEL, id, id))objc_msgSend)(entry->mWebView, sel, html, base);
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::GoBack(uint32_t aId) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mWebView) {
    return NS_ERROR_INVALID_ARG;
  }
  SEL sel = @selector(goBack);
  if ([entry->mWebView respondsToSelector:sel]) {
    ((id (*)(id, SEL))objc_msgSend)(entry->mWebView, sel);
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::GoForward(uint32_t aId) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mWebView) {
    return NS_ERROR_INVALID_ARG;
  }
  SEL sel = @selector(goForward);
  if ([entry->mWebView respondsToSelector:sel]) {
    ((id (*)(id, SEL))objc_msgSend)(entry->mWebView, sel);
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::Reload(uint32_t aId) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mWebView) {
    return NS_ERROR_INVALID_ARG;
  }
  SEL sel = @selector(reload);
  if ([entry->mWebView respondsToSelector:sel]) {
    ((id (*)(id, SEL))objc_msgSend)(entry->mWebView, sel);
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::Stop(uint32_t aId) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mWebView) {
    return NS_ERROR_INVALID_ARG;
  }
  SEL sel = @selector(stopLoading);
  if ([entry->mWebView respondsToSelector:sel]) {
    ((void (*)(id, SEL))objc_msgSend)(entry->mWebView, sel);
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::CanGoBack(uint32_t aId, bool* aOut) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  NS_ENSURE_ARG_POINTER(aOut);
  *aOut = false;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mWebView) {
    return NS_ERROR_INVALID_ARG;
  }
  *aOut = [[entry->mWebView valueForKey:@"canGoBack"] boolValue];
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::CanGoForward(uint32_t aId, bool* aOut) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  NS_ENSURE_ARG_POINTER(aOut);
  *aOut = false;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mWebView) {
    return NS_ERROR_INVALID_ARG;
  }
  *aOut = [[entry->mWebView valueForKey:@"canGoForward"] boolValue];
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::IsLoading(uint32_t aId, bool* aOut) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  NS_ENSURE_ARG_POINTER(aOut);
  *aOut = false;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mWebView) {
    return NS_ERROR_INVALID_ARG;
  }
  *aOut = [[entry->mWebView valueForKey:@"loading"] boolValue];
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::Focus(uint32_t aId) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mWebView) {
    return NS_ERROR_INVALID_ARG;
  }
  EnsureViewHierarchyAcceptsFirstMouse(entry->mWebView);
  NSWindow* win = [entry->mWebView window];
  if (win) {
    [win makeFirstResponder:entry->mWebView];
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::Blur(uint32_t aId) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mChildView) {
    return NS_ERROR_INVALID_ARG;
  }
  NSWindow* win = [entry->mChildView window];
  if (win && IsEntryFocused(*entry)) {
    [win makeFirstResponder:entry->mChildView];
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::IsFocused(uint32_t aId, bool* aOut) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  NS_ENSURE_ARG_POINTER(aOut);
  *aOut = false;
  TabEntry* entry = FindEntry(aId);
  if (!entry) {
    return NS_ERROR_INVALID_ARG;
  }
  *aOut = IsEntryFocused(*entry);
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::SetReservedShortcuts(uint32_t aId,
                                     const nsAString& aShortcutsJson) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  TabEntry* entry = FindEntry(aId);
  if (!entry) {
    return NS_ERROR_INVALID_ARG;
  }
  entry->mReservedShortcuts.clear();
  if (aShortcutsJson.IsEmpty()) {
    return NS_OK;
  }
  NSString* jsonStr = nsCocoaUtils::ToNSString(aShortcutsJson);
  NSData* data = [jsonStr dataUsingEncoding:NSUTF8StringEncoding];
  if (!data) {
    return NS_OK;
  }
  id parsed = [NSJSONSerialization JSONObjectWithData:data
                                              options:0
                                                error:nil];
  if (![parsed isKindOfClass:[NSArray class]]) {
    return NS_OK;
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
    entry->mReservedShortcuts.push_back(std::move(shortcut));
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::Evaluate(uint32_t aId, const nsAString& aScript, JSContext* aCx,
                         Promise** aOutPromise) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  NS_ENSURE_ARG_POINTER(aOutPromise);
  *aOutPromise = nullptr;

  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mWebView) {
    return NS_ERROR_INVALID_ARG;
  }

  nsIGlobalObject* global = xpc::CurrentNativeGlobal(aCx);
  if (!global) {
    return NS_ERROR_UNEXPECTED;
  }
  ErrorResult rv;
  RefPtr<Promise> promise = Promise::Create(global, rv);
  if (rv.Failed()) {
    return rv.StealNSResult();
  }

  NSString* script = nsCocoaUtils::ToNSString(aScript);
  RefPtr<Promise> held = promise;
  void (^handler)(id, NSError*) = ^(id aResult, NSError* aError) {
    if (aError) {
      nsAutoString msg;
      nsCocoaUtils::GetStringForNSString([aError localizedDescription], msg);
      held->MaybeRejectWithOperationError(NS_ConvertUTF16toUTF8(msg));
      return;
    }
    nsAutoString out;
    if (aResult && aResult != [NSNull null]) {
      NSString* desc = [aResult isKindOfClass:[NSString class]]
                           ? (NSString*)aResult
                           : [aResult description];
      nsCocoaUtils::GetStringForNSString(desc, out);
    }
    held->MaybeResolve(out);
  };

  SEL sel = @selector(evaluateJavaScript:completionHandler:);
  if ([entry->mWebView respondsToSelector:sel]) {
    ((void (*)(id, SEL, NSString*, void (^)(id, NSError*)))objc_msgSend)(
        entry->mWebView, sel, script, handler);
  } else {
    promise->MaybeRejectWithNotSupportedError("evaluateJavaScript unavailable");
  }

  promise.forget(aOutPromise);
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::GetCookies(const nsAString& aDataStoreId,
                           const nsAString& aBaseDomain, JSContext* aCx,
                           Promise** aOutPromise) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  NS_ENSURE_ARG_POINTER(aOutPromise);
  *aOutPromise = nullptr;
  if (!XRE_IsParentProcess() || aBaseDomain.IsEmpty()) {
    return NS_ERROR_INVALID_ARG;
  }
  id cookieStore = CookieStoreForDataStoreId(aDataStoreId);
  SEL sel = @selector(getAllCookies:);
  if (!cookieStore || ![cookieStore respondsToSelector:sel]) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  nsIGlobalObject* global = xpc::CurrentNativeGlobal(aCx);
  if (!global) {
    return NS_ERROR_UNEXPECTED;
  }
  ErrorResult rv;
  RefPtr<Promise> promise = Promise::Create(global, rv);
  if (rv.Failed()) {
    return rv.StealNSResult();
  }

  RefPtr<Promise> held = promise;
  NSString* base = [nsCocoaUtils::ToNSString(aBaseDomain) retain];
  void (^handler)(NSArray*) = ^(NSArray* aCookies) {
    NSMutableArray* out = [NSMutableArray array];
    for (id cookie in aCookies) {
      if (![cookie isKindOfClass:[NSHTTPCookie class]]) {
        continue;
      }
      NSHTTPCookie* httpCookie = (NSHTTPCookie*)cookie;
      if (!CookieDomainInSite(httpCookie.domain, base) ||
          IsPartitionedCookie(httpCookie)) {
        continue;
      }
      [out addObject:CookieToDict(httpCookie)];
    }
    [base release];
    NSData* data = [NSJSONSerialization dataWithJSONObject:out
                                                   options:0
                                                     error:nil];
    nsAutoString json;
    if (data) {
      NSString* str = [[[NSString alloc] initWithData:data
                                             encoding:NSUTF8StringEncoding]
          autorelease];
      nsCocoaUtils::GetStringForNSString(str, json);
    }
    if (json.IsEmpty()) {
      json.AssignLiteral("[]");
    }
    held->MaybeResolve(json);
  };
  ((void (*)(id, SEL, void (^)(NSArray*)))objc_msgSend)(cookieStore, sel,
                                                        handler);

  promise.forget(aOutPromise);
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::SetCookies(const nsAString& aDataStoreId,
                           const nsAString& aBaseDomain,
                           const nsAString& aCookiesJson, JSContext* aCx,
                           Promise** aOutPromise) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  NS_ENSURE_ARG_POINTER(aOutPromise);
  *aOutPromise = nullptr;
  if (!XRE_IsParentProcess() || aBaseDomain.IsEmpty()) {
    return NS_ERROR_INVALID_ARG;
  }
  id cookieStore = CookieStoreForDataStoreId(aDataStoreId);
  SEL sel = @selector(setCookie:completionHandler:);
  if (!cookieStore || ![cookieStore respondsToSelector:sel]) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  NSData* data = [nsCocoaUtils::ToNSString(aCookiesJson)
      dataUsingEncoding:NSUTF8StringEncoding];
  id parsed = data ? [NSJSONSerialization JSONObjectWithData:data
                                                     options:0
                                                       error:nil]
                   : nil;
  if (![parsed isKindOfClass:[NSArray class]]) {
    return NS_ERROR_INVALID_ARG;
  }
  // The store only ever receives this site's cookies, whatever JS passes.
  NSString* base = nsCocoaUtils::ToNSString(aBaseDomain);
  NSMutableArray* cookies = [NSMutableArray array];
  for (id item in (NSArray*)parsed) {
    if (![item isKindOfClass:[NSDictionary class]]) {
      continue;
    }
    NSHTTPCookie* cookie = CookieFromDict(item);
    if (cookie && CookieDomainInSite(cookie.domain, base)) {
      [cookies addObject:cookie];
    }
  }

  nsIGlobalObject* global = xpc::CurrentNativeGlobal(aCx);
  if (!global) {
    return NS_ERROR_UNEXPECTED;
  }
  ErrorResult rv;
  RefPtr<Promise> promise = Promise::Create(global, rv);
  if (rv.Failed()) {
    return rv.StealNSResult();
  }
  if (!cookies.count) {
    promise->MaybeResolve(0);
    promise.forget(aOutPromise);
    return NS_OK;
  }

  // WKHTTPCookieStore calls each completion handler on the main thread, so
  // the shared counter needs no lock; the promise settles after the last.
  RefPtr<Promise> held = promise;
  uint32_t total = static_cast<uint32_t>(cookies.count);
  __block uint32_t remaining = total;
  for (NSHTTPCookie* cookie in cookies) {
    void (^done)(void) = ^{
      if (--remaining == 0) {
        held->MaybeResolve(total);
      }
    };
    ((void (*)(id, SEL, NSHTTPCookie*, void (^)(void)))objc_msgSend)(
        cookieStore, sel, cookie, done);
  }

  promise.forget(aOutPromise);
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::HitTestAt(uint32_t aId, double aX, double aY,
                          nsAString& aOut) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  aOut.Truncate();
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mChildView || !entry->mHost) {
    return NS_ERROR_INVALID_ARG;
  }
  EnsureViewHierarchyAcceptsFirstMouse(entry->mWebView);
  NSWindow* win = [entry->mChildView window];
  NSView* contentView = [win contentView];
  NSView* root = [contentView superview];
  if (!win || !contentView || !root) {
    return NS_ERROR_FAILURE;
  }
  NSPoint inChild = NSMakePoint(aX, aY);
  NSPoint inRoot = [entry->mChildView convertPoint:inChild toView:root];
  NSView* hit = [root hitTest:inRoot];
  if (!hit) {
    aOut.AssignLiteral("none");
  } else if (hit == entry->mWebView || [hit isDescendantOf:entry->mHost]) {
    aOut.AssignLiteral("webkit");
  } else if (hit == entry->mChildView ||
             [hit isDescendantOf:entry->mChildView]) {
    aOut.AssignLiteral("gecko");
  } else {
    aOut.AssignLiteral("other");
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::AcceptsFirstMouseAt(uint32_t aId, double aX, double aY,
                                    bool* aOut) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  NS_ENSURE_ARG_POINTER(aOut);
  *aOut = false;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mChildView || !entry->mHost) {
    return NS_ERROR_INVALID_ARG;
  }
  EnsureViewHierarchyAcceptsFirstMouse(entry->mWebView);
  NSWindow* win = [entry->mChildView window];
  NSView* contentView = [win contentView];
  NSView* root = [contentView superview];
  if (!win || !contentView || !root) {
    return NS_ERROR_FAILURE;
  }
  NSPoint inChild = NSMakePoint(aX, aY);
  NSPoint inRoot = [entry->mChildView convertPoint:inChild toView:root];
  NSView* hit = [root hitTest:inRoot];
  if (hit && (hit == entry->mWebView || [hit isDescendantOf:entry->mHost])) {
    *aOut = [hit acceptsFirstMouse:nil];
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::DestroyTab(uint32_t aId) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  if (!gTabs) {
    return NS_OK;
  }
  for (size_t i = 0; i < gTabs->Length(); ++i) {
    if ((*gTabs)[i].mId == aId) {
      DestroyEntry((*gTabs)[i]);
      gTabs->RemoveElementAt(i);
      break;
    }
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

}  // namespace whimsy
