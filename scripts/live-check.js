'use strict';
// Runs the addon against real titles and reports what came back.
//   node scripts/live-check.js [lang]        e.g. node scripts/live-check.js ell
// It talks to the real OpenSubtitles addon, one title at a time, so please run it sparingly.
const A = require('../lib/addon');

const TITLES = [
  ['movie', 'tt0111161', 'The Shawshank Redemption'], ['movie', 'tt0068646', 'The Godfather'],
  ['movie', 'tt0468569', 'The Dark Knight'], ['movie', 'tt1375666', 'Inception'],
  ['movie', 'tt0133093', 'The Matrix'], ['movie', 'tt0109830', 'Forrest Gump'],
  ['movie', 'tt0816692', 'Interstellar'], ['movie', 'tt15398776', 'Oppenheimer'],
  ['movie', 'tt1517268', 'Barbie'], ['movie', 'tt6751668', 'Parasite'],
  ['movie', 'tt0245429', 'Spirited Away'], ['movie', 'tt7286456', 'Joker'],
  ['movie', 'tt4154796', 'Avengers: Endgame'], ['movie', 'tt0120737', 'LOTR: Fellowship'],
  ['movie', 'tt0167260', 'LOTR: Return of the King'], ['movie', 'tt0034583', 'Casablanca'],
  ['movie', 'tt0050083', '12 Angry Men'], ['movie', 'tt9362722', 'Across the Spider-Verse'],
  ['movie', 'tt15239678', 'Dune: Part Two'], ['movie', 'tt0110912', 'Pulp Fiction'],
  ['series', 'tt0903747:1:1', 'Breaking Bad S1E1'], ['series', 'tt0944947:1:1', 'Game of Thrones S1E1'],
  ['series', 'tt0108778:1:1', 'Friends S1E1'], ['series', 'tt0386676:2:1', 'The Office S2E1'],
  ['series', 'tt4574334:1:1', 'Stranger Things S1E1'], ['series', 'tt2861424:1:1', 'Rick and Morty S1E1'],
  ['series', 'tt0388629:1:1', 'One Piece E1'], ['series', 'tt2560140:1:1', 'Attack on Titan S1E1'],
  ['series', 'tt11280740:1:1', 'Severance S1E1'], ['series', 'tt7366338:1:1', 'Chernobyl E1'],
  ['movie', 'tt0000000', '(title that does not exist)'],
];

(async () => {
  const lang = process.argv[2] || 'ell';
  let withSubs = 0, failed = 0, slowest = 0;
  for (const [type, id, name] of TITLES) {
    const t0 = Date.now();
    let line;
    try {
      const r = await A.subtitles(lang, type, id, '', 'http://local');
      const fits = r.info.map((info) => `${info.before.toFixed(2)}>${info.after.toFixed(2)}${info.ratio !== 1 ? ' speed' : ''}${info.splits ? ' cuts' : ''}${info.filmSpeed ? ' film-speed' : ''}`);
      if (r.subtitles.length) withSubs++;
      line = r.subtitles.length ? `${r.subtitles.length} version(s)  fit ${fits.join(' | ')}` : `none (${r.note || 'nothing matched'})`;
    } catch (e) {
      failed++;
      line = `FAILED: ${e.message}`;
    }
    const ms = Date.now() - t0;
    slowest = Math.max(slowest, ms);
    console.log(`${name.padEnd(30)} ${String(ms).padStart(6)} ms  ${line}`);
  }
  console.log(`\n${withSubs}/${TITLES.length} titles got synced subtitles, ${failed} failed, slowest ${slowest} ms`);
})();
