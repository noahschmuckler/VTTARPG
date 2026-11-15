#!/usr/bin/env python3
"""Build the game's sprite assets from the downloaded public packs.

Usage:  python3 -I tools/build_assets.py <kenney Dungeon Pack dir> <flare sheets dir> <out dir>

Kenney "Isometric Miniature Dungeon" (CC0): floor tiles, walls, props, and the 8-direction hero.
Flare-format monster sheets from OpenGameArt (CC0 / CC-BY-SA 3.0, see CREDITS.md).

Everything is downscaled to the game's tile size (128 px wide diamond), trimmed, and written with a
manifest (assets/manifest.json) holding each image's anchor offset, so the renderer can place any
sprite by the centre of the tile's top face.
"""
import json, os, sys
from PIL import Image

KDIR, FDIR, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
SCALE = 0.5                      # Kenney tiles are 256 wide; the game uses 128
ANCHOR = (128, 428)              # centre of a Kenney floor tile's top face (a 256x128, 2:1 diamond) in its 256x512 canvas
os.makedirs(os.path.join(OUT, 'tiles'), exist_ok=True)
os.makedirs(os.path.join(OUT, 'units'), exist_ok=True)
manifest = {'tiles': {}, 'units': {}}

# ------------------------------------------------------------------ tiles and props
TILES = ['stone', 'stoneTile', 'stoneUneven', 'stoneMissingTiles', 'stoneInset', 'dirt', 'dirtTiles', 'planks',
         'planksBroken', 'planksHole', 'bridge', 'stoneColumn', 'stoneColumnWood', 'barrel', 'barrels', 'barrelsStacked',
         'woodenCrate', 'woodenCrates', 'woodenPile', 'chestClosed', 'chestOpen', 'tableRound', 'tableRoundChairs',
         'tableShortChairs', 'tableChairsBroken', 'stoneWall', 'stoneWallAged', 'stoneWallWindow', 'stoneWallWindowBars',
         'stoneWallColumn', 'stoneWallBroken', 'stoneWallHole', 'stoneWallGateClosed', 'stoneWallGateOpen',
         'stoneWallDoorClosed', 'stairsSpiral', 'woodenSupports', 'stoneWallCorner', 'stoneWallRound']
FLOORS = {'stone', 'stoneTile', 'stoneUneven', 'stoneMissingTiles', 'stoneInset', 'dirt', 'dirtTiles', 'planks', 'planksBroken', 'planksHole'}
def wanted(name):  # only the rotations the renderer draws: floors face N, bridges E, walls S/E, the stair S; props any way
    if name in FLOORS: return 'N'
    if name == 'bridge': return 'E'
    if name.startswith('stoneWall'): return 'SE'
    if name == 'stairsSpiral': return 'S'
    return 'NESW'
for name in TILES:
    for d in wanted(name):
        p = os.path.join(KDIR, 'Isometric', f'{name}_{d}.png')
        if not os.path.exists(p):
            continue
        im = Image.open(p).convert('RGBA')
        bb = im.getbbox()
        if not bb:
            continue
        im = im.crop(bb)
        w, h = round(im.width * SCALE), round(im.height * SCALE)
        im = im.resize((w, h), Image.LANCZOS)
        key = f'{name}_{d}'
        im.quantize(256, method=Image.FASTOCTREE).save(os.path.join(OUT, 'tiles', key + '.png'), optimize=True)
        manifest['tiles'][key] = [w, h, round((bb[0] - ANCHOR[0]) * SCALE, 1), round((bb[1] - ANCHOR[1]) * SCALE, 1)]

# ------------------------------------------------------------------ units
# Canonical directions (screen space, clockwise from screen-right): 0 E, 1 SE, 2 S, 3 SW, 4 W, 5 NW, 6 N, 7 NE.
# Each sheet stores `base`: the row holding canonical direction d is (base - d) mod 8 (checked by eye).
def pack(name, frames_by_dir, anims, fw, fh, anchor, base=4):
    """frames_by_dir[d] = list of RGBA frames (same size). Trims to the union bbox, writes one sheet:
    rows = directions, columns = frames. anchor = feet point in the untrimmed frame."""
    box = None
    for row in frames_by_dir:
        for f in row:
            b = f.getbbox()
            if b:
                box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
    n = len(frames_by_dir[0])
    cw, ch = box[2] - box[0], box[3] - box[1]
    sheet = Image.new('RGBA', (cw * n, ch * 8))
    for d, row in enumerate(frames_by_dir):
        for i, f in enumerate(row):
            sheet.alpha_composite(f.crop(box), (i * cw, d * ch))
    sheet.quantize(256, method=Image.FASTOCTREE).save(os.path.join(OUT, 'units', name + '.png'), optimize=True)
    manifest['units'][name] = {'fw': cw, 'fh': ch, 'ax': anchor[0] - box[0], 'ay': anchor[1] - box[1], 'anims': anims, 'base': base}

