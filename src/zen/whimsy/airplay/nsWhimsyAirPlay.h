/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_nsWhimsyAirPlay_h_
#define mozilla_nsWhimsyAirPlay_h_

#include "nsIWhimsyAirPlay.h"

#define WHIMSY_AIRPLAY_CONTRACTID "@whimsy/airplay;1"

namespace whimsy {

/**
 * @brief Implementation of nsIWhimsyAirPlay over AVFoundation and AVKit.
 * The player, picker and observer live in nsWhimsyAirPlay.mm (one session
 * per process), so this header stays plain C++ for the generated component
 * registration that includes it.
 */
class nsWhimsyAirPlay final : public nsIWhimsyAirPlay {
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWHIMSYAIRPLAY

 public:
  nsWhimsyAirPlay() = default;

 private:
  ~nsWhimsyAirPlay() = default;
};

}  // namespace whimsy

#endif
