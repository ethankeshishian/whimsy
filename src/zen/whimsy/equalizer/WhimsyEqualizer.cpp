/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/WhimsyEqualizer.h"

#include <algorithm>
#include <cmath>
#include <string.h>

#include "AudioSegment.h"
#include "SharedBuffer.h"
#include "mozilla/CheckedInt.h"

namespace mozilla {

static constexpr size_t kBands = WhimsyEqualizerParams::kBands;
// Frames per coefficient update while a gain ramps.
static constexpr uint32_t kBlockFrames = 32;
static constexpr double kRampSeconds = 0.05;
static constexpr double kPeakingQ = 1.0;
static constexpr double kPi = 3.14159265358979323846;
// Bands at or above this fraction of the sample rate are skipped (a filter
// that close to Nyquist only adds error).
static constexpr double kMaxFrequencyRatio = 0.45;

WhimsyEqualizerParams::WhimsyEqualizerParams() {
  for (auto& gain : mGains) {
    gain.store(0.0f, std::memory_order_relaxed);
  }
}

void WhimsyEqualizerParams::SetGains(const float* aGains, size_t aCount) {
  for (size_t i = 0; i < kBands; i++) {
    float gain = i < aCount ? aGains[i] : 0.0f;
    if (!std::isfinite(gain)) {
      gain = 0.0f;
    }
    gain = std::clamp(gain, -kMaxGainDb, kMaxGainDb);
    mGains[i].store(gain, std::memory_order_relaxed);
  }
  mGeneration.fetch_add(1, std::memory_order_release);
}

void WhimsyEqualizerParams::GetGains(float* aOut) const {
  for (size_t i = 0; i < kBands; i++) {
    aOut[i] = mGains[i].load(std::memory_order_relaxed);
  }
}

bool WhimsyEqualizerParams::IsFlat() const {
  for (const auto& gain : mGains) {
    if (gain.load(std::memory_order_relaxed) != 0.0f) {
      return false;
    }
  }
  return true;
}

WhimsyEqualizer::WhimsyEqualizer(WhimsyEqualizerParams* aParams)
    : mParams(aParams) {}

WhimsyEqualizer::~WhimsyEqualizer() = default;

void WhimsyEqualizer::Reset() { memset(mState, 0, sizeof(mState)); }

bool WhimsyEqualizer::BandActive(size_t aBand) const {
  if (mCurrentDb[aBand] == 0.0f && mTargetDb[aBand] == 0.0f) {
    return false;
  }
  return mRate &&
         WhimsyEqualizerParams::kFrequencies[aBand] <
             kMaxFrequencyRatio * static_cast<double>(mRate);
}

void WhimsyEqualizer::Sync(uint32_t aRate) {
  if (!mParams) {
    mBypassed = true;
    return;
  }
  const uint32_t generation = mParams->Generation();
  if (mSynced && generation == mGeneration) {
    return;
  }
  float gains[kBands];
  mParams->GetGains(gains);
  // The first gains a new output sees apply at once (a new sink after a seek
  // must not fade in from flat); later changes ramp.
  const bool snap = !mSynced || !aRate;
  mSynced = true;
  mGeneration = generation;
  mRampFrames =
      snap ? 0
           : std::max<uint32_t>(
                 1, static_cast<uint32_t>(std::lround(aRate * kRampSeconds)));
  bool flat = true;
  for (size_t i = 0; i < kBands; i++) {
    mTargetDb[i] = gains[i];
    if (snap) {
      mCurrentDb[i] = gains[i];
      mStepDb[i] = 0.0f;
    } else {
      mStepDb[i] = (gains[i] - mCurrentDb[i]) / static_cast<float>(mRampFrames);
    }
    if (mCurrentDb[i] != 0.0f || mTargetDb[i] != 0.0f) {
      flat = false;
    }
  }
  if (flat) {
    mRampFrames = 0;
  }
  if (mBypassed && !flat) {
    Reset();
  }
  mBypassed = flat;
  for (size_t i = 0; i < kBands; i++) {
    ComputeCoefficients(i);
  }
}

bool WhimsyEqualizer::WillProcess() {
  Sync(mRate);
  return !mBypassed;
}

void WhimsyEqualizer::ComputeCoefficients(size_t aBand) {
  Coefficients& c = mCoefficients[aBand];
  if (!BandActive(aBand)) {
    c = Coefficients();
    return;
  }
  // Robert Bristow-Johnson's Audio EQ Cookbook.
  const double A = std::pow(10.0, mCurrentDb[aBand] / 40.0);
  const double w0 = 2.0 * kPi * WhimsyEqualizerParams::kFrequencies[aBand] /
                    static_cast<double>(mRate);
  const double cosw = std::cos(w0);
  const double sinw = std::sin(w0);
  double b0, b1, b2, a0, a1, a2;
  if (aBand == 0 || aBand == kBands - 1) {
    // Shelf, slope S = 1.
    const double alpha = sinw / 2.0 * std::sqrt(2.0);
    const double twoSqrtAAlpha = 2.0 * std::sqrt(A) * alpha;
    if (aBand == 0) {
      b0 = A * ((A + 1) - (A - 1) * cosw + twoSqrtAAlpha);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosw);
      b2 = A * ((A + 1) - (A - 1) * cosw - twoSqrtAAlpha);
      a0 = (A + 1) + (A - 1) * cosw + twoSqrtAAlpha;
      a1 = -2 * ((A - 1) + (A + 1) * cosw);
      a2 = (A + 1) + (A - 1) * cosw - twoSqrtAAlpha;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cosw + twoSqrtAAlpha);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
      b2 = A * ((A + 1) + (A - 1) * cosw - twoSqrtAAlpha);
      a0 = (A + 1) - (A - 1) * cosw + twoSqrtAAlpha;
      a1 = 2 * ((A - 1) - (A + 1) * cosw);
      a2 = (A + 1) - (A - 1) * cosw - twoSqrtAAlpha;
    }
  } else {
    const double alpha = sinw / (2.0 * kPeakingQ);
    b0 = 1 + alpha * A;
    b1 = -2 * cosw;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cosw;
    a2 = 1 - alpha / A;
  }
  c.b0 = b0 / a0;
  c.b1 = b1 / a0;
  c.b2 = b2 / a0;
  c.a1 = a1 / a0;
  c.a2 = a2 / a0;
}

