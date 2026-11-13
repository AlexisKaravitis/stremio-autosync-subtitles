'use strict';
// Reads files out of a ZIP archive. Some subtitle sites only hand out subtitles zipped.
// No dependencies: the ZIP layout is simple and Node already knows how to inflate.
// The archive comes from the internet, so nothing in it is trusted: every offset and length is
// checked against the buffer, sizes are enforced, and each file's checksum is verified.
const zlib = require('zlib');

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const bad = (why) => new Error(`damaged zip file (${why})`);

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// The record at the very end that says where the list of files is. The same four bytes can
// occur inside an archive's comment, so a candidate only counts if its own numbers add up.
function findEnd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) !== EOCD) continue;
    const dirSize = buf.readUInt32LE(i + 12), dirAt = buf.readUInt32LE(i + 16), comment = buf.readUInt16LE(i + 20);
    // the comment must run exactly to the end of the file, and the list of files exactly up to this record
    if (i + 22 + comment === buf.length && dirAt + dirSize === i) return { count: buf.readUInt16LE(i + 10), dirAt, dirEnd: dirAt + dirSize };
  }
  throw new Error('not a zip file');
}

// Lists the archive's files: [{ name, size, read() }]. `read` returns the file's bytes or throws.
function entries(buf, maxBytes = 3 * 1024 * 1024) {
  if (buf.length < 22) throw new Error('not a zip file');
  const { count, dirAt, dirEnd } = findEnd(buf);
  if (count === 0xffff || dirAt === 0xffffffff) throw new Error('unsupported zip file (too large)');
  const out = [];
  let at = dirAt;
  for (let n = 0; n < count; n++) {
    if (at + 46 > dirEnd || buf.readUInt32LE(at) !== CENTRAL) throw bad('file list');
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16), packed = buf.readUInt32LE(at + 20), size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    if (at + 46 + nameLen + extraLen + commentLen > dirEnd) throw bad('file list');
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // a folder
    out.push({
      name, size,
      read() {
        if (flags & 1) throw new Error('encrypted zip entry');
        if (size > maxBytes) throw new Error('file too large');
        // the local header repeats the name; its own lengths say where the data starts
        if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw bad('file header');
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        if (start + packed > dirAt) throw bad('file data');
        const data = buf.subarray(start, start + packed);
        let plain;
        if (method === 0) {
          if (packed !== size) throw bad('stored size');
          plain = Buffer.from(data);
        } else if (method === 8) {
          try { plain = zlib.inflateRawSync(data, { maxOutputLength: maxBytes }); } catch { throw bad('compressed data'); }
        } else {
          throw new Error('unsupported zip compression');
        }
        if (plain.length !== size || crc32(plain) !== crc) throw bad('checksum');
        return plain;
      },
    });
  }
  return out;
}

// Builds a ZIP with one or more files. Used by the tests; small and unoptimised.
// `store: true` writes the files uncompressed.
function build(files, { store = false } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content), packed = store ? data : zlib.deflateRawSync(data), nm = Buffer.from(name, 'utf8');
    const crc = crc32(data), method = store ? 0 : 8;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOCAL, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nm.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CENTRAL, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(method, 10);
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

module.exports = { entries, build, crc32 };
