/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy's live captions for videos without any: the video's audio (tapped
// in the content process by nsIWhimsyAudioTap, sent over the speed
// control's actor) goes to Apple's speech recognizer, on this Mac only
// (requiresOnDeviceRecognition), and the partial transcripts come back to
// the caption box, translated like any other caption. Nothing here asks for
// access by itself; the front end calls requestAccess() only when the
// person turns on CC for a video that has no captions.
//
// A session is a run of recognition tasks ("stretches"): macOS ends a task
// after a pause or an error, and the session also ends one itself every
// kStretchSeconds of audio so the transcript stays caption-sized. Each new
// task gets a new generation; answers from an older one are dropped.

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <Speech/Speech.h>

#include <cstring>

#include "nsWhimsySpeech.h"

#include "mozilla/TimeStamp.h"
#include "nsCOMPtr.h"
#include "nsObjCExceptions.h"
#include "nsProxyRelease.h"
#include "nsString.h"
#include "nsTArray.h"
#include "nsThreadUtils.h"

namespace whimsy {

using mozilla::TimeDuration;
using mozilla::TimeStamp;

namespace {

using ListenerHandle = nsMainThreadPtrHandle<nsIWhimsySpeechListener>;
using CallbackHandle = nsMainThreadPtrHandle<nsIWhimsySpeechCallback>;

constexpr uint32_t kStretchSeconds = 30;
// More failed tasks than this within kFailureWindow ends the session.
constexpr uint32_t kMaxFailures = 4;
constexpr double kFailureWindowSeconds = 15.0;

void StatusName(SFSpeechRecognizerAuthorizationStatus aStatus, nsACString& aName) {
  switch (aStatus) {
    case SFSpeechRecognizerAuthorizationStatusNotDetermined:
      aName.AssignLiteral("notDetermined");
      break;
    case SFSpeechRecognizerAuthorizationStatusDenied:
      aName.AssignLiteral("denied");
      break;
    case SFSpeechRecognizerAuthorizationStatusRestricted:
      aName.AssignLiteral("restricted");
      break;
    case SFSpeechRecognizerAuthorizationStatusAuthorized:
      aName.AssignLiteral("authorized");
      break;
    default:
      aName.AssignLiteral("unknown");
      break;
  }
}

// macOS ends an app that asks for speech recognition without this string
// in its Info.plist, so a build missing it answers with an error instead.
bool HasUsageDescription() {
  NSDictionary* info = [[NSBundle mainBundle] infoDictionary];
  id value = info[@"NSSpeechRecognitionUsageDescription"];
  return [value isKindOfClass:[NSString class]] && [(NSString*)value length] > 0;
}

// "en-US" for Gecko, "en_US" for NSLocale.
NSLocale* LocaleFor(const nsACString& aTag) {
  nsAutoCString tag(aTag);
  tag.ReplaceChar('-', '_');
  NSString* identifier = [NSString stringWithUTF8String:tag.get()];
  return identifier.length ? [NSLocale localeWithLocaleIdentifier:identifier] : nil;
}

void TagFor(NSLocale* aLocale, nsACString& aTag) {
  const char* identifier = [aLocale.localeIdentifier UTF8String];
  aTag.Assign(identifier ? identifier : "");
  aTag.ReplaceChar('_', '-');
}

// Ends of a task that aren't failures: no speech in the stretch (1110), or
// the task cancelled because a newer one replaced it (216, 301).
bool IsBenign(NSError* aError) {
  if (!aError) {
    return true;
  }
  NSInteger code = aError.code;
  return code == 1110 || code == 216 || code == 301 || code == 203;
}

}  // namespace

class SpeechSession final : public nsIWhimsySpeechSession {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIWHIMSYSPEECHSESSION

  SpeechSession(const nsACString& aLocale, SFSpeechRecognizer* aRecognizer,
                const ListenerHandle& aListener)
      : mLocale(aLocale), mListener(aListener) {
    mRecognizer = [aRecognizer retain];
    // Answers come on this queue and are passed to the main thread, so
    // nothing depends on the main dispatch queue being serviced.
    mQueue = [[NSOperationQueue alloc] init];
    mQueue.maxConcurrentOperationCount = 1;
    mRecognizer.queue = mQueue;
  }

  // Main thread: an answer from the task of generation `aGeneration`.
  void HandleResult(uint32_t aGeneration, const nsCString& aText, bool aHasText, bool aFinal,
                    bool aEnded, bool aFailed) {
    MOZ_ASSERT(NS_IsMainThread());
    if (mStopped || aGeneration != mGeneration) {
      return;
    }
    if (aHasText) {
      mListener->OnText(aText, aFinal);
      if (mStopped) {
        return;
      }
    }
    if (!aEnded) {
      return;
    }
    if (aFailed) {
      TimeStamp now = TimeStamp::Now();
      if (mFailures == 0 ||
          (now - mFirstFailure) > TimeDuration::FromSeconds(kFailureWindowSeconds)) {
        mFirstFailure = now;
        mFailures = 0;
      }
      if (++mFailures > kMaxFailures) {
        Stop();
        mListener->OnError("failed"_ns);
        return;
      }
    }
    // The next audio starts a new stretch.
    ReleaseTask(/* aEndAudio */ true);
  }

 private:
  ~SpeechSession() {
    if (mTask) {
      [mTask cancel];
    }
    [mTask release];
    [mRequest release];
    [mFormat release];
    mRecognizer.queue = [NSOperationQueue mainQueue];
    [mRecognizer release];
    [mQueue release];
  }

  // A new recognition task, fed from now on.
  void Begin() {
    ReleaseTask(/* aEndAudio */ true);
    mGeneration++;
    mFed = 0;
    mRequest = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
    mRequest.requiresOnDeviceRecognition = YES;
    mRequest.shouldReportPartialResults = YES;
    if (@available(macOS 13.0, *)) {
      mRequest.addsPunctuation = YES;
    }

    RefPtr<SpeechSession> self = this;
    uint32_t generation = mGeneration;
    SFSpeechRecognitionTask* task = [mRecognizer
        recognitionTaskWithRequest:mRequest
                     resultHandler:^(SFSpeechRecognitionResult* result, NSError* error) {
                       nsCString text;
                       bool hasText = false;
                       bool final = false;
                       if (result) {
                         const char* utf8 = [result.bestTranscription.formattedString UTF8String];
                         text.Assign(utf8 ? utf8 : "");
                         hasText = true;
                         final = result.isFinal;
                       }
                       bool ended = final || error != nil;
                       bool failed = error != nil && !IsBenign(error);
                       NS_DispatchToMainThread(NS_NewRunnableFunction(
                           "WhimsySpeech::Result",
                           [self, generation, text, hasText, final, ended, failed]() {
                             self->HandleResult(generation, text, hasText, final, ended, failed);
                           }));
                     }];
    mTask = [task retain];
  }

  // Lets the current task finish (or not) on its own; its answers are
  // dropped from now on.
  void ReleaseTask(bool aEndAudio) {
    if (mRequest && aEndAudio) {
      [mRequest endAudio];
    }
    [mRequest release];
    mRequest = nil;
    [mTask release];
    mTask = nil;
    mGeneration++;
  }

  const nsCString mLocale;
  ListenerHandle mListener;
  SFSpeechRecognizer* mRecognizer = nil;
  NSOperationQueue* mQueue = nil;
  // Main thread only from here.
  SFSpeechAudioBufferRecognitionRequest* mRequest = nil;
  SFSpeechRecognitionTask* mTask = nil;
  AVAudioFormat* mFormat = nil;
  uint32_t mRate = 0;
  uint64_t mFed = 0;
  uint32_t mGeneration = 0;
  bool mStopped = false;
  uint32_t mFailures = 0;
  TimeStamp mFirstFailure;
};

NS_IMPL_ISUPPORTS(SpeechSession, nsIWhimsySpeechSession)

NS_IMETHODIMP
SpeechSession::AppendAudio(const nsTArray<float>& aSamples, uint32_t aSampleRate) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mStopped || aSamples.IsEmpty() || aSampleRate < 8000 || aSampleRate > 192000) {
    return NS_OK;
  }

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  if (aSampleRate != mRate || !mFormat) {
    [mFormat release];
    mFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32
                                               sampleRate:(double)aSampleRate
                                                 channels:1
                                              interleaved:NO];
    mRate = aSampleRate;
    // One format per task.
    ReleaseTask(/* aEndAudio */ true);
  }
  if (!mFormat) {
    return NS_ERROR_FAILURE;
  }
  if (!mRequest) {
    Begin();
  }

  AVAudioFrameCount frames = (AVAudioFrameCount)aSamples.Length();
  AVAudioPCMBuffer* buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:mFormat
                                                           frameCapacity:frames];
  if (!buffer || !buffer.floatChannelData) {
    [buffer release];
    return NS_ERROR_OUT_OF_MEMORY;
  }
  memcpy(buffer.floatChannelData[0], aSamples.Elements(), frames * sizeof(float));
  buffer.frameLength = frames;
  [mRequest appendAudioPCMBuffer:buffer];
  [buffer release];

  mFed += frames;
  if (mFed >= uint64_t(mRate) * kStretchSeconds) {
    // Caption-sized transcripts: the next audio starts a new stretch.
    ReleaseTask(/* aEndAudio */ true);
  }
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
SpeechSession::Stop() {
  MOZ_ASSERT(NS_IsMainThread());
  if (mStopped) {
    return NS_OK;
  }
  mStopped = true;

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  if (mTask) {
    [mTask cancel];
  }
  ReleaseTask(/* aEndAudio */ false);
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
SpeechSession::GetLocale(nsACString& aLocale) {
  aLocale = mLocale;
  return NS_OK;
}

NS_IMPL_ISUPPORTS(nsWhimsySpeech, nsIWhimsySpeech)

NS_IMETHODIMP
nsWhimsySpeech::GetAuthorizationStatus(nsACString& aStatus) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  StatusName([SFSpeechRecognizer authorizationStatus], aStatus);
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsySpeech::RequestAccess(nsIWhimsySpeechCallback* aCallback) {
  NS_ENSURE_ARG_POINTER(aCallback);
  MOZ_ASSERT(NS_IsMainThread());

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  CallbackHandle callback(
      new nsMainThreadPtrHolder<nsIWhimsySpeechCallback>("WhimsySpeech::RequestAccess", aCallback));

  if (!HasUsageDescription()) {
    NS_DispatchToMainThread(NS_NewRunnableFunction("WhimsySpeech::NoUsage", [callback]() {
      callback->OnComplete(false, "missing-usage-description"_ns);
    }));
    return NS_OK;
  }

  // Called on an arbitrary queue.
  [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
    nsAutoCString name;
    StatusName(status, name);
    nsCString result(name);
    bool granted = status == SFSpeechRecognizerAuthorizationStatusAuthorized;
    NS_DispatchToMainThread(
        NS_NewRunnableFunction("WhimsySpeech::AccessAnswered", [callback, granted, result]() {
          callback->OnComplete(granted, result);
        }));
  }];
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsySpeech::GetOnDeviceLocales(nsTArray<nsCString>& aLocales) {
  MOZ_ASSERT(NS_IsMainThread());

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  aLocales.Clear();
  @autoreleasepool {
    for (NSLocale* locale in [SFSpeechRecognizer supportedLocales]) {
      SFSpeechRecognizer* recognizer = [[SFSpeechRecognizer alloc] initWithLocale:locale];
      if (recognizer && recognizer.supportsOnDeviceRecognition) {
        nsAutoCString tag;
        TagFor(locale, tag);
        if (!tag.IsEmpty()) {
          aLocales.AppendElement(tag);
        }
      }
      [recognizer release];
    }
  }
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsySpeech::Start(const nsACString& aLocale, nsIWhimsySpeechListener* aListener,
                      nsIWhimsySpeechSession** aSession) {
  NS_ENSURE_ARG_POINTER(aListener);
  NS_ENSURE_ARG_POINTER(aSession);
  MOZ_ASSERT(NS_IsMainThread());

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  *aSession = nullptr;
  if (!HasUsageDescription() ||
      [SFSpeechRecognizer authorizationStatus] != SFSpeechRecognizerAuthorizationStatusAuthorized) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NSLocale* locale = LocaleFor(aLocale);
  if (!locale) {
    return NS_ERROR_INVALID_ARG;
  }
  SFSpeechRecognizer* recognizer = [[SFSpeechRecognizer alloc] initWithLocale:locale];
  // Never the server: a locale without an on-device model is refused.
  if (!recognizer || !recognizer.supportsOnDeviceRecognition) {
    [recognizer release];
    return NS_ERROR_NOT_AVAILABLE;
  }

  ListenerHandle listener(
      new nsMainThreadPtrHolder<nsIWhimsySpeechListener>("WhimsySpeech::Listener", aListener));
  RefPtr<SpeechSession> session = new SpeechSession(aLocale, recognizer, listener);
  [recognizer release];
  session.forget(aSession);
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

}  // namespace whimsy
