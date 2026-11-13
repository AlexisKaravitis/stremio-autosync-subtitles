'use strict';
// AutoSync Subtitles: a Stremio subtitles addon.
// For each video it takes the subtitles OpenSubtitles has in your language, works out which
// timings the subtitles in every language agree on (one group per release of the film), and
// offers your language retimed to the timings most likely to match the video being played.

const S = require('./sync');
const R = require('./release');
const page = require('./page');
const LOGO = Buffer.from(require('./logo'), 'base64');

const UPSTREAM = 'https://opensubtitles-v3.strem.io';
const SUB_HOST = /^https:\/\/subs\d*\.strem\.io\/[\w\-./]+$/; // the only place subtitles are downloaded from
const MAX_REFS = 14, MAX_TARGETS = 6, MAX_VARIANTS = 4;
const PARALLEL = 6; // downloads at once, to stay polite to the subtitle servers
const MAX_BYTES = 3 * 1024 * 1024; // no real subtitle file is bigger than this
const DEADLINE = 45000; // give up and answer "nothing" rather than hang the player
const MIN_FIT = 0.72;

const LANGS = {
  ell: 'Greek', eng: 'English', spa: 'Spanish', fre: 'French', ger: 'German', ita: 'Italian', por: 'Portuguese',
  pob: 'Portuguese (Brazil)', nld: 'Dutch', pol: 'Polish', tur: 'Turkish', rus: 'Russian', ukr: 'Ukrainian',
  ara: 'Arabic', heb: 'Hebrew', per: 'Persian', ron: 'Romanian', bul: 'Bulgarian', srp: 'Serbian', hrv: 'Croatian',
  slv: 'Slovenian', cze: 'Czech', slo: 'Slovak', hun: 'Hungarian', alb: 'Albanian', dan: 'Danish', swe: 'Swedish',
  nor: 'Norwegian', fin: 'Finnish', est: 'Estonian', lit: 'Lithuanian', lav: 'Latvian', jpn: 'Japanese',
  kor: 'Korean', chi: 'Chinese', vie: 'Vietnamese', ind: 'Indonesian', tha: 'Thai', hin: 'Hindi',
};

function manifest(lang, legacy, baseUrl) {
  return {
    // the original Greek-only address keeps its id so existing installs carry on untouched
    id: legacy ? 'community.greek.autosync' : `community.autosync.${lang}`,
    version: '2.0.0',
    name: legacy ? 'Greek AutoSync' : `AutoSync Subtitles (${LANGS[lang]})`,
    description: `${LANGS[lang]} subtitles from OpenSubtitles, automatically retimed to match your video: fixes delays, wrong frame rate and different cuts. Free and open source, no account, no tracking.`,
    logo: `${baseUrl}/logo.png`, // served by whichever copy of the addon is running
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: true },
  };
}

const cache = new Map(); // small in-memory cache: key -> promise
function cached(key, fn, max = 300) {
  if (cache.has(key)) return cache.get(key);
  const p = fn().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, p);
  if (cache.size > max) cache.delete(cache.keys().next().value);
  return p;
}

async function getOnce(url, ms) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'autosync-subtitles' } });
  if (!r.ok) throw Object.assign(new Error(`upstream answered ${r.status}`), { retry: r.status >= 500 || r.status === 429 });
  if (+r.headers.get('content-length') > MAX_BYTES) throw new Error('file too large');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('file too large');
  return buf;
}

// The subtitle servers sometimes answer with a temporary error; one more try usually works.
async function get(url, ms = 12000) {
  try {
    return await getOnce(url, ms);
  } catch (e) {
    if (e.retry === false || /too large/.test(e.message)) throw e;
    await new Promise((r) => setTimeout(r, 400));
    return getOnce(url, ms);
  }
}

function loadCues(url) {
  if (typeof url !== 'string' || !SUB_HOST.test(url)) return Promise.reject(new Error('subtitle host not allowed'));
  return cached('cues:' + url, async () => S.parseSrt(S.decode(await get(url))));
}

const span = (cues) => (cues.length ? cues[cues.length - 1].end : 0);
const token = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function untoken(t) {
  if (t.length > 700) throw new Error('bad link');
  const o = JSON.parse(Buffer.from(t, 'base64url').toString());
  if (!o || !SUB_HOST.test(o.g) || !SUB_HOST.test(o.r)) throw new Error('bad link');
  return o;
}

