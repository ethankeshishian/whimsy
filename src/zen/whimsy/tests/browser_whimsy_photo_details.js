/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29: choose which photo details to remove. Settings › Privacy & Security
// › "Remove details from photos you upload" has four kinds (Location,
// Camera and device, Date and time taken, Everything else) and "Ask before
// each upload"; the "Remove photo details?" sheet asks per upload, from a
// file input, a drop, or Cmd+V. Every format removes the same kinds, keeps
// Orientation and the colour profile, and never changes the image data.
//
// The photos are built by whimsy_photo_builders.js, each carrying the same
// details in every place its format keeps them (see PHOTO_DETAILS there).

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "whimsy_photo_builders.js", this);

const { WhimsyImageMetadata, stripImageMetadata, inspectImageMetadata, formatOf } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyImageMetadata.sys.mjs"
);
const { WhimsyUploadParent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUploadParent.sys.mjs");

const PHOTO_ROOT = getRootDirectory(gTestPath);
const PHOTO_PAGE = PHOTO_ROOT.replace("chrome://mochitests/content", "https://example.com") + "whimsy_photo_upload.html";
const PREF = "whimsy.privacy.strip-image-metadata";
const KINDS = ["location", "camera", "date", "other"];
const SETTINGS_DEFAULT = { location: true, camera: true, date: false, other: true };

const PHOTOS = {
  jpeg: () => photoJpeg(),
  "multi-picture jpeg": () => photoMpf(),
  png: () => photoPng(),
  webp: () => photoWebp(),
  gif: () => photoGif(),
  tiff: () => photoTiff(),
  "big-endian tiff": () => photoTiff(false),
  heic: () => photoHeif("heic"),
  avif: () => photoHeif("avif"),
  jxl: () => photoJxl(),
};

// What must survive every strip: the image itself and its colour profile.
const IMAGE = ["PIXELDATA", "SCANDATA", "GAINMAP", "ICCDATA-PROFILE"];

function same(a, b) {
  return !!a && !!b && a.length == b.length && a.every((v, i) => v == b[i]);
}

function only(kind) {
  return Object.fromEntries(KINDS.map(k => [k, k == kind]));
}

// The details of each kind the photo carries.
function detailsIn(bytes) {
  return Object.fromEntries(KINDS.map(k => [k, PHOTO_DETAILS[k].filter(text => hasText(bytes, text))]));
}

add_task(function every_format_carries_every_kind() {
  for (const [name, build] of Object.entries(PHOTOS)) {
    const bytes = build();
    ok(formatOf(bytes), `${name} is a format Whimsy reads (${formatOf(bytes)})`);
    const found = inspectImageMetadata(bytes);
    Assert.deepEqual(KINDS.filter(k => found.has(k)), KINDS, `${name} has details of all four kinds`);
    for (const kind of KINDS) {
      ok(detailsIn(bytes)[kind].length, `${name} carries ${kind} details`);
    }
  }
});

add_task(function each_kind_goes_alone_in_each_format() {
  for (const [name, build] of Object.entries(PHOTOS)) {
    const bytes = build();
    const before = detailsIn(bytes);
    for (const kind of KINDS) {
      const out = stripImageMetadata(bytes, only(kind));
      ok(out, `${name}: removing ${kind} changes it`);
      if (!out) {
        continue;
      }
      const after = detailsIn(out);
      Assert.deepEqual(after[kind], [], `${name}: no ${kind} detail is left`);
      for (const other of KINDS.filter(k => k != kind)) {
        Assert.deepEqual(after[other], before[other], `${name}: removing ${kind} keeps every ${other} detail`);
      }
      for (const text of IMAGE.filter(t => hasText(bytes, t))) {
        ok(hasText(out, text), `${name}: removing ${kind} keeps ${text}`);
      }
      is(orientationIn(out), orientationIn(bytes), `${name}: removing ${kind} keeps the Orientation`);
      ok(!inspectImageMetadata(out).has(kind), `${name}: it no longer reports ${kind}`);
      is(stripImageMetadata(out, only(kind)), null, `${name}: removing ${kind} again changes nothing`);
    }
  }
});

add_task(function all_kinds_leave_only_the_image() {
  for (const [name, build] of Object.entries(PHOTOS)) {
    const bytes = build();
    const out = stripImageMetadata(bytes);
    ok(out, `${name}: removing everything changes it`);
    Assert.deepEqual(Object.values(detailsIn(out)).flat(), [], `${name}: no detail is left`);
    ok(!hasText(out, "THUMBDATA"), `${name}: the Exif thumbnail is gone`);
    is(inspectImageMetadata(out).size, 0, `${name}: nothing is reported`);
    is(orientationIn(out), orientationIn(bytes), `${name}: the Orientation stays (${orientationIn(bytes)})`);
    for (const text of ["PIXELDATA", "SCANDATA", "ICCDATA-PROFILE"].filter(t => hasText(bytes, t))) {
      ok(hasText(out, text), `${name}: ${text} stays`);
    }
    Assert.deepEqual(stripImageMetadata(out), null, `${name}: stripping again changes nothing`);
    ok(same(stripImageMetadata(bytes, { location: true, camera: true, date: true, other: true }), out), `${name}: all four ticked is the same as everything`);
  }
});

add_task(function thumbnails_go_with_location_camera_and_everything_else() {
  const bytes = photoJpeg();
  ok(hasText(bytes, "THUMBDATA"), "The JPEG has an Exif thumbnail");
  for (const kind of ["location", "camera", "other"]) {
    ok(!hasText(stripImageMetadata(bytes, only(kind)), "THUMBDATA"), `It goes with ${kind}`);
  }
  ok(hasText(stripImageMetadata(bytes, only("date")), "THUMBDATA"), "but stays when only the date goes");
});

add_task(function image_data_is_unchanged() {
  // JPEG: everything from the first SOS on.
  const jpeg = photoJpeg();
  const sos = bytes => bytes.findIndex((b, i) => b == 0xff && bytes[i + 1] == 0xda);
  for (const kind of KINDS) {
    const out = stripImageMetadata(jpeg, only(kind));
    ok(same(out.subarray(sos(out)), jpeg.subarray(sos(jpeg))), `JPEG (${kind}): the scan data is byte for byte the same`);
  }
  // HEIF and AVIF are rewritten in place: same length, every byte outside
  // the Exif and XMP items the same.
  for (const brand of ["heic", "avif"]) {
    const bytes = photoHeif(brand);
    for (const kind of KINDS) {
      const out = stripImageMetadata(bytes, only(kind));
      is(out.length, bytes.length, `${brand} (${kind}): the file keeps its length, so every offset holds`);
      const pixels = findBytes(bytes, new TextEncoder().encode("PIXELDATA"));
      is(findBytes(out, new TextEncoder().encode("PIXELDATA")), pixels, `${brand} (${kind}): the image item hasn't moved`);
      const mdat = findBytes(bytes, new TextEncoder().encode("mdat"));
      ok(same(out.subarray(0, mdat), bytes.subarray(0, mdat)), `${brand} (${kind}): ftyp and meta are the same`);
    }
  }
});

add_task(function multi_picture_jpeg_keeps_its_gain_map_unless_everything_else_goes() {
  const bytes = photoMpf();
  ok(hasText(bytes, "GAINMAP"), "The photo has a second image (an HDR gain map)");
  for (const kind of ["location", "camera", "date"]) {
    const out = stripImageMetadata(bytes, only(kind));
    ok(hasText(out, "GAINMAP"), `Removing ${kind} keeps the gain map`);
    ok(hasText(out, "MPF\0"), "and its index");
    Assert.deepEqual(detailsIn(out)[kind], [], `with no ${kind} detail in either image`);
  }
  const located = stripImageMetadata(bytes, only("location"));
  ok(hasText(located, "WhimsyCam"), "The second image keeps its camera details when only location goes");
  ok(!hasText(located, "GPSAREA"), "and loses its GPS");
  const out = stripImageMetadata(bytes, only("other"));
  ok(!hasText(out, "GAINMAP") && !hasText(out, "MPF\0"), "Everything else takes the second image and its index");
});

add_task(function iptc_keeps_what_isnt_removed() {
  const bytes = photoJpeg();
  const out = stripImageMetadata(bytes, only("other"));
  ok(!hasText(out, "IptcCaptionText"), "The IPTC caption goes with everything else");
  ok(hasText(out, "IptcCityOakland") && hasText(out, "IptcProgApp") && hasText(out, "20220303"), "while its city, program, and date stay");
  ok(hasText(stripImageMetadata(bytes, only("location")), "IptcCaptionText"), "Removing location keeps the caption");
});

add_task(function unsupported_files_pass_through() {
  // BigTIFF (and DNG, a TIFF with raw data) can't be rewritten safely.
  const big = new Uint8Array([0x49, 0x49, 0x2b, 0, 8, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, ...new TextEncoder().encode("WhimsyCam GPS")]);
  is(stripImageMetadata(big), null, "A BigTIFF passes through untouched");
  const truncated = photoHeif("heic").subarray(0, 200);
  is(stripImageMetadata(truncated), null, "A cut-off HEIC passes through");
  is(stripImageMetadata(photoGif().subarray(0, 40)), null, "A cut-off GIF passes through");
  is(stripImageMetadata(photoWebp().subarray(0, 30)), null, "A cut-off WebP passes through");
  is(stripImageMetadata(photoJxl().subarray(0, 30)), null, "A cut-off JPEG XL passes through");
});

add_task(async function inspect_counts_photos_per_kind() {
  const files = [
    new File([photoJpeg()], "a.jpg", { type: "image/jpeg" }),
    new File([photoJpeg({ exif: null, xmp: false, iptc: false })], "b.jpg", { type: "image/jpeg" }),
    new File([photoPng()], "c.png", { type: "image/png" }),
    new File(["notes"], "d.txt", { type: "text/plain" }),
  ];
  const scan = await WhimsyImageMetadata.inspectFiles(files);
  is(scan.count, 3, "Three files carry details (one only a comment)");
  Assert.deepEqual(scan.kinds, { location: 2, camera: 2, date: 2, other: 3 }, "counted per kind");
  for (const ext of ["heic", "heif", "avif", "webp", "gif", "tif", "tiff", "jxl"]) {
    ok(WhimsyImageMetadata.candidate(new File([photoJpeg()], `x.${ext}`)), `A .${ext} file is looked at`);
  }
});

add_task(async function files_to_upload_follows_settings_or_the_sheet() {
  const file = new File([photoJpeg()], "a.jpg", { type: "image/jpeg", lastModified: 1700000000000 });
  const bytes = async f => new Uint8Array(await f.arrayBuffer());
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true], [`${PREF}.ask`, false]] });
  try {
    let [out] = await WhimsyImageMetadata.filesToUpload([file]);
    ok(same(await bytes(out), stripImageMetadata(photoJpeg(), SETTINGS_DEFAULT)), "Without asking, Settings' kinds go (date stays)");
    is(out.name, "a.jpg", "under the same name");
    is(out.lastModified, 1700000000000, "and date");
    await SpecialPowers.pushPrefEnv({ set: [[`${PREF}.date`, true], [`${PREF}.other`, false]] });
    [out] = await WhimsyImageMetadata.filesToUpload([file]);
    ok(same(await bytes(out), stripImageMetadata(photoJpeg(), { location: true, camera: true, date: true, other: false })), "Ticking Date and unticking Everything else changes what goes");
    await SpecialPowers.popPrefEnv();
    let asked = 0;
    [out] = await WhimsyImageMetadata.filesToUpload([file], null, () => asked++);
    is(asked, 0, "With Ask off, nothing asks");
    await SpecialPowers.pushPrefEnv({ set: [[`${PREF}.ask`, true]] });
    let question = null;
    [out] = await WhimsyImageMetadata.filesToUpload([file], null, q => {
      question = q;
      return only("location");
    });
    Assert.deepEqual(question, { count: 1, kinds: { location: 1, camera: 1, date: 1, other: 1 } }, "With Ask on, the sheet is asked");
    ok(same(await bytes(out), stripImageMetadata(photoJpeg(), only("location"))), "and its answer decides, for this upload");
    [out] = await WhimsyImageMetadata.filesToUpload([file], null, () => ({ location: false, camera: false, date: false, other: false }));
    is(out, file, "Nothing ticked uploads the original");
    is(await WhimsyImageMetadata.filesToUpload([file], null, () => null), null, "A cancelled sheet cancels the upload");
    const text = new File(["notes"], "notes.txt", { type: "text/plain" });
    asked = 0;
    Assert.deepEqual(await WhimsyImageMetadata.filesToUpload([text], null, () => asked++), [text], "A file with no details goes as it is");
    is(asked, 0, "without asking");
    await SpecialPowers.popPrefEnv();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

// ---------------------------------------------------------------------------
// The sheet

function sheetShown() {
  return BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-photo-details");
}

function sheetRows() {
  const panel = document.getElementById("whimsy-photo-details");
  return Object.fromEntries(KINDS.map(k => [k, panel.querySelector(`#whimsy-photo-details-${k}`)]));
}

async function press(id) {
  const hidden = BrowserTestUtils.waitForEvent(document.getElementById("whimsy-photo-details"), "popuphidden");
  EventUtils.synthesizeMouseAtCenter(document.getElementById(id), {});
  await hidden;
}

add_task(async function sheet_shows_what_the_photos_carry() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  try {
    const shown = sheetShown();
    const answer = WhimsyUploadParent.askDetails(window, { count: 3, kinds: { location: 2, camera: 3, date: 0, other: 1 } });
    await shown;
    const panel = document.getElementById("whimsy-photo-details");
    await TestUtils.waitForCondition(() => panel.querySelector(".whimsy-photo-details-text")?.textContent, "The summary is filled in");
    const rows = sheetRows();
    Assert.deepEqual(
      KINDS.map(k => rows[k].closest(".whimsy-photo-details-row").dataset.kind),
      KINDS,
      "Four rows, in a fixed order"
    );
    Assert.deepEqual(KINDS.map(k => rows[k].checked), [true, true, false, true], "Ticked as in Settings, where a photo has it");
    ok(rows.date.disabled, "A kind no photo has is greyed out");
    const note = k => panel.querySelector(`#whimsy-photo-details-${k}-count`);
    Assert.deepEqual(
      KINDS.map(k => document.l10n.getAttributes(note(k)).id),
      ["whimsy-photo-details-count", "whimsy-photo-details-count", "whimsy-photo-details-none", "whimsy-photo-details-count"],
      "Each row says how many photos have it"
    );
    Assert.deepEqual(
      ["location", "camera", "other"].map(k => document.l10n.getAttributes(note(k)).args.count),
      [2, 3, 1],
      "(2, 3, and 1)"
    );
    is(rows.location.getAttribute("aria-describedby"), note("location").id, "and the count describes the row");
    is(document.activeElement, rows.location, "The first row has focus");
    EventUtils.synthesizeKey("KEY_ArrowDown");
    is(document.activeElement, rows.camera, "Down moves to the next row");
    EventUtils.synthesizeKey("KEY_ArrowDown");
    is(document.activeElement, rows.other, "skipping the greyed-out one");
    const upload = document.getElementById("whimsy-photo-details-upload");
    is(document.l10n.getAttributes(upload).id, "whimsy-photo-details-upload", "The button says Upload");
    for (const k of ["location", "camera", "other"]) {
      EventUtils.synthesizeMouseAtCenter(rows[k], {});
    }
    is(document.l10n.getAttributes(upload).id, "whimsy-photo-details-upload-as-is", "With nothing ticked it says Upload as is");
    EventUtils.synthesizeMouseAtCenter(rows.camera, {});
    is(document.l10n.getAttributes(upload).id, "whimsy-photo-details-upload", "and Upload again once something is");
    await press("whimsy-photo-details-upload");
    Assert.deepEqual(await answer, { location: false, camera: true, date: false, other: false }, "Upload answers with the ticked kinds");
    is(Services.prefs.getBoolPref(`${PREF}.location`), true, "and Settings don't change");

    let next = sheetShown();
    let again = WhimsyUploadParent.askDetails(window, { count: 1, kinds: { location: 1, camera: 0, date: 0, other: 0 } });
    await next;
    await press("whimsy-photo-details-cancel");
    is(await again, null, "Cancel cancels");

    next = sheetShown();
    again = WhimsyUploadParent.askDetails(window, { count: 1, kinds: { location: 1, camera: 0, date: 0, other: 0 } });
    await next;
    const hidden = BrowserTestUtils.waitForEvent(document.getElementById("whimsy-photo-details"), "popuphidden");
    EventUtils.synthesizeKey("KEY_Escape");
    await hidden;
    is(await again, null, "and so does Esc");

    next = sheetShown();
    again = WhimsyUploadParent.askDetails(window, { count: 1, kinds: { location: 1, camera: 0, date: 0, other: 0 } });
    await next;
    const gone = BrowserTestUtils.waitForEvent(document.getElementById("whimsy-photo-details"), "popuphidden");
    EventUtils.synthesizeKey("KEY_Enter");
    await gone;
    Assert.deepEqual(await again, only("location"), "Return uploads");
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

// ---------------------------------------------------------------------------
// In a page: a file input, a drop, and Cmd+V

let photoDir;
let jpegFile;
let pngFile;
let jpegPath;

add_task(async function setup_photo_files() {
  photoDir = await IOUtils.createUniqueDirectory(PathUtils.profileDir, "whimsy-photo-details");
  jpegPath = PathUtils.join(photoDir, "beach.jpg");
  const pngPath = PathUtils.join(photoDir, "screen.png");
  await IOUtils.write(jpegPath, photoJpeg());
  await IOUtils.write(pngPath, photoPng());
  const local = path => {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file;
  };
  jpegFile = local(jpegPath);
  pngFile = local(pngPath);
  registerCleanupFunction(() => IOUtils.remove(photoDir, { recursive: true }));
});

async function withPhotoPage(prefs, task) {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true], [`${PREF}.ask`, true], ["whimsy.feature.photo-metadata", true], ...prefs] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PHOTO_PAGE);
  try {
    await task(tab.linkedBrowser);
  } finally {
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
}

function pageState(browser) {
  return SpecialPowers.spawn(browser, [], () => ({
    received: JSON.parse(JSON.stringify(content.wrappedJSObject.received)),
    files: content.document.getElementById("pick").files.length,
  }));
}

async function received(browser) {
  await TestUtils.waitForCondition(async () => (await pageState(browser)).received.length, "The page got the files");
  return (await pageState(browser)).received;
}

// Nothing reaches the page for a moment (the sheet was cancelled).
async function nothingReceived(browser) {
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 500));
  return (await pageState(browser)).received.length == 0;
}