bool WhimsyEqualizer::Process(float* const* aChannels, uint32_t aChannelCount,
                              uint32_t aFrames, size_t aStride,
                              uint32_t aRate) {
  if (!aChannelCount || aChannelCount > kMaxChannels || !aFrames || !aRate) {
    return false;
  }
  if (aRate != mRate || aChannelCount != mChannelCount) {
    mRate = aRate;
    mChannelCount = aChannelCount;
    Reset();
    for (size_t i = 0; i < kBands; i++) {
      ComputeCoefficients(i);
    }
  }
  Sync(aRate);
  if (mBypassed) {
    return false;
  }

  for (uint32_t start = 0; start < aFrames; start += kBlockFrames) {
    const uint32_t count = std::min(kBlockFrames, aFrames - start);
    if (mRampFrames) {
      const uint32_t step = std::min(count, mRampFrames);
      mRampFrames -= step;
      for (size_t b = 0; b < kBands; b++) {
        if (mCurrentDb[b] == mTargetDb[b]) {
          continue;
        }
        mCurrentDb[b] = mRampFrames ? mCurrentDb[b] + mStepDb[b] * step
                                    : mTargetDb[b];
        ComputeCoefficients(b);
      }
    }
    for (size_t b = 0; b < kBands; b++) {
      if (!BandActive(b)) {
        continue;
      }
      const Coefficients& c = mCoefficients[b];
      for (uint32_t ch = 0; ch < aChannelCount; ch++) {
        double z1 = mState[ch][b][0];
        double z2 = mState[ch][b][1];
        float* sample = aChannels[ch] + start * aStride;
        for (uint32_t i = 0; i < count; i++, sample += aStride) {
          const double x = *sample;
          const double y = c.b0 * x + z1;
          z1 = c.b1 * x - c.a1 * y + z2;
          z2 = c.b2 * x - c.a2 * y;
          *sample = static_cast<float>(y);
        }
        // Flush denormals so a filter ringing out over silence stays cheap.
        mState[ch][b][0] = std::fabs(z1) < 1e-25 ? 0.0 : z1;
        mState[ch][b][1] = std::fabs(z2) < 1e-25 ? 0.0 : z2;
      }
    }
  }

  if (!mRampFrames) {
    bool flat = true;
    for (size_t b = 0; b < kBands; b++) {
      if (mTargetDb[b] != 0.0f) {
        flat = false;
      } else {
        // A band that has ramped to 0 dB is skipped from here on; clear its
        // state so it starts clean if it comes back.
        for (uint32_t ch = 0; ch < kMaxChannels; ch++) {
          mState[ch][b][0] = mState[ch][b][1] = 0.0;
        }
      }
    }
    if (flat) {
      mBypassed = true;
      Reset();
    }
  }
  return true;
}

bool WhimsyEqualizer::ProcessInterleaved(float* aData, uint32_t aChannelCount,
                                         uint32_t aFrames, uint32_t aRate) {
  if (!aChannelCount || aChannelCount > kMaxChannels) {
    return false;
  }
  float* channels[kMaxChannels];
  for (uint32_t ch = 0; ch < aChannelCount; ch++) {
    channels[ch] = aData + ch;
  }
  return Process(channels, aChannelCount, aFrames, aChannelCount, aRate);
}

void WhimsyEqualizer::ProcessSegment(AudioSegment& aSegment, uint32_t aRate) {
  if (!WillProcess()) {
    return;
  }
  for (AudioSegment::ChunkIterator ci(aSegment); !ci.IsEnded(); ci.Next()) {
    AudioChunk& chunk = *ci;
    if (chunk.IsNull() || chunk.mBufferFormat != AUDIO_FORMAT_FLOAT32 ||
        chunk.mDuration <= 0) {
      continue;
    }
    const uint32_t channelCount = chunk.ChannelCount();
    if (!channelCount || channelCount > kMaxChannels) {
      continue;
    }
    const uint32_t frames = static_cast<uint32_t>(chunk.mDuration);
    CheckedInt<size_t> size = sizeof(float);
    size *= channelCount;
    size *= frames;
    if (!size.isValid()) {
      continue;
    }
    RefPtr<SharedBuffer> buffer = SharedBuffer::Create(size, fallible);
    if (!buffer) {
      continue;
    }
    float* data = static_cast<float*>(buffer->Data());
    float* channels[kMaxChannels];
    const auto input = chunk.ChannelData<float>();
    for (uint32_t ch = 0; ch < channelCount; ch++) {
      channels[ch] = data + static_cast<size_t>(ch) * frames;
      memcpy(channels[ch], input[ch], frames * sizeof(float));
    }
    Process(channels, channelCount, frames, 1, aRate);
    chunk.mChannelData.ClearAndRetainStorage();
    for (uint32_t ch = 0; ch < channelCount; ch++) {
      chunk.mChannelData.AppendElement(channels[ch]);
    }
    chunk.mBuffer = std::move(buffer);
  }
}

}  // namespace mozilla
