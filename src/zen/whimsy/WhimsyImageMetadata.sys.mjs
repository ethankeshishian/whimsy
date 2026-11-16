/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W27/W29: "Remove details from photos you upload" (Settings › Privacy &
// Security, whimsy.privacy.strip-image-metadata, off by default). Each kind
// of detail is its own box (whimsy.privacy.strip-image-metadata.<kind>):
//
// - location: GPS, and place names (XMP and IPTC city, country, location).
// - camera: make, model, lens, serial numbers, owner, and the editing app.
// - date: when the photo was taken, digitized, and modified.
// - other: everything else (captions, keywords, author, comments, thumbnails,
//   maker data, text chunks, and a JPEG's secondary images: depth and HDR).
//   Exif thumbnails carry their own details, so they go with location and
//   camera too.
//
// Orientation and the colour profile always stay, and the pixel data never
// changes: only metadata goes, and every other byte is copied as is.
//
// Formats:
// - JPEG: Exif (APP1) filtered tag by tag; XMP (APP1) filtered property by
//   property; IPTC (APP13) filtered dataset by dataset; COM and other APPn
//   are "other". A multi-picture JPEG (APP2 MPF: iPhone gain maps, depth)
//   keeps its secondary images only while "other" is off, each filtered
//   like the primary, with the MPF index rewritten. Anything after the EOI
//   that isn't such an image goes with "other".
// - PNG: eXIf (Exif), iTXt XMP, the other text chunks ("other"), and tIME.
// - WebP: the EXIF and XMP chunks, with the VP8X flags kept in step.
// - GIF: comments, the XMP application extension, and other application
//   extensions (the loop count and the colour profile stay).
// - TIFF: the file's own tags (its image structure stays), with each page.
//   DNG and BigTIFF pass through untouched.
// - HEIC/HEIF/AVIF: the Exif and XMP items, rewritten in place at the same
//   size; a sequence's movie user data. Depth and HDR auxiliary images are
//   images of their own and stay.
// - JPEG XL (container): the Exif and xml boxes; compressed (brob) boxes go
//   when any box is ticked, since they can't be read here.
//
// A file that doesn't parse passes through untouched. A metadata block that
// doesn't parse inside a file that does goes whenever any box is ticked.
// WhimsyUploadChild applies this to files chosen in file inputs and dropped
// on pages; WhimsyUploadParent to the clipboard and download files it
// uploads. Downloads themselves are never touched.

const PREF = "whimsy.privacy.strip-image-metadata";
const ASK_PREF = `${PREF}.ask`;
const FEATURE_PREF = "whimsy.feature.photo-metadata";
// Larger files pass through rather than being read into memory.
const MAX_BYTES = 64 * 1024 * 1024;

export const CATEGORIES = ["location", "camera", "date", "other"];
const DEFAULTS = { location: true, camera: true, date: false, other: true };
export const ALL = Object.freeze({ location: true, camera: true, date: true, other: true });

const JPEG_SOI = [0xff, 0xd8];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JXL_SIGNATURE = [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];
const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const MPF_ID = [0x4d, 0x50, 0x46, 0x00]; // "MPF\0"
const ORIENTATION_TAG = 0x0112;
const ICC_TAG = 0x8773;

const ascii = text => [...text].map(ch => ch.charCodeAt(0));
const XMP_ID = ascii("http://ns.adobe.com/xap/1.0/\0");
const XMP_EXT_ID = ascii("http://ns.adobe.com/xmp/extension/\0");
const ICC_ID = ascii("ICC_PROFILE\0");
const PHOTOSHOP_ID = ascii("Photoshop 3.0\0");

function startsWith(bytes, at, sig) {
  if (at < 0 || at + sig.length > bytes.length) {
    return false;
  }
  return sig.every((b, i) => bytes[at + i] == b);
}

function fourcc(bytes, at) {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function be32(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function le32(bytes, at) {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function contains(bytes, text) {
  const needle = ascii(text);
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

// What one run removes (`cats`) and notes (`found`, the kinds the file has).
class Run {
  constructor(cats, found) {
    this.cats = cats;
    this.found = found;
  }
  // Notes `cat` as present; true when it goes.
  hit(cat) {
    this.found?.add(cat);
    return !!this.cats[cat];
  }
  get any() {
    return CATEGORIES.some(c => this.cats[c]);
  }
  get inspecting() {
    return !!this.found;
  }
}

/** The Orientation (2–8) in the TIFF structure at bytes[start, end), else 0 (none or upright). */
export function orientationOf(bytes, start, end) {
  if (end - start < 8 || end > bytes.length) {
    return 0;
  }
  const little = bytes[start] == 0x49 && bytes[start + 1] == 0x49;
  const big = bytes[start] == 0x4d && bytes[start + 1] == 0x4d;
  if (!little && !big) {
    return 0;
  }
  const u16 = at => (little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]);
  const u32 = at =>
    (little
      ? bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)
      : (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  if (u16(start + 2) != 42) {
    return 0;
  }
  const ifd = start + u32(start + 4);
  if (ifd + 2 > end) {
    return 0;
  }
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) {
      break;
    }
    // SHORT (3), one value, stored in the entry's first two value bytes.
    if (u16(entry) == ORIENTATION_TAG && u16(entry + 2) == 3) {
      const value = u16(entry + 8);
      return value >= 2 && value <= 8 ? value : 0;
    }
  }
  return 0;
}

// A big-endian TIFF with one IFD holding only Orientation.
function orientationTiff(value) {
  return [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, value, 0, 0, 0, 0, 0, 0];
}
// A big-endian TIFF with an empty IFD.
const EMPTY_TIFF = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0];

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function same(a, b) {
  if (a.length != b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] != b[i]) {
      return false;
    }
  }
  return true;
}

// The rebuilt file, or null when it's the same as the original.
function rebuilt(parts, original) {
  const out = concat(parts);
  return same(out, original) ? null : out;
}

// ---------------------------------------------------------------------------
// TIFF and Exif

// Location: GeoTIFF.
const TIFF_LOCATION = new Set([0x830e, 0x8482, 0x85d8, 0x87af, 0x87b0, 0x87b1]);
const TIFF_CAMERA = new Set([0x010f, 0x0110, 0x0131, 0x013c, 0x927c, 0xa430, 0xa431, 0xa432, 0xa433, 0xa434, 0xa435]);
const TIFF_DATE = new Set([0x0132, 0x9003, 0x9004, 0x9010, 0x9011, 0x9012, 0x9290, 0x9291, 0x9292]);
// What a TIFF file needs to show its image.
const TIFF_STRUCTURE = new Set([
  0x00fe, 0x00ff, 0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0107, 0x0108, 0x0109, 0x010a, 0x0111, 0x0115, 0x0116,
  0x0117, 0x0118, 0x0119, 0x011a, 0x011b, 0x011c, 0x0122, 0x0123, 0x0124, 0x0125, 0x0128, 0x0129, 0x012d, 0x013d,
  0x013e, 0x013f, 0x0140, 0x0141, 0x0142, 0x0143, 0x0144, 0x0145, 0x0146, 0x0147, 0x014c, 0x0150, 0x0151, 0x0152,
  0x0153, 0x0154, 0x0155, 0x0156, 0x015b, 0x0200, 0x0201, 0x0202, 0x0203, 0x0205, 0x0206, 0x0207, 0x0208, 0x0209,
  0x0211, 0x0212, 0x0213, 0x0214,
]);
const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4, 0, 0, 8, 8, 8];
const EXIF_POINTER = 0x8769;
const GPS_POINTER = 0x8825;
const INTEROP_POINTER = 0xa005;
const SUB_IFDS = 0x014a;
const XMP_TAG = 0x02bc;
const IPTC_TAG = 0x83bb;
const PHOTOSHOP_TAG = 0x8649;
const DNG_VERSION = 0xc612;

function tiffCategory(tag, fileMode) {
  if (tag == ORIENTATION_TAG || tag == ICC_TAG) {
    return "keep";
  }
  if (fileMode && TIFF_STRUCTURE.has(tag)) {
    return "keep";
  }
  if (TIFF_LOCATION.has(tag)) {
    return "location";
  }
  if (TIFF_CAMERA.has(tag)) {
    return "camera";
  }
  if (TIFF_DATE.has(tag)) {
    return "date";
  }
  return "other";
}

