/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// B17: a stale or re-registered Sync client record for this same Mac must
// never show up as another device, in either list that reads it: the
// command bar's synced-tabs source (SyncedTabs.getTabClients, feeding
// UrlbarProviderRemoteTabs) or the app-menu's Sync panel "all devices" list
// (FxAMenuDeviceList._getMergedDeviceList, which backs Send Tab to Device).
// Firefox's own fxAccounts.device.recentDeviceList/isCurrentDevice check
// only runs on devices it already matched to a Sync client; an unmatched or
// re-registered client for the local Mac slips past it in both call sites.
// This fakes exactly that: a device list where one device (and its Sync
// client) is the local device, keyed either by matching Sync client GUID or
// by FxA device id, and checks it never appears in either list's output.

const { Weave } = ChromeUtils.importESModule(
  "resource://services-sync/main.sys.mjs"
);
const { SyncedTabs } = ChromeUtils.importESModule(
  "resource://services-sync/SyncedTabs.sys.mjs"
);
const { getFxAccountsSingleton } = ChromeUtils.importESModule(
  "resource://gre/modules/FxAccounts.sys.mjs"
);

const LOCAL_FXA_DEVICE_ID = "local-device-id";
const LOCAL_CLIENT_GUID = "guid_local_desktop";
const REMOTE_FXA_DEVICE_ID = "remote-device-id";
const REMOTE_CLIENT_GUID = "guid_remote_desktop";

function MockTabsEngine() {
  this.clients = {};
}
MockTabsEngine.prototype = {
  name: "tabs",
  enabled: true,
  getAllClients() {
    return Object.values(this.clients);
  },
  getOpenURLs() {
    return new Set();
  },
  async finalize() {},
};

let tabsEngine;
let realClientsEngine;

const MockClientsEngine = {
  localID: LOCAL_CLIENT_GUID,
  remoteClientExists(id) {
    return !!tabsEngine.clients[id];
  },
  getClientFxaDeviceId(id) {
    return tabsEngine.clients[id]?.fxaDeviceId ?? null;
  },
  getClientName(id) {
    return tabsEngine.clients[id]?.clientName ?? "";
  },
  getClientType() {
    return "desktop";
  },
  isMobile() {
    return false;
  },
};

function configureClients(clients) {
  for (const [guid, client] of Object.entries(clients)) {
    client.id = guid;
  }
  tabsEngine.clients = clients;
  Services.obs.notifyObservers(null, "weave:engine:sync:finish", "tabs");
}

add_setup(async function setup() {
  // configureClients() fires "weave:engine:sync:finish", which makes
  // SyncedTabs stamp services.sync.lastTabFetch; restore it afterwards.
  const hadLastTabFetch = Services.prefs.prefHasUserValue(
    "services.sync.lastTabFetch"
  );
  const lastTabFetch = hadLastTabFetch
    ? Services.prefs.getIntPref("services.sync.lastTabFetch")
    : 0;

  await Weave.Service.promiseInitialized;
  await Weave.Service.engineManager.unregister("tabs");
  await Weave.Service.engineManager.register(MockTabsEngine);
  realClientsEngine = Weave.Service.clientsEngine;
  Weave.Service.clientsEngine = MockClientsEngine;
  tabsEngine = Weave.Service.engineManager.get("tabs");

  const weaveXPCService = Cc["@mozilla.org/weave/service;1"].getService(
    Ci.nsISupports
  ).wrappedJSObject;
  const wasReady = weaveXPCService.ready;
  weaveXPCService.ready = true;

  const fxAccounts = getFxAccountsSingleton();
  const realRecentDeviceList = Object.getOwnPropertyDescriptor(
    fxAccounts.device,
    "recentDeviceList"
  );
  Object.defineProperty(fxAccounts.device, "recentDeviceList", {
    configurable: true,
    get: () => [
      {
        id: LOCAL_FXA_DEVICE_ID,
        name: "This Mac",
        isCurrentDevice: true,
        lastAccessTime: 2,
        availableCommands: {},
      },
      {
        id: REMOTE_FXA_DEVICE_ID,
        name: "Other Mac",
        isCurrentDevice: false,
        lastAccessTime: 1,
        availableCommands: {},
      },
    ],
  });

  registerCleanupFunction(async () => {
    if (realRecentDeviceList) {
      Object.defineProperty(
        fxAccounts.device,
        "recentDeviceList",
        realRecentDeviceList
      );
    } else {
      delete fxAccounts.device.recentDeviceList;
    }
    weaveXPCService.ready = wasReady;
    Weave.Service.clientsEngine = realClientsEngine;
    await Weave.Service.engineManager.unregister("tabs");
    if (hadLastTabFetch) {
      Services.prefs.setIntPref("services.sync.lastTabFetch", lastTabFetch);
    } else {
      Services.prefs.clearUserPref("services.sync.lastTabFetch");
    }
  });
});

