/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/small: the changelog shows dev build IDs (1.24b-w3-dev.7) only on
// the Dev channel; release IDs (1.24b-w3) show on both.

const GROUPS = [
  { version: "1.24b-w3-dev.7", date: "2026-10-30", title: "Dev with a title", new: ["One"] },
  { version: "1.24b-w3-dev.6", date: "2026-10-29", new: ["Two"] },
  { version: "1.24b-w3", date: "2026-10-28", title: "Release", new: ["Three"] },
];

async function render(browser) {
  return SpecialPowers.spawn(browser, [GROUPS], async groups => {
    const doc = content.document;
    await ContentTaskUtils.waitForCondition(() => doc.getElementById("whimsy-changelog-list").children.length);
    content.wrappedJSObject.renderChangelog(Cu.cloneInto(groups, content));
    await doc.l10n.translateFragment(doc.getElementById("whimsy-changelog-list"));
    return [...doc.querySelectorAll("#whimsy-changelog-list > .whimsy-changelog-group")].map(build => ({
      id: build.id,
      chip: build.querySelector(".whimsy-changelog-version")?.textContent ?? null,
      title: build.querySelector(".wh-build-title span").textContent,
      label: build.querySelector(".wh-anchor").getAttribute("aria-label"),
    }));
  });
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.home", true]] });
});

add_task(async function test_release_channel_hides_dev_ids() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.update-channel", "release"]] });
  await BrowserTestUtils.withNewTab("about:whimsy?tab=changelog", async browser => {
    const [titled, untitled, release] = await render(browser);
    is(titled.chip, null, "No dev ID chip on Release");
    is(titled.title, "Dev with a title", "The build keeps its title");
    ok(!titled.label.includes("dev."), `Its link doesn't name the ID (${titled.label})`);
    is(untitled.chip, null, "An untitled dev build has no ID chip either");
    is(untitled.title, "Update", "and is headed by a plain word, not its ID");
    ok(!untitled.label.includes("dev."), `nor does its link (${untitled.label})`);
    is(titled.id, "v1-24b-w3-dev-7", "Anchors still work for links people shared");
    is(release.chip, "1.24b-w3", "Release IDs still show");
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_dev_channel_shows_dev_ids() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.update-channel", "dev"]] });
  await BrowserTestUtils.withNewTab("about:whimsy?tab=changelog", async browser => {
    const [titled, untitled, release] = await render(browser);
    is(titled.chip, "1.24b-w3-dev.7", "Dev channel shows the dev ID");
    is(untitled.title, "1.24b-w3-dev.6", "An untitled dev build is headed by its ID");
    is(release.chip, "1.24b-w3", "Release IDs show too");
  });
  await SpecialPowers.popPrefEnv();
});
