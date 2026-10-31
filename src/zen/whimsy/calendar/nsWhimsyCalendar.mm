/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy's "Next meeting": reads macOS Calendar through EventKit. Cmd+K's
// "Add to Calendar" (WhimsyVerbs) adds one event. Nothing here asks for
// access by itself; the front end calls requestAccess() only when the
// person turns on Apple Calendar, and requestWriteAccess() only when they
// pick "Add to Calendar" (never at startup).

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

// Full access (3) also lets the app add events; write-only (4) only that.
bool CanWrite() {
  NSInteger status = RawStatus();
  return status == 3 || status == 4;
}

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

// The same for adding events: macOS 14 asks with the write-only string.
bool HasWriteUsageDescription() {
  NSDictionary* info = [[NSBundle mainBundle] infoDictionary];
  NSString* key = @"NSCalendarsUsageDescription";
  if (@available(macOS 14.0, *)) {
    key = @"NSCalendarsWriteOnlyAccessUsageDescription";
  }
  id value = info[key];
  return [value isKindOfClass:[NSString class]] && [(NSString*)value length] > 0;
}

// The event addEvent() was handed, checked. Main thread.
struct NewEvent {
  NSString* title = nil;  // autoreleased
  NSDate* start = nil;
  NSDate* end = nil;
  BOOL allDay = NO;
  NSString* notes = nil;
  NSString* location = nil;
  NSURL* url = nil;
};

NSString* StringField(NSDictionary* aObject, NSString* aKey, NSUInteger aMax) {
  id value = aObject[aKey];
  if (![value isKindOfClass:[NSString class]]) {
    return nil;
  }
  NSString* text = (NSString*)value;
  if (!text.length) {
    return nil;
  }
  return text.length > aMax ? [text substringToIndex:aMax] : text;
}

NSDate* DateField(NSDictionary* aObject, NSString* aKey) {
  id value = aObject[aKey];
  if (![value isKindOfClass:[NSNumber class]]) {
    return nil;
  }
  double ms = [(NSNumber*)value doubleValue];
  if (!std::isfinite(ms)) {
    return nil;
  }
  return [NSDate dateWithTimeIntervalSince1970:ms / 1000.0];
}

bool ParseNewEvent(const nsACString& aJSON, NewEvent& aEvent) {
  NSData* data = [NSData dataWithBytes:aJSON.BeginReading() length:aJSON.Length()];
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![parsed isKindOfClass:[NSDictionary class]]) {
    return false;
  }
  NSDictionary* object = (NSDictionary*)parsed;
  aEvent.start = DateField(object, @"start");
  aEvent.end = DateField(object, @"end");
  if (!aEvent.start || !aEvent.end || [aEvent.end compare:aEvent.start] == NSOrderedAscending) {
    return false;
  }
  aEvent.title = StringField(object, @"title", 500) ?: @"";
  id allDay = object[@"allDay"];
  aEvent.allDay = [allDay isKindOfClass:[NSNumber class]] && [(NSNumber*)allDay boolValue];
  aEvent.notes = StringField(object, @"notes", 8000);
  aEvent.location = StringField(object, @"location", 500);
  NSString* url = StringField(object, @"url", 4000);
  if (url) {
    NSURL* parsedURL = [NSURL URLWithString:url];
    NSString* scheme = parsedURL.scheme.lowercaseString;
    if ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]) {
      aEvent.url = parsedURL;
    }
  }
  return true;
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

// Asks for write-only access (macOS 14+) or the one calendar permission
// (before 14); answers on the main thread with the status afterwards.
void AskForWriteAccess(const CallbackHandle& aCallback) {
  // A local copy: the block copies it (a reference would dangle).
  CallbackHandle callback = aCallback;
  // Called on an arbitrary queue.
  EKEventStoreRequestAccessCompletionHandler handler = ^(BOOL granted, NSError* error) {
    bool ok = granted;
    NS_DispatchToMainThread(
        NS_NewRunnableFunction("WhimsyCalendar::WriteAccessAnswered", [callback, ok]() {
          MOZ_ASSERT(NS_IsMainThread());
          ResetStore();
          nsAutoCString status;
          StatusName(RawStatus(), status);
          callback->OnComplete(ok && CanWrite(), status);
        }));
  };

  if (@available(macOS 14.0, *)) {
    [Store() requestWriteOnlyAccessToEventsWithCompletion:handler];
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [Store() requestAccessToEntityType:EKEntityTypeEvent completion:handler];
#pragma clang diagnostic pop
  }
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

NS_IMETHODIMP
nsWhimsyCalendar::RequestWriteAccess(nsIWhimsyCalendarCallback* aCallback) {
  NS_ENSURE_ARG_POINTER(aCallback);
  MOZ_ASSERT(NS_IsMainThread());

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  CallbackHandle callback(new nsMainThreadPtrHolder<nsIWhimsyCalendarCallback>(
      "WhimsyCalendar::RequestWriteAccess", aCallback));

  // Already allowed (full or write-only access): no prompt.
  if (CanWrite()) {
    nsAutoCString status;
    StatusName(RawStatus(), status);
    Answer(callback, true, status);
    return NS_OK;
  }

  if (!HasWriteUsageDescription()) {
    Answer(callback, false, "missing-usage-description"_ns);
    return NS_OK;
  }

  AskForWriteAccess(callback);
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyCalendar::AddEvent(const nsACString& aEventJSON, nsIWhimsyCalendarCallback* aCallback) {
  NS_ENSURE_ARG_POINTER(aCallback);
  MOZ_ASSERT(NS_IsMainThread());

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  CallbackHandle callback(
      new nsMainThreadPtrHolder<nsIWhimsyCalendarCallback>("WhimsyCalendar::AddEvent", aCallback));

  NewEvent parsed;
  if (!ParseNewEvent(aEventJSON, parsed)) {
    Answer(callback, false, "invalid-event"_ns);
    return NS_OK;
  }

  if (!CanWrite()) {
    Answer(callback, false, "not-authorized"_ns);
    return NS_OK;
  }

  EKEventStore* store = Store();
  EKCalendar* calendar = store.defaultCalendarForNewEvents;
  if (!calendar) {
    Answer(callback, false, "no-calendar"_ns);
    return NS_OK;
  }

  EKEvent* event = [EKEvent eventWithEventStore:store];
  event.calendar = calendar;
  event.title = parsed.title;
  event.allDay = parsed.allDay;
  event.startDate = parsed.start;
  NSDate* end = parsed.end;
  if (parsed.allDay) {
    // iCalendar's all-day end is the next day; EventKit's is the last day
    // itself (an end at the next midnight adds a day in Calendar).
    NSDate* lastSecond = [end dateByAddingTimeInterval:-1.0];
    end = [lastSecond compare:parsed.start] == NSOrderedAscending ? parsed.start : lastSecond;
  }
  event.endDate = end;
  if (parsed.notes) {
    event.notes = parsed.notes;
  }
  if (parsed.location) {
    event.location = parsed.location;
  }
  if (parsed.url) {
    event.URL = parsed.url;
  }

  // Saving a single local event is quick; Calendar syncs it afterwards.
  NSError* error = nil;
  BOOL saved = [store saveEvent:event span:EKSpanThisEvent commit:YES error:&error];
  if (!saved) {
    Answer(callback, false, "save-failed"_ns);
    return NS_OK;
  }
  nsAutoCString identifier;
  const char* utf8 = event.eventIdentifier ? [event.eventIdentifier UTF8String] : nullptr;
  if (utf8) {
    identifier.Assign(utf8);
  }
  Answer(callback, true, identifier);
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

}  // namespace whimsy
