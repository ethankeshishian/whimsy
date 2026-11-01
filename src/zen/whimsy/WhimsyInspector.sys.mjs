/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave9: Inspector (Font Inspector & Element Inspector Lite).
//
// W9-01: Font Inspector ("What Font Is This?"):
// On highlighted text (right-click item registered with Menus settings,
// command bar action, assignable shortcut), shows a clean popover with
// font family (the face actually rendered, not just the CSS stack), size,
// weight, line height, letter spacing, and colour (hex, copyable, with swatch).
// Each value copies on click. Works in content via a JSWindowActor; never
// writes private pages' data to storage.
//
// W9-02: Element Inspector lite:
// Pick an element to inspect its box model (margin, border, padding, content),
// colours, and text-contrast ratio (WCAG pass/fail). Hold Option or select two
// elements to measure the distance/gap between them. Shares the element picker
// with Zap and W9-01. Includes "Open in DevTools" link.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  DevToolsShim: "chrome://devtools-startup/content/DevToolsShim.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "ClipboardHelper", () =>
  Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper)
);
ChromeUtils.defineLazyGetter(lazy, "l10n", () =>
  new Localization(["browser/whimsy.ftl"], true)
);

const FONT_FEATURE_PREF = "whimsy.feature.font-inspector";
const ELEMENT_FEATURE_PREF = "whimsy.feature.element-inspector";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const PANEL_SHEET = "chrome://browser/content/whimsy/whimsy-inspector.css";

