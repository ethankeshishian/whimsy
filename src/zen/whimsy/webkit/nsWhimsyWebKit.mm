/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsWhimsyWebKit.h"

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <Security/Security.h>
#include <dlfcn.h>
#include <signal.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <algorithm>
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
  CGFloat mHoleRadius = 0;
  std::vector<NSRect> mExclusionsInChild;
  std::vector<ReservedShortcut> mReservedShortcuts;
  NSView* mChildView = nil;      // weak; owned by widget
  WhimsyWebKitHost* mHost = nil; // retained
  NSView* mWebView = nil;        // retained (WKWebView*)
  id mObserver = nil;            // retained (WhimsyWebKitObserver*)
  id mScriptHandler = nil;       // retained (WhimsyWebKitScriptHandler*)
  id mUserContent = nil;         // retained (WKUserContentController*)
  NSString* mEpoch = nil;        // retained; the main-frame document's epoch
  double mScrollX = 0;
  double mScrollY = 0;
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

static NSString* ToJSON(id aObject) {
  if (!aObject || ![NSJSONSerialization isValidJSONObject:aObject]) {
    return @"{}";
  }
  NSData* data = [NSJSONSerialization dataWithJSONObject:aObject
                                                 options:0
                                                   error:nil];
  if (!data) {
    return @"{}";
  }
  return [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]
      autorelease];
}

static NSDictionary* DictFromJSON(const nsAString& aJson) {
  NSData* data = [nsCocoaUtils::ToNSString(aJson)
      dataUsingEncoding:NSUTF8StringEncoding];
  id parsed = data ? [NSJSONSerialization JSONObjectWithData:data
                                                     options:0
                                                       error:nil]
                   : nil;
  return [parsed isKindOfClass:[NSDictionary class]] ? (NSDictionary*)parsed
                                                      : nil;
}

static NSString* OriginString(id aSecurityOrigin) {
  if (!aSecurityOrigin) {
    return @"";
  }
  @try {
    NSString* protocol = [aSecurityOrigin valueForKey:@"protocol"];
    NSString* host = [aSecurityOrigin valueForKey:@"host"];
    NSInteger port = [[aSecurityOrigin valueForKey:@"port"] integerValue];
    if (!protocol.length || !host.length) {
      return @"";
    }
    if ([host containsString:@":"]) {
      host = [NSString stringWithFormat:@"[%@]", host];
    }
    if (port > 0) {
      return [NSString stringWithFormat:@"%@://%@:%ld", protocol, host,
                                        (long)port];
    }
    return [NSString stringWithFormat:@"%@://%@", protocol, host];
  } @catch (NSException* ex) {
    return @"";
  }
}

static NSString* FrameOrigin(id aFrameInfo) {
  @try {
    return OriginString([aFrameInfo valueForKey:@"securityOrigin"]);
  } @catch (NSException* ex) {
    return @"";
  }
}

static bool IsMainFrame(id aFrameInfo) {
  @try {
    return aFrameInfo && [[aFrameInfo valueForKey:@"mainFrame"] boolValue];
  } @catch (NSException* ex) {
    return false;
  }
}

// W32: WebKit delegate requests wait here for Gecko's answer (a prompt, the
// file picker, the password manager, a permission doorhanger). Each one is
// answered exactly once: by respond(), or with nil (WebKit's safe default)
// when its tab goes away.
typedef void (^WhimsyResponder)(NSDictionary* aResponse);
static NSMutableDictionary* gPending = nil;  // @(req) -> @[@(tabId), block]
static uint32_t gNextRequestId = 1;

static void AnswerPending(uint32_t aRequestId, uint32_t aTabId,
                          NSDictionary* aResponse) {
  NSArray* record = gPending[@(aRequestId)];
  if (!record || [record[0] unsignedIntValue] != aTabId) {
    return;
  }
  [[record retain] autorelease];
  [gPending removeObjectForKey:@(aRequestId)];
  WhimsyResponder responder = record[1];
  responder(aResponse);
}

static void AskListener(uint32_t aTabId, const char* aType,
                        NSDictionary* aPayload, WhimsyResponder aResponder) {
  TabEntry* entry = FindEntry(aTabId);
  if (!entry || !entry->mListener) {
    aResponder(nil);
    return;
  }
  if (!gPending) {
    gPending = [[NSMutableDictionary alloc] init];
  }
  uint32_t req = gNextRequestId++;
  WhimsyResponder copied = [[aResponder copy] autorelease];
  gPending[@(req)] = @[ @(aTabId), copied ];
  NSMutableDictionary* payload = [[aPayload mutableCopy] autorelease];
  payload[@"req"] = @(req);
  NotifyListener(aTabId, aType, ToJSON(payload));
}

static void CancelPendingForTab(uint32_t aTabId) {
  if (!gPending) {
    return;
  }
  NSMutableArray* keys = [NSMutableArray array];
  for (NSNumber* key in gPending) {
    if ([gPending[key][0] unsignedIntValue] == aTabId) {
      [keys addObject:key];
    }
  }
  for (NSNumber* key in keys) {
    AnswerPending([key unsignedIntValue], aTabId, nil);
  }
}

static NSString* EntryEpoch(uint32_t aId) {
  TabEntry* entry = FindEntry(aId);
  return entry ? entry->mEpoch : nil;
}

