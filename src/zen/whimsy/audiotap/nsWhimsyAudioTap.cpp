/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Live captions for videos without any: the audio of the video's captured
// track (HTMLMediaElement.captureStream(), called by WhimsyCaptionsChild),
// as mono PCM at about 16 kHz, for Apple's on-device speech recognizer in
// the parent (../speech). The listener runs on the MediaTrackGraph thread,
// so it only averages channels and frames into a locked buffer; the main
// thread drains it a few times a second.

#include "mozilla/nsWhimsyAudioTap.h"

#include <algorithm>

#include "AudioSegment.h"
#include "MediaSegment.h"
#include "MediaTrackGraph.h"
#include "MediaTrackListener.h"
#include "mozilla/Mutex.h"
#include "mozilla/dom/MediaStreamTrack.h"
#include "nsTArray.h"
#include "nsThreadUtils.h"

namespace whimsy {

using namespace mozilla;

namespace {

// Speech recognizers want about 16 kHz; graphs run at 44.1 or 48 kHz.
constexpr uint32_t kTargetRate = 16000;
// What's kept when nobody takes it (a busy main thread, a paused poller).
constexpr uint32_t kKeepSeconds = 10;

}  // namespace

class AudioTapListener final : public MediaTrackListener {
 public:
  AudioTapListener() : mMutex("WhimsyAudioTap") {}

  void NotifyQueuedChanges(MediaTrackGraph* aGraph, TrackTime aTrackOffset,
                           const MediaSegment& aQueuedMedia) override {
    if (aQueuedMedia.GetType() != MediaSegment::AUDIO) {
      return;
    }
    const AudioSegment& audio = static_cast<const AudioSegment&>(aQueuedMedia);
    const TrackRate graphRate = aGraph->GraphRate();
    if (graphRate <= 0) {
      return;
    }
    const uint32_t factor = std::max<uint32_t>(
        1, (uint32_t(graphRate) + kTargetRate / 2) / kTargetRate);

    MutexAutoLock lock(mMutex);
    if (factor != mFactor || uint32_t(graphRate) != mGraphRate) {
      mFactor = factor;
      mGraphRate = uint32_t(graphRate);
      mRate = mGraphRate / mFactor;
      mSum = 0.0f;
      mCount = 0;
      mSamples.Clear();
    }

    for (AudioSegment::ConstChunkIterator ci(audio); !ci.IsEnded(); ci.Next()) {
      const AudioChunk& chunk = *ci;
      const TrackTime frames = chunk.GetDuration();
      const uint32_t channels = chunk.ChannelCount();
      if (chunk.IsNull() || chunk.IsMuted() || channels == 0) {
        for (TrackTime i = 0; i < frames; i++) {
          Push(0.0f);
        }
        continue;
      }
      const float gain = chunk.mVolume / float(channels);
      if (chunk.mBufferFormat == AUDIO_FORMAT_FLOAT32) {
        auto data = chunk.ChannelData<float>();
        for (TrackTime i = 0; i < frames; i++) {
          float sum = 0.0f;
          for (uint32_t c = 0; c < channels; c++) {
            sum += data[c][i];
          }
          Push(sum * gain);
        }
      } else if (chunk.mBufferFormat == AUDIO_FORMAT_S16) {
        auto data = chunk.ChannelData<int16_t>();
        for (TrackTime i = 0; i < frames; i++) {
          float sum = 0.0f;
          for (uint32_t c = 0; c < channels; c++) {
            sum += float(data[c][i]) / 32768.0f;
          }
          Push(sum * gain);
        }
      } else {
        for (TrackTime i = 0; i < frames; i++) {
          Push(0.0f);
        }
      }
    }

    const size_t keep = size_t(mRate) * kKeepSeconds;
    if (mSamples.Length() > keep) {
      mSamples.RemoveElementsAt(0, mSamples.Length() - keep);
    }
  }

  void Take(nsTArray<float>& aOut, uint32_t& aRate) {
    MutexAutoLock lock(mMutex);
    aOut = std::move(mSamples);
    mSamples = nsTArray<float>();
    aRate = mRate;
  }

  uint32_t Rate() {
    MutexAutoLock lock(mMutex);
    return mRate;
  }

 private:
  ~AudioTapListener() = default;

  // Box filter: each output sample is the mean of `mFactor` input frames.
  void Push(float aValue) MOZ_REQUIRES(mMutex) {
    mSum += aValue;
    if (++mCount >= mFactor) {
      mSamples.AppendElement(std::clamp(mSum / float(mFactor), -1.0f, 1.0f));
      mSum = 0.0f;
      mCount = 0;
    }
  }

  Mutex mMutex;
  nsTArray<float> mSamples MOZ_GUARDED_BY(mMutex);
  uint32_t mGraphRate MOZ_GUARDED_BY(mMutex) = 0;
  uint32_t mFactor MOZ_GUARDED_BY(mMutex) = 1;
  uint32_t mRate MOZ_GUARDED_BY(mMutex) = 0;
  float mSum MOZ_GUARDED_BY(mMutex) = 0.0f;
  uint32_t mCount MOZ_GUARDED_BY(mMutex) = 0;
};

NS_IMPL_ISUPPORTS(nsWhimsyAudioTap, nsIWhimsyAudioTap)

nsWhimsyAudioTap::nsWhimsyAudioTap() = default;

nsWhimsyAudioTap::~nsWhimsyAudioTap() { Stop(); }

NS_IMETHODIMP
nsWhimsyAudioTap::Start(dom::MediaStreamTrack* aTrack) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_ARG_POINTER(aTrack);
  if (!aTrack->AsAudioStreamTrack() || aTrack->Ended()) {
    return NS_ERROR_INVALID_ARG;
  }
  Stop();
  mListener = new AudioTapListener();
  aTrack->AddListener(mListener);
  mTrack = aTrack;
  return NS_OK;
}

NS_IMETHODIMP
nsWhimsyAudioTap::Stop() {
  MOZ_ASSERT(NS_IsMainThread());
  if (RefPtr<dom::MediaStreamTrack> track = mTrack.get()) {
    if (mListener) {
      track->RemoveListener(mListener);
    }
  }
  mTrack = nullptr;
  mListener = nullptr;
  return NS_OK;
}

NS_IMETHODIMP
nsWhimsyAudioTap::GetActive(bool* aActive) {
  NS_ENSURE_ARG_POINTER(aActive);
  RefPtr<dom::MediaStreamTrack> track = mTrack.get();
  *aActive = mListener && track && !track->Ended();
  return NS_OK;
}

NS_IMETHODIMP
nsWhimsyAudioTap::GetSampleRate(uint32_t* aRate) {
  NS_ENSURE_ARG_POINTER(aRate);
  *aRate = mListener ? mListener->Rate() : 0;
  return NS_OK;
}

NS_IMETHODIMP
nsWhimsyAudioTap::Take(nsTArray<float>& aSamples) {
  MOZ_ASSERT(NS_IsMainThread());
  aSamples.Clear();
  if (!mListener) {
    return NS_OK;
  }
  uint32_t rate = 0;
  mListener->Take(aSamples, rate);
  return NS_OK;
}

}  // namespace whimsy
