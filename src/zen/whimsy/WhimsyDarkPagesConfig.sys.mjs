/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const DARK_PAGES_KEY = "Whimsy:DarkPages";

// Content-process state shared with ZenBoostsChild through the overlay hook.
// Keep the authored boost separate so turning adaptation off restores it.
const contexts = new Map();

export function beginDarkPage(context) {
  const previous = contexts.get(context.id);
  const record = {
    context,
    original: previous?.original ?? context.isZenBoostsInverted,
    originalScheme: previous?.originalScheme ?? context.prefersColorSchemeOverride,
    active: false,
  };
  contexts.set(context.id, record);
  setAdaptiveDarkPage(record, false);
  return record;
}

export function setAdaptiveDarkPage(record, active) {
  if (contexts.get(record.context.id) != record) {
    return;
  }
  record.active = active;
  const value = active || record.original;
  if (!record.context.isDiscarded && record.context.isZenBoostsInverted != value) {
    record.context.isZenBoostsInverted = value;
  }
}

// Called by Zen's existing synced-field setter, including its asynchronous
// no-boost response. A late boost lookup must not erase adaptation.
export function darkPagesInversion(context, authored) {
  const record = contexts.get(context.id);
  if (!record) {
    return authored;
  }
  record.original = authored;
  return record.active || authored;
}

export function endDarkPage(record) {
  if (contexts.get(record.context.id) == record) {
    setAdaptiveDarkPage(record, false);
    if (!record.context.isDiscarded && record.context.prefersColorSchemeOverride != record.originalScheme) {
      record.context.prefersColorSchemeOverride = record.originalScheme;
    }
    contexts.delete(record.context.id);
  }
}