// W32 epoch guard: runs in Whimsy's isolated world at document start of the
// main frame. Each document gets a random epoch; a bfcache restore posts the
// restored document's epoch again. The page's own scripts can't see this
// world or its message handler.
static NSString* const kEpochScript =
    @"(() => {"
     "  const a = new Uint32Array(4);"
     "  crypto.getRandomValues(a);"
     "  const e = Array.from(a, n => n.toString(16).padStart(8, '0')).join('');"
     "  Object.defineProperty(globalThis, '__whimsyEpoch', { value: e });"
     "  const post = t => {"
     "    try {"
     "      webkit.messageHandlers.whimsy.postMessage({"
     "        e, t, x: window.scrollX, y: window.scrollY,"
     "      });"
     "    } catch (_) {}"
     "  };"
     "  post('epoch');"
     "  addEventListener('pageshow', ev => { if (ev.persisted) post('epoch'); });"
     "  let timer = 0;"
     "  addEventListener('scroll', () => {"
     "    clearTimeout(timer);"
     "    timer = setTimeout(() => post('scroll'), 120);"
     "  }, { passive: true, capture: true });"
     "  addEventListener('pagehide', () => post('scroll'));"
     "})();";

static id WhimsyContentWorld() {
  Class worldClass = NSClassFromString(@"WKContentWorld");
  if (![worldClass respondsToSelector:@selector(worldWithName:)]) {
    return nil;
  }
  return [worldClass performSelector:@selector(worldWithName:)
                          withObject:@"whimsy"];
}

static NSString* ResultToString(id aResult) {
  if (!aResult || aResult == [NSNull null]) {
    return @"";
  }
  if ([aResult isKindOfClass:[NSString class]]) {
    return (NSString*)aResult;
  }
  if ([aResult isKindOfClass:[NSArray class]] ||
      [aResult isKindOfClass:[NSDictionary class]]) {
    return ToJSON(aResult);
  }
  return [aResult description] ?: @"";
}

// Runs aBody (a function body) in Whimsy's isolated world only while the
// main frame still shows the document with aEpoch (nil: the current one).
// aDone gets the result, or a failure ("stale" when the document changed).
typedef void (^WhimsyGuardedDone)(id aResult, NSString* aFailure);
static void RunGuarded(uint32_t aTabId, NSString* aEpoch, NSString* aBody,
                       WhimsyGuardedDone aDone) {
  TabEntry* entry = FindEntry(aTabId);
  if (!entry || !entry->mWebView) {
    aDone(nil, @"gone");
    return;
  }
  NSString* current = entry->mEpoch;
  NSString* epoch = aEpoch.length ? aEpoch : current;
  if (!epoch.length || (current && ![epoch isEqualToString:current])) {
    aDone(nil, @"stale");
    return;
  }
  id world = WhimsyContentWorld();
  SEL sel = NSSelectorFromString(
      @"callAsyncJavaScript:arguments:inFrame:inContentWorld:"
       "completionHandler:");
  if (!world || ![entry->mWebView respondsToSelector:sel]) {
    aDone(nil, @"unsupported");
    return;
  }
  NSString* script = [NSString
      stringWithFormat:@"if (globalThis.__whimsyEpoch !== __e) {"
                        "  return { __whimsyStale: true };"
                        "}\n%@",
                       aBody];
  NSString* held = [[epoch copy] autorelease];
  WhimsyGuardedDone done = [[aDone copy] autorelease];
  void (^handler)(id, NSError*) = ^(id aResult, NSError* aError) {
    if (aError) {
      done(nil, [aError localizedDescription] ?: @"error");
      return;
    }
    TabEntry* now = FindEntry(aTabId);
    if (!now || !now->mEpoch || ![now->mEpoch isEqualToString:held] ||
        ([aResult isKindOfClass:[NSDictionary class]] &&
         [((NSDictionary*)aResult)[@"__whimsyStale"] boolValue])) {
      done(nil, @"stale");
      return;
    }
    done(aResult, nil);
  };
  ((void (*)(id, SEL, NSString*, NSDictionary*, id, id,
             void (^)(id, NSError*)))objc_msgSend)(
      entry->mWebView, sel, script, @{@"__e" : held}, nil, world, handler);
}

static void StartWebKitDownload(uint32_t aTabId, id aDownload);

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
    BOOL download = NO;
    @try {
      download = NSClassFromString(@"WKDownload") &&
                 [aNavigationAction
                     respondsToSelector:@selector(shouldPerformDownload)] &&
                 [[aNavigationAction valueForKey:@"shouldPerformDownload"]
                     boolValue];
    } @catch (NSException* ex) {
    }
    // WKNavigationActionPolicyDownload (<a download>) or Allow.
    aDecisionHandler(download ? 2 : 1);
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

  // Discover the page's favicon link if present. W32: guarded by the
  // document's epoch, so a late answer never labels the next page.
  uint32_t tabId = _tabId;
  NSString* iconScript =
      @"const el = document.querySelector("
       "  'link[rel~=\"icon\"][href], link[rel=\"shortcut icon\"][href], "
       "link[rel=\"apple-touch-icon\"][href]'"
       ");"
       "return el && el.href ? String(el.href) : '';";
  RunGuarded(_tabId, nil, iconScript, ^(id aResult, NSString* aFailure) {
    if (!aFailure && [aResult isKindOfClass:[NSString class]]) {
      NotifyListener(tabId, "favicon", (NSString*)aResult);
    }
  });
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
  // W32: Whimsy shows Gecko's error page for certificate failures.
  NSString* failing = [aError userInfo][NSURLErrorFailingURLStringErrorKey];
  if (![failing isKindOfClass:[NSString class]]) {
    NSURL* failingURL = [aError userInfo][NSURLErrorFailingURLErrorKey];
    failing = [failingURL isKindOfClass:[NSURL class]]
                  ? [failingURL absoluteString]
                  : @"";
  }
  NotifyListener(_tabId, "neterror",
                 ToJSON(@{
                   @"domain" : [aError domain] ?: @"",
                   @"code" : @([aError code]),
                   @"url" : failing ?: @"",
                 }));
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

