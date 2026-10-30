/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_nsWhimsyCalendar_h_
#define mozilla_nsWhimsyCalendar_h_

#include "nsIWhimsyCalendar.h"

#define WHIMSY_CALENDAR_CONTRACTID "@whimsy/calendar;1"

namespace whimsy {

/**
 * @brief Implementation of nsIWhimsyCalendar over EventKit. The event store
 * itself lives in nsWhimsyCalendar.mm, so this header stays plain C++ for
 * the generated component registration that includes it.
 */
class nsWhimsyCalendar final : public nsIWhimsyCalendar {
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWHIMSYCALENDAR

 public:
  nsWhimsyCalendar() = default;

 private:
  ~nsWhimsyCalendar() = default;
};

}  // namespace whimsy

#endif
