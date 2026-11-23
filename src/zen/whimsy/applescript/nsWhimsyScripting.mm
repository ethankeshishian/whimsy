/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W30 AppleScript (research/macos-integration.md option B): the Cocoa
// scripting side of Whimsy.sdef (Contents/Resources, named by
// OSAScriptingDefinition in Info.plist). Cocoa reads the dictionary, turns
// each Apple event into key-value coding on these classes, and they ask
// WhimsyScripting.sys.mjs (@whimsy/scripting;1, nsIWhimsyScripting) for
// everything: these objects are only ids, so a script always sees the
// windows, tabs, and spaces as they are now, through the same rules.
//
// Chrome's model: the application's windows (appleScriptWindows, never
// NSApplication's own orderedWindows, which would include private ones),
// each with tabs and spaces. Errors come back from the JS side as an
// nsresult and are put on the running command.

#import <Cocoa/Cocoa.h>

#include "mozilla/RefPtr.h"
#include "nsCOMPtr.h"
#include "nsIWhimsyScripting.h"
#include "nsObjCExceptions.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"

namespace {

constexpr const char* kContract = "@whimsy/scripting;1";

// MacErrors.h
constexpr int kErrEventFailed = -10000;
constexpr int kErrNotPermitted = -10004;
constexpr int kErrNoSuchObject = -1728;
constexpr int kErrWrongType = -1703;

nsCOMPtr<nsIWhimsyScripting> Service() { return do_GetService(kContract); }

void Fail(NSScriptCommand* aCommand, nsresult aResult) {
  if (!aCommand) {
    return;
  }
  if (aResult == NS_ERROR_NOT_AVAILABLE) {
    aCommand.scriptErrorNumber = kErrNotPermitted;
    aCommand.scriptErrorString = @"Scripting is turned off in Whimsy.";
  } else if (aResult == NS_ERROR_MALFORMED_URI) {
    aCommand.scriptErrorNumber = kErrWrongType;
    aCommand.scriptErrorString =
        @"Whimsy only opens http, https, and about:blank addresses from "
        @"scripts.";
  } else if (aResult == NS_ERROR_INVALID_ARG) {
    aCommand.scriptErrorNumber = kErrNoSuchObject;
    aCommand.scriptErrorString = @"Whimsy can't find that window, tab, or space.";
  } else {
    aCommand.scriptErrorNumber = kErrEventFailed;
  }
}

void Fail(nsresult aResult) { Fail([NSScriptCommand currentCommand], aResult); }

NSString* ToNS(const nsACString& aString) {
  return [[[NSString alloc] initWithBytes:aString.BeginReading()
                                   length:aString.Length()
                                 encoding:NSUTF8StringEncoding] autorelease];
}

nsAutoCString ToUTF8(NSString* aString) {
  nsAutoCString result;
  if ([aString isKindOfClass:[NSString class]]) {
    result.Assign([aString UTF8String]);
  }
  return result;
}

// Calls the JS side; its JSON answer, or nil (with the error set on the
// running command).
template <typename Call>
id Ask(Call&& aCall) {
  nsCOMPtr<nsIWhimsyScripting> service = Service();
  if (!service) {
    Fail(NS_ERROR_NOT_AVAILABLE);
    return nil;
  }
  nsAutoCString json;
  nsresult rv = aCall(service.get(), json);
  if (NS_FAILED(rv)) {
    Fail(rv);
    return nil;
  }
  NSData* data = [NSData dataWithBytes:json.BeginReading() length:json.Length()];
  id result = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return result == [NSNull null] ? nil : result;
}

// Calls the JS side for a command that answers nothing.
template <typename Call>
void Do(Call&& aCall) {
  nsCOMPtr<nsIWhimsyScripting> service = Service();
  if (!service) {
    Fail(NS_ERROR_NOT_AVAILABLE);
    return;
  }
  nsresult rv = aCall(service.get());
  if (NS_FAILED(rv)) {
    Fail(rv);
  }
}

// The dictionary's description of a class, for object specifiers. Not
// [object classDescription]: NSApp is GeckoNSApplication, which isn't named
// in Whimsy.sdef, and NSObject's version doesn't look at superclasses, so
// every specifier came back with no class and the script failed with
// "Can't make «class    » id ... into type specifier" (-1700).
NSScriptClassDescription* ClassDescription(Class aClass) {
  return [NSScriptClassDescription classDescriptionForClass:aClass];
}

id Field(NSDictionary* aRecord, NSString* aKey) {
  id value = [aRecord isKindOfClass:[NSDictionary class]] ? aRecord[aKey] : nil;
  return value == [NSNull null] ? nil : value;
}

}  // namespace

