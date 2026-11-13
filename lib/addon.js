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
const allowed = (url) => url.startsWith(UPSTREAM + '/') || SUB_HOST.test(url);

const MAX_REFS = 14, MAX_TARGETS = 6, MAX_VARIANTS = 4;
const MAX_GROUPS_TRIED = 8; // timing groups examined before giving up on filling the list
const PARALLEL = 6; // downloads at once, to stay polite to the subtitle servers
const MAX_BYTES = 3 * 1024 * 1024; // no real subtitle file is bigger than this
const MIN_FIT = 0.72; // share of speech a version must line up with to be offered
const deadline = () => +process.env.AUTOSYNC_DEADLINE_MS || 45000; // answer "nothing" rather than hang the player

const MIN = 60 * 1000, HOUR = 60 * MIN;

// Older films were often released on 25 fps DVDs, which play about 4% faster than the 23.976 fps
// copies streamed today. Stretching DVD-timed subtitles by this factor removes the drift.
const PAL_TO_FILM = 25 / 23.976;

// Codes are the ones the OpenSubtitles addon uses.
const LANGS = {
  ell: 'Greek', eng: 'English', spa: 'Spanish', fre: 'French', ger: 'German', ita: 'Italian', por: 'Portuguese',
  pob: 'Portuguese (Brazil)', nld: 'Dutch', pol: 'Polish', tur: 'Turkish', rus: 'Russian', ukr: 'Ukrainian',
  ara: 'Arabic', heb: 'Hebrew', per: 'Persian', ron: 'Romanian', bul: 'Bulgarian', srp: 'Serbian', hrv: 'Croatian',
  bos: 'Bosnian', mac: 'Macedonian', slv: 'Slovenian', cze: 'Czech', slo: 'Slovak', hun: 'Hungarian', alb: 'Albanian',
  dan: 'Danish', swe: 'Swedish', nor: 'Norwegian', fin: 'Finnish', est: 'Estonian', lit: 'Lithuanian', lav: 'Latvian',
  glg: 'Galician', jpn: 'Japanese', kor: 'Korean', zho: 'Chinese', vie: 'Vietnamese', ind: 'Indonesian', may: 'Malay',
  tha: 'Thai', hin: 'Hindi', ben: 'Bengali', tam: 'Tamil', sin: 'Sinhala', bur: 'Burmese', tat: 'Tatar',
};

function manifest(lang, legacy, baseUrl) {
  return {
    // the original Greek-only address keeps its id so existing installs carry on untouched
    id: legacy ? 'community.greek.autosync' : `community.autosync.${lang}`,
    version: '2.2.0',
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

// Small in-memory cache: key -> promise, each with an expiry so a long-running copy refreshes.
const cache = new Map();
function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.p;
  const entry = { exp: Infinity }; // never expires while still being worked out
  entry.p = fn().then(
    (v) => { entry.exp = Date.now() + (typeof ttl === 'function' ? ttl(v) : ttl); return v; },
    (e) => { if (cache.get(key) === entry) cache.delete(key); throw e; },
  );
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > 300) cache.delete(cache.keys().next().value);
  return entry.p;
}

const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });

// One download. Redirects are followed by hand so that every hop is checked against the
// allow-list: nothing is ever requested from another host.
async function getOnce(url, ms) {
  let at = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!allowed(at)) throw fatal('host not allowed');
    const r = await fetch(at, { redirect: 'manual', signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'autosync-subtitles' } });
    if (r.status >= 300 && r.status < 400) {
      const to = r.headers.get('location');
      if (!to) throw fatal('redirect without a destination');
      at = new URL(to, at).href;
      continue;
    }
    if (!r.ok) throw Object.assign(new Error(`upstream answered ${r.status}`), { fatal: r.status < 500 && r.status !== 429 });
    if (+r.headers.get('content-length') > MAX_BYTES) throw fatal('file too large');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw fatal('file too large');
    return buf;
  }
  throw fatal('too many redirects');
}

