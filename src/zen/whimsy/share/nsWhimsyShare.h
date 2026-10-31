/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_nsWhimsyShare_h_
#define mozilla_nsWhimsyShare_h_

#include "nsIWhimsyShare.h"

#define WHIMSY_SHARE_CONTRACTID "@whimsy/share;1"

namespace whimsy {

/**
 * @brief Implementation of nsIWhimsyShare over AppKit's NSSharingService.
 * Plain C++ here; the Objective-C lives in nsWhimsyShare.mm.
 */
class nsWhimsyShare final : public nsIWhimsyShare {
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWHIMSYSHARE

 public:
  nsWhimsyShare() = default;

 private:
  ~nsWhimsyShare() = default;
};

}  // namespace whimsy

#endif
