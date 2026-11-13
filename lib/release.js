'use strict';
// Reads release names ("Movie.2010.1080p.BluRay.x264-GROUP") so subtitles can be matched to the
// video being played. Subtitles made for the same release share the same timing.

const NOISE = new Set(['1080p', '720p', '2160p', '480p', '4k', 'x264', 'x265', 'h264', 'h265', 'hevc', 'xvid', 'divx',
  'aac', 'ac3', 'dts', 'dd5', 'ddp5', 'atmos', '10bit', 'hdr', 'srt', 'mkv', 'mp4', 'avi', 'eng', 'the', 'and', 'internal',
  'proper', 'repack', 'extended', 'unrated', 'multi', 'subs', 'sub']);

// Words that follow a hyphen in ordinary names and are not release groups: WEB-DL, Blu-Ray, Spider-Man...
const NOT_GROUP = new Set(['dl', 'ray', 'rip', 'man', 'men', 'hd', 'uhd', 'cam', 'ts', 'tc', 'scr', 'web', 'tv',
  '264', '265', 'x264', 'x265', 'hevc', 'aac', 'ac3', 'dts', 'cd1', 'cd2', 'fi', 'in', 'on', 'of', 'up', 'x']);

const FILE_EXT = /\.(srt|sub|ass|ssa|vtt|txt|mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm)$/i;
const LANG_TAG = /[.\-_ ](ell|gre|eng|spa|fre|ger|ita|por|pob|el|gr|en|es|fr|de|it|pt|forced|sdh|hi)$/i;

// Drop the file extension and a trailing language tag: "…-FGT.ell.srt" -> "…-FGT".
function bare(name) {
  return String(name || '').trim().replace(FILE_EXT, '').replace(LANG_TAG, '');
}

// The technical part of a name is what follows the year or the resolution. Reading only that
// keeps a title word from being taken for a source ("Charlotte's Web", "Cam").
function tail(name) {
  const s = bare(name);
  const m = /(?:^|[^a-z0-9])((?:19|20)\d\d|\d{3,4}p)(?=[^a-z0-9]|$)/i.exec(s);
  return m ? s.slice(m.index + m[0].length) : s;
}

function source(name) {
  const s = ' ' + tail(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  if (/ (cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine|screener|scr|dvdscr) /.test(s)) return 'cam';
  if (/ (bluray|blu ray|bdrip|brrip|bd rip|br rip|remux|bdremux) /.test(s)) return 'bluray';
  if (/ (web dl|webdl|webrip|web rip|web|amzn|nf|dsnp|hmax|atvp|hulu) /.test(s)) return 'web';
  if (/ (hdtv|pdtv|dsr|tvrip) /.test(s)) return 'hdtv';
  if (/ (dvdrip|dvd rip|dvd|dvd5|dvd9) /.test(s)) return 'dvd';
  return '';
}

function group(name) {
  const s = bare(name);
  let m = /\[([A-Za-z0-9]{2,12})(?:\.[A-Za-z]{2,3})?\]\s*$/.exec(s); // "…-[YTS.MX]"
  if (m) return m[1].toLowerCase();
  m = /-([A-Za-z0-9]{2,15})$/.exec(s);
  if (!m) return '';
  const g = m[1].toLowerCase();
  // a real release name has a title, a year or resolution, and more before the group
  if (NOT_GROUP.has(g) || s.slice(0, m.index).split(/[.\s_]+/).filter(Boolean).length < 3) return '';
  return g;
}

function tokens(name) {
  return new Set(bare(name).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !NOISE.has(t) && !/^(19|20)\d\d$/.test(t)));
}

function info(...names) {
  const given = names.filter(Boolean);
  return {
    src: given.map(source).find(Boolean) || '',
    grp: given.map(group).find(Boolean) || '',
    tok: new Set(given.flatMap((n) => [...tokens(n)])),
  };
}

// How likely are two releases the same one? Higher is better; negative means "clearly different".
function match(a, b) {
  let s = 0;
  if (a.src && b.src) s += a.src === b.src ? 2 : -2;
  if (a.grp && b.grp && a.grp === b.grp) s += 3;
  let common = 0;
  for (const t of a.tok) if (b.tok.has(t)) common++;
  const union = a.tok.size + b.tok.size - common;
  return s + (union ? common / union : 0);
}

// With no file name to go on: releases people actually stream today beat cinema-camera copies.
const SRC_WEIGHT = { bluray: 1, web: 1, hdtv: 0.5, dvd: 0.5, '': 0, cam: -1 };

module.exports = { info, match, source, group, SRC_WEIGHT };
