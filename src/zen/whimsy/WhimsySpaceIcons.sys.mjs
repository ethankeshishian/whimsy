/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Space icons (whimsy.feature.space-icon-picker): Arc's space icon picker.
//
// In Arc (macOS 1.170), Change Icon… or a click on a space's icon opens a
// small card: Emoji | Icon and a trash at the top, then a grid of 56 glyphs,
// 8 across, in a fixed order, with the space's current icon on a light
// plate. Picking one sets it at once and closes the card; the emoji grid
// has search and skin tones. The chosen icon shows before the space's name
// and in the switcher, which Zen already does.
//
// Zen's picker (ZenEmojiPicker.mjs) already has the tabs, the trash, the
// emoji search and the glyph grid, so this only listens to it:
// - the Icon tab lists Arc's 56 glyphs first, in Arc's order, then Zen's
//   other glyphs after a thin rule (the user kept them). Six of Arc's
//   subjects aren't in Zen's set; ours are Ionicons, like Zen's;
// - an 8-across grid on Arc's pitch, and the current icon on a plate. It
//   opens on the Icon tab when the space's icon is a glyph;
// - for a space (switcher, header, Library, new-space form) a pick or the
//   trash closes the card, as in Arc. Zen keeps it open so you can try a
//   few; tab and folder icons keep Zen's behavior;
// - a skin tone button beside the search (whimsy.spaces.emoji-skin-tone).
//
// With the switch off, Zen's picker is untouched. Glyphs already chosen
// keep drawing either way: the files always ship.

const FEATURE_PREF = "whimsy.feature.space-icon-picker";
const TONE_PREF = "whimsy.spaces.emoji-skin-tone";
const PANEL_ID = "PanelUI-zen-emojis-picker";
const ATTR = "whimsy-arc-icons";
const CURRENT_ATTR = "whimsy-current";
const BASE_ATTR = "whimsy-base";
const TONE_BUTTON_ID = "whimsy-emoji-skin-tone";
// Whimsy's own glyphs go by "whimsy-<name>.svg" in the picker.
const GLYPH_PREFIX = "whimsy-";
const GLYPH_BASE = "chrome://browser/content/whimsy/space-icons/";

// Arc's Icon tab, row by row, as Zen's file names (some of Zen's names
// aren't what they draw: star.svg is an asterisk, globe-1.svg a light
// bulb, coins.svg a database, globe.svg a stack of trays).
export const ARC_GLYPHS = [
  // star, bookmark, heart, flag, bolt, triangle, asterisk, bell
  "star-1.svg", "bookmark.svg", "heart.svg", "flag.svg",
  "lightning.svg", "triangle.svg", "star.svg", "bell.svg",
  // light bulb, shapes, four squares, nine dots, layers, database, trays, two squares
  "globe-1.svg", "shapes.svg", "grid-2x2.svg", "grid-3x3.svg",
  "layers.svg", "coins.svg", "globe.svg", "squares.svg",
  // folder, tray, calendar, envelope, checked box, page, open book, speech bubble
  "folder.svg", "inbox.svg", "whimsy-calendar.svg", "mail.svg",
  "checkbox.svg", "page.svg", "book.svg", "chat.svg",
  // two people, terminal, tools, square, egg, circle, moon, sun
  "people.svg", "terminal.svg", "construct.svg", "square.svg",
  "egg.svg", "circle.svg", "moon.svg", "sun.svg",
  // planet, leaf, cloud, paw, basket, gift, bed, fork and knife
  "planet.svg", "leaf.svg", "cloud.svg", "paw.svg",
  "basket.svg", "present.svg", "bed.svg", "cutlery.svg",
  // dumbbell, aeroplane, music note, palette, video camera, bandage, code, baseball
  "weight.svg", "airplane.svg", "music.svg", "palette.svg",
  "video.svg", "whimsy-bandage.svg", "code.svg", "baseball.svg",
  // cloud outline, map, campfire, pizza slice, skull, receipt, thumbs up, train
  "whimsy-cloud-outline.svg", "map.svg", "flame.svg", "pizza.svg",
  "skull.svg", "whimsy-receipt.svg", "whimsy-thumbs-up.svg", "whimsy-train.svg",
];

