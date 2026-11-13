'use strict';
// SubDL, the optional second source, against fakes that behave as the real services were
// measured to: SubDL wants the key on every request, puts it inside the download links it
// returns, allows few downloads, and says how long to wait when it refuses.
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const Z = require('../lib/zip');
const { parseSrt } = require('../lib/sync');

const KEY = 'test-key-do-not-leak';
const BLURAY = 'filename=Seven.2002.1080p.BluRay.x264-BBB.mkv'; // the copy being played in most tests
const u = (n) => `https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/${n}`;

// One film. On OpenSubtitles everything is for the 25 fps DVD; the BluRay runs at film speed
// and starts 12 s later.
const film = H.film(14);
const greek = H.translate(film);
const onDvd = (cues) => H.warp(cues, (t) => t * (23.976 / 25));
const onBluRay = (cues) => H.warp(cues, (t) => t + 12000);
const files = { 71: H.srt(onDvd(film)), 72: H.srt(onDvd(H.translate(film, 71, 'Hola'))), 73: H.srt(onDvd(greek)), 74: H.srt(onBluRay(film)) };
const dvd = [
  { id: 71, url: u(71), lang: 'eng', m: 'i', fpsMilli: 25000, movieReleaseName: 'Seven.2002.DVDRip.XviD-AAA' },
  { id: 72, url: u(72), lang: 'spa', m: 'i', fpsMilli: 25000, movieReleaseName: 'Seven.2002.DVDRip.XviD-AAA' },
  { id: 73, url: u(73), lang: 'ell', m: 'i', fpsMilli: 25000, movieReleaseName: 'Seven' },
];
const open = {
  dvd,
  dvdNoGreek: dvd.filter((x) => x.lang !== 'ell'),
  hasBluRay: [...dvd, { id: 74, url: u(74), lang: 'eng', m: 'i', movieReleaseName: 'Seven.2002.1080p.BluRay.x264-BBB' }],
  redirects: [...dvd, { id: 90, url: u(90), lang: 'ita', m: 'i', movieReleaseName: 'Seven.2002.DVDRip.XviD-AAA' }],
};

// What SubDL has. Every scenario gets its own archive names, so no test is helped by another's cache.
const zips = {};
const en = (name, release, more = {}) => ({ release_name: release, language: 'EN', lang: 'english', url: `/subtitle/${name}.zip`, ...more });
const el = (name, release, more = {}) => ({ release_name: release, language: 'EL', lang: 'Greek', url: `/subtitle/${name}.zip`, ...more });
const blurayRefs = (tag) => {
  zips[`${tag}-1`] = Z.build({ 'Seven.2002.1080p.BluRay.srt': H.srt(onBluRay(film)) });
  zips[`${tag}-2`] = Z.build({ 'readme.txt': 'hello', 'Seven.2002.2160p.UHD.BluRay.srt': H.srt(onBluRay(H.translate(film, 72, 'Hi'))) });
  return [en(`${tag}-1`, 'Seven.2002.1080p.BluRay.x264-BBB', { fps: 23.976 }), en(`${tag}-2`, 'Seven.2002.2160p.UHD.BluRay.x265-CCC')];
};
const greekBluRay = (tag) => { zips[`${tag}-3`] = Z.build({ 'Seven.2002.BDRip.gr.srt': H.srt(onBluRay(greek)) }); return el(`${tag}-3`, 'Seven (2002) 1080p-720p BDRip'); };

// title id -> what each source lists for it
const titles = {};
const title = (id, openList, subdlList) => { titles[id] = { open: open[openList], subdl: subdlList }; return id; };