async function choosePhotos(browser) {
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  MockFilePicker.setFiles([jpegFile, pngFile]);
  MockFilePicker.returnValue = MockFilePicker.returnOK;
  try {
    const shown = sheetShown();
    await BrowserTestUtils.synthesizeMouseAtCenter("#pick", {}, browser);
    await shown;
  } finally {
    MockFilePicker.cleanup();
  }
}

add_task(async function file_input_asks_then_uploads() {
  await withPhotoPage([["whimsy.feature.upload-clipboard", false]], async browser => {
    await choosePhotos(browser);
    const rows = sheetRows();
    Assert.deepEqual(KINDS.map(k => rows[k].checked), [true, true, false, true], "The sheet starts from Settings");
    const panel = document.getElementById("whimsy-photo-details");
    await TestUtils.waitForCondition(() => panel.querySelector("#whimsy-photo-details-location-count").textContent, "The counts are filled in");
    Assert.deepEqual(document.l10n.getAttributes(panel.querySelector(".whimsy-photo-details-text")).args, { count: 2 }, "for both photos");
    EventUtils.synthesizeMouseAtCenter(rows.date, {});
    await press("whimsy-photo-details-upload");
    const [got] = await received(browser);
    is(got.kind, "change", "The page's change listener ran");
    const cats = { location: true, camera: true, date: true, other: true };
    ok(same(got.files[0].bytes, stripImageMetadata(photoJpeg(), cats)), "The JPEG lost what was ticked");
    ok(same(got.files[1].bytes, stripImageMetadata(photoPng(), cats)), "and so did the PNG");
    is(Services.prefs.getBoolPref(`${PREF}.date`), false, "Ticking Date in the sheet doesn't change Settings");
  });
});

