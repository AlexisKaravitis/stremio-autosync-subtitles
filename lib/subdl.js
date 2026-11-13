'use strict';
// SubDL (subdl.com): an optional second source of subtitles. It often has files made for BluRay
// and web releases that the OpenSubtitles listing lacks. It needs a free API key, given to the
// addon as the SUBDL_API_KEY environment variable; without one this source is simply off.
//
// The key is a secret. SubDL puts it inside every download link it returns, so links are
// stripped down to their bare form here, and the key is added back only at the moment the
// server itself downloads a file. It must never reach a link that a viewer receives.
//
// The free plan allows 50 downloads a day, so every download has to be worth it.

const crypto = require('crypto');
const Z = require('./zip');

const API = 'https://api.subdl.com/api/v1/subtitles';
const FILE = /^https:\/\/dl\.subdl\.com\/subtitle\/[\w-]+\.zip$/; // the bare form of a download link

// The addon's language codes -> SubDL's.
const CODES = {
  ell: 'EL', eng: 'EN', spa: 'ES', fre: 'FR', ger: 'DE', ita: 'IT', por: 'PT', pob: 'BR_PT', nld: 'NL', pol: 'PL',
  tur: 'TR', rus: 'RU', ukr: 'UK', ara: 'AR', heb: 'HE', per: 'FA', ron: 'RO', bul: 'BG', srp: 'SR', hrv: 'HR',
  bos: 'BS', mac: 'MK', slv: 'SL', cze: 'CS', slo: 'SK', hun: 'HU', alb: 'SQ', dan: 'DA', swe: 'SV', nor: 'NO',
  fin: 'FI', est: 'ET', lit: 'LT', lav: 'LV', jpn: 'JA', kor: 'KO', zho: 'ZH', vie: 'VI', ind: 'ID', may: 'MS',
  tha: 'TH', hin: 'HI', ben: 'BN', tam: 'TA', sin: 'SI', bur: 'MY',
};
const BACK = Object.fromEntries(Object.entries(CODES).map(([ours, theirs]) => [theirs, ours]));

const key = () => process.env.SUBDL_API_KEY || '';
const enabled = () => key().length > 0;
const isFile = (url) => typeof url === 'string' && FILE.test(url);
const hasLanguage = (lang) => Boolean(CODES[lang]);

// A subtitle link that makes the server download from SubDL costs one of the day's downloads.
// Such links carry this signature, so only links the addon itself issued are honoured.
function sign(text) {
  const secret = crypto.createHash('sha256').update('autosync-link:' + key()).digest();
  return crypto.createHmac('sha256', secret).update(text).digest('base64url').slice(0, 22);
}
function signed(text, signature) {
  if (!enabled() || typeof signature !== 'string') return false;
  const want = Buffer.from(sign(text)), got = Buffer.from(signature);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// What to ask SubDL for a title. `id` is "tt123" or "tt123:season:episode". Returns null when
// asking would be pointless: an episode with no season or number would bring back the whole show.
function request(type, id, lang) {
  const [imdb, season, episode] = String(id).split(':');
  const want = { season: +season || 0, episode: +episode || 0 };
  if (type === 'series' && !(want.season && want.episode)) return null;
  const langs = [...new Set([CODES[lang], 'EN'].filter(Boolean))].join(',');
  let url = `${API}?api_key=${encodeURIComponent(key())}&imdb_id=${encodeURIComponent(imdb)}&type=${type === 'series' ? 'tv' : 'movie'}&languages=${langs}&subs_per_page=30`;
  if (type === 'series') url += `&season_number=${want.season}&episode_number=${want.episode}`;
  return { url, want: type === 'series' ? want : null };
}

// Turns SubDL's answer into the addon's own shape. Download links lose the key here.
// Throws when SubDL reports a failure, so that is never mistaken for "it has nothing".
function parseList(body, want) {
  const json = JSON.parse(body.toString());
  if (!json || json.status === false) throw new Error('SubDL reported a failure');
  const out = [];
  for (const s of Array.isArray(json.subtitles) ? json.subtitles : []) {
    if (!s || typeof s.url !== 'string' || s.full_season) continue; // season packs hold many episodes
    if (s.episode_from && s.episode_end && s.episode_from !== s.episode_end) continue;
    if (want && ((+s.season && +s.season !== want.season) || (+s.episode && +s.episode !== want.episode))) continue;
    const release = String(s.release_name || '').replace(/&amp;/g, '&');
    if (/\bcd\s?\d\b/i.test(release)) continue; // one half of a two-disc release
    let bare;
    try { bare = new URL(s.url.split('?')[0], 'https://dl.subdl.com').href; } catch { continue; }
    const lang = BACK[String(s.language || '').toUpperCase()];
    if (!lang || !FILE.test(bare)) continue;
    out.push({
      id: 'subdl-' + bare.slice(bare.lastIndexOf('/') + 1, -4),
      url: bare,
      lang,
      fpsMilli: Math.round((+s.fps || +s.framerate || 0) * 1000),
      movieReleaseName: release,
    });
  }
  return out;
}

// The address the server downloads a file from: the bare link plus the key.
const downloadUrl = (bare) => `${bare}?api_key=${encodeURIComponent(key())}`;

// Picks the subtitle out of a downloaded archive: the largest .srt that reads correctly.
// Whatever is wrong with an archive stays wrong, so the error says not to try it again.
function unpack(zip, maxBytes) {
  let why = 'no subtitle in the archive';
  try {
    const srts = Z.entries(zip, maxBytes).filter((e) => /\.srt$/i.test(e.name) && e.size > 0).sort((a, b) => b.size - a.size);
    for (const entry of srts.slice(0, 5)) {
      try { return entry.read(); } catch (e) { why = e.message; }
    }
  } catch (e) { why = e.message; }
  throw Object.assign(new Error(why), { fatal: true });
}

// May this address be requested at all? Checked for every hop, with or without the key on it.
function allowed(url) {
  return enabled() && (url.startsWith(API + '?') || FILE.test(url.split('?')[0]));
}

module.exports = { enabled, isFile, hasLanguage, sign, signed, request, parseList, downloadUrl, unpack, allowed };
