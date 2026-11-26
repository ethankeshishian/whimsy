/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WhimsyWebKit } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyWebKit.sys.mjs"
);
const { WhimsySiteSettings } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySiteSettings.sys.mjs"
);
const { WhimsyVerbs } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyVerbs.sys.mjs"
);
const { WhimsyCommands } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyCommands.sys.mjs"
);

// Local loopback HTTP server (127.0.0.1) so both Gecko and macOS WKWebView load
// deterministic local test pages with zero external network access.
function startLocalTestServer() {
  const srv = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket
  );
  srv.init(-1, true, -1);
  const port = srv.port;

  const faviconSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#2563eb"/></svg>';

  const pageHtml = (title, heading, nextPath) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <link rel="icon" type="image/svg+xml" href="http://127.0.0.1:${port}/favicon.svg">
</head>
<body style="margin:0;padding:24px;font:16px -apple-system,sans-serif;background:#eef6ff;color:#0f172a;">
  <h1 id="heading">${heading}</h1>
  <button id="btn" onclick="window.__clicks=(window.__clicks||0)+1;document.getElementById('count').textContent=window.__clicks;">Click me</button>
  <span id="count">0</span>
  <a id="next-link" href="http://127.0.0.1:${port}${nextPath}">Next page</a>
  <a id="popup-link" href="http://127.0.0.1:${port}/popup" target="_blank">Open popup</a>
</body>
</html>`;

  const connections = [];
  srv.asyncListen({
    onSocketAccepted(_socket, transport) {
      connections.push(transport);
      const input = transport
        .openInputStream(0, 0, 0)
        .QueryInterface(Ci.nsIAsyncInputStream);
      const output = transport.openOutputStream(0, 0, 0);
      const scriptable = Cc[
        "@mozilla.org/scriptableinputstream;1"
      ].createInstance(Ci.nsIScriptableInputStream);
      scriptable.init(input);

      let requestData = "";
      const waitRead = () => {
        input.asyncWait(
          {
            onInputStreamReady() {
              try {
                const avail = scriptable.available();
                if (avail > 0) {
                  requestData += scriptable.read(avail);
                }
              } catch {
                return;
              }
              if (!requestData.includes("\r\n\r\n")) {
                waitRead();
                return;
              }
              const firstLine = requestData.split("\r\n")[0] || "";
              const match = /^[A-Z]+\s+(\S+)/.exec(firstLine);
              const path = match ? match[1] : "/page1";

              let contentType = "text/html; charset=utf-8";
              let body = "";
              let status = "200 OK";
              let extraHeaders = "";
              if (path.startsWith("/favicon.svg")) {
                contentType = "image/svg+xml";
                body = faviconSvg;
              } else if (path.startsWith("/page2")) {
                body = pageHtml(
                  "WebKit Test Page Two",
                  "Second Page",
                  "/page1"
                );
              } else if (path.startsWith("/solid/")) {
                // A page that is one flat colour edge to edge (the colour is
                // the six hex digits after /solid/).
                const hex = /^\/solid\/([0-9a-f]{6})/i.exec(path)?.[1] || "ffffff";
                body = `<!doctype html><html><head><meta charset="utf-8"><title>Solid ${hex}</title><meta name="color-scheme" content="light"></head><body style="margin:0;height:100vh;background:#${hex};"></body></html>`;
              } else if (path.startsWith("/popup")) {
                body = pageHtml("WebKit Popup Page", "Popup Page", "/page1");
              } else if (path.startsWith("/tall")) {
                // W32: a long page, for the scroll position a discard keeps.
                body = `<!doctype html><html><head><meta charset="utf-8"><title>Tall Page</title></head><body style="margin:0"><div style="height:6000px;background:linear-gradient(#fff,#bbb)">Tall</div></body></html>`;
              } else if (path.startsWith("/auth")) {
                // W32: HTTP Basic auth (user "whimsy", password "secret").
                if (/\r\nauthorization: basic d2hpbXN5OnNlY3JldA==\r\n/i.test(requestData)) {
                  body = pageHtml("Auth OK", "Signed In", "/page1");
                } else {
                  status = "401 Unauthorized";
                  extraHeaders = 'WWW-Authenticate: Basic realm="Whimsy Test Realm"\r\n';
                  body = "<!doctype html><title>Denied</title>";
                }
              } else if (path.startsWith("/download")) {
                contentType = "application/octet-stream";
                extraHeaders =
                  'Content-Disposition: attachment; filename="whimsy-webkit-test.bin"\r\n';
                body = "whimsy webkit download\n";
              } else if (path.startsWith("/file")) {
                body = `<!doctype html><html><head><meta charset="utf-8"><title>File Page</title></head><body><input type="file" id="f"></body></html>`;
              } else {
                body = pageHtml("WebKit Test Page One", "First Page", "/page2");
              }

              const response =
                `HTTP/1.1 ${status}\r\n` +
                extraHeaders +
                `Content-Type: ${contentType}\r\n` +
                `Content-Length: ${body.length}\r\n` +
                `Cache-Control: no-store\r\n` +
                `Connection: close\r\n\r\n` +
                body;
              try {
                output.write(response, response.length);
                output.close();
                input.close();
              } catch {}
            },
          },
          0,
          0,
          Services.tm.mainThread
        );
      };
      waitRead();
    },
    onStopListening() {},
  });

  return {
    port,
    url(path = "/page1") {
      return `http://127.0.0.1:${port}${path}`;
    },
    close() {
      for (const t of connections) {
        try {
          t.close(Cr.NS_OK);
        } catch {}
      }
      try {
        srv.close();
      } catch {}
    },
  };
}

function parseRGBA(str) {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/.exec(
    str || ""
  );
  if (!m) {
    // Computed colours from relative-colour syntax (the accent fill is
    // oklch(from ...)) serialize as oklch()/color(): let a canvas resolve them.
    if (!str || str == "transparent" || !/^(oklch|oklab|lab|lch|color|hsl|hwb)\(/.test(str)) {
      return null;
    }
    const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = str;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  }
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] === undefined ? 1 : Number(m[4]),
  };
}

function blendColor(fg, bg) {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a <= 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  };
}

function effectiveBackground(el, win = window) {
  const layers = [];
  let cur = el;
  while (cur && cur.nodeType == 1) {
    const bg = parseRGBA(win.getComputedStyle(cur).backgroundColor);
    if (bg && bg.a > 0) {
      layers.unshift(bg);
      if (bg.a >= 0.999) {
        break;
      }
    }
    cur = cur.parentElement ?? cur.getRootNode()?.host;
  }
  const dark = win.matchMedia("(prefers-color-scheme: dark)").matches;
  let base = dark
    ? { r: 30, g: 30, b: 34, a: 1 }
    : { r: 245, g: 245, b: 247, a: 1 };
  for (const layer of layers) {
    base = blendColor(layer, base);
  }
  return base;
}

function relativeLuminance({ r, g, b }) {
  const chan = v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

let gServer = null;

add_setup(async function setup() {
  gServer = startLocalTestServer();
  Services.prefs.setStringPref("whimsy.webkit.sites", "[]");
  registerCleanupFunction(async () => {
    Services.prefs.setStringPref("whimsy.webkit.sites", "[]");
    await WhimsySiteSettings.hidePanel(window).catch(() => {});
    await WhimsyWebKit.hideExtensionsPanel(window).catch(() => {});
    gServer?.close();
  });
});

// This file needs a real WKWebView, so browser.toml tags it whimsy-headed
// and the runners run it headed. If WebKit is unavailable anyway, every task
// fails here: a quiet early return would count as green while testing
// nothing.
function requireWebKit() {
  if (WhimsyWebKit.available(window)) {
    return true;
  }
  const isHeadless =
    Services.env.get("MOZ_HEADLESS") == "1" ||
    Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo).isHeadless;
  Assert.ok(
    false,
    isHeadless
      ? "WebKit tabs can't run headless: run this file headed (browser.toml tags it whimsy-headed)"
      : "WebKit tabs are unavailable in this headed window (whimsy.feature.webkit-tabs off, macOS older than 14, or no nsIWhimsyWebKit service), so these tests can't run"
  );
  return false;
}