add_task(async function file_input_cancel_uploads_nothing() {
  await withPhotoPage([["whimsy.feature.upload-clipboard", false]], async browser => {
    await choosePhotos(browser);
    await press("whimsy-photo-details-cancel");
    ok(await nothingReceived(browser), "The page heard nothing");
    is((await pageState(browser)).files, 0, "and its input is empty");
  });
});

add_task(async function file_input_upload_as_is_sends_the_originals() {
  await withPhotoPage([["whimsy.feature.upload-clipboard", false]], async browser => {
    await choosePhotos(browser);
    const rows = sheetRows();
    for (const k of KINDS.filter(k => rows[k].checked)) {
      EventUtils.synthesizeMouseAtCenter(rows[k], {});
    }
    await press("whimsy-photo-details-upload");
    const [got] = await received(browser);
    ok(same(got.files[0].bytes, photoJpeg()), "The JPEG is byte for byte what was chosen");
    ok(same(got.files[1].bytes, photoPng()), "and so is the PNG");
  });
});

add_task(async function file_input_without_asking_uses_settings() {
  await withPhotoPage([["whimsy.feature.upload-clipboard", false], [`${PREF}.ask`, false]], async browser => {
    const MockFilePicker = SpecialPowers.MockFilePicker;
    MockFilePicker.init(window.browsingContext);
    MockFilePicker.setFiles([jpegFile]);
    MockFilePicker.returnValue = MockFilePicker.returnOK;
    try {
      await BrowserTestUtils.synthesizeMouseAtCenter("#pick", {}, browser);
      const [got] = await received(browser);
      ok(!document.getElementById("whimsy-photo-details")?.matches("[panelopen]"), "No sheet");
      ok(same(got.files[0].bytes, stripImageMetadata(photoJpeg(), SETTINGS_DEFAULT)), "The JPEG lost Settings' kinds");
    } finally {
      MockFilePicker.cleanup();
    }
  });
});

