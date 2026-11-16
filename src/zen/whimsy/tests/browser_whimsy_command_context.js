/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WhimsyRecentTabsProvider, isDriveDocument } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyRecentTabs.sys.mjs"
);
const { WhimsyTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTabs.sys.mjs");
const { WhimsyNextMeeting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyNextMeeting.sys.mjs");
const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");

function mailTab(url, title) {
  return { label: "Renamed Essential", linkedBrowser: { currentURI: { spec: url }, contentTitle: title },
    getAttribute: () => "" };
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.command-bar-recent-tabs", true],
    ["whimsy.feature.next-meeting", true],
  ] });
});

add_task(async function mail_counts_in_rows_and_hover() {
  const mail = mailTab("https://mail.google.com/mail/u/0/", "Inbox (12) - Gmail");
  is(WhimsyTabs.mailUnreadCount(mail), 12, "Uses the page title of a renamed Essential");
  const provider = new WhimsyRecentTabsProvider();
  provider.tabs = () => [mail];
  provider.meeting = () => null;
  provider.drives = async () => [];
  // W29/cmdrecent: closed/synced read real state; stub them out so this
  // test's row list is deterministic regardless of what else the suite
  // has closed or synced.
  provider.closed = () => [];
  provider.synced = async () => [];
  const rows = [];
  await provider.startQuery({ maxResults: 8 }, (_, row) => rows.push(row));
  const action = provider.getViewUpdate(rows[0]).action.l10n;
  is(action.id, "whimsy-command-mail-unread", "Mail row advertises unread count");
  is(action.args.count, 12, "Command bar shows the title count");
  // W29: the count moved from the disabled #tab-preview-panel hook into the
  // tab hover card itself (browser_whimsy_hover_cards.js covers that card).
  mail.linkedBrowser.contentTitle = "Inbox - Gmail";
  is(WhimsyTabs.mailUnreadCount(mail), 0, "Reading mail clears the count");
  for (const url of ["https://mail.google.com.evil.test/", "https://outlook.office.com/calendar/view/month"]) {
    is(WhimsyTabs.mailUnreadCount(mailTab(url, "(7) Page")), null, "Only a mail site gets a summary");
  }
  is(WhimsyTabs.mailUnreadCount(mailTab("https://outlook.office.com/mail/", "(7) Inbox")), 7,
    "Outlook mail is supported");
});

add_task(function meeting_uses_shared_timing_window() {
  const provider = new WhimsyRecentTabsProvider();
  const saved = WhimsyNextMeeting._sources;
  const now = Date.now();
  const event = { title: "Standup", start: now + 12 * 60000, end: now + 60 * 60000,
    location: "https://meet.google.com/aaa-bbbb-ccc" };
  WhimsyNextMeeting._sources = new Map([["command-test", { events: [event] }]]);
  try {
    is(provider.meeting({}).title, event.title, "Meeting twelve minutes away is offered");
    ok(WhimsyNextMeeting.soonMeeting(event.start - 15 * 60000, { joinable: true }), "Includes fifteen minutes before");
    is(WhimsyNextMeeting.soonMeeting(event.start - 15 * 60000 - 1, { joinable: true }), null,
      "Excludes earlier meetings");
    ok(WhimsyNextMeeting.soonMeeting(event.start + 10 * 60000, { joinable: true }), "Includes ten minutes after");
    is(WhimsyNextMeeting.soonMeeting(event.start + 10 * 60000 + 1, { joinable: true }), null,
      "Excludes later meetings");
    event.location = "Room 3";
    ok(!provider.meeting({}), "A meeting without a call link gets no Join row");
  } finally {
    WhimsyNextMeeting._sources = saved;
  }
});