// Each task runs through this: whatever tabs or windows it opened are closed
// afterwards even when an assertion throws, so one failing task can't leave
// a WebKit tab selected for the next task (or behind at the end of the run).
function add_webkit_task(fn) {
  const wrapped = async () => {
    const tabsBefore = new Set(gBrowser.tabs);
    const selectedBefore = gBrowser.selectedTab;
    const windowsBefore = new Set(Services.wm.getEnumerator("navigator:browser"));
    try {
      await fn();
    } finally {
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        if (!windowsBefore.has(win)) {
          await BrowserTestUtils.closeWindow(win);
        }
      }
      if (tabsBefore.has(selectedBefore) && selectedBefore.isConnected) {
        gBrowser.selectedTab = selectedBefore;
      }
      for (const tab of [...gBrowser.tabs]) {
        if (!tabsBefore.has(tab)) {
          BrowserTestUtils.removeTab(tab);
        }
      }
    }
  };
  Object.defineProperty(wrapped, "name", { value: fn.name });
  add_task(wrapped);
}

add_webkit_task(async function test_availability_and_profile_datastore() {
  if (!requireWebKit()) {
    return;
  }
  Assert.ok(
    WhimsyWebKit.available(window),
    "WebKit tabs are available in a headed macOS 14+ window"
  );

  const uuidDefault = WhimsyWebKit.dataStoreIdForProfile(0);
  const uuidProfile1 = WhimsyWebKit.dataStoreIdForProfile(1);
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  Assert.ok(
    uuidRegex.test(uuidDefault),
    "Default profile gets a stable persistent WKWebsiteDataStore UUID"
  );
  Assert.ok(
    uuidRegex.test(uuidProfile1),
    "Container profile gets a stable persistent WKWebsiteDataStore UUID"
  );
  Assert.notEqual(
    uuidDefault,
    uuidProfile1,
    "Different Whimsy profiles use isolated WKWebsiteDataStore UUIDs"
  );
  Assert.equal(
    WhimsyWebKit.dataStoreIdForProfile(0),
    uuidDefault,
    "Profile data store UUID is persisted across lookups"
  );
});

add_webkit_task(async function test_switch_tab_to_webkit_and_back_with_metadata_and_history() {
  if (!requireWebKit()) {
    return;
  }

  const spacerTab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    gServer.url("/page1")
  );
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    gServer.url("/page1")
  );
  const originalIndex = gBrowser.tabs.indexOf(tab);
  const pill = document.getElementById("whimsy-webkit-pill");

  Assert.ok(!WhimsyWebKit.isWebKitTab(tab), "Tab starts in Firefox (Gecko)");
  Assert.ok(pill.hidden, "WebKit pill is hidden on a Firefox tab");

  // Switch the tab to WebKit in place.
  await WhimsyWebKit.setTabEngine(tab, "webkit");
  Assert.ok(WhimsyWebKit.isWebKitTab(tab), "Tab is now a WebKit tab");
  Assert.equal(
    gBrowser.tabs.indexOf(tab),
    originalIndex,
    "Switching to WebKit keeps the tab in the same position"
  );
  Assert.equal(
    WhimsyWebKit.currentURIOf(tab)?.spec,
    gServer.url("/page1"),
    "WebKit tab loaded the same URL"
  );
  Assert.ok(!pill.hidden, "WebKit pill is shown on a WebKit tab");

  await TestUtils.waitForCondition(
    () => tab.label == "WebKit Test Page One",
    "Tab title comes from the WKWebView"
  );
  await TestUtils.waitForCondition(
    () => (tab.getAttribute("image") || "").includes("/favicon.svg"),
    "Tab favicon comes from the WKWebView"
  );
  await TestUtils.waitForCondition(
    () => gURLBar.value.includes(`127.0.0.1:${gServer.port}/page1`),
    "Address bar URL comes from the WKWebView"
  );

  // The parked Gecko <browser> can finish loading about:blank after WebKit
  // has loaded the page (a process switch made it ~700 ms late, about 1 run
  // in 10); tabbrowser then relabelled the tab from its URL and cleared its
  // icon. Load about:blank in it again by hand and check WebKit's title and
  // icon survive.
  const geckoStopped = new Promise(resolve => {
    const wpl = Ci.nsIWebProgressListener;
    const listener = {
      onStateChange(b, wp, r, flags) {
        if (
          b == tab.linkedBrowser &&
          wp?.isTopLevel &&
          flags & wpl.STATE_STOP &&
          flags & wpl.STATE_IS_WINDOW
        ) {
          gBrowser.removeTabsProgressListener(listener);
          resolve();
        }
      },
    };
    gBrowser.addTabsProgressListener(listener);
  });
  tab.linkedBrowser.fixupAndLoadURIString("about:blank", {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await geckoStopped;
  Assert.equal(
    tab.label,
    "WebKit Test Page One",
    "A late Gecko load in the parked browser leaves the WebKit page's title on the tab"
  );
  Assert.ok(
    (tab.getAttribute("image") || "").includes("/favicon.svg"),
    "A late Gecko load in the parked browser leaves the WebKit page's icon on the tab"
  );
  Assert.ok(
    !tab.hasAttribute("busy"),
    "A late Gecko load in the parked browser doesn't leave the tab busy"
  );
  Assert.ok(
    gURLBar.value.includes(`127.0.0.1:${gServer.port}/page1`),
    "A late Gecko load in the parked browser leaves the WebKit page's URL in the address bar"
  );

  const ua = await WhimsyWebKit.evaluateInTab(tab, "navigator.userAgent");
  Assert.ok(
    ua.includes("AppleWebKit") && ua.includes("Version/") && ua.includes("Safari/"),
    `WKWebView carries Safari-style Version/x Safari/y user agent (${ua})`
  );

  // Navigate to page 2 inside WebKit and check busy state, URL, title, and Back/Forward.
  const load2 = WhimsyWebKit.loadURLInTab(tab, gServer.url("/page2"));
  await load2;
  await TestUtils.waitForCondition(
    () =>
      tab.label == "WebKit Test Page Two" &&
      WhimsyWebKit.currentURIOf(tab)?.spec == gServer.url("/page2") &&
      !tab.hasAttribute("busy"),
    "Second page finished loading in WebKit with updated title, URL, and cleared busy state"
  );
  await TestUtils.waitForCondition(
    () => !document.getElementById("Browser:Back")?.hasAttribute("disabled"),
    "Back command is enabled after navigating in WebKit"
  );

  // Back button / Browser:Back command
  document.getElementById("Browser:Back").doCommand();
  await TestUtils.waitForCondition(
    () =>
      WhimsyWebKit.currentURIOf(tab)?.spec == gServer.url("/page1") &&
      tab.label == "WebKit Test Page One" &&
      !tab.hasAttribute("busy"),
    "Browser:Back navigates the WKWebView back to page 1 and finishes loading"
  );
  await TestUtils.waitForCondition(
    () => !document.getElementById("Browser:Forward")?.hasAttribute("disabled"),
    "Forward command is enabled after going back in WebKit"
  );

  // Forward button / Browser:Forward command
  document.getElementById("Browser:Forward").doCommand();
  await TestUtils.waitForCondition(
    () =>
      WhimsyWebKit.currentURIOf(tab)?.spec == gServer.url("/page2") &&
      tab.label == "WebKit Test Page Two",
    "Browser:Forward navigates the WKWebView forward to page 2"
  );

  // Reload command
  await WhimsyWebKit.evaluateInTab(tab, "window.__marker = 'before-reload'");
  document.getElementById("Browser:Reload").doCommand();
  await TestUtils.waitForCondition(
    async () =>
      (await WhimsyWebKit.evaluateInTab(tab, "String(window.__marker)")) ==
      "undefined",
    "Browser:Reload reloads the WKWebView"
  );

  // New-window request from WebKit opens a new tab (Gecko when host is not in site list).
  const tabCountBeforePopup = gBrowser.tabs.length;
  await WhimsyWebKit.evaluateInTab(
    tab,
    `window.open(${JSON.stringify(gServer.url("/popup"))}, "_blank")`
  );
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.length == tabCountBeforePopup + 1,
    "window.open from WebKit opens a new tab"
  );
  const popupTab = gBrowser.selectedTab;
  Assert.notEqual(popupTab, tab, "New tab was selected");
  Assert.ok(
    !WhimsyWebKit.isWebKitTab(popupTab),
    "New tab uses Firefox (Gecko) when host is not in whimsy.webkit.sites"
  );
  BrowserTestUtils.removeTab(popupTab);
  gBrowser.selectedTab = tab;

  // Switch the WebKit tab back to Firefox (Gecko) in place at the same URL (/page2).
  await WhimsyWebKit.setTabEngine(tab, "firefox");
  Assert.ok(!WhimsyWebKit.isWebKitTab(tab), "Tab switched back to Firefox");
  Assert.equal(
    gBrowser.tabs.indexOf(tab),
    originalIndex,
    "Switching back to Firefox keeps the tab in the same position"
  );
  Assert.equal(
    tab.linkedBrowser.currentURI.spec,
    gServer.url("/page2"),
    "Tab reloaded in Firefox at the same URL (/page2)"
  );
  Assert.ok(pill.hidden, "WebKit pill is hidden again after switching to Firefox");

  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(spacerTab);
});

