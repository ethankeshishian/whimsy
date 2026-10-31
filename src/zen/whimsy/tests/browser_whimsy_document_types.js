/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W8-30: Whimsy registered for Markdown (.md, .markdown), CSV (.csv, .tsv),
// and viewed data types in macOS Finder "Open With" (Info.plist CFBundleDocumentTypes).

add_task(async function test_info_plist_patch_document_types() {
  const patchPath = PathUtils.join(
    Services.dirsvc.get("CurWorkD", Ci.nsIFile).path,
    "src/browser/app/macbuild/Contents/whimsy-Info-plist-in.patch"
  );
  ok(await IOUtils.exists(patchPath), "Info.plist patch exists");

  const patchText = await IOUtils.readUTF8(patchPath);
  for (const ext of ["md", "markdown", "csv", "tsv", "webp", "avif", "xml", "yaml", "yml"]) {
    ok(patchText.includes(`<string>${ext}</string>`), `Patch registers .${ext} extension`);
  }
  ok(patchText.includes("Markdown Document"), "Registers Markdown Document type");
  ok(patchText.includes("Comma-Separated Values"), "Registers Comma-Separated Values type");
  ok(patchText.includes("Web Image"), "Registers Web Image type");
  ok(patchText.includes("Data Document"), "Registers Data Document type");
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
