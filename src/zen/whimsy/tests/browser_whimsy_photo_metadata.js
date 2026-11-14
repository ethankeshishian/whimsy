/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W27: Settings › Privacy & Security › "Remove location and camera details
// from photos you upload" (whimsy.privacy.strip-image-metadata, off by
// default). JPEG and PNG photos chosen in a file input or dropped on a page
// lose their Exif, GPS, XMP, and text metadata, losslessly: the image data
// stays byte for byte, and a turned photo keeps only its Orientation.
//
// The fixtures carry everything a phone might leave in a photo:
// - whimsy_photo_meta.jpg: APP0 JFIF; APP1 Exif (Make "WhimsyCam",
//   Orientation 6, GPS latitude); APP2 ICC profile; APP1 XMP with
//   GPSLatitude; APP13 IPTC ("Oakland"); a COM with coordinates.
// - whimsy_photo_meta.png: eXIf (the same Exif), tEXt with coordinates,
//   iTXt XMP, and zTXt "Location".

const { WhimsyImageMetadata, stripJpeg, stripPng, stripImageMetadata, orientationOf } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyImageMetadata.sys.mjs"
);

const PHOTO_ROOT = getRootDirectory(gTestPath);
const PHOTO_PAGE = PHOTO_ROOT.replace("chrome://mochitests/content", "https://example.com") + "whimsy_photo_upload.html";
const PREF = "whimsy.privacy.strip-image-metadata";

let jpeg;
let png;
let photoDir;
let jpegFile;
let pngFile;

async function fixture(name) {
  const response = await fetch(PHOTO_ROOT + name);
  return new Uint8Array(await response.arrayBuffer());
}

function has(bytes, text) {
  const needle = [...text].map(ch => ch.charCodeAt(0));
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] != needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

function same(a, b) {
  return a.length == b.length && a.every((v, i) => v == b[i]);
}

// The JPEG's segments before the image data, and where SOS starts.
function jpegSegments(bytes) {
  const segments = [];
  let pos = 2;
  while (pos < bytes.length) {
    const marker = bytes[pos + 1];
    if (marker == 0xda) {
      return { segments, sos: pos };
    }
    const end = pos + 2 + ((bytes[pos + 2] << 8) | bytes[pos + 3]);
    segments.push({ marker, bytes: bytes.subarray(pos, end) });
    pos = end;
  }
  return { segments, sos: -1 };
}

function pngChunks(bytes) {
  const chunks = [];
  let pos = 8;
  while (pos < bytes.length) {
    const size = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    chunks.push({ type, at: pos, data: bytes.subarray(pos + 8, pos + 8 + size), bytes: bytes.subarray(pos, pos + 12 + size) });
    pos += 12 + size;
  }
  return chunks;
}

add_setup(async function () {
  // Whimsy's upload popup would answer the file input's click first.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.upload-clipboard", false], ["whimsy.feature.photo-metadata", true]] });
  jpeg = await fixture("whimsy_photo_meta.jpg");
  png = await fixture("whimsy_photo_meta.png");
  photoDir = await IOUtils.createUniqueDirectory(PathUtils.profileDir, "whimsy-photo-metadata");
  const jpegPath = PathUtils.join(photoDir, "beach.jpg");
  const pngPath = PathUtils.join(photoDir, "screen.png");
  await IOUtils.write(jpegPath, jpeg);
  await IOUtils.write(pngPath, png);
  jpegFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  jpegFile.initWithPath(jpegPath);
  pngFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  pngFile.initWithPath(pngPath);
  registerCleanupFunction(() => IOUtils.remove(photoDir, { recursive: true }));
});

add_task(async function off_by_default() {
  is(Services.prefs.getDefaultBranch("").getBoolPref(PREF), false, "The setting starts off");
  ok(!WhimsyImageMetadata.enabled, "so nothing is stripped");
});

