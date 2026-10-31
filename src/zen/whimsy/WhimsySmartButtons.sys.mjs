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
      if (!isEnabled) {
        document.documentElement.setAttribute("whimsy-smart-buttons", "false");
        const dlBtn = document.getElementById("downloads-button");
        if (dlBtn) {
          dlBtn.hidden = true;
        }
        const pipBtn = document.getElementById("picture-in-picture-button");
        if (pipBtn && pipBtn.hasAttribute("whimsy-audio-playing")) {
          pipBtn.removeAttribute("whimsy-audio-playing");
          pipBtn.hidden = true;
        }
      } else {
        document.documentElement.removeAttribute("whimsy-smart-buttons");
        this.updateButtons(win);
      }
    };

    // Ensure Firefox PiP urlbar button pref & downloads autohide are active
    if (this.enabled) {
      try {
        if (!Services.prefs.getBoolPref(PIP_URLBAR_PREF, false)) {
          Services.prefs.setBoolPref(PIP_URLBAR_PREF, true);
        }
        if (!Services.prefs.getBoolPref(DOWNLOADS_AUTOHIDE_PREF, false)) {
          Services.prefs.setBoolPref(DOWNLOADS_AUTOHIDE_PREF, true);
        }
      } catch (e) {
        console.error("WhimsySmartButtons: error setting helper prefs", e);
      }
    }

    // Place downloads button beside the address bar
    this.setupDownloadsButton(win);

    // Setup media & audio observation
    this.setupMediaListeners(win);

    // Setup download progress listener for smart downloads visibility
    this.setupDownloadListeners(win);

    // Update on tab switch or page load
    const updateHandler = () => {
      if (this.enabled) {
        this.updateButtons(win);
      }
    };
    gBrowser.tabContainer.addEventListener("TabSelect", updateHandler);
    gBrowser.tabContainer.addEventListener("TabAttrModified", updateHandler);
    win.addEventListener("pageshow", updateHandler);

    const prefObserver = () => syncState();
    Services.prefs.addObserver(FEATURE_PREF, prefObserver);

    win.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(FEATURE_PREF, prefObserver);
        gBrowser.tabContainer.removeEventListener("TabSelect", updateHandler);
        gBrowser.tabContainer.removeEventListener("TabAttrModified", updateHandler);
        win.removeEventListener("pageshow", updateHandler);
      },
      { once: true }
    );

    syncState();
  },

  setupDownloadsButton(win) {
    const { document } = win;
    const dlBtn = document.getElementById("downloads-button");
    const urlbarContainer = document.getElementById("urlbar-container");
    if (dlBtn && urlbarContainer && dlBtn.previousElementSibling != urlbarContainer) {
      urlbarContainer.after(dlBtn);
    }
  },

  async setupDownloadListeners(win) {
    try {
      const list = await lazy.Downloads.getList(lazy.Downloads.ALL);
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
    const { document } = win;
    const dlBtn = document.getElementById("downloads-button");
    if (!dlBtn) {
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

  setupMediaListeners(win) {
    const { document, gBrowser } = win;
    const pipBtn = document.getElementById("picture-in-picture-button");
    if (!pipBtn) {
      return;
    }

    pipBtn.addEventListener(
      "click",
      event => {
        if (!this.enabled) {
          return;
        }
        // If audio playing mode without video PiP, toggle audio mute on click
        if (pipBtn.hasAttribute("whimsy-audio-playing")) {
          const browser = gBrowser.selectedBrowser;
          const tab = gBrowser.selectedTab;
          const count = lazy.PictureInPicture.getEligiblePipVideoCount(browser);
          if (!count || count.totalPipCount === 0) {
            event.stopPropagation();
            event.preventDefault();
            if (browser?.browsingContext?.mediaController) {
              const mc = browser.browsingContext.mediaController;
              if (mc.isPlaying) {
                mc.pause();
              } else {
                mc.play();
              }
            } else if (tab) {
              tab.toggleMuteAudio();
            }
          }
        }
      },
      true
    );
  },

  updateButtons(win) {
    const { document, gBrowser } = win;
    const browser = gBrowser.selectedBrowser;
    const tab = gBrowser.selectedTab;
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

    // 2. Picture-in-Picture / Media Button:
    const pipBtn = document.getElementById("picture-in-picture-button");
    if (pipBtn) {
      const pipCount = lazy.PictureInPicture.getEligiblePipVideoCount(browser);
      const hasPipVideo = Boolean(pipCount && pipCount.totalPipCount > 0);
      const isPipActive = Boolean(lazy.PictureInPicture.getPanelForBrowser?.(browser));
      const isSoundPlaying = Boolean(tab?.soundplaying);
      const isMuted = Boolean(tab?.muted);

      if (hasPipVideo || isPipActive) {
        pipBtn.removeAttribute("hidden");
        pipBtn.removeAttribute("whimsy-audio-playing");
      } else if (isSoundPlaying || isMuted) {
        pipBtn.removeAttribute("hidden");
        pipBtn.setAttribute("whimsy-audio-playing", "true");
        pipBtn.toggleAttribute("muted", isMuted);
      } else if (!hasPipVideo && !isPipActive && !isSoundPlaying && !isMuted) {
        pipBtn.removeAttribute("whimsy-audio-playing");
        pipBtn.removeAttribute("muted");
        pipBtn.setAttribute("hidden", "true");
      }
    }
  },

  registerCommands(win) {
    const { WhimsyCommands } = lazy;

    // Toggle Reader View command
    WhimsyCommands.register(win, {
      id: "cmd_whimsyToggleReader",
      l10nId: "whimsy-action-toggle-reader",
      run: w => {
        const btn = w.document.getElementById("reader-mode-button");
        if (btn && (!btn.hidden || btn.hasAttribute("readeractive"))) {
          w.AboutReaderParent?.toggleReaderMode(new w.Event("command"));
        } else if (w.gBrowser?.selectedBrowser?.isArticle) {
          w.AboutReaderParent?.toggleReaderMode(new w.Event("command"));
        }
      },
      keyId: "key_whimsyToggleReader",
      key: { key: "r", modifiers: "accel,alt" },
    });

    // Translate Page command
    WhimsyCommands.register(win, {
      id: "cmd_whimsyTranslatePage",
      l10nId: "whimsy-action-translate-page",
      run: w => {
        w.FullPageTranslationsPanel?.open(new w.Event("command"));
      },
      keyId: "key_whimsyTranslatePage",
    });

    // Media / Picture-in-Picture command
    WhimsyCommands.register(win, {
      id: "cmd_whimsyToggleMedia",
      l10nId: "whimsy-action-media-pip",
      run: w => {
        const browser = w.gBrowser.selectedBrowser;
        const tab = w.gBrowser.selectedTab;
        const count = lazy.PictureInPicture.getEligiblePipVideoCount(browser);
        if (count?.totalPipCount > 0 || lazy.PictureInPicture.getPanelForBrowser?.(browser)) {
          w.PictureInPicture.toggleUrlbar(new w.Event("command"));
        } else if (browser?.browsingContext?.mediaController) {
          const mc = browser.browsingContext.mediaController;
          if (mc.isPlaying) {
            mc.pause();
          } else {
            mc.play();
          }
        } else if (tab?.soundplaying || tab?.muted) {
          tab.toggleMuteAudio();
        }
      },
      keyId: "key_whimsyToggleMedia",
    });

    // Downloads command
    WhimsyCommands.register(win, {
      id: "cmd_whimsyDownloads",
      l10nId: "whimsy-action-downloads",
      run: w => {
        w.DownloadsPanel?.showPanel();
      },
      keyId: "key_whimsyDownloads",
    });
  },
};