# The Kenney hero: Idle0, Run0-9, Pickup0-9 per direction (Kenney index: 0 NE, 1 E, 2 SE, 3 S, 4 SW, 5 W, 6 NW, 7 N).
rows = []
for d in range(8):
    k = (d + 1) % 8
    names = ['Idle0'] + [f'Run{i}' for i in range(10)] + [f'Pickup{i}' for i in range(10)]
    row = []
    for nm in names:
        im = Image.open(os.path.join(KDIR, 'Characters', 'Male', f'Male_{k}_{nm}.png')).convert('RGBA')
        row.append(im.resize((128, 256), Image.LANCZOS))
    rows.append(row)
pack('hero', rows, {'idle': [0, 1], 'run': [1, 10], 'act': [11, 10]}, 128, 256, (64, ANCHOR[1] * SCALE))

# Flare sheets: one row per direction (Flare row: 0 W, 1 NW, 2 N, 3 NE, 4 E, 5 SE, 6 S, 7 SW), frames left to right.
# spec: file, frame size, [(anim, first, count)], downscale, feet anchor within the frame (Flare: centre, ~3/4 down)
FLARE = {
    'orc':      ('orc_regular_0.png', 128, [('idle', 0, 4), ('run', 4, 8), ('attack', 12, 4), ('hit', 20, 1), ('die', 20, 4)], 1.0),
    'orcHeavy': ('orc_heavy_1.png', 128, [('idle', 0, 4), ('run', 4, 8), ('attack', 12, 4), ('hit', 20, 1), ('die', 20, 4)], 1.0),
    'orcElite': ('orc_elite_0.png', 128, [('idle', 0, 4), ('run', 4, 8), ('attack', 24, 4), ('hit', 20, 1), ('die', 20, 4)], 1.0),
    'archer':   ('orc_archer_0.png', 128, [('idle', 0, 4), ('run', 4, 8), ('attack', 28, 4), ('hit', 20, 1), ('die', 20, 4)], 1.0),
    'slime':    ('slime_0.png', 128, [('idle', 0, 4), ('run', 4, 8), ('attack', 16, 6), ('hit', 24, 2), ('die', 26, 8)], 1.0),
    'spider':   ('spider_0.png', 128, [('idle', 0, 4), ('run', 4, 8), ('attack', 12, 4), ('hit', 24, 1), ('die', 18, 6)], 1.0),
    'spiderGiant': ('spider_giant.png', 128, [('idle', 0, 4), ('run', 4, 8), ('attack', 12, 4), ('hit', 24, 1), ('die', 18, 6)], 1.0),
    'werebear': ('werebear_brown_armor.png', 128, [('idle', 0, 4), ('run', 4, 8), ('attack', 12, 4), ('hit', 20, 1), ('die', 20, 4)], 1.0),
    'demon':    ('demon_0.png', 256, [('idle', 0, 4), ('run', 4, 8), ('attack', 12, 8), ('hit', 28, 2), ('die', 32, 10)], 0.5),
}
for name, (fn, fs, anims, sc) in FLARE.items():
    src = Image.open(os.path.join(FDIR, fn))
    if src.mode != 'RGBA':
        src = src.convert('RGBA')
    rows, meta, col = [], {}, 0
    for d in range(8):
        fr = (d + 4) % 8
        row = []
        for _, first, count in anims:
            for i in range(first, first + count):
                f = src.crop((i * fs, fr * fs, (i + 1) * fs, (fr + 1) * fs))
                if sc != 1:
                    f = f.resize((round(fs * sc), round(fs * sc)), Image.LANCZOS)
                row.append(f)
        rows.append(row)
    for a, first, count in anims:
        meta[a] = [col, count]
        col += count
    s = round(fs * sc)
    # rows were checked against the front (facing the viewer) and back views of each sheet
    pack(name, rows, meta, s, s, (s / 2, s * 0.75), {'werebear': 6}.get(name, 4))

with open(os.path.join(OUT, 'manifest.json'), 'w') as fh:
    json.dump(manifest, fh, separators=(',', ':'))
print('tiles', len(manifest['tiles']), 'units', list(manifest['units']))
