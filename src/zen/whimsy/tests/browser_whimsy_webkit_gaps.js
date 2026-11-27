/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W32 webkit-gaps: what a WebKit tab shares with Firefox tabs. SessionStore
// and the Archive keep its page and engine, the tab unloader sees its sound,
// capture, and process, failed loads show Gecko's error page, downloads ask
// where to save when Firefox would, and Firefox's saved logins fill it
// (only on the page's own origin, only after the user picks one) and offer
// to save through the usual doorhanger.

const { WhimsyWebKit } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyWebKit.sys.mjs"
);
const { WhimsyEngineTabs } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyEngineTabs.sys.mjs"
);
const { WhimsyEngineLogins } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyEngineLogins.sys.mjs"
);
const { TabUnloader } = ChromeUtils.importESModule(
  "moz-src:///browser/components/tabbrowser/TabUnloader.sys.mjs"
);
const { SessionStore } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/SessionStore.sys.mjs"
);

// A loopback HTTP server. 127.0.0.1 and localhost are two origins on the
// same port, for the cross-origin frame.
function startServer() {
  const srv = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket
  );
  srv.init(-1, true, -1);
  const port = srv.port;
  const page = (title, body) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const routes = {
    "/page1": () => page("Gaps Page One", "<h1>One</h1>"),
    "/page2": () => page("Gaps Page Two", "<h1>Two</h1>"),
    "/login": () =>
      page(
        "Login Page",
        `<form id="form" action="/page2" onsubmit="window.__submitted = true; return false;">
           <input type="text" id="u" name="user">
           <input type="password" id="p" name="pass">
           <button id="go">Sign in</button>
         </form>
         <iframe id="frame" src="http://localhost:${port}/login-frame" style="width:400px;height:200px"></iframe>
         <script>
           addEventListener("message", e => {
             if (e.data == "frame-focused") { window.__frameFocused = true; }
           });
         </script>`
      ),
    "/login-frame": () =>
      page(
        "Login Frame",
        `<form><input type="text" id="fu" name="user"><input type="password" id="fp" name="pass"></form>
         <script>
           addEventListener("message", e => {
             if (e.data == "focus") {
               document.getElementById("fu").focus();
               parent.postMessage("frame-focused", "*");
             }
           });
         </script>`
      ),
  };
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
      let request = "";
      const waitRead = () => {
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
                waitRead();
                return;
              }
              const path = (/^[A-Z]+\s+([^\s?]+)/.exec(request) || [])[1] || "/";
              let type = "text/html; charset=utf-8";
              let extra = "";
              let body;
              if (path == "/download") {
                type = "application/octet-stream";
                extra =
                  'Content-Disposition: attachment; filename="whimsy-gaps.bin"\r\n';
                body = "whimsy gaps download\n";
              } else {
                body = (routes[path] || routes["/page1"])();
              }
              const response =
                "HTTP/1.1 200 OK\r\n" +
                extra +
                `Content-Type: ${type}\r\n` +
                `Content-Length: ${body.length}\r\n` +
                "Cache-Control: no-store\r\nConnection: close\r\n\r\n" +
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
    origin: `http://127.0.0.1:${port}`,
    otherOrigin: `http://localhost:${port}`,
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

let gServer = null;

add_setup(async function setup() {
  gServer = startServer();
  Services.prefs.setStringPref("whimsy.webkit.sites", "[]");
  registerCleanupFunction(() => {
    Services.prefs.setStringPref("whimsy.webkit.sites", "[]");
    Services.logins.removeAllUserFacingLogins();
    gServer?.close();
  });
});

// Needs a real WKWebView (browser.toml tags this file whimsy-headed). A quiet
// return would pass while testing nothing, so an unavailable engine fails.
function requireWebKit() {
  if (WhimsyWebKit.available(window)) {
    return true;
  }
  Assert.ok(false, "WebKit tabs are unavailable, so these tests can't run");
  return false;
}

// Closes whatever a task opened, even when an assertion throws.
function add_webkit_task(fn) {
  const wrapped = async () => {
    const before = new Set(gBrowser.tabs);
    const selected = gBrowser.selectedTab;
    try {
      await fn();
    } finally {
      if (selected.isConnected) {
        gBrowser.selectedTab = selected;
      }
      for (const tab of [...gBrowser.tabs]) {
        if (!before.has(tab)) {
          BrowserTestUtils.removeTab(tab);
        }
      }
    }
  };
  Object.defineProperty(wrapped, "name", { value: fn.name });
  add_task(wrapped);
}

