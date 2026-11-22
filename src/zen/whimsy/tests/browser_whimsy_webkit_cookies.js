/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30: WebKit cookie copy. A real WKWebView can't run headless, so the
// native cookie store and the native tab service are stood in for here; the
// selection, mapping, jar isolation, and the copy-before-load ordering are
// the real code.

const { WhimsyWebKit } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyWebKit.sys.mjs"
);
const { WhimsyWebKitCookies } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyWebKitCookies.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

const HOUR = 60 * 60 * 1000;

function addGeckoCookie(host, name, opts = {}) {
  const {
    path = "/",
    value = "v-" + name,
    secure = true,
    httpOnly = false,
    session = false,
    expiry = Date.now() + HOUR,
    oa = {},
    sameSite = Ci.nsICookie.SAMESITE_NONE,
    partitioned = false,
  } = opts;
  const validation = Services.cookies.add(
    host,
    path,
    name,
    value,
    secure,
    httpOnly,
    session,
    expiry,
    oa,
    sameSite,
    Ci.nsICookie.SCHEME_HTTPS,
    partitioned
  );
  if (validation && validation.result != Ci.nsICookieValidation.eOK) {
    throw new Error(`test cookie ${name} rejected: ${validation.errorString}`);
  }
}

function geckoCookie(host, name, oa = {}) {
  const base = Services.eTLD.getBaseDomainFromHost(host.replace(/^\./, ""));
  return Services.cookies
    .getCookiesFromHost(base, oa)
    .find(c => c.host == host && c.name == name);
}

// An in-memory stand-in for the per-data-store WKHTTPCookieStore, speaking
// the same JSON as nsIWhimsyWebKit.getCookies/setCookies.
function makeStore() {
  const jars = new Map();
  const store = {
    jars,
    calls: [],
    gate: null,
    jar(id) {
      if (!jars.has(id)) {
        jars.set(id, []);
      }
      return jars.get(id);
    },
    async getCookies(id, site) {
      store.calls.push({ op: "get", id, site });
      return JSON.stringify(
        store.jar(id).filter(c => WhimsyWebKitCookies.cookieInSite(c.domain, site))
      );
    },
    async setCookies(id, site, json) {
      store.calls.push({ op: "set:start", id, site });
      if (store.gate) {
        await store.gate;
      }
      const list = JSON.parse(json);
      const jar = store.jar(id);
      for (const c of list) {
        const i = jar.findIndex(
          o => o.name == c.name && o.domain == c.domain && o.path == c.path
        );
        if (i >= 0) {
          jar.splice(i, 1);
        }
        jar.push(c);
      }
      store.calls.push({ op: "set:done", id, site, count: list.length });
      return list.length;
    },
  };
  return store;
}

function cleanupCookies() {
  Services.cookies.removeAll();
}

add_setup(async function () {
  cleanupCookies();
  registerCleanupFunction(() => {
    WhimsyWebKitCookies._store = null;
    cleanupCookies();
    Services.prefs.clearUserPref("whimsy.webkit.datastores");
    Services.prefs.clearUserPref("whimsy.webkit.sites");
  });
});

add_task(async function test_site_selection_is_pure() {
  const C = WhimsyWebKitCookies;
  const uri = s => Services.io.newURI(s);
  is(C.siteOf(uri("https://a.b.example.co.uk/x")), "example.co.uk", "eTLD+1");
  is(C.siteOf(uri("http://127.0.0.1:8080/")), "127.0.0.1", "an IP is its own site");
  is(C.siteOf(uri("http://localhost/")), "localhost", "a single label is its own site");
  is(C.siteOf(uri("about:blank")), "", "not a web page");

  ok(C.cookieInSite("example.com", "example.com"), "host-only on the site");
  ok(C.cookieInSite(".example.com", "example.com"), "domain cookie on the site");
  ok(C.cookieInSite("accounts.example.com", "example.com"), "subdomain");
  ok(C.cookieInSite(".Deep.Sub.Example.com", "example.com"), "case and depth");
  ok(!C.cookieInSite("notexample.com", "example.com"), "a lookalike suffix");
  ok(!C.cookieInSite("example.com.evil.net", "example.com"), "a lookalike prefix");
  ok(!C.cookieInSite("example.org", "example.com"), "a third party");
  ok(!C.cookieInSite("", "example.com"), "no domain");

  const now = 1_000_000;
  const base = { value: "x", path: "/", secure: true, httpOnly: false, sameSite: "" };
  const picked = C.selectSiteCookies(
    [
      { ...base, name: "host", domain: "example.com", expires: 0 },
      { ...base, name: "dom", domain: ".example.com", expires: now + 1 },
      { ...base, name: "sub", domain: "www.example.com", expires: 0 },
      { ...base, name: "tracker", domain: ".tracker.example", expires: 0 },
      { ...base, name: "lookalike", domain: "badexample.com", expires: 0 },
      { ...base, name: "chips", domain: "example.com", expires: 0, partitioned: true },
      { ...base, name: "stale", domain: "example.com", expires: now - 1 },
      { ...base, name: "", domain: "example.com", expires: 0 },
      null,
    ],
    "example.com",
    now
  ).map(c => c.name);
  Assert.deepEqual(
    picked,
    ["host", "dom", "sub"],
    "only the site's own, unpartitioned, live cookies"
  );
});

