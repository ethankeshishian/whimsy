/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_nsWhimsyBonjour_h_
#define mozilla_nsWhimsyBonjour_h_

#include "nsIWhimsyBonjour.h"
#include "mozilla/RefPtr.h"

#define WHIMSY_BONJOUR_CONTRACTID "@whimsy/bonjour;1"

namespace whimsy {

class BonjourSession;

/**
 * @brief Implementation of nsIWhimsyBonjour over dns_sd (DNSServiceBrowse
 * and DNSServiceResolve on one shared connection, on a private dispatch
 * queue). The session lives in nsWhimsyBonjour.mm, so this header stays
 * plain C++ for the generated component registration that includes it.
 */
class nsWhimsyBonjour final : public nsIWhimsyBonjour {
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWHIMSYBONJOUR

 public:
  nsWhimsyBonjour();

 private:
  ~nsWhimsyBonjour();

  RefPtr<BonjourSession> mSession;
};

}  // namespace whimsy

#endif