// The subtitle servers sometimes answer with a temporary error; one more try usually works.
async function get(url, ms = 12000) {
  try {
    return await getOnce(url, ms);
  } catch (e) {
    if (e.fatal) throw e;
    await new Promise((r) => setTimeout(r, 400));
    return getOnce(url, ms);
  }
}

function loadCues(url, lang) {
  if (typeof url !== 'string' || !SUB_HOST.test(url)) return Promise.reject(fatal('subtitle host not allowed'));
  return cached(`cues:${S.legacyEncoding(lang)}:${url}`, 6 * HOUR, async () => S.parseSrt(S.decode(await get(url), lang)));
}

// Where the film's dialogue ends. The very last cue is not trusted: one stray credit line hours
// after the end would otherwise make every other file look too short.
function span(cues) {
  return cues.length ? cues[Math.floor((cues.length - 1) * 0.98)].end : 0;
}

const token = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function untoken(t) {
  if (t.length > 700) throw fatal('bad link');
  const o = JSON.parse(Buffer.from(t, 'base64url').toString());
  if (!o || typeof o.g !== 'string' || typeof o.r !== 'string' || !SUB_HOST.test(o.g) || !SUB_HOST.test(o.r)) throw fatal('bad link');
  return { g: o.g, r: o.r, l: LANGS[o.l] ? o.l : 'ell', ...(o.k === 'pal' ? { k: 'pal' } : {}) };
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

// Keeps the files that are whole subtitles for the whole film.
function usable(list) {
  // A real subtitle has several lines a minute; "signs only" and broken files do not.
  const ok = list.filter((s) => s.cues.length >= Math.max(30, (span(s.cues) / MIN) * 3));
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
  return groups;
}

// The extra details Stremio adds to a subtitles request. `extra` is already decoded, so an "&"
// may be part of a file name: fields are split only where one of the known names begins.
const EXTRA_KEYS = ['videoHash', 'videoSize', 'filename'];
function parseExtra(extra) {
  const out = {};
  for (const part of String(extra || '').split(/&(?=(?:videoHash|videoSize|filename)=)/)) {
    const i = part.indexOf('=');
    if (i > 0 && EXTRA_KEYS.includes(part.slice(0, i))) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}
const encodeExtra = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// The work behind one request. `extra` holds the parsed extra details.
// Returns { items: [{ id, tok }], partial, note }; `partial` means some downloads failed.
async function find(lang, type, id, extra) {
  const tail = encodeExtra(extra);
  const path = `/subtitles/${type}/${encodeURIComponent(id)}${tail ? '/' + tail : ''}.json`;
  const up = JSON.parse((await get(UPSTREAM + path)).toString());
  const video = extra.filename ? R.info(extra.filename) : null;

  // Score every subtitle from its description alone, before downloading anything.
  const all = (Array.isArray(up.subtitles) ? up.subtitles : [])
    .filter((s) => s && typeof s.url === 'string' && SUB_HOST.test(s.url) && !/\bcd\s?\d\b/i.test(s.subtitleFileName || ''))
    .map((s) => {
      const rel = R.info(s.movieReleaseName, s.subtitleFileName);
      const pre = (s.m === 'h' ? 100 : 0) + (video ? R.match(video, rel) : 0) + R.SRC_WEIGHT[rel.src] + (s.lang === 'eng' ? 0.5 : 0);
      return { id: String(s.id), url: s.url, lang: s.lang, fps: +s.fpsMilli || 0, rel, pre };
    })
    .sort((a, b) => b.pre - a.pre);

  const targets = all.filter((s) => s.lang === lang).slice(0, MAX_TARGETS);
  if (!targets.length) return { items: [], partial: false, note: `no ${LANGS[lang]} subtitles on OpenSubtitles` };
  const refList = all.filter((s) => s.lang !== lang).slice(0, MAX_REFS);

  let failed = 0; // downloads that failed for a temporary reason; a file that is gone for good is not one
  const got = (await pool([...refList, ...targets], (s) =>
    loadCues(s.url, s.lang).then((cues) => ({ ...s, cues }), (e) => { if (!e.fatal) failed++; return null; }))).filter(Boolean);
  // A few files on the subtitle servers fail every time. Only a real share of failures means
  // "the servers are having a bad moment, try again soon".
  const partial = failed > Math.max(2, (refList.length + targets.length) / 4);
  const refs = usable(got.filter((s) => s.lang !== lang));
  let mine = usable(got.filter((s) => s.lang === lang));
  if (lang === 'ell') mine = mine.filter((s) => S.greekShare(s.cues) > 0.5);
  if (!mine.length || !refs.length) return { items: [], partial, note: 'nothing usable to sync against' };

  // Subtitles in the wanted language are timing evidence too, but a group is only believed when
  // a subtitle in another language agrees with it.
  const everything = [...refs, ...mine].sort((a, b) => b.pre - a.pre);
  const groups = cluster(everything)
    .map(({ members }) => {
      const ref = members.find((m) => m.lang !== lang);
      const known = members.filter((m) => m.rel.src);
      const allCam = known.length > 0 && known.every((m) => m.rel.src === 'cam');
      return { ref, own: members.find((m) => m.lang === lang), score: members[0].pre + 0.3 * members.length - (allCam && !video ? 1 : 0) };
    })
    .filter((g) => g.ref)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_GROUPS_TRIED);
  if (!groups.length) return { items: [], partial, note: 'nothing usable to sync against' };

  // The translation that sits best on the most likely timing is retimed for every group that
  // has no translation of its own.
  let best = null;
  for (const t of mine) {
    const fit = S.align(groups[0].ref.cues, t.cues, { piecewise: false }).after;
    if (!best || fit > best.fit) best = { t, fit };
  }

  // Every version offered must line up with a subtitle in another language: better to offer
  // nothing than subtitles that are confidently wrong.
  const items = [];
  for (const g of groups) {
    if (items.length === MAX_VARIANTS) break;
    const n = items.length + 1;
    if (g.own && S.fit(S.timeline(g.ref.cues), S.stripAds(g.own.cues), 1, 0) >= MIN_FIT) {
      // a translation already made for this release: used exactly as it is
      items.push({ id: `autosync-${lang}-${n}-${g.own.id}`, tok: token({ g: g.own.url, r: g.own.url, l: lang }) });
    } else if (S.align(g.ref.cues, S.stripAds(best.t.cues)).after >= MIN_FIT) {
      items.push({ id: `autosync-${lang}-${n}-${best.t.id}`, tok: token({ g: best.t.url, r: g.ref.url, l: lang }) });
    }
  }
  const slow = filmSpeedVersion(lang, [...refs, ...mine], items);
  if (slow) items.splice(Math.min(items.length, MAX_VARIANTS - 1), 1, slow); // always the last one listed
  return { items, partial };
}

// When every subtitle that exists is for a 25 fps DVD, nothing can be retimed to the copy being
// streamed, because no subtitle has that timing. Offer the most likely version once more,
// stretched to film speed. It is a guess: the drift goes, a constant offset of a few seconds
// may remain, and the player's subtitle delay can take that out.
function filmSpeedVersion(lang, files, items) {
  if (!items.length) return null;
  const marked = files.filter((f) => f.fps);
  const dvd = marked.filter((f) => Math.abs(f.fps - 25000) < 50);
  if (marked.length < 3 || dvd.length < marked.length * 0.8) return null; // not clearly 25 fps
  const lengths = files.map((f) => span(f.cues)).sort((a, b) => a - b);
  const middle = lengths[lengths.length >> 1];
  if (!lengths.every((l) => Math.abs(l - middle) <= middle * 0.025)) return null; // some file already has another speed
  const first = untoken(items[0].tok);
  return { id: `${items[0].id}-filmspeed`, tok: token({ ...first, k: 'pal' }) };
}

// What the handler and the scripts call: `find`, cached, with full subtitle addresses.
// `extra` is the decoded text after the id, e.g. "filename=A & B.mkv&videoSize=5".
async function subtitles(lang, type, id, extra, baseUrl) {
  const details = parseExtra(extra);
  const key = `list:${lang}:${type}:${id}:${encodeExtra(details)}`;
  const found = await cached(key, (v) => (v.partial ? 5 * MIN : v.items.length ? 6 * HOUR : 10 * MIN), () => find(lang, type, id, details));
  return {
    subtitles: found.items.map((it) => ({ id: it.id, lang, url: `${baseUrl}/sub/${it.tok}.srt` })),
    partial: found.partial,
    note: found.note,
  };
}

function syncedSrt(tok) {
  const { g, r, l, k } = untoken(tok);
  return cached('srt:' + tok, 24 * HOUR, async () => {
    const target = S.stripAds(await loadCues(g, l));
    const a = g === r
      ? { cues: target, before: 1, after: 1, ratio: 1, offset: 0, splits: 0 }
      : S.align(await loadCues(r), target);
    if (k === 'pal') {
      a.cues = a.cues.map((c) => ({ start: c.start * PAL_TO_FILM, end: c.end * PAL_TO_FILM, text: c.text }));
      a.filmSpeed = true;
    }
    return { srt: S.toSrt(a.cues), info: a };
  });
}

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('took too long')), ms).unref());