/**
 * Filters the TIFF structure in `src` (an Exif block, or with `fileMode` a
 * whole TIFF file). Returns null when it doesn't parse (or is DNG/BigTIFF in
 * file mode, which pass through), else { changed, out, orientation, bare }:
 * `out` is a copy of the same length with the removed entries gone and their
 * values zeroed; `bare` means nothing but Orientation is left, and
 * `orientation` is its value (0 when none).
 */
function filterTiff(src, run, fileMode = false) {
  const len = src.length;
  if (len < 8) {
    return null;
  }
  const little = src[0] == 0x49 && src[1] == 0x49;
  if (!little && !(src[0] == 0x4d && src[1] == 0x4d)) {
    return null;
  }
  const u16 = at => (little ? src[at] | (src[at + 1] << 8) : (src[at] << 8) | src[at + 1]);
  const u32 = at =>
    (little
      ? src[at] | (src[at + 1] << 8) | (src[at + 2] << 16) | (src[at + 3] << 24)
      : (src[at] << 24) | (src[at + 1] << 16) | (src[at + 2] << 8) | src[at + 3]) >>> 0;
  const w16 = (buf, at, v) => {
    if (little) {
      buf[at] = v & 0xff;
      buf[at + 1] = v >> 8;
    } else {
      buf[at] = v >> 8;
      buf[at + 1] = v & 0xff;
    }
  };
  const w32 = (buf, at, v) => {
    for (let i = 0; i < 4; i++) {
      buf[at + (little ? i : 3 - i)] = (v >>> (8 * i)) & 0xff;
    }
  };
  if (u16(2) != 42) {
    return null;
  }
  const out = new Uint8Array(len);
  out.set(src.subarray(0, 8));
  const kept = [[0, 8, "ifd"]];
  const removed = [];
  const replacements = [];
  const visited = new Set();
  let changed = false;
  let broken = false;

  const valueOf = (entry, type, count) => {
    const size = (TYPE_SIZES[type] ?? 0) * count;
    return size <= 4 ? { at: entry + 8, size, inline: true } : { at: u32(entry + 8), size, inline: false };
  };
  const values = (entry, type, count) => {
    const { at, size } = valueOf(entry, type, count);
    const step = type == 3 || type == 8 ? 2 : 4;
    if (at + size > len || count > 100000) {
      broken = true;
      return [];
    }
    const list = [];
    for (let i = 0; i < count; i++) {
      list.push(step == 2 ? u16(at + i * 2) : u32(at + i * 4));
    }
    return list;
  };

  // Every region an IFD (and what hangs off it) takes, for one that goes.
  const drop = (offset, depth = 0) => {
    if (depth > 8 || visited.has(offset) || offset + 2 > len) {
      return;
    }
    visited.add(offset);
    const count = u16(offset);
    if (offset + 2 + count * 12 + 4 > len) {
      broken = true;
      return;
    }
    removed.push([offset, 2 + count * 12 + 4]);
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      const type = u16(entry + 2);
      const n = u32(entry + 4);
      const v = valueOf(entry, type, n);
      if (!v.inline) {
        removed.push([v.at, v.size]);
      }
    }
    // A thumbnail's JPEG.
    const tags = new Map();
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      tags.set(u16(entry), entry);
    }
    if (tags.has(0x0201) && tags.has(0x0202)) {
      removed.push([u32(tags.get(0x0201) + 8), u32(tags.get(0x0202) + 8)]);
    }
  };

  // Copies the IFD at `offset` into `out`, without the entries that go.
  // `kind`: "ifd0", "exif", "keep" (all entries stay), "page" (a TIFF page),
  // "thumb" (Exif IFD1). Returns how many entries stayed.
  const copy = (offset, kind, depth = 0) => {
    if (depth > 8 || visited.has(offset) || offset + 2 > len) {
      broken ||= !visited.has(offset);
      return 0;
    }
    visited.add(offset);
    const count = u16(offset);
    const size = 2 + count * 12 + 4;
    if (offset + size > len) {
      broken = true;
      return 0;
    }
    kept.push([offset, size, "ifd"]);
    let at = offset + 2;
    let stayed = 0;
    const strips = new Map();
    let orientation = 0;
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const n = u32(entry + 4);
      const v = valueOf(entry, type, n);
      let goes = false;
      let replacement = null;
      if (kind == "keep") {
        goes = false;
      } else if (tag == EXIF_POINTER) {
        const child = u32(entry + 8);
        const childCount = child + 2 <= len ? u16(child) : 0;
        const left = copy(child, "exif", depth + 1);
        // An Exif IFD with nothing left goes, pointer and all.
        goes = left == 0 && childCount > 0;
      } else if (tag == GPS_POINTER) {
        const child = u32(entry + 8);
        const has = child + 2 <= len && u16(child) > 0;
        if (has && run.hit("location")) {
          goes = true;
          drop(child, depth + 1);
        } else if (!has && run.cats.location) {
          goes = true;
        } else {
          copy(child, "keep", depth + 1);
        }
      } else if (tag == INTEROP_POINTER) {
        const child = u32(entry + 8);
        if (run.hit("other")) {
          goes = true;
          drop(child, depth + 1);
        } else {
          copy(child, "keep", depth + 1);
        }
      } else if (tag == SUB_IFDS && fileMode) {
        for (const child of values(entry, type, n)) {
          copy(child, "page", depth + 1);
        }
      } else if (tag == XMP_TAG && !v.inline) {
        const result = v.at + v.size <= len ? filterXmp(src.subarray(v.at, v.at + v.size), run, true) : null;
        if (!result) {
          goes = run.hit("other") || run.any;
        } else if (result.changed) {
          if (result.out) {
            replacement = result.out;
          } else {
            goes = true;
          }
        }
      } else if ((tag == IPTC_TAG || tag == PHOTOSHOP_TAG) && !v.inline) {
        const block = v.at + v.size <= len ? src.subarray(v.at, v.at + v.size) : null;
        const result = block && (tag == IPTC_TAG ? filterIptc(block, run) : filterIrb(block, run));
        if (!result) {
          goes = run.hit("other") || run.any;
        } else if (result.changed) {
          if (result.out?.length) {
            const padded = new Uint8Array(v.size);
            padded.set(result.out.subarray(0, v.size));
            replacement = padded;
          } else {
            goes = true;
          }
        }
      } else {
        const cat = kind == "thumb" ? "other" : tiffCategory(tag, fileMode);
        goes = cat != "keep" && run.hit(cat);
      }
      if (goes) {
        changed = true;
        if (!v.inline) {
          removed.push([v.at, v.size]);
        }
        continue;
      }
      out.set(src.subarray(entry, entry + 12), at);
      at += 12;
      stayed++;
      if (tag == ORIENTATION_TAG) {
        orientation = 1;
      }
      if (!v.inline) {
        if (v.at + v.size > len) {
          // A value outside the file: nothing to copy.
          if (fileMode) {
            broken = true;
          }
        } else if (replacement) {
          changed = true;
          replacements.push([v.at, replacement]);
          kept.push([v.at, v.size, "value"]);
        } else {
          kept.push([v.at, v.size, "value"]);
        }
      }
      if ([0x0111, 0x0117, 0x0144, 0x0145].includes(tag)) {
        strips.set(tag, values(entry, type, n));
      } else if (tag == 0x0201 || tag == 0x0202) {
        strips.set(tag, [u32(entry + 8)]);
      }
    }
    w16(out, offset, stayed);
    // Image data (strips, tiles, a thumbnail's JPEG).
    for (const [offsets, counts] of [[0x0111, 0x0117], [0x0144, 0x0145], [0x0201, 0x0202]]) {
      const starts = strips.get(offsets) ?? [];
      const sizes = strips.get(counts) ?? [];
      for (let i = 0; i < Math.min(starts.length, sizes.length); i++) {
        if (starts[i] + sizes[i] > len) {
          if (fileMode) {
            broken = true;
          }
          continue;
        }
        kept.push([starts[i], sizes[i], "value"]);
      }
    }
    // The next IFD: a TIFF's next page, or Exif's IFD1 (the thumbnail).
    const next = u32(offset + 2 + count * 12);
    let nextOut = 0;
    if (next && (kind == "ifd0" || kind == "page")) {
      if (fileMode) {
        copy(next, "page", depth + 1);
        nextOut = next;
      } else if (run.hit("other") || run.cats.location || run.cats.camera) {
        // Thumbnails carry their own Exif, so they go whenever Location,
        // Camera, or Everything else is ticked.
        changed = true;
        drop(next, depth + 1);
      } else {
        copy(next, "thumb", depth + 1);
        nextOut = next;
      }
    } else if (next && kind == "keep") {
      nextOut = next;
    }
    w32(out, at, nextOut);
    // Remember the orientation-only case on IFD0.
    if (kind == "ifd0") {
      ifd0Stayed = stayed;
      ifd0Orientation = orientation;
      ifd0Next = nextOut;
    }
    return stayed;
  };

  let ifd0Stayed = 0;
  let ifd0Orientation = 0;
  let ifd0Next = 0;
  const first = u32(4);
  if (fileMode) {
    // DNG keeps its raw data in ways this doesn't follow: it passes through.
    if (first + 2 <= len) {
      const count = u16(first);
      for (let i = 0; i < count && first + 2 + i * 12 + 12 <= len; i++) {
        if (u16(first + 2 + i * 12) == DNG_VERSION) {
          return null;
        }
      }
    }
  }
  copy(first, "ifd0");
  if (broken) {
    return null;
  }
  // A removed region that shares bytes with a kept value, or a value that
  // shares bytes with an IFD, would leave what should go in the file: that's
  // a structure this can't filter safely.
  const overlaps = (a, aSize, b, bSize) => aSize > 0 && bSize > 0 && a < b + bSize && b < a + aSize;
  const valueRegions = kept.filter(k => k[2] == "value");
  for (const [start, size] of valueRegions) {
    if (removed.some(([r, rSize]) => overlaps(start, size, r, rSize))) {
      return null;
    }
    if (kept.some(([k, kSize, what]) => what == "ifd" && overlaps(start, size, k, kSize))) {
      return null;
    }
  }
  for (const [start, size] of valueRegions) {
    out.set(src.subarray(start, start + size), start);
  }
  for (const [start, bytes] of replacements) {
    out.set(bytes, start);
  }
  const bare = !fileMode && ifd0Next == 0 && (ifd0Stayed == 0 || (ifd0Stayed == 1 && ifd0Orientation == 1));
  return { changed, out, bare, orientation: orientationOf(out, 0, len) };
}

