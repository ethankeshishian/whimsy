/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_whimsy_nsWhimsyWebKit_h
#define mozilla_whimsy_nsWhimsyWebKit_h

#include "nsIWhimsyWebKit.h"

namespace whimsy {

class nsWhimsyWebKit final : public nsIWhimsyWebKit {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWHIMSYWEBKIT

  nsWhimsyWebKit() = default;

 private:
  ~nsWhimsyWebKit();
};

}  // namespace whimsy

#endif  // mozilla_whimsy_nsWhimsyWebKit_h
