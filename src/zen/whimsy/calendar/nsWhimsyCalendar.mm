/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy's "Next meeting": reads macOS Calendar through EventKit. Nothing
// here asks for access by itself; the front end calls requestAccess() only
// when the person turns on Apple Calendar (never at startup).

#import <Cocoa/Cocoa.h>
#import <EventKit/EventKit.h>

#include <algorithm>
#include <cmath>

#include "nsWhimsyCalendar.h"

#include "nsObjCExceptions.h"
#include "nsProxyRelease.h"
#include "nsString.h"
#include "nsThreadUtils.h"

namespace whimsy {

namespace {

using CallbackHandle = nsMainThreadPtrHandle<nsIWhimsyCalendarCallback>;

// Main thread only. Retained; replaced once access is granted, since a store
// made before that can't see any events.
EKEventStore* sStore = nil;

EKEventStore* Store() {
  if (!sStore) {
    sStore = [[EKEventStore alloc] init];
  }
  return sStore;
}

void ResetStore() {
  [sStore release];
  sStore = nil;
}

// The raw values, so this builds against the macOS 11 deployment target
// without availability warnings: 3 is "full access" on macOS 14 and the
// old "authorized" before it.
NSInteger RawStatus() {
  return (NSInteger)[EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
}

void StatusName(NSInteger aStatus, nsACString& aName) {
  switch (aStatus) {
    case 0:
      aName.AssignLiteral("notDetermined");
      break;
    case 1:
      aName.AssignLiteral("restricted");
      break;
    case 2:
      aName.AssignLiteral("denied");
      break;
    case 3:
      aName.AssignLiteral("fullAccess");
      break;
    case 4:
      aName.AssignLiteral("writeOnly");
      break;
    default:
      aName.AssignLiteral("unknown");
      break;
  }
}

bool HasFullAccess() { return RawStatus() == 3; }

// macOS ends an app that asks for calendar access without these strings in
// its Info.plist, so a build missing them (an old bundle, a test harness)
// answers with an error instead.
bool HasUsageDescription() {
  NSDictionary* info = [[NSBundle mainBundle] infoDictionary];
  NSString* key = @"NSCalendarsUsageDescription";
  if (@available(macOS 14.0, *)) {
    key = @"NSCalendarsFullAccessUsageDescription";
  }
  id value = info[key];
  return [value isKindOfClass:[NSString class]] && [(NSString*)value length] > 0;
}

void Answer(const CallbackHandle& aCallback, bool aSuccess, const nsACString& aResult) {
  nsCString result(aResult);
  NS_DispatchToMainThread(NS_NewRunnableFunction(
      "WhimsyCalendar::Answer", [aCallback, aSuccess, result]() {
        MOZ_ASSERT(NS_IsMainThread());
        aCallback->OnComplete(aSuccess, result);
      }));
}

NSString* HexColor(NSColor* aColor) {
  NSColor* color = [aColor colorUsingColorSpace:[NSColorSpace sRGBColorSpace]];
  if (!color) {
    return nil;
  }
  auto channel = [](CGFloat aValue) {
    return (int)std::lround(std::fmin(1.0, std::fmax(0.0, (double)aValue)) * 255.0);
  };
  return [NSString stringWithFormat:@"#%02X%02X%02X", channel(color.redComponent),
                                    channel(color.greenComponent), channel(color.blueComponent)];
}

NSNumber* Millis(NSDate* aDate) {
  return @(std::floor(aDate.timeIntervalSince1970 * 1000.0));
}

// Runs off the main thread (eventsMatchingPredicate is synchronous).
NSString* EventsJSON(EKEventStore* aStore, NSUInteger aHours) {
  NSDate* now = [NSDate date];
  NSDate* from = [now dateByAddingTimeInterval:-12.0 * 3600.0];
  NSDate* to = [now dateByAddingTimeInterval:(NSTimeInterval)aHours * 3600.0];
  NSPredicate* predicate = [aStore predicateForEventsWithStartDate:from endDate:to calendars:nil];
  NSArray<EKEvent*>* events = [aStore eventsMatchingPredicate:predicate];

  NSMutableArray* out = [NSMutableArray arrayWithCapacity:events.count];
  for (EKEvent* event in events) {
    NSDate* start = event.startDate;
    NSDate* end = event.endDate;
    if (!start || !end || [end compare:now] != NSOrderedDescending) {
      continue;
    }
    NSMutableDictionary* item = [NSMutableDictionary dictionary];
    // Occurrences of a repeating event share one identifier.
    item[@"id"] = [NSString stringWithFormat:@"%@@%.0f", event.eventIdentifier ?: @"",
                                             start.timeIntervalSince1970];
    item[@"title"] = event.title ?: @"";
    item[@"start"] = Millis(start);
    item[@"end"] = Millis(end);
    item[@"allDay"] = @(event.allDay ? YES : NO);
    NSString* location = event.location;
    if (location.length) {
      item[@"location"] = location;
    }
    NSString* notes = event.notes;
    if (notes.length) {
      item[@"notes"] = notes.length > 8000 ? [notes substringToIndex:8000] : notes;
    }
    NSString* url = event.URL.absoluteString;
    if (url.length) {
      item[@"url"] = url;
    }
    item[@"cancelled"] = @(event.status == EKEventStatusCanceled ? YES : NO);
    BOOL declined = NO;
    for (EKParticipant* attendee in event.attendees) {
      if ([attendee isCurrentUser]) {
        declined = attendee.participantStatus == EKParticipantStatusDeclined;
        break;
      }
    }
    item[@"declined"] = @(declined);
    EKCalendar* calendar = event.calendar;
    if (calendar) {
      item[@"calendar"] = calendar.title ?: @"";
      item[@"calendarId"] = calendar.calendarIdentifier ?: @"";
      NSString* account = calendar.source.title;
      if (account.length) {
        item[@"account"] = account;
      }
      NSString* color = calendar.color ? HexColor(calendar.color) : nil;
      if (color) {
        item[@"color"] = color;
      }
    }
    [out addObject:item];
  }

  NSData* data = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
  if (!data) {
    return nil;
  }
  return [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
}

}  // namespace

NS_IMPL_ISUPPORTS(nsWhimsyCalendar, nsIWhimsyCalendar)

NS_IMETHODIMP
nsWhimsyCalendar::GetAuthorizationStatus(nsACString& aStatus) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  StatusName(RawStatus(), aStatus);
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyCalendar::RequestAccess(nsIWhimsyCalendarCallback* aCallback) {
  NS_ENSURE_ARG_POINTER(aCallback);
  MOZ_ASSERT(NS_IsMainThread());

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  CallbackHandle callback(
      new nsMainThreadPtrHolder<nsIWhimsyCalendarCallback>("WhimsyCalendar::RequestAccess",
                                                           aCallback));

  if (!HasUsageDescription()) {
    Answer(callback, false, "missing-usage-description"_ns);
    return NS_OK;
  }

  // Called on an arbitrary queue.
  EKEventStoreRequestAccessCompletionHandler handler = ^(BOOL granted, NSError* error) {
    bool ok = granted;
    NS_DispatchToMainThread(
        NS_NewRunnableFunction("WhimsyCalendar::AccessAnswered", [callback, ok]() {
          MOZ_ASSERT(NS_IsMainThread());
          ResetStore();
          nsAutoCString status;
          StatusName(RawStatus(), status);
          callback->OnComplete(ok, status);
        }));
  };

  if (@available(macOS 14.0, *)) {
    [Store() requestFullAccessToEventsWithCompletion:handler];
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [Store() requestAccessToEntityType:EKEntityTypeEvent completion:handler];
#pragma clang diagnostic pop
  }
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyCalendar::UpcomingEvents(uint32_t aHours, nsIWhimsyCalendarCallback* aCallback) {
  NS_ENSURE_ARG_POINTER(aCallback);
  MOZ_ASSERT(NS_IsMainThread());

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  CallbackHandle callback(
      new nsMainThreadPtrHolder<nsIWhimsyCalendarCallback>("WhimsyCalendar::UpcomingEvents",
                                                           aCallback));

  if (!HasFullAccess()) {
    Answer(callback, false, "not-authorized"_ns);
    return NS_OK;
  }

  // At most two weeks ahead; the store stays alive until the read is done.
  NSUInteger hours = std::min<uint32_t>(std::max<uint32_t>(aHours, 1), 336);
  EKEventStore* store = [Store() retain];

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    nsAutoCString json;
    bool ok = false;
    @autoreleasepool {
      @try {
        NSString* result = EventsJSON(store, hours);
        const char* utf8 = result ? [result UTF8String] : nullptr;
        if (utf8) {
          json.Assign(utf8);
          ok = true;
        }
      } @catch (NSException* e) {
        ok = false;
      }
    }
    [store release];
    if (ok) {
      Answer(callback, true, json);
    } else {
      Answer(callback, false, "read-failed"_ns);
    }
  });
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

}  // namespace whimsy