const fetched = [];
const behave = { apiStatus: 200, apiHeaders: {}, apiBody: null, dlStatus: 200, dlHeaders: {}, dlHang: false, fail: new Set(), redirect: {} };
const calm = () => Object.assign(behave, { apiStatus: 200, apiHeaders: {}, apiBody: null, dlStatus: 200, dlHeaders: {}, dlHang: false });
global.fetch = async (url, opts = {}) => {
  url = String(url);
  fetched.push(url);
  const reply = (body, status = 200, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => Buffer.from(body),
  });
  const q = new URL(url);
  if (q.host === 'opensubtitles-v3.strem.io') {
    const id = /\/(tt\d+)/.exec(url)[1];
    return titles[id] ? reply(JSON.stringify({ subtitles: titles[id].open })) : reply('oops', 500);
  }
  if (q.host === 'subs5.strem.io') {
    const n = q.pathname.split('/').pop();
    if (n === '90') return reply('', 302, { location: 'https://dl.subdl.com/subtitle/stolen-1.zip' });
    return files[n] ? reply(files[n]) : reply('nope', 404);
  }
  if (q.host === 'api.subdl.com' || q.host === 'dl.subdl.com') {
    if (q.searchParams.get('api_key') !== KEY) return reply('{"status":false,"error":"not_authorized"}', 403);
    if (q.host === 'api.subdl.com') {
      if (behave.apiStatus !== 200) return reply('{"status":false}', behave.apiStatus, behave.apiHeaders);
      if (behave.apiBody) return reply(behave.apiBody);
      const list = (titles[q.searchParams.get('imdb_id')] || {}).subdl || [];
      return reply(JSON.stringify({ status: true, subtitles: list.map((x) => ({ ...x, url: `${x.url}?api_key=${KEY}` })) }));
    }
    const name = q.pathname.split('/').pop().replace('.zip', '');
    if (behave.dlHang) {
      // never answers until the addon gives up; the timer only keeps the test runner waiting meanwhile
      return new Promise((_, rej) => {
        const waiting = setTimeout(() => rej(new Error('the addon never gave up')), 10000);
        opts.signal.addEventListener('abort', () => { clearTimeout(waiting); rej(new Error('timed out')); });
      });
    }
    if (behave.dlStatus !== 200) return reply('{"error":"api_download_limit_exceeded"}', behave.dlStatus, behave.dlHeaders);
    if (behave.redirect[name]) return reply('', 302, { location: behave.redirect[name] });
    if (behave.fail.has(name)) return reply('broken', 500);
    return zips[name] ? reply(zips[name]) : reply('nope', 404);
  }
  return reply('should never be asked', 200);
};

const { handle, resetSubdl } = require('../lib/addon');
function call(url, { host = 'addon.test' } = {}) {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) { resolve({ status: this.statusCode, headers: this.headers, body: b === undefined ? '' : String(b) }); },
    };
    handle({ url, method: 'GET', headers: { host, 'x-forwarded-proto': 'https' } }, res);
  });
}
const path = (id, extra) => `/subtitles/movie/${id}${extra ? '/' + extra : ''}.json`;
const subsOf = (r) => JSON.parse(r.body).subtitles;
const linkOf = (sub) => sub.url.replace(/^https:\/\/[^/]+/, '');
const tokenOf = (sub) => linkOf(sub).slice(5, -4);
const inside = (sub) => JSON.parse(Buffer.from(tokenOf(sub).split('.')[0], 'base64url').toString());
const fetchSrt = async (sub) => parseSrt((await call(linkOf(sub))).body);
const good = (e) => e.median <= 150 && e.p95 <= 600;
const asked = (since, what) => fetched.slice(since).filter((f) => f.startsWith(what));
const API = 'https://api.subdl.com/', DL = 'https://dl.subdl.com/';
const CACHE = { normal: 'public, max-age=7200, s-maxage=21600', spent: 'public, max-age=7200, s-maxage=259200', soon: 'public, max-age=300, s-maxage=300', hour: 'public, max-age=3600, s-maxage=3600' };

// Runs a test with SubDL switched on, and leaves everything as it found it.
const withKey = (name, fn) => test(name, async () => {
  process.env.SUBDL_API_KEY = KEY;
  try { await fn(); } finally { delete process.env.SUBDL_API_KEY; delete process.env.AUTOSYNC_SUBDL_MS; calm(); resetSubdl(); }
});

