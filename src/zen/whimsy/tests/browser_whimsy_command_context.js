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
  const rows = [];
  await provider.startQuery({ maxResults: 8 }, (_, row) => rows.push(row));
  const action = provider.getViewUpdate(rows[0]).action.l10n;
  is(action.id, "whimsy-command-mail-unread", "Mail row advertises unread count");
  is(action.args.count, 12, "Command bar shows the title count");
  const panel = document.getElementById("tab-preview-panel");
  try {
    WhimsyTabs.updateMailHover(window, mail);
    let row = panel.querySelector("#whimsy-mail-unread-preview");
    is(document.l10n.getAttributes(row).args.count, 12, "Hover shows the same count");
    mail.linkedBrowser.contentTitle = "Inbox - Gmail";
    WhimsyTabs.updateMailHover(window, mail);
    row = panel.querySelector("#whimsy-mail-unread-preview");
    is(document.l10n.getAttributes(row).args.count, 0, "Reading mail clears the count");
    WhimsyTabs.updateMailHover(window, mailTab("https://example.com", "(9) Example"));
    ok(!panel.querySelector("#whimsy-mail-unread-preview"), "Next non-mail hover removes the summary");
    for (const url of ["https://mail.google.com.evil.test/", "https://outlook.office.com/calendar/view/month"]) {
      is(WhimsyTabs.mailUnreadCount(mailTab(url, "(7) Page")), null, "Only a mail site gets a summary");
    }
    is(WhimsyTabs.mailUnreadCount(mailTab("https://outlook.office.com/mail/", "(7) Inbox")), 7,
      "Outlook mail is supported");
  } finally {
    panel.querySelector("#whimsy-mail-unread-preview")?.remove();
  }
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
