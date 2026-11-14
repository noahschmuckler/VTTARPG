# Delvers' Descent

A solo, isometric (3/4 view), turn-based tactics ARPG built on the **Delvers' Ledger** rules from
[ttarpg](https://github.com/noahschmuckler/ttarpg). One hero, three acts, ten scenes, and the Eighth Gate at the bottom.

```bash
npm start      # http://localhost:8790  (any static server works; there is no build step)
npm test       # rules tests, including a bot that clears Act I with every calling
npm run sim    # balance sim: the bot plays the whole campaign with each calling
npm run deploy # Cloudflare Worker: https://delvers-descent.noah-schmuckler.workers.dev
```

Deploying: `tools/stage.js` copies the game into `dist/` and writes a small Worker that serves every file, bundled
into the script as binary modules (about 1.9 MB gzipped, under the free plan's 3 MB). Run `npx wrangler login` once.

## What carries over from the Ledger

The game imports the tabletop engine unchanged (`src/ledger/` is a copy of `ttarpg/public/{engine,sets,adventure,merchant,art}.js`):

| Ledger piece | In the video game |
|---|---|
| Five callings (`CLASSES`) | Ironclad, Runepriest, Ranger, Arcanist, Shadowblade: same health, armor, dice, damage, move, reach and powers. |
| Dice pool attacks | Roll d6s; every 4+ is a hit, 6s crit. Hits form a pool you spend one at a time by clicking foes in reach, choosing crit or plain hit (or Auto: crits to elites and bosses, hits to minions). |
| One move + one action | Walk (blue squares), then Attack, a Power or Sprint. Attack powers prime the attack; move-and-strike powers (Leaping Strike, Grapple Line, Shadowstep) move you, then you attack in the same action. Rolled hits keep until you end your turn. Once a scene is clear, turns stop and you walk freely. |
| Height, flanking, hiding | High ground and attacking from hiding add dice; foes get an extra die when you're surrounded or they stand above you. |
| Breaking away | Walking out of a foe's reach gives it a free blow; the path preview turns red. |
| Positional powers | Tapping a power or ware opens a panel describing it; nothing fires until you confirm. Gear lists every ability you have. Done for real on the grid: leap, grapple, blink, swap, push into walls (slammed, +1 hit) or chasms, pull, pin, gravity well, meteor, warding circle, vanish. |
| Gear, sets, synergies | `makeItem`, `derive`, `powersFor`: 6 four-piece sets whose powers unlock with one piece, 8 hidden synergies. |
| Foe abilities | Enrage, Stoneskin, Call the Horde, Summoner, Regenerate, Sweeping Blows, Energy Leech, Thick Hide, Slam (hurls you, maybe into a chasm), Death Throes. |
| Adventure planner | `planScene` sizes every scene (skirmish, swarm, elite pack, gauntlet, boss) against the hero as each act began, with waves of reinforcements. |
| The Rakshasa | Between acts: sell gear for Favour, buy boons and wares, play Three-Card Crown. |

Solo adaptations (all in `src/game/rules.js`, `SOLO` and `SPECS`): Rune of Recall swaps with a foe, ally-only effects
apply to the hero, minion counts are boosted for a grid, big foes hit a little softer, and you catch your breath
(35% health) after each scene.

## Controls

On a phone, tap once to select (path, free blows and foe details show) and tap again or press the button to confirm; pinch to zoom. With a mouse, click a blue square to move, a red-ringed foe to attack, a chest to open it, the glowing stair to descend.
Keys: `A` attack, `S` sprint, `1`–`9` powers, `E`/`Enter` end turn, `I` gear, `C` centre, arrows/drag to pan,
wheel to zoom, `Esc`/right-click to cancel. The run saves to the browser after every action.

## Layout

```
index.html, src/main.js     controller: input, HUD, screens, camp
src/game/rules.js           solo tactics rules (pure; pushes effects to G.fx)
src/game/grid.js            squares, paths, reach, line of sight, seeded RNG
src/game/mapgen.js          procedural dioramas: platforms, chasms, bridges, clutter, gates
src/game/content.js         the solo campaign and the foe roster
src/game/render.js          isometric canvas renderer and effects
src/game/assets.js          sprite loading, hero tints, the custom cliff texture
src/ledger/                 the Delvers' Ledger engine (copied verbatim)
assets/                     built sprites + manifest (see tools/build_assets.py)
tools/                      asset build, static server, bot and balance sim
```

## Art

Public assets where they exist, custom where they don't. See [CREDITS.md](CREDITS.md).
