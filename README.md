# Papieren

My X timeline had turned into a slot machine. Every scroll paid out a fresh outrage, a "like if you agree", a BREAKING siren from an account that breaks something every eleven minutes, and replies that read like they came off the same assembly line. The algorithm knows what makes people stop scrolling, and it is rarely the calm stuff.

Papieren is my attempt to turn the volume down. It is a small browser extension that hides posts on x.com by rules you choose: where an account is based, what a post looks like, and how an account behaves. Hidden posts fold into a one-line placeholder you can click open, so nothing is ever gone, just out of your face.

## A word before you install

I am not a developer. I am a sysadmin who spends more time in project and team management than in an editor, and Papieren was built with an AI coding assistant doing most of the typing while I did the deciding, the testing and the arguing. It has a lot of tests and I have been careful, but it is not the work of a seasoned extension developer, and the code will show it in places. Issues and suggestions are very welcome.

There are other extensions that filter X by country, by keyword or by behaviour, several of them older and more polished than this one, each with features this one lacks. They deserve a look. I made Papieren because I wanted to build my own and understand every piece of it, not because the others fall short.

## X's rules, and the two ways Papieren learns a country

X's Terms of Service, section 4, allow access only through X's "published interfaces" and forbid scraping. X's Automation rules say "scripting the X website ... may result in the permanent suspension of your account". Please read that twice, because it decides how you should use the country filter.

Papieren can learn where an account is based in two ways:

- **Passively, always on.** When you click an account's name and open its "About this account" panel, X itself fetches that information. Papieren reads the answer X already sent to your browser and remembers it. No extra request is made, so this stays within what you were doing anyway.
- **Actively, off by default.** With "Country lookups" switched on, Papieren asks X for the About information of accounts in your feed that it does not know yet, a few at a time, within a budget of lookups per 15 minutes that you set. This is scripting the X website. The switch asks you to accept that risk before it turns on, and I would only ever use it on a secondary account you can afford to lose.

Everything else Papieren does (hiding, Packs, behaviour detections) works on what X already sends to your browser and makes no requests of its own.

## What it does

### Country filter

Pick countries from the list and choose a mode: **block** hides posts from accounts based in them, **allow** hides everything else. Reposts are judged by both the reposter and the original author. Your own posts are never hidden. Known countries are cached locally for 30 days by default.

### Packs

A Pack is a set of weighted Tells (phrases, patterns, shapes of a post, facts about the account) and a Threshold. When the Tells a post meets add up to the Threshold, the post is hidden and its placeholder names the Pack. Four come built in, all off until you switch them on:

- **Engagement bait**: asks for likes, reposts, follows or replies instead of saying something
- **Ragebait**: picks a fight for reach, with provocations and us-against-them framing, and no side taken
- **AI-tone**: reads like unedited chatbot output
- **Aggregator**: news-relay posting, BREAKING and JUST IN, sirens included

Every Pack can be copied and edited in the popup's Pack editor, and you can write your own from `packs/example.json`, a worked example that uses every kind of Tell (on football transfer rumours, because nothing generates breathless certainty quite like a transfer window). `packs/pack.schema.json` documents the format. A Pack mode of **All_But** turns the logic around and hides everything except what your Packs match.

### Behaviour detections

Four optional detections hide posts by what an account does rather than what it says:

- **Copy-paste replies**: the same reply text from 3 or more accounts
- **Replies everywhere**: one account replying in 5 or more conversations within 24 hours
- **Recycled media**: the same image or video posted by 3 or more accounts, the earliest one left visible
- **Repeat offender**: an account caught 5 times by the others

Accounts you follow are never judged.

### Records

Papieren keeps a local history of what it hid and why, and per-rule statistics, so you can check it is not hiding things you would want to see. You choose how many days each kind of record is kept, and you can export them as JSON or CSV. Reply texts are stored as one-way fingerprints, never as text.

## Privacy

Everything stays in your browser: settings and the country cache in extension storage, records in the extension's own IndexedDB. Papieren sends nothing anywhere, has no analytics and no telemetry, and never changes the data X sends or the requests X's own app makes. The only network requests it can ever make are the country lookups, to x.com, and only if you switch them on.

## Install

Papieren is a Manifest V3 extension, developed and used in Brave, and it should work in any Chromium browser.

1. Download `papieren-<version>.zip` from the Releases page, or build it yourself with `npm run pack` (it lands in `dist/`).
2. Unzip it into a folder you will keep.
3. Open `brave://extensions` (or `chrome://extensions`), switch on **Developer mode**, click **Load unpacked** and choose the folder.

Firefox, Android included, is a possible future port, not a promise.

## Under the hood

- `src/content.js` reads the timeline answers X sends and the posts on screen, and decides what to hide.
- `src/lib/variants.js` holds the site adapters: one for each version of X's web app, so a change on X's side means changing one adapter.
- `src/lib/signals.js` is the Signal registry. The country filter and Packs are both Signals, and a new kind of rule is a new Signal.
- `src/background.js` is the service worker: the lookup budget, the database and the toolbar badge.

If you want to fork Papieren for another site or another kind of rule, the adapters and the Signal registry are the two seams built for it.

## Testing

```sh
npm test                          # unit tests, no dependencies
cd e2e && npm install && npm test # browser checks against a fake x.com
```

The browser checks run Chromium (`PAPIEREN_CHROMIUM` points at another binary) against `e2e/fakex.js`, a routed x.com that answers every request itself, so nothing reaches X. `TESTING.md` lists every check, manual and automated. Runs against the real x.com are described, with a template, in `e2e/LIVE.md`, under the same Terms of Service warning as above.

## Licence

GPL-3.0-only. See `LICENSE`.
