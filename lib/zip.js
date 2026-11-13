'use strict';
// Reads files out of a ZIP archive. Some subtitle sites only hand out subtitles zipped.
// No dependencies: the ZIP layout is simple and Node already knows how to inflate.
const zlib = require('zlib');

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

// Lists the archive's entries: [{ name, size, read() }]. Throws on anything that is not a
// plain ZIP (encrypted, split across disks, truncated).
function entries(buf, maxBytes = 3 * 1024 * 1024) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = [];
  for (let n = 0; n < count && n < 500; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) throw new Error('damaged zip file');
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20), size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // a folder
    out.push({
      name, size,
      read() {
        if (flags & 1) throw new Error('encrypted zip entry');
        if (size > maxBytes) throw new Error('file too large');
        if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new Error('damaged zip file');
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + packed);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: maxBytes });
        throw new Error('unsupported zip compression');
      },
    });
  }
  return out;
}

// Builds a ZIP with one or more files. Used by the tests; small and unoptimised.
function build(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content), packed = zlib.deflateRawSync(data), nm = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOCAL, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nm.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CENTRAL, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nm.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(head, nm, packed);
    centrals.push(cen, nm);
    offset += 30 + nm.length + packed.length;
  }
  const dir = Buffer.concat(centrals), tail = Buffer.alloc(22);
  tail.writeUInt32LE(EOCD, 0); tail.writeUInt16LE(centrals.length / 2, 8); tail.writeUInt16LE(centrals.length / 2, 10);
  tail.writeUInt32LE(dir.length, 12); tail.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, tail]);
}

module.exports = { entries, build };
