/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AI kill switch: one Settings toggle (whimsy.ai.blocked) that turns off every
// AI feature, like Firefox's "Block AI enhancements" (whose AI Controls pane
// Zen hides). Turning it on blocks each of Firefox's AI features the way
// that pane does (browser.ai.control.* = "blocked", then the feature's own
// block(), which also removes downloaded models) and turns off the ML engine
// and the trial ML API for extensions. Turning it off puts every pref back
// exactly as it was, so Zen's defaults (chatbot and link previews off)
// survive a round trip. Translations stay on: they're on-device and not
// generative, and Whimsy's translate features build on them.
// Whimsy's own AI features must check WhimsyAI.blocked before doing anything.

const PREF = "whimsy.ai.blocked";
const FEATURE_PREF = "whimsy.feature.ai-kill-switch";
const RESTORE_PREF = "whimsy.ai.restore";

// Firefox's AI features (browser/components/preferences/OnDeviceModelManager.mjs),
// minus translations: control pref, module, export, and the prefs block() touches.
const FEATURES = [
  {
    control: "browser.ai.control.sidebarChatbot",
    url: "moz-src:///browser/components/genai/GenAI.sys.mjs",
    name: "GenAI",
    prefs: ["browser.ml.chat.enabled", "browser.ml.chat.page", "browser.ml.chat.provider"],
  },
  {
    control: "browser.ai.control.linkPreviewKeyPoints",
    url: "moz-src:///browser/components/genai/LinkPreview.sys.mjs",
    name: "LinkPreview",
    prefs: ["browser.ml.linkPreview.enabled", "browser.ml.linkPreview.optin"],
  },
  {
    control: "browser.ai.control.smartTabGroups",
    url: "moz-src:///browser/components/tabbrowser/SmartTabGrouping.sys.mjs",
    name: "SmartTabGroupingManager",
    prefs: [
      "browser.tabs.groups.smart.enabled",
      "browser.tabs.groups.smart.userEnabled",
      "browser.tabs.groups.smart.optin",
    ],
  },
  {
    control: "browser.ai.control.pdfjsAltText",
    url: "resource://pdf.js/PdfJsAIFeature.sys.mjs",
    name: "PdfJsGuessAltTextFeature",
    prefs: ["pdfjs.enableGuessAltText", "pdfjs.enableAltTextModelDownload", "pdfjs.enableAltText"],
  },
  {
    control: "browser.ai.control.smartWindow",
    url: "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
    name: "AIWindow",
    prefs: [
      "browser.smartwindow.enabled",
      "browser.smartwindow.tos.consentTime",
      "browser.smartwindow.memories.generateFromConversation",
      "browser.smartwindow.memories.generateFromHistory",
    ],
  },
  {
    control: "browser.ai.control.speechRecognition",
    url: "resource://gre/modules/SpeechRecognitionFeature.sys.mjs",
    name: "SpeechRecognitionFeature",
    prefs: [],
  },
];

const GLOBAL_PREFS = {
  "browser.ai.control.default": "blocked",
  "browser.ml.enable": false,
  "extensions.ml.enabled": false,
};

function allPrefs() {
  return [
    ...Object.keys(GLOBAL_PREFS),
    ...FEATURES.flatMap(feature => [feature.control, ...feature.prefs]),
  ];
}

// A pref's user value, or null when it has none.
function snapshot(pref) {
  if (!Services.prefs.prefHasUserValue(pref)) {
    return null;
  }
  switch (Services.prefs.getPrefType(pref)) {
    case Services.prefs.PREF_BOOL:
      return Services.prefs.getBoolPref(pref);
    case Services.prefs.PREF_INT:
      return Services.prefs.getIntPref(pref);
    default:
      return Services.prefs.getStringPref(pref);
  }
}

function restore(pref, value) {
  if (Services.prefs.prefIsLocked(pref)) {
    return;
  }
  if (value === null) {
    Services.prefs.clearUserPref(pref);
  } else if (typeof value == "boolean") {
    Services.prefs.setBoolPref(pref, value);
  } else if (typeof value == "number") {
    Services.prefs.setIntPref(pref, value);
  } else {
    Services.prefs.setStringPref(pref, value);
  }
}

function setPref(pref, value) {
  if (Services.prefs.prefIsLocked(pref)) {
    return;
  }
  if (typeof value == "boolean") {
    Services.prefs.setBoolPref(pref, value);
  } else {
    Services.prefs.setStringPref(pref, value);
  }
}

export const WhimsyAI = {
  PREF,
  FEATURES,

  // True when the user turned AI off. Every Whimsy AI feature checks this.
  get blocked() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(PREF, false);
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    const update = () => {
      this.pending = this.apply().catch(e => console.error("Whimsy: AI kill switch", e));
    };
    Services.prefs.addObserver(PREF, update);
    Services.prefs.addObserver(FEATURE_PREF, update);
    // Only does work when the switch changed while Whimsy was closed.
    update();
  },

  // Resolves once every AI feature matches the switch.
  async apply() {
    const applied = Services.prefs.prefHasUserValue(RESTORE_PREF);
    if (this.blocked && !applied) {
      await this.blockAll();
    } else if (!this.blocked && applied) {
      this.restoreAll();
    }
  },

  async blockAll() {
    const saved = Object.fromEntries(allPrefs().map(pref => [pref, snapshot(pref)]));
    Services.prefs.setStringPref(RESTORE_PREF, JSON.stringify(saved));
    for (const [pref, value] of Object.entries(GLOBAL_PREFS)) {
      setPref(pref, value);
    }
    for (const feature of FEATURES) {
      if (Services.prefs.prefIsLocked(feature.control)) {
        continue; // Managed by policy.
      }
      setPref(feature.control, "blocked");
      try {
        const module = ChromeUtils.importESModule(feature.url);
        await module[feature.name].block();
      } catch (e) {
        // A feature this build doesn't have; its control pref still says blocked.
      }
      // block() may set prefs to values of its own; make sure it's off.
      setPref(feature.control, "blocked");
    }
  },

  restoreAll() {
    let saved = {};
    try {
      saved = JSON.parse(Services.prefs.getStringPref(RESTORE_PREF, "{}"));
    } catch (e) {}
    for (const pref of allPrefs()) {
      restore(pref, pref in saved ? saved[pref] : null);
    }
    Services.prefs.clearUserPref(RESTORE_PREF);
  },
};