// Unicode's Emoji_Modifier_Base (emoji-data.txt 16.0), minus the few whose
// toned forms aren't recommended (👪 👯 🤼), which fonts draw as two glyphs.
// prettier-ignore
const TONE_BASES = [
  [0x261d, 0x261d], [0x26f9, 0x26f9], [0x270a, 0x270d], [0x1f385, 0x1f385],
  [0x1f3c2, 0x1f3c4], [0x1f3c7, 0x1f3c7], [0x1f3ca, 0x1f3cc], [0x1f442, 0x1f443],
  [0x1f446, 0x1f450], [0x1f466, 0x1f469], [0x1f46b, 0x1f46e], [0x1f470, 0x1f478],
  [0x1f47c, 0x1f47c], [0x1f481, 0x1f483], [0x1f485, 0x1f487], [0x1f48f, 0x1f48f],
  [0x1f491, 0x1f491], [0x1f4aa, 0x1f4aa], [0x1f574, 0x1f575], [0x1f57a, 0x1f57a],
  [0x1f590, 0x1f590], [0x1f595, 0x1f596], [0x1f645, 0x1f647], [0x1f64b, 0x1f64f],
  [0x1f6a3, 0x1f6a3], [0x1f6b4, 0x1f6b6], [0x1f6c0, 0x1f6c0], [0x1f6cc, 0x1f6cc],
  [0x1f90c, 0x1f90c], [0x1f90f, 0x1f90f], [0x1f918, 0x1f91f], [0x1f926, 0x1f926],
  [0x1f930, 0x1f939], [0x1f93d, 0x1f93e], [0x1f977, 0x1f977], [0x1f9b5, 0x1f9b6],
  [0x1f9b8, 0x1f9b9], [0x1f9bb, 0x1f9bb], [0x1f9cd, 0x1f9cf], [0x1f9d1, 0x1f9dd],
  [0x1fac3, 0x1fac5], [0x1faf0, 0x1faf8],
];
const TONE_COUNT = 5;
const RAISED_HAND = "✋";

function featureOn() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