async function openWebKitTab(path, title) {
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

const evaluate = (tab, script) => WhimsyWebKit.evaluateInTab(tab, script);

// Stands in for one method of the real WebKit service while fn runs.
async function withServiceMethod(name, impl, fn) {
  const real = WhimsyWebKit.service;
  WhimsyWebKit._service = new Proxy(real, {
    get(target, key) {
      if (key == name) {
        return impl;
      }
      const value = target[key];
      return typeof value == "function" ? value.bind(target) : value;
    },
  });
  try {
    return await fn();
  } finally {
    WhimsyWebKit._service = real;
  }
}

// ---------------------------------------------------------------------------
// 1. SessionStore and the Archive

add_webkit_task(async function test_session_keeps_webkit_page_and_engine() {
  if (!requireWebKit()) {
    return;
  }
  const tab = await openWebKitTab("/page1", "Gaps Page One");
  await WhimsyWebKit.loadURLInTab(tab, gServer.url("/page2"));
  await TestUtils.waitForCondition(
    () => tab.label == "Gaps Page Two" && !tab.hasAttribute("busy"),
    "WebKit went to page two"
  );
  Assert.equal(
    tab.linkedBrowser.currentURI.spec,
    "about:blank",
    "The tab's Gecko browser is parked on about:blank"
  );
  await TestUtils.waitForCondition(() => {
    const saved = JSON.parse(SessionStore.getTabState(tab));
    const entry = saved.entries?.[saved.index - 1];
    return entry?.url == gServer.url("/page2");
  }, "SessionStore saves the WebKit page, not the parked about:blank");
  const saved = JSON.parse(SessionStore.getTabState(tab));
  const entry = saved.entries[saved.index - 1];
  Assert.equal(entry.title, "Gaps Page Two", "It saves the WebKit page's title");
  const choice = JSON.parse(saved.extData?.[WhimsyEngineTabs.SESSION_KEY] || "{}");
  Assert.equal(choice.engine, "webkit", "It saves the tab's engine");

  // Closing and restoring the tab (what Undo Close Tab and the Archive do)
  // opens the page in WebKit again.
  const closedCount = SessionStore.getClosedTabCountForWindow(window);
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedTabCountForWindow(window) > closedCount,
    "The tab is in the closed tabs"
  );
  const closed = SessionStore.getClosedTabDataForWindow(window)[0];
  Assert.equal(
    closed.state.entries[closed.state.index - 1].url,
    gServer.url("/page2"),
    "The closed tab keeps the WebKit page"
  );
  const restored = SessionStore.undoCloseTab(window, 0);
  await TestUtils.waitForCondition(
    () =>
      WhimsyWebKit.isWebKitTab(restored) &&
      WhimsyWebKit.currentURIOf(restored)?.spec == gServer.url("/page2"),
    "The restored tab opens its page in WebKit"
  );
  gBrowser.selectedTab = restored;
  await TestUtils.waitForCondition(
    () => restored.label == "Gaps Page Two" && !restored.hasAttribute("busy"),
    "The restored WebKit page loads"
  );

  // Moving the tab back to Firefox saves Firefox as its engine.
  await WhimsyWebKit.setTabEngine(restored, "gecko");
  await TestUtils.waitForCondition(() => {
    const value = SessionStore.getCustomTabValue(
      restored,
      WhimsyEngineTabs.SESSION_KEY
    );
    return !value || !JSON.parse(value).engine;
  }, "A tab put back in Firefox no longer saves WebKit as its engine");
});

// ---------------------------------------------------------------------------
// 2. The tab unloader

