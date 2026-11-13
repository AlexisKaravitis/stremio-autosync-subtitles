'use strict';
// Shows what the addon sees for one title: every subtitle it considered, how they group by
// timing, and how well each translation fits each group.
//   node scripts/diagnose.js movie tt10872600 [lang] [video file name]
const S = require('../lib/sync');
const R = require('../lib/release');

(async () => {
  const [type, id, lang = 'ell', filename = ''] = process.argv.slice(2);
  const extra = filename ? `/filename=${encodeURIComponent(filename)}` : '';
  const up = await (await fetch(`https://opensubtitles-v3.strem.io/subtitles/${type}/${encodeURIComponent(id)}${extra}.json`)).json();
  const video = filename ? R.info(filename) : null;
  const all = up.subtitles.map((s) => {
    const rel = R.info(s.movieReleaseName, s.subtitleFileName);
    const pre = (s.m === 'h' ? 100 : 0) + (video ? R.match(video, rel) : 0) + R.SRC_WEIGHT[rel.src] + (s.lang === 'eng' ? 0.5 : 0);
    return { ...s, rel, pre, name: (s.movieReleaseName || s.subtitleFileName || '').slice(0, 60) };
  }).filter((s) => !/\bcd\s?\d\b/i.test(s.subtitleFileName || '')).sort((a, b) => b.pre - a.pre);
  console.log(`${up.subtitles.length} subtitles, match types: ${[...new Set(up.subtitles.map((s) => s.m))]}`);
  const load = async (s) => { try { return { ...s, cues: S.parseSrt(S.decode(Buffer.from(await (await fetch(s.url)).arrayBuffer()))) }; } catch { return null; } };
  const targets = (await Promise.all(all.filter((s) => s.lang === lang).slice(0, 6).map(load))).filter(Boolean);
  const refs = (await Promise.all(all.filter((s) => s.lang !== lang).slice(0, 12).map(load))).filter(Boolean);
  const mins = (c) => (c.length ? (c[c.length - 1].end / 60000).toFixed(0) : 0);
  console.log('\nTranslations:');
  for (const t of targets) console.log(`  ${t.id} ${String(t.cues.length).padStart(5)} cues ${mins(t.cues)} min fps ${t.fpsMilli} [${t.rel.src || '?'}] ${t.name}`);
  console.log('\nReferences:');
  for (const r of refs) console.log(`  ${r.lang} ${String(r.cues.length).padStart(5)} cues ${mins(r.cues)} min fps ${r.fpsMilli} [${r.rel.src || '?'}] pre ${r.pre.toFixed(1)} ${r.name}`);
  const pool = [...refs, ...targets].filter((s) => s.cues.length >= 30);
  const tls = pool.map((p) => S.timeline(p.cues));
  const parent = pool.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) if (find(i) !== find(j) && S.sameTiming(tls[i], pool[j].cues)) parent[find(j)] = find(i);
  const groups = new Map();
  pool.forEach((p, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
  console.log('\nTiming groups:');
  for (const g of groups.values()) {
    g.sort((a, b) => b.pre - a.pre);
    console.log(`  ${g.length} member(s): ${g.map((m) => `${m.lang}[${m.rel.src || '?'}]`).join(' ')}  e.g. ${g[0].name}`);
    for (const t of targets) {
      const a = S.align(g[0].cues, t.cues);
      console.log(`      ${t.id}: fit ${a.before.toFixed(2)} -> ${a.after.toFixed(2)} x${a.ratio.toFixed(4)} shift ${(a.offset / 1000).toFixed(1)}s cuts ${a.splits}`);
    }
  }
})();
