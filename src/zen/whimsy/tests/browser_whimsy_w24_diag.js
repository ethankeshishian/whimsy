/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Temporary W24 diagnostic: dumps the VPN panel's and the sidebar bottom's
// boxes. Removed before merge.

const { WhimsyVPN } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVPN.sys.mjs");
const { IPProtectionService, IPProtectionStates } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs"
);
const { IPPProxyManager, IPPProxyStates } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs"
);

function describe(el) {
  const cs = el.documentGlobal.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return `${el.localName}#${el.id}.${typeof el.className == "string" ? el.className : ""} rect=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} pad=${cs.padding} margin=${cs.margin} bg=${cs.backgroundColor} bgimg=${cs.backgroundImage.slice(0, 60)} border=${cs.borderTop}/${cs.borderBottom} shadow=${cs.boxShadow.slice(0, 80)} outline=${cs.outlineStyle}`;
}

function dumpTree(root, depth = 0, max = 6) {
  if (depth > max) {
    return;
  }
  const kids = root.shadowRoot ? [...root.shadowRoot.children] : [];
  for (const el of [...kids, ...root.children]) {
    if (["style", "link", "script"].includes(el.localName)) {
      continue;
    }
    info(`${"  ".repeat(depth)}${describe(el)}`);
    dumpTree(el, depth + 1, max);
  }
}

add_task(async function diag_vpn() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.vpn", true], ["browser.ipProtection.enabled", true]] });
  Object.defineProperty(IPProtectionService, "state", { value: IPProtectionStates.READY, configurable: true });
  Object.defineProperty(IPPProxyManager, "state", { value: IPPProxyStates.NOT_READY, configurable: true });
  WhimsyVPN.updateUi(window);
  ok(await WhimsyVPN.openPanel(window), "open");
  const popup = WhimsyVPN.getPanel(window).panel;
  if (popup.state != "open") {
    await BrowserTestUtils.waitForPopupEvent(popup, "shown");
  }
  const content = popup.querySelector("ipprotection-content");
  await content.updateComplete;
  await new Promise(r => setTimeout(r, 500)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  info("PANEL " + describe(popup));
  let el = content;
  while (el && el != popup) {
    info("ANC " + describe(el));
    el = el.parentElement;
  }
  dumpTree(content, 0, 8);
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  popup.hidePopup();
  await hidden;
  delete IPProtectionService.state;
  delete IPPProxyManager.state;
  WhimsyVPN.updateUi(window);
});

add_task(async function diag_sidebar() {
  const foot = document.getElementById("zen-sidebar-foot-buttons");
  info("FOOT " + describe(foot));
  let el = foot;
  while (el) {
    info("ANC " + describe(el));
    el = el.parentElement;
  }
  const fr = foot.getBoundingClientRect();
  const x = Math.round(fr.left + fr.width / 2);
  info(`window inner ${window.innerWidth}x${window.innerHeight}`);
  for (let y = Math.round(fr.bottom) - 2; y < window.innerHeight; y += 2) {
    const stack = document.elementsFromPoint(x, y).slice(0, 6).map(e => `${e.localName}#${e.id}`).join(" > ");
    info(`y=${y}: ${stack}`);
  }
  for (const sel of ["#navigator-toolbox", "#zen-main-app-wrapper", "#browser", "#zen-appcontent-wrapper", "#tabbrowser-tabbox", "#zen-tabbox-wrapper", "#titlebar", "#TabsToolbar", "#zen-sidebar-splitter"]) {
    const n = document.querySelector(sel);
    if (n) {
      info("SEL " + describe(n));
      for (const pseudo of ["::before", "::after"]) {
        const cs = getComputedStyle(n, pseudo);
        if (cs.content != "none") {
          info(`  ${pseudo} content=${cs.content} bg=${cs.backgroundColor} pos=${cs.position} h=${cs.height} b=${cs.bottom} border=${cs.borderTop}`);
        }
      }
    }
  }
  dumpTree(document.getElementById("navigator-toolbox"), 0, 3);
  ok(true, "dumped");
});