// W32: the WebContent process died (a crash, a jetsam kill, or the test
// hook). The WKWebView stays; Whimsy shows Gecko's tab-crashed page and
// reloads it on Restore.
- (void)webViewWebContentProcessDidTerminate:(id)aWebView {
  if (!_observing) {
    return;
  }
  TabEntry* entry = FindEntry(_tabId);
  if (entry && entry->mEpoch) {
    [entry->mEpoch release];
    entry->mEpoch = nil;
  }
  CancelPendingForTab(_tabId);
  NotifyListener(_tabId, "loading", @"false");
  NotifyListener(_tabId, "crashed");
}

// W32: downloads go to Firefox's downloads list. A response WebKit can't show
// (or one marked as an attachment) becomes a WKDownload.
- (void)webView:(id)aWebView
    decidePolicyForNavigationResponse:(id)aNavigationResponse
                      decisionHandler:(void (^)(NSInteger))aDecisionHandler {
  if (!aDecisionHandler) {
    return;
  }
  NSInteger policy = 1;  // WKNavigationResponsePolicyAllow
  @try {
    if (_observing && NSClassFromString(@"WKDownload")) {
      BOOL canShow =
          [[aNavigationResponse valueForKey:@"canShowMIMEType"] boolValue];
      BOOL forMainFrame =
          [[aNavigationResponse valueForKey:@"forMainFrame"] boolValue];
      NSURLResponse* response = [aNavigationResponse valueForKey:@"response"];
      BOOL attachment = NO;
      if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
        NSString* disposition = [(NSHTTPURLResponse*)response
            valueForHTTPHeaderField:@"Content-Disposition"];
        attachment = [[[disposition lowercaseString]
            stringByTrimmingCharactersInSet:[NSCharacterSet
                                                whitespaceCharacterSet]]
            hasPrefix:@"attachment"];
      }
      if (!canShow || (attachment && forMainFrame)) {
        policy = 2;  // WKNavigationResponsePolicyDownload
      }
    }
  } @catch (NSException* ex) {
  }
  aDecisionHandler(policy);
}

- (void)webView:(id)aWebView
    navigationResponse:(id)aNavigationResponse
     didBecomeDownload:(id)aDownload {
  StartWebKitDownload(_tabId, aDownload);
}

- (void)webView:(id)aWebView
    navigationAction:(id)aNavigationAction
    didBecomeDownload:(id)aDownload {
  StartWebKitDownload(_tabId, aDownload);
}

// W32: HTTP auth goes through Firefox's auth prompt and password manager;
// server-trust failures through Gecko's certificate overrides.
- (void)webView:(id)aWebView
    didReceiveAuthenticationChallenge:(NSURLAuthenticationChallenge*)aChallenge
                    completionHandler:
                        (void (^)(NSURLSessionAuthChallengeDisposition,
                                  NSURLCredential*))aCompletion {
  if (!aCompletion) {
    return;
  }
  NSURLProtectionSpace* space = [aChallenge protectionSpace];
  NSString* method = [space authenticationMethod];
  if (!_observing || !space) {
    aCompletion(NSURLSessionAuthChallengePerformDefaultHandling, nil);
    return;
  }
  void (^completion)(NSURLSessionAuthChallengeDisposition, NSURLCredential*) =
      [[aCompletion copy] autorelease];

  if ([method isEqualToString:NSURLAuthenticationMethodServerTrust]) {
    SecTrustRef trust = [space serverTrust];
    if (!trust || SecTrustEvaluateWithError(trust, nullptr)) {
      completion(NSURLSessionAuthChallengePerformDefaultHandling, nil);
      return;
    }
    NSString* certBase64 = @"";
    SecCertificateRef leaf = nullptr;
    if (@available(macOS 12.0, *)) {
      CFArrayRef chain = SecTrustCopyCertificateChain(trust);
      if (chain) {
        if (CFArrayGetCount(chain) > 0) {
          leaf = (SecCertificateRef)CFRetain(CFArrayGetValueAtIndex(chain, 0));
        }
        CFRelease(chain);
      }
    } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
      if (SecTrustGetCertificateCount(trust) > 0) {
        leaf = (SecCertificateRef)CFRetain(
            SecTrustGetCertificateAtIndex(trust, 0));
      }
#pragma clang diagnostic pop
    }
    if (leaf) {
      CFDataRef der = SecCertificateCopyData(leaf);
      if (der) {
        certBase64 = [(NSData*)der base64EncodedStringWithOptions:0] ?: @"";
        CFRelease(der);
      }
      CFRelease(leaf);
    }
    if (!certBase64.length) {
      completion(NSURLSessionAuthChallengePerformDefaultHandling, nil);
      return;
    }
    CFRetain(trust);
    AskListener(
        _tabId, "servertrust",
        @{
          @"host" : [space host] ?: @"",
          @"port" : @([space port]),
          @"cert" : certBase64,
        },
        ^(NSDictionary* aResponse) {
          if ([aResponse[@"trust"] boolValue]) {
            completion(NSURLSessionAuthChallengeUseCredential,
                       [NSURLCredential credentialForTrust:trust]);
          } else {
            completion(NSURLSessionAuthChallengePerformDefaultHandling, nil);
          }
          CFRelease(trust);
        });
    return;
  }

  bool httpAuth =
      [method isEqualToString:NSURLAuthenticationMethodDefault] ||
      [method isEqualToString:NSURLAuthenticationMethodHTTPBasic] ||
      [method isEqualToString:NSURLAuthenticationMethodHTTPDigest] ||
      [method isEqualToString:NSURLAuthenticationMethodNTLM] ||
      [method isEqualToString:NSURLAuthenticationMethodNegotiate];
  if (!httpAuth) {
    // Client certificates and anything else: WebKit's default (no client
    // certificate is offered).
    completion(NSURLSessionAuthChallengePerformDefaultHandling, nil);
    return;
  }
  NSString* scheme = @"basic";
  if ([method isEqualToString:NSURLAuthenticationMethodHTTPDigest]) {
    scheme = @"digest";
  } else if ([method isEqualToString:NSURLAuthenticationMethodNTLM]) {
    scheme = @"ntlm";
  } else if ([method isEqualToString:NSURLAuthenticationMethodNegotiate]) {
    scheme = @"negotiate";
  }
  NSString* protocol = [space protocol] ?: @"https";
  NSString* host = [space host] ?: @"";
  NSString* url = [space port] > 0
                      ? [NSString stringWithFormat:@"%@://%@:%ld/", protocol,
                                                   host, (long)[space port]]
                      : [NSString stringWithFormat:@"%@://%@/", protocol, host];
  NSString* user = [[aChallenge proposedCredential] user] ?: @"";
  AskListener(_tabId, "auth",
              @{
                @"url" : url,
                @"realm" : [space realm] ?: @"",
                @"scheme" : scheme,
                @"proxy" : @([space isProxy]),
                @"failed" : @([aChallenge previousFailureCount] > 0),
                @"username" : user,
              },
              ^(NSDictionary* aResponse) {
                NSString* name = aResponse[@"username"];
                NSString* pass = aResponse[@"password"];
                if (![name isKindOfClass:[NSString class]] ||
                    ![pass isKindOfClass:[NSString class]]) {
                  completion(NSURLSessionAuthChallengeCancelAuthenticationChallenge,
                             nil);
                  return;
                }
                // Session-only, like Gecko's in-memory HTTP auth cache;
                // saving is the password manager's job.
                completion(NSURLSessionAuthChallengeUseCredential,
                           [NSURLCredential
                               credentialWithUser:name
                                         password:pass
                                      persistence:
                                          NSURLCredentialPersistenceForSession]);
              });
}

