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
#import <Cocoa/Cocoa.h>
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

void AVStatusName(AVAuthorizationStatus aStatus, nsACString& aName) {
  switch (aStatus) {
    case AVAuthorizationStatusNotDetermined:
      aName.AssignLiteral("notDetermined");
      break;
    case AVAuthorizationStatusDenied:
      aName.AssignLiteral("denied");
      break;
    case AVAuthorizationStatusRestricted:
      aName.AssignLiteral("restricted");
      break;
    case AVAuthorizationStatusAuthorized:
      aName.AssignLiteral("authorized");
      break;
    default:
      aName.AssignLiteral("unknown");
      break;
  }
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

// W23 voice-image: dictation. One recognition task for the whole hold,
// fed from the default microphone through an AVAudioEngine tap; finish()
// turns the microphone off and lets the recognizer punctuate the end.
class MicSession final : public nsIWhimsyMicSession {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIWHIMSYMICSESSION

  MicSession(const nsACString& aLocale, SFSpeechRecognizer* aRecognizer,
             const ListenerHandle& aListener)
      : mLocale(aLocale), mListener(aListener) {
    mRecognizer = [aRecognizer retain];
    mQueue = [[NSOperationQueue alloc] init];
    mQueue.maxConcurrentOperationCount = 1;
    mRecognizer.queue = mQueue;
  }

  nsresult Begin() {
    MOZ_ASSERT(NS_IsMainThread());
    mRequest = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
    mRequest.requiresOnDeviceRecognition = YES;
    mRequest.shouldReportPartialResults = YES;
    if (@available(macOS 13.0, *)) {
      mRequest.addsPunctuation = YES;
    }
    mEngine = [[AVAudioEngine alloc] init];
    AVAudioInputNode* input = mEngine.inputNode;
    AVAudioFormat* format = [input outputFormatForBus:0];
    if (!format || format.sampleRate <= 0 || format.channelCount == 0) {
      Teardown();
      return NS_ERROR_NOT_AVAILABLE;
    }
    SFSpeechAudioBufferRecognitionRequest* request = mRequest;
    // On the audio thread: only the request, which takes buffers from any thread.
    [input installTapOnBus:0
                bufferSize:1024
                    format:format
                     block:^(AVAudioPCMBuffer* buffer, AVAudioTime* when) {
                       [request appendAudioPCMBuffer:buffer];
                     }];
    mTapped = true;

    RefPtr<MicSession> self = this;
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
                       bool failed = error != nil && !IsBenign(error);
                       bool ended = final || error != nil;
                       NS_DispatchToMainThread(NS_NewRunnableFunction(
                           "WhimsySpeech::MicResult", [self, text, hasText, final, ended, failed]() {
                             self->HandleResult(text, hasText, final, ended, failed);
                           }));
                     }];
    mTask = [task retain];

    [mEngine prepare];
    NSError* error = nil;
    if (![mEngine startAndReturnError:&error]) {
      Teardown();
      return NS_ERROR_NOT_AVAILABLE;
    }
    return NS_OK;
  }

  void HandleResult(const nsCString& aText, bool aHasText, bool aFinal, bool aEnded,
                    bool aFailed) {
    MOZ_ASSERT(NS_IsMainThread());
    if (mDone) {
      return;
    }
    if (aHasText) {
      mLast = aText;
    }
    if (aFailed) {
      mDone = true;
      Teardown();
      mListener->OnError("failed"_ns);
      return;
    }
    if (aEnded) {
      // A final answer, or a benign end (no speech): the last words stand.
      mDone = true;
      Teardown();
      mListener->OnText(mLast, true);
      return;
    }
    if (aHasText) {
      mListener->OnText(aText, false);
    }
  }

 private:
  ~MicSession() {
    Teardown();
    mRecognizer.queue = [NSOperationQueue mainQueue];
    [mRecognizer release];
    [mQueue release];
  }

  // The microphone off; the request ends so a final answer can still come.
  void StopMicrophone() {
    if (mEngine) {
      if (mTapped) {
        [mEngine.inputNode removeTapOnBus:0];
        mTapped = false;
      }
      [mEngine stop];
      [mEngine release];
      mEngine = nil;
    }
    if (mRequest) {
      [mRequest endAudio];
    }
  }

  void Teardown() {
    StopMicrophone();
    if (mTask && mDone) {
      [mTask cancel];
    }
    [mTask release];
    mTask = nil;
    [mRequest release];
    mRequest = nil;
  }

  const nsCString mLocale;
  ListenerHandle mListener;
  SFSpeechRecognizer* mRecognizer = nil;
  NSOperationQueue* mQueue = nil;
  // Main thread only from here.
  AVAudioEngine* mEngine = nil;
  SFSpeechAudioBufferRecognitionRequest* mRequest = nil;
  SFSpeechRecognitionTask* mTask = nil;
  nsCString mLast;
  bool mTapped = false;
  bool mDone = false;
};

NS_IMPL_ISUPPORTS(MicSession, nsIWhimsyMicSession)