add_webkit_task(async function test_site_list_and_cmdk_verbs() {
  if (!requireWebKit()) {
    return;
  }

  // Host pattern matching (exact and wildcard).
  WhimsyWebKit.setSites(["127.0.0.1", "*.example.org"]);
  Assert.ok(WhimsyWebKit.isSiteInWebKit("127.0.0.1"), "Exact host matches");
  Assert.ok(
    WhimsyWebKit.isSiteInWebKit("sub.example.org"),
    "Wildcard subdomain matches"
  );
  Assert.ok(
    WhimsyWebKit.isSiteInWebKit("example.org"),
    "Wildcard root domain matches"
  );
  Assert.ok(
    !WhimsyWebKit.isSiteInWebKit("example.com"),
    "Unlisted host does not match"
  );

  // Opening a tab to a host in whimsy.webkit.sites opens it in WebKit automatically.
  const autoTab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    gServer.url("/page1")
  );
  await TestUtils.waitForCondition(
    () => WhimsyWebKit.isWebKitTab(autoTab),
    "Opening a URL whose host is in whimsy.webkit.sites opens it in WebKit"
  );
  await TestUtils.waitForCondition(
    () => autoTab.label == "WebKit Test Page One",
    "Auto-opened WebKit tab finished loading page 1"
  );

  // New-window link when host IS in whimsy.webkit.sites opens the new tab in WebKit too.
  const countBefore = gBrowser.tabs.length;
  await WhimsyWebKit.evaluateInTab(
    autoTab,
    `window.open(${JSON.stringify(gServer.url("/popup"))}, "_blank")`
  );
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.length == countBefore + 1,
    "window.open opened a new tab"
  );
  const popupWebKitTab = gBrowser.selectedTab;
  await TestUtils.waitForCondition(
    () => WhimsyWebKit.isWebKitTab(popupWebKitTab),
    "New tab from window.open also opens in WebKit when its site is in the list"
  );
  BrowserTestUtils.removeTab(popupWebKitTab);
  gBrowser.selectedTab = autoTab;

  // W.1: Verify ⌘K verbs on a WebKit tab whose site is in the list.
  const subjectWebKit = await WhimsyVerbs.subjectFor(window);
  const verbsWebKit = WhimsyVerbs.verbsFor(window, subjectWebKit);
  const switchVerbWebKit = verbsWebKit.find(v => v.id == "webkit:switch-tab");
  const siteVerbWebKit = verbsWebKit.find(v => v.id == "webkit:toggle-site");
  Assert.ok(switchVerbWebKit, "Switch engine verb is present on WebKit tab");
  Assert.ok(siteVerbWebKit, "Toggle site verb is present on WebKit tab");
  Assert.equal(
    WhimsyVerbs.labelFor(switchVerbWebKit, subjectWebKit, window),
    "Open in Firefox",
    "⌘K verb in a WebKit tab reads 'Open in Firefox' (never 'Open in Whimsy')"
  );
  Assert.equal(
    WhimsyVerbs.labelFor(siteVerbWebKit, subjectWebKit, window),
    "Stop Opening 127.0.0.1 in WebKit",
    "⌘K site verb reads 'Stop Opening 127.0.0.1 in WebKit'"
  );

  // Run "Stop Opening 127.0.0.1 in WebKit" -> removes from site list and switches to Firefox.
  await WhimsyVerbs.runVerb(window, "webkit:toggle-site", subjectWebKit);
  await TestUtils.waitForCondition(
    () => !WhimsyWebKit.isWebKitTab(autoTab),
    "Stop Opening {host} in WebKit switches the tab back to Firefox"
  );
  Assert.ok(
    !WhimsyWebKit.isSiteInWebKit("127.0.0.1"),
    "127.0.0.1 was removed from whimsy.webkit.sites"
  );

  // W.1: Verify ⌘K verbs on a Firefox tab.
  const subjectFirefox = await WhimsyVerbs.subjectFor(window);
  const verbsFirefox = WhimsyVerbs.verbsFor(window, subjectFirefox);
  const switchVerbFirefox = verbsFirefox.find(v => v.id == "webkit:switch-tab");
  const siteVerbFirefox = verbsFirefox.find(v => v.id == "webkit:toggle-site");
  Assert.equal(
    WhimsyVerbs.labelFor(switchVerbFirefox, subjectFirefox, window),
    "Open in WebKit",
    "⌘K verb on a Firefox tab reads 'Open in WebKit'"
  );
  Assert.equal(
    WhimsyVerbs.labelFor(siteVerbFirefox, subjectFirefox, window),
    "Always Open 127.0.0.1 in WebKit",
    "⌘K site verb on a Firefox tab reads 'Always Open 127.0.0.1 in WebKit'"
  );

  // Run "Open in WebKit" via WhimsyVerbs.
  await WhimsyVerbs.runVerb(window, "webkit:switch-tab", subjectFirefox);
  await TestUtils.waitForCondition(
    () => WhimsyWebKit.isWebKitTab(autoTab),
    "Open in WebKit verb switches the tab to WebKit"
  );

  WhimsyWebKit.setSites([]);
  BrowserTestUtils.removeTab(autoTab);
});

