'use strict';
// The small web page at the addon's address: pick a language, install, read what it does.

const REPO = require('./repo');

// A value written into the page's script. "<" is escaped so it can never close the script tag.
const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

module.exports = function page(langs, current, baseUrl) {
  const host = baseUrl.replace(/^https?:\/\//, '');
  const options = Object.entries(langs)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([code, name]) => `<option value="${code}"${code === current ? ' selected' : ''}>${name}</option>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AutoSync Subtitles for Stremio</title>
<meta name="description" content="A free, open-source Stremio addon that retimes subtitles to match your video.">
<link rel="icon" href="/logo.png">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; background: #12101f; color: #e9e7f5; }
  main { max-width: 640px; margin: 0 auto; padding: 48px 20px 64px; }
  img { width: 72px; height: 72px; }
  h1 { font-size: 30px; margin: 16px 0 4px; }
  h2 { font-size: 18px; margin: 36px 0 8px; }
  p, li { color: #c4c0dc; }
  .lead { font-size: 18px; color: #e9e7f5; }
  .card { background: #1c1930; border: 1px solid #322d52; border-radius: 12px; padding: 20px; margin-top: 24px; }
  label { display: block; font-size: 14px; margin-bottom: 6px; color: #c4c0dc; }
  select, input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #453e70; background: #12101f; color: inherit; font: inherit; }
  .row { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
  a.btn, button { flex: 1 1 180px; text-align: center; padding: 12px 16px; border-radius: 8px; border: 0; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
  a.btn { background: #7b5bf5; color: #fff; }
  button { background: #2b2647; color: #e9e7f5; }
  a { color: #a993ff; }
  small { color: #8f8aad; }
</style>
</head>
<body>
<main>
  <img src="/logo.png" alt="">
  <h1>AutoSync Subtitles</h1>
  <p class="lead">A Stremio addon that retimes subtitles to match your video, so they stop running early, late, or drifting.</p>

  <div class="card">
    <label for="lang">Subtitle language</label>
    <select id="lang">${options}</select>
    <div class="row">
      <a class="btn" id="install" href="#">Install in Stremio</a>
      <button id="copy" type="button">Copy addon link</button>
    </div>
    <p><small>If the button does nothing, copy the link and paste it into the search box on Stremio's Addons screen.</small></p>
    <input id="link" readonly aria-label="Addon link">
  </div>

  <h2>What it fixes</h2>
  <ul>
    <li>Subtitles that are early or late by the same amount all the way through.</li>
    <li>Subtitles that start fine and drift, because they were made for a different frame rate.</li>
    <li>Subtitles made for a different cut of the film, such as one with ad breaks removed.</li>
  </ul>

  <h2>How it works</h2>
  <ol>
    <li>When you play something, Stremio asks the addon for subtitles for that title.</li>
    <li>The addon looks up the subtitles OpenSubtitles has for it, in every language.</li>
    <li>It compares when people are speaking in each one. Subtitles that agree were made for the same release of the film.</li>
    <li>It retimes the best subtitle in your language to the releases most likely to match your video, and lists them in the player's subtitle menu.</li>
  </ol>
  <p>It can offer up to four versions. The first is the most likely match; if it is off, try the next.</p>

  <h2>What it sees</h2>
  <p>Only what Stremio sends to any subtitle addon: the title's ID and, when available, the video's file name, size and fingerprint. There are no accounts, no tracking and no stored history.</p>

  <h2>Limits</h2>
  <ul>
    <li>It can only retime subtitles that exist on OpenSubtitles for your language.</li>
    <li>The first time a title is opened it can take a few seconds; after that it is quick.</li>
  </ul>

  <p><small>Free and open source${REPO ? ` · <a href="${REPO}">source code and issue tracker</a>` : ''} · not affiliated with Stremio or OpenSubtitles.</small></p>
</main>
<script>
  var host = ${js(host)}, base = ${js(baseUrl)}, sel = document.getElementById('lang');
  function update() {
    var path = (sel.value === 'ell' ? '' : '/' + sel.value) + '/manifest.json';
    document.getElementById('install').href = 'stremio://' + host + path;
    document.getElementById('link').value = base + path;
  }
  sel.addEventListener('change', update);
  document.getElementById('copy').addEventListener('click', function () {
    var el = document.getElementById('link'), b = this;
    (navigator.clipboard ? navigator.clipboard.writeText(el.value) : Promise.reject()).catch(function () { el.select(); document.execCommand('copy'); });
    b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy addon link'; }, 1500);
  });
  update();
</script>
</body>
</html>`;
};
