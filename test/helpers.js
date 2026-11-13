'use strict';
// Synthetic films for tests: no real subtitle files are needed or stored in this repository.
const S = require('../lib/sync');

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

// A film's dialogue: bursts of lines separated by pauses, like real speech.
function film(seed = 1, minutes = 110, text = 'Hello there') {
  const r = rng(seed), cues = [];
  let t = 30000 + r() * 60000;
  while (t < minutes * 60000) {
    const lines = 1 + Math.floor(r() * 12);
    for (let i = 0; i < lines; i++) {
      const d = 900 + r() * 3200;
      cues.push({ start: Math.round(t), end: Math.round(t + d), text });
      t += d + 80 + r() * 900;
    }
    t += 2000 + r() * r() * 60000;
  }
  return cues;
}

// A translation of the same film: some lines merged, some dropped, edges slightly different.
// Every line carries its own number, so a repaired line can be compared with the same line in
// the correct version, not just with whichever line happens to be nearest.
function translate(cues, seed = 7, text = 'Γειά σου κόσμε') {
  const r = rng(seed), out = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i], n = cues[i + 1], label = `${text} #${i}`;
    if (r() < 0.08) continue;
    if (n && r() < 0.15 && n.start - c.end < 1500) { out.push({ start: c.start, end: n.end, text: label }); i++; continue; }
    out.push({ start: Math.round(c.start + (r() - 0.5) * 400), end: Math.round(c.end + (r() - 0.5) * 400), text: label });
  }
  return out;
}

const warp = (cues, f) => cues.map((c) => ({ start: f(c.start), end: f(c.end), text: c.text })).filter((c) => c.end > 0);

// How far each repaired line is from the same line in the correct version.
function error(got, want) {
  const where = new Map(want.map((c) => [c.text, c.start]));
  const errs = got.filter((c) => where.has(c.text)).map((c) => Math.abs(c.start - where.get(c.text))).sort((a, b) => a - b);
  if (!errs.length) return { median: Infinity, p95: Infinity, max: Infinity, over1s: Infinity, lines: 0 };
  return {
    median: errs[errs.length >> 1],
    p95: errs[Math.floor(errs.length * 0.95)],
    max: errs[errs.length - 1],
    over1s: errs.filter((e) => e > 1000).length,
    lines: errs.length,
  };
}

module.exports = { film, translate, warp, error, srt: S.toSrt };
