'use strict';
// SubDL (subdl.com): an optional second source of subtitles. It often has files made for BluRay
// and web releases that the OpenSubtitles listing lacks. It needs a free API key, given to the
// addon as the SUBDL_API_KEY environment variable; without one this source is simply off.
//
// The key is a secret. SubDL puts it inside every download link it returns, so links are
// stripped down to their bare form here, and the key is added back only at the moment the
// server itself downloads a file. It must never reach a link that a viewer receives.

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

// The address to ask SubDL for a title's subtitles. `id` is "tt123" or "tt123:season:episode".
function listUrl(type, id, lang) {
  const [imdb, season, episode] = String(id).split(':');
  const langs = [...new Set([CODES[lang], 'EN'].filter(Boolean))].join(',');
  let url = `${API}?api_key=${encodeURIComponent(key())}&imdb_id=${encodeURIComponent(imdb)}&type=${type === 'series' ? 'tv' : 'movie'}&languages=${langs}&subs_per_page=30`;
  if (type === 'series' && season && episode) url += `&season_number=${+season || 0}&episode_number=${+episode || 0}`;
  return url;
}

// Turns SubDL's answer into the addon's own shape. Download links lose the key here.
function parseList(body) {
  let json;
  try { json = JSON.parse(body.toString()); } catch { return []; }
  const out = [];
  for (const s of Array.isArray(json && json.subtitles) ? json.subtitles : []) {
    if (!s || typeof s.url !== 'string' || s.full_season) continue; // season packs hold many episodes
    if (s.episode_from && s.episode_end && s.episode_from !== s.episode_end) continue;
    let bare;
    try { bare = new URL(s.url.split('?')[0], 'https://dl.subdl.com').href; } catch { continue; }
    const lang = BACK[String(s.language || '').toUpperCase()];
    if (!lang || !FILE.test(bare)) continue;
    out.push({
      id: 'subdl-' + bare.slice(bare.lastIndexOf('/') + 1, -4),
      url: bare,
      lang,
      fpsMilli: Math.round((+s.fps || +s.framerate || 0) * 1000),
      movieReleaseName: String(s.release_name || '').replace(/&amp;/g, '&'),
    });
  }
  return out;
}

// The address the server downloads a file from: the bare link plus the key.
const downloadUrl = (bare) => `${bare}?api_key=${encodeURIComponent(key())}`;

// Picks the subtitle out of a downloaded archive: the largest .srt in it.
function unpack(zip, maxBytes) {
  const srts = Z.entries(zip, maxBytes).filter((e) => /\.srt$/i.test(e.name)).sort((a, b) => b.size - a.size);
  if (!srts.length) throw new Error('no subtitle in the archive');
  return srts[0].read();
}

// May this address be requested at all? Checked for every hop, with or without the key on it.
function allowed(url) {
  return url.startsWith(API + '?') || FILE.test(url.split('?')[0]);
}

module.exports = { enabled, isFile, listUrl, parseList, downloadUrl, unpack, allowed };