add_task(async function test_attributes_survive_both_ways() {
  cleanupCookies();
  const expiry = Date.now() + 5 * HOUR;
  addGeckoCookie("example.com", "hostonly", {
    path: "/app",
    httpOnly: true,
    expiry,
    sameSite: Ci.nsICookie.SAMESITE_STRICT,
  });
  addGeckoCookie(".example.com", "domainwide", {
    session: true,
    secure: false,
    sameSite: Ci.nsICookie.SAMESITE_LAX,
  });
  addGeckoCookie(".example.com", "nonesecure", {
    sameSite: Ci.nsICookie.SAMESITE_NONE,
  });

  const portable = Services.cookies
    .getCookiesFromHost("example.com", {})
    .map(c => WhimsyWebKitCookies.fromGecko(c));
  const by = name => portable.find(c => c.name == name);

  const h = by("hostonly");
  is(h.domain, "example.com", "host-only stays host-only");
  is(h.path, "/app", "path");
  is(h.value, "v-hostonly", "value");
  ok(h.httpOnly && h.secure, "httpOnly and secure");
  is(h.sameSite, "strict", "strict");
  ok(Math.abs(h.expires - expiry) < 2000, "persistent expiry in ms");

  const d = by("domainwide");
  is(d.domain, ".example.com", "domain cookie keeps its dot");
  is(d.expires, 0, "session stays session");
  ok(!d.secure && !d.httpOnly, "not secure, not httpOnly");
  is(d.sameSite, "lax", "lax");

  is(by("nonesecure").sameSite, "", "None travels as no attribute");

  // Back into Gecko (into a different jar, so we read what the copy wrote).
  const oa = { userContextId: 77 };
  for (const c of portable) {
    Services.cookies.add(...WhimsyWebKitCookies.toGeckoArgs(c, oa, "https"));
  }
  const h2 = geckoCookie("example.com", "hostonly", oa);
  ok(h2 && !h2.isDomain, "host-only written as host-only");
  is(h2.path, "/app", "path written");
  ok(h2.isHttpOnly && h2.isSecure, "flags written");
  is(h2.sameSite, Ci.nsICookie.SAMESITE_STRICT, "strict written");
  ok(!h2.isSession && Math.abs(h2.expiry - expiry) < 2000, "expiry written");
  const d2 = geckoCookie(".example.com", "domainwide", oa);
  ok(d2 && d2.isDomain, "domain cookie written as domain cookie");
  ok(d2.isSession, "session written as session");
  is(d2.sameSite, Ci.nsICookie.SAMESITE_LAX, "lax written");
  ok(geckoCookie(".example.com", "nonesecure", oa), "SameSite=None, Secure written");
  cleanupCookies();
});

add_task(async function test_copy_to_webkit_takes_only_the_site() {
  cleanupCookies();
  const store = makeStore();
  WhimsyWebKitCookies._store = store;

  addGeckoCookie("example.com", "session_id");
  addGeckoCookie(".example.com", "wide");
  addGeckoCookie("accounts.example.com", "sub");
  addGeckoCookie(".example.org", "thirdparty");
  addGeckoCookie("example.com", "chips", {
    oa: { partitionKey: "(https,example.org)" },
    partitioned: true,
  });
  addGeckoCookie("example.com", "work_only", { oa: { userContextId: 77 } });

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const copied = await WhimsyWebKitCookies.copyToWebKit(
    tab,
    Services.io.newURI("https://www.example.com/page")
  );
  is(copied, 3, "three cookies copied");
  const id = WhimsyWebKit.dataStoreIdForProfile(0);
  const names = store.jar(id).map(c => c.name).sort();
  Assert.deepEqual(names, ["session_id", "sub", "wide"], "site and subdomains only");
  is(store.jars.size, 1, "only the default profile's store was written");
  ok(
    store.calls.every(c => c.site == "example.com"),
    "the native side is told the site too"
  );
  BrowserTestUtils.removeTab(tab);
  WhimsyWebKitCookies._store = null;
  cleanupCookies();
});

