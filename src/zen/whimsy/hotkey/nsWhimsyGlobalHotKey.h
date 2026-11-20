/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_nsWhimsyGlobalHotKey_h_
#define mozilla_nsWhimsyGlobalHotKey_h_

#include "nsIWhimsyGlobalHotKey.h"

namespace whimsy {

/**
 * @brief Implementation of nsIWhimsyGlobalHotKey over Carbon's
 * RegisterEventHotKey. The Carbon state lives in nsWhimsyGlobalHotKey.mm,
 * so this header stays plain C++ for the generated registration.
 */
class nsWhimsyGlobalHotKey final : public nsIWhimsyGlobalHotKey {
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWHIMSYGLOBALHOTKEY

 public:
  nsWhimsyGlobalHotKey() = default;

 private:
  ~nsWhimsyGlobalHotKey();
};

}  // namespace whimsy

#endif