// An Exif block (a TIFF) in a format whose blocks can change size: the
// bytes to put in its place, null to drop it, or `src` when it stays.
function exifBlock(src, run) {
  const result = filterTiff(src, run);
  if (!result) {
    // Not readable: it goes whenever any box is ticked.
    return run.hit("other") || run.any ? null : src;
  }
  if (!result.changed) {
    return src;
  }
  if (result.bare) {
    return result.orientation ? new Uint8Array(orientationTiff(result.orientation)) : null;
  }
  return result.out;
}

// An Exif block that must keep its size (HEIF items): the same length, with
// what goes zeroed; null when it stays as it is.
function exifInPlace(src, run) {
  const result = filterTiff(src, run);
  let out;
  if (!result) {
    if (!(run.hit("other") || run.any)) {
      return null;
    }
    out = new Uint8Array(src.length);
    if (src.length >= EMPTY_TIFF.length) {
      out.set(EMPTY_TIFF);
    }
    return out;
  }
  if (!result.changed) {
    return null;
  }
  if (result.bare) {
    out = new Uint8Array(src.length);
    const tiff = result.orientation ? orientationTiff(result.orientation) : EMPTY_TIFF;
    if (tiff.length <= src.length) {
      out.set(tiff);
    }
    return out;
  }
  return result.out;
}

// ---------------------------------------------------------------------------
// XMP

const NS = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  tiff: "http://ns.adobe.com/tiff/1.0/",
  exif: "http://ns.adobe.com/exif/1.0/",
  aux: "http://ns.adobe.com/exif/1.0/aux/",
  xmp: "http://ns.adobe.com/xap/1.0/",
  photoshop: "http://ns.adobe.com/photoshop/1.0/",
  iptcCore: "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/",
  iptcExt: "http://iptc.org/std/Iptc4xmpExt/2008-02-29/",
  exifEX: "http://cipa.jp/exif/1.0/",
};
const XMP_DATES = new Set(["CreateDate", "ModifyDate", "MetadataDate", "DateCreated", "DateTimeOriginal", "DateTimeDigitized", "DateTime"]);
const XMP_CAMERA = new Set([
  "Make",
  "Model",
  "Software",
  "HostComputer",
  "CreatorTool",
  "SerialNumber",
  "BodySerialNumber",
  "LensSerialNumber",
  "LensMake",
  "LensModel",
  "Lens",
  "LensID",
  "LensInfo",
  "LensSpecification",
  "CameraOwnerName",
  "OwnerName",
]);

function xmpCategory(ns, name) {
  if (ns == NS.tiff && name == "Orientation") {
    return "keep";
  }
  if (/^gps/i.test(name) || /latitude|longitude|altitude/i.test(name)) {
    return "location";
  }
  if (ns == NS.photoshop && ["City", "State", "Country"].includes(name)) {
    return "location";
  }
  if (ns == NS.iptcCore && ["Location", "CountryCode"].includes(name)) {
    return "location";
  }
  if (ns == NS.iptcExt && ["LocationCreated", "LocationShown"].includes(name)) {
    return "location";
  }
  if (ns == NS.aux || XMP_CAMERA.has(name)) {
    return "camera";
  }
  if (XMP_DATES.has(name) || /^(SubSecTime|OffsetTime)/.test(name)) {
    return "date";
  }
  return "other";
}

const EMPTY_XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>';

/**
 * Filters an XMP packet property by property. Null when it doesn't parse;
 * else { changed, out }: `out` is null when nothing worth keeping is left
 * (only Orientation, or nothing), and with `fixed` it's padded to the
 * original length (or null when it no longer fits).
 */
function filterXmp(bytes, run, fixed = false) {
  let doc;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\0+$/, "");
    doc = new DOMParser().parseFromString(text, "application/xml");
  } catch (e) {
    return null;
  }
  const root = doc?.documentElement;
  if (!root || root.localName == "parsererror" || doc.getElementsByTagNameNS("http://www.mozilla.org/newlayout/xml/parsererror.xml", "parsererror").length) {
    return null;
  }
  let changed = false;
  let left = 0;
  let leftOrientation = 0;
  for (const rdf of [...doc.getElementsByTagNameNS(NS.rdf, "RDF")]) {
    for (const desc of [...rdf.children]) {
      if (desc.namespaceURI != NS.rdf || desc.localName != "Description") {
        continue;
      }
      for (const attr of [...desc.attributes]) {
        if (attr.prefix == "xmlns" || attr.name == "xmlns" || attr.namespaceURI == NS.rdf || !attr.namespaceURI) {
          continue;
        }
        const cat = xmpCategory(attr.namespaceURI, attr.localName);
        if (cat != "keep" && run.hit(cat)) {
          desc.removeAttributeNode(attr);
          changed = true;
        } else {
          left++;
          leftOrientation += cat == "keep" ? 1 : 0;
        }
      }
      for (const prop of [...desc.children]) {
        const cat = xmpCategory(prop.namespaceURI, prop.localName);
        if (cat != "keep" && run.hit(cat)) {
          prop.remove();
          changed = true;
        } else {
          left++;
          leftOrientation += cat == "keep" ? 1 : 0;
        }
      }
      const props = [...desc.attributes].filter(a => a.prefix != "xmlns" && a.name != "xmlns" && a.namespaceURI != NS.rdf && a.namespaceURI);
      if (changed && !props.length && !desc.children.length) {
        desc.remove();
      }
    }
  }
  if (!changed) {
    return { changed: false, out: null };
  }
  if (left == leftOrientation) {
    if (!fixed) {
      return { changed: true, out: null };
    }
    return { changed: true, out: pad(new TextEncoder().encode(EMPTY_XMP), bytes.length) };
  }
  let text = new XMLSerializer().serializeToString(doc);
  // The serializer leaves out the XML declaration's encoding: keep it plain.
  let out = new TextEncoder().encode(text);
  if (fixed) {
    out = pad(out, bytes.length);
  }
  return { changed: true, out };
}