add_webkit_task(async function test_unloader_sees_webkit_activity() {
  if (!requireWebKit()) {
    return;
  }
  const plain = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    gServer.url("/page1")
  );
  const tab = await openWebKitTab("/page2", "Gaps Page Two");
  Assert.equal(
    WhimsyEngineTabs.unloaderActivity(plain),
    null,
    "A Firefox tab has no engine activity"
  );
  const real = WhimsyEngineTabs.unloaderActivity(tab);
  Assert.greater(real.pid, 0, "The WebKit tab reports its web content process");
  Assert.ok(!real.audio && !real.capture, "A quiet page plays nothing and captures nothing");

  // A background tab of each kind, with another tab selected.
  const front = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    gServer.url("/page1")
  );
  const discardable = async which => {
    const sorted = await TabUnloader.getSortedTabs(null);
    const entry = sorted.find(t => t.tab == which);
    return !!entry && TabUnloader.isDiscardable(entry);
  };
  Assert.ok(await discardable(plain), "A background Firefox tab can be unloaded");
  Assert.ok(await discardable(tab), "A quiet background WebKit tab can be unloaded");

  for (const [what, activity] of [
    ["playing sound", { audio: true }],
    ["using the camera or microphone", { capture: true }],
  ]) {
    await withServiceMethod(
      "tabActivity",
      () => JSON.stringify({ pid: real.pid, footprint: 1, ...activity }),
      async () => {
        Assert.ok(
          !(await discardable(tab)),
          `A WebKit tab ${what} is never unloaded, as a Firefox tab wouldn't be`
        );
      }
    );
  }

  // Memory: the unloader's process map gets WebKit's footprint.
  await withServiceMethod(
    "tabActivity",
    () => JSON.stringify({ pid: real.pid, footprint: 123456789 }),
    async () => {
      WhimsyEngineTabs.unloaderActivity(tab);
      const map = new Map([[real.pid, { count: 1, topCount: 1, tabSet: new Set() }]]);
      WhimsyEngineTabs.addUnloaderMemory(map);
      Assert.equal(map.get(real.pid).memory, 123456789, "WebKit's memory counts for its tab");
    }
  );
  BrowserTestUtils.removeTab(front);
});

// ---------------------------------------------------------------------------
// 3. Network errors

add_webkit_task(async function test_network_error_shows_gecko_neterror() {
  if (!requireWebKit()) {
    return;
  }
  // A port nothing listens on.
  const probe = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket
  );
  probe.init(-1, true, -1);
  const deadPort = probe.port;
  probe.close();
  const deadURL = `http://127.0.0.1:${deadPort}/`;

  const tab = await openWebKitTab("/page1", "Gaps Page One");
  const state = WhimsyWebKit.stateOf(tab);
  const browser = tab.linkedBrowser;
  WhimsyWebKit.loadURLInTab(tab, deadURL, { waitForLoad: false });
  await TestUtils.waitForCondition(
    () =>
      browser.browsingContext?.currentWindowGlobal?.documentURI?.spec.startsWith(
        "about:neterror"
      ),
    "A refused connection in WebKit shows Gecko's network error page"
  );
  Assert.equal(state.geckoPage, "neterror", "The tab shows the Gecko error page");
  Assert.ok(WhimsyWebKit.isWebKitTab(tab), "The tab stays a WebKit tab");
  await TestUtils.waitForCondition(
    () => gURLBar.value.includes(`127.0.0.1:${deadPort}`),
    "The address bar shows the failing address"
  );

  // Going to a working page leaves the error page for WebKit again.
  WhimsyWebKit.loadURLInTab(tab, gServer.url("/page2"), { waitForLoad: false });
  await TestUtils.waitForCondition(
    () => !state.geckoPage && tab.label == "Gaps Page Two" && !tab.hasAttribute("busy"),
    "A working page loads in WebKit after the error"
  );
});

// ---------------------------------------------------------------------------
// 4. Downloads ask where to save when Firefox would

add_webkit_task(async function test_download_asks_where_to_save() {
  if (!requireWebKit()) {
    return;
  }
  const dir = PathUtils.join(PathUtils.tempDir, `whimsy-gaps-${Date.now()}`);
  await IOUtils.makeDirectory(dir);
  const chosen = PathUtils.join(dir, "chosen-name.bin");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.useDownloadDir", false],
      ["browser.download.folderList", 2],
      ["browser.download.dir", dir],
      ["browser.download.alwaysOpenPanel", false],
    ],
  });
  const list = await Downloads.getList(Downloads.ALL);
  const added = [];
  const view = { onDownloadAdded: d => added.push(d) };
  await list.addView(view);
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  try {
    const tab = await openWebKitTab("/page1", "Gaps Page One");
    let shown = 0;
    let shownName = "";
    MockFilePicker.showCallback = fp => {
      shown++;
      shownName = fp.defaultString;
    };

    // Cancel: nothing is saved.
    MockFilePicker.returnValue = MockFilePicker.returnCancel;
    WhimsyWebKit.loadURLInTab(tab, gServer.url("/download"), { waitForLoad: false });
    await TestUtils.waitForCondition(() => shown == 1, "Firefox's Save dialog opens");
    Assert.equal(shownName, "whimsy-gaps.bin", "It suggests the site's file name");
    await new Promise(r => setTimeout(r, 500));
    Assert.ok(
      !added.some(d => d.source.url == gServer.url("/download")),
      "A cancelled Save dialog saves nothing"
    );

    // Choose a file: the download goes there.
    MockFilePicker.returnValue = MockFilePicker.returnOK;
    MockFilePicker.setFiles([new FileUtils.File(chosen)]);
    WhimsyWebKit.loadURLInTab(tab, gServer.url("/download"), { waitForLoad: false });
    await TestUtils.waitForCondition(
      () => added.some(d => d.source.url == gServer.url("/download")),
      "The download joins Firefox's downloads list"
    );
    const download = added.find(d => d.source.url == gServer.url("/download"));
    await TestUtils.waitForCondition(() => download.stopped, "The download finished");
    Assert.equal(shown, 2, "The Save dialog opened for each download");
    Assert.ok(download.succeeded, "The download succeeded");
    Assert.equal(download.target.path, chosen, "It saved where the Save dialog said");
    Assert.equal(
      await IOUtils.readUTF8(chosen),
      "whimsy gaps download\n",
      "The file holds what the site sent"
    );
  } finally {
    MockFilePicker.cleanup();
    await list.removeView(view);
    for (const d of added) {
      await list.remove(d);
      await d.finalize(true).catch(() => {});
    }
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    await SpecialPowers.popPrefEnv();
  }
});