add_task(function jpeg_loses_its_metadata_and_keeps_its_image() {
  ok(has(jpeg, "WhimsyCam") && has(jpeg, "GPSLatitude") && has(jpeg, "Oakland") && has(jpeg, "37.7749"), "The fixture carries camera, GPS, IPTC, and comment details");
  const out = stripJpeg(jpeg);
  ok(out, "It changes");
  ok(out.length < jpeg.length, "and gets smaller");
  for (const text of ["WhimsyCam", "GPSLatitude", "Photoshop", "Oakland", "37.7749", "http://ns.adobe.com/xap"]) {
    ok(!has(out, text), `"${text}" is gone`);
  }
  const before = jpegSegments(jpeg);
  const after = jpegSegments(out);
  ok(after.sos > 0, "The stripped file still has its image data");
  ok(same(out.subarray(after.sos), jpeg.subarray(before.sos)), "Everything from SOS on is byte-identical");
  const kept = m => before.segments.filter(s => s.marker == m);
  for (const marker of [0xe0, 0xe2, 0xdb, 0xc0, 0xc4]) {
    const original = kept(marker);
    const now = after.segments.filter(s => s.marker == marker);
    is(now.length, original.length, `Marker 0x${marker.toString(16)} is kept`);
    ok(now.every((s, i) => same(s.bytes, original[i].bytes)), `byte for byte (0x${marker.toString(16)})`);
  }
  ok(has(out, "ICC_PROFILE"), "The colour profile stays");
  ok(!after.segments.some(s => s.marker == 0xed || s.marker == 0xfe), "No APP13 or COM is left");
  const app1 = after.segments.filter(s => s.marker == 0xe1);
  is(app1.length, 1, "One APP1 is left");
  ok(has(app1[0].bytes, "Exif\0\0"), "an Exif one");
  is(orientationOf(app1[0].bytes, 10, app1[0].bytes.length), 6, "It keeps Orientation 6, so the photo still shows upright");
  is(app1[0].bytes.length, 36, "and nothing else");
  is(stripJpeg(out), null, "Stripping it again changes nothing");
  is(stripImageMetadata(out), null, "(either way in)");
});

add_task(function png_loses_its_text_and_keeps_its_image() {
  ok(has(png, "37.7749") && has(png, "Location") && has(png, "WhimsyCam"), "The fixture carries text and camera details");
  const out = stripPng(png);
  ok(out, "It changes");
  for (const text of ["WhimsyCam", "37.7749", "Location", "Oakland", "tEXt", "iTXt", "zTXt"]) {
    ok(!has(out, text), `"${text}" is gone`);
  }
  const before = pngChunks(png);
  const after = pngChunks(out);
  Assert.deepEqual(after.map(c => c.type), ["IHDR", "eXIf", "IDAT", "IEND"], "Only the image chunks and a small eXIf stay");
  ok(same(after[0].bytes, before[0].bytes), "IHDR is byte-identical");
  const idat = chunks => chunks.find(c => c.type == "IDAT");
  ok(same(out.subarray(idat(after).at), png.subarray(idat(before).at)), "The image data and IEND are byte-identical");
  const exif = after.find(c => c.type == "eXIf");
  is(orientationOf(exif.data, 0, exif.data.length), 6, "eXIf keeps Orientation 6");
  is(exif.data.length, 26, "and nothing else");
  is(stripPng(out), null, "Stripping it again changes nothing");
});

add_task(function other_files_pass_through() {
  is(stripImageMetadata(new TextEncoder().encode("Not a photo, just some text that is long enough.")), null, "Text isn't touched");
  is(stripImageMetadata(jpeg.subarray(0, 40)), null, "nor a cut-off JPEG");
  is(stripImageMetadata(png.subarray(0, 40)), null, "nor a cut-off PNG");
});

add_task(async function strip_file_follows_the_setting() {
  const file = new File([jpeg], "beach.jpg", { type: "image/jpeg", lastModified: 1700000000000 });
  is(await WhimsyImageMetadata.stripFile(file), file, "With the setting off, the same file comes back");
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  const out = await WhimsyImageMetadata.stripFile(file);
  isnot(out, file, "With it on, a copy comes back");
  is(out.name, "beach.jpg", "with the same name");
  is(out.type, "image/jpeg", "type");
  is(out.lastModified, 1700000000000, "and date");
  ok(same(new Uint8Array(await out.arrayBuffer()), stripJpeg(jpeg)), "without the metadata");
  const text = new File(["hello"], "notes.txt", { type: "text/plain" });
  is(await WhimsyImageMetadata.stripFile(text), text, "Other files come back as they were");
  await SpecialPowers.popPrefEnv();
});