withKey('a BluRay reference from SubDL lets a DVD-only translation be retimed properly', async () => {
  const id = title('tt0000101', 'dvd', [...blurayRefs('a'), en('a-9', 'Seven.S01.Complete', { full_season: true }), en('a-8', 'Seven.2002.BluRay.CD1')]);
  const r = await call(path(id, BLURAY));
  const subs = subsOf(r);
  assert.ok(good(H.error(await fetchSrt(subs[0]), onBluRay(greek))), 'the first version fits the BluRay');
  assert.ok(!subs.some((x) => /filmspeed/.test(x.id)), 'no blind film-speed guess when a real reference exists');
  assert.strictEqual(r.headers['cache-control'], CACHE.spent, 'an answer that cost downloads is kept for three days');
  assert.ok(asked(0, DL).every((f) => f.includes(`api_key=${KEY}`)), 'the server adds the key when it downloads');
  assert.ok(!fetched.some((f) => f.includes('a-9') || f.includes('a-8')), 'season packs and half-films are not downloaded');
  assert.ok(!asked(0, API).some((f) => /filename|videoHash|videoSize/.test(f)), 'SubDL is not told the file name or fingerprint');
  // the link carries the recipe: serving it needs the OpenSubtitles file only, no SubDL download
  const link = inside(subs[0]);
  assert.ok(link.g.includes('subs5.strem.io') && link.x && !link.r, JSON.stringify(link));
  // the key appears nowhere a viewer can see
  const file = await call(linkOf(subs[0]));
  for (const text of [r.body, JSON.stringify(r.headers), file.body, JSON.stringify(file.headers), ...subs.map((x) => JSON.stringify(inside(x)))]) {
    assert.ok(!text.includes(KEY) && !/api_key/.test(text), 'the key leaked');
  }
});

withKey('a translation SubDL has for the right release is offered, through a signed link only', async () => {
  const tag = 'b';
  const id = title('tt0000102', 'dvdNoGreek', [...blurayRefs(tag), greekBluRay(tag)]);
  const subs = subsOf(await call(path(id, BLURAY)));
  assert.ok(H.error(await fetchSrt(subs[0]), onBluRay(greek)).max <= 2, 'it is the BluRay translation exactly as it is');
  const tok = tokenOf(subs[0]);
  assert.ok(tok.includes('.'), 'the link is signed');
  const [text, sig] = tok.split('.');
  const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  assert.strictEqual((await call(`/sub/${text}.${flipped}.srt`)).status, 404, 'a wrong signature is refused');
  assert.strictEqual((await call(`/sub/${text}.srt`)).status, 404, 'a missing signature is refused');
  // a made-up link to some other SubDL file must not make the server download it
  zips['b-secret'] = Z.build({ 'x.srt': H.srt(film) });
  const forged = Buffer.from(JSON.stringify({ g: 'https://dl.subdl.com/subtitle/b-secret.zip', l: 'ell' })).toString('base64url');
  const before = fetched.length;
  for (const t of [forged, `${forged}.${sig}`, Buffer.from(JSON.stringify({ g: u(73), r: 'https://dl.subdl.com/subtitle/b-secret.zip' })).toString('base64url')]) {
    assert.strictEqual((await call(`/sub/${t}.srt`)).status, 404);
  }
  assert.deepStrictEqual(asked(before, DL), [], 'nothing was downloaded for a link the addon did not issue');
});

withKey('SubDL is asked only when OpenSubtitles lacks what is needed, and only useful files are taken', async () => {
  const refs = blurayRefs('c');
  let mark = fetched.length;
  // OpenSubtitles has the language, and nothing says the copy played is of another kind
  await call(path(title('tt0000103', 'dvd', refs)));
  await call(path('tt0000103', 'filename=Seven.2002.DVDRip.XviD-AAA.avi'));
  // OpenSubtitles already has a BluRay reference
  await call(path(title('tt0000104', 'hasBluRay', refs), BLURAY));
  // English wanted: SubDL could only add more English, which is no reference for English
  await call('/eng' + path(title('tt0000105', 'dvd', refs), BLURAY));
  assert.deepStrictEqual(asked(mark, API), [], 'not asked in any of these');

  // a very large file with a plain name is a BluRay or web copy: asked
  mark = fetched.length;
  const big = subsOf(await call(path(title('tt0000106', 'dvd', refs), 'filename=Seven (2002).mkv&videoSize=28021802852')));
  assert.strictEqual(asked(mark, API).length, 1);
  assert.ok(good(H.error(await fetchSrt(big[0]), onBluRay(greek))));

  // SubDL has only DVD subtitles too: asked, but nothing is downloaded
  zips['c-dvd'] = Z.build({ 'd.srt': H.srt(onDvd(film)) });
  mark = fetched.length;
  const r = await call(path(title('tt0000107', 'dvd', [en('c-dvd', 'Seven.2002.DVDRip.XviD-ZZZ')]), BLURAY));
  assert.strictEqual(asked(mark, API).length, 1);
  assert.deepStrictEqual(asked(mark, DL), [], 'no download is spent on a file that cannot help');
  assert.strictEqual(r.headers['cache-control'], CACHE.normal);
});

