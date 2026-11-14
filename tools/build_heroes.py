#!/usr/bin/env python3
"""Build one sprite sheet per calling from the Flare hero layers (CC-BY-SA 3.0, Clint Bellanger and Flare contributors).

Usage:  python3 -I tools/build_heroes.py <flare-game/mods/fantasycore> <assets dir>

Each Flare layer (body parts, armour pieces, weapons) is a packed atlas plus an animation file with one line per frame:
    frame=<index>,<direction>,<x>,<y>,<w>,<h>,<offset x>,<offset y>
We composite the layers for each calling in Flare's per-direction draw order (engine/hero_layers.txt), then pack the
frames in the same layout as the monster sheets (rows = directions, columns = frames) and add them to manifest.json.
"""
import json, os, re, sys
from PIL import Image

SRC, OUT = sys.argv[1], sys.argv[2]
ORDER = []  # per Flare direction index: list of layer types, first drawn first
for line in open(os.path.join(SRC, 'engine', 'hero_layers.txt')):
    if line.startswith('layer='):
        ORDER.append(line.strip().split('=', 1)[1].split(',')[1:])

# The look of each calling: (body folder, {layer type: art name})
LOOKS = {
    'ironclad': ('male', {'head': 'plate_helm', 'chest': 'plate_cuirass', 'hands': 'plate_gauntlets', 'legs': 'plate_greaves', 'feet': 'plate_boots', 'main': 'war_hammer', 'off': 'kite_shield'}),
    'runepriest': ('female', {'head': 'chain_coif', 'chest': 'chain_cuirass', 'hands': 'chain_gloves', 'legs': 'chain_greaves', 'feet': 'chain_boots', 'main': 'smith_hammer', 'off': 'iron_buckler'}),
    'ranger': ('female', {'head': 'leather_hood', 'chest': 'leather_chest', 'hands': 'leather_gloves', 'legs': 'leather_pants', 'feet': 'leather_boots', 'main': 'longbow'}),
    'arcanist': ('male', {'head': 'mage_hood', 'chest': 'mage_vest', 'hands': 'mage_sleeves', 'legs': 'mage_skirt', 'feet': 'mage_boots', 'main': 'greatstaff'}),
    'shadowblade': ('male', {'head': 'mage_hood_alt2', 'chest': 'leather_chest', 'hands': 'cloth_gloves', 'legs': 'leather_pants', 'feet': 'cloth_sandals', 'main': 'dagger'}),
}
ATTACK = {'ironclad': 'swing', 'runepriest': 'swing', 'ranger': 'shoot', 'arcanist': 'cast', 'shadowblade': 'swing'}
ANIMS = [('idle', 'stance'), ('run', 'run'), ('attack', None), ('hit', 'hit'), ('die', 'die')]
CW, CH, AX, AY = 200, 190, 100, 150  # compositing canvas and the feet point in it
SCALE = float(os.environ.get('HERO_SCALE', 0.75))
COLORS = int(os.environ.get('HERO_COLORS', 96))
#                         # stored at 3/4 size to keep the deploy small; the renderer draws them at 1/SCALE

def load_anim(body, name):
    path = os.path.join(SRC, 'animations', 'avatar', body, name + '.txt')
    img = Image.open(os.path.join(SRC, 'images', 'avatar', body, name + '.png')).convert('RGBA')
    # drop Flare's baked-in drop shadow (pure black at partial alpha): the game draws its own, and the speckle won't compress
    r, g, b, al = img.split()
    dark = Image.eval(Image.merge('RGB', (r, g, b)).convert('L'), lambda v: 255 if v < 14 else 0)
    faint = Image.eval(al, lambda v: 255 if v < 180 else 0)
    shadow = Image.composite(dark, Image.new('L', img.size, 0), faint)
    img.putalpha(Image.composite(Image.new('L', img.size, 0), al, shadow))
    anims, cur = {}, None
    for line in open(path):
        line = line.strip()
        m = re.match(r'\[(\w+)\]', line)
        if m: cur = anims.setdefault(m.group(1), {}); continue
        if line.startswith('frame=') and cur is not None:
            i, d, x, y, w, h, ox, oy = map(int, line[6:].split(','))
            cur[(i, d)] = (x, y, w, h, ox, oy)
    return img, anims

manifest = json.load(open(os.path.join(OUT, 'manifest.json')))
for cls, (body, look) in LOOKS.items():
    head_default = 'head_short' if body == 'male' else 'head_long'
    layers = {t: load_anim(body, n) for t, n in look.items()}
    for t, n in (('head', head_default), ('chest', 'default_chest'), ('hands', 'default_hands'), ('legs', 'default_legs'), ('feet', 'default_feet')):
        layers.setdefault(t, load_anim(body, n))
    seq = [(a, src or ATTACK[cls]) for a, src in ANIMS]
    total = {a: max(i for (i, _d) in layers['chest'][1][s]) + 1 for a, s in seq}
    PICK = {'idle': [0, 2], 'hit': [1], 'die': [0, 2, 4, 5]}  # fewer frames where it doesn't show, to keep the deploy small
    pick = {a: [i for i in PICK.get(a, range(total[a])) if i < total[a]] for a, _ in seq}
    counts = {a: len(pick[a]) for a, _ in seq}
    rows = []
    for r in range(8):             # sheet row r holds canonical direction (4 - r) mod 8 (manifest base 4), i.e. Flare direction -r
        fd = (-r) % 8
        row = []
        for a, s in seq:
            for i in pick[a]:
                canvas = Image.new('RGBA', (CW, CH))
                for t in ORDER[fd]:
                    if t not in layers: continue
                    img, anims = layers[t]
                    fr = anims.get(s, {}).get((i, fd))
                    if not fr: continue
                    x, y, w, h, ox, oy = fr
                    canvas.alpha_composite(img.crop((x, y, x + w, y + h)), (AX - ox, AY - oy))
                row.append(canvas)
        rows.append(row)
    box = None
    for row in rows:
        for f in row:
            b = f.getbbox()
            if b: box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
    n, fw, fh = len(rows[0]), box[2] - box[0], box[3] - box[1]
    sheet = Image.new('RGBA', (fw * n, fh * 8))
    for d, row in enumerate(rows):
        for i, f in enumerate(row):
            sheet.alpha_composite(f.crop(box), (i * fw, d * fh))
    name = 'hero_' + cls
    sheet = sheet.resize((round(sheet.width * SCALE), round(sheet.height * SCALE)), Image.LANCZOS)
    fw, fh = round(fw * SCALE), round(fh * SCALE)
    sheet.quantize(COLORS, method=Image.FASTOCTREE, dither=Image.Dither.NONE).save(os.path.join(OUT, 'units', name + '.png'), optimize=True)
    col, meta = 0, {}
    for a, _ in seq: meta[a] = [col, counts[a]]; col += counts[a]
    manifest['units'][name] = {'fw': fw, 'fh': fh, 'ax': round((AX - box[0]) * SCALE, 1), 'ay': round((AY - box[1]) * SCALE, 1), 'anims': meta, 'base': 4, 'scale': round(1 / SCALE, 3)}
    print(name, fw, fh, n, 'frames', os.path.getsize(os.path.join(OUT, 'units', name + '.png')) // 1024, 'KB')
json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), separators=(',', ':'))