add_webkit_task(async function test_overlays_first_mouse_shortcuts_and_focus_handoffs() {
  if (!requireWebKit()) {
    return;
  }

  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    gServer.url("/page1")
  );
  await WhimsyWebKit.setTabEngine(tab, "webkit");
  await TestUtils.waitForCondition(
    () => tab.label == "WebKit Test Page One",
    "WebKit tab ready"
  );

  const m = WhimsyWebKit.measureBrowserRect(window, tab.linkedBrowser);
  const cx = Math.round(m.x + m.width / 2);
  const cy = Math.round(m.y + m.height / 2);

  // 1. Hit-test inside the uncovered WebKit page area hits WebKit, and
  //    acceptsFirstMouse is true for first click into an inactive window.
  Assert.equal(
    WhimsyWebKit.hitTestAtTab(tab, cx, cy),
    "webkit",
    "Uncovered browser area hit-tests to the native WKWebView"
  );
  Assert.ok(
    WhimsyWebKit.acceptsFirstMouseAtTab(tab, cx, cy),
    "WKWebView accepts first mouse click in an inactive window (acceptsFirstMouse)"
  );

  // 2. Open a toast over the WebKit page: the hole subtracts the toast rect so
  //    clicks on the toast hit Gecko and never reach the WebKit page.
  const toastHandle = window.gZenUIManager.toasts.open(
    "whimsy-verb-copied-toast"
  );
  await TestUtils.waitForCondition(
    () =>
      toastHandle?.element?.isConnected &&
      toastHandle.element.getBoundingClientRect().width > 10,
    "Toast is visible over the window"
  );
  WhimsyWebKit.syncLayout(window);
  const toastRect = toastHandle.element.getBoundingClientRect();
  const tx = Math.round(toastRect.left + toastRect.width / 2);
  const ty = Math.round(toastRect.top + toastRect.height / 2);
  Assert.equal(
    WhimsyWebKit.hitTestAtTab(tab, tx, ty),
    "gecko",
    "Toast rectangle is subtracted from the ChildView hole so clicks on a toast hit Gecko, not WebKit"
  );
  closeToasts(window);
  WhimsyWebKit.syncLayout(window);

  // 3. Open the command bar (#urlbar[open]) over the WebKit page: its rect is
  //    subtracted from the hole so clicks on the command bar hit Gecko.
  gURLBar.select();
  gURLBar.startQuery({ allowAutofill: false, event: new Event("command") });
  await TestUtils.waitForCondition(
    () => gURLBar.hasAttribute("open") || gURLBar.hasAttribute("breakout-extend"),
    "Command bar is open"
  );
  WhimsyWebKit.syncLayout(window);
  const urlbarRect = document.getElementById("urlbar").getBoundingClientRect();
  const ux = Math.round(urlbarRect.left + urlbarRect.width / 2);
  const uy = Math.round(urlbarRect.top + urlbarRect.height / 2);
  Assert.equal(
    WhimsyWebKit.hitTestAtTab(tab, ux, uy),
    "gecko",
    "Open command bar rectangle is subtracted from the hole so clicks on it hit Gecko, not WebKit"
  );
  gURLBar.view.close();
  gURLBar.handleRevert();
  WhimsyWebKit.syncLayout(window);

  // 4. Reserved shortcuts: verify dynamic discovery from the window's keysets.
  const shortcuts = WhimsyWebKit.collectReservedShortcuts(window);
  Assert.ok(
    shortcuts.some(s => s.ctrl && !s.shift && s.keyCode == 48),
    "Ctrl+Tab is in the reserved shortcut list"
  );
  Assert.ok(
    shortcuts.some(s => s.ctrl && s.shift && s.keyCode == 48),
    "Ctrl+Shift+Tab is in the reserved shortcut list"
  );
  const domCtrlKeys = [...document.querySelectorAll("keyset key, key")].filter(
    k =>
      !k.hasAttribute("disabled") &&
      (k.getAttribute("modifiers") || "")
        .toLowerCase()
        .split(/[\s,]+/)
        .includes("control") &&
      (k.getAttribute("key") || k.getAttribute("keycode"))
  );
  Assert.greater(
    domCtrlKeys.length,
    0,
    "Found Control-modified bindings in the window's keysets"
  );
  for (const keyEl of domCtrlKeys) {
    const k = (keyEl.getAttribute("key") || "").toLowerCase();
    if (k) {
      Assert.ok(
        shortcuts.some(s => s.ctrl && s.key == k),
        `Keyset Control binding (${keyEl.id || k}) was discovered dynamically`
      );
    }
  }

  // 5. Focus hand-offs: ⌘L, ⌘T, and ⌘W.
  WhimsyWebKit.focusTab(tab);
  Assert.ok(
    WhimsyWebKit.isTabFocused(tab),
    "WKWebView holds native firstResponder focus"
  );

  // ⌘L (Browser:OpenLocation) hands focus from WKWebView to the address bar.
  document.getElementById("Browser:OpenLocation").doCommand();
  Assert.ok(
    !WhimsyWebKit.isTabFocused(tab),
    "⌘L blurs the WKWebView and returns firstResponder to Gecko's ChildView"
  );
  Assert.ok(gURLBar.focused, "⌘L focuses gURLBar");

  // Return focus to WKWebView, then press ⌘T (cmd_newNavigatorTab).
  WhimsyWebKit.focusTab(tab);
  Assert.ok(WhimsyWebKit.isTabFocused(tab), "WKWebView re-focused");
  document.getElementById("cmd_newNavigatorTab").doCommand();
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab != tab,
    "⌘T opened and selected a new tab"
  );
  const newTab = gBrowser.selectedTab;
  Assert.ok(
    !WhimsyWebKit.isTabFocused(tab),
    "⌘T handed focus away from the background WebKit tab"
  );
  Assert.ok(
    document.getElementById("whimsy-webkit-pill").hidden,
    "WebKit pill hides when switching to the new Firefox tab"
  );
  BrowserTestUtils.removeTab(newTab);
  gBrowser.selectedTab = tab;

  // Focus WKWebView and close the tab (⌘W / removeTab).
  WhimsyWebKit.focusTab(tab);
  BrowserTestUtils.removeTab(tab);
  Assert.ok(
    document.getElementById("whimsy-webkit-pill").hidden,
    "Closing the WebKit tab hides the pill and cleans up native state"
  );
});

add_webkit_task(async function test_both_engine_panels_and_contrast_with_screenshots() {
  if (!requireWebKit()) {
    return;
  }

  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    gServer.url("/page1")
  );
  const pill = document.getElementById("whimsy-webkit-pill");
  Assert.ok(pill.hidden, "Pill is hidden before switching to WebKit");

  // 1. Open the Site Panel (#zen-unified-site-data-panel) and switch to WebKit
  //    using its Engine segmented control.
  await WhimsySiteSettings.open(window);
  const sitePanel = document.getElementById("zen-unified-site-data-panel");
  const siteEngineRow = sitePanel.querySelector('[whimsy-site-setting="engine"]');
  const siteAlwaysRow = sitePanel.querySelector(
    '[whimsy-site-setting="engine-always"]'
  );
  Assert.ok(siteEngineRow, "Engine row is present in the site panel");
  Assert.ok(
    siteAlwaysRow,
    "'Always use for this site' row is present in the site panel"
  );

  const siteSegButtons = [
    ...siteEngineRow.querySelectorAll(".whimsy-surface-segment"),
  ];
  Assert.deepEqual(
    siteSegButtons.map(b => b.querySelector(".whimsy-surface-segment-label").textContent.trim()),
    ["Firefox", "WebKit"],
    "Site panel Engine row reads 'Firefox | WebKit'"
  );
  Assert.equal(
    siteSegButtons[0].getAttribute("aria-checked"),
    "true",
    "Firefox segment is active initially in the site panel"
  );

  // Click "WebKit" in the site panel.
  siteSegButtons[1].click();
  await TestUtils.waitForCondition(
    () => WhimsyWebKit.isWebKitTab(tab) && !pill.hidden,
    "Clicking WebKit in the site panel switches the tab to WebKit and shows the pill"
  );

  const siteNote = sitePanel.querySelector(".whimsy-webkit-engine-note");
  Assert.ok(
    siteNote && !siteNote.hidden,
    "WebKit feature note is visible in the site panel while WebKit is active"
  );
  Assert.equal(
    siteNote.textContent.trim(),
    "Some Whimsy features don’t work in WebKit tabs, like extensions, Dark Pages, and annotations.",
    "WebKit note copy matches mockup with curly apostrophe and Oxford comma"
  );

  // Light and dark screenshots + WCAG AA contrast assertions for the pill and
  // the site panel's Engine rows.
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    WhimsySiteSettings.render(window);
    await whimsySettled();

    const pillFg = parseRGBA(getComputedStyle(pill).color);
    const pillBg = effectiveBackground(pill);
    const pillContrast = contrastRatio(pillFg, pillBg);
    Assert.greaterOrEqual(
      pillContrast,
      4.5,
      `WebKit address-bar pill meets WCAG AA contrast (>= 4.5:1) in ${dark ? "dark" : "light"} mode (got ${pillContrast.toFixed(2)})`
    );

    const rowLabel = sitePanel.querySelector(
      "#whimsy-site-settings-engine-label"
    );
    const rowFg = parseRGBA(getComputedStyle(rowLabel).color);
    const rowBg = effectiveBackground(rowLabel);
    const rowContrast = contrastRatio(rowFg, rowBg);
    Assert.greaterOrEqual(
      rowContrast,
      4.5,
      `Site panel Engine label meets WCAG AA contrast in ${dark ? "dark" : "light"} mode (got ${rowContrast.toFixed(2)})`
    );

    for (const btn of sitePanel.querySelectorAll(
      "#whimsy-site-settings-engine-seg .whimsy-surface-segment"
    )) {
      const fg = parseRGBA(getComputedStyle(btn).color);
      const bg = effectiveBackground(btn);
      const ratio = contrastRatio(fg, bg);
      Assert.greaterOrEqual(
        ratio,
        4.5,
        `Site panel segment '${btn.textContent.trim()}' meets WCAG AA contrast in ${dark ? "dark" : "light"} mode (got ${ratio.toFixed(2)})`
      );
    }

    const undoStandIn = whimsyStandInPopups(document);
    try {
      await whimsyShot(`webkit-site-panel-${dark ? "dark" : "light"}`);
    } finally {
      undoStandIn();
    }
    await SpecialPowers.popPrefEnv();
  }

  await WhimsySiteSettings.hidePanel(window);

  // 2. Open the Puzzle Button's Panel (#unified-extensions-panel) and verify
  //    the exact same Engine control, strings, contrast, and behaviour.
  const extPanel = await WhimsyWebKit.openExtensionsPanel(window);
  Assert.ok(
    extPanel && extPanel.state == "open",
    "Unified extensions panel opened"
  );
  const extEngineRow = extPanel.querySelector('[whimsy-site-setting="engine"]');
  const extAlwaysRow = extPanel.querySelector(
    '[whimsy-site-setting="engine-always"]'
  );
  Assert.ok(
    extEngineRow,
    "Engine row is present in the unified extensions panel"
  );
  Assert.ok(
    extAlwaysRow,
    "'Always use for this site' row is present in the unified extensions panel"
  );

  const extSegButtons = [
    ...extEngineRow.querySelectorAll(".whimsy-surface-segment"),
  ];
  Assert.deepEqual(
    extSegButtons.map(b => b.querySelector(".whimsy-surface-segment-label").textContent.trim()),
    ["Firefox", "WebKit"],
    "Extensions panel Engine row reads 'Firefox | WebKit'"
  );
  Assert.equal(
    extSegButtons[1].getAttribute("aria-checked"),
    "true",
    "WebKit segment reflects the current engine in the extensions panel"
  );

  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    WhimsyWebKit.renderExtensionsPanel(window);
    await whimsySettled();

    const rowLabel = extPanel.querySelector(
      "#whimsy-extensions-panel-engine-label"
    );
    const rowFg = parseRGBA(getComputedStyle(rowLabel).color);
    const rowBg = effectiveBackground(rowLabel);
    const rowContrast = contrastRatio(rowFg, rowBg);
    Assert.greaterOrEqual(
      rowContrast,
      4.5,
      `Extensions panel Engine label meets WCAG AA contrast in ${dark ? "dark" : "light"} mode (got ${rowContrast.toFixed(2)})`
    );

    for (const btn of extPanel.querySelectorAll(
      "#whimsy-extensions-panel-engine-seg .whimsy-surface-segment"
    )) {
      const fg = parseRGBA(getComputedStyle(btn).color);
      const bg = effectiveBackground(btn);
      const ratio = contrastRatio(fg, bg);
      Assert.greaterOrEqual(
        ratio,
        4.5,
        `Extensions panel segment '${btn.textContent.trim()}' meets WCAG AA contrast in ${dark ? "dark" : "light"} mode (got ${ratio.toFixed(2)})`
      );
    }

    const undoStandIn = whimsyStandInPopups(document);
    try {
      await whimsyShot(`webkit-extensions-panel-${dark ? "dark" : "light"}`);
    } finally {
      undoStandIn();
    }
    await SpecialPowers.popPrefEnv();
  }

  // Switch back to Firefox from the Puzzle Button's Panel.
  const firefoxBtn = extPanel.querySelector(
    '#whimsy-extensions-panel-engine-seg .whimsy-surface-segment[data-value="firefox"]'
  );
  firefoxBtn.click();
  await TestUtils.waitForCondition(
    () => !WhimsyWebKit.isWebKitTab(tab) && pill.hidden,
    "Clicking Firefox in the extensions panel switches the tab back to Firefox"
  );

  await WhimsyWebKit.hideExtensionsPanel(window);
  BrowserTestUtils.removeTab(tab);
});