// ---------------------------------------------------------------------------
// 5. Logins

function addLogin(origin, username, password) {
  const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
    Ci.nsILoginInfo
  );
  info.init(origin, origin, null, username, password, "user", "pass");
  return Services.logins.addLoginAsync(info);
}

// Records the login events the page sends (after the native origin check).
function spyLoginEvents() {
  const events = [];
  const orig = WhimsyEngineLogins.onEvent;
  WhimsyEngineLogins.onEvent = function (engineTabs, tab, state, svc, data) {
    events.push(data);
    return orig.call(this, engineTabs, tab, state, svc, data);
  };
  events.restore = () => (WhimsyEngineLogins.onEvent = orig);
  return events;
}

const fieldValues = tab =>
  evaluate(
    tab,
    "JSON.stringify([document.getElementById('u').value, document.getElementById('p').value])"
  ).then(JSON.parse);

add_webkit_task(async function test_login_fill_uses_saved_logins_on_its_origin_only() {
  if (!requireWebKit()) {
    return;
  }
  Services.logins.removeAllUserFacingLogins();
  await addLogin(gServer.origin, "alice", "alice-secret");
  const other = await addLogin(gServer.otherOrigin, "mallory", "other-secret");
  const events = spyLoginEvents();
  try {
    const tab = await openWebKitTab("/login", "Login Page");
    const state = WhimsyWebKit.stateOf(tab);
    await TestUtils.waitForCondition(
      async () => (await evaluate(tab, "document.getElementById('frame').contentWindow != null")) === true,
      "The frame is there"
    );
    await new Promise(r => setTimeout(r, 300));
    Assert.deepEqual(
      await fieldValues(tab),
      ["", ""],
      "Nothing is filled on load: only a login the user picks"
    );
    Assert.equal(
      await evaluate(tab, "typeof globalThis.__whimsyLogin"),
      "undefined",
      "The page's scripts can't see the login bridge"
    );

    // A cross-origin frame's login field never reaches the browser.
    WhimsyWebKit.focusTab(tab);
    await evaluate(tab, "document.getElementById('frame').contentWindow.postMessage('focus', '*'), true");
    await TestUtils.waitForCondition(
      async () => (await evaluate(tab, "!!window.__frameFocused")) === true,
      "The frame's login field took focus"
    );
    await new Promise(r => setTimeout(r, 500));
    Assert.equal(events.length, 0, "A login field in a cross-origin frame sends nothing");

    // A focus event the page makes up is ignored.
    await evaluate(
      tab,
      "document.getElementById('u').dispatchEvent(new FocusEvent('focusin', { bubbles: true })), true"
    );
    await new Promise(r => setTimeout(r, 300));
    Assert.equal(events.length, 0, "A page-made focus event opens nothing");

    // Focusing the username field opens Firefox's login popup with the
    // page's own saved login only.
    WhimsyWebKit.focusTab(tab);
    await evaluate(tab, "document.getElementById('u').focus(), true");
    await TestUtils.waitForCondition(
      () => events.some(e => e.k == "show"),
      "Focusing the username field asks for the popup"
    );
    const show = events.find(e => e.k == "show");
    Assert.equal(show.origin, gServer.origin, "The origin was set natively from the page");
    Assert.equal(show.role, "username", "The field is the username field");
    const session = WhimsyEngineLogins._sessions.get(tab);
    Assert.ok(session, "The tab has a login session");
    await TestUtils.waitForCondition(
      () => session.popupActor.openedPopup?.state == "open",
      "Firefox's login popup opens"
    );
    Assert.deepEqual(
      session.results.filter(r => r.style == "loginWithOrigin" || r.style == "login").map(r => r.value),
      ["alice"],
      "The popup lists the page's own login, not another origin's"
    );
    Assert.ok(
      !session.results.some(r => JSON.stringify(r).includes("mallory")),
      "Another origin's login is never offered"
    );
    Assert.deepEqual(await fieldValues(tab), ["", ""], "Opening the popup fills nothing");

    // A login of another origin, asked for by guid, is refused.
    Assert.equal(await session.findLogin(other.guid), null, "Another origin's login is refused by guid");
    await session.fill(other.guid);
    await new Promise(r => setTimeout(r, 300));
    Assert.deepEqual(await fieldValues(tab), ["", ""], "Another origin's login is never filled");

    // The native bridge refuses a fill for a different origin or document.
    const svc = WhimsyWebKit.service;
    const fill = JSON.stringify({ k: "fill", username: "x", password: "y" });
    Assert.throws(
      () => svc.loginAction(state.id, session.epoch, gServer.otherOrigin, fill),
      /NS_ERROR_INVALID_ARG/,
      "A fill for another origin is refused natively"
    );
    Assert.throws(
      () => svc.loginAction(state.id, "not-the-epoch", gServer.origin, fill),
      /NS_ERROR_INVALID_ARG/,
      "A fill for another document is refused natively"
    );
    Assert.throws(
      () => svc.loginAction(state.id, session.epoch, gServer.origin, JSON.stringify({ k: "read" })),
      /NS_ERROR_INVALID_ARG/,
      "The bridge only fills and tracks the popup"
    );
    await new Promise(r => setTimeout(r, 300));
    Assert.deepEqual(await fieldValues(tab), ["", ""], "Refused fills change nothing");

    // Picking the login in the popup fills it.
    session.onKey("ArrowDown");
    Assert.equal(session.popupActor.openedPopup.selectedIndex, 0, "The arrow key selects the login");
    session.onKey("Enter");
    await TestUtils.waitForCondition(
      async () => (await fieldValues(tab))[1] == "alice-secret",
      "Choosing the login fills the page"
    );
    Assert.deepEqual(await fieldValues(tab), ["alice", "alice-secret"], "Both fields are filled");
    await TestUtils.waitForCondition(
      () => !session.popupActor.openedPopup,
      "The popup closes after a choice"
    );

    // A session from the previous page can't fill the next one.
    await WhimsyWebKit.loadURLInTab(tab, gServer.url("/login"));
    await TestUtils.waitForCondition(
      () => WhimsyWebKit.currentEpochOf(tab) && WhimsyWebKit.currentEpochOf(tab) != session.epoch,
      "The reloaded page has its own document"
    );
    Assert.ok(!session.isCurrent(), "The old session is stale");
    Assert.ok(!session.act({ k: "fill", username: "a", password: "b" }), "A stale session can't fill");
    Assert.ok(!WhimsyEngineLogins._sessions.has(tab), "Navigating ends the tab's login session");
  } finally {
    events.restore();
    Services.logins.removeAllUserFacingLogins();
  }
});

