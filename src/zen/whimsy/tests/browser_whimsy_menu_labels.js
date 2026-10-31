/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Every Whimsy menu row has a label. Fluent puts a message's value into
// textContent and only its attributes on the element, so a <menuitem> whose
// message is a plain value ("whimsy-x = New Note") draws an empty row in a
// native macOS menu (the menu-bar extra always is one) and has no
// accessible name. Rows built on demand are built here first.

const { WhimsyNotes } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyNotesSection.sys.mjs");
const { WhimsyVerbs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
const { WhimsyLiveFolders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLiveFolders.sys.mjs");
const { WhimsyMenuBarExtra } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMenuBarExtra.sys.mjs");

const ROWS = "menuitem[data-l10n-id], menu[data-l10n-id], checkbox[data-l10n-id]";

function whimsyRows(root) {
  return [...root.querySelectorAll(ROWS)].filter(el => el.getAttribute("data-l10n-id").startsWith("whimsy-"));
}

async function checkLabels(rows, where) {
  ok(rows.length, `${where}: Whimsy rows to check`);
  const ids = [...new Set(rows.map(el => el.getAttribute("data-l10n-id")))];
  const messages = await document.l10n.formatMessages(ids.map(id => ({ id, args: { count: 1, tabCount: 1, name: "x" } })));
  ids.forEach((id, i) => {
    const label = messages[i]?.attributes?.find(a => a.name == "label")?.value;
    ok(label?.trim(), `${where}: ${id} has a .label ("${label ?? ""}")`);
  });
}

add_task(async function test_rows_built_on_demand() {
  const host = document.createXULElement("menupopup");
  document.getElementById("mainPopupSet").append(host);
  registerCleanupFunction(() => host.remove());

  // Page menu: New Note (W8-42).
  const realContext = window.gContextMenu;
  window.gContextMenu = { isContentSelected: false, onTextInput: false, onEditable: false };
  WhimsyNotes.updateContextMenu(window);
  // Selection menu: the verbs (W8-13).
  window.gContextMenu = {
    isContentSelected: true, onTextInput: false, onEditable: false,
    selectionInfo: { fullText: "1 Infinite Loop, Cupertino CA, Friday 3pm" },
  };
  WhimsyVerbs.updateContextMenu(window);
  window.gContextMenu = realContext;
  const pageRows = ["context-whimsy-new-note", "context-whimsy-verb-map", "context-whimsy-verb-email"]
    .map(id => document.getElementById(id)).filter(Boolean);
  is(pageRows.length, 3, "New Note and the verbs were built");

  // Folder ▸ Live Options: Resync (W8-26).
  // Zen's own Live Options menu (or a stand-in), with its Refresh row.
  let options = document.getElementById("context_zenLiveFolderOptions");
  if (!options) {
    options = document.createXULElement("menu");
    options.id = "context_zenLiveFolderOptions";
    host.append(options);
  }
  let popup = options.querySelector("menupopup");
  if (!popup) {
    popup = document.createXULElement("menupopup");
    options.append(popup);
  }
  const saved = [...popup.childNodes];
  const refresh = document.createXULElement("menuitem");
  refresh.setAttribute("option-key", "refresh");
  popup.replaceChildren(refresh);
  registerCleanupFunction(() => popup.replaceChildren(...saved));
  WhimsyLiveFolders.addResyncMenuItem({ document }, { id: "labels-test" });
  const resync = popup.querySelector('[option-key="whimsyResync"]');
  ok(resync, "Resync was built");

  // The menu-bar extra's popup (a native status-bar menu).
  const extra = document.createXULElement("menupopup");
  host.append(extra);
  WhimsyMenuBarExtra._populate(extra, window);

  await checkLabels([...pageRows, resync, ...whimsyRows(extra)], "Built rows");
  for (const id of ["context-whimsy-new-note", ...["map", "email", "note", "calendar", "linear-new", "linear-search"]
    .map(v => `context-whimsy-verb-${v}`)]) {
    document.getElementById(id)?.remove();
  }
});

add_task(async function test_every_row_in_the_window() {
  await checkLabels(whimsyRows(document), "Window");
});
