'use strict';
// Subtitle parsing + timing alignment. No dependencies.
// All times are in milliseconds.

const BIN = 100; // timeline resolution (ms)
const RATIOS = [1, 25 / 23.976, 23.976 / 25, 25 / 24, 24 / 25, 24 / 23.976, 23.976 / 24];
const TIME_RE = /(\d+):(\d\d):(\d\d)[,.](\d{1,3})\s*-->\s*(\d+):(\d\d):(\d\d)[,.](\d{1,3})/;
const AD_RE = /opensubtitles|osdb\.link|VIP member|subtitles by|www\.[a-z0-9-]+\.(com|org|net|gr)/i;

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1253').decode(buf); // legacy Greek encoding
  }
}

function toMs(h, m, s, ms) {
  return (+h * 3600 + +m * 60 + +s) * 1000 + +ms.padEnd(3, '0');
}

function parseSrt(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const cues = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TIME_RE.exec(lines[i]);
    if (!m) continue;
    const start = toMs(m[1], m[2], m[3], m[4]);
    const end = toMs(m[5], m[6], m[7], m[8]);
    const body = [];
    i++;
    while (i < lines.length && lines[i].trim() !== '') {
      if (TIME_RE.test(lines[i])) { i--; break; }
      body.push(lines[i]);
      i++;
    }
    // a bare number directly before the next timing line is that cue's index, not text
    if (body.length > 1 && /^\d+$/.test(body[body.length - 1].trim()) && TIME_RE.test(lines[i + 1] || '')) body.pop();
    if (end > start && body.length) cues.push({ start, end, text: body.join('\n') });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function fmt(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms % 1000, 3)}`;
}

function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`).join('\n');
}

function stripAds(cues) {
  return cues.filter((c) => !AD_RE.test(c.text));
}

function greekShare(cues) {
  let g = 0, l = 0;
  for (const c of cues) for (const ch of c.text) {
    const k = ch.codePointAt(0);
    if ((k >= 0x370 && k <= 0x3ff) || (k >= 0x1f00 && k <= 0x1fff)) g++;
    else if ((k >= 65 && k <= 90) || (k >= 97 && k <= 122)) l++;
  }
  return g + l ? g / (g + l) : 0;
}

// Reference timeline: prefix sums of "someone is speaking" per 100 ms bin.
function timeline(cues) {
  const last = cues.reduce((a, c) => Math.max(a, c.end), 0);
  const n = Math.ceil(last / BIN) + 2;
  const on = new Uint8Array(n);
  let dur = 0;
  for (const c of cues) for (let b = Math.floor(c.start / BIN), e = Math.ceil(c.end / BIN); b < e; b++) on[b] = 1;
  const pre = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) { pre[i + 1] = pre[i] + on[i]; dur += on[i]; }
  return { pre, n, dur };
}

function overlap(tl, s, e) {
  let a = Math.round(s / BIN), b = Math.round(e / BIN);
  if (b <= 0 || a >= tl.n) return 0;
  if (a < 0) a = 0;
  if (b > tl.n) b = tl.n;
  return tl.pre[b] - tl.pre[a];
}

function totalOverlap(tl, cues, ratio, off, from = 0, to = cues.length) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += overlap(tl, cues[i].start * ratio + off, cues[i].end * ratio + off);
  return sum;
}

function cueBins(cues, ratio) {
  let d = 0;
  for (const c of cues) d += Math.round((c.end - c.start) * ratio / BIN);
  return d;
}

// 0..1, how well the cues sit on the reference speech timeline.
function fit(tl, cues, ratio, off) {
  const ov = totalOverlap(tl, cues, ratio, off);
  return (2 * ov) / (cueBins(cues, ratio) + tl.dur || 1);
}

function bestOffset(tl, cues, ratio, range, step = BIN) {
  let best = -1, at = 0;
  for (let off = -range; off <= range; off += step) {
    const ov = totalOverlap(tl, cues, ratio, off);
    if (ov > best) { best = ov; at = off; }
  }
  for (let off = at - step; off <= at + step; off += 10) { // fine pass, 10 ms
    const ov = totalOverlap(tl, cues, ratio, off);
    if (ov > best) { best = ov; at = off; }
  }
  return { off: at, ov: best };
}

