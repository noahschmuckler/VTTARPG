# Delvers' Descent: notes for Claude

- `src/ledger/` is a verbatim copy of `ttarpg/public/{engine,sets,adventure,merchant,art}.js`. Don't edit it here;
  change the rules in ttarpg and copy them over. Solo-only rules live in `src/game/rules.js` (`SOLO`, `SPECS`).
- Parties: `G.party` holds the heroes; `G.hero/pos/turn/strike/pit/hidden` are accessors onto the active one (`bindParty`,
  call it again after loading a save). Effects on another hero go through `withHero`. Hero fx ids are `h0`…`h3`.
- `src/game/rules.js` is pure: no DOM. Everything visible goes through `G.fx`; `src/main.js` plays it via `View.play`.
- When a mechanic changes, update the in-game help (`help()` in `src/main.js`) and the table in `README.md`.
- Sprites: rebuild with `python3 -I tools/build_assets.py <kenney pack dir> <flare sheets dir> assets`
  (downloads listed in CREDITS.md). Each unit sheet's `base` maps canonical directions to rows.
- Heroes: `python3 -I tools/build_heroes.py <flare-game>/mods/fantasycore assets` composites one sheet per calling
  (outfits in `LOOKS`). Sheets are stored at 3/4 size (`scale` in the manifest) to stay under the deploy limit.
- Checks: `npm test`, `npm run sim` for balance, and drive the UI with Playwright against `npm start` (port 8790).
- Deploy: `npm run deploy` (stages dist/ via tools/stage.js, then wrangler). Live: https://delvers-descent.noah-schmuckler.workers.dev
  Keep the bundle under 3 MB gzipped (free Workers limit).

## The playtest forum
Players post bugs, ideas, feedback and questions in-game (💬, menu, title screen, links like `/#thread-12`); everyone
can read every thread. Storage: one Durable Object with SQLite (`worker/forum.js`, `worker/main.js`); locally
`npm start` uses `data/forum.sqlite` (set `FORUM_ADMIN_KEY` to try developer replies).
- Read: `node tools/forum.js list [open|closed|all] [bug|idea|feedback|question]`, `node tools/forum.js show <id>`
  (includes the game context and a screenshot URL).
- Replying, status changes, pinning and deleting need the admin key. A session that has no `.forum-key` runs
  `node tools/forum.js key` first: it makes a fresh key, stores it as the Worker secret `ADMIN_KEY` via the Cloudflare
  API, and saves it to the git-ignored `.forum-key` (this invalidates any older key).
- Reply: `node tools/forum.js reply <id> "text" [--status planned|fixed|wontfix|answered]`. Replies show as the developer.
- Workflow: summarise new threads for the owner and wait for their go-ahead before implementing a suggestion or fix,
  or posting a reply that promises something. After a fix ships, reply on the thread and mark it fixed.