// The local Mac's Sync client record is keyed by the same GUID the clients
// engine uses for itself (clientsEngine.localID): the straightforward case
// of a stale self-record still present in the clients collection.
add_task(async function test_synced_tabs_excludes_local_client_by_guid() {
  configureClients({
    [LOCAL_CLIENT_GUID]: {
      clientName: "This Mac",
      fxaDeviceId: LOCAL_FXA_DEVICE_ID,
      tabs: [{ urlHistory: ["https://example.com/local"], title: "Local" }],
    },
    [REMOTE_CLIENT_GUID]: {
      clientName: "Other Mac",
      fxaDeviceId: REMOTE_FXA_DEVICE_ID,
      tabs: [{ urlHistory: ["https://example.com/remote"], title: "Remote" }],
    },
  });

  const clients = await SyncedTabs.getTabClients();
  ok(
    !clients.some(c => c.id == LOCAL_CLIENT_GUID),
    "the command bar's synced-tabs source never lists this device's own client"
  );
  is(clients.length, 1, "only the other device's client is listed");
  is(clients[0].id, REMOTE_CLIENT_GUID, "the remaining client is the remote one");
});

// A re-registered client for the local Mac under a different Sync GUID,
// recognisable only by its FxA device id matching the current device.
add_task(async function test_synced_tabs_excludes_local_client_by_fxa_device_id() {
  const reRegisteredGuid = "guid_local_desktop_reregistered";
  configureClients({
    [reRegisteredGuid]: {
      clientName: "This Mac (new sync id)",
      fxaDeviceId: LOCAL_FXA_DEVICE_ID,
      tabs: [{ urlHistory: ["https://example.com/local2"], title: "Local 2" }],
    },
    [REMOTE_CLIENT_GUID]: {
      clientName: "Other Mac",
      fxaDeviceId: REMOTE_FXA_DEVICE_ID,
      tabs: [{ urlHistory: ["https://example.com/remote2"], title: "Remote 2" }],
    },
  });

  const clients = await SyncedTabs.getTabClients();
  ok(
    !clients.some(c => c.id == reRegisteredGuid),
    "a client matching the current FxA device id is excluded even under a new Sync GUID"
  );
  is(clients.length, 1, "only the other device's client is listed");
});

// The app-menu Sync panel's "all devices" list (Send Tab to Device / synced
// tabs) must also never surface the local device, including the case where
// its client record doesn't match any entry in recentDeviceList by FxA
// device id (the unmatched-clients fallback FxAMenuDeviceList appends so the
// list "never shows fewer devices than the tabs engine knows about").
add_task(async function test_merged_device_list_excludes_local_device() {
  configureClients({
    [LOCAL_CLIENT_GUID]: {
      clientName: "This Mac",
      fxaDeviceId: LOCAL_FXA_DEVICE_ID,
      tabs: [{ urlHistory: ["https://example.com/local3"], title: "Local 3" }],
    },
    [REMOTE_CLIENT_GUID]: {
      clientName: "Other Mac",
      fxaDeviceId: REMOTE_FXA_DEVICE_ID,
      tabs: [{ urlHistory: ["https://example.com/remote3"], title: "Remote 3" }],
    },
  });

  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const merged = await win.FxAMenuDeviceList.prototype._getMergedDeviceList.call({});
  ok(
    !merged.some(c => c.id == LOCAL_CLIENT_GUID || c.id == LOCAL_FXA_DEVICE_ID),
    "the all-devices / Send Tab to Device list never lists this device"
  );
  is(merged.length, 1, "only the other device is listed");
  is(merged[0].id, REMOTE_CLIENT_GUID, "the remaining entry is the remote device's client");
});

// Same list, but the local device's client is unmatched by FXA id (the
// stale-record fallback path FxAMenuDeviceList appends unconditionally).
add_task(async function test_merged_device_list_excludes_unmatched_local_client() {
  configureClients({
    [LOCAL_CLIENT_GUID]: {
      clientName: "This Mac",
      fxaDeviceId: "some-other-stale-id-not-in-recentDeviceList",
      tabs: [],
    },
    [REMOTE_CLIENT_GUID]: {
      clientName: "Other Mac",
      fxaDeviceId: REMOTE_FXA_DEVICE_ID,
      tabs: [{ urlHistory: ["https://example.com/remote4"], title: "Remote 4" }],
    },
  });

  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const merged = await win.FxAMenuDeviceList.prototype._getMergedDeviceList.call({});
  ok(
    !merged.some(c => c.id == LOCAL_CLIENT_GUID),
    "an unmatched client for this device is still excluded by its Sync client GUID"
  );
  is(merged.length, 1, "only the other device's client is listed");
});