// XMP padded with spaces to `size` bytes (before its closing xpacket, when
// there is one); null when it doesn't fit.
function pad(out, size) {
  if (out.length > size) {
    return null;
  }
  if (out.length == size) {
    return out;
  }
  const text = new TextDecoder().decode(out);
  const end = text.lastIndexOf("<?xpacket end");
  const spaces = " ".repeat(size - out.length);
  const padded = end >= 0 ? text.slice(0, end) + spaces + text.slice(end) : text + spaces;
  return new TextEncoder().encode(padded);
}

// ---------------------------------------------------------------------------
// IPTC (IIM) and Photoshop resources

const IPTC_LOCATION = new Set([26, 27, 90, 92, 95, 100, 101]);
const IPTC_DATE = new Set([55, 60, 62, 63]);
const IPTC_CAMERA = new Set([65, 70]);

function iptcCategory(record, dataset) {
  if ((record == 1 && (dataset == 0 || dataset == 90)) || (record == 2 && dataset == 0)) {
    return "keep";
  }
  if (record == 2 && IPTC_LOCATION.has(dataset)) {
    return "location";
  }
  if (record == 2 && IPTC_DATE.has(dataset)) {
    return "date";
  }
  if (record == 2 && IPTC_CAMERA.has(dataset)) {
    return "camera";
  }
  return "other";
}

// IPTC datasets: null when they don't parse, else { changed, out } (`out`
// empty when nothing but the record version is left).
function filterIptc(bytes, run) {
  const parts = [];
  let changed = false;
  let meaningful = 0;
  let pos = 0;
  while (pos < bytes.length) {
    if (bytes[pos] == 0) {
      break; // Padding.
    }
    if (bytes[pos] != 0x1c || pos + 5 > bytes.length) {
      return null;
    }
    const record = bytes[pos + 1];
    const dataset = bytes[pos + 2];
    let size = (bytes[pos + 3] << 8) | bytes[pos + 4];
    let head = 5;
    if (size & 0x8000) {
      const n = size & 0x7fff;
      if (n > 4 || pos + 5 + n > bytes.length) {
        return null;
      }
      size = 0;
      for (let i = 0; i < n; i++) {
        size = size * 256 + bytes[pos + 5 + i];
      }
      head += n;
    }
    const end = pos + head + size;
    if (end > bytes.length) {
      return null;
    }
    const cat = iptcCategory(record, dataset);
    if (cat != "keep" && run.hit(cat)) {
      changed = true;
    } else {
      parts.push(bytes.subarray(pos, end));
      meaningful += cat == "keep" ? 0 : 1;
    }
    pos = end;
  }
  if (!changed) {
    return { changed: false, out: bytes };
  }
  return { changed: true, out: meaningful ? concat(parts) : new Uint8Array(0) };
}

// Photoshop image resources ("8BIM" blocks): null when they don't parse,
// else { changed, out } (`out` empty when nothing is left).
function filterIrb(bytes, run) {
  const blocks = [];
  let pos = 0;
  while (pos + 12 <= bytes.length && fourcc(bytes, pos) == "8BIM") {
    const id = (bytes[pos + 4] << 8) | bytes[pos + 5];
    let name = 1 + bytes[pos + 6];
    name += name & 1;
    const sizeAt = pos + 6 + name;
    if (sizeAt + 4 > bytes.length) {
      return null;
    }
    const size = be32(bytes, sizeAt);
    const data = sizeAt + 4;
    const end = data + size + (size & 1);
    if (data + size > bytes.length) {
      return null;
    }
    blocks.push({ id, head: bytes.subarray(pos, sizeAt), data: bytes.subarray(data, data + size) });
    pos = Math.min(end, bytes.length);
  }
  if (pos < bytes.length && bytes.subarray(pos).some(b => b != 0)) {
    return null;
  }
  const known = b => [0x0404, 0x0425, 0x0422, 0x0424, 0x040f].includes(b.id);
  if (blocks.some(b => !known(b))) {
    run.hit("other");
  }
  if (CATEGORIES.every(c => run.cats[c])) {
    // The whole block goes (noting what it carried).
    for (const b of blocks) {
      if (b.id == 0x0404) {
        filterIptc(b.data, new Run({}, run.found));
      } else if (b.id == 0x0422) {
        filterTiff(b.data, new Run({}, run.found));
      } else if (b.id == 0x0424) {
        filterXmp(b.data, new Run({}, run.found));
      }
    }
    return { changed: true, out: new Uint8Array(0) };
  }
  let changed = false;
  let iptcChanged = false;
  const out = [];
  for (const b of blocks) {
    let data = b.data;
    if (!known(b) && run.cats.other) {
      // Captions, paths, and the rest of Photoshop's own resources.
      changed = true;
      continue;
    }
    if (b.id == 0x0404) {
      const result = filterIptc(data, run);
      if (!result) {
        if (run.any) {
          changed = iptcChanged = true;
          continue;
        }
      } else if (result.changed) {
        changed = iptcChanged = true;
        if (!result.out.length) {
          continue;
        }
        data = result.out;
      }
    } else if (b.id == 0x0422) {
      const result = exifBlock(data, run);
      if (result !== data) {
        changed = true;
        if (!result) {
          continue;
        }
        data = result;
      }
    } else if (b.id == 0x0424) {
      const result = filterXmp(data, run);
      if (!result) {
        if (run.any) {
          changed = true;
          continue;
        }
      } else if (result.changed) {
        changed = true;
        if (!result.out) {
          continue;
        }
        data = result.out;
      }
    }
    out.push({ ...b, data });
  }
  if (iptcChanged) {
    // The IPTC digest no longer matches.
    const at = out.findIndex(b => b.id == 0x0425);
    if (at >= 0) {
      out.splice(at, 1);
    }
  }
  if (!changed) {
    return { changed: false, out: bytes };
  }
  const parts = [];
  for (const b of out) {
    const n = b.data.length;
    parts.push(b.head, new Uint8Array([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]), b.data);
    if (n & 1) {
      parts.push(new Uint8Array(1));
    }
  }
  return { changed: true, out: concat(parts) };
}

// ---------------------------------------------------------------------------
// JPEG

// Where the JPEG image starting with the SOS at `pos` ends: `end` is just
// past its EOI, or -1 when there's none; `scanEnd` is where the last scan's
// data stopped. Walks the scans (entropy-coded data, where FF is followed by
// a 00 stuffing byte or an RST marker) and the marker segments between them
// (progressive JPEGs have several scans).
function endOfImage(bytes, pos) {
  const len = bytes.length;
  let scanEnd = pos;
  while (pos + 1 < len) {
    if (bytes[pos] != 0xff) {
      break;
    }
    const marker = bytes[pos + 1];
    if (marker == 0xff) {
      pos++; // Fill byte.
      continue;
    }
    if (marker == 0xd9) {
      return { end: pos + 2, scanEnd };
    }
    if (marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (pos + 4 > len) {
      break;
    }
    const size = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (size < 2 || pos + 2 + size > len) {
      break;
    }
    pos += 2 + size;
    if (marker == 0xda) {
      // The scan's data runs to the next marker that isn't 00 or RST.
      while (pos + 1 < len && !(bytes[pos] == 0xff && bytes[pos + 1] != 0x00 && !(bytes[pos + 1] >= 0xd0 && bytes[pos + 1] <= 0xd7))) {
        pos++;
      }
      scanEnd = pos + 1 < len ? pos : len;
    }
  }
  return { end: -1, scanEnd };
}

function segment(marker, payload) {
  const length = payload.length + 2;
  if (length > 0xffff) {
    return null;
  }
  return concat([new Uint8Array([0xff, marker, length >> 8, length & 0xff]), payload]);
}

// The MPF index in an APP2 payload: its images (offsets relative to the MPF
// TIFF header), or null when it has none or doesn't parse.
function mpfIndex(bytes, tiffAt, end) {
  const tiff = bytes.subarray(tiffAt, end);
  if (tiff.length < 8) {
    return null;
  }
  const little = tiff[0] == 0x49;
  const u16 = at => (little ? tiff[at] | (tiff[at + 1] << 8) : (tiff[at] << 8) | tiff[at + 1]);
  const u32 = at => (little ? le32(tiff, at) : be32(tiff, at));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) {
    return null;
  }
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) {
      return null;
    }
    if (u16(entry) == 0xb002) {
      const n = u32(entry + 4);
      const at = n <= 4 ? entry + 8 : u32(entry + 8);
      if (n % 16 || at + n > tiff.length) {
        return null;
      }
      const images = [];
      for (let k = 0; k < n / 16; k++) {
        const e = at + k * 16;
        images.push({ entry: tiffAt + e, size: u32(e + 4), offset: u32(e + 8) });
      }
      return { images, little };
    }
  }
  return null;
}