// Owner report (W30): "WebKit pages are dimmer than Firefox." The WKWebView
// sits below Gecko's view, so anything Gecko paints in the browser's rect (the
// window's theme gradient, its translucent dark default, grain) lands on top
// of the page. These read back what the window server really shows and check
// that a WebKit page looks exactly like the same page in a Firefox tab: white
// stays white and grey stays grey, in dark and light windows and under a
// translucent coloured theme, while the chrome around the page is unchanged.
function sampleWindow(rect) {
  return JSON.parse(
    WhimsyWebKit.service.sampleWindowColor(
      window,
      rect.x,
      rect.y,
      rect.width,
      rect.height
    )
  );
}

function describeSample(s) {
  const rgb = `rgb(${s.r.toFixed(1)}, ${s.g.toFixed(1)}, ${s.b.toFixed(1)})`;
  return "a" in s ? `${rgb} a=${s.a.toFixed(1)} [${s.min}..${s.max}]` : rgb;
}

// Samples until two reads in a row agree, so the window has finished
// painting (Gecko's frame and the WKWebView's) before anything is compared.
async function settledSample(rect, what) {
  let prev = null;
  let cur = null;
  await TestUtils.waitForCondition(() => {
    cur = sampleWindow(rect);
    const same =
      prev &&
      ["r", "g", "b", "a"].every(k => Math.abs(prev[k] - cur[k]) < 0.5);
    prev = cur;
    return same && cur.a >= 254.5;
  }, `${what} has settled`);
  info(`${what}: ${describeSample(cur)}`);
  return cur;
}

function compositeRegions(browser) {
  const r = browser.getBoundingClientRect();
  const { radius } = WhimsyWebKit.measureBrowserRect(window, browser);
  const inset = Math.ceil(radius) + 4;
  const regions = {
    // Strips across the upper and lower parts of the page catch a hole that
    // is misplaced vertically, the centre block catches any tint at all.
    // (The very top of the page is left out: Whimsy's own hints can sit
    // there, above the page, in either engine.)
    top: { x: r.left + inset, y: Math.round(r.top + r.height / 4), width: r.width - 2 * inset, height: 6 },
    centre: {
      x: Math.round(r.left + r.width / 2 - 40),
      y: Math.round(r.top + r.height / 2 - 40),
      width: 80,
      height: 80,
    },
    bottom: { x: r.left + inset, y: r.bottom - 18, width: r.width - 2 * inset, height: 6 },
  };
  // The gap between the sidebar and the page card: chrome that must look the
  // same whichever engine the tab uses.
  const gap = r.left >= 6
    ? { x: r.left - 4, y: Math.round(r.top + r.height / 2 - 40), width: 2, height: 80 }
    : null;
  return { regions, gap };
}

function assertSameColour(actual, expected, tolerance, what) {
  const worst = Math.max(
    ...["r", "g", "b"].map(k => Math.abs(actual[k] - expected[k]))
  );
  Assert.lessOrEqual(
    worst,
    tolerance,
    `${what}: ${describeSample(actual)} matches ${describeSample(expected)} (off by ${worst.toFixed(1)})`
  );
}

async function setTranslucentTheme(colour) {
  const bg = document.getElementById("zen-browser-background");
  const old = {};
  for (const name of [
    "--zen-main-browser-background",
    "--zen-main-browser-background-old",
  ]) {
    old[name] = bg.style.getPropertyValue(name);
    if (colour) {
      bg.style.setProperty(name, colour);
    }
  }
  return () => {
    for (const [name, value] of Object.entries(old)) {
      if (value) {
        bg.style.setProperty(name, value);
      } else {
        bg.style.removeProperty(name);
      }
    }
  };
}

add_webkit_task(async function test_webkit_page_is_not_dimmed() {
  if (!requireWebKit()) {
    return;
  }
  for (const { scheme, name } of [
    { scheme: 0, name: "dark" },
    { scheme: 1, name: "light" },
  ]) {
    await SpecialPowers.pushPrefEnv({
      set: [["zen.view.window.scheme", scheme]],
    });

    const tab = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      gServer.url("/solid/808080")
    );
    try {
      await checkEngineComposite(tab, name);
    } finally {
      if (tab.isConnected) {
        BrowserTestUtils.removeTab(tab);
      }
      await SpecialPowers.popPrefEnv();
    }
  }
});

