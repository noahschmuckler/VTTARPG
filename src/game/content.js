// The solo campaign and the foe roster. Pure data.
// Foes are sized by the ledger's adventure planner (planScene): this file only says what they look like,
// how far they move, how far they reach, and what the scenes are.

// Sprite and movement for each foe name used in the adventure. reach 1 = adjacent; more = ranged with line of sight.
export const ROSTER = {
  'Orc Grunt': { sprite: 'orc', move: 5, reach: 1, scale: 0.95 },
  'Orc Archer': { sprite: 'archer', move: 4, reach: 6, scale: 0.95 },
  'Bog Slime': { sprite: 'slime', move: 3, reach: 1, scale: 0.6 },
  'Cave Spider': { sprite: 'spider', move: 6, reach: 1, scale: 0.85 },
  'Orc Brute': { sprite: 'orcHeavy', move: 4, reach: 1, scale: 1.25 },
  'Orc Warlord': { sprite: 'orcElite', move: 4, reach: 1, scale: 1.35 },
  'Broodmother': { sprite: 'spiderGiant', move: 5, reach: 1, scale: 1.45 },
  'Loup Garou': { sprite: 'werebear', move: 5, reach: 1, scale: 1.3 },
  'Gate Demon': { sprite: 'demon', move: 4, reach: 1, scale: 2.1, fly: true },
  'Imp': { sprite: 'demon', move: 6, reach: 1, scale: 0.95, fly: true },
};
export const rosterFor = name => ROSTER[name] || ROSTER['Orc Grunt'];

const F = (name, abilities = [], ability = '', extra = {}) => ({ name, abilities, ability, ...extra });

// Three acts in the planner's format (see ledger/adventure.js). `arena` steers the map generator.
export const SOLO_GATE = {
  name: 'The Eighth Gate: Solo Descent', difficulty: 'normal',
  acts: [
    { name: 'Act I · The Outer Ruins', scenes: [
      { name: 'The Gatehouse', template: 'skirmish', chests: 1, minions: ['Orc Grunt'], arena: 'ruins',
        intro: 'The road ends at a ruined gatehouse, its arch split by roots. Somewhere below the mountain, the Eighth Gate is opening, and every orc in the valley has come to loot what crawls out. They have found you first.',
        outro: 'The last grunt drops. Past the broken arch, a spiral stair winds down into the barracks.' },
      { name: 'The Barracks', template: 'gauntlet', chests: 1, minions: ['Orc Grunt', 'Orc Archer'], arena: 'hall',
        elites: [F('Orc Brute', ['regen', 'enrage'], 'Heals between rounds; enraged at half health')],
        intro: 'Bunks, barrels and the smell of old stew. The Brute who runs this place looks up from his meal, delighted to have company.' },
      { name: 'The Slime Pits', template: 'swarm', chests: 1, minions: ['Bog Slime'], arena: 'pits',
        intro: 'The floor gives way to sinkholes full of black water, and the water is moving. Mind the edges: what falls in has to climb out.' },
      { name: 'The Warlord', template: 'boss', chests: 1, minions: ['Orc Grunt', 'Orc Archer'], arena: 'arena',
        bosses: [F('Orc Warlord', ['horde', 'enrage', 'stoneskin'], 'Calls his horde at half health')],
        intro: 'A courtyard of flagstones and broken pillars. The Warlord stands on the far dais with his banner, and his drums start the moment he sees you.',
        outro: 'The Warlord falls and his drums fall silent. Under his throne, a cold draught rises from a crack in the floor: the way down. The Rakshasa is waiting by it, of course, sitting on a rug that was not there a moment ago.' },
    ] },
    { name: 'Act II · The Webbed Deep', scenes: [
      { name: 'Silk Tunnels', template: 'skirmish', chests: 1, minions: ['Cave Spider'], arena: 'pits',
        intro: 'The tunnels below are wrapped in silk. Every thread trembles as you pass.' },
      { name: 'The Den', template: 'elitepack', chests: 1, minions: ['Cave Spider'], arena: 'hall',
        elites: [F('Broodmother', ['summoner'], 'Two spiderlings hatch every round'), F('Loup Garou', ['enrage', 'thickhide'], 'Its hide turns crits')],
        intro: 'Egg sacs the size of barrels hang from the beams. Something larger than the spiders is eating something in the corner.' },
      { name: 'The Chasm Bridge', template: 'gauntlet', chests: 1, minions: ['Cave Spider', 'Orc Archer'], arena: 'chasm',
        elites: [F('Orc Brute', ['slam'], 'A landed blow hurls you 3 squares, perhaps into the chasm')],
        intro: 'A great crack splits the cavern. The orcs have bridged it with planks and set a Brute to guard it, the kind who likes to throw people.' },
      { name: 'The Old Wolf', template: 'boss', chests: 1, minions: ['Cave Spider'], arena: 'arena',
        bosses: [F('Loup Garou', ['regen', 'slam', 'enrage', 'throes'], 'Old, huge, and very angry')],
        intro: 'The den of the oldest Loup Garou. Bones everywhere. It rises, and keeps rising.',
        outro: 'The beast\'s death-howl shakes dust from the roof. In the quiet after, you hear it: a slow, enormous heartbeat, far below. The Gate.' },
    ] },
    { name: 'Act III · The Eighth Gate', scenes: [
      { name: 'The Burning Stair', template: 'swarm', chests: 1, minions: ['Imp', 'Bog Slime'], arena: 'pits',
        intro: 'Heat rolls up the stair. Imps tumble out of the cracks in the walls, giggling.' },
      { name: 'The Seals', template: 'elitepack', chests: 1, minions: ['Imp', 'Orc Grunt'], arena: 'hall',
        elites: [F('Orc Warlord', ['leech', 'stoneskin'], 'Holds the First Seal; drinks your energy'), F('Broodmother', ['sweep', 'summoner'], 'Holds the Second Seal')],
        intro: 'Two seals still hold the Gate shut, and two guardians have been bound to break them.' },
      { name: 'The Gatekeeper', template: 'boss', chests: 2, minions: ['Imp'], arena: 'chasm',
        bosses: [F('Gate Demon', ['sweep', 'enrage', 'horde', 'leech', 'throes'], 'The thing that waits behind the Eighth Gate')],
        intro: 'The Eighth Gate stands open over a bottomless chasm, and the Gatekeeper steps through it, wings spreading until they touch both walls.',
        outro: 'The Gatekeeper burns from the inside out, and the Eighth Gate grinds shut behind it with a sound like the mountain sighing. You have done it, alone. The Rakshasa is clapping slowly from somewhere you cannot see.' },
    ] },
  ],
};

export const HERO_COLOR = { ironclad: '#9fb6d6', runepriest: '#5fd3c4', ranger: '#8fd16a', arcanist: '#ff8a3d', shadowblade: '#b88cff' };