async function dropPhoto(browser) {
  const shown = sheetShown();
  await SpecialPowers.spawn(browser, [Array.from(photoJpeg())], jpg => {
    const zone = content.document.getElementById("zone");
    const page = Cu.waiveXrays(content);
    const data = new page.DataTransfer();
    data.items.add(new page.File(Cu.cloneInto([new Uint8Array(jpg)], content), "beach.jpg", Cu.cloneInto({ type: "image/jpeg" }, content)));
    const drop = new content.DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: Cu.unwaiveXrays(data) });
    content.windowUtils.dispatchDOMEventViaPresShellForTesting(zone, drop);
  });
  await shown;
}

add_task(async function drop_asks_then_uploads() {
  await withPhotoPage([], async browser => {
    await dropPhoto(browser);
    await press("whimsy-photo-details-upload");
    const [got] = await received(browser);
    is(got.kind, "drop", "The page's drop listener ran");
    ok(same(got.files[0].bytes, stripImageMetadata(photoJpeg(), SETTINGS_DEFAULT)), "with the photo stripped as ticked");
  });
  await withPhotoPage([], async browser => {
    await dropPhoto(browser);
    await press("whimsy-photo-details-cancel");
    ok(await nothingReceived(browser), "Cancel drops nothing");
  });
});

