/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const { WhimsyGoogleSearch, WhimsyGoogleSearchProvider } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyGoogleSearch.sys.mjs");
const { WhimsyConnectors } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyConnectors.sys.mjs");
const { WhimsyConnectorOAuth } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyConnectorOAuth.sys.mjs");
const { HttpServer } = ChromeUtils.importESModule("resource://testing-common/httpd.sys.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
const original = {};
const entry = (account, scopes = {}) => ({ account, scopes: { gmail: true, drive: true, calendar: true, ...scopes }, status: "ok" });

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.google-search", true], ["whimsy.feature.ai-connectors", true], ["whimsy.feature.ai-hints", false], ["whimsy.connectors.google.client-id", "test.apps"]] });
  for (const key of ["_file", "_api", "searchGoogleAccount", "connect", "accessToken"]) {
    original[key] = WhimsyConnectors[key];
  }
  WhimsyConnectors._file = { connectors: { google: entry("work@example.com"), "google:personal": entry("personal@example.com"), "google:side": entry("side@example.com") } };
  registerCleanupFunction(() => {
    WhimsyGoogleSearch.exit(window, false);
    Object.assign(WhimsyConnectors, original);
    gURLBar.view.close();
  });
});

add_task(async function legacy_account_becomes_an_account_without_losing_its_secret() {
  const legacy = { ...entry("work@example.com", { drive: false }), secret: "ciphertext" };
  WhimsyConnectors._file = { connectors: { google: legacy } };
  const [account] = await WhimsyConnectors.googleAccounts();
  is(account.id, "google", "The legacy identity remains stable for existing consumers");
  is(account.label, "work", "The label defaults to the address prefix");
  ok(account.useInSearch, "Existing accounts participate in chip search");
  ok(!account.scopes.find(s => s.id == "drive").on, "The old switch is preserved");
  is(WhimsyConnectors._file.connectors.google.secret, "ciphertext", "Migration retains encrypted tokens");
  WhimsyConnectors._file.connectors["google:personal"] = entry("personal@example.com");
  is((await WhimsyConnectors.list()).find(c => c.id == "google").accounts.length, 2, "Settings gets one Google card containing both accounts");
});

