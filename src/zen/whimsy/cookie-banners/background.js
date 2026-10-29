/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Reject cookie banners: Whimsy's background for DuckDuckGo's Autoconsent
// content script (autoconsent/, MPL-2.0, vendored by
// whimsy/update-autoconsent.sh). Each frame asks for its rules ("init"); this
// answers with the compact rules that apply to that frame and the opt-out
// config, and runs the few rule steps that need the page's own world
// ("eval", always one of Autoconsent's named snippets). Settings → Privacy &
// Security → "Reject cookie banners" turns the whole add-on off.

import { evalSnippets, filterCompactRules } from "./autoconsent/autoconsent.mjs";

const CONFIG = {
  enabled: true,
  autoAction: "optOut",
  enablePrehide: true,
  enableCosmeticRules: true,
  enableHeuristicDetection: false,
  logs: { errors: false },
};

let rulesPromise;
function compactRules() {
  rulesPromise ??= fetch(browser.runtime.getURL("autoconsent/compact-rules.json")).then(r => r.json());
  return rulesPromise;
}

async function onMessage(msg, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    return;
  }
  const { frameId } = sender;
  const reply = message => browser.tabs.sendMessage(tabId, message, { frameId }).catch(() => {});
  switch (msg.type) {
    case "init": {
      const url = sender.url || `${sender.origin}/`;
      const compact = filterCompactRules(await compactRules(), { url, mainFrame: frameId === 0 });
      reply({ type: "initResp", config: CONFIG, rules: { autoconsent: [], compact } });
      break;
    }
    case "eval": {
      const func = evalSnippets[msg.snippetId];
      let result = false;
      if (func) {
        try {
          const [injection] = await browser.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            world: "MAIN",
            func,
          });
          result = injection?.result;
        } catch (e) {}
      }
      reply({ type: "evalResp", id: msg.id, result });
      break;
    }
  }
}

browser.runtime.onMessage.addListener((msg, sender) => {
  onMessage(msg, sender).catch(e => console.error("Whimsy cookie banners:", e));
});