async function checkEngineComposite(tab, name) {
  {
    const browser = tab.linkedBrowser;
    const { regions, gap } = compositeRegions(browser);

    // The same pages in a Firefox tab are the reference.
    const ffGrey = await settledSample(regions.centre, `${name}: Firefox grey page`);
    BrowserTestUtils.startLoadingURIString(browser, gServer.url("/solid/ffffff"));
    await BrowserTestUtils.browserLoaded(browser);
    const ffWhite = {};
    for (const [key, rect] of Object.entries(regions)) {
      ffWhite[key] = await settledSample(rect, `${name}: Firefox white page, ${key}`);
      assertSameColour(ffWhite[key], { r: 255, g: 255, b: 255 }, 2,
        `${name}: a white page in a Firefox tab is white (${key})`);
    }
    const ffGap = gap && (await settledSample(gap, `${name}: chrome beside a Firefox tab`));

    await WhimsyWebKit.setTabEngine(tab, "webkit");
    Assert.ok(WhimsyWebKit.isWebKitTab(tab), `${name}: the tab is a WebKit tab`);
    for (const [key, rect] of Object.entries(regions)) {
      const wk = await settledSample(rect, `${name}: WebKit white page, ${key}`);
      assertSameColour(wk, { r: 255, g: 255, b: 255 }, 2,
        `${name}: a white page in a WebKit tab composites to white (${key})`);
    }
    if (gap) {
      const wkGap = await settledSample(gap, `${name}: chrome beside a WebKit tab`);
      assertSameColour(wkGap, ffGap, 2,
        `${name}: the chrome beside the page looks the same for both engines`);
    }

    await WhimsyWebKit.loadURLInTab(tab, gServer.url("/solid/808080"));
    const wkGrey = await settledSample(regions.centre, `${name}: WebKit grey page`);
    assertSameColour(wkGrey, ffGrey, 3,
      `${name}: a grey page in a WebKit tab matches the Firefox tab`);

    // A translucent coloured theme (what a space gradient with transparency
    // gives) must not tint the page either.
    const restoreTheme = await setTranslucentTheme("rgba(90, 40, 160, 0.55)");
    try {
      const tinted = await settledSample(regions.centre, `${name}: WebKit grey page, coloured theme`);
      assertSameColour(tinted, ffGrey, 3,
        `${name}: a coloured theme doesn't tint a WebKit page`);
    } finally {
      restoreTheme();
    }

    // Back in Firefox, nothing of the WebKit tab's treatment is left.
    await WhimsyWebKit.setTabEngine(tab, "firefox");
    Assert.ok(!WhimsyWebKit.isWebKitTab(tab), `${name}: the tab is back in Firefox`);
    const backGrey = await settledSample(regions.centre, `${name}: Firefox grey page again`);
    assertSameColour(backGrey, ffGrey, 2,
      `${name}: the Firefox tab looks as it did before the switch`);
    if (gap) {
      const backGap = await settledSample(gap, `${name}: chrome beside the Firefox tab again`);
      assertSameColour(backGap, ffGap, 2,
        `${name}: the chrome beside a Firefox tab is unchanged after the switch`);
    }
  }
}

add_webkit_task(async function test_private_windows_hide_all_webkit_ui() {
  const privWin = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  await BrowserTestUtils.startLoadingURIString(
    privWin.gBrowser.selectedBrowser,
    gServer.url("/page1")
  );
  await BrowserTestUtils.browserLoaded(privWin.gBrowser.selectedBrowser);

  Assert.ok(
    !WhimsyWebKit.available(privWin),
    "WebKit tabs are unavailable in a private window"
  );
  Assert.ok(
    !WhimsyWebKit.availableForTab(privWin.gBrowser.selectedTab),
    "WebKit tabs are unavailable for a private window's tab"
  );

  const privPill = privWin.document.getElementById("whimsy-webkit-pill");
  Assert.ok(
    !privPill || privPill.hidden,
    "WebKit pill is never shown in a private window"
  );

  const subject = await WhimsyVerbs.subjectFor(privWin);
  const verbs = subject ? WhimsyVerbs.verbsFor(privWin, subject) : [];
  Assert.ok(
    !verbs.some(v => v.id.startsWith("webkit:")),
    "No WebKit ⌘K verbs are offered in a private window"
  );

  await WhimsySiteSettings.open(privWin);
  const privSitePanel = privWin.document.getElementById(
    "zen-unified-site-data-panel"
  );
  Assert.ok(
    !privSitePanel?.querySelector('[whimsy-site-setting="engine"]'),
    "Engine row is hidden in a private window's site panel"
  );
  await WhimsySiteSettings.hidePanel(privWin);

  await BrowserTestUtils.closeWindow(privWin);
});

// ---------------------------------------------------------------------------
// W32: WebKit parity (discards, crashes, delegate requests through Gecko's
// prompts and services, and the epoch guard).

const { PromptTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromptTestUtils.sys.mjs"
);
const { Downloads } = ChromeUtils.importESModule(
  "resource://gre/modules/Downloads.sys.mjs"
);
const { SitePermissions } = ChromeUtils.importESModule(
  "resource:///modules/SitePermissions.sys.mjs"
);

// A WebKit tab, selected, showing aPath from the local server.
async function openWebKitTab(path = "/page1", title = "WebKit Test Page One") {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    gServer.url(path)
  );
  await WhimsyWebKit.setTabEngine(tab, "webkit");
  Assert.ok(WhimsyWebKit.isWebKitTab(tab), "The tab is a WebKit tab");
  await TestUtils.waitForCondition(
    () => tab.label == title && !tab.hasAttribute("busy"),
    `WebKit loaded ${path}`
  );
  return tab;
}

add_webkit_task(async function test_w32_discard_keeps_history_and_scroll() {
  if (!requireWebKit()) {
    return;
  }
  const tab = await openWebKitTab();
  await WhimsyWebKit.loadURLInTab(tab, gServer.url("/tall"));
  await TestUtils.waitForCondition(
    () => tab.label == "Tall Page" && !tab.hasAttribute("busy"),
    "The tall page loaded in WebKit"
  );
  await WhimsyWebKit.evaluateInTab(tab, "window.scrollTo(0, 1500), true");
  await TestUtils.waitForCondition(
    async () => (await WhimsyWebKit.evaluateInTab(tab, "window.scrollY")) >= 1400,
    "The tall page scrolled"
  );

  const other = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    gServer.url("/page2")
  );
  const discarded = BrowserTestUtils.waitForEvent(tab, "TabBrowserDiscarded");
  gBrowser.discardBrowser(tab, true);
  await discarded;
  const state = WhimsyWebKit.stateOf(tab);
  Assert.ok(!tab.linkedPanel, "Gecko discarded the WebKit tab");
  Assert.equal(state.id, 0, "Discarding the tab freed its WKWebView");
  Assert.ok(WhimsyWebKit.isWebKitTab(tab), "A discarded WebKit tab stays a WebKit tab");
  Assert.equal(
    tab.linkedBrowser.currentURI.spec,
    gServer.url("/tall"),
    "The discarded tab keeps the WebKit page's address"
  );

  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(
    () => state.id && tab.label == "Tall Page" && !tab.hasAttribute("busy"),
    "Selecting the discarded tab brings its WebKit page back"
  );
  Assert.equal(
    WhimsyWebKit.currentURIOf(tab)?.spec,
    gServer.url("/tall"),
    "The restored tab shows the page it was on"
  );
  await TestUtils.waitForCondition(
    async () => (await WhimsyWebKit.evaluateInTab(tab, "window.scrollY")) >= 1400,
    "The restored page keeps its scroll position"
  );
  Assert.ok(
    !document.getElementById("Browser:Back").hasAttribute("disabled"),
    "The restored tab can go back"
  );
  WhimsyWebKit.goBack(tab);
  await TestUtils.waitForCondition(
    () => tab.label == "WebKit Test Page One" && !tab.hasAttribute("busy"),
    "Back goes to the page before the tall one: the history survived"
  );
  BrowserTestUtils.removeTab(other);
});

add_webkit_task(async function test_w32_crash_shows_tabcrashed_and_restores() {
  if (!requireWebKit()) {
    return;
  }
  const tab = await openWebKitTab();
  const state = WhimsyWebKit.stateOf(tab);
  const browser = tab.linkedBrowser;
  WhimsyWebKit.service.killWebContentProcessForTesting(state.id);
  await TestUtils.waitForCondition(
    () => browser.contentDocument?.documentURI?.startsWith("about:tabcrashed"),
    "A crashed WebKit tab shows Gecko's tab-crashed page"
  );
  Assert.equal(state.geckoPage, "tabcrashed", "The tab is on the tab-crashed page");
  Assert.ok(tab.hasAttribute("crashed"), "The tab is marked crashed, as Gecko marks one");
  Assert.ok(!tab.hasAttribute("busy"), "A crashed tab isn't left busy");

  const restore = await TestUtils.waitForCondition(
    () => browser.contentDocument?.getElementById("restoreTab"),
    "The tab-crashed page has its Restore button"
  );
  restore.click();
  await TestUtils.waitForCondition(
    () => !state.geckoPage && !state.crashed && !tab.hasAttribute("crashed"),
    "Restore puts the WebKit page back"
  );
  await TestUtils.waitForCondition(
    () => tab.label == "WebKit Test Page One" && !tab.hasAttribute("busy"),
    "The restored WebKit page reloads"
  );
  Assert.equal(
    await WhimsyWebKit.evaluateInTab(tab, "document.getElementById('heading').textContent"),
    "First Page",
    "The restored page runs"
  );

  // A background tab whose page crashed reloads when it's selected.
  const other = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    gServer.url("/page2")
  );
  WhimsyWebKit.service.killWebContentProcessForTesting(state.id);
  await TestUtils.waitForCondition(() => state.crashed, "The background page crashed");
  Assert.ok(!state.geckoPage, "A background crash waits for the tab to be selected");
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(
    () => !state.crashed && tab.label == "WebKit Test Page One" && !tab.hasAttribute("busy"),
    "Selecting a crashed background tab reloads its page"
  );
  Assert.equal(
    await WhimsyWebKit.evaluateInTab(tab, "1 + 1"),
    2,
    "The reloaded page runs"
  );
  BrowserTestUtils.removeTab(other);
});