NS_IMETHODIMP
MicSession::Finish() {
  MOZ_ASSERT(NS_IsMainThread());
  if (mDone) {
    return NS_OK;
  }
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  StopMicrophone();
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
MicSession::Stop() {
  MOZ_ASSERT(NS_IsMainThread());
  if (mDone) {
    return NS_OK;
  }
  mDone = true;
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  Teardown();
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
MicSession::GetLocale(nsACString& aLocale) {
  aLocale = mLocale;
  return NS_OK;
}

// W23 voice-image: the Fn (globe) key, from a local event monitor (events
// reach it only while Whimsy is the active app).
class FnWatch final : public nsIWhimsyFnWatch {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWHIMSYFNWATCH

  explicit FnWatch(nsIWhimsyFnListener* aListener) : mListener(aListener) {}

  void Begin() {
    FnWatch* watch = this;
    mMonitor = [[NSEvent
        addLocalMonitorForEventsMatchingMask:(NSEventMaskFlagsChanged | NSEventMaskKeyDown)
                                     handler:^NSEvent*(NSEvent* event) {
                                       watch->Handle(event);
                                       return event;
                                     }] retain];
  }

  void Handle(NSEvent* aEvent) {
    if (!mListener) {
      return;
    }
    nsCOMPtr<nsIWhimsyFnListener> listener = mListener;
    if (aEvent.type == NSEventTypeKeyDown) {
      if (mDown) {
        listener->OnFn("other-key"_ns);
      }
      return;
    }
    // kVK_Function
    if (aEvent.keyCode != 63) {
      if (mDown) {
        listener->OnFn("other-key"_ns);
      }
      return;
    }
    bool down = (aEvent.modifierFlags & NSEventModifierFlagFunction) != 0;
    if (down == mDown) {
      return;
    }
    mDown = down;
    listener->OnFn(down ? "down"_ns : "up"_ns);
  }

 private:
  ~FnWatch() { Stop(); }

  nsCOMPtr<nsIWhimsyFnListener> mListener;
  id mMonitor = nil;
  bool mDown = false;
};

NS_IMPL_ISUPPORTS(FnWatch, nsIWhimsyFnWatch)

NS_IMETHODIMP
FnWatch::Stop() {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  if (mMonitor) {
    [NSEvent removeMonitor:mMonitor];
    [mMonitor release];
    mMonitor = nil;
  }
  mListener = nullptr;
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsySpeech::GetMicrophoneStatus(nsACString& aStatus) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  AVStatusName([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio], aStatus);
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsySpeech::RequestMicrophoneAccess(nsIWhimsySpeechCallback* aCallback) {
  NS_ENSURE_ARG_POINTER(aCallback);
  MOZ_ASSERT(NS_IsMainThread());
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  CallbackHandle callback(new nsMainThreadPtrHolder<nsIWhimsySpeechCallback>(
      "WhimsySpeech::RequestMicrophoneAccess", aCallback));
  [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                           completionHandler:^(BOOL granted) {
                             nsAutoCString name;
                             AVStatusName(
                                 [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio],
                                 name);
                             nsCString result(name);
                             bool ok = granted;
                             NS_DispatchToMainThread(NS_NewRunnableFunction(
                                 "WhimsySpeech::MicrophoneAnswered",
                                 [callback, ok, result]() { callback->OnComplete(ok, result); }));
                           }];
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsySpeech::Listen(const nsACString& aLocale, nsIWhimsySpeechListener* aListener,
                       nsIWhimsyMicSession** aSession) {
  NS_ENSURE_ARG_POINTER(aListener);
  NS_ENSURE_ARG_POINTER(aSession);
  MOZ_ASSERT(NS_IsMainThread());
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  *aSession = nullptr;
  if (!HasUsageDescription() ||
      [SFSpeechRecognizer authorizationStatus] != SFSpeechRecognizerAuthorizationStatusAuthorized ||
      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] !=
          AVAuthorizationStatusAuthorized) {
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
      new nsMainThreadPtrHolder<nsIWhimsySpeechListener>("WhimsySpeech::MicListener", aListener));
  RefPtr<MicSession> session = new MicSession(aLocale, recognizer, listener);
  [recognizer release];
  nsresult rv = session->Begin();
  if (NS_FAILED(rv)) {
    return rv;
  }
  session.forget(aSession);
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsySpeech::WatchFnKey(nsIWhimsyFnListener* aListener, nsIWhimsyFnWatch** aWatch) {
  NS_ENSURE_ARG_POINTER(aListener);
  NS_ENSURE_ARG_POINTER(aWatch);
  MOZ_ASSERT(NS_IsMainThread());
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  RefPtr<FnWatch> watch = new FnWatch(aListener);
  watch->Begin();
  watch.forget(aWatch);
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsySpeech::GetFnKeyUsage(int32_t* aUsage) {
  NS_ENSURE_ARG_POINTER(aUsage);
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  *aUsage = -1;
  CFPropertyListRef value =
      CFPreferencesCopyAppValue(CFSTR("AppleFnUsageType"), CFSTR("com.apple.HIToolbox"));
  if (value) {
    int number = -1;
    if (CFGetTypeID(value) == CFNumberGetTypeID() &&
        CFNumberGetValue((CFNumberRef)value, kCFNumberIntType, &number)) {
      *aUsage = number;
    }
    CFRelease(value);
  }
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsySpeech::OpenSystemSettings(const nsACString& aPage) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;
  NSString* url = nil;
  if (aPage.EqualsLiteral("keyboard")) {
    url = @"x-apple.systempreferences:com.apple.Keyboard-Settings.extension";
  } else if (aPage.EqualsLiteral("microphone")) {
    url = @"x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
  } else if (aPage.EqualsLiteral("speech-recognition")) {
    url = @"x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition";
  } else {
    return NS_ERROR_INVALID_ARG;
  }
  [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:url]];
  return NS_OK;
  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

}  // namespace whimsy