function isToneBase(codePoint) {
  return TONE_BASES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

function tonePref() {
  const tone = Services.prefs.getIntPref(TONE_PREF, 0);
  return tone >= 0 && tone <= TONE_COUNT ? tone : 0;
}

export const WhimsySpaceIcons = {
  ARC_GLYPHS,

  // The emoji in skin tone 1-5 (0 = as is). Only emoji with exactly one
  // person or hand take a tone; others (couples of two people, flags...)
  // stay as they are.
  withTone(emoji, tone) {
    if (!tone || !emoji) {
      return emoji;
    }
    const chars = [...emoji];
    const bases = chars.flatMap((c, i) => (isToneBase(c.codePointAt(0)) ? [i] : []));
    if (bases.length != 1) {
      return emoji;
    }
    const at = bases[0] + 1;
    // The modifier replaces a following emoji presentation selector.
    chars.splice(at, chars[at] == "️" ? 1 : 0, String.fromCodePoint(0x1f3fa + tone));
    return chars.join("");
  },

  glyphURL(name) {
    return GLYPH_BASE + name.slice(GLYPH_PREFIX.length);
  },

  initWindow(win) {
    const { document } = win;
    const picker = win.gZenEmojiPicker;
    const panel = document.getElementById(PANEL_ID);
    if (!picker || !panel || panel._whimsySpaceIcons) {
      return;
    }
    panel._whimsySpaceIcons = true;

    // Zen picks a glyph through getSVGURL(name); ours live elsewhere.
    const original = picker.getSVGURL;
    picker.getSVGURL = function (icon) {
      return icon?.startsWith(GLYPH_PREFIX) ? WhimsySpaceIcons.glyphURL(icon) : original.call(this, icon);
    };

    // What the open picker is for: { space, icon } for a space, else null.
    let target = null;

    // All registered after Zen's own listeners, so they run after them.
    panel.addEventListener("popupshowing", event => {
      if (event.target != panel) {
        return;
      }
      const on = featureOn();
      panel.toggleAttribute(ATTR, on);
      this.toneButton(win, panel).hidden = !on || panel.hasAttribute("only-svg-icons");
      target = null;
      if (!on) {
        return;
      }
      try {
        target = this.spaceTarget(win, panel.anchorNode || document.querySelector("[zen-emoji-open] > [zen-emoji-open]"));
        this.arrangeGlyphs(win);
        this.applyTone(win, tonePref());
        this.markCurrent(win, target?.icon);
      } catch (e) {
        console.error("Whimsy: space icon picker", e);
      }
    });
    panel.addEventListener("popupshown", event => {
      if (event.target != panel || !panel.hasAttribute(ATTR)) {
        return;
      }
      // Zen always opens on Emoji; a space with a glyph opens on Icon.
      if (target?.icon?.endsWith(".svg") && !panel.hasAttribute("only-svg-icons")) {
        this.showIconPage(win);
      }
      const current = panel.querySelector(`[${CURRENT_ATTR}]`);
      if (current) {
        const pages = document.getElementById("PanelUI-zen-emojis-picker-pages");
        const left = pages.scrollLeft;
        current.scrollIntoView({ block: "nearest", inline: "nearest" });
        pages.scrollLeft = left;
      }
    });
    panel.addEventListener("popuphidden", event => {
      if (event.target == panel) {
        target = null;
      }
    });
    panel.addEventListener("command", event => {
      if (!panel.hasAttribute(ATTR)) {
        return;
      }
      const item = event.target;
      const picked =
        item.id == "PanelUI-zen-emojis-picker-none" ||
        item.classList?.contains("zen-emojis-picker-emoji") ||
        item.classList?.contains("zen-emojis-picker-svg");
      // Arc closes the card on a pick; Zen keeps it open for spaces.
      if (picked && target && panel.state == "open") {
        panel.hidePopup();
      }
    });
    // Typing searches emoji, so show them (Arc's Icon tab has no search).
    picker.searchInput?.addEventListener("input", () => {
      if (panel.hasAttribute(ATTR) && document.getElementById("PanelUI-zen-emojis-picker-change-svg")?.classList.contains("selected")) {
        document.getElementById("PanelUI-zen-emojis-picker-change-emojis")?.doCommand();
      }
    });

    const onTone = () => {
      if (panel.state == "open" && panel.hasAttribute(ATTR)) {
        this.applyTone(win, tonePref());
        this.markCurrent(win, target?.icon);
        // Re-run the search over the toned grid.
        if (picker.searchInput?.value) {
          picker.searchInput.dispatchEvent(new win.Event("input", { bubbles: true }));
        }
      }
      this.updateToneButton(win);
    };
    Services.prefs.addObserver(TONE_PREF, onTone);
    win.addEventListener("unload", () => Services.prefs.removeObserver(TONE_PREF, onTone), { once: true });
  },

  // The space a picker anchor belongs to, and its current icon.
  spaceTarget(win, anchor) {
    if (!anchor?.closest) {
      return null;
    }
    const spaces = win.gZenWorkspaces;
    const space = id => {
      const workspace = id && spaces?.getWorkspaceFromId(id);
      return workspace ? { space: id, icon: workspace.icon || null } : null;
    };
    // Checked before anything else: tabs carry zen-workspace-id too.
    if (anchor.closest("zen-workspace-icons")) {
      return space(anchor.closest("[zen-workspace-id]")?.getAttribute("zen-workspace-id"));
    }
    if (anchor.closest(".zen-current-workspace-indicator-icon")) {
      return space(anchor.closest("zen-workspace")?.id || spaces?.activeWorkspace);
    }
    if (anchor.closest(".zen-library-space-icon")) {
      return space(anchor.closest(".zen-library-space")?.getAttribute("data-uuid"));
    }
    const creating = anchor.closest(".zen-workspace-creation-icon-label");
    if (creating) {
      return { space: null, icon: creating.getAttribute("image") || creating.getAttribute("label") || null };
    }
    return null;
  },

  // Arc's 56 first, in Arc's order, then Zen's others after a rule.
  arrangeGlyphs(win) {
    const { document } = win;
    const list = win.gZenEmojiPicker.svgList;
    if (!list) {
      return;
    }
    const zens = [...list.children];
    const byName = new Map(zens.map(button => [button.getAttribute("icon"), button]));
    const arc = [];
    for (const name of ARC_GLYPHS) {
      const button = byName.get(name) || (name.startsWith(GLYPH_PREFIX) ? this.makeGlyph(win, name) : null);
      if (button) {
        arc.push(button);
      }
    }
    const rest = zens.filter(button => !arc.includes(button));
    const items = [...arc];
    if (rest.length) {
      const rule = document.createXULElement("box");
      rule.className = "whimsy-glyph-rule";
      rule.setAttribute("role", "separator");
      items.push(rule, ...rest);
    }
    list.replaceChildren(...items);
  },

  makeGlyph(win, name) {
    const button = win.document.createXULElement("toolbarbutton");
    // Zen's class, so Zen's own command handler picks it.
    button.className = "toolbarbutton-1 zen-emojis-picker-svg";
    button.setAttribute("label", name.slice(GLYPH_PREFIX.length, -".svg".length));
    button.setAttribute("tooltiptext", "");
    button.setAttribute("icon", name);
    button.style.listStyleImage = `url(${this.glyphURL(name)})`;
    return button;
  },

  showIconPage(win) {
    const { document } = win;
    const pages = document.getElementById("PanelUI-zen-emojis-picker-pages");
    const svgs = win.gZenEmojiPicker.svgList;
    if (!pages || !svgs) {
      return;
    }
    pages.scrollLeft = svgs.offsetLeft;
    document.getElementById("PanelUI-zen-emojis-picker-change-svg")?.classList.add("selected");
    document.getElementById("PanelUI-zen-emojis-picker-change-emojis")?.classList.remove("selected");
  },

  // Puts the current icon on a plate (Arc's selected glyph).
  markCurrent(win, icon) {
    const picker = win.gZenEmojiPicker;
    for (const old of win.document.querySelectorAll(`#${PANEL_ID} [${CURRENT_ATTR}]`)) {
      old.removeAttribute(CURRENT_ATTR);
    }
    if (!icon) {
      return;
    }
    let match;
    if (icon.endsWith(".svg")) {
      match = [...(picker.svgList?.children || [])].find(
        button => button.hasAttribute("icon") && picker.getSVGURL(button.getAttribute("icon")) == icon
      );
    } else {
      match = [...(picker.emojiList?.children || [])].find(
        button => button.getAttribute("label") == icon || button.getAttribute(BASE_ATTR) == icon
      );
    }
    match?.setAttribute(CURRENT_ATTR, "");
  },

  // Shows every emoji that takes one in the chosen skin tone. The emoji as
  // Zen's data has it stays in whimsy-base, for search.
  applyTone(win, tone) {
    const list = win.gZenEmojiPicker.emojiList;
    if (!list || (!tone && !list.hasAttribute("whimsy-skin-tone"))) {
      return;
    }
    list.toggleAttribute("whimsy-skin-tone", !!tone);
    for (const button of list.children) {
      const base = button.getAttribute(BASE_ATTR) || button.getAttribute("label");
      const label = this.withTone(base, tone);
      if (label != base) {
        button.setAttribute(BASE_ATTR, base);
      }
      if (button.getAttribute("label") != label) {
        button.setAttribute("label", label);
      }
    }
  },

  // The skin tone button beside the emoji search, made once per window.
  toneButton(win, panel) {
    const { document } = win;
    let button = document.getElementById(TONE_BUTTON_ID);
    if (button) {
      return button;
    }
    button = document.createXULElement("toolbarbutton");
    button.id = TONE_BUTTON_ID;
    button.className = "toolbarbutton-1";
    button.setAttribute("type", "menu");
    // Its label is the hand (set in code), so its name comes from Fluent
    // by hand rather than data-l10n-id, which would clear the label.
    document.l10n.formatValue("whimsy-emoji-skin-tone-button").then(name => {
      button.setAttribute("tooltiptext", name);
      button.setAttribute("aria-label", name);
    });
    const popup = document.createXULElement("menupopup");
    popup.id = `${TONE_BUTTON_ID}-popup`;
    for (let tone = 0; tone <= TONE_COUNT; tone++) {
      const item = document.createXULElement("menuitem");
      item.setAttribute("type", "radio");
      item.setAttribute("name", "whimsy-skin-tone");
      item.setAttribute("value", String(tone));
      document.l10n.setAttributes(item, `whimsy-emoji-skin-tone-${tone}`);
      item.addEventListener("command", event => {
        event.stopPropagation();
        Services.prefs.setIntPref(TONE_PREF, tone);
      });
      popup.append(item);
    }
    button.append(popup);
    const header = document.getElementById("PanelUI-zen-emojis-picker-header") || panel;
    header.append(button);
    this.updateToneButton(win);
    return button;
  },

  updateToneButton(win) {
    const button = win.document.getElementById(TONE_BUTTON_ID);
    if (!button) {
      return;
    }
    const tone = tonePref();
    button.setAttribute("label", this.withTone(RAISED_HAND, tone));
    for (const item of button.querySelectorAll("menuitem")) {
      item.setAttribute("checked", item.getAttribute("value") == String(tone));
    }
  },
};
