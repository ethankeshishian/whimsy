/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29 "Open Mini Whimsy from any app": one system-wide shortcut. A Carbon
// hot key (RegisterEventHotKey) is still the only way to get a key press
// while another app is in front without asking for Accessibility access;
// Cocoa's global event monitors need it. Registered with
// kEventHotKeyExclusive, so a key another app already holds comes back as
// eventHotKeyExistsErr ("taken") instead of both apps firing.
//
// The state is per process (there is one shortcut), so it lives in this
// file's statics and every instance of the component shares it.

#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>

#include "nsWhimsyGlobalHotKey.h"

#include "mozilla/Services.h"
#include "nsCOMPtr.h"
#include "nsIObserverService.h"
#include "nsObjCExceptions.h"
#include "nsString.h"
#include "nsThreadUtils.h"

namespace whimsy {

namespace {

constexpr uint32_t kMaskCmd = 1;
constexpr uint32_t kMaskShift = 2;
constexpr uint32_t kMaskOption = 4;
constexpr uint32_t kMaskControl = 8;

// 'Whmy'
constexpr OSType kSignature = 0x57686d79;

EventHotKeyRef sHotKey = nullptr;
UInt32 sKeyCode = 0;
UInt32 sModifiers = 0;
EventHandlerRef sHandler = nullptr;
// Retained: the app activate() found in front, when it wasn't Whimsy.
NSRunningApplication* sPreviousApp = nil;

struct CodeEntry {
  const char* mCode;
  UInt32 mKeyCode;
};

// KeyboardEvent.code to macOS's virtual key codes (Events.h, kVK_*). These
// name physical keys, so they hold on every keyboard layout.
const CodeEntry kCodes[] = {
    {"KeyA", kVK_ANSI_A},
    {"KeyB", kVK_ANSI_B},
    {"KeyC", kVK_ANSI_C},
    {"KeyD", kVK_ANSI_D},
    {"KeyE", kVK_ANSI_E},
    {"KeyF", kVK_ANSI_F},
    {"KeyG", kVK_ANSI_G},
    {"KeyH", kVK_ANSI_H},
    {"KeyI", kVK_ANSI_I},
    {"KeyJ", kVK_ANSI_J},
    {"KeyK", kVK_ANSI_K},
    {"KeyL", kVK_ANSI_L},
    {"KeyM", kVK_ANSI_M},
    {"KeyN", kVK_ANSI_N},
    {"KeyO", kVK_ANSI_O},
    {"KeyP", kVK_ANSI_P},
    {"KeyQ", kVK_ANSI_Q},
    {"KeyR", kVK_ANSI_R},
    {"KeyS", kVK_ANSI_S},
    {"KeyT", kVK_ANSI_T},
    {"KeyU", kVK_ANSI_U},
    {"KeyV", kVK_ANSI_V},
    {"KeyW", kVK_ANSI_W},
    {"KeyX", kVK_ANSI_X},
    {"KeyY", kVK_ANSI_Y},
    {"KeyZ", kVK_ANSI_Z},
    {"Digit0", kVK_ANSI_0},
    {"Digit1", kVK_ANSI_1},
    {"Digit2", kVK_ANSI_2},
    {"Digit3", kVK_ANSI_3},
    {"Digit4", kVK_ANSI_4},
    {"Digit5", kVK_ANSI_5},
    {"Digit6", kVK_ANSI_6},
    {"Digit7", kVK_ANSI_7},
    {"Digit8", kVK_ANSI_8},
    {"Digit9", kVK_ANSI_9},
    {"Space", kVK_Space},
    {"Enter", kVK_Return},
    {"Tab", kVK_Tab},
    {"Backquote", kVK_ANSI_Grave},
    {"Minus", kVK_ANSI_Minus},
    {"Equal", kVK_ANSI_Equal},
    {"BracketLeft", kVK_ANSI_LeftBracket},
    {"BracketRight", kVK_ANSI_RightBracket},
    {"Backslash", kVK_ANSI_Backslash},
    {"Semicolon", kVK_ANSI_Semicolon},
    {"Quote", kVK_ANSI_Quote},
    {"Comma", kVK_ANSI_Comma},
    {"Period", kVK_ANSI_Period},
    {"Slash", kVK_ANSI_Slash},
    {"ArrowLeft", kVK_LeftArrow},
    {"ArrowRight", kVK_RightArrow},
    {"ArrowUp", kVK_UpArrow},
    {"ArrowDown", kVK_DownArrow},
    {"F1", kVK_F1},
    {"F2", kVK_F2},
    {"F3", kVK_F3},
    {"F4", kVK_F4},
    {"F5", kVK_F5},
    {"F6", kVK_F6},
    {"F7", kVK_F7},
    {"F8", kVK_F8},
    {"F9", kVK_F9},
    {"F10", kVK_F10},
    {"F11", kVK_F11},
    {"F12", kVK_F12},
    {"F13", kVK_F13},
    {"F14", kVK_F14},
    {"F15", kVK_F15},
    {"F16", kVK_F16},
    {"F17", kVK_F17},
    {"F18", kVK_F18},
    {"F19", kVK_F19},
    {"F20", kVK_F20},
};

bool KeyCodeFor(const nsACString& aCode, UInt32* aKeyCode) {
  for (const CodeEntry& entry : kCodes) {
    if (aCode.EqualsASCII(entry.mCode)) {
      *aKeyCode = entry.mKeyCode;
      return true;
    }
  }
  return false;
}

const char* CodeFor(UInt32 aKeyCode) {
  for (const CodeEntry& entry : kCodes) {
    if (entry.mKeyCode == aKeyCode) {
      return entry.mCode;
    }
  }
  return nullptr;
}

UInt32 CarbonModifiers(uint32_t aMask) {
  UInt32 mods = 0;
  if (aMask & kMaskCmd) mods |= cmdKey;
  if (aMask & kMaskShift) mods |= shiftKey;
  if (aMask & kMaskOption) mods |= optionKey;
  if (aMask & kMaskControl) mods |= controlKey;
  return mods;
}

// com.apple.symbolichotkeys stores NSEvent modifier flags.
uint32_t MaskFromEventFlags(NSUInteger aFlags) {
  uint32_t mask = 0;
  if (aFlags & NSEventModifierFlagCommand) mask |= kMaskCmd;
  if (aFlags & NSEventModifierFlagShift) mask |= kMaskShift;
  if (aFlags & NSEventModifierFlagOption) mask |= kMaskOption;
  if (aFlags & NSEventModifierFlagControl) mask |= kMaskControl;
  return mask;
}

OSStatus OnHotKey(EventHandlerCallRef, EventRef aEvent, void*) {
  EventHotKeyID id;
  if (GetEventParameter(aEvent, kEventParamDirectObject, typeEventHotKeyID,
                        nullptr, sizeof(id), nullptr, &id) != noErr ||
      id.signature != kSignature) {
    return eventNotHandledErr;
  }
  // Carbon calls this on the main thread from inside event dispatch; tell
  // observers from a fresh runnable, outside it.
  NS_DispatchToMainThread(NS_NewRunnableFunction("WhimsyGlobalHotKey", [] {
    if (nsCOMPtr<nsIObserverService> obs =
            mozilla::services::GetObserverService()) {
      obs->NotifyObservers(nullptr, "whimsy-global-hotkey", nullptr);
    }
  }));
  return noErr;
}

bool EnsureHandler() {
  if (sHandler) {
    return true;
  }
  EventTypeSpec spec = {kEventClassKeyboard, kEventHotKeyPressed};
  return InstallApplicationEventHandler(NewEventHandlerUPP(OnHotKey), 1,
                                        &spec, nullptr, &sHandler) == noErr;
}

}  // namespace

NS_IMPL_ISUPPORTS(nsWhimsyGlobalHotKey, nsIWhimsyGlobalHotKey)

nsWhimsyGlobalHotKey::~nsWhimsyGlobalHotKey() = default;

NS_IMETHODIMP
nsWhimsyGlobalHotKey::Register(const nsACString& aCode, uint32_t aModifiers,
                               nsACString& aResult) {
  MOZ_ASSERT(NS_IsMainThread());
  UInt32 keyCode;
  if (!KeyCodeFor(aCode, &keyCode)) {
    aResult.AssignLiteral("invalid");
    return NS_OK;
  }
  UInt32 modifiers = CarbonModifiers(aModifiers);
  if (sHotKey && sKeyCode == keyCode && sModifiers == modifiers) {
    aResult.AssignLiteral("ok");
    return NS_OK;
  }
  if (!EnsureHandler()) {
    aResult.AssignLiteral("failed");
    return NS_OK;
  }
  // Register the new key before letting go of the old one, so a refused
  // key leaves the old one working.
  EventHotKeyID id = {kSignature, 1};
  EventHotKeyRef ref = nullptr;
  OSStatus status = RegisterEventHotKey(
      keyCode, modifiers, id, GetApplicationEventTarget(),
      kEventHotKeyExclusive, &ref);
  if (status == eventHotKeyExistsErr) {
    aResult.AssignLiteral("taken");
    return NS_OK;
  }
  if (status != noErr || !ref) {
    aResult.AssignLiteral("failed");
    return NS_OK;
  }
  if (sHotKey) {
    UnregisterEventHotKey(sHotKey);
  }
  sHotKey = ref;
  sKeyCode = keyCode;
  sModifiers = modifiers;
  aResult.AssignLiteral("ok");
  return NS_OK;
}

NS_IMETHODIMP
nsWhimsyGlobalHotKey::Unregister() {
  MOZ_ASSERT(NS_IsMainThread());
  if (sHotKey) {
    UnregisterEventHotKey(sHotKey);
    sHotKey = nullptr;
  }
  return NS_OK;
}

NS_IMETHODIMP
nsWhimsyGlobalHotKey::GetRegistered(bool* aRegistered) {
  *aRegistered = !!sHotKey;
  return NS_OK;
}

NS_IMETHODIMP
nsWhimsyGlobalHotKey::GetSystemHotKeys(nsACString& aJSON) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  aJSON.AssignLiteral("[");
  CFPropertyListRef raw = CFPreferencesCopyAppValue(
      CFSTR("AppleSymbolicHotKeys"), CFSTR("com.apple.symbolichotkeys"));
  NSDictionary* all = raw ? [(id)raw autorelease] : nil;
  bool first = true;
  if ([all isKindOfClass:[NSDictionary class]]) {
    for (id key in all) {
      NSDictionary* entry = all[key];
      if (![key respondsToSelector:@selector(intValue)] ||
          ![entry isKindOfClass:[NSDictionary class]]) {
        continue;
      }
      NSDictionary* value = entry[@"value"];
      NSArray* params =
          [value isKindOfClass:[NSDictionary class]] ? value[@"parameters"]
                                                     : nil;
      // { ascii, virtual key code, NSEvent modifier flags }
      if (![params isKindOfClass:[NSArray class]] || params.count < 3) {
        continue;
      }
      const char* code = CodeFor((UInt32)[params[1] unsignedIntValue]);
      if (!code) {
        continue;
      }
      bool enabled = [entry[@"enabled"] respondsToSelector:@selector(boolValue)]
                         ? [entry[@"enabled"] boolValue]
                         : true;
      if (!first) {
        aJSON.Append(',');
      }
      first = false;
      aJSON.AppendPrintf(
          "{\"id\":%d,\"code\":\"%s\",\"modifiers\":%u,\"enabled\":%s}",
          [key intValue], code,
          MaskFromEventFlags([params[2] unsignedIntegerValue]),
          enabled ? "true" : "false");
    }
  }
  aJSON.Append(']');
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyGlobalHotKey::Activate() {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  NSRunningApplication* front =
      [[NSWorkspace sharedWorkspace] frontmostApplication];
  NSRunningApplication* me = [NSRunningApplication currentApplication];
  [sPreviousApp release];
  sPreviousApp = (front && ![front isEqual:me]) ? [front retain] : nil;
  // No NSApplicationActivateAllWindows: only the window that becomes key
  // comes forward, never Whimsy's other windows.
  [me activateWithOptions:0];
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyGlobalHotKey::RestorePreviousApp() {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  NSRunningApplication* previous = sPreviousApp;
  sPreviousApp = nil;
  if (previous && !previous.terminated) {
    [previous activateWithOptions:0];
  }
  [previous release];
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

}  // namespace whimsy
