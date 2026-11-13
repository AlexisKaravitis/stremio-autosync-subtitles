'use strict';
// Runs the whole addon against a fake OpenSubtitles, including every way it can go wrong.
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { parseSrt } = require('../lib/sync');

const base = H.film(3);
const bluray = base;                                             // the release being "played"
const cam = H.warp(base, (t) => t * (25 / 23.976) + 9000);       // an old cinema-camera copy
const greekTruth = H.translate(bluray);
const greekOnCam = H.warp(greekTruth, (t) => t * (25 / 23.976) + 9000);

const files = {
  1: H.srt(cam), 2: H.srt(H.translate(cam, 11, 'Hola')), 3: H.srt(H.translate(cam, 12, 'Ciao')),
  4: H.srt(bluray), 5: H.srt(H.translate(bluray, 13, 'Salut')),
  6: H.srt(greekOnCam),
  7: 'x'.repeat(4 * 1024 * 1024),                                // absurdly large "subtitle"
};
const u = (n) => `https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/${n}`;
const listing = [
  { id: 1, url: u(1), lang: 'eng', m: 'i', movieReleaseName: 'Film.2010.CAM.XviD-OLD' },
  { id: 2, url: u(2), lang: 'spa', m: 'i', movieReleaseName: 'Film.2010.TS.XviD-OLD' },
  { id: 3, url: u(3), lang: 'ita', m: 'i', movieReleaseName: 'Film.2010.TELESYNC-ZZZ' },
  { id: 4, url: u(4), lang: 'eng', m: 'i', movieReleaseName: 'Film.2010.1080p.BluRay.x264-SPARKS' },
  { id: 5, url: u(5), lang: 'fre', m: 'i', movieReleaseName: 'Film.2010.720p.BluRay.x264-OTHER' },
  { id: 6, url: u(6), lang: 'ell', m: 'i', movieReleaseName: 'Film.2010.TS.XviD-OLD' },
  { id: 7, url: u(7), lang: 'eng', m: 'i', movieReleaseName: 'Film.2010.1080p.BluRay.x264-HUGE' },
  { id: 8, url: 'https://evil.example/steal', lang: 'eng', m: 'i' },   // must never be fetched
];

let mode = 'ok';
const fetched = [];
global.fetch = async (url) => {
  fetched.push(String(url));
  const reply = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, arrayBuffer: async () => Buffer.from(body) });
  if (String(url).startsWith('https://opensubtitles-v3.strem.io/')) {
    if (mode === 'down') return reply('oops', 500);
    if (mode === 'garbage') return reply('<html>not json');
    if (mode === 'nogreek') return reply(JSON.stringify({ subtitles: listing.filter((s) => s.lang !== 'ell') }));
    if (mode === 'empty') return reply(JSON.stringify({}));
    return reply(JSON.stringify({ subtitles: listing }));
  }
  const m = /\/file\/(\d+)$/.exec(String(url));
  if (m && files[m[1]]) return reply(files[m[1]]);
  return reply('nope', 404);
};

const { handle } = require('../lib/addon');
function call(url, method = 'GET') {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) { resolve({ status: this.statusCode, headers: this.headers, body: b === undefined ? '' : String(b) }); },
    };
    handle({ url, method, headers: { host: 'addon.test', 'x-forwarded-proto': 'https' } }, res);
  });
}
const list = async (path) => JSON.parse((await call(path)).body).subtitles;
const fetchSrt = async (sub) => parseSrt((await call(sub.url.replace('https://addon.test', ''))).body);

test('manifest: original Greek address, language addresses, unknown language', async () => {
  const a = JSON.parse((await call('/manifest.json')).body);
  assert.strictEqual(a.id, 'community.greek.autosync');
  assert.deepStrictEqual(a.resources, ['subtitles']);
  assert.strictEqual(a.logo, 'https://addon.test/logo.png'); // each copy serves its own logo
  const b = JSON.parse((await call('/spa/manifest.json')).body);
  assert.strictEqual(b.id, 'community.autosync.spa');
  assert.strictEqual((await call('/xxx/manifest.json')).status, 404);
});

test('web page and logo are served', async () => {
  const p = await call('/');
  assert.strictEqual(p.status, 200);
  assert.match(p.body, /Install in Stremio/);
  assert.strictEqual((await call('/configure')).status, 200);
  assert.strictEqual((await call('/logo.png')).headers['content-type'], 'image/png');
});

test('with the video file name, the matching release comes first and is synced correctly', async () => {
  const subs = await list('/subtitles/movie/tt0000001/filename=Film.2010.1080p.BluRay.x264-SPARKS.mkv&videoSize=1.json');
  assert.ok(subs.length >= 1 && subs.length <= 3);
  assert.ok(subs.every((s) => s.lang === 'ell' && s.url.startsWith('https://addon.test/sub/')));
  const e = H.error(await fetchSrt(subs[0]), greekTruth);
  assert.ok(e.median <= 150 && e.p95 <= 600, `first choice is off: median ${e.median} ms, 95% ${e.p95} ms`);
});

test('without a file name, modern releases are still preferred over camera copies', async () => {
  const subs = await list('/subtitles/movie/tt0000002.json');
  const e = H.error(await fetchSrt(subs[0]), greekTruth);
  assert.ok(e.median <= 150, `median ${e.median} ms`);
});

test('a camera-copy file name puts the camera timing first', async () => {
  const subs = await list('/subtitles/movie/tt0000004/filename=Film.2010.TS.XviD-OLD.avi.json');
  const e = H.error(await fetchSrt(subs[0]), greekOnCam);
  assert.ok(e.median <= 150, `median ${e.median} ms`);
});

test('works through the Vercel rewrite and with encoded episode ids', async () => {
  assert.ok((await list('/api/index?__p=subtitles/series/tt0000003%3A1%3A2.json')).length >= 1);
  assert.ok((await list('/subtitles/series/tt0000003:1:2/videoHash=abc&videoSize=5.json')).length >= 1);
});

test('answers with an empty list, never an error, when things go wrong', async () => {
  for (const m of ['down', 'garbage', 'nogreek', 'empty']) {
    mode = m;
    const r = await call(`/subtitles/movie/tt99${m}.json`);
    assert.strictEqual(r.status, 200, m);
    assert.deepStrictEqual(JSON.parse(r.body).subtitles, [], m);
  }
  mode = 'ok';
});

test('rejects tampered links and odd requests without leaking details', async () => {
  const evil = Buffer.from(JSON.stringify({ g: 'https://evil.example/a', r: 'http://169.254.169.254/latest' })).toString('base64url');
  const paths = [`/sub/${evil}.srt`, '/sub/AAAA.srt', `/sub/${'A'.repeat(900)}.srt`, '/sub/..%2f..%2fetc.srt', '/nope', '/subtitles/tv/tt1.json'];
  for (const path of paths) {
    const r = await call(path);
    assert.strictEqual(r.status, 404, path);
    assert.ok(r.body.length < 40 && !/evil|stack|Error/.test(r.body), path);
  }
  assert.strictEqual((await call('/manifest.json', 'POST')).status, 405);
  assert.strictEqual((await call('/manifest.json', 'OPTIONS')).status, 204);
});

test('never downloads from anywhere but the OpenSubtitles addon and its subtitle servers', () => {
  const allowed = /^https:\/\/(opensubtitles-v3\.strem\.io|subs\d*\.strem\.io)\//;
  assert.deepStrictEqual(fetched.filter((f) => !allowed.test(f)), []);
});