// One speed correction + one shift for the whole file.
function alignGlobal(tl, cues, range = 600000) {
  let best = null;
  for (const ratio of RATIOS) {
    const r = bestOffset(tl, cues, ratio, range, 5 * BIN);
    const score = (2 * r.ov) / (cueBins(cues, ratio) + tl.dur || 1);
    // prefer "no speed change" unless another ratio is clearly better
    const adj = ratio === 1 ? score + 0.01 : score;
    if (!best || adj > best.adj) best = { ratio, off: r.off, score, adj };
  }
  return best;
}

// Different cuts / ad breaks: let the shift change between blocks of cues, but only when it pays off.
function alignPiecewise(tl, cues, g, span = 120000, segSize = 30) {
  const K = Math.floor((2 * span) / BIN) + 1;
  const segs = [];
  for (let i = 0; i < cues.length; i += segSize) segs.push([i, Math.min(cues.length, i + segSize)]);
  if (segs.length < 3) return null;
  const penalty = 60; // bins of overlap a change of shift must win back (6 s of speech)
  let prev = new Float64Array(K);
  const back = [];
  for (let s = 0; s < segs.length; s++) {
    const cur = new Float64Array(K), bk = new Int32Array(K);
    let pmax = -Infinity, parg = 0;
    for (let k = 0; k < K; k++) if (prev[k] > pmax) { pmax = prev[k]; parg = k; }
    for (let k = 0; k < K; k++) {
      const sc = totalOverlap(tl, cues, g.ratio, g.off - span + k * BIN, segs[s][0], segs[s][1]);
      if (s > 0 && pmax - penalty > prev[k]) { cur[k] = pmax - penalty + sc; bk[k] = parg; }
      else { cur[k] = prev[k] + sc; bk[k] = k; }
    }
    back.push(bk);
    prev = cur;
  }
  let k = 0;
  for (let i = 1; i < K; i++) if (prev[i] > prev[k]) k = i;
  const offs = new Array(segs.length);
  for (let s = segs.length - 1; s >= 0; s--) { offs[s] = g.off - span + k * BIN; k = back[s][k]; }
  let changes = 0, ov = 0;
  for (let s = 0; s < segs.length; s++) {
    if (s && offs[s] !== offs[s - 1]) changes++;
    ov += totalOverlap(tl, cues, g.ratio, offs[s], segs[s][0], segs[s][1]);
  }
  const base = totalOverlap(tl, cues, g.ratio, g.off);
  if (!changes || changes > 8 || ov < base * 1.04) return null;
  return { segs, offs, changes, score: (2 * ov) / (cueBins(cues, g.ratio) + tl.dur || 1) };
}

// Retime `cues` onto the reference. Returns new cues plus what was done.
function align(refCues, cues, { piecewise = true } = {}) {
  const tl = timeline(refCues);
  const before = fit(tl, cues, 1, 0);
  const g = alignGlobal(tl, cues);
  const pw = piecewise ? alignPiecewise(tl, cues, g) : null;
  const out = [];
  if (pw) {
    pw.segs.forEach(([a, b], s) => {
      for (let i = a; i < b; i++) out.push({ start: cues[i].start * g.ratio + pw.offs[s], end: cues[i].end * g.ratio + pw.offs[s], text: cues[i].text });
    });
    out.sort((a, b) => a.start - b.start);
  } else {
    for (const c of cues) out.push({ start: c.start * g.ratio + g.off, end: c.end * g.ratio + g.off, text: c.text });
  }
  return {
    cues: out.filter((c) => c.end > 0),
    before, after: pw ? pw.score : g.score,
    ratio: g.ratio, offset: g.off, splits: pw ? pw.changes : 0,
  };
}

// Do two subtitle files already share the same timing (same release of the film)?
function sameTiming(tlA, cuesB) {
  const r = bestOffset(tlA, cuesB, 1, 30000);
  const score = (2 * r.ov) / (cueBins(cuesB, 1) + tlA.dur || 1);
  return Math.abs(r.off) <= 600 && score >= 0.45;
}

module.exports = { decode, parseSrt, toSrt, stripAds, greekShare, timeline, fit, align, sameTiming };
