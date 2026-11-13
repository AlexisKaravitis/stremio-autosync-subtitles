'use strict';
// Runs the whole addon against a fake OpenSubtitles, including every way it can go wrong.
// Each scenario has its own title id and its own file numbers, so nothing is shared by accident.
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { parseSrt } = require('../lib/sync');

const u = (n) => `https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/${n}`;
const files = {};      // file number -> SRT text
const listings = {};   // scenario -> what OpenSubtitles lists for it
const redirects = {};  // file number -> where the server sends you instead
const fat = (cues) => H.srt(cues.map((c) => ({ ...c, text: 'x'.repeat(3000) }))); // > 3 MB, otherwise valid

// A: one film, an old camera copy and a BluRay. Greek exists only for the camera copy.
const base = H.film(3);
const cam = H.warp(base, (t) => t * (25 / 23.976) + 9000);
const greekTruth = H.translate(base);
const greekOnCam = H.warp(greekTruth, (t) => t * (25 / 23.976) + 9000);
const wrong7s = H.warp(base, (t) => t + 7000);
Object.assign(files, {
  1: H.srt(cam), 2: H.srt(H.translate(cam, 11, 'Hola')), 3: H.srt(H.translate(cam, 12, 'Ciao')),
  4: H.srt(base), 5: H.srt(H.translate(base, 13, 'Salut')), 6: H.srt(greekOnCam),
  7: fat(wrong7s), 9: fat(wrong7s),
});
listings.A = [
  { id: 1, url: u(1), lang: 'eng', m: 'i', movieReleaseName: 'Film.2010.CAM.XviD-OLD' },
  { id: 2, url: u(2), lang: 'spa', m: 'i', movieReleaseName: 'Film.2010.TS.XviD-OLD' },
  { id: 3, url: u(3), lang: 'ita', m: 'i', movieReleaseName: 'Film.2010.TELESYNC-ZZZ' },
  { id: 4, url: u(4), lang: 'eng', m: 'i', movieReleaseName: 'Film.2010.1080p.BluRay.x264-SPARKS' },
  { id: 5, url: u(5), lang: 'fre', m: 'i', movieReleaseName: 'Film.2010.720p.BluRay.x264-OTHER' },
  { id: 6, url: u(6), lang: 'ell', m: 'i', movieReleaseName: 'Film.2010.TS.XviD-OLD' },
  // Oversized files with the wrong timing, marked as exact matches for the video: if the size
  // limit ever stopped working they would be ranked first and the tests below would fail.
  { id: 7, url: u(7), lang: 'eng', m: 'h', movieReleaseName: 'Film.2010.1080p.BluRay.x264-SPARKS' }, // size known up front
  { id: 9, url: u(9), lang: 'ger', m: 'h', movieReleaseName: 'Film.2010.1080p.BluRay.x264-SPARKS' }, // size found on reading
  { id: 8, url: 'https://evil.example/steal', lang: 'eng', m: 'i' }, // must never be fetched
];

// B: web and BluRay releases only 1.1 s apart, a "signs only" file, Greek only for an HDTV copy.
const later = (cues) => H.warp(cues, (t) => t + 1100);
const film2 = H.film(5);
const greek2 = H.translate(film2);
Object.assign(files, {
  21: H.srt(film2), 22: H.srt(H.translate(film2, 21, 'Hola')),
  23: H.srt(later(film2)), 24: H.srt(later(H.translate(film2, 22, 'Ciao'))), 25: H.srt(later(H.translate(film2, 23, 'Salut'))),
  26: H.srt(H.warp(greek2, (t) => t + 20000)),
  27: H.srt(film2.filter((_, i) => i % 40 === 0)),
});
listings.B = [
  { id: 21, url: u(21), lang: 'eng', m: 'i', movieReleaseName: 'Two.2023.1080p.WEB-DL.x264-AAA' },
  { id: 22, url: u(22), lang: 'spa', m: 'i', movieReleaseName: 'Two.2023.1080p.WEB-DL.x264-AAA' },
  { id: 23, url: u(23), lang: 'eng', m: 'i', movieReleaseName: 'Two.2023.1080p.BluRay.x264-BBB' },
  { id: 24, url: u(24), lang: 'ita', m: 'i', movieReleaseName: 'Two.2023.1080p.BluRay.x264-BBB' },
  { id: 25, url: u(25), lang: 'fre', m: 'i', movieReleaseName: 'Two.2023.720p.BluRay.x264-CCC' },
  { id: 26, url: u(26), lang: 'ell', m: 'i', movieReleaseName: 'Two.2023.HDTV-DDD' },
  { id: 27, url: u(27), lang: 'eng', m: 'i', movieReleaseName: 'Two.2023.1080p.BluRay.x264-SIGNS' },
];