// Runs `fn` over `items`, a few at a time.
async function pool(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// Downloads and parses a list of subtitles. `failed` counts the ones that could not be fetched.
async function loadAll(list, stats) {
  const got = await pool(list, (s) => loadCues(s.url).then((cues) => ({ ...s, cues }), () => { stats.failed++; return null; }));
  // A real subtitle has several lines a minute; "signs only" and broken files do not.
  const ok = got.filter((s) => s && s.cues.length >= Math.max(30, (span(s.cues) / 60000) * 3));
  // drop half-films (old "CD1/CD2" files): much shorter than the rest
  const longest = Math.max(0, ...ok.map((s) => span(s.cues)));
  return ok.filter((s) => span(s.cues) >= longest * 0.6);
}

// Group subtitles that share the same timing (same release of the film). Each subtitle joins
// the first group whose leading member it matches; it is never chained through other members,
// because releases a second apart must stay apart.
function cluster(subs) {
  const groups = [];
  for (const sub of subs) {
    const home = groups.find((g) => S.sameTiming(g.tl, sub.cues));
    if (home) home.members.push(sub);
    else groups.push({ tl: S.timeline(sub.cues), members: [sub] });
  }
  return groups.map((g) => g.members);
}

function parseExtra(extra) {
  const out = {};
  for (const part of String(extra || '').split('&')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1)); } catch { /* ignore */ } }
  }
  return out;
}

async function subtitles(lang, type, id, extra, baseUrl) {
  const path = `/subtitles/${type}/${encodeURIComponent(id)}${extra ? '/' + extra : ''}.json`;
  const up = JSON.parse((await get(UPSTREAM + path)).toString());
  const filename = parseExtra(extra).filename;
  const video = filename ? R.info(filename) : null;

  // Score every subtitle from its description alone, before downloading anything.
  const all = (Array.isArray(up.subtitles) ? up.subtitles : [])
    .filter((s) => s && typeof s.url === 'string' && SUB_HOST.test(s.url) && !/\bcd\s?\d\b/i.test(s.subtitleFileName || ''))
    .map((s) => {
      const rel = R.info(s.movieReleaseName, s.subtitleFileName);
      const pre = (s.m === 'h' ? 100 : 0) + (video ? R.match(video, rel) : 0) + R.SRC_WEIGHT[rel.src] + (s.lang === 'eng' ? 0.5 : 0);
      return { id: String(s.id), url: s.url, lang: s.lang, hashMatch: s.m === 'h', rel, pre };
    })
    .sort((a, b) => b.pre - a.pre);

  const targets = all.filter((s) => s.lang === lang).slice(0, MAX_TARGETS);
  if (!targets.length) return { subtitles: [], note: `no ${LANGS[lang]} subtitles on OpenSubtitles` };
  const refList = all.filter((s) => s.lang !== lang).slice(0, MAX_REFS);

  const stats = { failed: 0 };
  const [refs, tg] = await Promise.all([loadAll(refList, stats), loadAll(targets, stats)]);
  const targetsOk = lang === 'ell' ? tg.filter((s) => S.greekShare(s.cues) > 0.5) : tg;
  if (!targetsOk.length) {
    if (stats.failed) throw new Error('subtitle downloads failed'); // temporary: do not cache as "none"
    return { subtitles: [], note: 'no usable subtitles in that language' };
  }

  // Subtitles in the wanted language are timing evidence too.
  const everything = [...refs, ...targetsOk].sort((a, b) => b.pre - a.pre);
  const groups = cluster(everything).map((members) => {
    const known = members.filter((m) => m.rel.src);
    const allCam = known.length > 0 && known.every((m) => m.rel.src === 'cam');
    const score = members[0].pre + 0.3 * members.length - (allCam && !video ? 1 : 0);
    return { members, rep: members[0], score };
  }).sort((a, b) => b.score - a.score).slice(0, MAX_VARIANTS);

  // The translation that sits best on the most likely timing is the fallback for every group.
  let best = null;
  for (const t of targetsOk) {
    const fit = S.align(groups[0].rep.cues, t.cues, { piecewise: false }).after;
    if (!best || fit > best.fit) best = { t, fit };
  }
  const out = [];
  groups.forEach((g, i) => {
    // A translation already made for this release needs no guessing: use it.
    const own = g.members.find((m) => m.lang === lang);
    const t = own || best.t;
    // Every version must be a believable match: better to offer nothing than subtitles that
    // are confidently wrong.
    if (!own && S.align(g.rep.cues, S.stripAds(t.cues)).after < MIN_FIT) return;
    out.push({
      id: `autosync-${lang}-${i + 1}-${t.id}`,
      lang,
      url: `${baseUrl}/sub/${token({ g: t.url, r: (own || g.rep).url })}.srt`,
    });
  });
  if (!out.length && stats.failed) throw new Error('subtitle downloads failed');
  return { subtitles: out, cacheMaxAge: 6 * 3600, staleRevalidate: 24 * 3600, staleError: 7 * 24 * 3600 };
}