add_task(async function meeting_first_then_tabs_then_documents() {
  const provider = new WhimsyRecentTabsProvider();
  const meeting = { title: "Design review", start: Date.now() + 12 * 60000,
    join: { url: "https://meet.google.com/aaa-bbbb-ccc" } };
  provider.meeting = () => meeting;
  provider.tabs = () => [mailTab("https://mail.google.com/", "Inbox (3) - Gmail")];
  provider.drives = async () => [{ title: "Notes", url: "https://docs.google.com/document/d/notes/edit" },
    { title: "Budget", url: "https://docs.google.com/spreadsheets/d/budget/edit" }];
  provider.closed = () => [];
  provider.synced = async () => [];
  const context = { searchString: "", maxResults: 8 };
  const rows = [];
  await provider.startQuery(context, (_, row) => rows.push(row));
  Assert.deepEqual(rows.map(row => row.payload.kind), ["meeting", "tab", "drive", "drive"], "Section order");
  ok(provider.getViewUpdate(rows[0]).action.l10n.args.until, "Meeting includes relative start time");
  const join = WhimsyNextMeeting.join;
  let joined = null;
  WhimsyNextMeeting.join = (_win, event) => { joined = event; };
  try {
    provider.onEngagement(context, null, { result: rows[0] });
    is(joined, meeting, "Enter joins the displayed meeting");
    joined = null;
    provider.meeting = () => null;
    provider.onEngagement(context, null, { result: rows[0] });
    is(joined, null, "An expired meeting cannot be joined from its stale row");
  } finally {
    WhimsyNextMeeting.join = join;
  }
  const limited = [];
  await provider.startQuery({ ...context, maxResults: 2 }, (_, row) => limited.push(row));
  is(limited.length, 2, "Respects the query result budget");
});

add_task(async function drive_history_and_private_boundary() {
  const urls = [
    "https://docs.google.com/document/d/whimsy-context-old/edit",
    "https://www.dropbox.com/scl/fi/whimsy-context-new/notes.txt",
    "https://onedrive.live.com/?id=whimsy-context-newest",
  ];
  const home = "https://drive.google.com/drive/u/0/home?whimsy-context";
  const provider = new WhimsyRecentTabsProvider();
  try {
    for (const [i, url] of [...urls, home].entries()) {
      await PlacesUtils.history.insert({ url, title: `Context document ${i}`,
        visits: [{ date: new Date(Date.now() - (4 - i) * 1000) }] });
    }
    const docs = await provider.drives({});
    Assert.deepEqual(docs.map(doc => doc.url), [urls[2], urls[1]], "Two latest documents, excluding the drive home");
    Assert.deepEqual(await provider.drives({ isPrivate: true }), [], "No profile history in a private query");
    ok(!provider.meeting({ isPrivate: true }), "No profile meeting in a private query");
    provider.tabs = () => [];
    provider.meeting = () => null;
    ok(await provider.isActive({ searchString: "" }), "History alone activates the provider");
    ok(!await provider.isActive({ searchString: "", isPrivate: true }), "Private query remains empty");
    ok(!await provider.isActive({ searchString: "notes" }), "Typing retains normal search");
    ok(!await provider.isActive({ searchString: "", searchMode: {} }), "Search mode retains normal search");
    for (const url of ["https://docs.google.com.evil.test/document/d/a", "http://docs.google.com/document/d/a",
      "https://docs.google.com/", "https://www.dropbox.com/home"]) {
      ok(!isDriveDocument(url), `Not a document: ${url}`);
    }
  } finally {
    await PlacesUtils.history.remove([...urls, home]);
  }
});

add_task(async function cancelled_history_read_emits_nothing() {
  const provider = new WhimsyRecentTabsProvider();
  provider.tabs = () => [];
  provider.meeting = () => null;
  let finish;
  provider.drives = () => new Promise(resolve => { finish = resolve; });
  const rows = [];
  const query = provider.startQuery({}, (_, row) => rows.push(row));
  provider.cancelQuery();
  finish([{ title: "Notes", url: "https://docs.google.com/document/d/notes/edit" }]);
  await query;
  is(rows.length, 0, "Cancelled query cannot repopulate the view after history resolves");
});

// W29/cmdrecent: Recently Closed and Synced Tabs join the empty command bar,
// after everything that's already there (R.1: nothing that's there today
// moves).

add_task(function private_context_has_no_recently_closed_rows() {
  const provider = new WhimsyRecentTabsProvider();
  Assert.deepEqual(provider.closed(window, { isPrivate: true }), [],
    "A private query never reads closed-tab history, in Private Browsing too");
});

add_task(async function private_context_has_no_synced_rows() {
  const provider = new WhimsyRecentTabsProvider();
  Assert.deepEqual(await provider.synced({ isPrivate: true }), [],
    "A private query never reads Sync state either");
});