// C: Greek files that agree with nothing: one 5 s late, one for a different film entirely.
const film3 = H.film(8);
const greek3 = H.translate(film3);
Object.assign(files, {
  31: H.srt(film3), 32: H.srt(H.translate(film3, 31, 'Hola')),
  33: H.srt(H.warp(greek3, (t) => t + 5000)), 34: H.srt(H.translate(H.film(77), 32)),
});
listings.C = [
  { id: 31, url: u(31), lang: 'eng', m: 'i', movieReleaseName: 'Three.2020.1080p.BluRay.x264-AAA' },
  { id: 32, url: u(32), lang: 'spa', m: 'i', movieReleaseName: 'Three.2020.1080p.BluRay.x264-AAA' },
  { id: 33, url: u(33), lang: 'ell', m: 'i', movieReleaseName: 'Three.2020.HDTV.x264-BBB' },
  { id: 34, url: u(34), lang: 'ell', m: 'i', movieReleaseName: 'Three.2020.1080p.BluRay.x264-AAA' },
];

// D: files carrying one stray line hours after the film ends.
const film4 = H.film(9);
const greek4 = H.translate(film4);
const stray = (cues) => [...cues, { start: 16200000, end: 16203000, text: 'credit' }];
Object.assign(files, {
  41: H.srt(stray(film4)), 42: H.srt(H.translate(film4, 41, 'Hola')),
  43: H.srt(stray(H.warp(greek4, (t) => t + 3000))), 44: H.srt(H.warp(greek4, (t) => t + 3000)),
});
listings.D = [
  { id: 41, url: u(41), lang: 'eng', m: 'i', movieReleaseName: 'Four.2020.1080p.BluRay.x264-AAA' },
  { id: 42, url: u(42), lang: 'spa', m: 'i', movieReleaseName: 'Four.2020.1080p.BluRay.x264-AAA' },
  { id: 43, url: u(43), lang: 'ell', m: 'i', movieReleaseName: 'Four.2020.DVDRip.x264-BBB' },
  { id: 44, url: u(44), lang: 'ell', m: 'i', movieReleaseName: 'Four.2020.DVDRip.x264-CCC' },
];

// E: one file redirects to another site, one keeps failing with a temporary error.
const film5 = H.film(10);
const greek5 = H.translate(film5);
Object.assign(files, { 52: H.srt(film5), 53: H.srt(H.translate(film5, 51, 'Hola')), 54: H.srt(H.warp(greek5, (t) => t - 4000)) });
redirects[51] = 'https://evil.example/elsewhere.srt';
listings.E = [
  { id: 51, url: u(51), lang: 'eng', m: 'h', movieReleaseName: 'Five.2020.1080p.BluRay.x264-AAA' },
  { id: 52, url: u(52), lang: 'eng', m: 'i', movieReleaseName: 'Five.2020.1080p.BluRay.x264-AAA' },
  { id: 53, url: u(53), lang: 'spa', m: 'i', movieReleaseName: 'Five.2020.1080p.BluRay.x264-AAA' },
  { id: 54, url: u(54), lang: 'ell', m: 'i', movieReleaseName: 'Five.2020.HDTV.x264-BBB' },
  { id: 55, url: u(55), lang: 'fre', m: 'i', movieReleaseName: 'Five.2020.1080p.BluRay.x264-DOWN' }, // always 520
];