function syncedSrt(tok) {
  const { g, r } = untoken(tok);
  return cached('srt:' + tok, async () => {
    const [ref, target] = await Promise.all([loadCues(r), loadCues(g)]);
    const a = S.align(ref, S.stripAds(target));
    return { srt: S.toSrt(a.cues), info: a };
  });
}

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('took too long')), ms).unref());

// One handler for every route; works behind plain Node http and serverless hosts alike.
async function handle(req, res) {
  // On Vercel the rewrite hands us /api/index?__p=<original path>; recover the original.
  const at = req.url.indexOf('__p=');
  let raw = at >= 0 ? '/' + req.url.slice(at + 4) : req.url;
  if (at >= 0) { try { raw = decodeURIComponent(raw); } catch { /* keep as is */ } }
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const baseUrl = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (code, type, body, maxAge = 0) => {
    res.statusCode = code;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', maxAge ? `public, max-age=${maxAge}, s-maxage=${maxAge}` : 'no-store');
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const json = (code, obj, maxAge) => send(code, 'application/json; charset=utf-8', JSON.stringify(obj), maxAge);
  if (req.method === 'OPTIONS') return send(204, 'text/plain', '');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'method not allowed');

  let p;
  try { p = new URL(raw.split('?')[0].replace(/:/g, '%3A'), 'http://x').pathname; } catch { return send(400, 'text/plain', 'bad request'); }
  if (p.length > 2000) return send(414, 'text/plain', 'address too long');

  // optional language prefix: /spa/manifest.json. No prefix means Greek (the original address).
  let lang = 'ell', legacy = true, m;
  if ((m = /^\/([a-z]{3})(\/.*)$/.exec(p)) && m[1] !== 'sub') {
    if (!LANGS[m[1]]) return send(404, 'text/plain', 'unknown language');
    lang = m[1]; legacy = false; p = m[2];
  }

  try {
    if (p === '/manifest.json') return json(200, manifest(lang, legacy, baseUrl), 3600);
    if (p === '/' || p === '/configure') return send(200, 'text/html; charset=utf-8', page(LANGS, lang, baseUrl), 3600);
    if (p === '/logo.png') return send(200, 'image/png', LOGO, 7 * 24 * 3600);
    if ((m = /^\/subtitles\/(movie|series)\/([^/]+?)(?:\/(.+))?\.json$/.exec(p))) {
      let body;
      try {
        body = await Promise.race([
          cached(`list:${lang}:${p}`, () => subtitles(lang, m[1], decodeURIComponent(m[2]), m[3], baseUrl)),
          timeout(DEADLINE),
        ]);
      } catch {
        // Never make the player wait or show an error: no synced subtitles this time, try again soon.
        return json(200, { subtitles: [] }, 60);
      }
      return json(200, body, body.subtitles.length ? 6 * 3600 : 600);
    }
    if ((m = /^\/sub\/([A-Za-z0-9_-]+)\.srt$/.exec(p))) {
      let done;
      try { done = await Promise.race([syncedSrt(m[1]), timeout(DEADLINE)]); } catch { return send(404, 'text/plain', 'subtitle not available'); }
      return send(200, 'text/plain; charset=utf-8', done.srt, 7 * 24 * 3600);
    }
    return send(404, 'text/plain', 'not found');
  } catch {
    return send(500, 'text/plain', 'something went wrong');
  }
}

module.exports = { handle, manifest, subtitles, syncedSrt, untoken, LANGS };