add_webkit_task(async function test_login_submit_offers_to_save() {
  if (!requireWebKit()) {
    return;
  }
  Services.logins.removeAllUserFacingLogins();
  const tab = await openWebKitTab("/login", "Login Page");
  await evaluate(
    tab,
    `document.getElementById('u').value = 'bob';
     document.getElementById('p').value = 'bob-secret';
     document.getElementById('form').requestSubmit(); true`
  );
  await TestUtils.waitForCondition(
    () => PopupNotifications.getNotification("password", tab.linkedBrowser),
    "Submitting a login offers to save it in Firefox's doorhanger"
  );
  const notification = PopupNotifications.getNotification("password", tab.linkedBrowser);
  Assert.equal(notification.options.passwordNotificationType, "password-save", "It is the save doorhanger");
  const shown = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popupshown");
  notification.reshow();
  await shown;
  Assert.equal(
    document.getElementById("password-notification-username").value,
    "bob",
    "The doorhanger shows the submitted username"
  );
  const hidden = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popuphidden");
  PopupNotifications.panel.querySelector("button.popup-notification-primary-button").click();
  await hidden;
  await TestUtils.waitForCondition(async () => {
    const logins = await Services.logins.searchLoginsAsync({ origin: gServer.origin });
    return logins.some(l => l.username == "bob" && l.password == "bob-secret");
  }, "Saving stores the login for the page's origin");
  Services.logins.removeAllUserFacingLogins();
});
