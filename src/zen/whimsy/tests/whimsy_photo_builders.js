/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29: builds small photos in every format Whimsy strips, each carrying
// the same details, so a test can check what each box removes. Loaded by
// browser_whimsy_photo_details.js with loadSubScript.
//
// Every detail is a piece of text a test can look for in the bytes:
// - location: GPSAREA-Oakland (Exif GPS), 37,46.494N and XmpCityOakland
//   (XMP), IptcCityOakland (IPTC)
// - camera: WhimsyCam, Model-Z9, EditApp, SN12345, LensX, APPLE-MAKER
//   (Exif), XmpMakeCam and XmpToolApp (XMP), IptcProgApp (IPTC)
// - date: 2024:05:01 (Exif), 2023-01-02 (XMP), 20220303 (IPTC)
// - other: Ada Artist, Beach day caption, and Exif user note (Exif),
//   XmpCaptionText (XMP), IptcCaptionText (IPTC), COMMENT-TEXT (comments
//   and text chunks)
// - THUMBDATA: the Exif thumbnail
// What always stays: Orientation 6, the colour profile (ICCDATA-PROFILE),
// and the image data (SCANDATA, PIXELDATA).

const PHOTO_DETAILS = {
  location: ["GPSAREA-Oakland", "37,46.494N", "XmpCityOakland", "IptcCityOakland"],
  camera: ["WhimsyCam", "Model-Z9", "EditApp", "SN12345", "LensX", "APPLE-MAKER", "XmpMakeCam", "XmpToolApp", "IptcProgApp"],
  date: ["2024:05:01", "2023-01-02", "20220303"],
  other: ["Ada Artist", "Beach day caption", "Exif user note", "XmpCaptionText", "IptcCaptionText", "COMMENT-TEXT"],
};

const asciiBytes = text => [...text].map(ch => ch.charCodeAt(0) & 0xff);
const bytesOf = parts => {
  const list = parts.map(p => (typeof p == "string" ? asciiBytes(p) : [...p]));
  return new Uint8Array(list.flat());
};