export const WhimsyInspector = {
  _sessionInitialized: false,
  _sheetLoaded: new WeakSet(),
  _activePickers: new WeakMap(),
  _lastInspectedFont: null,

  get fontInspectorEnabled() {
    return Services.prefs.getBoolPref(FONT_FEATURE_PREF, true);
  },

  get elementInspectorEnabled() {
    return Services.prefs.getBoolPref(ELEMENT_FEATURE_PREF, true);
  },

  get enabled() {
    return this.fontInspectorEnabled || this.elementInspectorEnabled;
  },

  initSession() {
    if (this._sessionInitialized) {
      return;
    }
    this._sessionInitialized = true;
    try {
      ChromeUtils.registerWindowActor("WhimsyInspector", {
        parent: { esModuleURI: "resource:///modules/whimsy/WhimsyInspectorParent.sys.mjs" },
        child: { esModuleURI: "resource:///modules/whimsy/WhimsyInspectorChild.sys.mjs" },
        matches: ["https://*/*", "http://*/*", "file:///*"],
        allFrames: true,
        safeForUntrustedWebProcess: true,
      });
    } catch (e) {
      // Actor might already be registered in this session.
    }
  },

  // The page's inspector actor, or null where it can't run (about: pages,
  // which the actor's matches leave out).
  actorFor(browser) {
    try {
      return browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyInspector") ?? null;
    } catch (e) {
      return null;
    }
  },

  initWindow(win) {
    this.initSession();
    const { document } = win;

    // Register commands in WhimsyCommands
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyInspectFont",
      l10nId: "whimsy-action-inspect-font",
      run: w => this.inspectFont(w),
      icon: "chrome://browser/skin/zen-icons/signature.svg",
      isAvailable: w => this.fontInspectorEnabled,
    });

    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsySearchFont",
      l10nId: "whimsy-action-search-font",
      run: w => this.searchFont(w),
      icon: "chrome://browser/skin/zen-icons/search-glass.svg",
      isAvailable: w => this.fontInspectorEnabled,
    });

    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyInspectElement",
      l10nId: "whimsy-action-inspect-element",
      whimsyKeywords: lazy.WhimsyCommands.keywords("whimsy-keywords-inspect-element"),
      run: w => this.togglePicker(w, "element"),
      icon: "chrome://browser/skin/zen-icons/developer.svg",
      isAvailable: w => this.elementInspectorEnabled,
    });

    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyMeasureGap",
      l10nId: "whimsy-action-measure-gap",
      run: w => this.togglePicker(w, "measure"),
      icon: "chrome://browser/skin/zen-icons/developer.svg",
      isAvailable: w => this.elementInspectorEnabled,
    });

    // Content area context menu item for highlighted text
    const menu = document.getElementById("contentAreaContextMenu");
    if (menu) {
      const item = document.createXULElement("menuitem");
      item.id = "context-whimsy-inspect-font";
      item.hidden = true;
      document.l10n.setAttributes(item, "whimsy-context-inspect-font");
      item.setAttribute("command", "cmd_whimsyInspectFont");
      item.addEventListener("command", () => {
        this.inspectFont(win);
      });

      menu.addEventListener("popupshowing", event => {
        if (event.target != menu) {
          return;
        }
        const context = win.gContextMenu;
        const selection = !!context?.isContentSelected && !context.onTextInput;
        item.hidden = !this.fontInspectorEnabled || !context || !selection;
        if (item.hidden) {
          return;
        }
        const anchor = document.getElementById("context-inspect") || document.getElementById("context-copy");
        if (anchor && anchor.nextElementSibling != item) {
          anchor.after(item);
        }
      });
      menu.append(item);

      // W10-45: the user couldn't find Element Info (only in Tools ▸ Browser
      // Tools and the command bar). Right-click any element → Element Info,
      // beside Firefox's Inspect, opens it on that element. Settings → Menus
      // can turn it off.
      const info = document.createXULElement("menuitem");
      info.id = "context-whimsy-element-info";
      info.hidden = true;
      document.l10n.setAttributes(info, "whimsy-context-element-info");
      info.addEventListener("command", () => this.inspectContextElement(win));
      menu.addEventListener("popupshowing", event => {
        if (event.target != menu) {
          return;
        }
        const context = win.gContextMenu;
        info.hidden =
          !this.elementInspectorEnabled ||
          !context ||
          !!context.onTextInput ||
          !this.actorFor(context.browser);
        if (info.hidden) {
          return;
        }
        const anchor =
          document.getElementById("context-inspect-a11y") ||
          document.getElementById("context-inspect") ||
          document.getElementById("context-whimsy-inspect-font");
        if (anchor && anchor.nextElementSibling != info) {
          anchor.after(info);
        }
      });
      menu.append(info);
    }
  },

  // W10-45: Element Info on the element that was right-clicked (in its own
  // frame); the picker when it can't be found.
  async inspectContextElement(win) {
    if (!this.elementInspectorEnabled) {
      return;
    }
    const context = win.gContextMenu;
    const frame = context?.frameBrowsingContext ?? context?.browser?.browsingContext;
    let data = null;
    try {
      const actor = frame?.currentWindowGlobal?.getActor("WhimsyInspector");
      data = await actor?.sendQuery("Whimsy:InspectContextTarget", { target: context.targetIdentifier });
    } catch (e) {
      // A page the inspector can't run in, or one going away.
    }
    if (data) {
      this.showElementPopover(win, data);
    } else {
      this.startPicker(win, "element");
    }
  },

  // Inspect font: inspects selected text immediately, or starts element picker if no selection.
  async inspectFont(win) {
    if (!this.fontInspectorEnabled) {
      return;
    }
    const browser = win.gBrowser?.selectedBrowser;
    const actor = this.actorFor(browser);
    if (!actor) {
      return;
    }

    try {
      const result = await actor.sendQuery("Whimsy:InspectFontSelection");
      if (result && result.renderedFont) {
        this.showFontPopover(win, result);
        return;
      }
    } catch (e) {}

    // No text highlighted: start picker in font inspection mode
    this.startPicker(win, "font");
  },

  // Search for the rendered font name in a new tab next to current one
  async searchFont(win, fontName = null) {
    if (!this.fontInspectorEnabled) {
      return;
    }
    const openPanel = win.document?.getElementById("whimsy-font-inspector-panel");
    if (openPanel) {
      lazy.WhimsyPanels.close(openPanel);
    }

    let font = fontName || this._lastInspectedFont?.renderedFont;
    if (!font) {
      const browser = win.gBrowser?.selectedBrowser;
      const actor = this.actorFor(browser);
      if (actor) {
        try {
          const result = await actor.sendQuery("Whimsy:InspectFontSelection");
          if (result?.renderedFont) {
            font = result.renderedFont;
          }
        } catch (e) {}
      }
    }
    if (!font) {
      return;
    }
    await this.performFontSearch(win, font);
  },

  async performFontSearch(win, fontName) {
    if (!fontName) {
      return;
    }
    const isPrivate =
      lazy.PrivateBrowsingUtils.isWindowPrivate(win) ||
      lazy.WhimsyPrivate.isPrivateTab?.(win.gBrowser?.selectedTab);

    let url = null;
    try {
      await lazy.SearchService.init();
      const engine = isPrivate
        ? (await lazy.SearchService.getDefaultPrivate()) || (await lazy.SearchService.getDefault())
        : await lazy.SearchService.getDefault();
      const submission = engine?.getSubmission(fontName);
      if (submission?.uri?.spec) {
        url = submission.uri.spec;
      }
    } catch (e) {}

    if (!url) {
      url = `https://www.google.com/search?q=${encodeURIComponent(fontName)}`;
    }

    lazy.WhimsyPrivate.openTabFor(win, url, { relatedToCurrent: true });
  },

  // The popovers' styles live in whimsy-inspector.css, which nothing else
  // loads into the browser window: load it once per window, on first use.
  _loadSheet(win) {
    if (this._sheetLoaded.has(win)) {
      return;
    }
    this._sheetLoaded.add(win);
    try {
      win.windowUtils.loadSheetUsingURIString(PANEL_SHEET, win.windowUtils.AUTHOR_SHEET);
    } catch (e) {
      console.error("Whimsy: inspector sheet", e);
    }
  },

  // Display the Font Inspector popover matching Whimsy's panel styling.
  showFontPopover(win, data, anchor = null) {
    if (!data) {
      return;
    }
    this._loadSheet(win);
    this._lastInspectedFont = data;
    const { document: doc } = win;

    const { panel, body } = lazy.WhimsyPanels.create(win, {
      id: "whimsy-font-inspector-panel",
      titleL10nId: "whimsy-font-inspector-title",
      size: "small",
    });
    panel.classList.add("whimsy-font-inspector-panel");

    const copyValue = (value, label = "") => {
      if (!value) {
        return;
      }
      lazy.ClipboardHelper.copyString(value);
      try {
        this.showToast(win, "whimsy-font-copied-toast", { value: label || value });
      } catch (e) {}
    };

    // Hero Font Face Card (accessible button for keyboard navigation and copying)
    const card = doc.createElementNS(HTML_NS, "button");
    card.type = "button";
    card.className = "whimsy-font-face-card whimsy-sheet-item";
    const [cardHintMsg] = lazy.l10n.formatMessagesSync([{ id: "whimsy-font-card-copy-hint" }]);
    const cardTitle = cardHintMsg?.attributes?.find(a => a.name === "title")?.value || "";
    if (cardTitle) {
      card.title = cardTitle;
    }
    doc.l10n.setAttributes(card, "whimsy-font-card-copy-hint");
    card.addEventListener("click", () => copyValue(data.renderedFont));

    const headRow = doc.createElementNS(HTML_NS, "div");
    headRow.className = "whimsy-font-header-row";

    const name = doc.createElementNS(HTML_NS, "span");
    name.className = "whimsy-font-family-name";
    name.textContent = data.renderedFont;

    const badge = doc.createElementNS(HTML_NS, "span");
    badge.className = "whimsy-font-rendered-badge";
    badge.textContent = lazy.l10n.formatValueSync("whimsy-font-rendered-badge");
    doc.l10n.setAttributes(badge, "whimsy-font-rendered-badge");

    headRow.append(name, badge);

    const preview = doc.createElementNS(HTML_NS, "div");
    preview.className = "whimsy-font-preview";
    preview.style.fontFamily = `"${data.renderedFont}", ${data.cssStack}`;
    preview.style.fontWeight = data.weight;
    preview.textContent = data.previewText || lazy.l10n.formatValueSync("whimsy-font-sample-text");

    const stack = doc.createElementNS(HTML_NS, "div");
    stack.className = "whimsy-font-css-stack";
    stack.textContent = data.cssStack;

    card.append(headRow, preview, stack);
    body.append(card);

    // Metric rows list (Each value copies on click)
    const list = doc.createElementNS(HTML_NS, "div");
    list.className = "whimsy-font-props-list";

    const addPropRow = (l10nId, value, copyVal = value, isColor = false) => {
      const row = doc.createElementNS(HTML_NS, "button");
      row.type = "button";
      row.className = "whimsy-font-prop-row whimsy-sheet-item";
      const [propHintMsg] = lazy.l10n.formatMessagesSync([{ id: "whimsy-font-prop-copy-hint", args: { value } }]);
      const propTitle = propHintMsg?.attributes?.find(a => a.name === "title")?.value || "";
      if (propTitle) {
        row.title = propTitle;
      }
      doc.l10n.setAttributes(row, "whimsy-font-prop-copy-hint", { value });

      const lbl = doc.createElementNS(HTML_NS, "span");
      lbl.className = "whimsy-font-prop-label";
      lbl.textContent = lazy.l10n.formatValueSync(l10nId);
      doc.l10n.setAttributes(lbl, l10nId);

      const val = doc.createElementNS(HTML_NS, "span");
      val.className = "whimsy-font-prop-value";

      if (isColor) {
        const chip = doc.createElementNS(HTML_NS, "span");
        chip.className = "whimsy-color-chip";
        const swatch = doc.createElementNS(HTML_NS, "span");
        swatch.className = "whimsy-color-swatch";
        swatch.style.backgroundColor = copyVal;
        chip.append(swatch, doc.createTextNode(value));
        val.append(chip);
      } else {
        val.textContent = value;
      }

      const hint = doc.createElementNS(HTML_NS, "span");
      hint.className = "whimsy-copy-hint";
      hint.textContent = lazy.l10n.formatValueSync("whimsy-font-copy-hint");
      doc.l10n.setAttributes(hint, "whimsy-font-copy-hint");
      val.append(hint);

      row.append(lbl, val);
      row.addEventListener("click", () => copyValue(copyVal, value));
      list.append(row);
    };

    addPropRow("whimsy-font-size-label", data.size);
    addPropRow("whimsy-font-weight-label", data.weight);
    addPropRow("whimsy-font-line-height-label", data.lineHeight || "normal");
    addPropRow("whimsy-font-letter-spacing-label", data.letterSpacing || "normal");
    addPropRow("whimsy-font-color-label", data.colorHex, data.colorHex, true);

    body.append(list);

    // Actions footer
    const actions = doc.createElementNS(HTML_NS, "div");
    actions.className = "whimsy-inspector-actions";

    const copyCssBtn = doc.createElementNS(HTML_NS, "button");
    copyCssBtn.className = "whimsy-inspector-button primary";
    copyCssBtn.textContent = lazy.l10n.formatValueSync("whimsy-font-copy-css");
    doc.l10n.setAttributes(copyCssBtn, "whimsy-font-copy-css");
    copyCssBtn.addEventListener("click", () => {
      const css =
        `font-family: "${data.renderedFont}", ${data.cssStack};\n` +
        `font-size: ${data.size};\n` +
        `font-weight: ${data.weight};\n` +
        `line-height: ${data.lineHeight || "normal"};\n` +
        `letter-spacing: ${data.letterSpacing || "normal"};\n` +
        `color: ${data.colorHex};`;
      copyValue(css, lazy.l10n.formatValueSync("whimsy-font-css-label"));
    });

    const searchFontBtn = doc.createElementNS(HTML_NS, "button");
    searchFontBtn.className = "whimsy-inspector-button";
    searchFontBtn.textContent = lazy.l10n.formatValueSync("whimsy-font-search-button");
    doc.l10n.setAttributes(searchFontBtn, "whimsy-font-search-button");
    searchFontBtn.addEventListener("click", () => {
      this.searchFont(win, data.renderedFont);
    });

    const inspectElementBtn = doc.createElementNS(HTML_NS, "button");
    inspectElementBtn.className = "whimsy-inspector-button";
    inspectElementBtn.textContent = lazy.l10n.formatValueSync("whimsy-font-inspect-element");
    doc.l10n.setAttributes(inspectElementBtn, "whimsy-font-inspect-element");
    inspectElementBtn.addEventListener("click", () => {
      lazy.WhimsyPanels.close(panel);
      if (data.selector) {
        this.inspectElementBySelector(win, data.selector);
      } else {
        this.startPicker(win, "element");
      }
    });

    actions.append(copyCssBtn, searchFontBtn, inspectElementBtn);
    body.append(actions);

    lazy.WhimsyPanels.open(win, panel, { anchor });
  },

  // Display the Element Inspector popover matching Whimsy's panel styling.
  showElementPopover(win, data, anchor = null) {
    if (!data) {
      return;
    }
    this._loadSheet(win);
    const { document: doc } = win;

    const { panel, body } = lazy.WhimsyPanels.create(win, {
      id: "whimsy-element-inspector-panel",
      titleL10nId: "whimsy-element-inspector-title",
      size: "medium",
    });
    panel.classList.add("whimsy-element-inspector-panel");

    // Header selector chip
    const headerBox = doc.createElementNS(HTML_NS, "div");
    headerBox.className = "whimsy-element-header-box";
    headerBox.title = data.selector;

    const tag = doc.createElementNS(HTML_NS, "span");
    tag.className = "whimsy-element-tag";
    tag.textContent = `<${data.tagName || data.selector}>`;
    tag.title = data.selector;

    const dims = doc.createElementNS(HTML_NS, "span");
    dims.className = "whimsy-element-dims";
    dims.textContent = `${data.boxModel.width} × ${data.boxModel.height}px`;

    headerBox.append(tag, dims);
    body.append(headerBox);

    // Box Model Heading & Diagram
    const boxModelHeading = doc.createElementNS(HTML_NS, "div");
    boxModelHeading.className = "whimsy-inspector-section-heading";
    boxModelHeading.textContent = lazy.l10n.formatValueSync("whimsy-element-box-model");
    doc.l10n.setAttributes(boxModelHeading, "whimsy-element-box-model");
    body.append(boxModelHeading);

    const boxModelWrap = doc.createElementNS(HTML_NS, "div");
    boxModelWrap.className = "whimsy-box-model-container";

    const bm = data.boxModel;

    const marginBox = doc.createElementNS(HTML_NS, "div");
    marginBox.className = "whimsy-box-margin";

    const marginLabel = doc.createElementNS(HTML_NS, "span");
    marginLabel.className = "whimsy-box-label";
    marginLabel.textContent = lazy.l10n.formatValueSync("whimsy-element-margin-box");
    doc.l10n.setAttributes(marginLabel, "whimsy-element-margin-box");
    const mTop = doc.createElementNS(HTML_NS, "span");
    mTop.className = "whimsy-box-val-top";
    mTop.textContent = bm.margin.top;
    const mBottom = doc.createElementNS(HTML_NS, "span");
    mBottom.className = "whimsy-box-val-bottom";
    mBottom.textContent = bm.margin.bottom;
    const mLeft = doc.createElementNS(HTML_NS, "span");
    mLeft.className = "whimsy-box-val-left";
    mLeft.textContent = bm.margin.left;
    const mRight = doc.createElementNS(HTML_NS, "span");
    mRight.className = "whimsy-box-val-right";
    mRight.textContent = bm.margin.right;

    const borderBox = doc.createElementNS(HTML_NS, "div");
    borderBox.className = "whimsy-box-border";
    const borderLabel = doc.createElementNS(HTML_NS, "span");
    borderLabel.className = "whimsy-box-label";
    borderLabel.textContent = lazy.l10n.formatValueSync("whimsy-element-border-box");
    doc.l10n.setAttributes(borderLabel, "whimsy-element-border-box");
    const bTop = doc.createElementNS(HTML_NS, "span");
    bTop.className = "whimsy-box-val-top";
    bTop.textContent = bm.border.top;
    const bBottom = doc.createElementNS(HTML_NS, "span");
    bBottom.className = "whimsy-box-val-bottom";
    bBottom.textContent = bm.border.bottom;
    const bLeft = doc.createElementNS(HTML_NS, "span");
    bLeft.className = "whimsy-box-val-left";
    bLeft.textContent = bm.border.left;
    const bRight = doc.createElementNS(HTML_NS, "span");
    bRight.className = "whimsy-box-val-right";
    bRight.textContent = bm.border.right;

    const paddingBox = doc.createElementNS(HTML_NS, "div");
    paddingBox.className = "whimsy-box-padding";
    const paddingLabel = doc.createElementNS(HTML_NS, "span");
    paddingLabel.className = "whimsy-box-label";
    paddingLabel.textContent = lazy.l10n.formatValueSync("whimsy-element-padding-box");
    doc.l10n.setAttributes(paddingLabel, "whimsy-element-padding-box");
    const pTop = doc.createElementNS(HTML_NS, "span");
    pTop.className = "whimsy-box-val-top";
    pTop.textContent = bm.padding.top;
    const pBottom = doc.createElementNS(HTML_NS, "span");
    pBottom.className = "whimsy-box-val-bottom";
    pBottom.textContent = bm.padding.bottom;
    const pLeft = doc.createElementNS(HTML_NS, "span");
    pLeft.className = "whimsy-box-val-left";
    pLeft.textContent = bm.padding.left;
    const pRight = doc.createElementNS(HTML_NS, "span");
    pRight.className = "whimsy-box-val-right";
    pRight.textContent = bm.padding.right;

    const contentBox = doc.createElementNS(HTML_NS, "div");
    contentBox.className = "whimsy-box-content";
    contentBox.textContent = `${bm.width} × ${bm.height}`;

    paddingBox.append(paddingLabel, pTop, pBottom, pLeft, pRight, contentBox);
    borderBox.append(borderLabel, bTop, bBottom, bLeft, bRight, paddingBox);
    marginBox.append(marginLabel, mTop, mBottom, mLeft, mRight, borderBox);
    boxModelWrap.append(marginBox);
    body.append(boxModelWrap);

    // Colours & Contrast Card
    const contrastCard = doc.createElementNS(HTML_NS, "div");
    contrastCard.className = "whimsy-contrast-card";

    const colorsHeading = doc.createElementNS(HTML_NS, "div");
    colorsHeading.className = "whimsy-inspector-section-heading";
    colorsHeading.textContent = lazy.l10n.formatValueSync("whimsy-element-colors-heading");
    doc.l10n.setAttributes(colorsHeading, "whimsy-element-colors-heading");
    contrastCard.append(colorsHeading);

    const cRow = doc.createElementNS(HTML_NS, "div");
    cRow.className = "whimsy-contrast-row";

    const swatches = doc.createElementNS(HTML_NS, "div");
    swatches.className = "whimsy-contrast-swatches";

    const textColorItem = doc.createElementNS(HTML_NS, "div");
    textColorItem.className = "whimsy-color-chip-row";
    const textLabel = doc.createElementNS(HTML_NS, "span");
    textLabel.className = "whimsy-color-chip-label";
    textLabel.textContent = lazy.l10n.formatValueSync("whimsy-element-text-color");
    doc.l10n.setAttributes(textLabel, "whimsy-element-text-color");
    const textChip = doc.createElementNS(HTML_NS, "span");
    textChip.className = "whimsy-color-chip";
    const textSwatch = doc.createElementNS(HTML_NS, "span");
    textSwatch.className = "whimsy-color-swatch";
    textSwatch.style.backgroundColor = data.colors.textColorHex;
    textChip.append(textSwatch, doc.createTextNode(data.colors.textColorHex));
    textColorItem.append(textLabel, textChip);

    const bgColorItem = doc.createElementNS(HTML_NS, "div");
    bgColorItem.className = "whimsy-color-chip-row";
    const bgLabel = doc.createElementNS(HTML_NS, "span");
    bgLabel.className = "whimsy-color-chip-label";
    bgLabel.textContent = lazy.l10n.formatValueSync("whimsy-element-bg-color");
    doc.l10n.setAttributes(bgLabel, "whimsy-element-bg-color");
    const bgChip = doc.createElementNS(HTML_NS, "span");
    bgChip.className = "whimsy-color-chip";
    const bgSwatch = doc.createElementNS(HTML_NS, "span");
    bgSwatch.className = "whimsy-color-swatch";
    bgSwatch.style.backgroundColor = data.colors.bgColorHex;
    bgChip.append(bgSwatch, doc.createTextNode(data.colors.bgColorHex));
    bgColorItem.append(bgLabel, bgChip);

    swatches.append(textColorItem, bgColorItem);

    const ratioBox = doc.createElementNS(HTML_NS, "div");
    ratioBox.className = "whimsy-contrast-ratio-box";

    const ratioLabel = doc.createElementNS(HTML_NS, "span");
    ratioLabel.className = "whimsy-contrast-label";
    ratioLabel.textContent = lazy.l10n.formatValueSync("whimsy-element-contrast-ratio");
    doc.l10n.setAttributes(ratioLabel, "whimsy-element-contrast-ratio");

    const ratioValues = doc.createElementNS(HTML_NS, "div");
    ratioValues.className = "whimsy-contrast-values";

    const ratio = doc.createElementNS(HTML_NS, "span");
    ratio.className = "whimsy-contrast-ratio";
    ratio.textContent = data.colors.contrastRatio;

    const badge = doc.createElementNS(HTML_NS, "span");
    badge.className = `whimsy-wcag-badge ${data.colors.passAA ? "pass" : "fail"}`;
    badge.textContent = lazy.l10n.formatValueSync("whimsy-element-wcag-badge", { rating: data.colors.rating });
    doc.l10n.setAttributes(badge, "whimsy-element-wcag-badge", { rating: data.colors.rating });

    ratioValues.append(ratio, badge);
    ratioBox.append(ratioLabel, ratioValues);
    cRow.append(swatches, ratioBox);
    contrastCard.append(cRow);
    body.append(contrastCard);

    // Actions & Open in DevTools Link
    const actions = doc.createElementNS(HTML_NS, "div");
    actions.className = "whimsy-inspector-actions";

    const devtoolsBtn = doc.createElementNS(HTML_NS, "button");
    devtoolsBtn.className = "whimsy-inspector-button primary";
    devtoolsBtn.textContent = lazy.l10n.formatValueSync("whimsy-element-open-devtools");
    doc.l10n.setAttributes(devtoolsBtn, "whimsy-element-open-devtools");
    devtoolsBtn.addEventListener("click", () => {
      lazy.WhimsyPanels.close(panel);
      try {
        lazy.DevToolsShim?.showToolboxForTab?.(win.gBrowser.selectedTab, { toolId: "inspector" });
      } catch (e) {
        console.error("Whimsy: failed to open DevTools", e);
      }
    });

    const fontBtn = doc.createElementNS(HTML_NS, "button");
    fontBtn.className = "whimsy-inspector-button";
    fontBtn.textContent = lazy.l10n.formatValueSync("whimsy-action-inspect-font");
    doc.l10n.setAttributes(fontBtn, "whimsy-action-inspect-font");
    fontBtn.addEventListener("click", () => {
      lazy.WhimsyPanels.close(panel);
      if (data.font) {
        this.showFontPopover(win, data.font);
      }
    });

    const pickBtn = doc.createElementNS(HTML_NS, "button");
    pickBtn.className = "whimsy-inspector-button";
    pickBtn.textContent = lazy.l10n.formatValueSync("whimsy-element-pick-another");
    doc.l10n.setAttributes(pickBtn, "whimsy-element-pick-another");
    pickBtn.addEventListener("click", () => {
      lazy.WhimsyPanels.close(panel);
      this.startPicker(win, "element");
    });

    actions.append(devtoolsBtn, fontBtn, pickBtn);
    body.append(actions);

    lazy.WhimsyPanels.open(win, panel, { anchor });
  },

  async inspectElementBySelector(win, selector) {
    const browser = win.gBrowser.selectedBrowser;
    const actor = this.actorFor(browser);
    if (!actor) {
      return;
    }
    try {
      const data = await actor.sendQuery("Whimsy:InspectElementBySelector", { selector });
      if (data) {
        this.showElementPopover(win, data);
      }
    } catch (e) {}
  },

  // Shared element picker controls (shares picker between Zap, Font Inspector, Element Inspector)
  startPicker(win, mode = "element") {
    // Each picker honours its own switch.
    if (mode == "font" ? !this.fontInspectorEnabled : !this.elementInspectorEnabled) {
      return false;
    }
    const browser = win.gBrowser.selectedBrowser;
    const actor = this.actorFor(browser);
    if (!actor) {
      return false;
    }
    this._activePickers.set(win, mode);
    actor.sendAsyncMessage("Whimsy:StartPicker", { mode });
    return true;
  },

  stopPicker(win) {
    const browser = win.gBrowser.selectedBrowser;
    const actor = this.actorFor(browser);
    this._activePickers.delete(win);
    actor?.sendAsyncMessage("Whimsy:StopPicker");
  },

  togglePicker(win, mode = "element") {
    if (this._activePickers.has(win)) {
      this.stopPicker(win);
      return false;
    }
    return this.startPicker(win, mode);
  },

  onPickerClosed(win) {
    this._activePickers.delete(win);
  },

  showToast(win, messageId, l10nArgs = {}) {
    if (!win.gZenUIManager?.showToast) {
      return;
    }
    win.gZenUIManager.showToast(messageId, { l10nArgs });
    // Zen reuses a toast that is still showing if messageId matches,
    // keeping its old text. Refresh the label like WhimsyCopy does.
    const container = win.document?.getElementById("zen-toast-container");
    if (!container) {
      return;
    }
    const toast = [...container.children].find(t => t._messageId == messageId);
    if (!toast) {
      return;
    }
    const label = toast.firstElementChild?.querySelector("label:not(.whimsy-copy-url)");
    if (label) {
      win.document.l10n.setAttributes(label, messageId, l10nArgs);
    }
  },

  onGapMeasured(win, data) {
    if (!data) {
      return;
    }
    try {
      this.showToast(win, "whimsy-element-gap-toast", {
        gapX: data.gapX,
        gapY: data.gapY,
      });
    } catch (e) {}
  },
};