withKey('series: SubDL is asked for the one episode, and other episodes are ignored', async () => {
  zips['d-ep2'] = Z.build({ 'S01E02.srt': H.srt(onBluRay(greek)) });
  zips['d-ep3'] = Z.build({ 'S01E03.srt': H.srt(greek) });
  const id = title('tt0000108', 'dvdNoGreek', [...blurayRefs('d'), el('d-ep2', 'Seven.S01E02.1080p.BluRay', { season: 1, episode: 2 }), el('d-ep3', 'Seven.S01E03.1080p.BluRay', { season: 1, episode: 3 })]);
  let mark = fetched.length;
  await call(`/subtitles/series/${id}:1:2/${BLURAY}.json`);
  const api = asked(mark, API);
  assert.ok(api.length === 1 && /type=tv/.test(api[0]) && /season_number=1/.test(api[0]) && /episode_number=2/.test(api[0]), api[0]);
  assert.ok(asked(mark, DL).some((f) => f.includes('d-ep2')) && !asked(mark, DL).some((f) => f.includes('d-ep3')));
  mark = fetched.length;
  await call(`/subtitles/series/${title('tt0000109', 'dvdNoGreek', [])}/${BLURAY}.json`);
  assert.deepStrictEqual(asked(mark, API), [], 'an episode with no season or number is not looked up');
});

withKey('downloads that led to nothing are still remembered for three days', async () => {
  zips['e-fake'] = Z.build({ 'el.srt': H.srt(H.translate(onBluRay(film), 5, 'Not Greek at all')) });
  const id = title('tt0000110', 'dvdNoGreek', [...blurayRefs('e'), el('e-fake', 'Seven.2002.1080p.BluRay.x264-BBB')]);
  const r = await call(path(id, BLURAY));
  assert.deepStrictEqual(subsOf(r), []);
  assert.strictEqual(r.headers['cache-control'], 'public, max-age=600, s-maxage=259200', 'or every ten minutes would cost three more downloads');
});

withKey('a SubDL file that failed for the moment is not locked in for three days', async () => {
  const id = title('tt0000111', 'dvd', blurayRefs('f'));
  behave.fail.add('f-2');
  const r = await call(path(id, BLURAY));
  assert.ok(subsOf(r).length >= 1);
  assert.strictEqual(r.headers['cache-control'], CACHE.soon);
});

withKey('a SubDL that does not answer cannot hold the player up', async () => {
  process.env.AUTOSYNC_SUBDL_MS = '150';
  behave.dlHang = true;
  const id = title('tt0000112', 'dvd', blurayRefs('g'));
  const t0 = Date.now(), mark = fetched.length;
  const r = await call(path(id, BLURAY));
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.ok(subsOf(r).length >= 1, 'the OpenSubtitles versions are offered');
  assert.strictEqual(r.headers['cache-control'], CACHE.soon);
  assert.strictEqual(asked(mark, DL).length, 1, 'one try, no retry, and the second file is not attempted');
});

withKey('"too many requests" is not retried, and SubDL is then left alone', async () => {
  behave.dlStatus = 429;
  const mark = fetched.length;
  const r = await call(path(title('tt0000113', 'dvd', blurayRefs('h')), BLURAY));
  assert.ok(subsOf(r).length >= 1);
  assert.strictEqual(asked(mark, DL).length, 1);
  assert.strictEqual(r.headers['cache-control'], CACHE.soon, 'it did not say how long, so try again soon');
});

for (const [how, headers] of [['in seconds', { 'retry-after': '50000' }], ['as a date', { 'retry-after': new Date(Date.now() + 50000e3).toUTCString() }], ['as a reset time', { 'x-ratelimit-reset': new Date(Date.now() + 50000e3).toISOString() }]]) {
  withKey(`when the daily limit is used up (wait given ${how}), SubDL is not asked again until the reset`, async () => {
    Object.assign(behave, { dlStatus: 429, dlHeaders: headers });
    const tag = `i${how.length}`;
    const first = await call(path(title(`tt00002${how.length}1`, 'dvd', blurayRefs(tag)), BLURAY));
    assert.ok(subsOf(first).length >= 1);
    assert.strictEqual(first.headers['cache-control'], CACHE.hour, 'looked at again in an hour, not every few minutes');
    calm(); // even if SubDL would answer now, the wait it asked for is respected
    const mark = fetched.length;
    const second = await call(path(title(`tt00002${how.length}2`, 'dvd', blurayRefs(tag + 'x')), BLURAY));
    assert.ok(subsOf(second).length >= 1);
    assert.deepStrictEqual([...asked(mark, API), ...asked(mark, DL)], [], 'not contacted at all while it rests');
  });
}

