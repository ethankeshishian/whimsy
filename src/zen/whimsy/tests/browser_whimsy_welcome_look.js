/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// fixC: Zen's onboarding gets two Whimsy pages (transparency, interface
// font) right after the space colors page, built from Zen's own option
// cards, applied live as you pick (whimsy.feature.welcome-look).

const { WhimsyWelcome, TRANSPARENCY_LEVELS } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyWelcome.sys.mjs"
);

const TRANSPARENCY = "whimsy.look.transparency";
const FONT = "whimsy.look.ui-font";

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(TRANSPARENCY);
  Services.prefs.clearUserPref(FONT);
});

// The markup of ZenWelcome.mjs's createOption().
function createOption({ id, group, checked, l10n, text }) {
  const label = document.createElement("label");
  label.className = "zen-welcome-option";
  label.setAttribute("for", id);
  const input = document.createElement("input");
  input.type = "radio";
  input.id = id;
  input.name = group;
  input.checked = !!checked;
  label.appendChild(input);
  const labelText = document.createElement("span");
  labelText.className = "zen-welcome-option-label";
  if (l10n) {
    document.l10n.setAttributes(labelText, l10n);
  } else {
    labelText.textContent = text;
  }
  label.appendChild(labelText);
  return label;
}

const kNextButton = { l10n: "zen-generic-next", primary: true };
const helpers = { createOption, kNextButton };

function zenPages() {
  return ["import", "colors", "search", "block-ads", "essentials", "default-browser", "finish"].map(id => ({ id }));
}

function container() {
  const content = document.createElement("div");
  content.hidden = true;
  document.documentElement.appendChild(content);
  return content;
}

function pick(content, id) {
  const input = content.querySelector(`#${id}`);
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

add_task(async function test_hook_and_order() {
  const source = await (await fetch("chrome://browser/content/zen-components/ZenWelcome.mjs")).text();
  ok(source.includes("WhimsyWelcome.extendPages"), "Zen's onboarding hands its pages to Whimsy");

  const pages = WhimsyWelcome.extendPages(window, zenPages(), helpers);
  const ids = pages.map(page => page.id);
  Assert.deepEqual(
    ids.slice(1, 4),
    ["colors", "whimsy-transparency", "whimsy-font"],
    "Whimsy's pages come right after the space colors"
  );
  is(ids.at(-1), "finish", "Zen's last page stays last");
  for (const page of pages.filter(p => p.id.startsWith("whimsy-"))) {
    ok(page.title && page.descriptions?.length, `${page.id} has a title and a line, like Zen's pages`);
    is(page.buttons[0], kNextButton, `${page.id} uses Zen's Next button`);
  }
  is(WhimsyWelcome.extendPages(window, pages, helpers).length, pages.length, "Never added twice");

  const noColors = WhimsyWelcome.extendPages(window, [{ id: "search" }, { id: "finish" }], helpers);
  Assert.deepEqual(
    noColors.map(page => page.id),
    ["search", "whimsy-transparency", "whimsy-font", "finish"],
    "Without a colors page they go before the last page"
  );
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.welcome-look", false]] });
  const pages = zenPages();
  is(WhimsyWelcome.extendPages(window, pages, helpers), pages, "With the switch off Zen's flow is untouched");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_transparency_page() {
  const page = WhimsyWelcome.extendPages(window, zenPages(), helpers).find(p => p.id == "whimsy-transparency");
  is(page.skip(), AppConstants.platform != "macosx", "Only offered where the desktop can show through");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.transparency", false]] });
  ok(page.skip(), "Skipped when transparency is switched off");
  await SpecialPowers.popPrefEnv();

  const content = container();
  page.render(content);
  is(content.querySelectorAll(".zen-welcome-option").length, TRANSPARENCY_LEVELS.length, "One card per level");
  ok(content.querySelector("#whimsy-welcome-transparency-solid").checked, "Solid (Zen's look) is picked by default");
  await document.l10n.translateFragment(content);
  for (const label of content.querySelectorAll(".zen-welcome-option-label")) {
    ok(label.textContent.trim(), "Each card is labelled");
  }

  pick(content, "whimsy-welcome-transparency-glassy");
  is(Services.prefs.getIntPref(TRANSPARENCY), 45, "Picking applies it at once");
  await TestUtils.waitForCondition(
    () => document.documentElement.hasAttribute("whimsy-transparency"),
    "The window fades live"
  );
  pick(content, "whimsy-welcome-transparency-solid");
  page.commit(content);
  ok(!Services.prefs.prefHasUserValue(TRANSPARENCY), "Back to solid leaves the default");
  content.remove();
});

add_task(async function test_font_page() {
  const page = WhimsyWelcome.extendPages(window, zenPages(), helpers).find(p => p.id == "whimsy-font");
  ok(!page.skip(), "Offered");
  const content = container();
  await page.render(content);
  const inputs = [...content.querySelectorAll("input[name='whimsy-welcome-font']")];
  ok(inputs.length >= 1, "At least the system font");
  is(inputs[0].value, "", "The system font comes first");
  ok(inputs[0].checked, "and is picked by default");
  for (const label of content.querySelectorAll(".zen-welcome-option-label")) {
    ok(label.classList.contains("whimsy-font-preview"), "Each card previews its font");
  }

  const other = inputs.find(input => input.value);
  if (other) {
    pick(content, other.id);
    is(Services.prefs.getStringPref(FONT), other.value, "Picking a font applies it at once");
    await TestUtils.waitForCondition(() => document.documentElement.hasAttribute("whimsy-ui-font"), "The window switches font");
    const label = other.parentElement.querySelector(".zen-welcome-option-label");
    ok(
      getComputedStyle(content.querySelector(".zen-welcome-option-label")).fontFamily.includes("system-ui"),
      "The system card keeps showing the system font while another font is on"
    );
    ok(getComputedStyle(label).fontFamily.includes(other.value), "Its own card shows that font");
    pick(content, inputs[0].id);
    page.commit(content);
    ok(!Services.prefs.prefHasUserValue(FONT), "The system font is the default");
  } else {
    info("None of the bundled font choices are installed here");
  }
  content.remove();

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ui-font", false]] });
  ok(page.skip(), "Skipped when the interface font is switched off");
  await SpecialPowers.popPrefEnv();
});
