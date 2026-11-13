'use strict';
// The zip reader is fed files from the internet, so these tests are mostly about bad input.
const test = require('node:test');
const assert = require('node:assert');
const Z = require('../lib/zip');
const SubDL = require('../lib/subdl');

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nΓειά\n';
const good = Z.build({ 'notes.txt': 'x', 'dir/Film.srt': SRT });

test('reads compressed and stored files, and lists them by name', () => {
  const es = Z.entries(good);
  assert.deepStrictEqual(es.map((e) => e.name), ['notes.txt', 'dir/Film.srt']);
  assert.strictEqual(es[1].read().toString(), SRT);
  assert.strictEqual(Z.entries(Z.build({ 's.srt': SRT }, { store: true }))[0].read().toString(), SRT);
  assert.strictEqual(Z.crc32(Buffer.from('123456789')), 0xcbf43926); // the standard check value
});

test('refuses what is not an archive, is cut short, or is too large', () => {
  assert.throws(() => Z.entries(Buffer.from('this is not an archive, just some text')), /not a zip/);
  assert.throws(() => Z.entries(Buffer.alloc(5)), /not a zip/);
  assert.throws(() => Z.entries(good.subarray(0, good.length - 30)), /zip/);
  assert.throws(() => Z.entries(Z.build({ 'big.srt': 'x'.repeat(5000) }), 1000)[0].read(), /too large/);
});

test('a file whose contents were damaged is refused, not returned', () => {
  const stored = Z.build({ 's.srt': SRT }, { store: true });
  const at = stored.indexOf(Buffer.from('00:00:01'));
  const damaged = Buffer.from(stored);
  damaged[at] ^= 0x01; // one flipped bit in the text
  assert.throws(() => Z.entries(damaged)[0].read(), /checksum/);
});

test('sizes in the archive that do not match its data are refused', () => {
  const stored = Z.build({ 's.srt': SRT }, { store: true });
  const dir = stored.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const lying = Buffer.from(stored);
  lying.writeUInt32LE(10, dir + 24); // claims the file is 10 bytes
  assert.throws(() => Z.entries(lying)[0].read(), /damaged/);
  const encrypted = Buffer.from(good);
  const dir2 = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encrypted.writeUInt16LE(encrypted.readUInt16LE(dir2 + 8) | 1, dir2 + 8);
  assert.throws(() => Z.entries(encrypted)[0].read(), /encrypted/);
});

test('an end-of-archive marker inside the comment is not mistaken for the real one', () => {
  const fake = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]); // looks like an (empty) ending
  const withComment = Buffer.concat([good.subarray(0, good.length - 2), Buffer.from([fake.length, 0]), fake]);
  assert.deepStrictEqual(Z.entries(withComment).map((e) => e.name), ['notes.txt', 'dir/Film.srt']);
});

test('picking the subtitle: the largest .srt that reads correctly; an archive without one is refused for good', () => {
  const two = Z.build({ 'small.srt': SRT, 'big.srt': SRT.repeat(20), 'x.ass': 'y'.repeat(9000) });
  assert.strictEqual(SubDL.unpack(two, 1e6).toString(), SRT.repeat(20));
  // damage the big one: the small one is used instead
  const damaged = Buffer.from(two);
  const dir = damaged.indexOf(Buffer.from('big.srt'), damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))) - 46;
  damaged.writeUInt32LE((damaged.readUInt32LE(dir + 16) ^ 1) >>> 0, dir + 16); // wrong checksum for big.srt
  assert.strictEqual(SubDL.unpack(damaged, 1e6).toString(), SRT);
  for (const bad of [Z.build({ 'only.ass': 'x' }), Z.build({ 'empty.srt': '' }), Buffer.from('nonsense')]) {
    assert.throws(() => SubDL.unpack(bad, 1e6), (e) => e.fatal === true);
  }
});

test('random damage never crashes the reader and never yields wrong contents', () => {
  const originals = new Set([SRT, 'x']);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 4000; i++) {
    const b = Buffer.from(good);
    for (let k = 1 + Math.floor(rnd() * 3); k > 0; k--) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    const cut = rnd() < 0.2 ? b.subarray(0, Math.floor(rnd() * b.length)) : b;
    try {
      for (const e of Z.entries(cut)) {
        try { assert.ok(originals.has(e.read().toString()), 'damaged contents were returned as good'); } catch (err) { if (err.code === 'ERR_ASSERTION') throw err; assert.ok(err instanceof Error); }
      }
    } catch (err) { if (err.code === 'ERR_ASSERTION') throw err; assert.ok(err instanceof Error); }
  }
});
