"use strict";
// A minimal flatbuffer writer, for the catalogues our server publishes.
//
// The client parses these files with generated code, so the layout must be exact. The rules used
// here are the format's own: a buffer is written from the end backwards, every offset is measured
// from the start of the buffer, a table starts with a signed offset back to its vtable, and a
// vtable holds the field offsets relative to the table start.
//
// Only what our catalogues need is supported: strings, uint8/bool/uint16/uint32/int32 scalars,
// tables and vectors of table offsets. Bigger scalars are deliberately absent - an unused primitive
// is a silent way to write a wrong width.
const IDENTIFIER_BYTES = 4;

class FlatbufferBuilder {
  constructor(size = 8192) {
    this.buffer = Buffer.alloc(size);
    this.head = size;
    this.vtable = null;
    this.objectStart = 0;
    this.minAlign = 1;
  }

  offset() {
    return this.buffer.length - this.head;
  }

  _grow(needed) {
    if (this.head >= needed) return;
    const grown = Buffer.alloc(this.buffer.length * 2);
    this.buffer.copy(grown, this.buffer.length - this.head + (grown.length - this.buffer.length));
    // copying a backwards buffer: keep the written part at the end
    grown.fill(0);
    this.buffer.copy(grown, grown.length - (this.buffer.length - this.head));
    this.head = grown.length - (this.buffer.length - this.head);
    this.buffer = grown;
  }

  _prep(size, extra) {
    if (size > this.minAlign) this.minAlign = size;
    const alignSize = ((~(this.offset() + extra)) + 1) & (size - 1);
    const needed = this.head - alignSize - size;
    if (needed < 0) this._grow(this.buffer.length * 2);
    this._pad(alignSize);
  }

  _pad(count) {
    for (let index = 0; index < count; index += 1) this._writeByte(0);
  }

  _writeByte(value) {
    if (this.head < 1) this._grow(this.buffer.length * 2);
    this.head -= 1;
    this.buffer[this.head] = value & 0xff;
  }

  _writeBytes(bytes) {
    if (this.head < bytes.length) this._grow(this.buffer.length * 2);
    this.head -= bytes.length;
    bytes.copy(this.buffer, this.head);
  }

  _writeUint16(value) {
    if (this.head < 2) this._grow(this.buffer.length * 2);
    this.head -= 2;
    this.buffer.writeUInt16LE(value & 0xffff, this.head);
  }

  _writeInt32(value) {
    if (this.head < 4) this._grow(this.buffer.length * 2);
    this.head -= 4;
    this.buffer.writeInt32LE(value | 0, this.head);
  }

  _writeUint32(value) {
    if (this.head < 4) this._grow(this.buffer.length * 2);
    this.head -= 4;
    this.buffer.writeUInt32LE(value >>> 0, this.head);
  }

  _writeUint64(value) {
    if (this.head < 8) this._grow(this.buffer.length * 2);
    this.head -= 8;
    this.buffer.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value || 0)), this.head);
  }

  // A uoffset points forward: its value is the distance from where it is written to its target.
  _writeUoffset(targetOffset) {
    this._prep(4, 0);
    this._writeInt32(this.offset() - targetOffset + 4);
  }

  createString(value) {
    const bytes = Buffer.from(String(value == null ? "" : value), "utf8");
    this._prep(4, bytes.length + 1);
    this._writeByte(0);
    this._writeBytes(bytes);
    this._writeInt32(bytes.length);
    return this.offset();
  }

  createVectorOfOffsets(offsets) {
    const rows = Array.isArray(offsets) ? offsets : [];
    this._prep(4, rows.length * 4);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      this._writeUoffset(rows[index]);
    }
    this._writeInt32(rows.length);
    return this.offset();
  }

  createVectorOfStrings(values) {
    return this.createVectorOfOffsets((values || []).map((value) => this.createString(value)));
  }

  startTable(fieldCount) {
    this.vtable = new Array(Math.max(0, fieldCount)).fill(0);
    // the object ends where nothing has been written for it yet
    this.objectEnd = this.offset();
  }

  // A uoffset field: write the offset, then record where it landed.
  slot(index, valueOffset) {
    if (valueOffset === 0 || valueOffset == null) return;
    this._writeUoffset(valueOffset);
    this.vtable[index] = this.offset();
  }

  // A scalar field is written in place; there is no offset to follow. The width must match the
  // client's generated `Prepend<Type>Slot` for that field, or the reader decodes the wrong bytes.
  scalarSlot(index, value, width = "uint32") {
    const numeric = Number(value) || 0;
    if (width === "uint64" || width === "int64") {
      // 64-bit fields are what the achievement catalogue stores targets and reward quantities in;
      // written with a BigInt so a value above 2^53 cannot be silently rounded.
      this._prep(8, 0);
      this._writeUint64(numeric);
      this.vtable[index] = this.offset();
      return;
    }
    if (width === "uint8" || width === "bool") {
      this._prep(1, 0);
      this._writeByte(width === "bool" ? (numeric ? 1 : 0) : numeric);
      this.vtable[index] = this.offset();
      return;
    }
    if (width === "uint16") {
      this._prep(2, 0);
      this._writeUint16(numeric);
      this.vtable[index] = this.offset();
      return;
    }
    this._prep(4, 0);
    if (width === "int32") this._writeInt32(numeric);
    else this._writeUint32(numeric);
    this.vtable[index] = this.offset();
  }

  endTable() {
    this._writeInt32(0); // placeholder for the soffset back to the vtable
    const objectOffset = this.offset();
    let maxSlot = 0;
    for (let index = 0; index < this.vtable.length; index += 1) {
      if (this.vtable[index] !== 0) maxSlot = index + 1;
    }
    for (let index = maxSlot - 1; index >= 0; index -= 1) {
      const field = this.vtable[index];
      this._writeUint16(field ? objectOffset - field : 0);
    }
    this._writeUint16(objectOffset - this.objectEnd); // object size
    this._writeUint16(4 + maxSlot * 2); // vtable size
    const vtableOffset = this.offset();
    // The table start holds (vtable - table) so the reader can find its vtable.
    this.buffer.writeInt32LE(vtableOffset - objectOffset,
      this.buffer.length - objectOffset);
    this.vtable = null;
    return objectOffset;
  }

  finish(rootOffset, identifier = "") {
    // The identifier must sit at bytes 4..8, immediately after the root uoffset, so the buffer is
    // aligned to 4 before both are written.
    this._pad((4 - (this.offset() % 4)) % 4);
    if (identifier) this._writeBytes(Buffer.from(String(identifier), "utf8"));
    this._writeUoffset(rootOffset);
    return this.buffer.subarray(this.head);
  }
}

module.exports = {
  FlatbufferBuilder,
  IDENTIFIER_BYTES,
};
