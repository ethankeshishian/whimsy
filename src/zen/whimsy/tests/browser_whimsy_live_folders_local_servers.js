/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Local servers live folder: dev servers running on localhost show up as
// tabs (title from the page, favicon inlined), and go away when the server
// stops. It probes only while the folder is visible (expanded, active
// space, window shown) and does no work at all otherwise.

const { HttpServer } = ChromeUtils.importESModule("resource://testing-common/httpd.sys.mjs");
const {
  WhimsyLocalServersLiveFolderProvider,
  PORTS_PREF,
  POLL_PREF,
  BONJOUR_PREF,
  BONJOUR_TYPES,
  BonjourTesting,
  LAN_ICON,
  bonjourItems,
  parsePorts,
  parseTitle,
  parseIconHref,
  DEFAULT_PORTS,
} = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLocalServersLiveFolder.sys.mjs");
const { WhimsyLiveFolders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLiveFolders.sys.mjs");

const FALLBACK_ICON = "chrome://browser/skin/zen-icons/selectable/code.svg";
// A 1x1 transparent PNG.
const PNG_BYTES = atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
);

function startServer({ html, contentType = "text/html; charset=utf-8", server: serverHeader, icon = false } = {}) {
  const server = new HttpServer();
  server.registerPathHandler("/", (request, response) => {
    const body = html ?? "plain text, no page";
    if (serverHeader) {
      // httpd.js always overwrites the Server header with its own, so a
      // different server (e.g. AirPlay's AirTunes) needs a raw response.
      response.seizePower();
      response.write(
        "HTTP/1.1 200 OK\r\n" +
          `Server: ${serverHeader}\r\n` +
          `Content-Type: ${contentType}\r\n` +
          `Content-Length: ${body.length}\r\n` +
          "Connection: close\r\n\r\n" +
          body
      );
      response.finish();
      return;
    }
    response.setHeader("Content-Type", contentType, false);
    response.write(body);
  });
  if (icon) {
    server.registerPathHandler("/icon.png", (request, response) => {
      response.setHeader("Content-Type", "image/png", false);
      response.bodyOutputStream.write(PNG_BYTES, PNG_BYTES.length);
    });
  }
  server.start(-1);
  return server;
}

const portOf = server => server.identity.primaryPort;
const stopServer = server => new Promise(resolve => server.stop(resolve));

async function closedPort() {
  const server = startServer();
  const port = portOf(server);
  await stopServer(server);
  return port;
}

async function usePorts(ports) {
  await SpecialPowers.pushPrefEnv({
    set: [
      [PORTS_PREF, ports.join(",")],
      [POLL_PREF, 1000],
    ],
  });
}

// A stand-in manager and folder: no real tab-group, so the visibility rules
// and the fetch/apply loop can be driven directly.
function makeProvider({ collapsed = false } = {}) {
  const folder = { collapsed, parentElement: null, getAttribute: () => null };
  const fetches = [];
  const manager = {
    window,
    dismissedItems: new Set(),
    getFolderForLiveFolder: () => folder,
    onLiveFolderFetch: (_liveFolder, items) => fetches.push(items),
    saveState: () => {},
  };
  const provider = new WhimsyLocalServersLiveFolderProvider({
    id: "test-local",
    manager,
    state: { type: WhimsyLocalServersLiveFolderProvider.type },
  });
  return { provider, folder, fetches, manager };
}

// The real Bonjour browse would ask macOS for Local Network access, so it
// stays off except where a stand-in replaces it.
add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [[BONJOUR_PREF, false]] });
});

add_task(async function test_parsers() {
  is(parseTitle("<html><head><title> My  App &amp; Co </title>"), "My App & Co", "Titles are trimmed and decoded");
  is(parseTitle("<p>no title</p>"), "", "No <title>, no title");
  is(
    parseIconHref('<link rel="shortcut icon" href="/static/fav.svg">', "http://localhost:3000/app/"),
    "http://localhost:3000/static/fav.svg",
    "The page's declared icon is resolved against it"
  );
  is(parseIconHref("", "http://localhost:3000/"), "http://localhost:3000/favicon.ico", "Falls back to /favicon.ico");
  Assert.deepEqual(parsePorts("3000, 5173 3000 nope 70000"), [3000, 5173], "Ports parse, dedupe and drop junk");
  is(parsePorts(""), DEFAULT_PORTS, "An empty pref means the common dev ports");
});

