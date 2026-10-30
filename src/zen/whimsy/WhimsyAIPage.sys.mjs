/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Feature 2: Ask on Page + Arc's 5-second hover preview summary.
// - Ask on Page: Ask questions grounded in the current page's readable content.
// - Hover Preview Summary: Shift-hover any link (or hover on Google, DDG,
//   Bing, X, Threads, HN) to show a concise summary preview card without navigating.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyHoverCard: "resource:///modules/whimsy/WhimsyHoverCard.sys.mjs",
});

const PREF_ASK_ON_PAGE = "whimsy.feature.ask-on-page";
const PREF_HOVER_PREVIEW = "whimsy.ai.hover-preview";
const MENU_ASK_ID = "context_whimsyAskOnPage";
const BAR_ID = "whimsy-ask-on-page-bar";

export const WhimsyAIPage = {
  initWindow(win) {
    if (!Services.prefs.getBoolPref(PREF_ASK_ON_PAGE, true)) {
      return;
    }
    this.initMenu(win);
  },

  initMenu(win) {
    const { document } = win;
    const menu = document.getElementById("tabContextMenu");
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateMenu(win);
      }
    });
  },

  updateMenu(win) {
    const { document } = win;
    let item = document.getElementById(MENU_ASK_ID);
    const enabled = Services.prefs.getBoolPref(PREF_ASK_ON_PAGE, true) && !lazy.WhimsyAI.blocked;
    if (!enabled) {
      if (item) {
        item.hidden = true;
      }
      return;
    }

    if (!item) {
      item = document.createXULElement("menuitem");
      item.id = MENU_ASK_ID;
      document.l10n.setAttributes(item, "tab-context-whimsy-ask-on-page");
      item.addEventListener("command", () => this.openAskOnPageUI(win));
      const anchor = document.getElementById("context_whimsyTidyTabs") || document.getElementById("context_reloadTab");
      if (anchor) {
        anchor.after(item);
      } else {
        document.getElementById("tabContextMenu")?.appendChild(item);
      }
    }
    item.hidden = false;
  },

  async askOnPage(win, question) {
    if (lazy.WhimsyAI.blocked || !Services.prefs.getBoolPref(PREF_ASK_ON_PAGE, true)) {
      throw new Components.Exception("AI is blocked by kill switch", Cr.NS_ERROR_ABORT);
    }

    const tab = win.gBrowser.selectedTab;
    const browser = tab?.linkedBrowser;
    if (!browser) {
      throw new Error("No active browser tab found");
    }

    const pageText = await this.getPageText(browser);
    if (!pageText || pageText.trim().length < 10) {
      throw new Error("Page has no readable text content");
    }

    const prompt = `You are Ask on Page. Answer the question using ONLY the provided page text. Be concise, accurate, and direct. If the answer cannot be found in the text, state that clearly.

Question: ${question}

Page Text:
${pageText.slice(0, 15000)}`;

    const { text } = await lazy.WhimsyAIProviders.complete({
      system: "You answer questions based strictly on the provided web page text.",
      prompt,
    });
    return text.trim();
  },

  async getPageText(browser) {
    try {
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage");
      if (actor) {
        const res = await actor.sendQuery("Whimsy:ExtractPageText");
        if (res?.text) {
          return res.text;
        }
      }
    } catch (e) {
      console.debug("WhimsyAIPage: getPageText actor error", e);
    }
    return browser.contentTitle || "";
  },

  openAskOnPageUI(win) {
    let bar = win.document.getElementById(BAR_ID);
    if (!bar) {
      bar = win.document.createXULElement("hbox");
      bar.id = BAR_ID;
      bar.className = "whimsy-ask-bar";

      const input = win.document.createElement("input");
      input.id = "whimsy-ask-on-page-input";
      input.placeholder = "Ask a question about this page…";

      const btn = win.document.createXULElement("button");
      btn.id = "whimsy-ask-on-page-submit";
      btn.setAttribute("label", "Ask");

      const resultBox = win.document.createElement("div");
      resultBox.id = "whimsy-ask-on-page-result";

      const closeBtn = win.document.createXULElement("toolbarbutton");
      closeBtn.className = "close-icon";
      closeBtn.addEventListener("command", () => {
        bar.hidden = true;
      });

      const handleAsk = async () => {
        const q = input.value.trim();
        if (!q) {
          return;
        }
        resultBox.textContent = "Finding answer…";
        try {
          const ans = await this.askOnPage(win, q);
          resultBox.textContent = ans;
        } catch (err) {
          resultBox.textContent = "Error: " + err.message;
        }
      };

      btn.addEventListener("command", handleAsk);
      input.addEventListener("keydown", e => {
        if (e.key === "Enter") {
          handleAsk();
        } else if (e.key === "Escape") {
          bar.hidden = true;
        }
      });

      bar.appendChild(input);
      bar.appendChild(btn);
      bar.appendChild(resultBox);
      bar.appendChild(closeBtn);

      const navBar = win.document.getElementById("nav-bar");
      if (navBar) {
        navBar.after(bar);
      } else {
        win.document.documentElement.appendChild(bar);
      }
    }
    bar.hidden = false;
    win.document.getElementById("whimsy-ask-on-page-input")?.focus();
  },

  async summarizeLink(url) {
    if (lazy.WhimsyAI.blocked || !Services.prefs.getBoolPref(PREF_HOVER_PREVIEW, true)) {
      return null;
    }
    try {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) {
        return null;
      }
      const html = await response.text();
      const cleanText = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
                            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
                            .replace(/<[^>]+>/g, " ")
                            .replace(/\s+/g, " ")
                            .trim();

      const prompt = `Summarize this web page destination in 2 to 3 concise bullet points for a quick 5-second hover preview card. Maximum 40 words total.\n\nContent:\n${cleanText.slice(0, 8000)}`;

      const { text } = await lazy.WhimsyAIProviders.complete({
        system: "You write brief 2-3 bullet point summaries of web pages.",
        prompt,
      });
      return text.trim();
    } catch (e) {
      console.debug("WhimsyAIPage: summarizeLink error", e);
      return null;
    }
  },

  onLinkHover(win, browser, data) {
    if (lazy.WhimsyAI.blocked || !Services.prefs.getBoolPref(PREF_HOVER_PREVIEW, true)) {
      return;
    }
    const card = lazy.WhimsyHoverCard.forWindow(win);
    const screen = {
      x: Math.max(win.screenX, Math.min(Number(data.x) || 0, win.screenX + win.outerWidth - 320)),
      y: Math.max(win.screenY, Math.min((Number(data.y) || 0) + 16, win.screenY + win.outerHeight - 200)),
    };
    card.schedule(
      browser,
      async () => {
        const summary = await this.summarizeLink(data.url);
        if (!summary) {
          return null;
        }
        return {
          title: data.url,
          url: data.url,
          description: summary,
          screen,
        };
      },
      PREF_HOVER_PREVIEW
    );
  },

  onLinkLeave(win, browser) {
    const card = lazy.WhimsyHoverCard.forWindow(win);
    card.leave(browser);
  },
};
