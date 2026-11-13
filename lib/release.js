'use strict';
// Reads release names ("Movie.2010.1080p.BluRay.x264-GROUP") so subtitles can be matched to the
// video being played. Subtitles made for the same release share the same timing.

const NOISE = new Set(['1080p', '720p', '2160p', '480p', '4k', 'x264', 'x265', 'h264', 'h265', 'hevc', 'xvid', 'divx',
  'aac', 'ac3', 'dts', 'dd5', 'ddp5', 'atmos', '10bit', 'hdr', 'srt', 'mkv', 'mp4', 'avi', 'eng', 'the', 'and', 'internal',
  'proper', 'repack', 'extended', 'unrated', 'multi', 'subs', 'sub']);

function source(name) {
  const s = ' ' + String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  if (/ (cam|camrip|hdcam|ts|hdts|telesync|tc|telecine|screener|scr|dvdscr) /.test(s)) return 'cam';
  if (/ (bluray|blu ray|bdrip|brrip|bd rip|br rip|remux|uhd|bdremux) /.test(s)) return 'bluray';
  if (/ (web dl|webdl|webrip|web rip|web|amzn|nf|dsnp|hmax|atvp|hulu) /.test(s)) return 'web';
  if (/ (hdtv|pdtv|dsr|tvrip) /.test(s)) return 'hdtv';
  if (/ (dvdrip|dvd rip|dvd|dvd5|dvd9) /.test(s)) return 'dvd';
  return '';
}

function group(name) {
  const m = /-([A-Za-z0-9]{2,15})(?:\.[a-z0-9]{2,4})?\s*$/.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : '';
}

function tokens(name) {
  return new Set(String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !NOISE.has(t) && !/^(19|20)\d\d$/.test(t)));
}

function info(...names) {
  const name = names.filter(Boolean).join(' ');
  return { src: source(name), grp: names.map(group).find(Boolean) || '', tok: tokens(name) };
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

module.exports = { info, match, source, SRC_WEIGHT };