add_webkit_task(async function test_w32_alert_confirm_prompt_use_tab_prompts() {
  if (!requireWebKit()) {
    return;
  }
  const tab = await openWebKitTab();
  const browser = tab.linkedBrowser;
  const modalType = Services.prompt.MODAL_TYPE_TAB;
  const host = `127.0.0.1:${gServer.port}`;

  let result = WhimsyWebKit.evaluateInTab(tab, "alert('Hello from WebKit'), 'done'");
  let dialog = await PromptTestUtils.waitForPrompt(browser, { modalType, promptType: "alert" });
  Assert.equal(dialog.args.text, "Hello from WebKit", "alert() shows Gecko's tab prompt with its message");
  Assert.equal(dialog.args.title, host, "The prompt is titled with the page's host");
  await PromptTestUtils.handlePrompt(dialog);
  Assert.equal(await result, "done", "alert() returns once the prompt closes");

  // evaluateInTab hands back primitives as strings, so the page reports
  // what it got with JSON.stringify.
  result = WhimsyWebKit.evaluateInTab(tab, "JSON.stringify(confirm('Sure?'))");
  await PromptTestUtils.handleNextPrompt(browser, { modalType, promptType: "confirm" }, { buttonNumClick: 0 });
  Assert.equal(await result, "true", "confirm() returns true for OK");
  result = WhimsyWebKit.evaluateInTab(tab, "JSON.stringify(confirm('Sure?'))");
  await PromptTestUtils.handleNextPrompt(browser, { modalType, promptType: "confirm" }, { buttonNumClick: 1 });
  Assert.equal(await result, "false", "confirm() returns false for Cancel");

  result = WhimsyWebKit.evaluateInTab(tab, "JSON.stringify(prompt('Name?', 'default'))");
  dialog = await PromptTestUtils.waitForPrompt(browser, { modalType, promptType: "prompt" });
  Assert.equal(dialog.ui.loginTextbox.value, "default", "prompt() fills in its default value");
  await PromptTestUtils.handlePrompt(dialog, { loginInput: "Whimsy" });
  Assert.equal(await result, '"Whimsy"', "prompt() returns what was typed");
  result = WhimsyWebKit.evaluateInTab(tab, "JSON.stringify(prompt('Name?'))");
  await PromptTestUtils.handleNextPrompt(browser, { modalType, promptType: "prompt" }, { buttonNumClick: 1 });
  Assert.equal(await result, "null", "prompt() returns null when cancelled");
});

add_webkit_task(async function test_w32_file_input_uses_firefox_file_picker() {
  if (!requireWebKit()) {
    return;
  }
  const tab = await openWebKitTab("/file", "File Page");
  const path = PathUtils.join(PathUtils.tempDir, "whimsy-webkit-upload.txt");
  await IOUtils.writeUTF8(path, "upload me");
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  try {
    let shownMode = null;
    MockFilePicker.showCallback = fp => {
      shownMode = fp.mode;
    };
    MockFilePicker.returnValue = MockFilePicker.returnOK;
    MockFilePicker.setFiles([new FileUtils.File(path)]);
    await WhimsyWebKit.evaluateInTab(tab, "document.getElementById('f').click(), true");
    await TestUtils.waitForCondition(
      async () =>
        (await WhimsyWebKit.evaluateInTab(
          tab,
          "document.getElementById('f').files[0]?.name || ''"
        )) == "whimsy-webkit-upload.txt",
      "The file chosen in Firefox's file picker reaches the WebKit page"
    );
    Assert.equal(shownMode, Ci.nsIFilePicker.modeOpen, "A single-file input opens the picker for one file");
  } finally {
    MockFilePicker.cleanup();
    await IOUtils.remove(path, { ignoreAbsent: true });
  }
});

add_webkit_task(async function test_w32_http_auth_uses_firefox_auth_prompt() {
  if (!requireWebKit()) {
    return;
  }
  const tab = await openWebKitTab();
  const browser = tab.linkedBrowser;
  const modalType = Services.prefs.getIntPref(
    "prompts.modalType.httpAuth",
    Services.prompt.MODAL_TYPE_TAB
  );
  const prompted = PromptTestUtils.waitForPrompt(browser, {
    modalType,
    promptType: "promptUserAndPass",
  });
  WhimsyWebKit.loadURLInTab(tab, gServer.url("/auth"), { waitForLoad: false });
  const dialog = await prompted;
  if (modalType == Services.prompt.MODAL_TYPE_TAB) {
    // Tab-modal auth prompts carry Firefox's standard sign-in message; the
    // dialog's title names the site.
    const bundle = Services.strings.createBundle(
      "chrome://global/locale/commonDialogs.properties"
    );
    Assert.equal(
      dialog.args.text,
      bundle.GetStringFromName("EnterCredentials"),
      "Firefox's own auth prompt asks for the login"
    );
  } else {
    Assert.ok(dialog.args.text.includes("127.0.0.1"), "Firefox's auth prompt names the site asking");
  }
  await PromptTestUtils.handlePrompt(dialog, {
    loginInput: "whimsy",
    passwordInput: "secret",
  });
  await TestUtils.waitForCondition(
    () => tab.label == "Auth OK" && !tab.hasAttribute("busy"),
    "The credentials from Firefox's prompt signed WebKit in"
  );
  // The password manager offers to save the login; leave it unsaved.
  try {
    await TestUtils.waitForCondition(
      () => PopupNotifications.getNotification("password", browser),
      "The password manager offers to save the login",
      100,
      30
    );
  } catch {}
  PopupNotifications.getNotification("password", browser)?.remove();
  Assert.equal(
    (await Services.logins.getAllLogins()).filter(l => l.httpRealm == "Whimsy Test Realm").length,
    0,
    "Nothing is saved without the password manager's own Save"
  );
});

add_webkit_task(async function test_w32_camera_uses_firefox_doorhanger() {
  if (!requireWebKit()) {
    return;
  }
  await SpecialPowers.pushPrefEnv({ set: [["media.navigator.streams.fake", true]] });
  const tab = await openWebKitTab();
  const state = WhimsyWebKit.stateOf(tab);
  const origin = `http://127.0.0.1:${gServer.port}`;
  const principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin(origin);
  const responses = [];
  const origRespond = WhimsyWebKit._respond;
  const origDevices = WhimsyWebKit._captureDevices;
  WhimsyWebKit._respond = (id, req, response) => responses.push({ req, ...response });
  WhimsyWebKit._captureDevices = () => ({
    camera: { name: "Whimsy Test Camera", id: "whimsy-test-camera" },
  });
  try {
    // WebKit asks for the camera: Gecko's sharing doorhanger answers.
    let shown = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popupshown");
    await WhimsyWebKit._onMedia(tab, state, state.id, { req: 41, origin, camera: true });
    await shown;
    let notification = PopupNotifications.getNotification("webRTC-shareDevices", tab.linkedBrowser);
    Assert.ok(notification, "A WebKit camera request shows Firefox's camera doorhanger");
    const panel = PopupNotifications.panel.firstElementChild;
    if (panel.checkbox) {
      panel.checkbox.checked = false;
    }
    panel.button.click();
    await TestUtils.waitForCondition(() => responses.length == 1, "The doorhanger answered WebKit");
    Assert.deepEqual(responses[0], { req: 41, allow: true }, "Allow lets WebKit use the camera");

    // A blocked site is refused without asking.
    SitePermissions.setForPrincipal(principal, "camera", SitePermissions.BLOCK);
    await WhimsyWebKit._onMedia(tab, state, state.id, { req: 42, origin, camera: true });
    Assert.deepEqual(responses[1], { req: 42, allow: false }, "A blocked camera is refused");
    SitePermissions.removeFromPrincipal(principal, "camera");
    SitePermissions.clearTemporaryBlockPermissions(tab.linkedBrowser);

    // Leaving the page withdraws an open request.
    shown = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popupshown");
    await WhimsyWebKit._onMedia(tab, state, state.id, { req: 43, origin, camera: true });
    await shown;
    await WhimsyWebKit.loadURLInTab(tab, gServer.url("/page2"));
    await TestUtils.waitForCondition(
      () => responses.some(r => r.req == 43),
      "Leaving the page answers the open request"
    );
    Assert.deepEqual(responses.find(r => r.req == 43), { req: 43, allow: false }, "A withdrawn request is refused");
    await TestUtils.waitForCondition(
      () => !PopupNotifications.getNotification("webRTC-shareDevices", tab.linkedBrowser),
      "Its doorhanger goes away"
    );
  } finally {
    WhimsyWebKit._respond = origRespond;
    WhimsyWebKit._captureDevices = origDevices;
    for (const perm of SitePermissions.getAllForBrowser(tab.linkedBrowser)) {
      SitePermissions.removeFromPrincipal(principal, perm.id, tab.linkedBrowser);
    }
    Services.perms.removeFromPrincipal(principal, "MediaManagerVideo");
    await SpecialPowers.popPrefEnv();
  }
});

