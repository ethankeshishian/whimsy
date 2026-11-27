/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_whimsy_nsWhimsyWebKit_h
#define mozilla_whimsy_nsWhimsyWebKit_h

#include "nsIWhimsyEngineTab.h"

namespace whimsy {

// W32: WebKit's engine tab service (nsIWhimsyEngineTab, engine "webkit").
class nsWhimsyWebKit final : public nsIWhimsyEngineTab {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWHIMSYENGINETAB

  nsWhimsyWebKit() = default;

 private:
  ~nsWhimsyWebKit();
};

}  // namespace whimsy

#endif  // mozilla_whimsy_nsWhimsyWebKit_h
