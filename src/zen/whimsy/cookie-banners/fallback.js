/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Runs only after Autoconsent completes a rule pass without a CMP. Keep this
// outside the vendored directory so CMP updates cannot overwrite the fallback.
(() => {
  const CONTROL = 'button, input[type="button"], input[type="submit"], a, [role="button"]';
  const CLOSE = /^(dismiss|close|no thanks|got it|[x✕×✖])$/i;
  const ACCEPT = /^(accept( all( cookies)?)?|allow( all( cookies)?)?|agree|i agree|ok(ay)?)$/i;
  const COOKIE = /\bcookies?\b|\b(cookie consent|consent preferences|privacy choices)\b/i;
  const SENSITIVE = /\b(log[ -]?in|sign[ -]?in|password|payment|checkout|credit card|subscribe|subscription)\b/i;
  // A close/acknowledgement label alone is not evidence of non-consent.
  const IMPLIED_COOKIE_USE = /\b(by|if|when|click(?:ing)?|tapp?ing|press(?:ing)?|select(?:ing)?)\b.{0,180}\b(use|store|set|enable|share|track|collect)\b.{0,80}\b(cookies?|data)\b/i;
  const IMPLIED_CONSENT = /\b(by|if|when)\b.{0,180}\b(agree|consent|accept|allow)\b|\b(closing|dismiss(?:ing)?|continu(?:e|ing)|got it)\b.{0,100}\b(consent|agree|accept|allow)\b|\b(consent|agree|accept|allow)\b.{0,100}\b(closing|dismiss(?:ing)?|continu(?:e|ing)|got it)\b/i;
  const attempted = new WeakSet();
  let observer;
  let active = false;
  let scheduled = false;

  function visible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility === "visible" &&
      Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0 &&
      rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }

  function label(element) {
    return (element.getAttribute("aria-label") || element.textContent || element.value || "")
      .replace(/\s+/g, " ").trim();
  }

  function nonBlocking(element) {
    if (document.querySelector('[aria-modal="true"], dialog[open], [inert]')) {
      return false;
    }
    if ([document.documentElement, document.body].some(node =>
      /hidden|clip/.test(getComputedStyle(node).overflowY))) {
      return false;
    }
    // A separate backdrop can block the page even when the notice is small.
    const points = [[innerWidth / 2, innerHeight / 2], [1, 1], [innerWidth - 2, innerHeight - 2]];
    return points.every(([x, y]) => {
      const top = document.elementFromPoint(x, y);
      if (!top || element.contains(top)) {
        return true;
      }
      const rect = top.getBoundingClientRect();
      return getComputedStyle(top).position !== "fixed" ||
        rect.width * rect.height < innerWidth * innerHeight * 0.65;
    });
  }

  function scan() {
    if (!active || !document.body) {
      return;
    }
    for (const element of document.querySelectorAll('div, section, aside, footer, [role="dialog"], [role="banner"]')) {
      // Limit both the scope of text matching and the geometry. Never hide a
      // page-sized container, a form, a modal, or an ordinary site dialog.
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length > 1500 || !COOKIE.test(text) || SENSITIVE.test(text) ||
          element.closest('form, dialog, [aria-modal="true"]') ||
          element.querySelector('form, input:not([type="button"]):not([type="submit"]), select, textarea, [contenteditable="true"]') ||
          !visible(element)) {
        continue;
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (!["fixed", "sticky"].includes(style.position) ||
          rect.height > innerHeight * 0.35 ||
          Math.min(Math.abs(rect.top), Math.abs(rect.left),
            Math.abs(innerHeight - rect.bottom), Math.abs(innerWidth - rect.right)) > 32) {
        continue;
      }
      const controls = [...element.querySelectorAll(CONTROL)].filter(visible);
      const buttons = controls.filter(control => control.matches('button, input, [role="button"]'));
      // Unknown preference workflows belong to CMP rules. This fallback only
      // recognises notices offering Accept plus optional non-consent closes.
      if (!controls.some(control => ACCEPT.test(label(control))) ||
          buttons.some(control => !ACCEPT.test(label(control)) && !CLOSE.test(label(control)))) {
        continue;
      }
      const close = controls.find(control => CLOSE.test(label(control)) &&
        !control.disabled && control.getAttribute("aria-disabled") !== "true" &&
        !control.matches('input[type="submit"], button[type="submit"]') &&
        // An accessible label must not disguise visible Accept text (or vice
        // versa), and a close link must not navigate to a consent endpoint.
        !/\b(accept|agree|consent|allow|enable)\b/i.test(
          `${control.textContent} ${control.value || ""} ${control.title} ${label(control)}`) &&
        (!control.matches("a[href]") || control.getAttribute("href").startsWith("#")));
      if (close && !IMPLIED_CONSENT.test(text) && !IMPLIED_COOKIE_USE.test(text) &&
          !IMPLIED_CONSENT.test(close.getAttribute("title") || "")) {
        if (!attempted.has(close)) {
          attempted.add(close);
          close.click();
        }
      } else if (nonBlocking(element)) {
        // Cosmetic removal is deliberately not consent, nor a persisted choice.
        element.style.setProperty("display", "none", "important");
      }
    }
  }

  function schedule() {
    if (!scheduled && active) {
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        scan();
      });
    }
  }

  browser.runtime.onMessage.addListener(message => {
    if (message.type !== "whimsyCookieFallback") {
      return undefined;
    }
    active = message.enabled === true;
    observer?.disconnect();
    window.removeEventListener("scroll", schedule, true);
    window.removeEventListener("resize", schedule);
    if (active) {
      observer ??= new MutationObserver(schedule);
      observer.observe(document, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] });
      window.addEventListener("scroll", schedule, true);
      window.addEventListener("resize", schedule);
      scan();
    }
    return Promise.resolve();
  });
})();
