/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const DROP_ROOT = getRootDirectory(gTestPath);
const DROP_WEB_ROOT = DROP_ROOT.replace("chrome://mochitests/content", "https://example.com");
const DROP_PAGE = DROP_ROOT + "whimsy_image_drop.html";
const DROP_IMAGE = DROP_WEB_ROOT + "whimsy_image_drop.sjs";
const DROP_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwaDjwHwAFBAKAPJ4DgAAAAABJRU5ErkJggg==";
let dropDirectory;
let imageFile;
let textFile;
const dropStartTabs = new Set(gBrowser.tabs);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.image-drop", true],
    ["browser.tabs.loadInBackground", true],
    ["browser.tabs.insertAfterCurrent", false],
  ] });
  dropDirectory = await IOUtils.createUniqueDirectory(PathUtils.profileDir, "whimsy-image-drop");
  registerCleanupFunction(async () => {
    for (const tab of gBrowser.tabs.filter(t => !dropStartTabs.has(t))) {
      await BrowserTestUtils.removeTab(tab);
    }
    await IOUtils.remove(dropDirectory, { recursive: true });
  });
  const imagePath = PathUtils.join(dropDirectory, "image.PNG");
  const textPath = PathUtils.join(dropDirectory, "ordinary.txt");
  await IOUtils.write(imagePath, Uint8Array.from(atob(DROP_PNG), c => c.charCodeAt(0)));
  await IOUtils.writeUTF8(textPath, "The non-image drop still replaces its page.");
  imageFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  imageFile.initWithPath(imagePath);
  textFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  textFile.initWithPath(textPath);
});

// Use the non-remote chrome fixture for external file drops: this lets the
// EventUtils trusted-event helper reach the actual content-area listener with
// no fabricated source node/principal. The web-image test below also exercises
// real remote drag dispatch and RemoteDropLinks with the mock native service.
async function openFileDropPage() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, DROP_PAGE);
  ok(!tab.linkedBrowser.isRemoteBrowser, "External-drop fixture is non-remote");
  return tab;
}

function dropExternalFile(browser, file) {
  const targetWindow = browser.contentWindow;
  const target = targetWindow.document.getElementById("dropTarget");
  EventUtils.startDragSession(window, "copy");
  try {
    const dt = new DataTransfer();
    dt.mozSetDataAt("application/x-moz-file", file, 0);
    dt.dropEffect = "copy";
    // As in Firefox's browser_drop_link_user_interaction.js, construct trusted
    // drag events directly so mozSourceNode stays null (an external drag).
    for (const type of ["dragover", "drop"]) {
      EventUtils.sendDragEvent(
        EventUtils.createDragEventObject(type, target, targetWindow, dt, {}),
        target,
        targetWindow
      );
    }
  } finally {
    window.windowUtils.dragSession?.endDragSession(true);
  }
}

async function assertImageTab(original, opened, url, beforeCount, originalDocument) {
  is(gBrowser.tabs.length, beforeCount + 1, "Exactly one tab opened");
  is(gBrowser.selectedTab, opened, "Image tab is selected despite background-tab pref");
  is(opened.index, original.index + 1, "Image tab is immediately after the original");
  is(opened.linkedBrowser.currentURI.spec, url, "New tab loaded the image URL");
  is(original.linkedBrowser.currentURI.spec, originalDocument.url, "Original URL is untouched");
  is(original.linkedBrowser.lastLocationChange, originalDocument.locationChange,
    "Original browser did not navigate");
  await SpecialPowers.spawn(original.linkedBrowser, [], () => {
    is(content.document.getElementById("dropTarget").textContent, "Original page stays here.",
      "Original page content is untouched");
    is(content.wrappedJSObject.imageDropMarker, "still here", "Original document survived");
  });
  await SpecialPowers.spawn(opened.linkedBrowser, [], () => {
    ok(content.document.contentType.startsWith("image/"), "New document is an image");
    ok(content.document.querySelector("img")?.naturalWidth > 0, "Image decoded");
  });
}

function originalState(tab) {
  return { url: tab.linkedBrowser.currentURI.spec,
    locationChange: tab.linkedBrowser.lastLocationChange };
}

add_task(async function image_file_opens_next_selected_tab() {
  const original = await openFileDropPage();
  const state = originalState(original);
  const count = gBrowser.tabs.length;
  const url = Services.io.newFileURI(imageFile).spec;
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
  dropExternalFile(original.linkedBrowser, imageFile);
  const imageTab = await opened;
  await assertImageTab(original, imageTab, url, count, state);
  await BrowserTestUtils.removeTab(imageTab);
  await BrowserTestUtils.removeTab(original);
});