// WKUIDelegate: JS dialogs, the file picker, and camera/microphone go
// through Gecko's own tab-modal prompts, file picker, and permission
// doorhanger. Unanswered (tab gone): WebKit's defaults.
- (void)webView:(id)aWebView
    runJavaScriptAlertPanelWithMessage:(NSString*)aMessage
                      initiatedByFrame:(id)aFrame
                     completionHandler:(void (^)(void))aCompletion {
  if (!aCompletion) {
    return;
  }
  void (^completion)(void) = [[aCompletion copy] autorelease];
  if (!_observing) {
    completion();
    return;
  }
  AskListener(_tabId, "dialog",
              @{
                @"kind" : @"alert",
                @"message" : aMessage ?: @"",
                @"origin" : FrameOrigin(aFrame),
              },
              ^(NSDictionary* aResponse) {
                completion();
              });
}

- (void)webView:(id)aWebView
    runJavaScriptConfirmPanelWithMessage:(NSString*)aMessage
                        initiatedByFrame:(id)aFrame
                       completionHandler:(void (^)(BOOL))aCompletion {
  if (!aCompletion) {
    return;
  }
  void (^completion)(BOOL) = [[aCompletion copy] autorelease];
  if (!_observing) {
    completion(NO);
    return;
  }
  AskListener(_tabId, "dialog",
              @{
                @"kind" : @"confirm",
                @"message" : aMessage ?: @"",
                @"origin" : FrameOrigin(aFrame),
              },
              ^(NSDictionary* aResponse) {
                completion([aResponse[@"ok"] boolValue]);
              });
}

- (void)webView:(id)aWebView
    runJavaScriptTextInputPanelWithPrompt:(NSString*)aPrompt
                              defaultText:(NSString*)aDefaultText
                         initiatedByFrame:(id)aFrame
                        completionHandler:(void (^)(NSString*))aCompletion {
  if (!aCompletion) {
    return;
  }
  void (^completion)(NSString*) = [[aCompletion copy] autorelease];
  if (!_observing) {
    completion(nil);
    return;
  }
  AskListener(_tabId, "dialog",
              @{
                @"kind" : @"prompt",
                @"message" : aPrompt ?: @"",
                @"value" : aDefaultText ?: @"",
                @"origin" : FrameOrigin(aFrame),
              },
              ^(NSDictionary* aResponse) {
                id value = aResponse[@"value"];
                completion([aResponse[@"ok"] boolValue] &&
                                   [value isKindOfClass:[NSString class]]
                               ? (NSString*)value
                               : nil);
              });
}

- (void)webView:(id)aWebView
    runOpenPanelWithParameters:(id)aParameters
              initiatedByFrame:(id)aFrame
             completionHandler:(void (^)(NSArray*))aCompletion {
  if (!aCompletion) {
    return;
  }
  void (^completion)(NSArray*) = [[aCompletion copy] autorelease];
  if (!_observing) {
    completion(nil);
    return;
  }
  BOOL multiple = NO;
  BOOL directories = NO;
  @try {
    multiple = [[aParameters valueForKey:@"allowsMultipleSelection"] boolValue];
    directories = [[aParameters valueForKey:@"allowsDirectories"] boolValue];
  } @catch (NSException* ex) {
  }
  AskListener(_tabId, "openpanel",
              @{
                @"multiple" : @(multiple),
                @"directories" : @(directories),
              },
              ^(NSDictionary* aResponse) {
                NSArray* paths = aResponse[@"paths"];
                if (![paths isKindOfClass:[NSArray class]] || !paths.count) {
                  completion(nil);
                  return;
                }
                NSMutableArray* urls = [NSMutableArray array];
                for (id path in paths) {
                  if ([path isKindOfClass:[NSString class]]) {
                    [urls addObject:[NSURL fileURLWithPath:path]];
                  }
                }
                completion(urls.count ? urls : nil);
              });
}