async function received(browser, count) {
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [count], n => content.wrappedJSObject.received.length >= n),
    "The page got the files"
  );
  return SpecialPowers.spawn(browser, [], () => JSON.parse(JSON.stringify(content.wrappedJSObject.received)));
}

async function chooseFiles(browser) {
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  MockFilePicker.setFiles([jpegFile, pngFile]);
  MockFilePicker.returnValue = MockFilePicker.returnOK;
  try {
    await BrowserTestUtils.synthesizeMouseAtCenter("#pick", {}, browser);
    return (await received(browser, 1))[0];
  } finally {
    MockFilePicker.cleanup();
  }
}

add_task(async function file_input_gets_stripped_photos() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PHOTO_PAGE);
  const got = await chooseFiles(tab.linkedBrowser);
  is(got.kind, "change", "The page's change listener ran");
  Assert.deepEqual(got.files.map(f => f.name), ["beach.jpg", "screen.png"], "with both photos, named as chosen");
  ok(same(got.files[0].bytes, stripJpeg(jpeg)), "The JPEG arrived without its metadata");
  ok(same(got.files[1].bytes, stripPng(png)), "and so did the PNG");
  const runs = await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.received.length);
  is(runs, 1, "The page heard change once");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function file_input_untouched_when_off() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PHOTO_PAGE);
  const got = await chooseFiles(tab.linkedBrowser);
  ok(got.trusted, "The browser's own change reached the page");
  ok(same(got.files[0].bytes, jpeg), "The JPEG is byte for byte what was chosen");
  ok(same(got.files[1].bytes, png), "and so is the PNG");
  BrowserTestUtils.removeTab(tab);
});

// A trusted drop of two photos and some text on the page's zone.
async function dropPhotos(browser) {
  await SpecialPowers.spawn(browser, [Array.from(jpeg), Array.from(png)], (jpg, pic) => {
    const zone = content.document.getElementById("zone");
    // The page's own Files, as a real drop from Finder would give it.
    const pageFile = (bytes, name, type) => new content.File([Cu.cloneInto(new Uint8Array(bytes), content)], name, { type });
    const data = new content.DataTransfer();
    data.items.add(pageFile(jpg, "beach.jpg", "image/jpeg"));
    data.items.add(pageFile(pic, "screen.png", "image/png"));
    data.setData("text/plain", "From the beach");
    const drop = new content.DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data });
    content.windowUtils.dispatchDOMEventViaPresShellForTesting(zone, drop);
  });
  return (await received(browser, 1))[0];
}

add_task(async function drop_gets_stripped_photos() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PHOTO_PAGE);
  const got = await dropPhotos(tab.linkedBrowser);
  is(got.kind, "drop", "The page's drop listener ran");
  Assert.deepEqual(got.files.map(f => [f.name, f.type]), [["beach.jpg", "image/jpeg"], ["screen.png", "image/png"]], "with both photos");
  ok(same(got.files[0].bytes, stripJpeg(jpeg)), "The JPEG arrived without its metadata");
  ok(same(got.files[1].bytes, stripPng(png)), "and so did the PNG");
  is(got.text, "From the beach", "The dropped text came along");
  const runs = await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.received.length);
  is(runs, 1, "The page heard the drop once");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function drop_untouched_when_off() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PHOTO_PAGE);
  const got = await dropPhotos(tab.linkedBrowser);
  ok(got.trusted, "The original drop reached the page");
  ok(same(got.files[0].bytes, jpeg), "The JPEG is byte for byte what was dropped");
  ok(same(got.files[1].bytes, png), "and so is the PNG");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function settings_checkbox_turns_it_on() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#privacy");
  const doc = tab.linkedBrowser.contentDocument;
  const box = await TestUtils.waitForCondition(() => {
    const el = doc.getElementById("whimsyStripImageMetadata");
    return el?.checkVisibility() ? el : null;
  }, "Privacy & Security shows the photo checkbox");
  ok(!box.checked, "unchecked by default");
  box.scrollIntoView({ block: "center" });
  box.click();
  await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(PREF, false), "Checking it turns the setting on");
  ok(WhimsyImageMetadata.enabled, "and stripping with it");
  box.click();
  await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref(PREF, true), "Unchecking turns it off");
  BrowserTestUtils.removeTab(tab);
  Services.prefs.clearUserPref(PREF);
});