const titles = { tt0000005: 'B', tt0000006: 'B', tt0000007: 'C', tt0000008: 'D', tt0000009: 'E' };
const seen = new Set();
const fetched = [];
let mode = 'ok';
global.fetch = async (url) => {
  url = String(url);
  fetched.push(url);
  const reply = (body, status = 200, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => Buffer.from(body),
  });
  if (url.startsWith('https://opensubtitles-v3.strem.io/')) {
    // slow, not endless: a promise that never settles would leave the test runner with nothing to wait for
    if (mode === 'hang') return new Promise((res) => setTimeout(() => res(reply('too late', 500)), 1500));
    if (mode === 'down') return reply('oops', 500);
    if (mode === 'garbage') return reply('<html>not json');
    if (mode === 'empty') return reply(JSON.stringify({}));
    const id = /\/(tt\d+)/.exec(url)[1];
    const list = listings[titles[id] || 'A'];
    return reply(JSON.stringify({ subtitles: mode === 'nogreek' ? list.filter((s) => s.lang !== 'ell') : list }));
  }
  const n = (/\/file\/(\d+)$/.exec(url) || [])[1];
  if (mode === 'flaky' && !seen.has(url)) { seen.add(url); return reply('<html>temporary error', 520); }
  if (redirects[n]) return reply('', 302, { location: redirects[n] });
  if (n === '55') return reply('<html>temporary error', 520);
  if (n === '7') return reply(files[7], 200, { 'content-length': String(files[7].length) });
  if (files[n]) return reply(files[n]);
  return reply('nope', 404);
};

const { handle } = require('../lib/addon');
function call(url, { method = 'GET', host = 'addon.test', headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) { resolve({ status: this.statusCode, headers: this.headers, body: b === undefined ? '' : String(b) }); },
    };
    handle({ url, method, headers: { host, 'x-forwarded-proto': 'https', ...headers } }, res);
  });
}
const list = async (path, opts) => JSON.parse((await call(path, opts)).body).subtitles;
const fetchSrt = async (sub) => parseSrt((await call(sub.url.replace(/^https:\/\/[^/]+/, ''))).body);
const good = (e) => e.median <= 150 && e.p95 <= 600;

test('manifest: original Greek address, language addresses, unknown language', async () => {
  const a = JSON.parse((await call('/manifest.json')).body);
  assert.strictEqual(a.id, 'community.greek.autosync');
  assert.deepStrictEqual(a.resources, ['subtitles']);
  assert.strictEqual(a.logo, 'https://addon.test/logo.png'); // each copy serves its own logo
  assert.strictEqual(JSON.parse((await call('/spa/manifest.json')).body).id, 'community.autosync.spa');
  assert.strictEqual((await call('/zho/manifest.json')).status, 200); // the code OpenSubtitles uses for Chinese
  assert.strictEqual((await call('/chi/manifest.json')).status, 404);
  assert.strictEqual((await call('/xxx/manifest.json')).status, 404);
});

test('web page and logo are served; HEAD sends no body', async () => {
  const p = await call('/');
  assert.strictEqual(p.status, 200);
  assert.match(p.body, /Install in Stremio/);
  assert.strictEqual((await call('/configure')).status, 200);
  assert.strictEqual((await call('/logo.png')).headers['content-type'], 'image/png');
  const head = await call('/manifest.json', { method: 'HEAD' });
  assert.deepStrictEqual([head.status, head.body], [200, '']);
});

test('with the video file name, the matching release comes first and is synced correctly', async () => {
  const subs = await list('/subtitles/movie/tt0000001/filename=Film.2010.1080p.BluRay.x264-SPARKS.mkv&videoSize=1.json');
  assert.ok(subs.length >= 1 && subs.length <= 4, `${subs.length} versions`);
  assert.ok(subs.every((s) => s.lang === 'ell' && s.url.startsWith('https://addon.test/sub/')));
  const e = H.error(await fetchSrt(subs[0]), greekTruth);
  assert.ok(good(e), `first choice is off: median ${e.median} ms, 95% ${e.p95} ms`);
});

test('without a file name, modern releases are still preferred over camera copies', async () => {
  const subs = await list('/subtitles/movie/tt0000002.json');
  assert.ok(good(H.error(await fetchSrt(subs[0]), greekTruth)));
});

test('a camera-copy file name puts the camera timing first', async () => {
  const subs = await list('/subtitles/movie/tt0000004/filename=Film.2010.TS.XviD-OLD.avi.json');
  assert.ok(good(H.error(await fetchSrt(subs[0]), greekOnCam)));
});