- (void)webView:(id)aWebView
    requestMediaCapturePermissionForOrigin:(id)aOrigin
                          initiatedByFrame:(id)aFrame
                                      type:(NSInteger)aType
                           decisionHandler:(void (^)(NSInteger))aDecision {
  if (!aDecision) {
    return;
  }
  void (^decision)(NSInteger) = [[aDecision copy] autorelease];
  if (!_observing) {
    decision(2);  // WKPermissionDecisionDeny
    return;
  }
  // WKMediaCaptureType: 0 camera, 1 microphone, 2 both.
  AskListener(_tabId, "media",
              @{
                @"origin" : OriginString(aOrigin),
                @"frameOrigin" : FrameOrigin(aFrame),
                @"camera" : @(aType == 0 || aType == 2),
                @"microphone" : @(aType == 1 || aType == 2),
              },
              ^(NSDictionary* aResponse) {
                decision([aResponse[@"allow"] boolValue] ? 1 : 2);
              });
}

@end

// W32 epoch guard: messages from Whimsy's isolated-world script. Only the
// entry's own web view and its main frame count; a scroll report from any
// document but the current one is dropped.
@interface WhimsyWebKitScriptHandler : NSObject {
  uint32_t _tabId;
}
- (instancetype)initWithTabId:(uint32_t)aTabId;
@end

@implementation WhimsyWebKitScriptHandler

- (instancetype)initWithTabId:(uint32_t)aTabId {
  if ((self = [super init])) {
    _tabId = aTabId;
  }
  return self;
}

- (void)userContentController:(id)aController
      didReceiveScriptMessage:(id)aMessage {
  TabEntry* entry = FindEntry(_tabId);
  if (!entry || !entry->mWebView) {
    return;
  }
  @try {
    if ([aMessage valueForKey:@"webView"] != entry->mWebView ||
        !IsMainFrame([aMessage valueForKey:@"frameInfo"])) {
      return;
    }
    NSDictionary* body = [aMessage valueForKey:@"body"];
    if (![body isKindOfClass:[NSDictionary class]]) {
      return;
    }
    NSString* epoch = body[@"e"];
    NSString* type = body[@"t"];
    if (![epoch isKindOfClass:[NSString class]] || !epoch.length ||
        ![type isKindOfClass:[NSString class]]) {
      return;
    }
    if ([type isEqualToString:@"epoch"]) {
      if (![epoch isEqualToString:entry->mEpoch]) {
        [entry->mEpoch release];
        entry->mEpoch = [epoch copy];
      }
    } else if (![type isEqualToString:@"scroll"] ||
               ![epoch isEqualToString:entry->mEpoch]) {
      return;
    }
    id x = body[@"x"];
    id y = body[@"y"];
    if ([x isKindOfClass:[NSNumber class]] &&
        [y isKindOfClass:[NSNumber class]]) {
      entry->mScrollX = [x doubleValue];
      entry->mScrollY = [y doubleValue];
    }
  } @catch (NSException* ex) {
  }
}

@end

// W32: one WebKit download, reported to Firefox's downloads list. It keeps
// the listener of the tab it started in, so it outlives that tab.
@interface WhimsyWebKitDownload : NSObject {
 @public
  uint32_t _dlId;
  uint32_t _tabId;
  id _download;  // retained (WKDownload*)
  nsIWhimsyWebKitListener* _listener;  // strong (manual AddRef)
  bool _observing;
  bool _done;
  CFAbsoluteTime _lastProgress;
}
- (instancetype)initWithId:(uint32_t)aId
                     tabId:(uint32_t)aTabId
                  download:(id)aDownload
                  listener:(nsIWhimsyWebKitListener*)aListener;
- (void)send:(NSDictionary*)aPayload type:(const char*)aType;
- (void)finishWithState:(NSString*)aState;
@end

namespace {
static NSMutableDictionary* gDownloads = nil;  // @(dlId) -> download
static uint32_t gNextDownloadId = 1;
}  // namespace

@implementation WhimsyWebKitDownload

- (instancetype)initWithId:(uint32_t)aId
                     tabId:(uint32_t)aTabId
                  download:(id)aDownload
                  listener:(nsIWhimsyWebKitListener*)aListener {
  if ((self = [super init])) {
    _dlId = aId;
    _tabId = aTabId;
    _download = [aDownload retain];
    _listener = aListener;
    NS_IF_ADDREF(_listener);
    @try {
      [_download addObserver:self
                  forKeyPath:@"progress.completedUnitCount"
                     options:0
                     context:nil];
      _observing = true;
    } @catch (NSException* ex) {
    }
  }
  return self;
}

- (void)dealloc {
  [self stopObserving];
  [_download release];
  NS_IF_RELEASE(_listener);
  [super dealloc];
}

- (void)stopObserving {
  if (_observing) {
    _observing = false;
    @try {
      [_download removeObserver:self
                     forKeyPath:@"progress.completedUnitCount"];
    } @catch (NSException* ex) {
    }
  }
}

