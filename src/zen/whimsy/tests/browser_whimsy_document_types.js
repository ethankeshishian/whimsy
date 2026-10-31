/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W8-30: Whimsy registered for Markdown (.md, .markdown), CSV (.csv, .tsv),
// and viewed data types in macOS Finder "Open With" (Info.plist CFBundleDocumentTypes).

// The built app's Info.plist (from whimsy-Info-plist-in.patch), so a patch
// that stops applying fails here.
add_task(async function test_info_plist_document_types() {
  const exe = Services.dirsvc.get("XREExeF", Ci.nsIFile);
  const plistPath = PathUtils.join(exe.parent.parent.path, "Info.plist");
  ok(await IOUtils.exists(plistPath), `The app's Info.plist exists (${plistPath})`);
  const plist = await IOUtils.readUTF8(plistPath);
  for (const ext of ["md", "markdown", "csv", "tsv", "webp", "avif"]) {
    ok(plist.includes(`<string>${ext}</string>`), `Info.plist registers .${ext}`);
  }
  for (const name of ["Markdown Document", "Comma-Separated Values", "Web Image"]) {
    ok(plist.includes(name), `Info.plist names ${name}`);
  }
  ok(plist.includes("<string>whimsy</string>"), "The whimsy: link scheme is still registered");
});

add_task(async function test_view_md_and_csv_files() {
  const tempDir = PathUtils.tempDir;
  const mdPath = PathUtils.join(tempDir, "whimsy_test_doc.md");
  const csvPath = PathUtils.join(tempDir, "whimsy_test_data.csv");

  await IOUtils.writeUTF8(mdPath, "# Whimsy Notes\n\nTesting markdown view.");
  await IOUtils.writeUTF8(csvPath, "name,role,team\nAlice,Engineer,Whimsy\nBob,Designer,Whimsy");

  registerCleanupFunction(async () => {
    await IOUtils.remove(mdPath, { ignoreAbsent: true });
    await IOUtils.remove(csvPath, { ignoreAbsent: true });
  });

  const mdURI = PathUtils.toFileURI(mdPath);
  await BrowserTestUtils.withNewTab(mdURI, async browser => {
    await SpecialPowers.spawn(browser, [], () => {
      ok(content.document.body.textContent.includes("Whimsy Notes"), "Markdown file content rendered");
    });
  });

  const csvURI = PathUtils.toFileURI(csvPath);
  await BrowserTestUtils.withNewTab(csvURI, async browser => {
    await SpecialPowers.spawn(browser, [], () => {
      ok(content.document.body.textContent.includes("Alice,Engineer,Whimsy"), "CSV file content rendered");
    });
  });
});