add_task(async function test_lists_running_servers() {
  const app = startServer({
    html: '<html><head><title>My App &amp; Co</title><link rel="icon" href="/icon.png"></head></html>',
    icon: true,
  });
  const api = startServer({ contentType: "application/json", html: "{}" });
  const airplay = startServer({ html: "<title>AirPlay</title>", server: "AirTunes/860.7.1" });
  const closed = await closedPort();
  await usePorts([portOf(api), closed, portOf(app), portOf(airplay)]);

  const { provider } = makeProvider();
  const items = await provider.fetchItems();
  const ports = [portOf(app), portOf(api)].sort((a, b) => a - b);
  Assert.deepEqual(
    items.map(i => i.port),
    ports,
    "Both running servers are listed, sorted by port; the closed port and AirPlay are not"
  );
  const appItem = items.find(i => i.port === portOf(app));
  is(appItem.title, "My App & Co", "The title comes from the page");
  is(appItem.subtitle, `localhost:${portOf(app)}`, "The subtitle is host:port");
  is(appItem.url, `http://localhost:${portOf(app)}/`, "The tab opens the server");
  ok(appItem.icon.startsWith("data:image/png;base64,"), "The favicon is inlined as a data: URI");
  const apiItem = items.find(i => i.port === portOf(api));
  is(apiItem.title, `localhost:${portOf(api)}`, "No page title: host:port");
  is(apiItem.icon, FALLBACK_ICON, "No favicon: the fallback icon");

  await Promise.all([app, api, airplay].map(stopServer));
  await SpecialPowers.popPrefEnv();
});