async function pastePhoto(browser) {
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("pick").focus());
  const shown = sheetShown();
  EventUtils.synthesizeKey("v", { accelKey: true });
  await shown;
}

add_task(async function paste_asks_then_uploads() {
  const original = WhimsyUploadParent.clipboardUpload;
  WhimsyUploadParent.clipboardUpload = async () => ({ path: jpegPath, isFile: true });
  try {
    await withPhotoPage([["whimsy.feature.upload-clipboard", true]], async browser => {
      await pastePhoto(browser);
      const rows = sheetRows();
      Assert.deepEqual(KINDS.map(k => rows[k].checked), [true, true, false, true], "Cmd+V gets the same sheet");
      EventUtils.synthesizeMouseAtCenter(rows.camera, {});
      await press("whimsy-photo-details-upload");
      const [got] = await received(browser);
      is(got.files[0].name, "beach.jpg", "The pasted photo arrived");
      ok(same(got.files[0].bytes, stripImageMetadata(photoJpeg(), { location: true, camera: false, date: false, other: true })), "stripped as ticked");
    });
    await withPhotoPage([["whimsy.feature.upload-clipboard", true]], async browser => {
      await pastePhoto(browser);
      await press("whimsy-photo-details-cancel");
      ok(await nothingReceived(browser), "Cancel pastes nothing");
      is((await pageState(browser)).files, 0, "and the input stays empty");
    });
    await withPhotoPage([["whimsy.feature.upload-clipboard", true], [`${PREF}.ask`, false]], async browser => {
      await SpecialPowers.spawn(browser, [], () => content.document.getElementById("pick").focus());
      EventUtils.synthesizeKey("v", { accelKey: true });
      const [got] = await received(browser);
      ok(same(got.files[0].bytes, stripImageMetadata(photoJpeg(), SETTINGS_DEFAULT)), "Without asking, a paste loses Settings' kinds");
    });
  } finally {
    WhimsyUploadParent.clipboardUpload = original;
  }
});

