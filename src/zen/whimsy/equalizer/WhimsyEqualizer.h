/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_WhimsyEqualizer_h_
#define mozilla_WhimsyEqualizer_h_

#include <atomic>
#include <stddef.h>
#include <stdint.h>

#include "mozilla/RefPtr.h"
#include "nsISupportsImpl.h"

namespace mozilla {

class AudioSegment;

/**
 * W29 equalizer: the gains one media element asks for, shared between the
 * main thread (the element writes them) and the audio thread that plays its
 * decoded audio (AudioSink::PopFrames, or AudioDecoderInputTrack on the graph
 * thread when the element is captured). Lock-free: the gains are atomics and
 * a generation counter tells the reader when to look again.
 */
class WhimsyEqualizerParams final {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(WhimsyEqualizerParams)

  static constexpr size_t kBands = 8;
  static constexpr float kMaxGainDb = 12.0f;
  // Band centres in Hz: 60 Hz is a low shelf, 15 kHz a high shelf, the rest
  // are peaking filters.
  static constexpr float kFrequencies[kBands] = {60.0f,   150.0f,  400.0f,
                                                 1000.0f, 2400.0f, 6000.0f,
                                                 10000.0f, 15000.0f};

  WhimsyEqualizerParams();

  // Any thread. Gains in dB, clamped to +-12; missing bands are 0 and a NaN
  // is 0.
  void SetGains(const float* aGains, size_t aCount);
  void GetGains(float* aOut) const;
  bool IsFlat() const;
  uint32_t Generation() const {
    return mGeneration.load(std::memory_order_acquire);
  }

 private:
  ~WhimsyEqualizerParams() = default;

  std::atomic<float> mGains[kBands];
  std::atomic<uint32_t> mGeneration{0};
};

/**
 * The filter itself: one per audio output, used only on that output's audio
 * thread. An 8-band cascade of RBJ biquads (transposed direct form II, double
 * state). A gain change ramps linearly in dB over 50 ms, with coefficients
 * recomputed every 32 frames, so moving a slider never clicks. While every
 * band is at 0 dB the filter returns at once and leaves the samples alone, so
 * a flat equalizer costs one atomic load per callback and is bit-identical.
 */
class WhimsyEqualizer final {
 public:
  static constexpr uint32_t kMaxChannels = 8;

  explicit WhimsyEqualizer(WhimsyEqualizerParams* aParams);
  ~WhimsyEqualizer();

  // Picks up new gains; true when the next Process call will change samples.
  bool WillProcess();

  // Filters aFrames frames in place. aChannels[c] points at channel c's
  // first sample and successive frames are aStride samples apart (1 for
  // planar data, the channel count for interleaved). Returns true when it
  // changed anything. More than kMaxChannels channels are left alone.
  bool Process(float* const* aChannels, uint32_t aChannelCount,
               uint32_t aFrames, size_t aStride, uint32_t aRate);
  bool ProcessInterleaved(float* aData, uint32_t aChannelCount,
                          uint32_t aFrames, uint32_t aRate);
  // A graph segment: every float chunk is copied into a new buffer (chunk
  // buffers are shared) and filtered there.
  void ProcessSegment(AudioSegment& aSegment, uint32_t aRate);

 private:
  struct Coefficients {
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  };

  void Sync(uint32_t aRate);
  void Reset();
  void ComputeCoefficients(size_t aBand);
  bool BandActive(size_t aBand) const;

  RefPtr<WhimsyEqualizerParams> mParams;
  bool mSynced = false;
  uint32_t mGeneration = 0;
  uint32_t mRate = 0;
  uint32_t mChannelCount = 0;
  bool mBypassed = true;

  float mCurrentDb[WhimsyEqualizerParams::kBands] = {};
  float mTargetDb[WhimsyEqualizerParams::kBands] = {};
  float mStepDb[WhimsyEqualizerParams::kBands] = {};
  uint32_t mRampFrames = 0;

  Coefficients mCoefficients[WhimsyEqualizerParams::kBands];
  // [channel][band][z1, z2]
  double mState[kMaxChannels][WhimsyEqualizerParams::kBands][2] = {};
};

}  // namespace mozilla

#endif
