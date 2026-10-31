/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy's Share submenu services. Firefox's own Share ▸ (SharingUtils) ends
// in "Share…", which closes the menu and opens macOS's picker as a second
// menu. Arc and Safari list the services in the submenu itself; this gives
// the front end (WhimsyShareMenu.sys.mjs) that list, and runs the one the
// person picks. Firefox did the same before it moved to the picker (its old
// nsMacSharingService.mm): NSSharingService's list for the items, minus a
// few duplicates, and -performWithItems: on the chosen one. Main thread only.

#import <AppKit/AppKit.h>
#import <Cocoa/Cocoa.h>

#include "nsWhimsyShare.h"

#include "nsObjCExceptions.h"
#include "nsString.h"
#include "nsTArray.h"

// The service's stable identifier (e.g. com.apple.share.AirDrop.send); a
// method AppKit has but doesn't declare. Firefox used it the same way.
@interface NSSharingService (WhimsyName)
- (id)name;
@end

namespace {

// Services that duplicate one Whimsy already has, or that don't work for a
// browser's links.
NSArray<NSString*>* IgnoredServices() {
  return @[
    @"com.apple.share.System.add-to-safari-reading-list",
    @"com.apple.share.CopyLink",
  ];
}

NSString* ToNS(const nsACString& aValue) {
  NSString* string = [[[NSString alloc] initWithBytes:aValue.BeginReading()
                                               length:aValue.Length()
                                             encoding:NSUTF8StringEncoding] autorelease];
  return string ?: @"";
}

nsCString FromNS(NSString* aValue) {
  return nsCString(aValue ? [aValue UTF8String] : "");
}

// The links as NSURLs (anything that doesn't parse is left out).
NSArray* ItemsFor(const nsTArray<nsCString>& aUrls) {
  NSMutableArray* items = [NSMutableArray arrayWithCapacity:aUrls.Length()];
  for (const nsCString& url : aUrls) {
    NSURL* nsurl = [NSURL URLWithString:ToNS(url)];
    if (nsurl) {
      [items addObject:nsurl];
    }
  }
  return items;
}

NSString* NameOf(NSSharingService* aService) {
  if (![aService respondsToSelector:@selector(name)]) {
    return nil;
  }
  id name = [aService name];
  return [name isKindOfClass:[NSString class]] ? (NSString*)name : nil;
}

NSArray<NSSharingService*>* ServicesFor(NSArray* aItems) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  return [NSSharingService sharingServicesForItems:aItems];
#pragma clang diagnostic pop
}

// The service's icon as a 32px PNG data: URI (shown at 16pt, so sharp on
// Retina), or "" when it has none.
nsCString IconFor(NSSharingService* aService) {
  NSImage* image = [aService image];
  if (!image) {
    return ""_ns;
  }
  NSRect rect = NSMakeRect(0, 0, 32, 32);
  CGImageRef cgImage = [image CGImageForProposedRect:&rect context:nil hints:nil];
  if (!cgImage) {
    return ""_ns;
  }
  NSBitmapImageRep* rep = [[[NSBitmapImageRep alloc] initWithCGImage:cgImage] autorelease];
  NSData* png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  if (!png) {
    return ""_ns;
  }
  nsCString uri("data:image/png;base64,"_ns);
  uri.Append(FromNS([png base64EncodedStringWithOptions:0]));
  return uri;
}

}  // namespace

namespace whimsy {

NS_IMPL_ISUPPORTS(nsWhimsyShare, nsIWhimsyShare)

NS_IMETHODIMP
nsWhimsyShare::GetServices(const nsTArray<nsCString>& aUrls, nsTArray<nsCString>& aNames,
                           nsTArray<nsCString>& aTitles, nsTArray<nsCString>& aIcons) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  aNames.Clear();
  aTitles.Clear();
  aIcons.Clear();
  @autoreleasepool {
    NSArray* items = ItemsFor(aUrls);
    if (![items count]) {
      return NS_OK;
    }
    NSArray<NSString*>* ignored = IgnoredServices();
    for (NSSharingService* service in ServicesFor(items)) {
      NSString* name = NameOf(service);
      NSString* title = [service title];
      if (!name || ![title length] || [ignored containsObject:name]) {
        continue;
      }
      aNames.AppendElement(FromNS(name));
      aTitles.AppendElement(FromNS(title));
      aIcons.AppendElement(IconFor(service));
    }
  }
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyShare::Share(const nsACString& aName, const nsTArray<nsCString>& aUrls,
                     const nsACString& aSubject, bool* aResult) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  *aResult = false;
  @autoreleasepool {
    NSArray* items = ItemsFor(aUrls);
    NSString* wanted = ToNS(aName);
    if (![items count] || ![wanted length]) {
      return NS_OK;
    }
    // The same list getServices returned, so only a service macOS offers
    // for these links can run.
    NSSharingService* chosen = nil;
    for (NSSharingService* service in ServicesFor(items)) {
      if ([NameOf(service) isEqualToString:wanted]) {
        chosen = service;
        break;
      }
    }
    if (!chosen || ![chosen canPerformWithItems:items]) {
      return NS_OK;
    }
    if (!aSubject.IsEmpty()) {
      [chosen setSubject:ToNS(aSubject)];
    }
    [chosen performWithItems:items];
    *aResult = true;
  }
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

}  // namespace whimsy
