'use strict';
// Breaks a subtitle file in known ways and checks the engine puts every line back.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/sync');
const H = require('./helpers');

const ref = H.film(1);
const truth = H.translate(ref);

const cases = {
  'already in sync': (t) => t,
  'late by 2.4 s': (t) => t + 2400,
  'early by 37 s': (t) => t - 37000,
  'late by 4 min (different intro)': (t) => t + 240000,
  '25 fps file on 23.976 video, +1.5 s': (t) => t * (23.976 / 25) + 1500,
  '23.976 fps file on 25 video, -3 s': (t) => t * (25 / 23.976) - 3000,
  '24 vs 23.976 slow drift': (t) => t * (24 / 23.976) + 800,
  'ad break: +30 s after minute 40': (t) => (t > 2400000 ? t + 30000 : t) + 1000,
  'two cuts: -12 s after 30 min, +8 s after 70 min': (t) => t + (t > 4200000 ? 8000 : t > 1800000 ? -12000 : 0),
};

for (const [name, f] of Object.entries(cases)) {
  test(`repairs: ${name}`, () => {
    const a = S.align(ref, H.warp(truth, f));
    const e = H.error(a.cues, truth);
    assert.ok(e.median <= 150, `median error ${e.median} ms`);
    assert.ok(e.p95 <= 600, `95% error ${e.p95} ms`);
    assert.ok(a.after >= 0.85, `fit ${a.after}`);
  });
}

test('a different film does not look like a match', () => {
  const a = S.align(ref, H.translate(H.film(99)));
  assert.ok(a.after < 0.72, `fit ${a.after} should be below the acceptance bar`);
});

test('parses messy SRT: BOM, CRLF, dots, missing index, legacy Greek encoding', () => {
  const text = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nΓειά\r\n\r\n00:00:03.5 --> 00:00:04.250\r\nδύο\r\nγραμμές\r\n\r\n3\r\n00:00:05,000 --> 00:00:06,000\r\nτρία\r\n';
  const cues = S.parseSrt(text);
  assert.deepStrictEqual(cues.map((c) => [c.start, c.end]), [[1000, 2500], [3500, 4250], [5000, 6000]]);
  assert.strictEqual(cues[1].text, 'δύο\nγραμμές');
  const legacy = Buffer.from([0xc3, 0xe5, 0xe9, 0xdc]); // "Γειά" in windows-1253
  assert.strictEqual(S.decode(legacy), 'Γειά');
  assert.strictEqual(S.parseSrt('not a subtitle file at all').length, 0);
});

test('written SRT reads back identically and ad lines are removed', () => {
  const cues = [{ start: 1000, end: 2000, text: 'α' }, { start: 3000, end: 4000, text: 'Support us and become VIP member' }];
  assert.deepStrictEqual(S.parseSrt(S.toSrt(S.stripAds(cues))), [cues[0]]);
});
