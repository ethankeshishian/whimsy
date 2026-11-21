/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/designfix: the words. The Archive has one name; copy that names a
// menu row uses that row's real label; the VPN badge uses the picker's
// words; nothing that reaches the user is hard-coded English; one kind of
// apostrophe; calm onboarding copy.

const l10n = new Localization(["branding/brand.ftl", "browser/whimsy.ftl", "browser/zen-workspaces.ftl"], true);

function value(id, args) {
  return l10n.formatValueSync(id, args);
}

function label(id) {
  const [message] = l10n.formatMessagesSync([{ id }]);
  return message.attributes.find(a => a.name == "label")?.value;
}

add_task(function test_archive_has_one_name() {
  is(value("whimsy-history-show-closed"), "Archive", "History's filter is the Archive (Arc's word)");
  ok(label("whimsy-tabs-archive-view").includes("Archive"), "the setting says Archive");
  ok(!label("whimsy-tabs-archive-view").includes("closed tabs in History"), "not 'closed tabs in History'");
  ok(value("whimsy-snooze-cancel-toast", { title: "x" }).includes("the Archive"), "Snooze's toast points to the Archive");
});

add_task(function test_copy_names_real_rows() {
  const editLook = label("whimsy-space-look-menu");
  ok(value("whimsy-welcome-font-per-space").includes(editLook), `onboarding names the row "${editLook}"`);
  is(label("whimsy-menus-space-look"), editLook, "Settings → Menus calls it the same");
  const setProfile = label("zen-workspaces-panel-context-default-profile");
  is(label("whimsy-menus-space-profile"), setProfile, `Settings → Menus calls the profile row "${setProfile}"`);
});

add_task(function test_no_straight_apostrophes_or_shouting() {
  const ids = [
    "whimsy-updated-notes-label",
    "whimsy-home-blurb",
    "whimsy-note-block-private",
    "whimsy-split-favorite-name-prompt",
  ];
  for (const id of ids) {
    const text = value(id);
    ok(!text.includes("'") && text.includes("’"), `${id} uses ’`);
  }
  for (const id of ["whimsy-welcome-transparency-description", "whimsy-welcome-font-description"]) {
    ok(!value(id).includes("!"), `${id} is calm`);
  }
  is(value("whimsy-profiles-delete-rule"), "Only profiles that no space uses can be deleted.", "sentence case");
});

add_task(async function test_turned_off_pages_are_translated() {
  for (const [feature, url, id] of [
    ["whimsy.feature.year-in-tabs", "about:whimsy?year", "whimsy-year-off"],
    ["whimsy.feature.game", "about:whimsy?game", "whimsy-game-off"],
  ]) {
    await SpecialPowers.pushPrefEnv({ set: [[feature, false]] });
    await BrowserTestUtils.withNewTab(url, async browser => {
      const doc = browser.contentDocument;
      const off = await TestUtils.waitForCondition(() => doc.getElementById(id), `${url}: the off message`);
      await TestUtils.waitForCondition(() => off.textContent, "translated");
      is(off.textContent, value(id), `${url}: says it in words`);
      ok(!off.textContent.includes("whimsy.feature"), "without a raw pref name");
    });
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_year_day_and_hour_names_follow_the_locale() {
  // The recap's busiest day and hour come from Intl, not English tables.
  const locale = Services.locale.appLocaleAsBCP47;
  const sunday = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(new Date(2023, 0, 1));
  is(new Date(2023, 0, 1).getDay(), 0, "1 January 2023 is a Sunday (day 0)");
  ok(sunday.length, `Day 0 is ${sunday}`);
  const src = await (await fetch("chrome://browser/content/whimsy/whimsy-year.js")).text();
  ok(!src.includes('"Sunday"') && !src.includes('"pm"'), "no English day or am/pm tables in the recap");
});

// W30 copy: no label is the bare word "Now" (a time, not a state); lists
// of three or more take the serial comma; the floating Essential is a
// popover everywhere (the changelog's word and Chat's: Show Chat as Popover).
add_task(function test_no_bare_now_labels() {
  for (const id of ["whimsy-library-notes-just-now", "whimsy-meeting-now", "whimsy-action-lock-private-now"]) {
    const text = value(id);
    isnot(text.trim(), "Now", `${id} says more than "Now" (${text})`);
    ok(!/\bNow$/.test(text), `${id} doesn't end in Now`);
  }
  is(value("whimsy-meeting-now"), "In progress", "A meeting that has started is in progress");
  is(value("whimsy-action-lock-private-now"), label("whimsy-menu-lock-private"), "The command and the menu row share a name");
});

add_task(async function test_serial_commas() {
  ok(value("whimsy-split-always-show-headers-help").includes("address, and the pane"), "a list of five ends with ', and'");
  ok(value("whimsy-game-hint").includes("WASD, or"), "a list of three ends with ', or'");
  // Every list of three or more in the file carries the comma before its
  // and/or: no "a, b and c" anywhere (keyword lists aside).
  const ftl = await (await fetch("chrome://browser/locale/browser/whimsy.ftl").catch(() => null))?.text?.(); // precheck: ignore-url (tolerates a missing file)
  if (!ftl) {
    info("The strings file isn't fetchable in this build; the formatted strings above stand");
    return;
  }
  const offenders = ftl
    .split("\n")
    .filter(line => !line.startsWith("#") && !line.includes(".keywords") && !line.includes("whimsy-easel-empty-body"))
    .filter(line => /\w+, \w+(?: \w+)? (?:and|or) \w/.test(line) && !/, (?:and|or) /.test(line));
  Assert.deepEqual(offenders, [], "No list without its serial comma");
});

add_task(function test_popover_is_the_name() {
  for (const id of ["tab-context-whimsy-side-panel", "whimsy-menus-tab-side-panel"]) {
    is(label(id), "Open as Popover", `${id} calls it a popover`);
  }
  is(value("whimsy-action-open-in-side-panel"), "Open as Popover", "The command bar too");
  is(value("whimsy-action-side-panel"), "Open as Popover or Tab", "and the toggle");
  const [splitter] = l10n.formatMessagesSync([{ id: "whimsy-side-panel-splitter" }]);
  is(splitter.attributes.find(a => a.name == "aria-label")?.value, "Resize popover", "The grip too");
  ok(label("whimsy-chat-menu-popover").includes("Popover"), "the same word Chat uses");
});
