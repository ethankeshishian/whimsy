/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/native1: macOS Focus for Whimsy's own toasts. See nsIWhimsyFocus.idl
// for why there are two sources. Nothing here runs at startup: the front
// end gets the service when the first window opens and the feature is on.

#import <Cocoa/Cocoa.h>
#import <CoreServices/CoreServices.h>
#import <Intents/Intents.h>
#import <Security/SecTask.h>

#include <limits.h>
#include <stdlib.h>

#include "nsWhimsyFocus.h"

#include "mozilla/Services.h"
#include "nsIObserverService.h"
#include "nsObjCExceptions.h"
#include "nsString.h"
#include "nsThreadUtils.h"

namespace whimsy {

namespace {

constexpr const char* kTopic = "whimsy-focus-changed";

// INFocusStatusCenter answers only apps signed with this.
bool HasCommunicationEntitlement() {
  static int sAnswer = -1;  // main thread only
  if (sAnswer >= 0) {
    return sAnswer == 1;
  }
  sAnswer = 0;
  SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
  if (!task) {
    return false;
  }
  CFTypeRef value = SecTaskCopyValueForEntitlement(
      task, CFSTR("com.apple.developer.usernotifications.communication"), nullptr);
  CFRelease(task);
  if (value) {
    if (CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)value)) {
      sAnswer = 1;
    }
    CFRelease(value);
  }
  return sAnswer == 1;
}

void Notify(const char16_t* aData) {
  nsString data(aData);
  NS_DispatchToMainThread(NS_NewRunnableFunction("WhimsyFocus::Notify", [data]() {
    nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
    if (obs) {
      obs->NotifyObservers(nullptr, kTopic, data.get());
    }
  }));
}

// Called on sQueue, coalesced by the stream's latency.
void StreamCallback(ConstFSEventStreamRef aStream, void* aInfo, size_t aCount, void* aPaths,
                    const FSEventStreamEventFlags aFlags[], const FSEventStreamEventId aIds[]) {
  if (aCount) {
    Notify(u"database");
  }
}

dispatch_queue_t Queue() {
  static dispatch_queue_t sQueue = nullptr;  // main thread only; kept
  if (!sQueue) {
    sQueue = dispatch_queue_create("org.whimsy.focus-watch", DISPATCH_QUEUE_SERIAL);
  }
  return sQueue;
}

}  // namespace

NS_IMPL_ISUPPORTS(nsWhimsyFocus, nsIWhimsyFocus)

nsWhimsyFocus::~nsWhimsyFocus() { StopWatching(); }

NS_IMETHODIMP
nsWhimsyFocus::GetHasFocusEntitlement(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = HasCommunicationEntitlement();
  return NS_OK;
}

NS_IMETHODIMP
nsWhimsyFocus::GetAuthorizationStatus(nsACString& aStatus) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  aStatus.AssignLiteral("unavailable");
  if (!HasCommunicationEntitlement()) {
    return NS_OK;
  }
  if (@available(macOS 12.0, *)) {
    switch ([INFocusStatusCenter defaultCenter].authorizationStatus) {
      case INFocusStatusAuthorizationStatusNotDetermined:
        aStatus.AssignLiteral("notDetermined");
        break;
      case INFocusStatusAuthorizationStatusRestricted:
        aStatus.AssignLiteral("restricted");
        break;
      case INFocusStatusAuthorizationStatusDenied:
        aStatus.AssignLiteral("denied");
        break;
      case INFocusStatusAuthorizationStatusAuthorized:
        aStatus.AssignLiteral("authorized");
        break;
    }
  }
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyFocus::GetSystemFocusStatus(nsACString& aStatus) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  aStatus.AssignLiteral("unavailable");
  if (!HasCommunicationEntitlement()) {
    return NS_OK;
  }
  if (@available(macOS 12.0, *)) {
    INFocusStatusCenter* center = [INFocusStatusCenter defaultCenter];
    if (center.authorizationStatus != INFocusStatusAuthorizationStatusAuthorized) {
      return NS_OK;
    }
    NSNumber* focused = center.focusStatus.isFocused;
    if (focused) {
      if (focused.boolValue) {
        aStatus.AssignLiteral("focused");
      } else {
        aStatus.AssignLiteral("notFocused");
      }
    }
  }
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyFocus::RequestAuthorization() {
  MOZ_ASSERT(NS_IsMainThread());

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  if (HasCommunicationEntitlement()) {
    if (@available(macOS 12.0, *)) {
      INFocusStatusCenter* center = [INFocusStatusCenter defaultCenter];
      if (center.authorizationStatus == INFocusStatusAuthorizationStatusNotDetermined) {
        // Called on an arbitrary queue.
        [center requestAuthorizationWithCompletionHandler:^(INFocusStatusAuthorizationStatus aStatus) {
          Notify(u"system");
        }];
        return NS_OK;
      }
    }
  }
  Notify(u"system");
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyFocus::StartWatching(const nsAString& aDirectory) {
  MOZ_ASSERT(NS_IsMainThread());
  if (aDirectory.IsEmpty()) {
    return NS_ERROR_INVALID_ARG;
  }

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  StopWatching();

  // FSEvents reports real paths; resolve symlinks (/var -> /private/var)
  // so a watch through one still matches. A missing directory is watched
  // as given (FSEvents waits for it).
  NS_ConvertUTF16toUTF8 given(aDirectory);
  char resolved[PATH_MAX];
  const char* real = realpath(given.get(), resolved) ? resolved : given.get();
  CFStringRef path = CFStringCreateWithCString(kCFAllocatorDefault, real, kCFStringEncodingUTF8);
  if (!path) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  const void* values[] = {path};
  CFArrayRef paths = CFArrayCreate(kCFAllocatorDefault, values, 1, &kCFTypeArrayCallBacks);
  CFRelease(path);
  if (!paths) {
    return NS_ERROR_OUT_OF_MEMORY;
  }

  FSEventStreamContext context = {0, nullptr, nullptr, nullptr, nullptr};
  // File-level events: Focus may rewrite Assertions.json in place.
  FSEventStreamRef stream =
      FSEventStreamCreate(kCFAllocatorDefault, &StreamCallback, &context, paths,
                          kFSEventStreamEventIdSinceNow, 0.5, kFSEventStreamCreateFlagFileEvents);
  CFRelease(paths);
  if (!stream) {
    return NS_ERROR_FAILURE;
  }
  FSEventStreamSetDispatchQueue(stream, Queue());
  if (!FSEventStreamStart(stream)) {
    FSEventStreamInvalidate(stream);
    FSEventStreamRelease(stream);
    return NS_ERROR_FAILURE;
  }
  mStream = stream;
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyFocus::StopWatching() {
  if (!mStream) {
    return NS_OK;
  }
  FSEventStreamRef stream = static_cast<FSEventStreamRef>(mStream);
  mStream = nullptr;
  FSEventStreamStop(stream);
  FSEventStreamInvalidate(stream);
  FSEventStreamRelease(stream);
  return NS_OK;
}

NS_IMETHODIMP
nsWhimsyFocus::GetWatching(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = !!mStream;
  return NS_OK;
}

}  // namespace whimsy
