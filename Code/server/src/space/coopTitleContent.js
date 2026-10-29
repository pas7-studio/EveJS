"use strict";
// Our own character-title definitions: the catalogue the client downloads.
//
// In New Eden this file comes from CCP's content pipeline; here it comes from us, because the
// game server is ours. The client asks the gateway for the latest checkpoint, downloads the
// buffer from that URL over HTTPS, verifies its CRC and parses a flatbuffer whose root is
// `TitleData` with a vector of `Title` tables:
//
//   Title { id: string (uuid hex), localized_name: string }
//
// The file identifier must be 'CHTI'. The buffer is assembled by hand (a few dozen bytes per
// title) because pulling a flatbuffer library into the server for one small table is not worth
// it; the layout below is the standard one and the tests read it back the way the client does.
const zlib = require("zlib");

const CDN_PATH = "/elysian-eve/titles/1.0.0.titles";
const CDN_URL = `https://127.0.0.1${CDN_PATH}`;
const VERSION = Object.freeze({ major: 1, minor: 0, patch: 0 });
const FILE_IDENTIFIER = "CHTI";

// Real titles a co-op pilot can earn. The ids are uuid hex strings, which is exactly what the
// client's TitleIdentifier.from_flatbuffer does uuid.UUID(<string>) on.
const TITLES = Object.freeze([
  { id: "0f1d2c3b4a5968778695a4b3c2d1e0f1", name: "Belt Breaker" },
  { id: "1a2b3c4d5e6f708192a3b4c5d6e7f809", name: "Hauler of the Reach" },
  { id: "2b3c4d5e6f708192a3b4c5d6e7f8091a", name: "Anomaly Hunter" },
  { id: "3c4d5e6f708192a3b4c5d6e7f8091a2b", name: "Founder" },
]);

function crc32(buffer) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buffer) >>> 0;
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      }
      table[index] = value;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

// Minimal flatbuffer writer: every segment is placed at an absolute position, so the offsets the
// client follows are plain arithmetic rather than a mutable builder.
function buildTitleData(titles = TITLES) {
  const align4 = (value) => (value + 3) & ~3;
  const parts = []; // {at, bytes}
  const place = (bytes) => {
    const at = align4(8 + parts.reduce((total, part) => total + part.bytes.length, 0));
    parts.push({ at, bytes });
    return at;
  };
  const padTo = (target) => {
    const end = 8 + parts.reduce((total, part) => total + part.bytes.length, 0);
    if (end < target) parts.push({ at: end, bytes: Buffer.alloc(target - end) });
  };

  // TitleData table (8 bytes) + its vtable (6 bytes).
  const tablePos = 8;
  const vtablePos = tablePos + 8;
  padTo(vtablePos);
  const rootTable = Buffer.alloc(8);
  const rootVtable = Buffer.alloc(6);
  rootVtable.writeUInt16LE(6, 0);
  rootVtable.writeUInt16LE(8, 2);
  rootVtable.writeUInt16LE(4, 4);
  rootTable.writeInt32LE(tablePos - vtablePos, 0);
  parts.push({ at: tablePos, bytes: rootTable });
  parts.push({ at: vtablePos, bytes: rootVtable });

  // vector of uoffsets
  const vectorAt = align4(vtablePos + 6);
  padTo(vectorAt);
  const vector = Buffer.alloc(4 + 4 * titles.length);
  vector.writeUInt32LE(titles.length, 0);
  parts.push({ at: vectorAt, bytes: vector });
  rootTable.writeUInt32LE(vectorAt - (tablePos + 4), 4);

  // one table + vtable per title, then its two strings
  const titlePositions = titles.map(() => ({ table: 0, idAt: 0, nameAt: 0 }));
  titles.forEach((title, index) => {
    const vtable = align4(8 + parts.reduce((total, part) => total + part.bytes.length, 0));
    padTo(vtable);
    const table = vtable + 8;
    const tableBytes = Buffer.alloc(12);
    const vtableBytes = Buffer.alloc(8);
    vtableBytes.writeUInt16LE(8, 0);
    vtableBytes.writeUInt16LE(12, 2);
    vtableBytes.writeUInt16LE(4, 4);
    vtableBytes.writeUInt16LE(8, 6);
    tableBytes.writeInt32LE(table - vtable, 0);
    parts.push({ at: vtable, bytes: vtableBytes });
    parts.push({ at: table, bytes: tableBytes });

    const stringFor = (value) => {
      const bytes = Buffer.from(String(value), "utf8");
      const at = align4(8 + parts.reduce((total, part) => total + part.bytes.length, 0));
      padTo(at);
      const wrapper = Buffer.alloc(4 + bytes.length + 1);
      wrapper.writeUInt32LE(bytes.length, 0);
      bytes.copy(wrapper, 4);
      parts.push({ at, bytes: wrapper });
      return at;
    };
    titlePositions[index].table = table;
    titlePositions[index].idAt = stringFor(title.id);
    titlePositions[index].nameAt = stringFor(title.name);

    tableBytes.writeUInt32LE(titlePositions[index].idAt - (table + 4), 4);
    tableBytes.writeUInt32LE(titlePositions[index].nameAt - (table + 8), 8);
    vector.writeUInt32LE(table - (vectorAt + 4 + index * 4), 4 + index * 4);
  });

  const total = align4(8 + parts.reduce((sum, part) => sum + part.bytes.length, 0));
  const buffer = Buffer.alloc(total);
  buffer.writeUInt32LE(tablePos, 0);
  buffer.write(FILE_IDENTIFIER, 4, "utf8");
  for (const part of parts) part.bytes.copy(buffer, part.at);
  return buffer;
}

let cached = null;

// The content is built once and reused: the URL, the CRC and the bytes must always describe the
// same file, or the client would download something that does not match the checkpoint.
function content() {
  if (!cached) {
    const buffer = buildTitleData();
    cached = Object.freeze({
      buffer,
      crc: crc32(buffer),
      version: VERSION,
      path: CDN_PATH,
      url: CDN_URL,
    });
  }
  return cached;
}

// The loopback CDN responder asks this for a route; anything else is not ours.
function getTitleContentAsset(routePath) {
  if (String(routePath || "") !== CDN_PATH) return null;
  return { buffer: content().buffer, contentType: "application/octet-stream" };
}

module.exports = {
  CDN_PATH,
  CDN_URL,
  FILE_IDENTIFIER,
  TITLES,
  VERSION,
  buildTitleData,
  content,
  crc32,
  getTitleContentAsset,
};
