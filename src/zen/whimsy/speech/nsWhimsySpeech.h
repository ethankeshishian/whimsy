/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_nsWhimsySpeech_h_
#define mozilla_nsWhimsySpeech_h_

#include "nsIWhimsySpeech.h"

#define WHIMSY_SPEECH_CONTRACTID "@whimsy/speech;1"

namespace whimsy {

/**
 * @brief Implementation of nsIWhimsySpeech over the Speech framework
 * (SFSpeechRecognizer, on-device only). Sessions and everything
 * Objective-C live in nsWhimsySpeech.mm, so this header stays plain C++ for
 * the generated component registration that includes it.
 */
class nsWhimsySpeech final : public nsIWhimsySpeech {
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWHIMSYSPEECH

 public:
  nsWhimsySpeech() = default;

 private:
  ~nsWhimsySpeech() = default;
};

}  // namespace whimsy

#endif