/** A JPEG without the details `cats` names, or null when nothing changes (or it isn't a JPEG). */
export function stripJpeg(bytes, cats = ALL, found = null) {
  return jpeg(bytes, new Run(cats, found));
}

function jpeg(bytes, run) {
  if (!startsWith(bytes, 0, JPEG_SOI)) {
    return null;
  }
  const len = bytes.length;
  const parts = [bytes.subarray(0, 2)];
  let out = 2;
  let changed = false;
  let mpf = null;
  let pos = 2;
  let imageEnd = len;
  while (pos < len) {
    if (bytes[pos] != 0xff) {
      return null;
    }
    let m = pos + 1;
    while (m < len && bytes[m] == 0xff) {
      m++; // Fill bytes.
    }
    if (m >= len) {
      return null;
    }
    const marker = bytes[m];
    if (marker == 0xda || marker == 0xd9) {
      // SOS (or an early EOI): the image data, byte for byte, up to the
      // primary image's EOI.
      const { end, scanEnd } = endOfImage(bytes, pos);
      if (end > 0) {
        parts.push(bytes.subarray(pos, end));
        imageEnd = end;
      } else if (!changed) {
        // No EOI, and no metadata found before the image: left as it is.
        return null;
      } else {
        // No EOI: the image data up to where its last scan stopped, closed
        // with an EOI, so nothing that follows can carry details along.
        parts.push(bytes.subarray(pos, scanEnd), new Uint8Array([0xff, 0xd9]));
        imageEnd = len;
        changed = true;
      }
      break;
    }
    if (marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(pos, m + 1));
      out += m + 1 - pos;
      pos = m + 1;
      continue;
    }
    if (m + 3 > len) {
      return null;
    }
    const size = (bytes[m + 1] << 8) | bytes[m + 2];
    const end = m + 1 + size;
    if (size < 2 || end > len) {
      return null;
    }
    const data = m + 3;
    let replacement; // undefined: stays; null: goes; bytes: the new segment.
    if (marker == 0xe1 && startsWith(bytes, data, EXIF_ID)) {
      const tiff = bytes.subarray(data + EXIF_ID.length, end);
      const result = exifBlock(tiff, run);
      if (result !== tiff) {
        replacement = result && segment(0xe1, concat([new Uint8Array(EXIF_ID), result]));
      }
    } else if (marker == 0xe1 && startsWith(bytes, data, XMP_ID)) {
      const result = filterXmp(bytes.subarray(data + XMP_ID.length, end), run);
      if (!result) {
        if (run.hit("other") || run.any) {
          replacement = null;
        }
      } else if (result.changed) {
        replacement = result.out && segment(0xe1, concat([new Uint8Array(XMP_ID), result.out]));
      }
    } else if (marker == 0xe1 && startsWith(bytes, data, XMP_EXT_ID)) {
      // Extended XMP (depth maps, HDR, long descriptions): split across
      // segments, so it isn't parsed. It goes with "other", or with a box
      // whose details it seems to carry.
      const chunk = bytes.subarray(data, end);
      const other = run.hit("other");
      const location = contains(chunk, "GPS") || contains(chunk, "Latitude");
      const date = contains(chunk, "DateTime") || contains(chunk, "CreateDate");
      if (location) {
        run.hit("location");
      }
      if (date) {
        run.hit("date");
      }
      if (other || (location && run.cats.location) || (date && run.cats.date)) {
        replacement = null;
      }
    } else if (marker == 0xed) {
      const result = startsWith(bytes, data, PHOTOSHOP_ID) ? filterIrb(bytes.subarray(data + PHOTOSHOP_ID.length, end), run) : null;
      if (!result) {
        if (run.hit("other") || run.any) {
          replacement = null;
        }
      } else if (result.changed) {
        replacement = result.out.length ? segment(0xed, concat([new Uint8Array(PHOTOSHOP_ID), result.out])) : null;
      }
    } else if (marker == 0xe2 && startsWith(bytes, data, MPF_ID)) {
      // The index of the secondary images (depth, HDR gain maps).
      if (run.hit("other")) {
        replacement = null;
      }
      mpf = { at: out + 4 + MPF_ID.length, src: data + MPF_ID.length, end, part: parts.length };
    } else if (marker == 0xfe || (marker >= 0xe1 && marker <= 0xef && marker != 0xee && marker != 0xe2)) {
      // Comments, and application data that isn't the image's: APP1 that
      // isn't Exif or XMP, APP3–APP13, APP15.
      if (run.hit("other")) {
        replacement = null;
      }
    } else if (marker == 0xe2 && !startsWith(bytes, data, ICC_ID)) {
      if (run.hit("other")) {
        replacement = null;
      }
    }
    if (replacement === undefined) {
      parts.push(bytes.subarray(pos, end));
      out += end - pos;
    } else {
      changed = true;
      if (replacement) {
        parts.push(replacement);
        out += replacement.length;
      }
    }
    pos = end;
  }
  const primaryLength = parts.reduce((n, p) => n + p.length, 0);
  // What follows the primary image's EOI.
  const trailer = bytes.subarray(imageEnd);
  const index = mpf ? mpfIndex(bytes, mpf.src, mpf.end) : null;
  // Secondary images, as the MPF index lists them.
  let secondaries = index ? [] : null;
  for (const image of index?.images.slice(1) ?? []) {
    const start = mpf.src + image.offset;
    if (!image.offset || start < imageEnd || start + image.size > len) {
      secondaries = null;
      break;
    }
    secondaries.push({ image, bytes: bytes.subarray(start, start + image.size) });
  }
  if (run.inspecting && secondaries) {
    for (const s of secondaries) {
      jpeg(s.bytes, new Run({}, run.found));
    }
  } else if (!mpf && trailer.some(b => b != 0 && b != 0xff)) {
    run.hit("other");
  }
  if (!run.cats.other && mpf && secondaries) {
    return mpfRebuilt(bytes, parts, run, { mpf, index, secondaries, primaryLength });
  }
  if (!trailer.length) {
    return changed ? rebuilt(parts, bytes) : null;
  }
  if (run.cats.other) {
    // Nothing after the EOI stays.
    return rebuilt(parts, bytes);
  }
  if (mpf) {
    // "Other" is off, but the index doesn't parse: the images it lists can't
    // be filtered, so they go with it.
    if (run.any) {
      parts.splice(mpf.part, 1);
      return rebuilt(parts, bytes);
    }
  } else if (run.any && ["Exif", "GPS", "http://ns.adobe.com/xap"].some(t => contains(trailer, t))) {
    // Unindexed data after the EOI that seems to carry details.
    return rebuilt(parts, bytes);
  }
  parts.push(trailer);
  return changed ? rebuilt(parts, bytes) : null;
}

// A multi-picture JPEG with "other" off: the secondary images stay, each
// filtered, and the MPF index points at where they are now.
function mpfRebuilt(bytes, parts, run, { mpf, index, secondaries, primaryLength }) {
  const filtered = secondaries.map(s => jpeg(s.bytes, run) ?? s.bytes);
  const result = concat([...parts, ...filtered]);
  const little = index.little;
  const put = (at, v) => {
    for (let i = 0; i < 4; i++) {
      result[at + (little ? i : 3 - i)] = (v >>> (8 * i)) & 0xff;
    }
  };
  const base = mpf.at;
  const entry = image => base + (image.entry - mpf.src);
  put(entry(index.images[0]) + 4, primaryLength);
  let at = primaryLength;
  secondaries.forEach((s, i) => {
    put(entry(s.image) + 4, filtered[i].length);
    put(entry(s.image) + 8, at - base);
    at += filtered[i].length;
  });
  return same(result, bytes) ? null : result;
}