withKey('the list service refusing, failing or rejecting the key also rests SubDL', async () => {
  const refs = blurayRefs('j');
  // "too many requests" from the list service, with a long wait
  Object.assign(behave, { apiStatus: 429, apiHeaders: { 'retry-after': '40000' } });
  let r = await call(path(title('tt0000120', 'dvd', refs), BLURAY));
  assert.strictEqual(r.headers['cache-control'], CACHE.hour);
  calm();
  let mark = fetched.length;
  await call(path(title('tt0000121', 'dvd', refs), BLURAY));
  assert.deepStrictEqual(asked(mark, API), []);
  resetSubdl();

  // a rejected key: no point asking again for an hour
  behave.apiStatus = 403;
  r = await call(path(title('tt0000122', 'dvd', refs), BLURAY));
  assert.ok(subsOf(r).length >= 1);
  assert.strictEqual(r.headers['cache-control'], CACHE.hour);
  calm(); resetSubdl();

  // an answer that says "failed" is not read as "SubDL has nothing"
  behave.apiBody = '{"status":false,"error":"something"}';
  r = await call(path(title('tt0000123', 'dvd', refs), BLURAY));
  assert.ok(subsOf(r).length >= 1);
  assert.strictEqual(r.headers['cache-control'], CACHE.soon);
});

withKey('an archive with no usable subtitle is downloaded once, not again for every request', async () => {
  zips['k-ass'] = Z.build({ 'Seven.2002.1080p.BluRay.ass': 'not an srt' });
  const id = title('tt0000124', 'dvd', [en('k-ass', 'Seven.2002.1080p.BluRay.x264-BBB')]);
  const mark = fetched.length;
  const r = await call(path(id, BLURAY));
  await call(path(id, BLURAY + '&videoSize=5'));
  await call(path(id, BLURAY + '&videoSize=6'));
  assert.strictEqual(asked(mark, DL).length, 1);
  assert.ok(subsOf(r).length >= 1);
});

withKey('a redirect from SubDL to another site is not followed, so the key goes nowhere else', async () => {
  behave.redirect['l-1'] = 'https://evil.example/collect';
  const refs = blurayRefs('l');
  await call(path(title('tt0000125', 'dvd', refs), BLURAY));
  assert.ok(!fetched.some((f) => f.includes('evil.example')));
  delete behave.redirect['l-1'];
});

test('without a key SubDL does not exist: never asked, its links refused, redirects to it not followed', async () => {
  // issue a signed link while SubDL is on
  process.env.SUBDL_API_KEY = KEY;
  const subs = subsOf(await call(path(title('tt0000126', 'dvdNoGreek', [...blurayRefs('m'), greekBluRay('m')]), BLURAY)));
  const signedLink = `/sub/${tokenOf(subs[0])}.srt`;
  zips['m-new'] = Z.build({ 'x.srt': H.srt(onBluRay(greek)) });
  delete process.env.SUBDL_API_KEY;
  resetSubdl();

  const mark = fetched.length;
  const plain = subsOf(await call(path(title('tt0000127', 'redirects', blurayRefs('n')), BLURAY)));
  assert.ok(plain.length >= 1, 'the DVD versions are offered as always');
  assert.deepStrictEqual(fetched.slice(mark).filter((f) => /subdl\.com/.test(f)), [], 'no request reaches SubDL, not even through a redirect');
  const other = Buffer.from(JSON.stringify({ g: 'https://dl.subdl.com/subtitle/m-new.zip', l: 'ell' })).toString('base64url');
  assert.strictEqual((await call(`/sub/${other}.x.srt`)).status, 404);
  assert.ok(!fetched.slice(mark).some((f) => f.includes('m-new')));
  void signedLink;
});

test('across every test above, nothing was requested from an unexpected place', () => {
  const ok = /^https:\/\/(opensubtitles-v3\.strem\.io|subs5\.strem\.io|api\.subdl\.com|dl\.subdl\.com)\//;
  assert.deepStrictEqual(fetched.filter((f) => !ok.test(f)), []);
});