add_task(async function test_containers_stay_apart() {
  cleanupCookies();
  const store = makeStore();
  WhimsyWebKitCookies._store = store;
  const workId = ContextualIdentityService.create(
    "Whimsy cookie copy",
    "briefcase",
    "blue"
  ).userContextId;
  try {
    addGeckoCookie("example.com", "default_session");
    addGeckoCookie("example.com", "work_session", { oa: { userContextId: workId } });

    const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/", {
      userContextId: workId,
    });
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    const jar = WhimsyWebKitCookies.jarFor(tab);
    ok(jar, "a real container has its own jar");
    is(jar.originAttributes.userContextId, workId, "the container's jar");
    isnot(
      jar.dataStoreId,
      WhimsyWebKit.dataStoreIdForProfile(0),
      "and its own WebKit store"
    );

    const uri = Services.io.newURI("https://example.com/");
    await WhimsyWebKitCookies.copyToWebKit(tab, uri);
    Assert.deepEqual(
      store.jar(jar.dataStoreId).map(c => c.name),
      ["work_session"],
      "Firefox to WebKit takes only the container's cookies"
    );
    ok(
      !store.jars.has(WhimsyWebKit.dataStoreIdForProfile(0)) ||
        !store.jar(WhimsyWebKit.dataStoreIdForProfile(0)).length,
      "nothing lands in the default store"
    );

    // WebKit to Firefox: a cookie WebKit set comes back into the container
    // only.
    store.jar(jar.dataStoreId).push({
      name: "wk_login",
      value: "secret",
      domain: "example.com",
      path: "/",
      expires: Date.now() + HOUR,
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });
    store.jar(WhimsyWebKit.dataStoreIdForProfile(0)).push({
      name: "default_wk",
      value: "x",
      domain: "example.com",
      path: "/",
      expires: 0,
      secure: true,
      httpOnly: false,
      sameSite: "",
    });
    await WhimsyWebKitCookies.copyToFirefox(tab, uri);
    ok(geckoCookie("example.com", "wk_login", { userContextId: workId }), "into the container");
    ok(!geckoCookie("example.com", "wk_login", {}), "not into the default jar");
    ok(
      !geckoCookie("example.com", "default_wk", { userContextId: workId }),
      "the default store's cookies don't cross into the container"
    );
    BrowserTestUtils.removeTab(tab);
  } finally {
    ContextualIdentityService.remove(workId);
    WhimsyWebKitCookies._store = null;
    cleanupCookies();
  }
});

add_task(async function test_private_tabs_never_copy() {
  cleanupCookies();
  const store = makeStore();
  WhimsyWebKitCookies._store = store;
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(
      win.gBrowser,
      "https://example.com/"
    );
    addGeckoCookie("example.com", "private_session", { oa: { privateBrowsingId: 1 } });
    store.jar(WhimsyWebKit.dataStoreIdForProfile(0)).push({
      name: "wk_cookie",
      value: "x",
      domain: "example.com",
      path: "/",
      expires: 0,
      secure: true,
      httpOnly: false,
      sameSite: "",
    });
    is(WhimsyWebKitCookies.jarFor(tab), null, "a private tab has no jar to copy");
    const uri = Services.io.newURI("https://example.com/");
    is(await WhimsyWebKitCookies.copyToWebKit(tab, uri), 0, "nothing to WebKit");
    is(await WhimsyWebKitCookies.copyToFirefox(tab, uri), 0, "nothing from WebKit");
    is(store.calls.length, 0, "the native store was never asked");
    ok(
      !geckoCookie("example.com", "wk_cookie", { privateBrowsingId: 1 }),
      "nothing written into the private jar"
    );
    ok(!geckoCookie("example.com", "wk_cookie", {}), "or the normal one");
  } finally {
    await BrowserTestUtils.closeWindow(win);
    WhimsyWebKitCookies._store = null;
    cleanupCookies();
  }
});

// A stand-in for nsIWhimsyWebKit so the real switch code runs headless. It
// records the order of native calls, including the cookie store's.
function installFakeService(store) {
  const events = [];
  let nextId = 1;
  const impl = {
    available: () => true,
    createTab: () => {
      events.push("createTab");
      return nextId++;
    },
    loadURL: (id, url) => {
      events.push("loadURL");
      fake.loaded.push(url);
      fake.onLoad?.(url);
    },
    getCookies: async (...args) => {
      events.push("getCookies");
      return store.getCookies(...args);
    },
    setCookies: async (...args) => {
      events.push("setCookies:start");
      const n = await store.setCookies(...args);
      events.push("setCookies:done");
      return n;
    },
    canGoBack: () => false,
    canGoForward: () => false,
    isLoading: () => false,
    isFocused: () => false,
  };
  const fake = {
    events,
    loaded: [],
    onLoad: null,
    service: new Proxy(impl, {
      get: (target, key) => (key in target ? target[key] : () => {}),
    }),
  };
  WhimsyWebKit._service = fake.service;
  return fake;
}