@class WhimsyScriptTab;
@class WhimsyScriptSpace;

// ---------------------------------------------------------------------------

@interface WhimsyScriptWindow : NSObject {
  NSString* mID;
}
- (instancetype)initWithID:(NSString*)aID;
@end

@interface WhimsyScriptTab : NSObject {
  NSString* mID;
  NSString* mWindowID;
  // `make new tab with properties {URL: ...}` sets the address before the
  // tab is inserted, so it waits here until then.
  NSString* mPendingURL;
}
- (instancetype)initWithID:(NSString*)aID windowID:(NSString*)aWindowID;
- (void)setID:(NSString*)aID windowID:(NSString*)aWindowID;
- (NSString*)pendingURL;
@end

@interface WhimsyScriptSpace : NSObject {
  NSString* mID;
  NSString* mWindowID;
}
- (instancetype)initWithID:(NSString*)aID windowID:(NSString*)aWindowID;
@end

// Opens the tab a `make` command made, in a window (aSpaceID empty) or a
// space. When it's refused, the tab keeps no id and the error is set.
static void InsertTab(WhimsyScriptTab* aTab, NSString* aWindowID, NSString* aSpaceID) {
  nsAutoCString windowId = ToUTF8(aWindowID);
  nsAutoCString spaceId = ToUTF8(aSpaceID);
  nsAutoCString url = ToUTF8([aTab pendingURL]);
  nsAutoCString id;
  nsCOMPtr<nsIWhimsyScripting> service = Service();
  nsresult rv = service ? service->MakeTab(windowId, spaceId, url, id) : NS_ERROR_NOT_AVAILABLE;
  if (NS_FAILED(rv)) {
    Fail(rv);
    return;
  }
  [aTab setID:ToNS(id) windowID:aWindowID];
}

static NSArray* TabsOf(NSString* aWindowID, NSString* aSpaceID) {
  NSArray* ids = Ask([&](nsIWhimsyScripting* aService, nsACString& aResult) {
    return aService->Tabs(ToUTF8(aWindowID), ToUTF8(aSpaceID), aResult);
  });
  NSMutableArray* tabs = [NSMutableArray array];
  for (id tabID in [ids isKindOfClass:[NSArray class]] ? ids : @[]) {
    [tabs addObject:[[[WhimsyScriptTab alloc] initWithID:tabID windowID:aWindowID] autorelease]];
  }
  return tabs;
}

// ---------------------------------------------------------------------------

@implementation WhimsyScriptWindow

- (instancetype)initWithID:(NSString*)aID {
  if ((self = [super init])) {
    mID = [aID copy];
  }
  return self;
}

- (void)dealloc {
  [mID release];
  [super dealloc];
}

- (NSString*)uniqueID {
  return mID;
}

- (NSScriptObjectSpecifier*)objectSpecifier {
  return [[[NSUniqueIDSpecifier alloc]
      initWithContainerClassDescription:ClassDescription([NSApplication class])
                     containerSpecifier:nil
                                    key:@"appleScriptWindows"
                               uniqueID:mID] autorelease];
}

- (NSDictionary*)record {
  return Ask([&](nsIWhimsyScripting* aService, nsACString& aResult) {
    return aService->Window(ToUTF8(mID), aResult);
  });
}

- (NSString*)name {
  return Field([self record], @"name");
}

- (NSString*)mode {
  return Field([self record], @"mode");
}

