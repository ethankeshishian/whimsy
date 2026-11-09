/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_nsWhimsyEmbedding_h_
#define mozilla_nsWhimsyEmbedding_h_

#include "nsIWhimsyEmbedding.h"

#define WHIMSY_EMBEDDING_CONTRACTID "@whimsy/embedding;1"

namespace whimsy {

/**
 * @brief Implementation of nsIWhimsyEmbedding over the NaturalLanguage
 * framework (NLEmbedding, on-device only). Objective-C lives in
 * nsWhimsyEmbedding.mm, so this header stays plain C++ for the generated
 * component registration that includes it.
 */
class nsWhimsyEmbedding final : public nsIWhimsyEmbedding {
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWHIMSYEMBEDDING

 public:
  nsWhimsyEmbedding() = default;

 private:
  ~nsWhimsyEmbedding() = default;
};

}  // namespace whimsy

#endif