function uninstallFakeService() {
  WhimsyWebKit._service = undefined;
}

add_task(async function test_switch_copies_before_each_engine_loads() {
  cleanupCookies();
  const store = makeStore();
  const fake = installFakeService(store);
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
    addGeckoCookie("example.com", "ff_login");

    // Firefox to WebKit: hold the cookie store so the load would overtake
    // it if the switch didn't wait.
    let release;
    store.gate = new Promise(r => (release = r));
    const switched = WhimsyWebKit.setTabEngine(tab, "webkit");
    await TestUtils.waitForCondition(
      () => fake.events.includes("setCookies:start"),
      "the copy started"
    );
    ok(!fake.events.includes("loadURL"), "WebKit hasn't loaded while the copy runs");
    release();
    store.gate = null;
    await TestUtils.waitForCondition(() => fake.events.includes("loadURL"), "WebKit loads");
    ok(
      fake.events.indexOf("setCookies:done") < fake.events.indexOf("loadURL"),
      "cookies landed before WebKit loaded the page"
    );
    ok(
      store.jar(WhimsyWebKit.dataStoreIdForProfile(0)).some(c => c.name == "ff_login"),
      "the Firefox login reached WebKit"
    );
    // Release the load waiter the fake never fires.
    for (const done of [...(WhimsyWebKit.stateOf(tab)?.loadWaiters ?? [])]) {
      done();
    }
    await switched;
    ok(WhimsyWebKit.isWebKitTab(tab), "the tab is a WebKit tab");

    // WebKit to Firefox: the WebKit-side cookie must be in Gecko when Gecko
    // starts loading.
    store.jar(WhimsyWebKit.dataStoreIdForProfile(0)).push({
      name: "wk_login",
      value: "x",
      domain: ".example.com",
      path: "/",
      expires: Date.now() + HOUR,
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });
    const browser = tab.linkedBrowser;
    let cookieAtLoad = null;
    const origLoad = browser.fixupAndLoadURIString;
    browser.fixupAndLoadURIString = function (spec, params) {
      if (spec != "about:blank" && cookieAtLoad === null) {
        cookieAtLoad = !!geckoCookie(".example.com", "wk_login", {});
      }
      return origLoad.call(this, spec, params);
    };
    try {
      await WhimsyWebKit.setTabEngine(tab, "firefox");
    } finally {
      delete browser.fixupAndLoadURIString;
    }
    ok(fake.events.includes("getCookies"), "WebKit's cookies were read");
    is(cookieAtLoad, true, "the WebKit login was in Firefox before Gecko loaded");
    ok(!WhimsyWebKit.isWebKitTab(tab), "back in Firefox");
    BrowserTestUtils.removeTab(tab);
  } finally {
    uninstallFakeService();
    cleanupCookies();
  }
});

add_task(async function test_always_webkit_site_copies_on_open() {
  cleanupCookies();
  const store = makeStore();
  const fake = installFakeService(store);
  WhimsyWebKit.addSite("example.com", 0);
  try {
    addGeckoCookie("example.com", "always_login");
    const loaded = new Promise(resolve => (fake.onLoad = resolve));
    const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/");
    await loaded;
    ok(
      fake.events.indexOf("setCookies:done") >= 0 &&
        fake.events.indexOf("setCookies:done") < fake.events.indexOf("loadURL"),
      "an always-WebKit site gets its cookies before WebKit loads it"
    );
    ok(
      store.jar(WhimsyWebKit.dataStoreIdForProfile(0)).some(c => c.name == "always_login"),
      "the login came along"
    );
    for (const done of [...(WhimsyWebKit.stateOf(tab)?.loadWaiters ?? [])]) {
      done();
    }
    // Through setTabEngine, so the tab stays in Firefox for this site.
    await WhimsyWebKit.setTabEngine(tab, "firefox");
    ok(!WhimsyWebKit.isWebKitTab(tab), "back in Firefox");
    BrowserTestUtils.removeTab(tab);
  } finally {
    WhimsyWebKit.removeSite("example.com", 0);
    uninstallFakeService();
    cleanupCookies();
  }
});