// The path Stremio asked for, decoded. On Vercel the rewrite hands us
// /api/index?<the visitor's own query>&__p=<path>, with the path decoded and then encoded again
// as one value; on a plain server the path arrives as it was sent.
function requestPath(url) {
  let raw;
  if (url.startsWith('/api/index')) {
    const at = url.lastIndexOf('__p=');
    raw = '/' + (at >= 0 ? url.slice(at + 4).split('&')[0] : '');
  } else {
    raw = url.split('?')[0];
  }
  try { return decodeURIComponent(raw); } catch { return raw; } // a stray "%" is left as it is
}

// One handler for every route; works behind plain Node http and serverless hosts alike.
async function handle(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // maxAge: how long the player may reuse the answer; shared: how long a CDN in front may.
  const send = (code, type, body, maxAge = 0, shared = maxAge) => {
    res.statusCode = code;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', maxAge ? `public, max-age=${maxAge}, s-maxage=${shared}` : 'no-store');
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const json = (code, obj, maxAge, shared) => send(code, 'application/json; charset=utf-8', JSON.stringify(obj), maxAge, shared);
  if (req.method === 'OPTIONS') return send(204, 'text/plain', '');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'method not allowed');

  // The address this copy is being reached at, used to build links back to it. Anything that
  // is not a plain host name is refused, so a forged header cannot put text into a page or link.
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!/^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i.test(host)) return send(400, 'text/plain', 'bad request');
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https' : 'http';
  const baseUrl = `${proto}://${host}`;

  let p = requestPath(String(req.url || '/'));
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
        body = await Promise.race([subtitles(lang, m[1], m[2], m[3], baseUrl), timeout(deadline())]);
      } catch {
        // Never make the player wait or show an error: no synced subtitles this time, try again soon.
        return json(200, { subtitles: [] }, 60);
      }
      const out = { subtitles: body.subtitles };
      if (body.partial) return json(200, out, 300); // some downloads failed: let it be redone soon
      if (!out.subtitles.length) return json(200, out, 600);
      return json(200, out, 2 * 3600, 6 * 3600);
    }
    if ((m = /^\/sub\/([A-Za-z0-9_-]+)\.srt$/.exec(p))) {
      let done;
      try { done = await Promise.race([syncedSrt(m[1]), timeout(deadline())]); } catch { return send(404, 'text/plain', 'subtitle not available'); }
      return send(200, 'text/plain; charset=utf-8', done.srt, 7 * 24 * 3600);
    }
    return send(404, 'text/plain', 'not found');
  } catch {
    return send(500, 'text/plain', 'something went wrong');
  }
}

module.exports = { handle, manifest, subtitles, syncedSrt, untoken, requestPath, LANGS };