- (WhimsyScriptTab*)activeTab {
  NSString* tabID = Field([self record], @"activeTabId");
  return tabID ? [[[WhimsyScriptTab alloc] initWithID:tabID windowID:mID] autorelease] : nil;
}

- (NSNumber*)activeTabIndex {
  return Field([self record], @"activeTabIndex");
}

- (void)setActiveTabIndex:(NSNumber*)aIndex {
  Do([&](nsIWhimsyScripting* aService) {
    return aService->SetActiveTabIndex(ToUTF8(mID), [aIndex intValue]);
  });
}

- (WhimsyScriptSpace*)activeSpace {
  NSString* spaceID = Field([self record], @"activeSpaceId");
  return spaceID ? [[[WhimsyScriptSpace alloc] initWithID:spaceID windowID:mID] autorelease] : nil;
}

- (NSArray*)tabs {
  return TabsOf(mID, @"");
}

- (void)insertInTabs:(WhimsyScriptTab*)aTab {
  InsertTab(aTab, mID, @"");
}

// New tabs go where Whimsy puts them in the space; the index isn't kept.
- (void)insertObject:(WhimsyScriptTab*)aTab inTabsAtIndex:(NSUInteger)aIndex {
  InsertTab(aTab, mID, @"");
}

// Key-value coding only treats `tabs` as an insertable list when it can
// also remove from it; without this, `make new tab` failed before
// inserting. Scripts close tabs with `close`, never by removing them.
- (void)removeObjectFromTabsAtIndex:(NSUInteger)aIndex {
  Fail(NS_ERROR_FAILURE);
}

- (NSArray*)spaces {
  NSArray* records = Ask([&](nsIWhimsyScripting* aService, nsACString& aResult) {
    return aService->Spaces(ToUTF8(mID), aResult);
  });
  NSMutableArray* spaces = [NSMutableArray array];
  for (NSDictionary* record in [records isKindOfClass:[NSArray class]] ? records : @[]) {
    [spaces addObject:[[[WhimsyScriptSpace alloc] initWithID:Field(record, @"id")
                                                    windowID:mID] autorelease]];
  }
  return spaces;
}

- (id)handleCloseScriptCommand:(NSCloseCommand*)aCommand {
  Do([&](nsIWhimsyScripting* aService) { return aService->CloseWindow(ToUTF8(mID)); });
  return nil;
}

@end

// ---------------------------------------------------------------------------

@implementation WhimsyScriptTab

- (instancetype)init {
  return [self initWithID:nil windowID:nil];
}

- (instancetype)initWithID:(NSString*)aID windowID:(NSString*)aWindowID {
  if ((self = [super init])) {
    mID = [aID copy];
    mWindowID = [aWindowID copy];
  }
  return self;
}

- (void)dealloc {
  [mID release];
  [mWindowID release];
  [mPendingURL release];
  [super dealloc];
}

- (void)setID:(NSString*)aID windowID:(NSString*)aWindowID {
  [mID release];
  mID = [aID copy];
  [mWindowID release];
  mWindowID = [aWindowID copy];
}

- (NSString*)pendingURL {
  return mPendingURL;
}

- (NSString*)uniqueID {
  return mID;
}

- (NSScriptObjectSpecifier*)objectSpecifier {
  if (!mID) {
    return nil;
  }
  WhimsyScriptWindow* window = [[[WhimsyScriptWindow alloc] initWithID:mWindowID] autorelease];
  return [[[NSUniqueIDSpecifier alloc]
      initWithContainerClassDescription:ClassDescription([WhimsyScriptWindow class])
                     containerSpecifier:[window objectSpecifier]
                                    key:@"tabs"
                               uniqueID:mID] autorelease];
}

- (NSDictionary*)record {
  if (!mID) {
    return nil;
  }
  return Ask([&](nsIWhimsyScripting* aService, nsACString& aResult) {
    return aService->Tab(ToUTF8(mID), aResult);
  });
}

- (NSString*)URL {
  return mID ? Field([self record], @"url") : mPendingURL;
}