add_webkit_task(async function test_w32_downloads_join_firefox_downloads() {
  if (!requireWebKit()) {
    return;
  }
  const dir = PathUtils.join(PathUtils.tempDir, `whimsy-webkit-downloads-${Date.now()}`);
  await IOUtils.makeDirectory(dir);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.useDownloadDir", true],
      ["browser.download.folderList", 2],
      ["browser.download.dir", dir],
      ["browser.download.alwaysOpenPanel", false],
    ],
  });
  const list = await Downloads.getList(Downloads.ALL);
  const added = [];
  const view = { onDownloadAdded: d => added.push(d) };
  await list.addView(view);
  try {
    const tab = await openWebKitTab();
    WhimsyWebKit.loadURLInTab(tab, gServer.url("/download"), { waitForLoad: false });
    await TestUtils.waitForCondition(
      () => added.some(d => d.source.url == gServer.url("/download")),
      "WebKit's download shows up in Firefox's downloads list"
    );
    const download = added.find(d => d.source.url == gServer.url("/download"));
    await TestUtils.waitForCondition(() => download.stopped, "The download finished");
    Assert.ok(download.succeeded, "The download succeeded");
    Assert.equal(PathUtils.parent(download.target.path), dir, "It saved to Firefox's download folder");
    Assert.equal(PathUtils.filename(download.target.path), "whimsy-webkit-test.bin", "It kept the site's file name");
    Assert.equal(
      await IOUtils.readUTF8(download.target.path),
      "whimsy webkit download\n",
      "The file holds what the site sent"
    );
    Assert.equal(
      WhimsyWebKit.currentURIOf(tab)?.spec,
      gServer.url("/page1"),
      "The tab stays on its page"
    );
  } finally {
    await list.removeView(view);
    for (const d of added) {
      await list.remove(d);
      await d.finalize(true).catch(() => {});
    }
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    await SpecialPowers.popPrefEnv();
  }
});

// A TLS server on 127.0.0.1 with a certificate neither engine trusts.
async function startUntrustedTLSServer() {
  const certDB = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB);
  certDB.importPKCS12File(new FileUtils.File(getTestFilePath("whimsy_webkit_tls.p12")), "password");
  const cert = (await certDB.getCerts()).find(c => c.commonName == "Test End-entity");
  Assert.ok(cert, "The test server certificate is available");
  const srv = Cc["@mozilla.org/network/tls-server-socket;1"].createInstance(Ci.nsITLSServerSocket);
  srv.init(-1, true, -1);
  srv.serverCert = cert;
  srv.setSessionTickets(false);
  srv.setRequestClientCertificate(Ci.nsITLSServerSocket.REQUEST_NEVER);
  const transports = [];
  const body =
    '<!doctype html><html><head><meta charset="utf-8"><title>Secure Page</title></head><body><h1 id="heading">Secure</h1></body></html>';
  srv.asyncListen({
    onSocketAccepted(_socket, transport) {
      transports.push(transport);
      const input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
      const output = transport.openOutputStream(0, 0, 0);
      const scriptable = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
        Ci.nsIScriptableInputStream
      );
      scriptable.init(input);
      let request = "";
      const read = () =>
        input.asyncWait(
          {
            onInputStreamReady() {
              try {
                const avail = scriptable.available();
                if (avail > 0) {
                  request += scriptable.read(avail);
                }
              } catch {
                return;
              }
              if (!request.includes("\r\n\r\n")) {
                read();
                return;
              }
              const response =
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n" +
                `Content-Length: ${body.length}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n` +
                body;
              try {
                output.write(response, response.length);
                output.close();
                input.close();
              } catch {}
            },
          },
          0,
          0,
          Services.tm.mainThread
        );
      transport.securityCallbacks
        .getInterface(Ci.nsITLSServerConnectionInfo)
        .setSecurityObserver({ onHandshakeDone: () => read() });
    },
    onStopListening() {},
  });
  return {
    cert,
    port: srv.port,
    url: `https://127.0.0.1:${srv.port}/`,
    close() {
      for (const t of transports) {
        try {
          t.close(Cr.NS_OK);
        } catch {}
      }
      srv.close();
    },
  };
}

add_webkit_task(async function test_w32_untrusted_certificate_uses_gecko_error_page() {
  if (!requireWebKit()) {
    return;
  }
  const tls = await startUntrustedTLSServer();
  const overrides = Cc["@mozilla.org/security/certoverride;1"].getService(
    Ci.nsICertOverrideService
  );
  try {
    const tab = await openWebKitTab();
    const state = WhimsyWebKit.stateOf(tab);
    const browser = tab.linkedBrowser;
    WhimsyWebKit.loadURLInTab(tab, tls.url, { waitForLoad: false });
    await TestUtils.waitForCondition(
      () =>
        browser.browsingContext?.currentWindowGlobal?.documentURI?.spec.startsWith(
          "about:certerror"
        ),
      "An untrusted certificate in WebKit shows Gecko's certificate error page"
    );
    Assert.equal(state.geckoPage, "certerror", "The tab shows the Gecko error page");
    await TestUtils.waitForCondition(
      () => gURLBar.value.includes(`127.0.0.1:${tls.port}`),
      "The address bar shows the failing site"
    );

    // Accepting the risk adds Gecko's exception; the page then loads in
    // WebKit, which trusts the certificate Gecko has an exception for.
    overrides.rememberValidityOverride("127.0.0.1", tls.port, {}, tls.cert, false);
    browser.reload();
    await TestUtils.waitForCondition(
      () => !state.geckoPage && tab.label == "Secure Page" && !tab.hasAttribute("busy"),
      "With Gecko's exception the site loads in WebKit"
    );
    Assert.ok(WhimsyWebKit.isWebKitTab(tab), "The tab is still a WebKit tab");
    Assert.equal(WhimsyWebKit.currentURIOf(tab)?.spec, tls.url, "WebKit shows the site");
    Assert.equal(
      await WhimsyWebKit.evaluateInTab(tab, "document.getElementById('heading').textContent"),
      "Secure",
      "The WebKit page runs"
    );
  } finally {
    overrides.clearValidityOverride("127.0.0.1", tls.port, {});
    tls.close();
  }
});

add_webkit_task(async function test_w32_epoch_guard_drops_stale_scripts() {
  if (!requireWebKit()) {
    return;
  }
  const tab = await openWebKitTab();
  await TestUtils.waitForCondition(() => WhimsyWebKit.currentEpochOf(tab), "The page has an epoch");
  const first = WhimsyWebKit.currentEpochOf(tab);
  Assert.equal(
    await WhimsyWebKit.evaluateGuardedInTab(tab, "return document.title;", first),
    "WebKit Test Page One",
    "A guarded script runs on the document it was made for"
  );
  Assert.equal(
    await WhimsyWebKit.evaluateInTab(tab, "typeof window.__whimsyEpoch"),
    "undefined",
    "The page's own scripts can't see the epoch"
  );

  await WhimsyWebKit.loadURLInTab(tab, gServer.url("/page2"));
  await TestUtils.waitForCondition(
    () => tab.label == "WebKit Test Page Two" && WhimsyWebKit.currentEpochOf(tab) != first,
    "The next page has its own epoch"
  );
  await Assert.rejects(
    WhimsyWebKit.evaluateGuardedInTab(tab, "return document.title;", first),
    e => e?.name == "AbortError",
    "A script made for the previous page is dropped with an AbortError"
  );
  Assert.equal(
    await WhimsyWebKit.evaluateGuardedInTab(tab, "return document.title;"),
    "WebKit Test Page Two",
    "An unpinned guarded script runs on the current page"
  );
});