// ---------------------------------------------------------------------------
// PNG

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) {
    c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = concat([new Uint8Array(ascii(type)), data]);
  const crc = crc32(body);
  const n = data.length;
  return concat([
    new Uint8Array([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]),
    body,
    new Uint8Array([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]),
  ]);
}

/** A PNG without the details `cats` names, or null when nothing changes (or it isn't a PNG). */
export function stripPng(bytes, cats = ALL, found = null) {
  return png(bytes, new Run(cats, found));
}

function png(bytes, run) {
  if (!startsWith(bytes, 0, PNG_SIGNATURE)) {
    return null;
  }
  const len = bytes.length;
  const parts = [bytes.subarray(0, 8)];
  let changed = false;
  let pos = 8;
  while (pos < len) {
    if (pos + 12 > len) {
      return null;
    }
    const size = be32(bytes, pos);
    const type = fourcc(bytes, pos + 4);
    const end = pos + 12 + size;
    if (end > len) {
      return null;
    }
    const data = bytes.subarray(pos + 8, pos + 8 + size);
    let replacement; // undefined: stays; null: goes; bytes: the new chunk.
    if (type == "eXIf") {
      const result = exifBlock(data, run);
      if (result !== data) {
        replacement = result && pngChunk("eXIf", result);
      }
    } else if (type == "tEXt" || type == "zTXt" || type == "iTXt") {
      const nul = data.indexOf(0);
      const keyword = String.fromCharCode(...data.subarray(0, nul < 0 ? 0 : nul));
      if (type == "iTXt" && keyword == "XML:com.adobe.xmp") {
        // keyword\0, compressed flag, method, language\0, translated\0, text.
        const lang = data.indexOf(0, nul + 3);
        const translated = lang < 0 ? -1 : data.indexOf(0, lang + 1);
        const result = translated > 0 && data[nul + 1] == 0 ? filterXmp(data.subarray(translated + 1), run) : null;
        if (!result) {
          if (run.hit("other") || run.any) {
            replacement = null;
          }
        } else if (result.changed) {
          replacement = result.out && pngChunk("iTXt", concat([data.subarray(0, translated + 1), result.out]));
        }
      } else if (/^Raw profile type/i.test(keyword)) {
        // Hex-encoded Exif, IPTC, or XMP (ImageMagick): it goes whenever any
        // box is ticked.
        run.hit("other");
        if (run.any) {
          replacement = null;
        }
      } else if (run.hit("other")) {
        // Text chunks (captions, comments, author) are "Everything else".
        replacement = null;
      }
    } else if (type == "tIME") {
      if (run.hit("date")) {
        replacement = null;
      }
    } else if (type == "caBX") {
      // Content credentials (C2PA).
      if (run.hit("other")) {
        replacement = null;
      }
    }
    if (replacement === undefined) {
      parts.push(bytes.subarray(pos, end));
    } else {
      changed = true;
      if (replacement) {
        parts.push(replacement);
      }
    }
    pos = end;
    if (type == "IEND") {
      parts.push(bytes.subarray(pos));
      break;
    }
  }
  return changed ? rebuilt(parts, bytes) : null;
}

// ---------------------------------------------------------------------------
// WebP

function webp(bytes, run) {
  if (bytes.length < 20 || fourcc(bytes, 0) != "RIFF" || fourcc(bytes, 8) != "WEBP") {
    return null;
  }
  const len = Math.min(bytes.length, le32(bytes, 4) + 8);
  const chunks = [];
  let pos = 12;
  while (pos + 8 <= len) {
    const type = fourcc(bytes, pos);
    const size = le32(bytes, pos + 4);
    const end = pos + 8 + size + (size & 1);
    if (pos + 8 + size > len) {
      return null;
    }
    chunks.push({ type, bytes: bytes.subarray(pos, Math.min(end, len)), data: bytes.subarray(pos + 8, pos + 8 + size) });
    pos = end;
  }
  let changed = false;
  const kept = [];
  for (const chunk of chunks) {
    if (chunk.type == "EXIF") {
      const prefixed = startsWith(chunk.data, 0, EXIF_ID);
      const tiff = prefixed ? chunk.data.subarray(6) : chunk.data;
      const result = exifBlock(tiff, run);
      if (result === tiff) {
        kept.push(chunk.bytes);
      } else {
        changed = true;
        if (result) {
          kept.push(riffChunk("EXIF", prefixed ? concat([new Uint8Array(EXIF_ID), result]) : result));
        }
      }
    } else if (chunk.type == "XMP ") {
      const result = filterXmp(chunk.data, run);
      if (!result) {
        if (run.hit("other") || run.any) {
          changed = true;
        } else {
          kept.push(chunk.bytes);
        }
      } else if (result.changed) {
        changed = true;
        if (result.out) {
          kept.push(riffChunk("XMP ", result.out));
        }
      } else {
        kept.push(chunk.bytes);
      }
    } else {
      kept.push(chunk.bytes);
    }
  }
  if (!changed) {
    return null;
  }
  // Keep VP8X's flags in step with the chunks that are left.
  const vp8x = kept.find(c => fourcc(c, 0) == "VP8X");
  if (vp8x) {
    const flags = vp8x[8] & ~0x0c;
    const exif = kept.some(c => fourcc(c, 0) == "EXIF") ? 0x08 : 0;
    const xmp = kept.some(c => fourcc(c, 0) == "XMP ") ? 0x04 : 0;
    const copy = new Uint8Array(vp8x);
    copy[8] = flags | exif | xmp;
    kept[kept.indexOf(vp8x)] = copy;
  }
  const body = concat(kept);
  const size = body.length + 4;
  const head = new Uint8Array([...ascii("RIFF"), size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, size >>> 24, ...ascii("WEBP")]);
  return rebuilt([head, body], bytes);
}

function riffChunk(type, data) {
  const n = data.length;
  const head = new Uint8Array([...ascii(type), n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24]);
  return concat([head, data, new Uint8Array(n & 1)]);
}

// ---------------------------------------------------------------------------
// GIF

const GIF_KEPT_APPS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0", "ICCRGBG1012"]);

function gifXmpTrailer() {
  const out = new Uint8Array(258);
  out[0] = 1;
  for (let i = 1; i < 257; i++) {
    out[i] = 256 - i;
  }
  return out; // The last byte (0) is the block terminator.
}

function gif(bytes, run) {
  if (!(startsWith(bytes, 0, ascii("GIF87a")) || startsWith(bytes, 0, ascii("GIF89a"))) || bytes.length < 13) {
    return null;
  }
  const len = bytes.length;
  // Sub-blocks from `pos`: where they end (past the terminator), or -1.
  const blocksEnd = pos => {
    while (pos < len) {
      const n = bytes[pos];
      pos += 1 + n;
      if (n == 0) {
        return pos;
      }
    }
    return -1;
  };
  let pos = 13;
  if (bytes[10] & 0x80) {
    pos += 3 * (1 << ((bytes[10] & 7) + 1));
  }
  const parts = [bytes.subarray(0, pos)];
  let changed = false;
  while (pos < len) {
    const kind = bytes[pos];
    if (kind == 0x3b) {
      parts.push(bytes.subarray(pos));
      break;
    }
    if (kind == 0x2c) {
      let at = pos + 10;
      if (at > len) {
        return null;
      }
      if (bytes[pos + 9] & 0x80) {
        at += 3 * (1 << ((bytes[pos + 9] & 7) + 1));
      }
      const end = blocksEnd(at + 1);
      if (end < 0) {
        return null;
      }
      parts.push(bytes.subarray(pos, end));
      pos = end;
      continue;
    }
    if (kind != 0x21 || pos + 2 > len) {
      return null;
    }
    const label = bytes[pos + 1];
    const end = blocksEnd(pos + 2);
    if (end < 0) {
      return null;
    }
    let replacement;
    if (label == 0xfe) {
      if (run.hit("other")) {
        replacement = null;
      }
    } else if (label == 0xff && bytes[pos + 2] == 11) {
      const id = String.fromCharCode(...bytes.subarray(pos + 3, pos + 14));
      if (id == "XMP DataXMP") {
        const start = pos + 14;
        const tail = end - 258;
        const result = tail > start && bytes[tail] == 1 && bytes[tail + 1] == 0xff ? filterXmp(bytes.subarray(start, tail), run) : null;
        if (!result) {
          if (run.hit("other") || run.any) {
            replacement = null;
          }
        } else if (result.changed) {
          replacement = result.out && concat([bytes.subarray(pos, start), result.out, gifXmpTrailer()]);
        }
      } else if (!GIF_KEPT_APPS.has(id) && run.hit("other")) {
        replacement = null;
      }
    }
    if (replacement === undefined) {
      parts.push(bytes.subarray(pos, end));
    } else {
      changed = true;
      if (replacement) {
        parts.push(replacement);
      }
    }
    pos = end;
  }
  return changed ? rebuilt(parts, bytes) : null;
}

