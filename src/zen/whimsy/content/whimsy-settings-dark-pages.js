/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var WhimsyDarkPagesSettings = {
  init(doc) {
    const { WhimsyDarkPages } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDarkPages.sys.mjs");
    const { WhimsySurface } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySurface.sys.mjs");
    const group = doc.getElementById("whimsyDarkPagesGroup");
    if (!group) {
      return;
    }
    if (!WhimsyDarkPages.enabled) {
      group.remove();
      return;
    }
    doc.getElementById("whimsyDarkPdf")?.remove();
    const card = WhimsySurface.group(doc);
    card.classList.add("whimsy-surface-tokens");
    const title = WhimsySurface.row(doc, {
      l10nId: "whimsy-dark-pages-title",
      detailL10nId: "whimsy-dark-pages-description",
    });
    title.label.id = "whimsy-dark-pages-mode-label";
    const seg = WhimsySurface.seg(doc, {
      name: "dark-pages-mode", label: "Dark pages",
      options: ["off", "match", "always"].map(value => ({ value, l10nId: `whimsy-dark-pages-${value}` })),
      onPick: value => Services.prefs.setStringPref("whimsy.dark-pages.mode", value),
    });
    seg.group.id = "whimsyDarkPagesMode";
    seg.group.setAttribute("aria-labelledby", title.label.id);
    const dim = WhimsySurface.switch(doc, {
      id: "whimsyDarkPagesDimImages", labelledBy: "whimsy-dark-pages-dim-label",
      onChange: value => Services.prefs.setBoolPref("whimsy.dark-pages.dim-images", value),
    });
    const dimRow = WhimsySurface.row(doc, {
      l10nId: "whimsy-dark-pages-dim", detailL10nId: "whimsy-dark-pages-dim-description", trailing: [dim],
    });
    dimRow.label.id = "whimsy-dark-pages-dim-label";
    card.append(title.row, seg.group, dimRow.row);
    const changed = WhimsySurface.group(doc);
    changed.id = "whimsyDarkPagesSites";
    changed.classList.add("whimsy-surface-tokens");
    const sync = () => {
      seg.select(WhimsyDarkPages.mode);
      dim.checked = Services.prefs.getBoolPref("whimsy.dark-pages.dim-images", false);
      changed.replaceChildren();
      const entries = Object.entries(WhimsyDarkPages.sites());
      changed.hidden = !entries.length;
      if (entries.length) {
        changed.append(WhimsySurface.caption(doc, { l10nId: "whimsy-dark-pages-sites" }).caption);
      }
      for (const [key, value] of entries) {
        const reset = WhimsySurface.textButton(doc, {
          l10nId: "whimsy-dark-pages-reset",
          onCommand: () => {
            const sites = WhimsyDarkPages.sites();
            delete sites[key];
            Services.prefs.setStringPref("whimsy.dark-pages.sites", JSON.stringify(sites));
          },
        });
        const row = WhimsySurface.row(doc, {
          text: key.slice(key.indexOf("|") + 1),
          detailL10nId: value == "on" ? "whimsy-dark-pages-dark" : "whimsy-dark-pages-original",
          trailing: [reset],
        });
        changed.append(row.row);
      }
    };
    group.append(card, changed);
    Services.prefs.addObserver("whimsy.dark-pages.", sync);
    doc.defaultView.addEventListener("unload", () => Services.prefs.removeObserver("whimsy.dark-pages.", sync), { once: true });
    sync();
  },
};
