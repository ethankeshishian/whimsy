/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave9: W9-06 Smart address bar buttons (Lens/Arc parity).
// Reader, Translate, media (PiP / audio playback) and Downloads in progress
// appear beside the address bar only when relevant, reusing existing
// Firefox/Zen buttons (reader-mode-button, translations-button,
// picture-in-picture-button, downloads-button, page actions pill).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  PictureInPicture: "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.smart-buttons";
const PIP_URLBAR_PREF = "media.videocontrols.picture-in-picture.urlbar-button.enabled";
const DOWNLOADS_AUTOHIDE_PREF = "browser.download.autohideButton";

export const WhimsySmartButtons = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    const { document, gBrowser } = win;
    if (!document || !gBrowser) {
      return;
    }

    // Register user commands in WhimsyCommands registry with assignable shortcuts
    this.registerCommands(win);

    // Apply root attribute for CSS styling
    const syncState = () => {
      const isEnabled = this.enabled;
      document.documentElement.toggleAttribute("whimsy-smart-buttons", isEnabled);
      if (isEnabled) {
        this.updateButtons(win);
      }
    };

    // Setup download progress listener for smart downloads visibility
    this.setupDownloadListeners(win);

    // Update on tab switch or page load
    const updateHandler = () => {
      if (this.enabled) {
        this.updateButtons(win);
      }
    };
    gBrowser.tabContainer?.addEventListener("TabSelect", updateHandler);
    gBrowser.tabContainer?.addEventListener("TabAttrModified", updateHandler);
    win.addEventListener("pageshow", updateHandler);

    const prefObserver = () => syncState();
    Services.prefs.addObserver(FEATURE_PREF, prefObserver);

    win.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(FEATURE_PREF, prefObserver);
        gBrowser.tabContainer?.removeEventListener("TabSelect", updateHandler);
        gBrowser.tabContainer?.removeEventListener("TabAttrModified", updateHandler);
        win.removeEventListener("pageshow", updateHandler);
      },
      { once: true }
    );

    syncState();
  },

  async setupDownloadListeners(win) {
    try {
      const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
      const list = await lazy.Downloads.getList(isPrivate ? lazy.Downloads.ALL : lazy.Downloads.PUBLIC);
      if (win.closed) {
        return;
      }
      const updateDl = () => {
        if (!this.enabled || win.closed) {
          return;
        }
        this.updateDownloadsButton(win, list);
      };
      const view = {
        onDownloadAdded: updateDl,
        onDownloadChanged: updateDl,
        onDownloadRemoved: updateDl,
      };
      win.addEventListener("unload", () => list.removeView(view), { once: true });
      list.addView(view);
      updateDl();
    } catch (e) {
      console.error("WhimsySmartButtons: failed to setup download listener", e);
    }
  },

  async updateDownloadsButton(win, list) {
    if (!this.enabled) {
      return;
    }
    const { document } = win;
    const dlBtn = document.getElementById("downloads-button");
    if (!dlBtn) {
      return;
    }
    // Respect user's autohide pref: if the user turned off download-autohide, never hide it
    const autohide = Services.prefs.getBoolPref(DOWNLOADS_AUTOHIDE_PREF, true);
    if (!autohide) {
      dlBtn.removeAttribute("hidden");
      return;
    }
    try {
      const downloads = await list.getAll();
      const inProgress = downloads.some(d => !d.stopped);
      if (inProgress) {
        dlBtn.removeAttribute("hidden");
      } else if (!dlBtn.hasAttribute("notification") && !dlBtn.hasAttribute("animate")) {
        dlBtn.setAttribute("hidden", "true");
      }
    } catch (e) {
      // In case list.getAll() is rejected
    }
  },

  updateButtons(win) {
    if (!this.enabled) {
      return;
    }
    const { document, gBrowser } = win;
    const browser = gBrowser?.selectedBrowser;
    if (!browser) {
      return;
    }

    // 1. Reader Mode Button:
    const readerBtn = document.getElementById("reader-mode-button");
    if (readerBtn) {
      const isArticle = Boolean(browser.isArticle);
      const isReaderActive = readerBtn.hasAttribute("readeractive");
      if (isArticle || isReaderActive) {
        readerBtn.removeAttribute("hidden");
      }
    }

    // 2. Picture-in-Picture Button:
    const pipBtn = document.getElementById("picture-in-picture-button");
    if (pipBtn) {
      const pipPrefEnabled = Services.prefs.getBoolPref(PIP_URLBAR_PREF, true);
      if (pipPrefEnabled) {
        const pipCount = lazy.PictureInPicture.getEligiblePipVideoCount(browser);
        const hasPipVideo = Boolean(pipCount && pipCount.totalPipCount > 0);
        const isPipActive = Boolean(lazy.PictureInPicture.getPanelForBrowser?.(browser));
        if (hasPipVideo || isPipActive) {
          pipBtn.removeAttribute("hidden");
        }
      }
    }
  },

  registerCommands(win) {
    const { WhimsyCommands } = lazy;

    // Translate Page command
    WhimsyCommands.register(win, {
      id: "cmd_whimsyTranslatePage",
      l10nId: "whimsy-action-translate-page",
      icon: "chrome://browser/skin/translations.svg",
      isAvailable: w => {
        const btn = w.document?.getElementById("translations-button");
        if (btn && !btn.hidden) {
          return true;
        }
        if (w.TranslationsParent) {
          return !w.TranslationsParent.isFullPageTranslationsRestrictedForPage(w.gBrowser);
        }
        return false;
      },
      run: w => {
        w.FullPageTranslationsPanel?.open(new w.Event("command"));
      },
      keyId: "key_whimsyTranslatePage",
    });

    // Picture-in-Picture command
    WhimsyCommands.register(win, {
      id: "cmd_whimsyPictureInPicture",
      l10nId: "whimsy-action-picture-in-picture",
      icon: "chrome://global/skin/media/picture-in-picture-open.svg",
      isAvailable: w => {
        const browser = w.gBrowser?.selectedBrowser;
        if (!browser) {
          return false;
        }
        const count = lazy.PictureInPicture.getEligiblePipVideoCount(browser);
        return Boolean((count && count.totalPipCount > 0) || lazy.PictureInPicture.getPanelForBrowser?.(browser));
      },
      run: w => {
        w.PictureInPicture?.toggleUrlbar?.(new w.Event("command"));
      },
      keyId: "key_whimsyPictureInPicture",
    });

    // Play or Pause Media command
    WhimsyCommands.register(win, {
      id: "cmd_whimsyPlayPauseMedia",
      l10nId: "whimsy-action-play-pause-media",
      icon: "chrome://browser/skin/zen-icons/media-unmute.svg",
      isAvailable: w => {
        const browser = w.gBrowser?.selectedBrowser;
        const tab = w.gBrowser?.selectedTab;
        const mc = browser?.browsingContext?.mediaController;
        return Boolean(mc?.hasPlayback || tab?.soundplaying || tab?.muted);
      },
      run: w => {
        const browser = w.gBrowser?.selectedBrowser;
        const mc = browser?.browsingContext?.mediaController;
        if (mc) {
          if (mc.isPlaying) {
            mc.pause();
          } else {
            mc.play();
          }
        } else if (w.gBrowser?.selectedTab) {
          w.gBrowser.selectedTab.toggleMuteAudio();
        }
      },
      keyId: "key_whimsyPlayPauseMedia",
    });
  },
};