// ---------------------------------------------------------------------------
// TIFF files

function tiffFile(bytes, run) {
  const result = filterTiff(bytes, run, true);
  if (!result || !result.changed) {
    return null;
  }
  return same(result.out, bytes) ? null : result.out;
}

// ---------------------------------------------------------------------------
// HEIF / AVIF and JPEG XL (ISO base media boxes)

// The boxes in bytes[start, end): { type, start, data, end }, or null.
function boxes(bytes, start, end) {
  const list = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = be32(bytes, pos);
    const type = fourcc(bytes, pos + 4);
    let data = pos + 8;
    if (size == 1) {
      if (pos + 16 > end || be32(bytes, pos + 8) != 0) {
        return null;
      }
      size = be32(bytes, pos + 12);
      data = pos + 16;
    } else if (size == 0) {
      size = end - pos;
    }
    if (size < data - pos || pos + size > end) {
      return null;
    }
    list.push({ type, start: pos, data, end: pos + size });
    pos += size;
  }
  return list;
}

function readUint(bytes, at, size) {
  let v = 0;
  for (let i = 0; i < size; i++) {
    v = v * 256 + bytes[at + i];
  }
  return v;
}

function heif(bytes, run) {
  const top = boxes(bytes, 0, bytes.length);
  if (!top || top[0]?.type != "ftyp") {
    return null;
  }
  const out = new Uint8Array(bytes);
  let changed = false;
  const meta = top.find(b => b.type == "meta");
  if (meta) {
    const children = boxes(bytes, meta.data + 4, meta.end);
    if (!children) {
      return null;
    }
    const iinf = children.find(b => b.type == "iinf");
    const iloc = children.find(b => b.type == "iloc");
    const idat = children.find(b => b.type == "idat");
    const items = iinf && iloc ? heifItems(bytes, iinf, iloc) : null;
    if (iinf && iloc && !items) {
      return null;
    }
    for (const item of items ?? []) {
      if (item.kind == null) {
        continue;
      }
      // Where its bytes are: in the file, or in idat.
      const base = item.method == 0 ? 0 : item.method == 1 && idat ? idat.data : -1;
      if (base < 0 || item.ref) {
        if (run.hit("other") || run.any) {
          return null; // Can't reach it: the file passes through.
        }
        continue;
      }
      const ranges = item.extents.map(e => [base + item.base + e.offset, e.length]);
      if (ranges.some(([at, n]) => at + n > bytes.length)) {
        return null;
      }
      const data = concat(ranges.map(([at, n]) => bytes.subarray(at, at + n)));
      let result = null;
      if (item.kind == "exif") {
        if (data.length < 4) {
          continue;
        }
        const tiffAt = 4 + be32(data, 0);
        if (tiffAt > data.length) {
          continue;
        }
        const tiff = exifInPlace(data.subarray(tiffAt), run);
        if (tiff) {
          result = new Uint8Array(data);
          result.set(tiff, tiffAt);
        }
      } else {
        const xmp = filterXmp(data, run, true);
        if (!xmp) {
          if (run.hit("other") || run.any) {
            result = pad(new TextEncoder().encode(EMPTY_XMP), data.length) ?? new Uint8Array(data.length).fill(0x20);
          }
        } else if (xmp.changed) {
          result = xmp.out ?? pad(new TextEncoder().encode(EMPTY_XMP), data.length) ?? new Uint8Array(data.length).fill(0x20);
        }
      }
      if (result && !same(result, data)) {
        changed = true;
        let at = 0;
        for (const [start, n] of ranges) {
          out.set(result.subarray(at, at + n), start);
          at += n;
        }
      }
    }
  }
  // A sequence's movie user data (©xyz is where it was taken).
  const moov = top.find(b => b.type == "moov");
  if (moov) {
    const blank = (list, depth) => {
      for (const box of list ?? []) {
        if (box.type == "udta" || (box.type == "meta" && depth > 0)) {
          const slice = bytes.subarray(box.start, box.end);
          const location = contains(slice, "\xa9xyz") || contains(slice, "location");
          if (location) {
            run.hit("location");
          }
          const other = run.hit("other");
          if (other || (location && run.cats.location)) {
            changed = true;
            out.set(ascii("free"), box.start + 4);
            out.fill(0, box.data, box.end);
          }
        } else if (box.type == "trak" || box.type == "moov") {
          blank(boxes(bytes, box.data, box.end), depth + 1);
        }
      }
    };
    blank([moov], 0);
  }
  return changed && !same(out, bytes) ? out : null;
}

// The Exif and XMP items, with where their bytes are.
function heifItems(bytes, iinf, iloc) {
  const kinds = new Map();
  const v = bytes[iinf.data];
  const first = iinf.data + 4 + (v == 0 ? 2 : 4);
  for (const infe of boxes(bytes, first, iinf.end) ?? []) {
    if (infe.type != "infe") {
      continue;
    }
    const version = bytes[infe.data];
    if (version < 2) {
      continue;
    }
    let at = infe.data + 4;
    const id = version == 2 ? (bytes[at] << 8) | bytes[at + 1] : be32(bytes, at);
    at += (version == 2 ? 2 : 4) + 2;
    const type = fourcc(bytes, at);
    at += 4;
    const nameEnd = bytes.indexOf(0, at);
    if (nameEnd < 0 || nameEnd >= infe.end) {
      return null;
    }
    if (type == "Exif") {
      kinds.set(id, "exif");
    } else if (type == "mime") {
      const typeEnd = bytes.indexOf(0, nameEnd + 1);
      const content = String.fromCharCode(...bytes.subarray(nameEnd + 1, typeEnd < 0 || typeEnd > infe.end ? infe.end : typeEnd));
      if (content == "application/rdf+xml") {
        kinds.set(id, "xmp");
      }
    }
  }
  const version = bytes[iloc.data];
  let at = iloc.data + 4;
  const offsetSize = bytes[at] >> 4;
  const lengthSize = bytes[at] & 15;
  const baseSize = bytes[at + 1] >> 4;
  const indexSize = version == 1 || version == 2 ? bytes[at + 1] & 15 : 0;
  at += 2;
  const count = version < 2 ? (bytes[at] << 8) | bytes[at + 1] : be32(bytes, at);
  at += version < 2 ? 2 : 4;
  const items = [];
  for (let i = 0; i < count; i++) {
    if (at > iloc.end) {
      return null;
    }
    const id = version < 2 ? (bytes[at] << 8) | bytes[at + 1] : be32(bytes, at);
    at += version < 2 ? 2 : 4;
    let method = 0;
    if (version == 1 || version == 2) {
      method = bytes[at + 1] & 15;
      at += 2;
    }
    const ref = (bytes[at] << 8) | bytes[at + 1];
    at += 2;
    const base = readUint(bytes, at, baseSize);
    at += baseSize;
    const extentCount = (bytes[at] << 8) | bytes[at + 1];
    at += 2;
    const extents = [];
    for (let k = 0; k < extentCount; k++) {
      at += indexSize;
      const offset = readUint(bytes, at, offsetSize);
      at += offsetSize;
      const length = readUint(bytes, at, lengthSize);
      at += lengthSize;
      extents.push({ offset, length });
    }
    if (at > iloc.end) {
      return null;
    }
    items.push({ id, kind: kinds.get(id) ?? null, method, ref, base, extents });
  }
  // An item with no location entry has no bytes in this file.
  return items;
}