- (void)send:(NSDictionary*)aPayload type:(const char*)aType {
  if (!_listener) {
    return;
  }
  nsCOMPtr<nsIWhimsyWebKitListener> listener = _listener;
  NSMutableDictionary* payload = [[aPayload mutableCopy] autorelease];
  payload[@"dl"] = @(_dlId);
  nsAutoString type;
  type.AssignASCII(aType);
  nsAutoString data;
  nsCocoaUtils::GetStringForNSString(ToJSON(payload), data);
  listener->OnEvent(_tabId, type, data);
}

- (void)finishWithState:(NSString*)aState {
  if (_done) {
    return;
  }
  _done = true;
  [self stopObserving];
  [[self retain] autorelease];
  [gDownloads removeObjectForKey:@(_dlId)];
  [self send:@{@"state" : aState} type:"download"];
  NS_IF_RELEASE(_listener);
}

- (void)observeValueForKeyPath:(NSString*)aKeyPath
                      ofObject:(id)aObject
                        change:(NSDictionary*)aChange
                       context:(void*)aContext {
  if (_done) {
    return;
  }
  if (![NSThread isMainThread]) {
    [self retain];
    dispatch_async(dispatch_get_main_queue(), ^{
      [self observeValueForKeyPath:aKeyPath
                          ofObject:aObject
                            change:nil
                           context:nullptr];
      [self release];
    });
    return;
  }
  CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
  if (now - _lastProgress < 0.25) {
    return;
  }
  _lastProgress = now;
  NSProgress* progress = [_download valueForKey:@"progress"];
  [self send:@{
    @"state" : @"progress",
    @"current" : @(progress.completedUnitCount),
    @"total" : @(progress.totalUnitCount),
  }
        type:"download"];
}

// WKDownloadDelegate

- (void)download:(id)aDownload
    decideDestinationUsingResponse:(NSURLResponse*)aResponse
                 suggestedFilename:(NSString*)aFilename
                 completionHandler:(void (^)(NSURL*))aCompletion {
  if (!aCompletion) {
    return;
  }
  void (^completion)(NSURL*) = [[aCompletion copy] autorelease];
  if (_done || !_listener) {
    completion(nil);
    return;
  }
  if (!gPending) {
    gPending = [[NSMutableDictionary alloc] init];
  }
  uint32_t req = gNextRequestId++;
  // Download requests aren't tied to a tab entry (id 0), so closing the tab
  // doesn't cancel them.
  WhimsyResponder responder = [[^(NSDictionary* aAnswer) {
    NSString* path = aAnswer[@"path"];
    completion([path isKindOfClass:[NSString class]] && path.length
                   ? [NSURL fileURLWithPath:path]
                   : nil);
  } copy] autorelease];
  gPending[@(req)] = @[ @(0), responder ];
  NSURLRequest* original = [aDownload valueForKey:@"originalRequest"];
  NSString* url = [[aResponse URL] absoluteString] ?:
                  [[original URL] absoluteString] ?: @"";
  [self send:@{
    @"req" : @(req),
    @"url" : url,
    @"filename" : aFilename ?: @"",
    @"mime" : [aResponse MIMEType] ?: @"",
    @"total" : @([aResponse expectedContentLength]),
  }
        type:"download-destination"];
}

- (void)download:(id)aDownload
    didFailWithError:(NSError*)aError
          resumeData:(NSData*)aResumeData {
  [self finishWithState:@"failed"];
}

- (void)downloadDidFinish:(id)aDownload {
  [self finishWithState:@"done"];
}

@end

