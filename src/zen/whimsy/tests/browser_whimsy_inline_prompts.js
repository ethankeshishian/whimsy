/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// wave5/uxfix: naming and setup questions (Split Favorite name, Jira site
// and JQL, Linear team and API key) ask inside the window, in the same sheet
// as Delete Space, instead of a separate system prompt window.

const { WhimsyPanels } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPanels.sys.mjs");
const { WhimsyJiraLiveFolderProvider } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyJiraLiveFolder.sys.mjs"
);

async function answer(asking, { value, accept = true, field = "loginTextbox" }) {
  const win = await BrowserTestUtils.promiseAlertDialogOpen(null);
  ok(window.gDialogBox.isOpen, "The question opens inside the browser window");
  const input = win.document.getElementById(field);
  ok(input.checkVisibility(), `The ${field} field shows`);
  const prefilled = input.value;
  if (value !== undefined) {
    input.value = value;
  }
  win.document.querySelector("dialog").getButton(accept ? "accept" : "cancel").click();
  return { prefilled, result: await asking };
}

add_task(async function ask_returns_text_or_null() {
  let asking = WhimsyPanels.ask(window, { title: "Name", value: "Docs + Mail" });
  let { prefilled, result } = await answer(asking, { value: "Morning" });
  is(prefilled, "Docs + Mail", "The field starts with the suggested name");
  is(result, "Morning", "Accept returns the typed text");

  asking = WhimsyPanels.ask(window, { title: "Name", value: "Docs" });
  ({ result } = await answer(asking, { accept: false }));
  is(result, null, "Cancel returns null");

  asking = WhimsyPanels.ask(window, { title: "Key", password: true });
  ({ result } = await answer(asking, { value: "lin_api_x", field: "password1Textbox" }));
  is(result, "lin_api_x", "Password mode returns the masked field's text");
});

add_task(async function jira_site_asks_in_window() {
  const asking = WhimsyJiraLiveFolderProvider.promptForSite(window, "");
  const { result } = await answer(asking, { value: " https://acme.atlassian.net/ " });
  is(result, "https://acme.atlassian.net", "The site is trimmed and normalized");

  const cancelled = WhimsyJiraLiveFolderProvider.promptForSite(window, "https://a.net");
  is((await answer(cancelled, { accept: false })).result, null, "Cancel creates nothing");
});