test('files over the size limit are refused, whether the size is announced or not', () => {
  assert.ok(files[7].length > 3 * 1024 * 1024 && parseSrt(files[7]).length > 500, 'the oversized files are otherwise valid');
  assert.ok(fetched.includes(u(7)) && fetched.includes(u(9)), 'both were attempted'); // and the tests above still passed
});

// What Vercel's rewrite does to a request, as measured on the live service: the path is decoded,
// encoded again as a single value, and placed after the visitor's own query string.
const vercel = (path, query = '') => `/api/index?${query ? query + '&' : ''}__p=${encodeURIComponent(decodeURIComponent(path))}`;

test('through the Vercel rewrite: episode ids, awkward file names, the visitor\'s own query string', async () => {
  assert.ok((await list(vercel('subtitles/series/tt0000003%3A1%3A2.json'))).length >= 1);
  assert.ok((await list('/subtitles/series/tt0000003:1:2/videoHash=abc&videoSize=5.json')).length >= 1);

  const name = 'Tom & Jerry #1? 100%.2010.1080p.BluRay.x264-SPARKS.mkv';
  const sent = `filename=${encodeURIComponent(name)}&videoSize=5`; // how Stremio sends it
  for (const [id, url] of [
    ['tt0000010', vercel(`subtitles/movie/tt0000010/${sent}.json`, 'utm=1')],
    ['tt0000013', `/subtitles/movie/tt0000013/${sent}.json?utm=1`], // the same request on a plain server
  ]) {
    const subs = await list(url);
    assert.ok(good(H.error(await fetchSrt(subs[0]), greekTruth)), `${id}: the release in the file name was recognised`);
    assert.ok(fetched.includes(`https://opensubtitles-v3.strem.io/subtitles/movie/${id}/${sent}.json`), `${id}: the whole file name reaches OpenSubtitles`);
  }
  const m = await call(vercel('manifest.json', 'utm=1&z=2'));
  assert.strictEqual(JSON.parse(m.body).id, 'community.greek.autosync');
  assert.strictEqual(JSON.parse((await call(vercel('spa/manifest.json'))).body).id, 'community.autosync.spa');
});

test('a temporary server error on a download is retried, not treated as an empty file', async () => {
  mode = 'flaky';
  const subs = await list('/subtitles/movie/tt0000006.json');
  mode = 'ok';
  assert.ok(seen.size >= 5, 'the downloads should have failed once each');
  assert.ok(subs.length >= 2, `got ${subs.length}`);
});

test('releases about a second apart are kept apart, and each gets its own correct version', async () => {
  const subs = await list('/subtitles/movie/tt0000005.json');
  const errs = [];
  for (const sub of subs) {
    const got = await fetchSrt(sub);
    errs.push([H.error(got, greek2).median, H.error(got, later(greek2)).median]);
  }
  assert.ok(errs.some((e) => e[0] <= 150), `no version matches the web release: ${JSON.stringify(errs)}`);
  assert.ok(errs.some((e) => e[1] <= 150), `no version matches the BluRay release: ${JSON.stringify(errs)}`);
  assert.ok(errs.every((e) => e[0] <= 150 || e[1] <= 150), `a version matches neither release: ${JSON.stringify(errs)}`);
});

test('a translation that agrees with no other subtitle is never offered as it is', async () => {
  const subs = await list('/subtitles/movie/tt0000007.json');
  assert.ok(subs.length >= 1);
  for (const sub of subs) {
    const e = H.error(await fetchSrt(sub), greek3);
    assert.ok(good(e), `offered a version that is off: median ${e.median} ms over ${e.lines} lines`);
  }
});

test('one stray line hours after the film does not discard the other files', async () => {
  const subs = await list('/subtitles/movie/tt0000008.json');
  assert.ok(subs.length >= 1, 'the references were thrown away');
  for (const sub of subs) assert.ok(good(H.error(await fetchSrt(sub), greek4)));
});

test('a redirect to another site is not followed, and a download that keeps failing shortens the cache time', async () => {
  const r = await call('/subtitles/movie/tt0000009.json');
  const subs = JSON.parse(r.body).subtitles;
  assert.ok(subs.length >= 1);
  assert.ok(good(H.error(await fetchSrt(subs[0]), greek5)));
  assert.strictEqual(r.headers['cache-control'], 'public, max-age=300, s-maxage=300');
});

