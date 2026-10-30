/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5/profiles: a process script (Services.ppmm.loadProcessScript, from
// WhimsySpaceExtensions) that keeps an extension's content scripts out of
// the pages of profiles it isn't allowed in. Gecko's C++
// (ExtensionPolicyService::ProcessScript) calls
// ExtensionProcessScript.loadContentScript on this process's shared module
// object through XPConnect, which looks the method up on every call, so
// replacing it here covers manifest content scripts, registered ones and
// scripting.executeScript alike. The list is the same
// extensions.userContextIsolation.<id>.restricted pref Firefox's tabs,
// webRequest and proxy APIs already honour.

"use strict";

(function () {
  let module;
  try {
    module = ChromeUtils.importESModule("resource://gre/modules/ExtensionProcessScript.sys.mjs");
  } catch (e) {
    return;
  }
  const { ExtensionProcessScript } = module;
  if (!ExtensionProcessScript || ExtensionProcessScript._whimsyProfiles) {
    return;
  }
  ExtensionProcessScript._whimsyProfiles = true;
  const original = ExtensionProcessScript.loadContentScript;

  function restricted(contentScript, window) {
    if (!Services.prefs.getBoolPref("whimsy.feature.space-extensions", true)) {
      return false;
    }
    const id = contentScript?.extension?.id;
    if (!id) {
      return false;
    }
    const list = Services.prefs.getStringPref(`extensions.userContextIsolation.${id}.restricted`, "");
    if (!list || list == "[]") {
      return false;
    }
    const userContextId = window?.document?.nodePrincipal?.originAttributes?.userContextId ?? 0;
    try {
      return JSON.parse(list).includes(userContextId);
    } catch {
      return false;
    }
  }

  ExtensionProcessScript.loadContentScript = function (contentScript, window) {
    if (restricted(contentScript, window)) {
      return Promise.resolve();
    }
    return original.call(this, contentScript, window);
  };
})();
