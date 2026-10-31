/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy's Cast to AirPlay. Gecko decodes video itself, so a page's <video>
// can't be routed to AirPlay the way Safari's can. Instead the video's
// address plays in an AVPlayer that allows external playback; AVKit's route
// picker (AVRoutePickerView, the same menu as Safari's AirPlay button) lets
// the person pick a receiver, and the Apple TV loads the address itself.
// Playback only starts once external playback is active, so nothing plays
// out of the Mac's speakers. Everything here runs on the main thread (KVO
// and notifications are bounced to the main queue, which Gecko's Cocoa
// event loop drains).

#import <AVFoundation/AVFoundation.h>
#import <AVKit/AVKit.h>
#import <Cocoa/Cocoa.h>
#import <CoreMedia/CoreMedia.h>

#include <cmath>

#include "nsWhimsyAirPlay.h"

#include "mozilla/ClearOnShutdown.h"
#include "mozilla/StaticPtr.h"
#include "nsCOMPtr.h"
#include "nsObjCExceptions.h"
#include "nsString.h"
#include "nsThreadUtils.h"

namespace whimsy {
void OnPlayerChanged(NSString* aKeyPath);
void OnPlayerEnded();
void OnPickerClosed();
}  // namespace whimsy

@interface WhimsyAirPlayObserver : NSObject <AVRoutePickerViewDelegate>
@end

@implementation WhimsyAirPlayObserver

- (void)observeValueForKeyPath:(NSString*)aKeyPath
                      ofObject:(id)aObject
                        change:(NSDictionary*)aChange
                       context:(void*)aContext {
  NSString* keyPath = [aKeyPath copy];
  dispatch_async(dispatch_get_main_queue(), ^{
    whimsy::OnPlayerChanged(keyPath);
    [keyPath release];
  });
}

- (void)itemEnded:(NSNotification*)aNotification {
  dispatch_async(dispatch_get_main_queue(), ^{
    whimsy::OnPlayerEnded();
  });
}

- (void)routePickerViewDidEndPresentingRoutes:(AVRoutePickerView*)aView {
  dispatch_async(dispatch_get_main_queue(), ^{
    whimsy::OnPickerClosed();
  });
}

@end

namespace whimsy {

namespace {

using mozilla::StaticRefPtr;

// One session per process. All retained; main thread only.
AVPlayer* sPlayer = nil;
WhimsyAirPlayObserver* sObserver = nil;
NSPanel* sPickerPanel = nil;
bool sConnected = false;
// Bumped by every cast()/stop(), so late callbacks from an old session
// (the picker's close timer) are dropped.
uint32_t sGeneration = 0;
StaticRefPtr<nsIWhimsyAirPlayListener> sListener;

NSString* const kExternalKey = @"externalPlaybackActive";
NSString* const kStatusKey = @"timeControlStatus";
NSString* const kItemStatusKey = @"currentItem.status";

double CurrentSeconds() {
  if (!sPlayer) {
    return 0;
  }
  double seconds = CMTimeGetSeconds([sPlayer currentTime]);
  return std::isfinite(seconds) ? seconds : 0;
}

void Notify(const char* aState) {
  MOZ_ASSERT(NS_IsMainThread());
  nsCOMPtr<nsIWhimsyAirPlayListener> listener = sListener.get();
  if (listener) {
    listener->OnStateChange(nsDependentCString(aState), CurrentSeconds());
  }
}

void ClosePicker() {
  if (sPickerPanel) {
    [sPickerPanel orderOut:nil];
    [sPickerPanel release];
    sPickerPanel = nil;
  }
}

// Tears the session down without telling anyone.
void Teardown() {
  ClosePicker();
  if (sPlayer) {
    [sPlayer pause];
    @try {
      [sPlayer removeObserver:sObserver forKeyPath:kExternalKey];
      [sPlayer removeObserver:sObserver forKeyPath:kStatusKey];
      [sPlayer removeObserver:sObserver forKeyPath:kItemStatusKey];
    } @catch (NSException* e) {
      // Not observed (a failed setup); nothing to remove.
    }
    [[NSNotificationCenter defaultCenter] removeObserver:sObserver];
    [sPlayer replaceCurrentItemWithPlayerItem:nil];
    [sPlayer release];
    sPlayer = nil;
  }
  sConnected = false;
}

// Ends the session and tells the listener once, last.
void Finish(const char* aState) {
  double seconds = CurrentSeconds();
  nsCOMPtr<nsIWhimsyAirPlayListener> listener = sListener.get();
  sListener = nullptr;
  Teardown();
  sGeneration++;
  if (listener) {
    listener->OnStateChange(nsDependentCString(aState), seconds);
  }
}

NSButton* FindButton(NSView* aView) {
  for (NSView* child in [aView subviews]) {
    if ([child isKindOfClass:[NSButton class]]) {
      return (NSButton*)child;
    }
    if (NSButton* button = FindButton(child)) {
      return button;
    }
  }
  return nil;
}

// A small borderless panel at the screen point holds the route picker; its
// button is clicked so the AirPlay menu opens there, as under Safari's
// AirPlay button.
bool OpenPicker(double aScreenX, double aScreenY) {
  NSArray<NSScreen*>* screens = [NSScreen screens];
  if (![screens count]) {
    return false;
  }
  CGFloat mainHeight = NSMaxY([screens[0] frame]);
  const CGFloat size = 28;
  NSRect frame = NSMakeRect(aScreenX, mainHeight - aScreenY - size, size, size);

  sPickerPanel = [[NSPanel alloc]
      initWithContentRect:frame
                styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                  backing:NSBackingStoreBuffered
                    defer:NO];
  [sPickerPanel setReleasedWhenClosed:NO];
  [sPickerPanel setOpaque:NO];
  [sPickerPanel setBackgroundColor:[NSColor clearColor]];
  [sPickerPanel setHasShadow:NO];
  [sPickerPanel setLevel:NSPopUpMenuWindowLevel];

  AVRoutePickerView* picker =
      [[[AVRoutePickerView alloc] initWithFrame:NSMakeRect(0, 0, size, size)] autorelease];
  picker.player = sPlayer;
  picker.delegate = sObserver;
  picker.routePickerButtonBordered = NO;
  [sPickerPanel setContentView:picker];
  [sPickerPanel orderFrontRegardless];

  NSButton* button = FindButton(picker);
  if (!button) {
    return false;
  }
  [button performClick:nil];
  return true;
}

}  // namespace

void OnPlayerChanged(NSString* aKeyPath) {
  if (!sPlayer) {
    return;
  }
  if ([aKeyPath isEqualToString:kExternalKey]) {
    bool external = [sPlayer isExternalPlaybackActive];
    if (external && !sConnected) {
      sConnected = true;
      ClosePicker();
      [sPlayer play];
      Notify("connected");
    } else if (!external && sConnected) {
      Finish("disconnected");
    }
  } else if ([aKeyPath isEqualToString:kStatusKey]) {
    if (!sConnected) {
      return;
    }
    switch ([sPlayer timeControlStatus]) {
      case AVPlayerTimeControlStatusPlaying:
        Notify("playing");
        break;
      case AVPlayerTimeControlStatusPaused:
        Notify("paused");
        break;
      default:
        break;
    }
  } else if ([aKeyPath isEqualToString:kItemStatusKey]) {
    if ([[sPlayer currentItem] status] == AVPlayerItemStatusFailed) {
      Finish("failed");
    }
  }
}

void OnPlayerEnded() {
  if (sPlayer && sConnected) {
    Notify("ended");
  }
}

// The menu closed. Picking a receiver turns external playback on a moment
// later, so wait a few seconds before calling it cancelled.
void OnPickerClosed() {
  if (!sPlayer || sConnected) {
    return;
  }
  uint32_t generation = sGeneration;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   if (generation == sGeneration && sPlayer && !sConnected) {
                     Finish("cancelled");
                   }
                 });
}

