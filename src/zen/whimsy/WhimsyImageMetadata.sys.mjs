/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W27: "Remove location and camera details from photos you upload"
// (Settings › Privacy & Security, whimsy.privacy.strip-image-metadata, off
// by default). Lossless: only metadata segments go; every other byte,
// including the compressed image data, is copied as is.
//
// - JPEG: drops APP1 (Exif, XMP), APP13 (Photoshop/IPTC), and COM. APP0
//   (JFIF), APP2 (ICC colour profile), APP14 (Adobe colour transform), the
//   tables, and everything from SOS on stay byte-identical. A photo turned
//   by its Exif Orientation keeps a minimal Exif APP1 holding only that tag,
//   so it still shows upright (rotating the pixels wouldn't be lossless).
// - PNG: drops eXIf, tEXt, iTXt, and zTXt chunks, keeping a minimal eXIf
//   with only the Orientation tag when it turns the image.
//
// Anything that isn't a well-formed JPEG or PNG passes through untouched.
// WhimsyUploadChild applies it to files chosen in file inputs and dropped
// on pages; WhimsyUploadParent to the clipboard and download files it
// uploads. Downloads themselves are never touched.

const PREF = "whimsy.privacy.strip-image-metadata";
const FEATURE_PREF = "whimsy.feature.photo-metadata";
// Larger files pass through rather than being read into memory.
const MAX_BYTES = 64 * 1024 * 1024;

const JPEG_SOI = [0xff, 0xd8];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const ORIENTATION_TAG = 0x0112;
const PNG_DROPPED = new Set(["eXIf", "tEXt", "iTXt", "zTXt"]);

function startsWith(bytes, at, sig) {
  if (at + sig.length > bytes.length) {
    return false;
  }
  return sig.every((b, i) => bytes[at + i] == b);
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

// The rebuilt file, or null when it's the same as the original (a photo
// stripped before keeps its one-tag Exif and comes out unchanged).
function rebuilt(parts, original) {
  const out = concat(parts);
  return out.length == original.length && out.every((b, i) => b == original[i]) ? null : out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A JPEG without its metadata segments, or null when nothing changes (or it isn't a JPEG). */
export function stripJpeg(bytes) {
  if (!startsWith(bytes, 0, JPEG_SOI)) {
    return null;
  }
  const len = bytes.length;
  const parts = [bytes.subarray(0, 2)];
  let changed = false;
  let pos = 2;
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
      // SOS (or an early EOI): the image data and the rest, byte for byte.
      parts.push(bytes.subarray(pos));
      pos = len;
      break;
    }
    if (marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(pos, m + 1));
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
    if (marker == 0xe1) {
      changed = true;
      const data = m + 3;
      if (startsWith(bytes, data, EXIF_ID)) {
        const orientation = orientationOf(bytes, data + EXIF_ID.length, end);
        if (orientation) {
          const payload = [...EXIF_ID, ...orientationTiff(orientation)];
          const length = payload.length + 2;
          parts.push(new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff, ...payload]));
        }
      }
    } else if (marker == 0xed || marker == 0xfe) {
      changed = true;
    } else {
      parts.push(bytes.subarray(pos, end));
    }
    pos = end;
  }
  return changed ? rebuilt(parts, bytes) : null;
}

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
  const body = new Uint8Array([...type].map(ch => ch.charCodeAt(0)).concat(data));
  const crc = crc32(body);
  const n = data.length;
  return concat([
    new Uint8Array([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]),
    body,
    new Uint8Array([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]),
  ]);
}

/** A PNG without its text and Exif chunks, or null when nothing changes (or it isn't a PNG). */
export function stripPng(bytes) {
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
    const size = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const end = pos + 12 + size;
    if (end > len) {
      return null;
    }
    if (PNG_DROPPED.has(type)) {
      changed = true;
      if (type == "eXIf") {
        const orientation = orientationOf(bytes, pos + 8, pos + 8 + size);
        if (orientation) {
          parts.push(pngChunk("eXIf", orientationTiff(orientation)));
        }
      }
    } else {
      parts.push(bytes.subarray(pos, end));
    }
    pos = end;
    if (type == "IEND") {
      parts.push(bytes.subarray(pos));
      break;
    }
  }
  return changed ? rebuilt(parts, bytes) : null;
}

/** The image's bytes without metadata, or null to keep the original (unchanged, or not a JPEG or PNG). */
export function stripImageMetadata(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return stripJpeg(bytes) ?? stripPng(bytes);
}

export const WhimsyImageMetadata = {
  PREF,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(PREF, false);
  },

  /** Whether `file` might carry metadata this removes (by its type or name; the bytes decide). */
  candidate(file) {
    if (!file || typeof file.size != "number" || file.size < 8 || file.size > MAX_BYTES) {
      return false;
    }
    return /^image\/(jpeg|pjpeg|png)$/i.test(file.type ?? "") || /\.(jpe?g|jfif|png)$/i.test(file.name ?? "");
  },

  /**
   * The file to upload in place of `file`: a copy without metadata, with the
   * same name, type, and date, or `file` itself when there's nothing to remove
   * (or the setting is off). Never throws.
   */
  async stripFile(file) {
    if (!this.enabled || !this.candidate(file)) {
      return file;
    }
    try {
      // A Blob made here reads a page's File (through its Xray) as our own.
      const bytes = new Uint8Array(await new Blob([file]).arrayBuffer());
      const out = stripImageMetadata(bytes);
      if (!out) {
        return file;
      }
      return new File([out], file.name, { type: file.type, lastModified: file.lastModified });
    } catch (e) {
      console.error("Whimsy: removing photo details failed", e);
      return file;
    }
  },

  /** stripFile for each; resolves to null when none changed. */
  async stripFiles(files) {
    const list = [...files];
    const out = await Promise.all(list.map(f => this.stripFile(f)));
    return out.some((f, i) => f !== list[i]) ? out : null;
  },
};