// wave7/security L9: a local page's icon is fetched only from that server,
// never from another host it names (or redirects to).
add_task(async function test_icon_only_from_the_server_itself() {
  const elsewhere = startServer({ icon: true });
  const hits = [];
  elsewhere.registerPathHandler("/beacon.png", (request, response) => {
    hits.push(request.path);
    response.setHeader("Content-Type", "image/png", false);
    response.bodyOutputStream.write(PNG_BYTES, PNG_BYTES.length);
  });
  const other = `http://localhost:${portOf(elsewhere)}/beacon.png`;
  const named = startServer({ html: `<title>Named</title><link rel="icon" href="${other}">` });
  const redirecting = startServer({ html: '<title>Redirect</title><link rel="icon" href="/icon.png">' });
  redirecting.registerPathHandler("/icon.png", (request, response) => {
    response.setStatusLine(request.httpVersion, 302, "Found");
    response.setHeader("Location", other, false);
  });
  await usePorts([portOf(named), portOf(redirecting)]);
  const { provider } = makeProvider();
  const items = await provider.fetchItems();
  is(items.length, 2, "Both servers are listed");
  ok(items.every(i => i.icon == FALLBACK_ICON), "with the fallback icon");
  Assert.deepEqual(hits, [], "The other host was never asked");
  await Promise.all([elsewhere, named, redirecting].map(stopServer));
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_polls_only_while_visible() {
  const app = startServer({ html: "<title>One</title>" });
  const other = startServer({ html: "<title>Two</title>" });
  await usePorts([portOf(app), portOf(other)]);

  const { provider, folder, fetches, manager } = makeProvider({ collapsed: true });
  provider.start();
  ok(!provider.isVisible, "A collapsed folder isn't visible");
  ok(!provider.isPolling, "and isn't polled");
  await new Promise(resolve => setTimeout(resolve, 100));
  is(fetches.length, 0, "Nothing is probed while collapsed");

  folder.collapsed = false;
  provider.handleEvent({ type: "TabGroupExpand" });
  await TestUtils.waitForCondition(() => fetches.length === 1, "Expanding probes at once");
  ok(provider.isPolling, "and starts polling");
  is(fetches[0].length, 2, "Both servers are there");

  await provider.refresh();
  is(fetches.length, 1, "An unchanged set of servers doesn't touch the folder");

  // A stopped server has no port any more, so remember it first.
  const otherPort = portOf(other);
  manager.dismissedItems.add(`test-local:${otherPort}`);
  await stopServer(other);
  await provider.refresh();
  is(fetches.length, 2, "A server stopping updates the folder");
  Assert.deepEqual(
    fetches[1].map(i => i.title),
    ["One"],
    "and its tab goes away"
  );
  ok(!manager.dismissedItems.has(`test-local:${otherPort}`), "Closing a server's tab lasts only while it runs");

  // The real listener wiring, through the window's document.
  folder.collapsed = true;
  document.dispatchEvent(new Event("visibilitychange"));
  await TestUtils.waitForCondition(() => !provider.isPolling, "Collapsing stops polling");

  provider.stop();
  ok(!provider.isPolling, "stop() leaves no timer");
  await stopServer(app);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_real_folder() {
  const app = startServer({ html: "<title>Real Folder App</title>" });
  await usePorts([portOf(app)]);

  const liveFolder = await WhimsyLiveFolders.createLocalServersFolder(window);
  ok(liveFolder, "A Local Servers folder is created");
  const folder = liveFolder.manager.getFolderForLiveFolder(liveFolder);
  ok(folder && !folder.collapsed, "It starts expanded");
  await TestUtils.waitForCondition(
    () => folder.tabs.some(t => t.getAttribute("zen-live-folder-item-id") === `${folder.id}:${portOf(app)}`),
    "The running server appears as a tab"
  );
  ok(liveFolder.isPolling, "It polls while expanded");

  folder.collapsed = true;
  await TestUtils.waitForCondition(() => !liveFolder.isPolling, "Collapsing the folder stops polling");

  liveFolder.manager.deleteFolder(folder.id);
  ok(!liveFolder.isPolling, "Deleting the folder leaves no timer");
  await stopServer(app);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_create_menu_and_switch() {
  const submenu = document.getElementById("zen-panel-ui-live-folder-create");
  const popup = submenu.menupopup;
  const show = () => popup.dispatchEvent(new Event("popupshowing", { bubbles: true }));
  show();
  show();
  const items = popup.querySelectorAll(":scope > .whimsy-live-folder-local-servers-create");
  is(items.length, 1, "Local Servers is in the create menu, once");
  ok(!items[0].hidden, "and shown");
  is(items[0].getAttribute("command"), "cmd_zenNewLiveFolder", "It runs the live folder command");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.live-folders-local-servers", false]] });
  ok(!WhimsyLiveFolders.localServersEnabled, "The feature switch is off");
  show();
  ok(items[0].hidden, "and the menu item is hidden");
  await SpecialPowers.popPrefEnv();
  ok(WhimsyLiveFolders.localServersEnabled, "On by default");
});

// w7native: Bonjour services on the LAN, through a stand-in for the native
// browser (nsIWhimsyBonjour).
function makeBonjourMock() {
  const mock = {
    starts: [],
    stops: 0,
    listener: null,
    browsing: false,
    allowedTypes: BONJOUR_TYPES,
    start(types, listener) {
      this.starts.push([...types]);
      this.listener = listener;
      this.browsing = true;
    },
    stop() {
      this.stops++;
      this.browsing = false;
    },
    announce(services) {
      this.listener.onServicesChanged(JSON.stringify(services));
    },
  };
  BonjourTesting.factory = () => mock;
  return mock;
}

add_task(async function test_bonjour_items() {
  const services = [
    { name: "Office NAS", type: "_http._tcp", domain: "local.", host: "nas.local.", port: 5000, local: false },
    { name: "Office NAS", type: "_https._tcp", domain: "local.", host: "nas.local", port: 5001, local: false },
    { name: "Printer", type: "_http._tcp", domain: "local.", host: "printer.local", port: 80, path: "/admin", local: false },
    { name: "My dev server", type: "_http._tcp", domain: "local.", host: "mac.local", port: 3000, local: true },
    { name: "Other port", type: "_http._tcp", domain: "local.", host: "mac.local", port: 4100, local: true },
    { name: "Broken", type: "_http._tcp", domain: "local.", host: "bad host", port: 80 },
    { name: "No port", type: "_http._tcp", domain: "local.", host: "x.local", port: 0 },
  ];
  const items = bonjourItems(services, [3000]);
  Assert.deepEqual(
    items.map(i => i.title),
    ["Office NAS", "Other port", "Printer"],
    "Sorted by name; this Mac's service on a probed port, bad hosts and port 0 are left out"
  );
  const nas = items.find(i => i.title == "Office NAS");
  is(nas.url, "https://nas.local:5001/", "A name on both http and https opens https");
  is(nas.subtitle, "nas.local:5001", "The subtitle is host:port");
  ok(nas.lan, "marked as a LAN item");
  is(items.find(i => i.title == "Printer").url, "http://printer.local/admin", "Default port dropped, TXT path kept");
  is(items.find(i => i.title == "Other port").url, "http://mac.local:4100/", "This Mac's service on another port stays");
  Assert.deepEqual(bonjourItems(null), [], "Nothing in, nothing out");
});

add_task(async function test_bonjour_browses_only_while_polling() {
  await usePorts([await closedPort()]);
  await SpecialPowers.pushPrefEnv({ set: [[BONJOUR_PREF, true]] });
  const mock = makeBonjourMock();

  const { provider, folder, fetches } = makeProvider({ collapsed: true });
  provider.start();
  is(mock.starts.length, 0, "A collapsed folder doesn't browse the LAN");

  folder.collapsed = false;
  provider.handleEvent({ type: "TabGroupExpand" });
  await TestUtils.waitForCondition(() => provider.isPolling, "Expanding starts polling");
  is(mock.starts.length, 1, "and the Bonjour browse");
  Assert.deepEqual(mock.starts[0], BONJOUR_TYPES, "for the HTTP types in Info.plist");
  ok(provider.isBrowsing, "The provider says it's browsing");

  const before = fetches.length;
  mock.announce([{ name: "Office NAS", type: "_http._tcp", domain: "local.", host: "nas.invalid", port: 5000, local: false }]);
  await TestUtils.waitForCondition(() => fetches.length > before && fetches.at(-1).some(i => i.lan), "A found service updates the folder");
  const item = fetches.at(-1).find(i => i.lan);
  is(item.title, "Office NAS", "named by Bonjour");
  is(item.url, "http://nas.invalid:5000/", "opening its address");
  is(item.icon, LAN_ICON, "with the LAN icon when it has no favicon");
  is(item.id, "lan:office nas", "and a stable id");

  mock.listener.onError("denied");
  is(provider.lanError, "denied", "A refusal is kept for the folder");

  folder.collapsed = true;
  provider.handleEvent({ type: "TabGroupCollapse" });
  await TestUtils.waitForCondition(() => !provider.isPolling, "Collapsing stops polling");
  is(mock.stops, 1, "and the browse");
  ok(!provider.isBrowsing, "Nothing browses while collapsed");

  // A late answer from a stopped browse is ignored.
  const count = fetches.length;
  mock.announce([{ name: "Late", type: "_http._tcp", host: "late.invalid", port: 80 }]);
  await new Promise(resolve => setTimeout(resolve, 100));
  is(fetches.length, count, "A stopped browse can't change the folder");

  provider.stop();
  BonjourTesting.factory = null;
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_bonjour_pref_off() {
  await usePorts([await closedPort()]);
  const mock = makeBonjourMock();
  const { provider } = makeProvider();
  provider.start();
  await TestUtils.waitForCondition(() => provider.isPolling, "The folder polls");
  is(mock.starts.length, 0, "With the Bonjour pref off nothing browses the LAN");
  provider.stop();
  BonjourTesting.factory = null;
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_bonjour_native_component() {
  // The real component, without starting it (that would prompt for Local
  // Network access): it's registered on macOS and reads Info.plist.
  if (AppConstants.platform != "macosx") {
    ok(!Cc["@whimsy/bonjour;1"], "Only built on macOS");
    return;
  }
  const bonjour = Cc["@whimsy/bonjour;1"].createInstance(Ci.nsIWhimsyBonjour);
  ok(!bonjour.browsing, "A new browser isn't browsing");
  ok(Array.isArray(bonjour.allowedTypes), "Its allowed types are a list");
  bonjour.stop();
  ok(!bonjour.browsing, "stop() without start() is harmless");
});