add_task(async function fake_google_api_metadata_and_pagination() {
  const server = new HttpServer();
  server.start(-1);
  const base = `http://127.0.0.1:${server.identity.primaryPort}`;
  const endpoints = WhimsyConnectorOAuth._test;
  const token = WhimsyConnectors.accessToken;
  const requests = [];
  server.registerPrefixHandler("/", (request, response) => {
    requests.push(new URL(request.path + "?" + request.queryString, base));
    is(request.getHeader("Authorization"), "Bearer fake-profile-token", "The user's account token goes directly to the API");
    response.setHeader("Content-Type", "application/json");
    const data = request.path.includes("/drive/")
      ? { nextPageToken: "drive-page-2", files: [{ id: "file", name: "Budget", modifiedTime: "2026-11-01T00:00:00Z", mimeType: "application/pdf", webViewLink: "https://drive.google.com/file/d/file/view" }] }
      : request.path.endsWith("/messages")
        ? { messages: [{ id: "message" }], nextPageToken: "mail-page-2" }
        : { id: "message", threadId: "thread", internalDate: "100", payload: { headers: [{ name: "Subject", value: "Invoice" }, { name: "From", value: "Billing" }] } };
    response.write(JSON.stringify(data));
  });
  WhimsyConnectorOAuth.setTestEndpoints({ google: { api: base } });
  WhimsyConnectors.accessToken = async id => {
    is(id, "google:personal", "Secondary accounts keep their own token identity");
    return "fake-profile-token";
  };
  try {
    const mail = await WhimsyConnectors.searchGoogleAccount("google:personal", "mail", "invoice");
    is(mail[0].title, "Invoice", "Mail metadata is mapped");
    is(mail[0].at, 100, "Mail uses Google's internal date");
    is(mail.nextPageToken, "mail-page-2", "Mail retains the cursor");
    const files = await WhimsyConnectors.searchGoogleAccount("google:personal", "drive", "budget's \\ notes", { pageToken: "page-1" });
    is(files[0].title, "Budget", "Drive metadata is mapped");
    is(files.nextPageToken, "drive-page-2", "Drive retains the cursor");
    const drive = requests.at(-1);
    is(drive.searchParams.get("orderBy"), "modifiedTime desc", "Drive asks for newest files");
    is(drive.searchParams.get("pageToken"), "page-1", "The account's cursor is passed through");
    ok(drive.searchParams.get("q").includes("budget\\'s \\\\ notes"), "Drive query literals escape quotes and backslashes");
    const count = requests.length;
    const controller = new AbortController();
    let releaseToken;
    WhimsyConnectors.accessToken = () => new Promise(resolve => (releaseToken = resolve));
    const cancelled = WhimsyConnectors._api("google:personal", "/drive/v3/files", { signal: controller.signal });
    controller.abort();
    releaseToken("fake-profile-token");
    await Assert.rejects(cancelled, e => e.name == "AbortError", "Cancellation during token lookup aborts the API request");
    is(requests.length, count, "An aborted token lookup sends no API request");
  } finally {
    WhimsyConnectorOAuth.setTestEndpoints(endpoints);
    WhimsyConnectors.accessToken = token;
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(async function chip_entry_exit_and_at_list() {
  gURLBar.focus();
  gURLBar.value = "@mail ";
  gURLBar.inputField.dispatchEvent(new Event("input", { bubbles: true }));
  await TestUtils.waitForCondition(() => WhimsyGoogleSearch.state(window)?.mode == "mail", "Typing the keyword and a space enters Mail");
  await TestUtils.waitForCondition(() => gURLBar.value == "", "The keyword is consumed");
  ok(document.querySelector(".whimsy-google-mode"), "A mode chip precedes the input");
  EventUtils.synthesizeKey("KEY_Backspace");
  ok(!WhimsyGoogleSearch.state(window), "Backspace on an empty field removes the chip");
  const provider = new WhimsyGoogleSearchProvider();
  const active = provider.isActive({ searchString: "@", isPrivate: false });
  ok(typeof active.then == "function", "Provider activation follows Gecko's Promise contract");
  ok(await active, "The @ query activates the provider");
  is(provider.getPriority(), 0, "Mode entries coexist with the ordinary providers");
  const rows = [];
  await provider.startQuery({ searchString: "@", isPrivate: false }, (_p, result) => rows.push(result));
  Assert.deepEqual(rows.map(r => r.payload.mode), ["mail", "drive"], "Both modes appear in the @ list");
  WhimsyGoogleSearch.enter(window, "drive");
  EventUtils.synthesizeKey("KEY_Escape");
  ok(!WhimsyGoogleSearch.state(window), "Escape exits the mode");
  gURLBar.view.close();
});

add_task(async function late_accounts_merge_by_date_failure_and_search_opt_out() {
  WhimsyConnectors._file = { connectors: { google: entry("work@example.com"), "google:personal": entry("personal@example.com"), "google:side": entry("side@example.com"), "google:excluded": { ...entry("excluded@example.com"), useInSearch: false } } };
  const real = WhimsyConnectors.searchGoogleAccount;
  const called = [];
  let finishWork;
  const work = new Promise(resolve => (finishWork = resolve));
  WhimsyConnectors.searchGoogleAccount = async (id, mode) => {
    called.push([id, mode]);
    if (id == "google") {
      return work;
    }
    if (id == "google:side") {
      throw new Error("Expired");
    }
    const rows = [{ id: "middle", title: "Personal", at: 20 }];
    rows.nextPageToken = "next-personal";
    return rows;
  };
  try {
    gURLBar.focus();
    WhimsyGoogleSearch.enter(window, "mail", "invoice");
    await TestUtils.waitForCondition(() => document.querySelector(".whimsy-google-row .urlbarView-title")?.textContent == "Personal", "The fast account is drawn before the slow account finishes");
    const state = WhimsyGoogleSearch.state(window);
    is(WhimsyGoogleSearch.provider.getPriority(), 100, "An explicit mode suppresses unrelated providers");
    state.selected = "google:personal:middle";
    finishWork([{ id: "old", at: 10 }, { id: "new", at: 30 }]);
    await TestUtils.waitForCondition(() => state.rows.some(r => r.id == "new"), "The slow account finishes");
    Assert.deepEqual(state.rows.map(r => r.id), ["new", "middle", "old", "error"], "Late results slot in by date and one failed account comes last");
    is(state.selected, "google:personal:middle", "Late results preserve the selected identity");
    is(state.node.querySelector("[selected] .urlbarView-title")?.textContent, "Personal", "The same visible row stays selected after the late merge");
    is(state.rows.filter(r => r.failed).length, 1, "Exactly one muted failure row per account");
    ok(!called.some(([id]) => id == "google:excluded"), "Use in Search off excludes the account");
    let signin;
    const connect = WhimsyConnectors.connect;
    WhimsyConnectors.connect = async (_win, id, opts) => (signin = [id, opts.accountId]);
    try {
      await WhimsyGoogleSearch.open(window, state.rows.find(r => r.failed));
      Assert.deepEqual(signin, ["google", "google:side"], "Opening a failure starts sign-in for that account");
    } finally {
      WhimsyConnectors.connect = connect;
    }
  } finally {
    finishWork([]);
    WhimsyConnectors.searchGoogleAccount = real;
    WhimsyGoogleSearch.exit(window, false);
  }
});

add_task(async function normal_and_private_windows_do_not_search() {
  const provider = new WhimsyGoogleSearchProvider();
  ok(!(await provider.isActive({ searchString: "invoice", isPrivate: false })), "The normal command bar cannot activate Google search");
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const real = WhimsyConnectors.searchGoogleAccount;
  let requests = 0;
  WhimsyConnectors.searchGoogleAccount = async () => { requests++; return []; };
  try {
    win.gURLBar.focus();
    win.gURLBar.value = "@mail invoice";
    win.gURLBar.inputField.dispatchEvent(new win.Event("input", { bubbles: true }));
    WhimsyGoogleSearch.enter(win, "drive", "budget");
    ok(!WhimsyGoogleSearch.state(win), "Private windows never enter either chip mode");
    ok(!(await provider.isActive({ searchString: "@mail", isPrivate: true })), "Private @ suggestions are disabled");
    is(requests, 0, "No Google requests in private windows");
  } finally {
    WhimsyConnectors.searchGoogleAccount = real;
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function superseded_lookup_cannot_replace_accounts_or_cancel_the_new_query() {
  WhimsyConnectors._file = { connectors: { google: entry("work@example.com") } };
  const accounts = WhimsyConnectors.googleAccounts;
  const search = WhimsyConnectors.searchGoogleAccount;
  const provider = new WhimsyGoogleSearchProvider();
  let releaseAccounts;
  let oldQuery;
  try {
    gURLBar.focus();
    WhimsyGoogleSearch.enter(window, "mail");
    await UrlbarTestUtils.promiseSearchComplete(window);
    await TestUtils.waitForCondition(() => WhimsyGoogleSearch.state(window)?.node?.isConnected, "The empty mode list is mounted");
    const state = WhimsyGoogleSearch.state(window);
    const node = state.node;
    const currentAccounts = await accounts.call(WhimsyConnectors);
    let lookups = 0;
    WhimsyConnectors.googleAccounts = async () => ++lookups == 1
      ? new Promise(resolve => (releaseAccounts = resolve))
      : currentAccounts;
    WhimsyConnectors.searchGoogleAccount = async (_id, _mode, query) => [{ id: query, title: query, at: 100 }];
    const oldContext = { searchString: "old", isPrivate: false };
    oldQuery = provider.startQuery(oldContext, () => {});
    await TestUtils.waitForCondition(() => !!releaseAccounts, "The old account lookup is pending");
    await provider.startQuery({ searchString: "latest", isPrivate: false }, () => {});
    provider.cancelQuery(oldContext);
    ok(!state.controller.signal.aborted, "Cancelling an old context leaves the latest request alive");
    releaseAccounts([]);
    await oldQuery;
    Assert.deepEqual(state.accounts.map(a => a.id), ["google"], "A superseded lookup cannot overwrite the current accounts");
    Assert.deepEqual(state.rows.map(r => r.id), ["latest"], "Only the latest query supplies rows");
    is(state.node, node, "A reused dynamic node stays mounted");
    is(node.querySelector(".urlbarView-title")?.textContent, "latest", "The reused list draws the new result");
  } finally {
    releaseAccounts?.([]);
    await oldQuery;
    WhimsyConnectors.googleAccounts = accounts;
    WhimsyConnectors.searchGoogleAccount = search;
    WhimsyGoogleSearch.exit(window, false);
    gURLBar.view.close();
  }
});

add_task(async function settings_migrates_in_the_same_card() {
  WhimsyConnectors._file = { connectors: { google: entry("legacy@example.com", { drive: false }) } };
  await BrowserTestUtils.withNewTab("about:preferences#whimsyAI", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.querySelector('.whimsy-google-accounts [data-account="google"]'), "The old account appears inside the Google card");
    const card = doc.querySelector(".whimsy-google-accounts");
    const label = card.querySelector("input");
    is(label.value, "legacy", "The migrated label is editable in place");
    Assert.deepEqual([...card.querySelectorAll("moz-toggle")].map(t => [t.dataset.scope, t.pressed]), [["gmail", true], ["calendar", true], ["drive", false], ["search", true]], "Existing scopes become account switches alongside Use in Search");
    is(card.querySelectorAll('[data-l10n-id="whimsy-google-add-account"]').length, 1, "There is one Add another account control");
    ok(!card.querySelector(".whimsy-ai-chev"), "The single-account expansion control is replaced");
  });
});

add_task(async function account_routing_and_option_enter() {
  WhimsyConnectors._file = { connectors: { google: entry("work@example.com") } };
  const opened = [];
  const open = window.openTrustedLinkIn;
  window.openTrustedLinkIn = (url, where) => opened.push({ url: new URL(url), where });
  try {
    WhimsyGoogleSearch.enter(window, "drive");
    await WhimsyGoogleSearch.open(window, { id: "file", accountId: "google", url: "https://docs.google.com/document/d/file/edit" });
    is(opened[0].url.searchParams.get("authuser"), "work@example.com", "Drive explicitly routes to the result's Google identity");
    is(opened[0].where, "current", "Enter opens in the current tab");
    WhimsyGoogleSearch.enter(window, "mail");
    await WhimsyGoogleSearch.open(window, { id: "message", threadId: "thread", accountId: "google" }, true);
    is(opened[1].where, "tab", "Option-Enter forces a new tab");
    is(opened[1].url.searchParams.get("authuser"), "work@example.com", "Mail also routes to the result's Google identity");
    is(opened[1].url.hash, "#all/thread", "Mail opens the matching thread");
  } finally {
    window.openTrustedLinkIn = open;
    WhimsyGoogleSearch.exit(window, false);
  }
});

add_task(async function chip_rows_and_settings_light_dark() {
  const search = WhimsyConnectors.searchGoogleAccount;
  WhimsyConnectors._file = { connectors: { google: { ...entry("work@example.com"), label: "Work" }, "google:personal": { ...entry("personal@example.com"), label: "Personal" } } };
  WhimsyConnectors.searchGoogleAccount = async id => [{ id: id + "-result", title: "Invoice for October — design subscriptions and the shared workspace renewal", detail: "Figma Billing", at: 1794000000000 }];
  function rgb(value) {
    const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }
  const luminance = values => values.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (el, background = el) => {
    const style = getComputedStyle(el);
    const a = luminance(rgb(style.color));
    const b = luminance(rgb(getComputedStyle(background).backgroundColor));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  try {
    await whimsyBothSchemes("gsearch-mail", async () => {
      gURLBar.focus();
      WhimsyGoogleSearch.enter(window, "mail", "invoice");
      await TestUtils.waitForCondition(() => document.querySelectorAll(".whimsy-google-row").length == 2, "Both account rows are drawn at the default command-bar width");
      const selected = document.querySelector(".whimsy-google-row[selected]");
      Assert.greaterOrEqual(contrast(document.querySelector(".whimsy-google-mode")), 4.5, "Mode chip text meets AA");
      Assert.greaterOrEqual(contrast(selected), 4.5, "Selected row text meets AA");
      for (const el of selected.querySelectorAll(".urlbarView-title, .whimsy-google-detail")) {
        Assert.greaterOrEqual(contrast(el, selected), 4.5, `Selected ${el.className} text meets AA on the row's fill`);
      }
      const rows = [...document.querySelectorAll(".whimsy-google-row")];
      ok(rows.every(row => row.lastElementChild.classList.contains("whimsy-google-account")), "Account tags are last on each row");
      const list = document.querySelector(".whimsy-google-results");
      ok(list.getBoundingClientRect().width > 0 && list.scrollWidth <= list.clientWidth, "The list fits the default command-bar width");
      for (const row of rows) {
        ok(BrowserTestUtils.isVisible(row), "Each account row is visible");
        // A missing brace earlier in the shared sheet nested these rules
        // under the focus-tab caption. Inline spans then had no client box,
        // and the selected option inherited the ordinary result colors.
        is(getComputedStyle(row).display, "grid", "The result layout applies outside the focus-tab caption");
        is(getComputedStyle(row.querySelector(".whimsy-google-text")).display, "flex", "The title and detail form a column");
        for (const el of row.querySelectorAll(".urlbarView-title, .whimsy-google-detail, .whimsy-google-account")) {
          ok(el.clientWidth > 0, `${el.className} has a text box`);
          ok(el.scrollWidth <= el.clientWidth, `${el.className} is not clipped (${el.scrollWidth}/${el.clientWidth}px)`);
          ok(el.getBoundingClientRect().right <= list.getBoundingClientRect().right + 1, "Row content stays inside the list");
        }
      }
      return () => { WhimsyGoogleSearch.exit(window, false); gURLBar.view.close(); };
    });
    await whimsyBothSchemes("gsearch-settings", async () => {
      const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#whimsyAI");
      const doc = tab.linkedBrowser.contentDocument;
      await TestUtils.waitForCondition(() => doc.querySelectorAll(".whimsy-google-account-settings").length == 2, "Settings shows both accounts");
      tab.linkedBrowser.contentWindow.WhimsyAISettings.jumpTo("connectors");
      await doc.l10n.translateFragment(doc.querySelector(".whimsy-google-accounts"));
      const switches = [...doc.querySelectorAll(".whimsy-google-switches .whimsy-connectors-scope > span")];
      ok(switches.every(el => el.scrollWidth <= el.clientWidth), "Account switch labels are not clipped");
      return () => BrowserTestUtils.removeTab(tab);
    });
  } finally {
    WhimsyConnectors.searchGoogleAccount = search;
    WhimsyGoogleSearch.exit(window, false);
  }
});

add_task(async function adding_reauthenticating_and_switching_accounts_is_isolated() {
  const restore = {};
  for (const key of ["_file", "_update", "_saveTokens", "_refreshCalendars"]) {
    restore[key] = WhimsyConnectors[key];
  }
  const signIn = WhimsyConnectorOAuth.signInProvider;
  let address = "personal@example.com";
  const savedIds = [];
  WhimsyConnectors._file = { connectors: { google: { ...entry("work@example.com"), secret: "work-ciphertext", label: "Work" } } };
  WhimsyConnectors._update = async change => change(await WhimsyConnectors._read());
  WhimsyConnectors._saveTokens = async (file, id) => { savedIds.push(id); file.connectors[id].secret = "personal-ciphertext"; };
  WhimsyConnectors._refreshCalendars = async () => {};
  WhimsyConnectorOAuth.signInProvider = async () => ({ account: address, tokens: {} });
  try {
    const personal = await WhimsyConnectors.connect(window, "google");
    is((await WhimsyConnectors.googleAccounts()).length, 2, "Adding another account retains the existing account");
    is(WhimsyConnectors._file.connectors.google.secret, "work-ciphertext", "Adding an account does not overwrite the first account's tokens");
    Assert.deepEqual(savedIds, [personal.id], "The new account's tokens have their own storage identity");
    await WhimsyConnectors.updateGoogleAccount(personal.id, { label: "Personal", useInSearch: false });
    await WhimsyConnectors.setScope(window, personal.id, "drive", false);
    const accounts = await WhimsyConnectors.googleAccounts();
    ok(accounts.find(a => a.id == "google").scopes.find(s => s.id == "drive").on, "Changing Personal's scope leaves Work unchanged");
    ok(WhimsyConnectors._builtinTools(WhimsyConnectors._file).some(t => t.connector == personal.id && t.name.startsWith("gmail_search")), "Use in Search off leaves AI access connected");
    await WhimsyConnectors.connect(window, "google", { accountId: personal.id, scopes: ["gmail", "calendar"] });
    is((await WhimsyConnectors.googleAccounts()).length, 2, "Reauthentication replaces that account rather than adding a duplicate");
    is((await WhimsyConnectors.googleAccounts()).find(a => a.id == personal.id).label, "Personal", "Reauthentication retains the editable label");
    address = "other@example.com";
    await Assert.rejects(WhimsyConnectors.connect(window, "google", { accountId: personal.id }), e => e.code == "failed", "Signing in to another identity cannot replace this account");
    is(WhimsyConnectors._file.connectors[personal.id].account, "personal@example.com", "A mismatched sign-in leaves the existing account intact");
  } finally {
    Object.assign(WhimsyConnectors, restore);
    WhimsyConnectorOAuth.signInProvider = signIn;
  }
});

add_task(async function exiting_aborts_requests_and_discards_late_replies() {
  WhimsyConnectors._file = { connectors: { google: entry("work@example.com") } };
  const search = WhimsyConnectors.searchGoogleAccount;
  let reply;
  let signal;
  WhimsyConnectors.searchGoogleAccount = async (_id, _mode, _query, options) => {
    signal = options.signal;
    return new Promise(resolve => (reply = resolve));
  };
  try {
    gURLBar.focus();
    WhimsyGoogleSearch.enter(window, "mail", "invoice");
    await TestUtils.waitForCondition(() => !!reply, "The explicit mode starts a request");
    const state = WhimsyGoogleSearch.state(window);
    WhimsyGoogleSearch.exit(window, false);
    ok(signal.aborted, "Removing the mode aborts its requests");
    reply([{ id: "late", title: "Private reply", at: 100 }]);
    await TestUtils.waitForCondition(() => !WhimsyGoogleSearch.state(window), "The mode stays closed");
    ok(!state.rows.some(r => r.id == "late"), "A late reply cannot repopulate results after exit");
  } finally {
    reply?.([]);
    WhimsyConnectors.searchGoogleAccount = search;
    WhimsyGoogleSearch.exit(window, false);
    gURLBar.view.close();
  }
});

add_task(async function gmail_tab_reuse_matches_the_account_not_its_index() {
  const { WhimsyTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTabs.sys.mjs");
  const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");
  const match = WhimsyTabs.mailAccountMatches;
  const privateTab = WhimsyAIContext.isPrivate;
  const tab = (url, address, isPrivate = false) => ({ linkedBrowser: { currentURI: { spec: url } }, address, isPrivate });
  const wrong = tab("https://mail.google.com/mail/u/0/", "other@example.com");
  const locked = tab("https://mail.google.com/mail/u/1/", "work@example.com", true);
  const right = tab("https://mail.google.com/mail/u/2/", "work@example.com");
  const explicit = tab("https://mail.google.com/mail/?authuser=personal%40example.com", "");
  WhimsyAIContext.isPrivate = t => t.isPrivate;
  WhimsyTabs.mailAccountMatches = (t, account) => t.address == account;
  try {
    const win = { gBrowser: { tabs: [wrong, locked, right, explicit] } };
    is(WhimsyGoogleSearch.mailTab(win, "work@example.com"), right, "Enter reuses the matching account's Gmail tab, including a numeric account URL");
    is(WhimsyGoogleSearch.mailTab(win, "personal@example.com"), explicit, "An explicit address also identifies the right account");
    ok(!WhimsyGoogleSearch.mailTab(win, "missing@example.com"), "An unrelated open Gmail tab is never reused");
  } finally {
    WhimsyTabs.mailAccountMatches = match;
    WhimsyAIContext.isPrivate = privateTab;
  }
});