namespace {
static void StartWebKitDownload(uint32_t aTabId, id aDownload) {
  TabEntry* entry = FindEntry(aTabId);
  if (!aDownload || !entry || !entry->mListener) {
    if (aDownload) {
      ((void (*)(id, SEL, void (^)(NSData*)))objc_msgSend)(
          aDownload, @selector(cancel:), nil);
    }
    return;
  }
  if (!gDownloads) {
    gDownloads = [[NSMutableDictionary alloc] init];
  }
  uint32_t dlId = gNextDownloadId++;
  WhimsyWebKitDownload* record =
      [[[WhimsyWebKitDownload alloc] initWithId:dlId
                                          tabId:aTabId
                                       download:aDownload
                                       listener:entry->mListener] autorelease];
  gDownloads[@(dlId)] = record;
  @try {
    [aDownload setValue:record forKey:@"delegate"];
  } @catch (NSException* ex) {
  }
}
}  // namespace

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
// The WKWebView sits below Gecko's view, and Gecko paints the window's
// backdrop (the space's theme gradient, the translucent dark default, grain,
// the inactive-window grey) across the whole window, page rect included. With
// nothing else done that paint lands on top of the page and dims or tints it.
// So while a WebKit page is showing, Gecko's view is masked: inside the page's
// rounded rect only the overlays Whimsy keeps above the page (the same
// exclusions the hit-test honours) are drawn, and everywhere else, or with no
// WebKit page showing, Gecko draws exactly as before.
static void UpdateHoleMask(NSView* aChildView,
                           const std::vector<const TabEntry*>& aShown) {
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
    for (const TabEntry* entry : aShown) {
      CGRect hole =
          NSRectToCGRect([aChildView convertRectToLayer:entry->mHoleInChild]);
      CGFloat radius = std::min({entry->mHoleRadius, hole.size.width / 2,
                                 hole.size.height / 2});
      if (radius > 0) {
        CGPathAddRoundedRect(path, nullptr, hole, radius, radius);
      } else {
        CGPathAddRect(path, nullptr, hole);
      }
      for (const NSRect& excl : entry->mExclusionsInChild) {
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

static void UpdateHoles(NSView* aChildView) {
  if (!aChildView) {
    return;
  }
  EnsureChildViewHitTestInstalled(aChildView);
  NSMutableArray<NSValue*>* holes = [NSMutableArray array];
  std::vector<const TabEntry*> shown;
  if (gTabs) {
    for (const auto& entry : *gTabs) {
      if (entry.mChildView == aChildView && entry.mBelow && entry.mVisible &&
          !NSIsEmptyRect(entry.mHoleInChild)) {
        shown.push_back(&entry);
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
  UpdateHoleMask(aChildView, shown);
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
  CancelPendingForTab(aEntry.mId);
  if (aEntry.mUserContent) {
    @try {
      SEL removeSel = NSSelectorFromString(
          @"removeScriptMessageHandlerForName:contentWorld:");
      id world = WhimsyContentWorld();
      if (world && [aEntry.mUserContent respondsToSelector:removeSel]) {
        ((void (*)(id, SEL, NSString*, id))objc_msgSend)(
            aEntry.mUserContent, removeSel, @"whimsy", world);
      }
      [aEntry.mUserContent performSelector:@selector(removeAllUserScripts)];
    } @catch (NSException* ex) {
    }
    [aEntry.mUserContent release];
    aEntry.mUserContent = nil;
  }
  [aEntry.mScriptHandler release];
  aEntry.mScriptHandler = nil;
  [aEntry.mEpoch release];
  aEntry.mEpoch = nil;
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

  // W32 epoch guard: Whimsy's isolated-world script and its message
  // handler.
  uint32_t newId = gNextId++;
  WhimsyWebKitScriptHandler* scriptHandler = nil;
  id userContent = nil;
  @try {
    id world = WhimsyContentWorld();
    Class userScriptClass = NSClassFromString(@"WKUserScript");
    userContent = [config valueForKey:@"userContentController"];
    SEL initScriptSel = NSSelectorFromString(
        @"initWithSource:injectionTime:forMainFrameOnly:inContentWorld:");
    SEL addHandlerSel =
        NSSelectorFromString(@"addScriptMessageHandler:contentWorld:name:");
    if (world && userContent &&
        [userScriptClass instancesRespondToSelector:initScriptSel] &&
        [userContent respondsToSelector:addHandlerSel]) {
      id userScript =
          ((id (*)(id, SEL, NSString*, NSInteger, BOOL, id))objc_msgSend)(
              [userScriptClass alloc], initScriptSel, kEpochScript,
              0 /* WKUserScriptInjectionTimeAtDocumentStart */, YES, world);
      [userContent performSelector:@selector(addUserScript:)
                        withObject:userScript];
      [userScript release];
      scriptHandler = [[WhimsyWebKitScriptHandler alloc] initWithTabId:newId];
      ((void (*)(id, SEL, id, id, NSString*))objc_msgSend)(
          userContent, addHandlerSel, scriptHandler, world, @"whimsy");
      [userContent retain];
    } else {
      userContent = nil;
    }
  } @catch (NSException* ex) {
    userContent = nil;
  }

  SEL initSel = @selector(initWithFrame:configuration:);
  id rawWebView = [webViewClass alloc];
  NSView* webView = ((NSView * (*)(id, SEL, NSRect, id)) objc_msgSend)(
      rawWebView, initSel, host.bounds, config);
  [config release];
  if (!webView) {
    [scriptHandler release];
    [userContent release];
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

  WhimsyWebKitObserver* observer =
      [[WhimsyWebKitObserver alloc] initWithTabId:newId webView:webView];
  @try {
    [webView setValue:observer forKey:@"navigationDelegate"];
    [webView setValue:observer forKey:@"UIDelegate"];
  } @catch (NSException* ex) {
  }

  TabEntry entry;
  entry.mId = newId;
  entry.mBelow = below;
  entry.mVisible = true;
  entry.mChildView = childView;
  entry.mHost = host;
  entry.mWebView = webView;
  entry.mObserver = observer;
  entry.mScriptHandler = scriptHandler;
  entry.mUserContent = userContent;
  entry.mListener = aListener;
  gTabs->AppendElement(std::move(entry));

  *aOutId = newId;
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
  entry->mHoleRadius = std::max(0.0, aRadius);
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
nsWhimsyWebKit::SampleWindowColor(mozIDOMWindowProxy* aWindow, double aX,
                                  double aY, double aWidth, double aHeight,
                                  nsAString& aOut) {
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

NS_IMETHODIMP
nsWhimsyWebKit::SaveSessionState(uint32_t aId, nsAString& aOut) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  aOut.Truncate();
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mWebView) {
    return NS_ERROR_INVALID_ARG;
  }
  NSString* state = @"";
  @try {
    if ([entry->mWebView respondsToSelector:@selector(interactionState)]) {
      id data = [entry->mWebView valueForKey:@"interactionState"];
      if ([data isKindOfClass:[NSData class]]) {
        state = [(NSData*)data base64EncodedStringWithOptions:0] ?: @"";
      }
    }
  } @catch (NSException* ex) {
  }
  NSURL* url = [entry->mWebView valueForKey:@"URL"];
  NSString* title = [entry->mWebView valueForKey:@"title"];
  NSDictionary* dict = @{
    @"state" : state,
    @"url" : [url isKindOfClass:[NSURL class]] ? ([url absoluteString] ?: @"")
                                               : @"",
    @"title" : [title isKindOfClass:[NSString class]] ? title : @"",
    @"scrollX" : @(entry->mScrollX),
    @"scrollY" : @(entry->mScrollY),
  };
  nsCocoaUtils::GetStringForNSString(ToJSON(dict), aOut);
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::RestoreSessionState(uint32_t aId, const nsAString& aStateJson,
                                    bool* aOut) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  NS_ENSURE_ARG_POINTER(aOut);
  *aOut = false;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mWebView) {
    return NS_ERROR_INVALID_ARG;
  }
  NSDictionary* dict = DictFromJSON(aStateJson);
  NSString* state = dict[@"state"];
  if (![state isKindOfClass:[NSString class]] || !state.length) {
    return NS_OK;
  }
  NSData* data = [[[NSData alloc] initWithBase64EncodedString:state
                                                      options:0] autorelease];
  if (!data) {
    return NS_OK;
  }
  @try {
    if ([entry->mWebView respondsToSelector:@selector(setInteractionState:)]) {
      [entry->mWebView setValue:data forKey:@"interactionState"];
      *aOut = true;
    }
  } @catch (NSException* ex) {
    *aOut = false;
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::Respond(uint32_t aId, uint32_t aRequestId,
                        const nsAString& aResponseJson) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  AnswerPending(aRequestId, aId, DictFromJSON(aResponseJson));
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::CancelDownload(uint32_t aDownloadId) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  WhimsyWebKitDownload* record = gDownloads[@(aDownloadId)];
  if (!record) {
    return NS_OK;
  }
  [[record retain] autorelease];
  id download = record->_download;
  [record finishWithState:@"cancelled"];
  @try {
    ((void (*)(id, SEL, void (^)(NSData*)))objc_msgSend)(
        download, @selector(cancel:), nil);
  } @catch (NSException* ex) {
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::CurrentEpoch(uint32_t aId, nsAString& aOut) {
  aOut.Truncate();
  NSString* epoch = EntryEpoch(aId);
  if (epoch) {
    nsCocoaUtils::GetStringForNSString(epoch, aOut);
  }
  return NS_OK;
}

NS_IMETHODIMP
nsWhimsyWebKit::EvaluateGuarded(uint32_t aId, const nsAString& aEpoch,
                                const nsAString& aScript, JSContext* aCx,
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
  RefPtr<Promise> held = promise;
  RunGuarded(aId, nsCocoaUtils::ToNSString(aEpoch),
             nsCocoaUtils::ToNSString(aScript),
             ^(id aResult, NSString* aFailure) {
               if (aFailure) {
                 if ([aFailure isEqualToString:@"stale"] ||
                     [aFailure isEqualToString:@"gone"]) {
                   held->MaybeRejectWithAbortError(
                       "The document changed before the script ran");
                 } else {
                   nsAutoString msg;
                   nsCocoaUtils::GetStringForNSString(aFailure, msg);
                   held->MaybeRejectWithOperationError(
                       NS_ConvertUTF16toUTF8(msg));
                 }
                 return;
               }
               nsAutoString out;
               nsCocoaUtils::GetStringForNSString(ResultToString(aResult),
                                                  out);
               held->MaybeResolve(out);
             });
  promise.forget(aOutPromise);
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::DefaultCaptureDevices(nsAString& aOut) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  aOut.AssignLiteral("{}");
  Class deviceClass = NSClassFromString(@"AVCaptureDevice");
  if (!deviceClass) {
    [[NSBundle bundleWithPath:@"/System/Library/Frameworks/AVFoundation.framework"]
        load];
    deviceClass = NSClassFromString(@"AVCaptureDevice");
  }
  SEL defaultSel = NSSelectorFromString(@"defaultDeviceWithMediaType:");
  if (!deviceClass || ![deviceClass respondsToSelector:defaultSel]) {
    return NS_OK;
  }
  NSMutableDictionary* result = [NSMutableDictionary dictionary];
  // AVMediaTypeVideo and AVMediaTypeAudio.
  NSDictionary* kinds = @{@"camera" : @"vide", @"microphone" : @"soun"};
  for (NSString* kind in kinds) {
    id device = ((id (*)(id, SEL, id))objc_msgSend)(deviceClass, defaultSel,
                                                    kinds[kind]);
    if (!device) {
      continue;
    }
    id name = [device valueForKey:@"localizedName"];
    id uid = [device valueForKey:@"uniqueID"];
    if (![name isKindOfClass:[NSString class]] || ![name length]) {
      continue;
    }
    result[kind] = @{
      @"name" : name,
      @"id" : [uid isKindOfClass:[NSString class]] ? uid : name,
    };
  }
  NSData* json = [NSJSONSerialization dataWithJSONObject:result
                                                 options:0
                                                   error:nil];
  if (json) {
    NSString* str = [[[NSString alloc] initWithData:json
                                           encoding:NSUTF8StringEncoding]
        autorelease];
    nsCocoaUtils::GetStringForNSString(str, aOut);
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyWebKit::KillWebContentProcessForTesting(uint32_t aId) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  TabEntry* entry = FindEntry(aId);
  if (!entry || !entry->mWebView) {
    return NS_ERROR_INVALID_ARG;
  }
  SEL pidSel = NSSelectorFromString(@"_webProcessIdentifier");
  if ([entry->mWebView respondsToSelector:pidSel]) {
    pid_t pid = ((pid_t (*)(id, SEL))objc_msgSend)(entry->mWebView, pidSel);
    if (pid > 0 && pid != getpid()) {
      kill(pid, SIGKILL);
      return NS_OK;
    }
  }
  SEL killSel = NSSelectorFromString(@"_killWebContentProcess");
  if ([entry->mWebView respondsToSelector:killSel]) {
    ((void (*)(id, SEL))objc_msgSend)(entry->mWebView, killSel);
    return NS_OK;
  }
  return NS_ERROR_NOT_AVAILABLE;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

}  // namespace whimsy
