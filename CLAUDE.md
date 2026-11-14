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