// ---------------------------------------------------------------------------
// Settings

add_task(async function settings_choose_the_kinds() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#privacy");
  try {
    const doc = tab.linkedBrowser.contentDocument;
    const main = await TestUtils.waitForCondition(() => {
      const el = doc.getElementById("whimsyStripImageMetadata");
      return el?.checkVisibility() ? el : null;
    }, "Privacy & Security shows the photo setting");
    const options = doc.getElementById("whimsyPhotoDetailsOptions");
    const box = kind => doc.querySelector(`#whimsyPhotoDetailsOptions moz-checkbox[data-kind="${kind}"]`);
    const ask = doc.getElementById("whimsyPhotoDetailsAsk");
    ok(!main.checked, "Off by default");
    ok(options.inert && !options.classList.contains("is-open"), "with its kinds folded away");
    main.scrollIntoView({ block: "center" });
    main.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(PREF, false), "Ticking it turns it on");
    await TestUtils.waitForCondition(() => !options.inert && options.classList.contains("is-open"), "and shows the kinds");
    Assert.deepEqual(KINDS.map(k => box(k).checked), [true, true, false, true], "Location, Camera, and Everything else start ticked");
    ok(ask.checked, "and so does Ask before each upload");
    box("date").click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(`${PREF}.date`, false), "Ticking Date and time taken sets its kind");
    ask.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref(`${PREF}.ask`, true), "Unticking Ask sets it");
    ok(Services.prefs.getBoolPref(PREF), "The main setting is still on");
    for (const kind of KINDS) {
      box(kind).click();
    }
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref(PREF, true), "Unticking every kind turns the setting off");
    await TestUtils.waitForCondition(() => !main.checked && options.inert, "and folds the kinds away");
    main.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(PREF, false), "Ticking it again turns it on");
    await TestUtils.waitForCondition(() => KINDS.map(k => box(k).checked).join() == "true,true,false,true", "with the kinds back to their defaults");
  } finally {
    BrowserTestUtils.removeTab(tab);
    for (const name of ["", ".location", ".camera", ".date", ".other", ".ask"]) {
      Services.prefs.clearUserPref(PREF + name);
    }
  }
});