test('nothing is ever requested from outside the OpenSubtitles addon and its subtitle servers', () => {
  const ok = /^https:\/\/(opensubtitles-v3\.strem\.io|subs\d*\.strem\.io)\//;
  assert.deepStrictEqual(fetched.filter((f) => !ok.test(f)), []);
});

test('answers with an empty list, never an error, when things go wrong', async () => {
  for (const m of ['down', 'garbage', 'nogreek', 'empty']) {
    mode = m;
    const r = await call(`/subtitles/movie/tt99${m}.json`);
    assert.strictEqual(r.status, 200, m);
    assert.deepStrictEqual(JSON.parse(r.body).subtitles, [], m);
    assert.match(r.headers['cache-control'], m === 'nogreek' || m === 'empty' ? /max-age=600\b/ : /max-age=60\b/, m);
  }
  mode = 'ok';
});

test('how long answers may be reused', async () => {
  const full = await call('/subtitles/movie/tt0000002.json');
  assert.strictEqual(full.headers['cache-control'], 'public, max-age=7200, s-maxage=21600');
  assert.strictEqual((await call('/nope')).headers['cache-control'], 'no-store');
});

test('gives up after the time limit instead of hanging the player', async () => {
  process.env.AUTOSYNC_DEADLINE_MS = '150';
  mode = 'hang';
  const t0 = Date.now();
  const r = await call('/subtitles/movie/tt0000020.json');
  mode = 'ok';
  delete process.env.AUTOSYNC_DEADLINE_MS;
  assert.ok(Date.now() - t0 < 2000);
  assert.deepStrictEqual([r.status, JSON.parse(r.body).subtitles], [200, []]);
});

test('a remembered "none" expires, so new subtitles are found later', async () => {
  mode = 'nogreek';
  assert.deepStrictEqual(await list('/subtitles/movie/tt0000012.json'), []);
  mode = 'ok';
  assert.deepStrictEqual(await list('/subtitles/movie/tt0000012.json'), [], 'still remembered a moment later');
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  try { assert.ok((await list('/subtitles/movie/tt0000012.json')).length >= 1, 'asked again after 11 minutes'); } finally { Date.now = realNow; }
});

test('links point at whichever address the request came to; forged addresses are refused', async () => {
  const a = await list('/subtitles/movie/tt0000002.json', { host: 'one.example' });
  const b = await list('/subtitles/movie/tt0000002.json', { host: '192.168.1.20:7711' });
  assert.ok(a[0].url.startsWith('https://one.example/sub/'));
  assert.ok(b[0].url.startsWith('https://192.168.1.20:7711/sub/'));
  for (const host of ['x"</script><script>alert(1)</script>', 'evil.example/path', 'a b', '']) {
    assert.strictEqual((await call('/', { host })).status, 400, JSON.stringify(host));
    assert.strictEqual((await call('/manifest.json', { headers: { 'x-forwarded-host': host || ' ' } })).status, 400);
  }
});

test('rejects tampered links and odd requests without leaking details', async () => {
  const evil = Buffer.from(JSON.stringify({ g: 'https://evil.example/a', r: 'http://169.254.169.254/latest' })).toString('base64url');
  const paths = [`/sub/${evil}.srt`, '/sub/AAAA.srt', `/sub/${'A'.repeat(900)}.srt`, '/sub/..%2f..%2fetc.srt', '/nope', '/subtitles/tv/tt1.json', '/sub/%E0%A4%A.srt', '/api/index?__p=%E0%A4%A'];
  for (const path of paths) {
    const r = await call(path);
    assert.strictEqual(r.status, 404, path);
    assert.ok(r.body.length < 40 && !/evil|stack|Error/.test(r.body), path);
  }
  assert.strictEqual((await call('/manifest.json', { method: 'POST' })).status, 405);
  assert.strictEqual((await call('/manifest.json', { method: 'OPTIONS' })).status, 204);
  assert.ok(!fetched.some((f) => f.includes('evil.example') || f.includes('169.254')));
});