- (void)setURL:(NSString*)aURL {
  if (!mID) {
    [mPendingURL release];
    mPendingURL = [aURL copy];
    return;
  }
  Do([&](nsIWhimsyScripting* aService) { return aService->SetURL(ToUTF8(mID), ToUTF8(aURL)); });
}

- (NSString*)title {
  return Field([self record], @"title");
}

- (NSNumber*)loading {
  return Field([self record], @"loading");
}

- (NSNumber*)pinned {
  return Field([self record], @"pinned");
}

- (WhimsyScriptSpace*)space {
  NSDictionary* record = [self record];
  NSString* spaceID = Field(record, @"spaceId");
  NSString* windowID = Field(record, @"windowId");
  return spaceID ? [[[WhimsyScriptSpace alloc] initWithID:spaceID windowID:windowID] autorelease]
                 : nil;
}

- (id)handleCloseScriptCommand:(NSCloseCommand*)aCommand {
  Do([&](nsIWhimsyScripting* aService) { return aService->CloseTab(ToUTF8(mID)); });
  return nil;
}

- (id)handleReloadScriptCommand:(NSScriptCommand*)aCommand {
  Do([&](nsIWhimsyScripting* aService) { return aService->Reload(ToUTF8(mID)); });
  return nil;
}

- (id)handleGoBackScriptCommand:(NSScriptCommand*)aCommand {
  Do([&](nsIWhimsyScripting* aService) { return aService->GoBack(ToUTF8(mID)); });
  return nil;
}

- (id)handleGoForwardScriptCommand:(NSScriptCommand*)aCommand {
  Do([&](nsIWhimsyScripting* aService) { return aService->GoForward(ToUTF8(mID)); });
  return nil;
}

- (id)handleSelectScriptCommand:(NSScriptCommand*)aCommand {
  Do([&](nsIWhimsyScripting* aService) { return aService->SelectTab(ToUTF8(mID)); });
  return nil;
}

@end

// ---------------------------------------------------------------------------

@implementation WhimsyScriptSpace

- (instancetype)initWithID:(NSString*)aID windowID:(NSString*)aWindowID {
  if ((self = [super init])) {
    mID = [aID copy];
    mWindowID = [aWindowID copy];
  }
  return self;
}

- (void)dealloc {
  [mID release];
  [mWindowID release];
  [super dealloc];
}

- (NSString*)uniqueID {
  return mID;
}

- (NSScriptObjectSpecifier*)objectSpecifier {
  WhimsyScriptWindow* window = [[[WhimsyScriptWindow alloc] initWithID:mWindowID] autorelease];
  return [[[NSUniqueIDSpecifier alloc]
      initWithContainerClassDescription:ClassDescription([WhimsyScriptWindow class])
                     containerSpecifier:[window objectSpecifier]
                                    key:@"spaces"
                               uniqueID:mID] autorelease];
}

- (NSString*)name {
  NSArray* records = Ask([&](nsIWhimsyScripting* aService, nsACString& aResult) {
    return aService->Spaces(ToUTF8(mWindowID), aResult);
  });
  for (NSDictionary* record in [records isKindOfClass:[NSArray class]] ? records : @[]) {
    if ([Field(record, @"id") isEqual:mID]) {
      return Field(record, @"name");
    }
  }
  if (records) {
    Fail(NS_ERROR_INVALID_ARG);
  }
  return nil;
}

- (NSArray*)tabs {
  return TabsOf(mWindowID, mID);
}

- (void)insertInTabs:(WhimsyScriptTab*)aTab {
  InsertTab(aTab, mWindowID, mID);
}

- (void)insertObject:(WhimsyScriptTab*)aTab inTabsAtIndex:(NSUInteger)aIndex {
  InsertTab(aTab, mWindowID, mID);
}

// As on the window: needed for `make`, never used to close a tab.
- (void)removeObjectFromTabsAtIndex:(NSUInteger)aIndex {
  Fail(NS_ERROR_FAILURE);
}

- (id)handleSelectScriptCommand:(NSScriptCommand*)aCommand {
  Do([&](nsIWhimsyScripting* aService) {
    return aService->SelectSpace(ToUTF8(mWindowID), ToUTF8(mID));
  });
  return nil;
}