function hasText(bytes, text) {
  const needle = asciiBytes(text);
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

// A TIFF structure (an Exif block, or a whole TIFF file). `spec`:
// { little, ifd0, exif, gps, ifd1, after } where each IFD is a list of
// { tag, type, value, target }: value is a string (ASCII), a Uint8Array
// (UNDEFINED, or `type`), or numbers (SHORT, or `type`: 4 LONG, 5
// RATIONAL pairs); `target` is "exif", "gps", or bytes the entry points at
// (written after the IFD, its offset patched in).
function buildTiff(spec) {
  const le = spec.little !== false;
  const out = [];
  const u16 = v => (le ? [v & 255, (v >> 8) & 255] : [(v >> 8) & 255, v & 255]);
  const u32 = v => (le ? [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24] : [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  const put = (at, list) => list.forEach((b, i) => (out[at + i] = b));
  const even = () => out.length & 1 && out.push(0);
  out.push(...(le ? [0x49, 0x49, 0x2a, 0] : [0x4d, 0x4d, 0, 0x2a]), 0, 0, 0, 0);
  const encode = e => {
    if (e.target) {
      return { type: 4, count: 1, bytes: [0, 0, 0, 0] };
    }
    if (typeof e.value == "string") {
      const b = [...asciiBytes(e.value), 0];
      return { type: 2, count: b.length, bytes: b };
    }
    if (e.value instanceof Uint8Array) {
      return { type: e.type ?? 7, count: e.value.length, bytes: [...e.value] };
    }
    const type = e.type ?? 3;
    const bytes = e.value.flatMap(v => (type == 3 ? u16(v) : u32(v)));
    return { type, count: type == 5 ? e.value.length / 2 : e.value.length, bytes };
  };
  const writeIfd = entries => {
    even();
    const at = out.length;
    const sorted = [...entries].sort((a, b) => a.tag - b.tag);
    out.push(...u16(sorted.length));
    const slots = sorted.map(() => {
      const slot = out.length;
      out.push(...new Array(12).fill(0));
      return slot;
    });
    const next = out.length;
    out.push(0, 0, 0, 0);
    sorted.forEach((e, i) => {
      const enc = encode(e);
      put(slots[i], [...u16(e.tag), ...u16(enc.type), ...u32(enc.count)]);
      if (enc.bytes.length <= 4) {
        put(slots[i] + 8, [...enc.bytes, 0, 0, 0, 0].slice(0, 4));
      } else {
        even();
        put(slots[i] + 8, u32(out.length));
        out.push(...enc.bytes);
      }
    });
    sorted.forEach((e, i) => {
      if (e.target instanceof Uint8Array) {
        even();
        put(slots[i] + 8, u32(out.length));
        out.push(...e.target);
      } else if (e.target) {
        const sub = writeIfd(spec[e.target]);
        put(slots[i] + 8, u32(sub.at));
      }
    });
    return { at, next };
  };
  const ifd0 = writeIfd(spec.ifd0);
  put(4, u32(ifd0.at));
  if (spec.ifd1) {
    const ifd1 = writeIfd(spec.ifd1);
    put(ifd0.next, u32(ifd1.at));
  }
  return new Uint8Array(out);
}

const THUMB = bytesOf([[0xff, 0xd8], "THUMBDATA", [0xff, 0xd9]]);

// The Exif a phone leaves: every kind of detail, Orientation 6, and a
// thumbnail.
function photoExifSpec(little = true) {
  return {
    little,
    ifd0: [
      { tag: 0x010e, value: "Beach day caption" },
      { tag: 0x010f, value: "WhimsyCam" },
      { tag: 0x0110, value: "Model-Z9" },
      { tag: 0x0112, value: [6] },
      { tag: 0x0131, value: "EditApp 2.0" },
      { tag: 0x0132, value: "2024:05:01 10:00:00" },
      { tag: 0x013b, value: "Ada Artist" },
      { tag: 0x8769, target: "exif" },
      { tag: 0x8825, target: "gps" },
    ],
    exif: [
      { tag: 0x9003, value: "2024:05:01 09:59:58" },
      { tag: 0x9286, value: bytesOf(["ASCII\0\0\0", "Exif user note"]) },
      { tag: 0x927c, value: bytesOf(["APPLE-MAKER-DATA-iOS"]) },
      { tag: 0xa431, value: "SN12345" },
      { tag: 0xa434, value: "LensX 50mm" },
    ],
    gps: [
      { tag: 0x0000, type: 1, value: new Uint8Array([2, 2, 0, 0]) },
      { tag: 0x0001, value: "N" },
      { tag: 0x0002, type: 5, value: [37, 1, 46, 1, 29, 1] },
      { tag: 0x001c, value: bytesOf(["ASCII\0\0\0", "GPSAREA-Oakland"]) },
    ],
    ifd1: [
      { tag: 0x0103, value: [6] },
      { tag: 0x0201, target: THUMB },
      { tag: 0x0202, type: 4, value: [THUMB.length] },
    ],
  };
}

function photoExif(little = true) {
  return buildTiff(photoExifSpec(little));
}

const PHOTO_XMP =
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" ' +
  'xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'exif:GPSLatitude="37,46.494N" photoshop:City="XmpCityOakland" tiff:Make="XmpMakeCam" xmp:CreatorTool="XmpToolApp" ' +
  'xmp:CreateDate="2023-01-02T03:04:05" tiff:Orientation="6">' +
  '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">XmpCaptionText</rdf:li></rdf:Alt></dc:description>' +
  "</rdf:Description></rdf:RDF></x:xmpmeta>" +
  " ".repeat(64) +
  '<?xpacket end="w"?>';

function photoXmp() {
  return bytesOf([PHOTO_XMP]);
}

// IPTC datasets, wrapped as Photoshop's image resource 0x0404.
function photoIptc() {
  const dataset = (record, number, text) => [0x1c, record, number, text.length >> 8, text.length & 255, ...asciiBytes(text)];
  return new Uint8Array([
    ...dataset(2, 0, "\0\x04"),
    ...dataset(2, 90, "IptcCityOakland"),
    ...dataset(2, 55, "20220303"),
    ...dataset(2, 65, "IptcProgApp"),
    ...dataset(2, 120, "IptcCaptionText"),
  ]);
}

function photoIrb() {
  const iptc = photoIptc();
  const n = iptc.length;
  return bytesOf(["8BIM", [0x04, 0x04, 0, 0, n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], iptc, n & 1 ? [0] : []]);
}

const ICC = bytesOf(["ICCDATA-PROFILE-0123456789"]);

function jpegSegment(marker, payload) {
  const n = payload.length + 2;
  return bytesOf([[0xff, marker, n >> 8, n & 255], payload]);
}

// The image itself: tables, a frame, and a scan (never parsed as pixels).
function jpegImage(tag = "SCANDATA") {
  return bytesOf([
    jpegSegment(0xdb, new Uint8Array(65).fill(1)),
    jpegSegment(0xc0, new Uint8Array([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0])),
    tag,
    [0x12, 0x34, 0xff, 0x00, 0x56],
    [0xff, 0xd9],
  ]);
}

// A JPEG with every detail: Exif, XMP, IPTC, and a comment (and `extra`
// segments before the image).
function photoJpeg({ exif = photoExif(), xmp = true, iptc = true, comment = true, extra = [], image = jpegImage() } = {}) {
  return bytesOf([
    [0xff, 0xd8],
    jpegSegment(0xe0, bytesOf(["JFIF\0", [1, 1, 0, 0, 1, 0, 1, 0, 0]])),
    exif ? jpegSegment(0xe1, bytesOf(["Exif\0\0", exif])) : [],
    jpegSegment(0xe2, bytesOf(["ICC_PROFILE\0", [1, 1], ICC])),
    xmp ? jpegSegment(0xe1, bytesOf(["http://ns.adobe.com/xap/1.0/\0", photoXmp()])) : [],
    iptc ? jpegSegment(0xed, bytesOf(["Photoshop 3.0\0", photoIrb()])) : [],
    comment ? jpegSegment(0xfe, bytesOf(["COMMENT-TEXT"])) : [],
    ...extra,
    image,
  ]);
}

// A multi-picture JPEG (an iPhone photo with its HDR gain map): the primary
// image with an MPF index, and a secondary image after its EOI with its
// own camera, GPS, and date details.
function photoMpf() {
  const secondary = photoJpeg({ xmp: false, iptc: false, comment: false, image: jpegImage("GAINMAP") });
  // The MPF index: version, two images, and their entries.
  const mpfTiff = little => {
    const entries = new Uint8Array(32);
    return buildTiff({
      little,
      ifd0: [
        { tag: 0xb000, value: bytesOf(["0100"]) },
        { tag: 0xb001, type: 4, value: [2] },
        { tag: 0xb002, value: entries },
      ],
    });
  };
  const index = mpfTiff(true);
  const primaryWith = idx => photoJpeg({ extra: [jpegSegment(0xe2, bytesOf(["MPF\0", idx]))] });
  let primary = primaryWith(index);
  // Where the MPF TIFF header is, and where its entries are.
  const tiffAt = findBytes(primary, bytesOf(["MPF\0"])) + 4;
  const entriesAt = tiffAt + findEntries(index);
  const set32 = (at, v) => {
    primary[at] = v & 255;
    primary[at + 1] = (v >>> 8) & 255;
    primary[at + 2] = (v >>> 16) & 255;
    primary[at + 3] = v >>> 24;
  };
  set32(entriesAt, 0x20030000);
  set32(entriesAt + 4, primary.length);
  set32(entriesAt + 8, 0);
  set32(entriesAt + 16, 0x00000000);
  set32(entriesAt + 20, secondary.length);
  set32(entriesAt + 24, primary.length - tiffAt);
  return bytesOf([primary, secondary]);
}

// Where the 32 bytes of MP entries are in an MPF TIFF built above.
function findEntries(tiff) {
  const ifd = tiff[4] | (tiff[5] << 8);
  const count = tiff[ifd] | (tiff[ifd + 1] << 8);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if ((tiff[e] | (tiff[e + 1] << 8)) == 0xb002) {
      return tiff[e + 8] | (tiff[e + 9] << 8) | (tiff[e + 10] << 16) | (tiff[e + 11] << 24);
    }
  }
  return -1;
}

function findBytes(bytes, needle, from = 0) {
  outer: for (let i = from; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] != needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// PNG

function crc32Of(bytes) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunkOf(type, data) {
  const body = bytesOf([type, data]);
  const crc = crc32Of(body);
  const n = data.length;
  return bytesOf([[n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], body, [crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]]);
}

function photoPng() {
  return bytesOf([
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunkOf("IHDR", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunkOf("iCCP", bytesOf(["icc\0\0", ICC])),
    pngChunkOf("eXIf", photoExif()),
    pngChunkOf("iTXt", bytesOf(["XML:com.adobe.xmp\0\0\0\0\0", photoXmp()])),
    pngChunkOf("tEXt", bytesOf(["Comment\0COMMENT-TEXT"])),
    pngChunkOf("tIME", new Uint8Array([7, 232, 5, 1, 10, 0, 0])),
    pngChunkOf("IDAT", bytesOf(["PIXELDATA"])),
    pngChunkOf("IEND", new Uint8Array()),
  ]);
}

// ---------------------------------------------------------------------------
// WebP

function riff(type, data) {
  const n = data.length;
  return bytesOf([type, [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24], data, n & 1 ? [0] : []]);
}

function photoWebp() {
  const body = bytesOf([
    "WEBP",
    riff("VP8X", new Uint8Array([0x2c, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    riff("ICCP", ICC),
    riff("VP8L", bytesOf(["/PIXELDATA"])),
    riff("EXIF", photoExif()),
    riff("XMP ", photoXmp()),
  ]);
  const n = body.length;
  return bytesOf(["RIFF", [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24], body]);
}

// ---------------------------------------------------------------------------
// GIF

function subBlocks(data) {
  const out = [];
  for (let i = 0; i < data.length; i += 255) {
    const piece = data.subarray(i, i + 255);
    out.push(piece.length, ...piece);
  }
  out.push(0);
  return out;
}

function photoGif() {
  const magic = [1];
  for (let i = 1; i < 257; i++) {
    magic.push(256 - i);
  }
  magic.push(0); // The block terminator.
  return bytesOf([
    "GIF89a",
    [1, 0, 1, 0, 0x80, 0, 0],
    [0, 0, 0, 255, 255, 255],
    [0x21, 0xff, 11],
    "NETSCAPE2.0",
    [3, 1, 0, 0, 0],
    [0x21, 0xfe],
    subBlocks(bytesOf(["COMMENT-TEXT"])),
    [0x21, 0xff, 11],
    "XMP DataXMP",
    photoXmp(),
    magic,
    [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0],
    [2],
    subBlocks(bytesOf(["PIXELDATA"])),
    [0x3b],
  ]);
}

// ---------------------------------------------------------------------------
// TIFF file: a one-strip image, with its tags, Exif, GPS, XMP, and IPTC.

function photoTiff(little = true) {
  const spec = photoExifSpec(little);
  const pixels = bytesOf(["PIXELDATA"]);
  spec.ifd0 = [
    { tag: 0x0100, value: [1] },
    { tag: 0x0101, value: [1] },
    { tag: 0x0102, value: [8, 8, 8] },
    { tag: 0x0103, value: [1] },
    { tag: 0x0106, value: [2] },
    { tag: 0x0111, target: pixels },
    { tag: 0x0115, value: [3] },
    { tag: 0x0116, value: [1] },
    { tag: 0x0117, type: 4, value: [pixels.length] },
    { tag: 0x02bc, type: 1, value: photoXmp() },
    { tag: 0x83bb, type: 7, value: photoIptc() },
    { tag: 0x8773, type: 7, value: ICC },
    ...spec.ifd0,
  ];
  delete spec.ifd1;
  return buildTiff(spec);
}

// ---------------------------------------------------------------------------
// HEIF / AVIF and JPEG XL

function box(type, ...data) {
  const body = bytesOf(data);
  const n = body.length + 8;
  return bytesOf([[n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], type, body]);
}

const fullBox = (type, version, ...data) => box(type, [version, 0, 0, 0], ...data);
const be16 = v => [(v >> 8) & 255, v & 255];
const be32b = v => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

// An Exif item payload: the offset to the TIFF header, "Exif\0\0", TIFF.
function exifPayload() {
  return bytesOf([be32b(6), "Exif\0\0", photoExif()]);
}

// A HEIF (brand "heic") or AVIF (brand "avif") image: the coded image, an
// Exif item, and an XMP item, all in mdat.
function photoHeif(brand = "heic") {
  const coded = brand == "avif" ? "av01" : "hvc1";
  const image = bytesOf(["PIXELDATA"]);
  const exif = exifPayload();
  const xmp = photoXmp();
  const infe = (id, type, name, extra = "") => fullBox("infe", 2, be16(id), be16(0), type, name, "\0", extra);
  const items = [
    [1, image],
    [2, exif],
    [3, xmp],
  ];
  const build = mdatStart => {
    let at = mdatStart + 8;
    const entries = items.map(([id, data]) => {
      const entry = [...be16(id), ...be16(0), 0, 1, ...be32b(at), ...be32b(data.length)];
      at += data.length;
      return entry;
    });
    const meta = fullBox(
      "meta",
      0,
      fullBox("hdlr", 0, be32b(0), "pict", new Uint8Array(12), "\0"),
      fullBox("pitm", 0, be16(1)),
      fullBox("iinf", 0, be16(3), infe(1, coded, "Image"), infe(2, "Exif", "Exif"), infe(3, "mime", "XMP", "application/rdf+xml\0")),
      fullBox("iloc", 0, [0x44, 0x00], be16(3), entries.flat())
    );
    const ftyp = box("ftyp", brand, be32b(0), "mif1", brand);
    return { ftyp, meta };
  };
  const first = build(0);
  const { ftyp, meta } = build(first.ftyp.length + first.meta.length);
  return bytesOf([ftyp, meta, box("mdat", image, exif, xmp)]);
}

function photoJxl() {
  return bytesOf([
    [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a],
    box("ftyp", "jxl ", be32b(0), "jxl "),
    box("Exif", be32b(0), photoExif()),
    box("xml ", photoXmp()),
    box("jxlc", [0xff, 0x0a], "PIXELDATA"),
  ]);
}

// The Orientation in the first TIFF structure in `bytes` (0 when none).
function orientationIn(bytes) {
  for (let at = 0; at + 8 <= bytes.length; at++) {
    const le = bytes[at] == 0x49 && bytes[at + 1] == 0x49 && bytes[at + 2] == 0x2a && bytes[at + 3] == 0;
    const be = bytes[at] == 0x4d && bytes[at + 1] == 0x4d && bytes[at + 2] == 0 && bytes[at + 3] == 0x2a;
    if (!le && !be) {
      continue;
    }
    const u16 = p => (le ? bytes[at + p] | (bytes[at + p + 1] << 8) : (bytes[at + p] << 8) | bytes[at + p + 1]);
    const u32 = p => (le ? u16(p) + u16(p + 2) * 65536 : u16(p) * 65536 + u16(p + 2));
    const ifd = u32(4);
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      if (u16(ifd + 2 + i * 12) == 0x0112) {
        return u16(ifd + 2 + i * 12 + 8);
      }
    }
    return 0;
  }
  return 0;
}
