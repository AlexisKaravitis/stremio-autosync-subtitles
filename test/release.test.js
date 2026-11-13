'use strict';
// Release names as they appear in the wild, and what must be read from them.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/release');

test('source is read from the technical part of the name, not the title or the file type', () => {
  const cases = {
    'Film.2010.1080p.BluRay.x264-SPARKS': 'bluray',
    'Film.2010.720p.Blu-Ray.x264': 'bluray',
    'Film.2021.1080p.WEB-DL.DDP5.1.H.264-GRP': 'web',
    'Film.2021.1080p.WEBRip.x264.AAC5.1-[YTS.MX]': 'web',
    'Film.2023.2160p.UHD.WEB-DL.x265': 'web',
    'Film.2023.2160p.UHD.BluRay.x265': 'bluray',
    'Film.2010.720p.HDTV.x264-BBB.ts': 'hdtv',      // .ts is a file type here, not "telesync"
    'Film.2010.TS.XviD-OLD': 'cam',
    'Film.2010.HDTC.x264': 'cam',
    'Film 2010 CAM XviD': 'cam',
    'Charlottes.Web.2006.DVDRip.XviD-GRP': 'dvd',   // "Web" is part of the title
    'The.Web.2019.HDTV.x264': 'hdtv',
    'Cam.2018.1080p.WEB.x264': 'web',               // so is "Cam"
    'Spider-Man': '',
  };
  for (const [name, want] of Object.entries(cases)) assert.strictEqual(R.source(name), want, name);
});

test('release group is not confused with hyphenated words', () => {
  const cases = {
    'Film.2010.1080p.BluRay.x264-SPARKS': 'sparks',
    'Film.2010.1080p.BluRay.x264-SPARKS.mkv': 'sparks',
    'Film.2021.1080p.WEB.H264-FGT.ell.srt': 'fgt',  // language tag before the extension
    'Film.2021.1080p.WEBRip.x264.AAC5.1-[YTS.MX]': 'yts',
    'Spider-Man.No.Way.Home.2021.1080p.WEB-DL.mkv': '',
    'Film.2010.720p.Blu-ray': '',
    'Spider-Man.srt': '',
    'X-Men': '',
  };
  for (const [name, want] of Object.entries(cases)) assert.strictEqual(R.group(name), want, name);
});

test('two different web releases do not score as the same release', () => {
  const video = R.info('Film.2019.1080p.WEB-DL.mkv');
  const sameSource = R.match(video, R.info('Other.Cut.2019.720p.WEB-DL'));
  const sameGroup = R.match(R.info('Film.2019.1080p.WEB-DL.x264-AAA.mkv'), R.info('Film.2019.1080p.WEB-DL.x264-AAA'));
  const otherSource = R.match(video, R.info('Film.2019.1080p.BluRay.x264-BBB'));
  assert.ok(sameSource < 3.1, `same source only: ${sameSource}`);
  assert.ok(sameGroup > sameSource + 2, `same group ${sameGroup} should beat same source ${sameSource}`);
  assert.ok(otherSource < 0, `different source: ${otherSource}`);
});
