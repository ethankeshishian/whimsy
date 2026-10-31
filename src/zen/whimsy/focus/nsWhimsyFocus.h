/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_nsWhimsyFocus_h_
#define mozilla_nsWhimsyFocus_h_

#include "nsIWhimsyFocus.h"

#define WHIMSY_FOCUS_CONTRACTID "@whimsy/focus;1"

namespace whimsy {

/**
 * @brief Implementation of nsIWhimsyFocus (INFocusStatusCenter + an FSEvents
 * watch). The Objective-C side lives in nsWhimsyFocus.mm, so this header
 * stays plain C++ for the generated component registration. A service: one
 * watch for the whole app.
 */
class nsWhimsyFocus final : public nsIWhimsyFocus {
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWHIMSYFOCUS

 public:
  nsWhimsyFocus() = default;

 private:
  ~nsWhimsyFocus();

  // An FSEventStreamRef, kept opaque here.
  void* mStream = nullptr;
};

}  // namespace whimsy

#endif
