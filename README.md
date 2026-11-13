# AutoSync Subtitles for Stremio

A free Stremio addon that retimes subtitles to match the video you are playing, so they stop
running early, late, or drifting. It started as a fix for Greek subtitles and works for about
40 languages.

[![tests](https://github.com/AlexisKaravitis/stremio-autosync-subtitles/actions/workflows/test.yml/badge.svg)](https://github.com/AlexisKaravitis/stremio-autosync-subtitles/actions/workflows/test.yml)

There is no shared public copy of this addon. You host your own, for free, in about two
minutes, and it is yours: your own address, your own free allowance, shared with nobody unless
you give them the link.

## Set up your own copy

You need a free [Vercel](https://vercel.com) account. No coding is involved.

1. Press this button and sign in to Vercel:

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAlexisKaravitis%2Fstremio-autosync-subtitles&project-name=autosync-subtitles&repository-name=autosync-subtitles)

2. Press **Create**, then **Deploy**, and wait about a minute. Vercel asks to connect a GitHub
   account, because it keeps your copy of the code there.
3. Vercel shows your addon's address, something like `https://autosync-subtitles-abc.vercel.app`.
   Open it in a browser.
4. On that page, pick your subtitle language and press **Install in Stremio**. If the button
   does nothing, press **Copy addon link** and paste the link into the search box on Stremio's
   Addons screen.

The addon is saved to your Stremio account, so it appears on every device you are signed in to,
including TVs. To share it with friends, send them the address from step 3.

### What the free plan covers

Vercel's free plan is plenty for a household and friends. Working out a title for the first time
takes a few seconds of processing, and the free plan includes 4 hours of processing a month,
roughly a few thousand first-time lookups. Repeat lookups are served from cache and cost almost
nothing. If you ever pass a limit, the addon stops answering until the limit resets; the free
plan has no billing, and Stremio carries on with its other subtitles.

## What it fixes

- Subtitles that are early or late by the same amount all the way through.
- Subtitles that start fine and drift, because they were made for a different frame rate
  (23.976, 24 or 25 fps).
- Subtitles made for a different cut of the film, such as one with ad breaks removed.

## How it works

1. When you play something, Stremio asks the addon for subtitles for that title.
2. The addon asks Stremio's OpenSubtitles addon for the subtitles it has for that title, in
   every language.
3. It reads each subtitle's release name and compares it with the name of the video file, when
   Stremio provides one, to decide which subtitles are worth downloading: at most 20 (up to 6 in
   your language and 14 in others), six at a time.
4. It turns each subtitle into a timeline of "someone is speaking" and "silence". The words are
   ignored, which is why an English subtitle can be the reference for a Greek one.
5. Subtitles whose timelines agree to within 0.3 seconds were made for the same release of the
   film. The addon groups them and ranks the groups: a release matching your video file first,
   then releases people stream today (BluRay, web) ahead of old cinema-camera copies, then the
   largest group. A group is only believed if a subtitle in another language is in it.
6. For each of the top groups it produces one version in your language:
   - if a translation was already made for that release, it is used exactly as it is;
   - otherwise the best-fitting translation is retimed to the group. It tries the usual
     frame-rate corrections, finds the shift where the lines overlap the speech the most, and
     then checks whether the shift needs to change partway through (ad breaks, different cuts).
7. A version is offered only if at least 72% of it lines up with the other-language subtitle.
   Up to four are listed in the player's subtitle menu, most likely first.

If the first version is off, try the next one: the addon cannot see your video, only work out
which releases exist.

## Limits

- **It can only retime to a timing some subtitle already has.** If every subtitle that exists
  for a film, in every language, was made for a release nobody streams any more, there is
  nothing to sync to. The usual case is an older film whose subtitles were all made for a
  25 fps DVD while today's copies run at 24 fps: the subtitles start roughly right and drift
  to minutes late by the end.
- It can only retime subtitles that exist on OpenSubtitles for your language. In a check of 31
  well-known titles, 6 had no Greek subtitles there.
- Where a film has a cut in the middle, one or two lines right at the cut can stay mistimed.
- It depends on Stremio's OpenSubtitles addon. If that service changes or is unavailable, this
  addon returns nothing until it is back.
- The first time a title is opened it takes a few seconds (up to about 10 for a three-hour
  film). Results are cached after that: the player may reuse an answer for 2 hours.
- It reads SRT subtitles only.

## Privacy

The addon receives what Stremio sends to every subtitle addon: the title's IMDb ID and, when
available, the video's file name, size and fingerprint. It forwards those to Stremio's
OpenSubtitles addon to get the list of subtitles. It has no accounts, sets no cookies, keeps no
database, and writes no logs of its own. The hosting provider keeps standard short-lived request
logs, as any web host does.

It only ever requests anything from `opensubtitles-v3.strem.io` and `subs*.strem.io`. Redirects
are checked one hop at a time against that list, and a test enforces it.

## Run it on your own computer instead

It needs Node.js 20 or newer and has no dependencies.

```bash
node server.js
```

Then install `http://127.0.0.1:7711/manifest.json` in Stremio on the same computer. This only
works for Stremio on that computer: TVs and phones need the addon at a secure web address, which
is what the Vercel setup above gives you.

## Tests

```bash
npm test
```

The tests build synthetic films and break their subtitles in known ways. For a delay or a wrong
frame rate, every line must come back to within 0.3 seconds. For cuts in the middle, the typical
line must be within 0.15 seconds and at most two lines beside each cut may stay wrong. They also
run the whole addon against a fake OpenSubtitles: outages, corrupt data, oversized files,
redirects to other sites, awkward file names, forged addresses and tampered links. No real
subtitle files are stored in this repository.

To try it against real titles (this contacts the real service, so run it sparingly):

```bash
node scripts/live-check.js ell
```

## Layout

| File | What it is |
|---|---|
| `lib/sync.js` | Subtitle parsing and the timing engine |
| `lib/release.js` | Reading release names and matching them to the video file |
| `lib/addon.js` | The addon: choosing subtitles, grouping, the web routes |
| `lib/page.js` | The install page |
| `api/index.js`, `vercel.json` | Hosting on Vercel |
| `server.js` | Running on your own computer |
| `scripts/live-check.js` | Tries the addon on 31 real titles |
| `scripts/diagnose.js` | Shows what the addon sees for one title: files, timing groups, fits |

## Licence

MIT. Not affiliated with Stremio or OpenSubtitles. Subtitles belong to their authors; this addon
changes only their timing.