async function dragWebImage(imageAsFile) {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.events.dataTransfer.imageAsFile.enabled", imageAsFile]],
  });
  const startTabs = new Set(gBrowser.tabs);
  let sourceWindow;
  try {
    const original = await BrowserTestUtils.openNewForegroundTab(
      gBrowser, DROP_WEB_ROOT + "whimsy_image_drop.html"
    );
    const state = originalState(original);
    // Two visible widgets allow a real cross-document drag with the existing
    // Firefox mock-DND helper, rather than calling droppedLinkHandler directly.
    // Keep the source window unsynced so its tabs and teardown stay separate
    // from the destination window (the option toggles the configured default).
    sourceWindow = await BrowserTestUtils.openNewBrowserWindow({
      zenSyncedWindow: Services.prefs.getBoolPref("zen.window-sync.prefer-unsynced-windows", false),
    });
    await sourceWindow.gZenWorkspaces.promiseInitialized;
    // Zen's empty/startup selection need not have a browser. Open and load an
    // explicit source tab instead of passing selectedBrowser to loadURIString.
    const sourceTab = await BrowserTestUtils.openNewForegroundTab(
      sourceWindow.gBrowser, DROP_WEB_ROOT + "whimsy_image_drop.html"
    );
    const sourceBrowser = sourceTab.linkedBrowser;
    await SpecialPowers.spawn(sourceBrowser, [DROP_IMAGE], async url => {
      const img = content.document.createElement("img");
      img.id = "dragImage";
      img.style.cssText = "width:80px;height:80px";
      img.src = url;
      content.document.body.prepend(img);
      await img.decode();
    });
    const count = gBrowser.tabs.length;
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, DROP_IMAGE, true);
    await EventUtils.synthesizeMockDragAndDrop({
      sourceBrowsingCxt: sourceBrowser.browsingContext,
      targetBrowsingCxt: original.linkedBrowser.browsingContext,
      srcElement: "dragImage",
      targetElement: "dropTarget",
      sourceOffset: [10, 10],
      targetOffset: [10, 10],
      info,
      record: (condition, message) => ok(condition, message),
      dropPromise: opened,
    });
    const imageTab = await opened;
    await assertImageTab(original, imageTab, DROP_IMAGE, count, state);
  } finally {
    try {
      if (sourceWindow && !sourceWindow.closed) {
        await BrowserTestUtils.closeWindow(sourceWindow);
      }
    } finally {
      try {
        // Include an image tab opened before a drag/assertion failure, and the
        // original tab even if opening the source window failed.
        for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
          await BrowserTestUtils.removeTab(tab);
        }
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    }
  }
}

add_task(async function native_image_drag_opens_next_selected_tab() {
  await dragWebImage(false);
});

add_task(async function image_as_file_drag_opens_next_selected_tab() {
  await dragWebImage(true);
});

add_task(async function page_preventing_drop_keeps_it() {
  const original = await openFileDropPage();
  const browser = original.linkedBrowser;
  const state = originalState(original);
  const count = gBrowser.tabs.length;
  const nativeHandler = browser.droppedLinkHandler;
  let nativeCalls = 0;
  browser.droppedLinkHandler = (...args) => {
    nativeCalls++;
    return nativeHandler.apply(browser, args);
  };
  try {
    await SpecialPowers.spawn(browser, [], () => {
      content.addEventListener("dragover", event => event.preventDefault());
      content.addEventListener("drop", event => {
        event.preventDefault();
        content.wrappedJSObject.receivedFile = event.dataTransfer.files[0]?.name;
      });
    });
    dropExternalFile(browser, imageFile);
    await SpecialPowers.spawn(browser, [imageFile.leafName], name => {
      is(content.wrappedJSObject.receivedFile, name, "Page received the image file");
    });
    is(nativeCalls, 0, "preventDefault stops the native navigation path");
    is(gBrowser.tabs.length, count, "No tab opened");
    is(gBrowser.selectedTab, original, "Page stays selected");
    is(browser.lastLocationChange, state.locationChange, "Page did not navigate");
    is(browser.currentURI.spec, state.url, "Page URL is unchanged");
  } finally {
    browser.droppedLinkHandler = nativeHandler;
    await BrowserTestUtils.removeTab(original);
  }
});

async function assertReplacingFileDrop(file) {
  const original = await openFileDropPage();
  const count = gBrowser.tabs.length;
  const url = Services.io.newFileURI(file).spec;
  const loaded = BrowserTestUtils.browserLoaded(original.linkedBrowser, false, url);
  dropExternalFile(original.linkedBrowser, file);
  await loaded;
  is(gBrowser.tabs.length, count, "Drop did not open a tab");
  is(gBrowser.selectedTab, original, "Original tab stays selected");
  is(original.linkedBrowser.currentURI.spec, url, "Drop replaces the original page");
  await BrowserTestUtils.removeTab(original);
}

add_task(async function non_image_file_keeps_native_behavior() {
  await assertReplacingFileDrop(textFile);
});

add_task(async function feature_off_keeps_native_behavior() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.image-drop", false]] });
  try {
    await assertReplacingFileDrop(imageFile);
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});
