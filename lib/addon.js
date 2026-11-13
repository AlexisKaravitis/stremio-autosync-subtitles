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
const MAX_REFS = 12, MAX_TARGETS = 6, MAX_VARIANTS = 3;
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

async function get(url, ms = 12000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'autosync-subtitles' } });
  if (!r.ok) throw new Error(`upstream answered ${r.status}`);
  if (+r.headers.get('content-length') > MAX_BYTES) throw new Error('file too large');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('file too large');
  return buf;
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

async function loadAll(list) {
  const got = await Promise.all(list.map((s) => loadCues(s.url).then((cues) => ({ ...s, cues }), () => null)));
  const ok = got.filter((s) => s && s.cues.length >= 30);
  // drop half-films (old "CD1/CD2" files): much shorter than the rest
  const longest = Math.max(0, ...ok.map((s) => span(s.cues)));
  return ok.filter((s) => span(s.cues) >= longest * 0.6);
}

// Group subtitles that already share the same timing (same release of the film).
function cluster(subs) {
  const tls = subs.map((r) => S.timeline(r.cues));
  const parent = subs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < subs.length; i++) for (let j = i + 1; j < subs.length; j++) {
    if (find(i) !== find(j) && S.sameTiming(tls[i], subs[j].cues)) parent[find(j)] = find(i);
  }
  const groups = new Map();
  subs.forEach((r, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  return [...groups.values()];
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

  const [refs, tg] = await Promise.all([loadAll(refList), loadAll(targets)]);
  const targetsOk = lang === 'ell' ? tg.filter((s) => S.greekShare(s.cues) > 0.5) : tg;
  if (!targetsOk.length) return { subtitles: [], note: 'no usable subtitles in that language' };

  // Subtitles in the wanted language are timing evidence too.
  const groups = cluster([...refs, ...targetsOk]).map((members) => {
    members.sort((a, b) => b.pre - a.pre);
    const known = members.filter((m) => m.rel.src);
    const allCam = known.length > 0 && known.every((m) => m.rel.src === 'cam');
    const score = members[0].pre + 0.3 * members.length - (allCam && !video ? 1 : 0);
    return { members, rep: members[0], score };
  }).sort((a, b) => b.score - a.score).slice(0, MAX_VARIANTS);

  // Pick the translation that sits best on the most likely timing.
  let best = null;
  for (const t of targetsOk) {
    const fit = S.align(groups[0].rep.cues, t.cues, { piecewise: false }).after;
    if (!best || fit > best.fit) best = { t, fit };
  }
  const out = [];
  groups.forEach((g, i) => {
    // Every version must be a believable match, the first one included: better to offer
    // nothing than subtitles that are confidently wrong.
    if (S.align(g.rep.cues, S.stripAds(best.t.cues)).after < MIN_FIT) return;
    out.push({
      id: `autosync-${lang}-${i + 1}-${best.t.id}`,
      lang,
      url: `${baseUrl}/sub/${token({ g: best.t.url, r: g.rep.url })}.srt`,
    });
  });
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