add_task(async function closed_tab_reopens_in_place_with_back_history() {
  const provider = new WhimsyRecentTabsProvider();
  provider.tabs = () => [];
  provider.meeting = () => null;
  provider.drives = async () => [];
  provider.synced = async () => [];

  const first = "https://example.com/?closed-history=1";
  const second = "https://example.com/?closed-history=2";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, first);
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, second);
  await loaded;
  const tabCount = gBrowser.tabs.length;
  BrowserTestUtils.removeTab(tab);

  const rows = [];
  await provider.startQuery({ searchString: "", maxResults: 11 }, (_, row) => rows.push(row));
  const closedRow = rows.find(row => row.payload.kind == "closed");
  ok(closedRow, "A Recently Closed row appears for the tab just closed");
  is(closedRow.rowLabel.id, "whimsy-command-recently-closed", "Section: Recently Closed");
  const action = provider.getViewUpdate(closedRow).action.l10n;
  is(action.id, "whimsy-command-reopen-tab", "Action: Reopen Tab");
  ok(action.args.ago, "Names how long ago it closed");

  provider.onEngagement({}, null, { result: closedRow });
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == tabCount, "Reopens, back to the same tab count");
  const reopened = gBrowser.selectedTab;
  await TestUtils.waitForCondition(
    () => reopened.linkedBrowser.currentURI.spec == second,
    "Reopens on the page it was showing when it closed"
  );
  reopened.linkedBrowser.goBack();
  await TestUtils.waitForCondition(
    () => reopened.linkedBrowser.currentURI.spec == first,
    "Its back history survived the close/reopen round trip"
  );
  BrowserTestUtils.removeTab(reopened);
});

add_task(async function synced_tab_opens_in_a_new_tab() {
  const provider = new WhimsyRecentTabsProvider();
  provider.tabs = () => [];
  provider.meeting = () => null;
  provider.drives = async () => [];
  provider.closed = () => [];
  provider.synced = async () => [
    { url: "https://example.com/?synced=1", title: "Synced Example", device: "Ethan's iPhone", icon: "" },
  ];

  const rows = [];
  await provider.startQuery({ searchString: "", maxResults: 11 }, (_, row) => rows.push(row));
  const syncedRow = rows.find(row => row.payload.kind == "synced");
  ok(syncedRow, "A Synced Tabs row appears");
  is(syncedRow.rowLabel.id, "whimsy-command-synced-tabs", "Section: Synced Tabs");
  const action = provider.getViewUpdate(syncedRow).action.l10n;
  is(action.id, "whimsy-command-open-tab", "Action: Open Tab");
  is(action.args.device, "Ethan's iPhone", "The detail names the device, not a generic label");

  const tabCount = gBrowser.tabs.length;
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.com/?synced=1", true);
  provider.onEngagement({}, null, { result: syncedRow });
  const tab = await opened;
  is(gBrowser.tabs.length, tabCount + 1, "Opens in a new tab, not in place");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function new_sections_land_after_everything_already_there() {
  const provider = new WhimsyRecentTabsProvider();
  const meeting = { title: "Standup", start: Date.now() + 5 * 60000, join: { url: "https://meet.google.com/zzz-order" } };
  provider.meeting = () => meeting;
  provider.tabs = () => [mailTab("https://mail.google.com/?order", "Inbox (1) - Gmail")];
  provider.drives = async () => [{ title: "Notes", url: "https://docs.google.com/document/d/order-notes/edit" }];
  provider.closed = () => [{ closedId: 999999, title: "Closed Example", closedAt: Date.now() - 4 * 60000, image: "" }];
  provider.synced = async () => [
    { url: "https://example.com/?synced=order", title: "Synced", device: "Work Laptop", icon: "" },
  ];
  const rows = [];
  await provider.startQuery({ searchString: "", maxResults: 11 }, (_, row) => rows.push(row));
  Assert.deepEqual(
    rows.map(row => row.payload.kind),
    ["meeting", "tab", "drive", "closed", "synced"],
    "Recently Closed and Synced Tabs land after the meeting, tabs, and documents that are already there; nothing moves"
  );
});

add_task(async function setting_label_covers_all_three_sections() {
  const l10n = new Localization(["browser/whimsy.ftl"], true);
  const [message] = await l10n.formatMessages([{ id: "whimsy-command-recent-tabs-toggle" }]);
  is(
    message.attributes.find(a => a.name == "label").value,
    "Show recent, closed, and synced tabs when the command bar opens empty",
    "The one switch's label now covers all three sections; the pref itself is unchanged"
  );
});