NS_IMPL_ISUPPORTS(nsWhimsyAirPlay, nsIWhimsyAirPlay)

NS_IMETHODIMP
nsWhimsyAirPlay::Cast(const nsACString& aURL, double aStartTime, double aScreenX,
                      double aScreenY, nsIWhimsyAirPlayListener* aListener) {
  NS_ENSURE_ARG_POINTER(aListener);
  MOZ_ASSERT(NS_IsMainThread());

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  NSString* address = [NSString stringWithUTF8String:PromiseFlatCString(aURL).get()];
  NSURL* url = address ? [NSURL URLWithString:address] : nil;
  NSString* scheme = [[url scheme] lowercaseString];
  if (!url || !([scheme isEqualToString:@"https"] || [scheme isEqualToString:@"http"])) {
    return NS_ERROR_INVALID_ARG;
  }

  if (sPlayer) {
    Finish("disconnected");
  }
  static bool sClearRegistered = false;
  if (!sClearRegistered) {
    sClearRegistered = true;
    mozilla::ClearOnShutdown(&sListener);
  }
  sGeneration++;
  sListener = aListener;
  if (!sObserver) {
    sObserver = [[WhimsyAirPlayObserver alloc] init];
  }

  sPlayer = [[AVPlayer alloc] initWithURL:url];
  sPlayer.allowsExternalPlayback = YES;
  sPlayer.usesExternalPlaybackWhileExternalScreenIsActive = YES;
  if (std::isfinite(aStartTime) && aStartTime > 0) {
    [sPlayer seekToTime:CMTimeMakeWithSeconds(aStartTime, 600)];
  }
  NSKeyValueObservingOptions options = NSKeyValueObservingOptionNew;
  [sPlayer addObserver:sObserver forKeyPath:kExternalKey options:options context:nullptr];
  [sPlayer addObserver:sObserver forKeyPath:kStatusKey options:options context:nullptr];
  [sPlayer addObserver:sObserver forKeyPath:kItemStatusKey options:options context:nullptr];
  [[NSNotificationCenter defaultCenter] addObserver:sObserver
                                           selector:@selector(itemEnded:)
                                               name:AVPlayerItemDidPlayToEndTimeNotification
                                             object:[sPlayer currentItem]];

  // AVRoutePickerView is macOS 10.15+, below Gecko's deployment target.
  if (!OpenPicker(aScreenX, aScreenY)) {
    sListener = nullptr;
    Teardown();
    sGeneration++;
    return NS_ERROR_FAILURE;
  }
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyAirPlay::GetActive(bool* aActive) {
  *aActive = sPlayer && sConnected;
  return NS_OK;
}

NS_IMETHODIMP
nsWhimsyAirPlay::GetCurrentTime(double* aTime) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  *aTime = CurrentSeconds();
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyAirPlay::Pause() {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  if (sPlayer && sConnected) {
    [sPlayer pause];
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyAirPlay::Resume() {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  if (sPlayer && sConnected) {
    [sPlayer play];
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyAirPlay::Seek(double aSeconds) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  if (sPlayer && std::isfinite(aSeconds)) {
    [sPlayer seekToTime:CMTimeMakeWithSeconds(std::fmax(0, aSeconds), 600)];
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyAirPlay::Stop() {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  if (sPlayer) {
    Finish("disconnected");
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

}  // namespace whimsy
