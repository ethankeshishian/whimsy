/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_nsWhimsyAudioTap_h_
#define mozilla_nsWhimsyAudioTap_h_

#include "nsIWhimsyAudioTap.h"
#include "mozilla/RefPtr.h"
#include "mozilla/WeakPtr.h"

#define WHIMSY_AUDIO_TAP_CONTRACTID "@whimsy/audio-tap;1"

namespace mozilla::dom {
class MediaStreamTrack;
}

namespace whimsy {

class AudioTapListener;

/**
 * @brief Implementation of nsIWhimsyAudioTap: a MediaTrackListener on the
 * captured track's graph track that downmixes and divides down each queued
 * audio segment on the graph thread, and a locked buffer the main thread
 * drains with take().
 */
class nsWhimsyAudioTap final : public nsIWhimsyAudioTap {
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWHIMSYAUDIOTAP

 public:
  nsWhimsyAudioTap();

 private:
  ~nsWhimsyAudioTap();

  RefPtr<AudioTapListener> mListener;
  // Weak: the page owns the track; the tap only listens while it lives.
  mozilla::WeakPtr<mozilla::dom::MediaStreamTrack> mTrack;
};

}  // namespace whimsy

#endif