@end

// ---------------------------------------------------------------------------

// The application's windows, for the sdef's `window` element.
@interface NSApplication (WhimsyScripting)
@end

@implementation NSApplication (WhimsyScripting)

- (NSArray*)appleScriptWindows {
  NSArray* ids = Ask([](nsIWhimsyScripting* aService, nsACString& aResult) {
    return aService->Windows(aResult);
  });
  NSMutableArray* windows = [NSMutableArray array];
  for (id windowID in [ids isKindOfClass:[NSArray class]] ? ids : @[]) {
    [windows addObject:[[[WhimsyScriptWindow alloc] initWithID:windowID] autorelease]];
  }
  return windows;
}

// `make new window` is answered by WhimsyScriptMakeCommand below; this is
// only here so Cocoa sees the element as one that takes new objects.
- (void)insertInAppleScriptWindows:(WhimsyScriptWindow*)aWindow {
  Fail(NS_ERROR_INVALID_ARG);
}

@end

// ---------------------------------------------------------------------------

// `make`: tabs go through Cocoa's own create command (a WhimsyScriptTab,
// then insertInTabs: on its window or space). A new window takes a moment
// to start, so the command waits for it and answers with the window.
@interface WhimsyScriptMakeCommand : NSCreateCommand
@end

namespace {

// Resumes the suspended command once, with the window or the error. Never
// answered (the JS side dropped it), it fails the command rather than
// leaving the script waiting.
class MakeWindowCallback final : public nsIWhimsyScriptingCallback {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWHIMSYSCRIPTINGCALLBACK

  explicit MakeWindowCallback(NSScriptCommand* aCommand) : mCommand([aCommand retain]) {}

  // The command was never suspended: nothing to resume.
  void Forget() {
    [mCommand release];
    mCommand = nil;
  }

 private:
  ~MakeWindowCallback() {
    if (mCommand) {
      Fail(mCommand, NS_ERROR_FAILURE);
      Resume(nil);
    }
  }

  void Resume(id aResult) {
    NSScriptCommand* command = mCommand;
    mCommand = nil;
    [command resumeExecutionWithResult:aResult];
    [command release];
  }

  // Retained until resumed.
  NSScriptCommand* mCommand;
};

NS_IMPL_ISUPPORTS(MakeWindowCallback, nsIWhimsyScriptingCallback)

NS_IMETHODIMP
MakeWindowCallback::OnWindow(const nsACString& aId) {
  NS_OBJC_BEGIN_TRY_IGNORE_BLOCK;
  if (mCommand) {
    WhimsyScriptWindow* window = [[[WhimsyScriptWindow alloc] initWithID:ToNS(aId)] autorelease];
    Resume([window objectSpecifier]);
  }
  NS_OBJC_END_TRY_IGNORE_BLOCK;
  return NS_OK;
}

NS_IMETHODIMP
MakeWindowCallback::OnError(nsresult aError) {
  NS_OBJC_BEGIN_TRY_IGNORE_BLOCK;
  if (mCommand) {
    Fail(mCommand, aError);
    Resume(nil);
  }
  NS_OBJC_END_TRY_IGNORE_BLOCK;
  return NS_OK;
}

}  // namespace

@implementation WhimsyScriptMakeCommand

- (id)performDefaultImplementation {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  if (![[[self createClassDescription] className] isEqualToString:@"window"]) {
    return [super performDefaultImplementation];
  }
  nsCOMPtr<nsIWhimsyScripting> service = Service();
  RefPtr<MakeWindowCallback> callback = new MakeWindowCallback(self);
  // The callback is always later (the window has to start), so the
  // command is suspended before it can be resumed.
  nsresult rv = service ? service->MakeWindow(""_ns, callback) : NS_ERROR_NOT_AVAILABLE;
  if (NS_FAILED(rv)) {
    callback->Forget();
    Fail(self, rv);
    return nil;
  }
  [self suspendExecution];
  return nil;
  NS_OBJC_END_TRY_BLOCK_RETURN(nil);
}

@end
