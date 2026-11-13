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
function translate(cues, seed = 7, text = 'Γειά σου κόσμε') {
  const r = rng(seed), out = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i], n = cues[i + 1];
    if (r() < 0.08) continue;
    if (n && r() < 0.15 && n.start - c.end < 1500) { out.push({ start: c.start, end: n.end, text }); i++; continue; }
    out.push({ start: Math.round(c.start + (r() - 0.5) * 400), end: Math.round(c.end + (r() - 0.5) * 400), text });
  }
  return out;
}

const warp = (cues, f) => cues.map((c) => ({ start: f(c.start), end: f(c.end), text: c.text })).filter((c) => c.end > 0);

// Median and 95th-percentile distance between repaired cues and where they belong.
function error(got, want) {
  const starts = want.map((c) => c.start);
  const errs = got.map((c) => Math.min(...starts.map((s) => Math.abs(s - c.start)))).sort((a, b) => a - b);
  return { median: errs[errs.length >> 1], p95: errs[Math.floor(errs.length * 0.95)] };
}

module.exports = { film, translate, warp, error, srt: S.toSrt };