function jxl(bytes, run) {
  if (!startsWith(bytes, 0, JXL_SIGNATURE)) {
    return null;
  }
  const list = boxes(bytes, 0, bytes.length);
  if (!list) {
    return null;
  }
  const parts = [];
  let changed = false;
  for (const box of list) {
    const whole = bytes.subarray(box.start, box.end);
    if (box.type == "Exif" && box.end - box.data >= 4) {
      const data = bytes.subarray(box.data, box.end);
      const tiffAt = 4 + be32(data, 0);
      const tiff = data.subarray(Math.min(tiffAt, data.length));
      const result = exifBlock(tiff, run);
      if (result !== tiff) {
        changed = true;
        if (result) {
          parts.push(isoBox("Exif", concat([data.subarray(0, tiffAt), result])));
        }
        continue;
      }
    } else if (box.type == "xml ") {
      const result = filterXmp(bytes.subarray(box.data, box.end), run);
      if (!result) {
        if (run.hit("other") || run.any) {
          changed = true;
          continue;
        }
      } else if (result.changed) {
        changed = true;
        if (result.out) {
          parts.push(isoBox("xml ", result.out));
        }
        continue;
      }
    } else if (box.type == "brob") {
      // Brotli-compressed metadata: it can't be read here.
      run.hit("other");
      if (run.any) {
        changed = true;
        continue;
      }
    }
    parts.push(whole);
  }
  return changed ? rebuilt(parts, bytes) : null;
}

function isoBox(type, data) {
  const n = data.length + 8;
  return concat([new Uint8Array([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...ascii(type)]), data]);
}

// ---------------------------------------------------------------------------

/** The format `bytes` are in, by their signature, or null. */
export function formatOf(bytes) {
  if (startsWith(bytes, 0, JPEG_SOI)) {
    return "jpeg";
  }
  if (startsWith(bytes, 0, PNG_SIGNATURE)) {
    return "png";
  }
  if (bytes.length >= 12 && fourcc(bytes, 0) == "RIFF" && fourcc(bytes, 8) == "WEBP") {
    return "webp";
  }
  if (startsWith(bytes, 0, ascii("GIF8"))) {
    return "gif";
  }
  if (startsWith(bytes, 0, [0x49, 0x49, 0x2a, 0]) || startsWith(bytes, 0, [0x4d, 0x4d, 0, 0x2a])) {
    return "tiff";
  }
  if (startsWith(bytes, 0, JXL_SIGNATURE)) {
    return "jxl";
  }
  if (bytes.length >= 12 && fourcc(bytes, 4) == "ftyp") {
    return "heif";
  }
  return null;
}

const STRIPPERS = { jpeg, png, webp, gif, tiff: tiffFile, heif, jxl };

function normalized(cats) {
  return Object.fromEntries(CATEGORIES.map(c => [c, !!cats?.[c]]));
}

/**
 * The image's bytes without the details `cats` names (all four when left
 * out), or null to keep the original (nothing to remove, or a file this
 * can't change safely). `found`, a Set, collects the kinds the file has.
 */
export function stripImageMetadata(input, cats = ALL, found = null) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const format = formatOf(bytes);
  if (!format) {
    return null;
  }
  try {
    return STRIPPERS[format](bytes, new Run(normalized(cats), found));
  } catch (e) {
    console.error("Whimsy: reading photo details failed", e);
    return null;
  }
}

/** The kinds of details the image carries (a Set of CATEGORIES). */
export function inspectImageMetadata(input) {
  const found = new Set();
  stripImageMetadata(input, ALL, found);
  return found;
}

// A file's bytes, in this module's global. A page's file (with its window)
// is read by the page's own FileReader, then copied over.
async function readBytes(file, win) {
  if (!win) {
    return new Uint8Array(await file.arrayBuffer());
  }
  const reader = new win.FileReader();
  await new Promise((resolve, reject) => {
    reader.onload = () => resolve();
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
  return new Uint8Array(Cu.cloneInto(reader.result, {}));
}

export const WhimsyImageMetadata = {
  PREF,
  ASK_PREF,
  CATEGORIES,
  DEFAULTS,

  /** Whether stripping is on: the setting, and at least one kind ticked. */
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(PREF, false) && CATEGORIES.some(c => this.categories[c]);
  },

  /** The kinds Settings removes ({ location, camera, date, other }). */
  get categories() {
    return Object.fromEntries(CATEGORIES.map(c => [c, Services.prefs.getBoolPref(`${PREF}.${c}`, DEFAULTS[c])]));
  },

  /** Whether to ask before each upload that has details to remove. */
  get ask() {
    return Services.prefs.getBoolPref(ASK_PREF, true);
  },

  /** Whether `file` might carry metadata this removes (by its type or name; the bytes decide). */
  candidate(file) {
    if (!file || typeof file.size != "number" || file.size < 8 || file.size > MAX_BYTES) {
      return false;
    }
    return (
      /^image\/(jpeg|pjpeg|png|apng|webp|gif|tiff|heic|heif|heic-sequence|heif-sequence|avif|avif-sequence|jxl)$/i.test(file.type ?? "") ||
      /\.(jpe?g|jpe|jfif|png|apng|webp|gif|tiff?|heic|heif|hif|avif|jxl)$/i.test(file.name ?? "")
    );
  },

  /**
   * Reads each candidate file once and notes what it carries. Resolves to
   * { entries: [{ file, bytes, found }], kinds: { location: n, … }, count }:
   * `count` photos carry something, `kinds` counts the photos with each.
   */
  async inspectFiles(files, win = null) {
    const entries = await Promise.all(
      [...files].map(async file => {
        if (!this.candidate(file)) {
          return { file, bytes: null, found: new Set() };
        }
        try {
          const bytes = await readBytes(file, win);
          return { file, bytes, found: inspectImageMetadata(bytes) };
        } catch (e) {
          console.error("Whimsy: reading a photo failed", e);
          return { file, bytes: null, found: new Set() };
        }
      })
    );
    const kinds = Object.fromEntries(CATEGORIES.map(c => [c, entries.filter(e => e.found.has(c)).length]));
    return { entries, kinds, count: entries.filter(e => e.found.size).length };
  },

  /** The files to upload for inspected `entries` with `cats` removed (originals where nothing changes). */
  stripEntries(entries, cats) {
    return entries.map(({ file, bytes, found }) => {
      if (!bytes || !found.size) {
        return file;
      }
      const out = stripImageMetadata(bytes, cats);
      return out ? new File([out], file.name, { type: file.type, lastModified: file.lastModified }) : file;
    });
  },

  /**
   * W29: the files to upload in place of `files`, or null when the upload
   * is cancelled. Photos with details lose the kinds Settings ticks; with
   * "Ask before each upload" on, `ask({ count, kinds })` (the sheet) picks
   * them instead and resolves to { location, camera, date, other }, or null
   * to cancel. With nothing to remove, the originals come back as they
   * were. Never throws.
   */
  async filesToUpload(files, win = null, ask = null) {
    const list = [...files];
    if (!this.enabled || !list.some(f => this.candidate(f))) {
      return list;
    }
    try {
      const scan = await this.inspectFiles(list, win);
      if (!scan.count) {
        return list;
      }
      let cats = this.categories;
      if (ask && this.ask) {
        const choice = await ask({ count: scan.count, kinds: scan.kinds });
        if (!choice) {
          return null;
        }
        cats = Object.fromEntries(CATEGORIES.map(c => [c, !!choice[c]]));
      }
      if (!CATEGORIES.some(c => cats[c])) {
        return list;
      }
      return this.stripEntries(scan.entries, cats);
    } catch (e) {
      console.error("Whimsy: removing photo details failed", e);
      return list;
    }
  },

  /**
   * The file to upload in place of `file`: a copy without the details `cats`
   * names (Settings' kinds when left out), with the same name, type, and
   * date, or `file` itself when there's nothing to remove (or the setting is
   * off). Never throws.
   */
  async stripFile(file, win = null, cats = null) {
    if (!this.enabled || !this.candidate(file)) {
      return file;
    }
    try {
      const bytes = await readBytes(file, win);
      const out = stripImageMetadata(bytes, cats ?? this.categories);
      if (!out) {
        return file;
      }
      return new File([out], file.name, { type: file.type, lastModified: file.lastModified });
    } catch (e) {
      console.error("Whimsy: removing photo details failed", e);
      return file;
    }
  },

  /** stripFile for each (a page's files with its `win`); resolves to null when none changed. */
  async stripFiles(files, win = null, cats = null) {
    const list = [...files];
    const out = await Promise.all(list.map(f => this.stripFile(f, win, cats)));
    return out.some((f, i) => f !== list[i]) ? out : null;
  },
};
