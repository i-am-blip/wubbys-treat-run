#!/usr/bin/env python3
"""Build the game's art from assets/raw/ into public/assets/game/ (atlases + JSON),
with labeled preview contact sheets in assets/preview/.

    .venv/Scripts/python scripts/build_assets.py          # build everything
    .venv/Scripts/python scripts/build_assets.py --stats  # only print sheet analysis

Requires Pillow and numpy.

Pixel-art sheets: chroma-key #00FF00 (binary alpha, green fringe peeled), split into sprites
by connected components (assigned to row/col by centre; small parts merge into their cell),
reduced with NEAREST sampling to their pixel grid, and packed into uniform cells.
The raw sheets are not drawn to a common scale (the thief is as tall as Wubby there), so each
character sheet's sampling step is chosen to hit a target height relative to Wubby.
"""
import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'assets' / 'raw'
OUT = ROOT / 'public' / 'assets' / 'game'
PREVIEW = ROOT / 'assets' / 'preview'
TILE = 18  # CONFIG.tileSize in config.js
BG_STEP = 1.0       # backgrounds keep their generated resolution: 1 raw px = 1 game px, the same
                    # on-screen size as a tile pixel (never coarser than the playable layer)
HAZARD_WIDTH = 24   # hazards are sampled a bit wider than a tile so they read at a glance

GREEN = np.array([0, 255, 0])
KEY_TOL = 110       # colour distance to the key green that counts as background
FRINGE_TOL = 175    # wider tolerance for green-dominant pixels touching the background
FRINGE_EXCESS = 60  # how much g must exceed max(r, b) to count as fringe

# Target sizes in game pixels (1 game pixel = 1 logical pixel = CONFIG.scale device pixels)
WUBBY_HEIGHT = 31        # idle height; matches the sheet's own pixel grid (~4.1 raw px)
THIEF_RATIO = 0.75       # thief height relative to Wubby
GANG_RATIO = 0.70        # gang squirrels relative to Wubby
BONE_WIDTH = 15          # items sheet is scaled so a bone is this wide
SPIKE_WIDTH = TILE       # hazards fill one tile


# ================================================================= basics

def load(name):
    return np.asarray(Image.open(RAW / name).convert('RGB')).astype(np.int16)


def green_dist(rgb):
    return np.sqrt(((rgb - GREEN) ** 2).sum(axis=-1))


def dilate(mask, r=1):
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx or dy:
                out |= np.roll(np.roll(mask, dy, 0), dx, 1)
    return out


def key_mask(rgb, fringe=True, strong=False):
    """True where the pixel is art (binary alpha).
    strong: for art with no green of its own (characters) - any green-dominant edge pixel is fringe,
    including dark outline pixels blended with the key green."""
    dist = green_dist(rgb)
    bg = dist < KEY_TOL
    if fringe:
        g, rb = rgb[..., 1], np.maximum(rgb[..., 0], rgb[..., 2])
        if strong:
            greenish = (g - rb > 12) & (g > rb * 1.15)
        else:
            greenish = (g - rb > FRINGE_EXCESS) & (dist < FRINGE_TOL)
        for _ in range(4 if strong else 2):  # peel halos, only where they touch the background
            bg |= dilate(bg, 1) & greenish
    return ~bg


def peel_small(img):
    """After sampling: drop green-dominant pixels on the sprite's outer edge (strong keying only)."""
    a = np.asarray(img).astype(np.int16)
    alpha = a[..., 3] > 0
    g, rb = a[..., 1], np.maximum(a[..., 0], a[..., 2])
    edge = alpha & dilate(~alpha, 1)
    bad = edge & (g - rb > 12) & (g > rb * 1.15)
    a[bad, 3] = 0
    return Image.fromarray(a.astype(np.uint8), 'RGBA')


# ================================================================= pixel grid

def edge_positions(rgb, fg, axis):
    a = rgb if axis == 1 else rgb.transpose(1, 0, 2)
    m = fg if axis == 1 else fg.T
    d = np.abs(np.diff(a, axis=1)).sum(axis=-1)
    _, xs = np.nonzero((d > 60) & m[:, 1:] & m[:, :-1])
    return xs.astype(np.float64) + 1.0


def detect_scale(rgb, fg, lo=2.0, hi=12.0):
    """Upscale factor: the largest period that colour edges consistently land on."""
    xs = np.concatenate([edge_positions(rgb, fg, 1), edge_positions(rgb, fg, 0)])
    if len(xs) > 40000:
        xs = np.random.default_rng(0).choice(xs, 40000, replace=False)
    if len(xs) == 0:
        return 4.0, 0.0
    periods = np.arange(lo, hi, 0.02)
    scores = np.abs(np.exp(2j * np.pi * xs[None, :] / periods[:, None]).mean(axis=1))
    best = scores.max()
    s = float(periods[scores >= best * 0.8].max())
    fine = np.arange(s - 0.03, s + 0.03, 0.002)
    fs = np.abs(np.exp(2j * np.pi * xs[None, :] / fine[:, None]).mean(axis=1))
    return float(fine[fs.argmax()]), float(best)


def grid_phase(rgb, fg, s, axis):
    xs = edge_positions(rgb, fg, axis)
    if len(xs) == 0:
        return s / 2
    return (np.angle(np.exp(2j * np.pi * xs / s).mean()) / (2 * np.pi) * s) % s


def sample(rgb, fg, s, ox, oy):
    """NEAREST: the centre pixel of each s-sized cell -> (rgb, alpha)."""
    h, w = fg.shape
    nx, ny = max(1, int((w - ox) // s)), max(1, int((h - oy) // s))
    xs = np.clip((ox + (np.arange(nx) + 0.5) * s).astype(int), 0, w - 1)
    ys = np.clip((oy + (np.arange(ny) + 0.5) * s).astype(int), 0, h - 1)
    return rgb[np.ix_(ys, xs)], fg[np.ix_(ys, xs)]


def to_rgba(rgb, alpha):
    a = np.where(alpha, 255, 0).astype(np.uint8)
    return Image.fromarray(np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), a]), 'RGBA')


def trim(img):
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


# ================================================================= components

def components(mask, min_area=1):
    """8-connected components -> (list of dicts, label map)."""
    h, w = mask.shape
    label = np.full((h, w), -1, np.int32)
    comps = []
    for y0 in range(h):
        for x0 in np.nonzero(mask[y0] & (label[y0] < 0))[0]:
            if label[y0, x0] >= 0:
                continue
            idx = len(comps)
            q = deque([(y0, x0)])
            label[y0, x0] = idx
            ys, xs = [], []
            while q:
                y, x = q.popleft()
                ys.append(y); xs.append(x)
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        yy, xx = y + dy, x + dx
                        if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and label[yy, xx] < 0:
                            label[yy, xx] = idx
                            q.append((yy, xx))
            ys, xs = np.array(ys), np.array(xs)
            comps.append({'id': idx, 'area': len(ys), 'x0': int(xs.min()), 'x1': int(xs.max()) + 1,
                          'y0': int(ys.min()), 'y1': int(ys.max()) + 1, 'cx': float(xs.mean()), 'cy': float(ys.mean())})
    keep = [c for c in comps if c['area'] >= min_area]
    return keep, label


def raw_components(fg, min_area=20):
    """Components found on a 2x subsample (fast), reported in raw pixels."""
    sub = fg[::2, ::2]
    comps, label = components(sub, min_area)
    for c in comps:
        for k in ('x0', 'x1', 'y0', 'y1'):
            c[k] *= 2
        c['cx'] *= 2; c['cy'] *= 2
    big = np.repeat(np.repeat(label, 2, 0), 2, 1)[:fg.shape[0], :fg.shape[1]]
    return comps, big


def kmeans_1d(values, k, iters=60):
    v = np.asarray(values, float)
    centers = np.linspace(v.min(), v.max(), k) if k > 1 else np.array([v.mean()])
    for _ in range(iters):
        assign = np.abs(v[:, None] - centers[None, :]).argmin(axis=1)
        new = np.array([v[assign == i].mean() if np.any(assign == i) else centers[i] for i in range(k)])
        if np.allclose(new, centers):
            break
        centers = new
    return np.sort(centers)


def grid_cells(comps, rows, cols, main_frac=0.15):
    """Assign components to (row, col) cells by centre position; small parts join their cell."""
    top = max(c['area'] for c in comps)
    big = [c for c in comps if c['area'] >= main_frac * top]
    rc = kmeans_1d([c['cy'] for c in big], rows)
    cc = kmeans_1d([c['cx'] for c in big], cols)
    cells = {}
    for c in comps:
        key = (int(np.abs(rc - c['cy']).argmin()), int(np.abs(cc - c['cx']).argmin()))
        cells.setdefault(key, []).append(c)
    return cells


def group_free(comps, gap=14):
    """Merge components whose boxes are within `gap` raw px (for loose sheets like tiles/props)."""
    groups = [dict(c, members=[c['id']]) for c in comps]
    merged = True
    while merged:
        merged = False
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                a, b = groups[i], groups[j]
                if a['x0'] - gap < b['x1'] and b['x0'] - gap < a['x1'] and a['y0'] - gap < b['y1'] and b['y0'] - gap < a['y1']:
                    small = min(a['area'], b['area']) < 0.08 * max(a['area'], b['area'])
                    if not small:
                        continue
                    a.update(x0=min(a['x0'], b['x0']), x1=max(a['x1'], b['x1']), y0=min(a['y0'], b['y0']), y1=max(a['y1'], b['y1']),
                             area=a['area'] + b['area'], members=a['members'] + b['members'])
                    groups.pop(j)
                    merged = True
                    break
            if merged:
                break
    for g in groups:
        g['cx'] = (g['x0'] + g['x1']) / 2
        g['cy'] = (g['y0'] + g['y1']) / 2
    return groups


def extract(rgb, fg, label, members, s, phase=None, pad=4):
    """Crop the pixels of the given component ids and sample them at step s -> trimmed RGBA."""
    xs = [m['x0'] for m in members] + [m['x1'] for m in members]
    ys = [m['y0'] for m in members] + [m['y1'] for m in members]
    h, w = fg.shape
    x0, x1 = max(0, min(xs) - pad), min(w, max(xs) + pad)
    y0, y1 = max(0, min(ys) - pad), min(h, max(ys) + pad)
    ids = np.array([m['id'] for m in members])
    lab = label[y0:y1, x0:x1]
    own = np.isin(lab, ids)
    mask = fg[y0:y1, x0:x1] & (own | ((lab < 0) & dilate(own, 2)))
    if phase is None:
        ox = oy = (s / 2) % s
    else:
        ox, oy = (phase[0] - x0) % s, (phase[1] - y0) % s
    small, alpha = sample(rgb[y0:y1, x0:x1], mask, s, ox, oy)
    return trim(to_rgba(small, alpha))


# ================================================================= packing + previews

def pack_uniform(frames, rows, cols, anchors):
    """frames: {(r, c): Image}. Uniform cells; bottom-centre or centre alignment per frame."""
    cw = max(im.width for im in frames.values()) + 2
    ch = max(im.height for im in frames.values()) + 2
    atlas = Image.new('RGBA', (cw * cols, ch * rows), (0, 0, 0, 0))
    rects = {}
    for (r, c), im in frames.items():
        anchor = anchors(r, c)
        x = c * cw + (cw - im.width) // 2
        y = r * ch + (ch - 1 - im.height if anchor == 'bottom' else (ch - im.height) // 2)
        atlas.paste(im, (x, y))
        rects[f'R{r + 1}C{c + 1}'] = {'x': c * cw, 'y': r * ch, 'w': cw, 'h': ch, 'anchor': anchor,
                                      'trim': {'x': x, 'y': y, 'w': im.width, 'h': im.height}}
    return atlas, rects, (cw, ch)


def font(size):
    return ImageFont.load_default(size=size)


def checker(w, h, a=(58, 62, 80), b=(48, 52, 68), step=6):
    img = Image.new('RGB', (w, h), a)
    d = ImageDraw.Draw(img)
    for y in range(0, h, step):
        for x in range((y // step % 2) * step, w, step * 2):
            d.rectangle([x, y, x + step - 1, y + step - 1], fill=b)
    return img


def preview_frames(title, items, zoom=3, cols=8):
    """items: list of (label, Image). Labeled contact sheet."""
    cw = max(im.width for _, im in items) * zoom + 12
    ch = max(im.height for _, im in items) * zoom + 30
    rows = (len(items) + cols - 1) // cols
    sheet = Image.new('RGB', (cw * cols, ch * rows + 34), (30, 32, 44))
    d = ImageDraw.Draw(sheet)
    d.text((8, 6), title, fill=(255, 220, 90), font=font(18))
    for i, (lab, im) in enumerate(items):
        x, y = (i % cols) * cw, (i // cols) * ch + 34
        bg = checker(cw - 6, ch - 24)
        big = im.resize((im.width * zoom, im.height * zoom), Image.NEAREST)
        bg.paste(big, ((bg.width - big.width) // 2, bg.height - big.height - 2), big)
        sheet.paste(bg, (x + 3, y))
        d.text((x + 5, y + ch - 22), lab, fill=(230, 230, 240), font=font(12))
    return sheet


# ================================================================= sheet configs

def wubby_anims():
    r = lambda row, cols: [f'R{row}C{c}' for c in cols]
    return {
        'idle': {'frames': r(1, range(1, 9)), 'fps': 8, 'loop': True},
        'run': {'frames': r(2, range(1, 9)), 'fps': 14, 'loop': True},
        'jumpAnticipation': {'frames': r(3, [1]), 'fps': 12, 'loop': False},
        'jumpTakeoff': {'frames': r(3, [2]), 'fps': 12, 'loop': False},
        'jumpRise': {'frames': r(3, [3, 4]), 'fps': 10, 'loop': True},
        'jumpApex': {'frames': r(3, [5]), 'fps': 10, 'loop': False},
        'jumpFall': {'frames': r(3, [6]), 'fps': 10, 'loop': False},  # C7 faces the camera; C6 reads better in motion
        'land': {'frames': r(3, [8]), 'fps': 12, 'loop': False},
        'skid': {'frames': r(4, [1, 2]), 'fps': 12, 'loop': True},
        'hurt': {'frames': r(4, [3]), 'fps': 10, 'loop': False},
        'knockback': {'frames': r(4, [4]), 'fps': 10, 'loop': False},
        'defeat': {'frames': r(4, [5, 6, 7]), 'fps': 8, 'loop': False},
        'surprised': {'frames': r(4, [8]), 'fps': 8, 'loop': False},
        'munch': {'frames': r(5, [1, 2, 3, 4]), 'fps': 8, 'loop': True},
        'celebrate': {'frames': r(5, [5, 6, 7, 8]), 'fps': 8, 'loop': True},
    }


def thief_anims():
    r = lambda row, cols: [f'R{row}C{c}' for c in cols]
    return {
        'runTreat': {'frames': r(1, range(1, 9)), 'fps': 14, 'loop': True},
        'steal': {'frames': r(2, range(1, 9)), 'fps': 12, 'loop': False},
        'sneak': {'frames': r(2, [1, 2, 3, 4]), 'fps': 12, 'loop': True},   # steal, part 1: approach
        'grab': {'frames': r(2, [5, 6, 7, 8]), 'fps': 8, 'loop': False},    # steal, part 2: snatch the treat
        'taunt': {'frames': r(3, [1, 2, 3, 4]), 'fps': 8, 'loop': True},
        'jump': {'frames': r(3, [5, 6, 7, 8]), 'fps': 10, 'loop': False},
        'caught': {'frames': r(4, [1, 2, 3]), 'fps': 10, 'loop': False},
        'dizzy': {'frames': r(4, [4, 5]), 'fps': 6, 'loop': True},
        'shrug': {'frames': r(4, [6]), 'fps': 6, 'loop': False},
        'flee': {'frames': r(4, [7, 8]), 'fps': 12, 'loop': True, 'facesLeft': True},
    }


def gang_anims():
    r = lambda row, cols: [f'R{row}C{c}' for c in cols]
    return {
        'walk': {'frames': r(1, range(1, 7)), 'fps': 10, 'loop': True},
        'turn': {'frames': r(1, [7, 8]), 'fps': 10, 'loop': False},
        'idle': {'frames': r(2, [1, 2, 3, 4]), 'fps': 6, 'loop': True},
        'alert': {'frames': r(2, [5]), 'fps': 6, 'loop': False},
        'squished': {'frames': r(2, [6, 7]), 'fps': 10, 'loop': False},
        'poof': {'frames': r(2, [8]), 'fps': 10, 'loop': False},
        'runDust': {'frames': r(3, [1, 2, 3]), 'fps': 14, 'loop': False},
        'landDust': {'frames': r(3, [4, 5, 6]), 'fps': 14, 'loop': False},
        'hitStars': {'frames': r(3, [7, 8]), 'fps': 10, 'loop': True},
        'heartLost': {'frames': r(4, [1, 2]), 'fps': 8, 'loop': False},
        'checkpointBurst': {'frames': r(4, [3, 4]), 'fps': 10, 'loop': False},
        'streakSparkle': {'frames': r(4, [5, 6]), 'fps': 12, 'loop': False},
        'stompRing': {'frames': r(4, [7, 8]), 'fps': 12, 'loop': False},
    }


def item_anims():
    r = lambda row, cols: [f'R{row}C{c}' for c in cols]
    return {
        'bone': {'frames': r(1, range(1, 7)), 'fps': 8, 'loop': True},
        'boneCollect': {'frames': r(1, [7, 8]), 'fps': 14, 'loop': False},
        'golden': {'frames': r(2, range(1, 7)), 'fps': 8, 'loop': True},
        'goldenCollect': {'frames': r(2, [7, 8]), 'fps': 12, 'loop': False},
        'heart': {'frames': r(3, [1, 2]), 'fps': 4, 'loop': True},
        'heartCollect': {'frames': r(3, [3, 4]), 'fps': 10, 'loop': False},
        'treat': {'frames': r(3, [5, 6]), 'fps': 4, 'loop': True},
        'jarClosed': {'frames': r(3, [7]), 'fps': 1, 'loop': False},
        'jarOpen': {'frames': r(3, [8]), 'fps': 1, 'loop': False},
        'pedestalFull': {'frames': r(4, [1]), 'fps': 1, 'loop': False},
        'pedestalEmpty': {'frames': r(4, [2]), 'fps': 1, 'loop': False},
        'flagDown': {'frames': r(4, [3]), 'fps': 1, 'loop': False},
        'flagWave': {'frames': r(4, [4, 5]), 'fps': 4, 'loop': True},
        'spikes': {'frames': r(4, [6]), 'fps': 1, 'loop': False},
        'bramble': {'frames': r(4, [7]), 'fps': 1, 'loop': False},
        'droppedBone': {'frames': r(4, [8]), 'fps': 1, 'loop': False},
    }


UI_NAMES = {
    (0, 0): 'panelS_left', (0, 1): 'panelS_mid', (0, 2): 'panelS_right',
    (0, 3): 'panelL_left', (0, 4): 'panelL_mid', (0, 5): 'panelL_right', (0, 6): 'banner', (0, 7): 'badge',
    (1, 0): 'icon_heart', (1, 1): 'icon_heart_empty', (1, 2): 'icon_bone', (1, 3): 'icon_golden',
    (1, 4): 'icon_golden_empty', (1, 5): 'icon_full_belly', (1, 6): 'icon_clock', (1, 7): 'icon_paw',
    (2, 1): 'bar_track', (2, 3): 'bar_fill', (2, 4): 'bar_divider', (2, 5): 'bar_wubby', (2, 6): 'bar_thief', (2, 7): 'bar_thief_pulse',
    (3, 0): 'btn_play', (3, 1): 'btn_pause', (3, 2): 'btn_sound_on', (3, 3): 'btn_sound_off',
    (3, 4): 'btn_restart', (3, 5): 'btn_share', (3, 6): 'btn_download', (3, 7): 'btn_home',
    (4, 0): 'btn_wide', (4, 1): 'btn_wide_pressed', (4, 2): 'btn_primary', (4, 3): 'btn_primary_pressed',
    (4, 4): 'input', (4, 5): 'key', (4, 6): 'key_space', (4, 7): 'cursor',
}

# Tile sheets: role -> component index in the preview (filled in after viewing the previews)
def character_sheet(name, rows, cols, *, height_target=None, anchors=lambda r, c: 'bottom', ref_cells=None):
    rgb = load(name)
    fg = key_mask(rgb, strong=True)
    comps, label = raw_components(fg)
    cells = grid_cells(comps, rows, cols)
    grid, _ = detect_scale(rgb, fg)
    if height_target:
        ref = [cells[k] for k in ref_cells]
        h = np.median([max(m['y1'] for m in v) - min(m['y0'] for m in v) for v in ref])
        s = float(h / height_target)
        phase = None
    else:
        s = grid
        phase = (grid_phase(rgb, fg, s, 1), grid_phase(rgb, fg, s, 0))
    frames = {k: trim(peel_small(extract(rgb, fg, label, v, s, phase))) for k, v in cells.items()}
    return frames, s, grid


def write_atlas(key, frames, rows, cols, anchors, anims, extra=None):
    atlas, rects, cell = pack_uniform(frames, rows, cols, anchors)
    atlas.save(OUT / f'{key}.png')
    meta = {'image': f'{key}.png', 'cell': cell, 'frames': rects, 'animations': anims}
    if extra:
        meta.update(extra)
    (OUT / f'{key}.json').write_text(json.dumps(meta, indent=1))
    return atlas, rects


def anim_preview(key, frames, anims, zoom=3):
    items = []
    for name, a in anims.items():
        for i, f in enumerate(a['frames']):
            r, c = int(f[1:f.index('C')]) - 1, int(f[f.index('C') + 1:]) - 1
            if (r, c) in frames:
                items.append((f'{f} {name}' + (f' {i + 1}' if len(a['frames']) > 1 else ''), frames[(r, c)]))
    preview_frames(f'{key}: {len(frames)} frames', items, zoom).save(PREVIEW / f'{key}.png')


def build_characters():
    report = {}
    wub, s_w, g_w = character_sheet('wubby.png', 5, 8, height_target=WUBBY_HEIGHT, ref_cells=[(0, c) for c in range(8)])
    wub_h = np.median([wub[(0, c)].height for c in range(8)])
    thief, s_t, g_t = character_sheet('thief.png', 4, 8, height_target=wub_h * THIEF_RATIO, ref_cells=[(0, c) for c in range(8)])
    gang, s_g, g_g = character_sheet('gang_effects.png', 4, 8, height_target=wub_h * GANG_RATIO, ref_cells=[(0, c) for c in range(6)])
    gang_anchor = lambda r, c: 'bottom' if r < 2 else 'center'

    write_atlas('wubby', wub, 5, 8, lambda r, c: 'bottom', wubby_anims(), {'facing': 'right'})
    write_atlas('thief', thief, 4, 8, lambda r, c: 'bottom', thief_anims(), {'facing': 'right'})
    write_atlas('gang_effects', gang, 4, 8, gang_anchor, gang_anims(), {'facing': 'left'})
    anim_preview('wubby', wub, wubby_anims())
    anim_preview('thief', thief, thief_anims())
    anim_preview('gang_effects', gang, gang_anims())
    th_h = np.median([thief[(0, c)].height for c in range(8)])
    gg_h = np.median([gang[(0, c)].height for c in range(6)])
    report['characters'] = (f'wubby {wub_h:.0f}px (step {s_w:.2f}, grid {g_w:.2f}), thief {th_h:.0f}px = {th_h / wub_h:.0%} (step {s_t:.2f}), '
                            f'gang {gg_h:.0f}px = {gg_h / wub_h:.0%} (step {s_g:.2f})')
    return wub, thief, gang, report


def build_items():
    rgb = load('items.png')
    fg = key_mask(rgb)
    comps, label = raw_components(fg)
    cells = grid_cells(comps, 4, 8)
    width = lambda k: max(m['x1'] for m in cells[k]) - min(m['x0'] for m in cells[k])
    s = float(np.median([width((0, c)) for c in range(6)]) / BONE_WIDTH)
    s_haz = float(width((3, 5)) / SPIKE_WIDTH)  # spikes / bramble fill a tile
    frames = {}
    for k, v in cells.items():
        frames[k] = extract(rgb, fg, label, v, s_haz if k in ((3, 5), (3, 6)) else s)
    anchors = lambda r, c: 'bottom' if r == 3 and c < 7 else ('bottom' if (r, c) in ((2, 6), (2, 7)) else 'center')
    write_atlas('items', frames, 4, 8, anchors, item_anims())
    anim_preview('items', frames, item_anims(), zoom=4)
    return frames, f'items step {s:.2f} (bone {BONE_WIDTH}px wide), hazards step {s_haz:.2f}'



# ================================================================= UI (3-slice pieces + generated CSS)

def _cols(img):
    return np.asarray(img).astype(np.int16)


def fill_period(a, c, max_p=12, tol=10):
    """Smallest p such that columns around c repeat with period p (1 = uniform)."""
    w = a.shape[1]
    for p in range(1, max_p + 1):
        if c + 2 * p > w:
            break
        if np.abs(a[:, c:c + p] - a[:, c + p:c + 2 * p]).mean() < tol:
            return p
    return 1


def matches_fill(col, fill, tol=14):
    return min(np.abs(col - fill[:, k]).mean() for k in range(fill.shape[1])) < tol


def bottom(a, h):
    """Bottom h rows of a (padded with transparency if shorter)."""
    if a.shape[0] >= h:
        return a[a.shape[0] - h:]
    pad = np.zeros((h - a.shape[0],) + a.shape[1:], a.dtype)
    return np.concatenate([pad, a])


def three_slice_single(img):
    """Caps of a single piece whose middle is uniform/periodic -> (L|fill|R image, left, right)."""
    a = _cols(img)
    w = a.shape[1]
    c = w // 2
    p = fill_period(a, c)
    fill = a[:, c:c + p]
    x = c
    while x > 0 and matches_fill(a[:, x - 1], fill):
        x -= 1
    left = x
    x = c + p
    while x < w and matches_fill(a[:, x], fill):
        x += 1
    right = w - x
    out = np.concatenate([a[:, :left], fill, a[:, w - right:]], axis=1)
    return Image.fromarray(out.astype(np.uint8), 'RGBA'), left, right


def three_slice_parts(L, M, R):
    """Panel from separate left/mid/right pieces, each drawn as a closed box: cut the caps where
    their columns start matching the middle's interior, and keep only a repeating strip of the middle."""
    m = _cols(M)
    h = max(L.height, M.height, R.height)
    m = bottom(m, h)
    c = m.shape[1] // 2
    p = fill_period(m, c)
    fill = m[:, c:c + p]
    l, r = bottom(_cols(L), h), bottom(_cols(R), h)

    def own_fill(a):
        c = a.shape[1] // 2
        return a[:, c:c + fill_period(a, c)]

    # Left cap: decoration + border, up to where the piece's own interior begins (interior comes from the middle)
    lf = own_fill(l)
    x = 0
    while x < l.shape[1] // 2 and not matches_fill(l[:, x], lf):
        x += 1
    left = l[:, :max(1, x)]
    rf = own_fill(r)
    x = r.shape[1] - 1
    while x > r.shape[1] // 2 and not matches_fill(r[:, x], rf):
        x -= 1
    right = r[:, min(r.shape[1] - 1, x + 1):]
    out = np.concatenate([left, fill, right], axis=1)
    return Image.fromarray(out.astype(np.uint8), 'RGBA'), left.shape[1], right.shape[1]


SLICE_SINGLE = ['bar_track', 'bar_fill', 'btn_wide', 'btn_wide_pressed', 'btn_primary', 'btn_primary_pressed', 'input', 'key_space', 'banner']


def vertical_insets(img, left, right, tol=14):
    """Top/bottom border rows of a 3-sliced panel: rows of the middle strip that differ from its centre row."""
    a = _cols(img)[:, left:img.width - right]
    h = a.shape[0]
    centre = a[h // 2]
    same = lambda r: np.abs(a[r] - centre).mean() < tol
    top = h // 2
    while top > 0 and same(top - 1):
        top -= 1
    bot = h // 2
    while bot < h - 1 and same(bot + 1):
        bot += 1
    return top, h - 1 - bot


def build_ui():
    rgb = load('ui.png')
    fg = key_mask(rgb)
    comps, label = raw_components(fg)
    cells = grid_cells(comps, 5, 8)
    s, _ = detect_scale(rgb, fg)
    phase = (grid_phase(rgb, fg, s, 1), grid_phase(rgb, fg, s, 0))
    frames = {k: extract(rgb, fg, label, v, s, phase) for k, v in cells.items()}
    write_atlas('ui', frames, 5, 8, lambda r, c: 'center', {}, {'names': {f'R{r + 1}C{c + 1}': n for (r, c), n in UI_NAMES.items()}})

    by_name = {n: frames[k] for k, n in UI_NAMES.items() if k in frames}
    ui_dir = OUT / 'ui'
    ui_dir.mkdir(exist_ok=True)
    for old in ui_dir.glob('*.png'):
        old.unlink()
    slices, plain = {}, {}
    for n in ('panelS', 'panelL'):
        img, l, r = three_slice_parts(by_name[f'{n}_left'], by_name[f'{n}_mid'], by_name[f'{n}_right'])
        img.save(ui_dir / f'{n}.png')
        t, b = vertical_insets(img, l, r)
        slices[n] = {'w': img.width, 'h': img.height, 'left': l, 'right': r, 'top': t, 'bottom': b}
    for n in SLICE_SINGLE:
        img, l, r = three_slice_single(by_name[n])
        img.save(ui_dir / f'{n}.png')
        slices[n] = {'w': img.width, 'h': img.height, 'left': l, 'right': r}
    for n, img in by_name.items():
        if n in SLICE_SINGLE or n.startswith('panel'):
            continue
        img.save(ui_dir / f'{n}.png')
        plain[n] = {'w': img.width, 'h': img.height}
    (OUT / 'ui_slices.json').write_text(json.dumps({'slices': slices, 'pieces': plain}, indent=1))
    write_ui_css(slices, plain)

    items = [(f'R{r + 1}C{c + 1} {UI_NAMES.get((r, c), "?")}', im) for (r, c), im in sorted(frames.items())]
    preview_frames(f'ui: {len(frames)} pieces (step {s:.2f})', items, zoom=3).save(PREVIEW / 'ui.png')

    # 3-slice check at several widths
    demo = Image.new('RGBA', (620, 40 + 50 * len(slices)), (40, 44, 60, 255))
    d = ImageDraw.Draw(demo)
    for i, (n, sl) in enumerate(slices.items()):
        src = Image.open(ui_dir / f'{n}.png')
        y = 10 + i * 50
        d.text((4, y + 4), n, fill=(230, 230, 240), font=font(11))
        x = 110
        for width in (sl['left'] + sl['right'] + 4, sl['w'] * 2, sl['w'] * 4):
            mid_w = max(1, width - sl['left'] - sl['right'])
            row = Image.new('RGBA', (sl['left'] + mid_w + sl['right'], sl['h']))
            row.paste(src.crop((0, 0, sl['left'], sl['h'])), (0, 0))
            mid = src.crop((sl['left'], 0, sl['w'] - sl['right'], sl['h']))
            for mx in range(0, mid_w, mid.width):
                row.paste(mid, (sl['left'] + mx, 0))
            row.paste(src.crop((sl['w'] - sl['right'], 0, sl['w'], sl['h'])), (sl['left'] + mid_w, 0))
            row = row.resize((row.width * 2, row.height * 2), Image.NEAREST)
            demo.paste(row, (x, y), row)
            x += row.width + 12
    demo.save(PREVIEW / 'ui_3slice.png')
    return frames, f'ui step {s:.2f}'


def write_ui_css(slices, plain):
    """CSS for the UI pieces; sizes are in art pixels times --px (an integer number of device pixels)."""
    lines = ['/* Generated by scripts/build_assets.py - do not edit. Sizes use --px (set by game.js). */']
    for n, sl in slices.items():
        cls = n.replace('_', '-')
        lines.append(
            f'.ui-{cls} {{ border-style: solid; border-color: transparent; box-sizing: border-box; '
            f'border-image: url("ui/{n}.png") 0 {sl["right"]} 0 {sl["left"]} fill repeat; '
            f'border-width: 0 calc({sl["right"]} * var(--px)) 0 calc({sl["left"]} * var(--px)); '
            f'height: calc({sl["h"]} * var(--px)); min-width: calc({sl["left"] + sl["right"] + 1} * var(--px)); image-rendering: pixelated; }}')
    for n, sl in slices.items():
        if 'top' in sl:  # 9-slice box version of the panels
            cls = n.replace('_', '-')
            lines.append(
                f'.ui-{cls}-box {{ border-style: solid; border-color: transparent; box-sizing: border-box; '
                f'border-image: url("ui/{n}.png") {sl["top"]} {sl["right"]} {sl["bottom"]} {sl["left"]} fill repeat; '
                f'border-width: calc({sl["top"]} * var(--px)) calc({sl["right"]} * var(--px)) calc({sl["bottom"]} * var(--px)) calc({sl["left"]} * var(--px)); image-rendering: pixelated; }}')
    for n, sl in slices.items():
        if n.endswith('_pressed') and n[:-8] in slices:
            base = n[:-8].replace('_', '-')
            lines.append(
                f'.ui-{base}:active, .ui-{base}.pressed {{ border-image: url("ui/{n}.png") 0 {sl["right"]} 0 {sl["left"]} fill repeat; '
                f'border-width: 0 calc({sl["right"]} * var(--px)) 0 calc({sl["left"]} * var(--px)); }}')
    for n, p in plain.items():
        cls = n.replace('_', '-')
        lines.append(
            f'.ui-{cls} {{ display: inline-block; width: calc({p["w"]} * var(--px)); height: calc({p["h"]} * var(--px)); '
            f'background: url("ui/{n}.png") 0 0 / 100% 100% no-repeat; image-rendering: pixelated; }}')
    (OUT / 'ui.css').write_text('\n'.join(lines) + '\n')


# ================================================================= tiles + props

# Roles by sprite index in assets/preview/<theme>_tiles.png
TILESETS = {
    'garden': {
        'ground': {'left': 0, 'mid': [1, 2, 3, 4], 'right': 5, 'fill': 'body:6'},
        'platform': {'left': 7, 'mid': [8, 9, 10], 'right': 11, 'single': 12},
        'props': [17, 19, 20, 22, 23, 24, 26, 28, 25],  # no mailbox/gnome/red planter (red is for hazards); no hedge/bench/crate/fence (read as platforms)
    },
    'rooftops': {
        'ground': {'left': 0, 'mid': [1, 3], 'right': 2, 'fill': 'body:1'},
        'platform': {'left': 8, 'mid': [9], 'right': 10, 'single': 9},
        'props': [12, 14, 15, 21, 16],  # no antenna/flower box/weathervane (read as hazards); no railing/chimney wall/water tank (platforms) or pigeon (enemy)
    },
    'kitchen': {
        'ground': {'left': 0, 'mid': [3, 1], 'right': 2, 'fill': 4},
        'platform': {'left': 0, 'mid': [3], 'right': 2, 'single': 3},
        'props': [9, 10, 11, 12, 14, 17],  # no red dog bowl (red is for hazards), utensils (read as forks), chair/stool/cloth stack (read as steps)
    },
}


def snap(img):
    return img.resize((TILE, TILE), Image.NEAREST)


def blend_cols(arrs, idx_pairs):
    """Make touching columns identical (average of the opaque ones) so repeats have no seam."""
    cols = [arrs[i][:, c] for i, c in idx_pairs]
    rgb = np.mean([c[:, :3] for c in cols], axis=0)
    alpha = np.max([c[:, 3] for c in cols], axis=0)
    for i, c in idx_pairs:
        arrs[i][:, c, :3] = np.round(rgb)
        arrs[i][:, c, 3] = alpha


def make_tileset(theme, sprites):
    cfg = TILESETS[theme]
    tiles = {}

    def get(ref):
        if isinstance(ref, str) and ref.startswith('body:'):
            src = np.asarray(snap(sprites[int(ref[5:])])).copy()
            body = src[TILE // 3:]
            reps = np.concatenate([body] * 3)[:TILE]
            return reps.astype(np.int16)
        return np.asarray(snap(sprites[ref])).astype(np.int16).copy()

    for role in ('ground', 'platform'):
        r = cfg[role]
        L, R = get(r['left']), get(r['right'])
        mids = [get(m) for m in r['mid']]
        arrs = [L] + mids + [R]
        # every boundary in the chain left|mid*|right uses the same column
        pairs = [(0, TILE - 1), (len(arrs) - 1, 0)] + [(i, 0) for i in range(1, len(arrs) - 1)] + [(i, TILE - 1) for i in range(1, len(arrs) - 1)]
        blend_cols(arrs, pairs)
        tiles[f'{role}_left'] = arrs[0]
        for i, m in enumerate(arrs[1:-1]):
            tiles[f'{role}_mid{i}'] = m
        tiles[f'{role}_right'] = arrs[-1]
        if 'single' in r:
            tiles[f'{role}_single'] = get(r['single'])
        if 'fill' in r:
            f = get(r['fill'])
            blend_cols([f], [(0, 0), (0, TILE - 1)])
            f2 = f.transpose(1, 0, 2).copy()
            blend_cols([f2], [(0, 0), (0, TILE - 1)])
            f = f2.transpose(1, 0, 2)
            f[..., 3] = 255  # fill is always solid
            tiles[f'{role}_fill'] = f
    props = [trim(sprites[i]) for i in cfg['props']]

    # pack: tiles in a row of 18px cells, props below (bottom aligned in uniform cells)
    names = list(tiles)
    pw = max(p.width for p in props) + 2
    ph = max(p.height for p in props) + 2
    per_row = 8
    width = max(len(names) * TILE, per_row * pw)
    height = TILE + ((len(props) + per_row - 1) // per_row) * ph
    atlas = Image.new('RGBA', (width, height))
    meta = {'image': f'tiles_{theme}.png', 'tile': TILE, 'tiles': {}, 'props': [], 'roles': {}}
    for i, n in enumerate(names):
        atlas.paste(Image.fromarray(tiles[n].astype(np.uint8), 'RGBA'), (i * TILE, 0))
        alpha = tiles[n][..., 3] > 0
        top = [int(np.argmax(alpha[:, c])) if alpha[:, c].any() else TILE for c in range(TILE)]
        # 'top': first opaque row per column, for the darker 1px top edge drawn on walkable surfaces
        meta['tiles'][n] = {'x': i * TILE, 'y': 0, 'w': TILE, 'h': TILE, 'top': top}
    for i, p in enumerate(props):
        cx, cy = (i % per_row) * pw, TILE + (i // per_row) * ph
        x, y = cx + (pw - p.width) // 2, cy + ph - 1 - p.height
        atlas.paste(p, (x, y))
        meta['props'].append({'x': x, 'y': y, 'w': p.width, 'h': p.height, 'source': cfg['props'][i]})
    for role in ('ground', 'platform'):
        r = cfg[role]
        meta['roles'][role] = {'left': f'{role}_left', 'right': f'{role}_right',
                               'mid': [f'{role}_mid{i}' for i in range(len(r['mid']))]}
        if 'single' in r:
            meta['roles'][role]['single'] = f'{role}_single'
        if 'fill' in r:
            meta['roles'][role]['fill'] = f'{role}_fill'
    atlas.save(OUT / f'tiles_{theme}.png')
    (OUT / f'tiles_{theme}.json').write_text(json.dumps(meta, indent=1))
    return atlas, meta


def tile_demo(theme, atlas, meta):
    """A small scene built from the roles, to check seams and prop scale."""
    T = TILE
    W, H = 30, 9
    img = Image.new('RGBA', (W * T, H * T), (120, 170, 220, 255))
    t = lambda n: atlas.crop((meta['tiles'][n]['x'], 0, meta['tiles'][n]['x'] + T, T))
    roles = meta['roles']
    # ground: columns 0-13 and 17-29, 3 deep, top at row 6
    for c0, c1 in ((0, 13), (17, 29)):
        for c in range(c0, c1 + 1):
            top = roles['ground']['left'] if c == c0 else roles['ground']['right'] if c == c1 else roles['ground']['mid'][c % len(roles['ground']['mid'])]
            img.alpha_composite(t(top), (c * T, 6 * T))
            for r in (7, 8):
                img.alpha_composite(t(roles['ground']['fill']), (c * T, r * T))
    for c in range(14, 17):
        name = roles['platform']['left'] if c == 14 else roles['platform']['right'] if c == 16 else roles['platform']['mid'][0]
        img.alpha_composite(t(name), (c * T, 3 * T))
    img.alpha_composite(t(roles['platform']['single']), (20 * T, 3 * T))
    x = 4
    for p in meta['props'][:8]:
        prop = atlas.crop((p['x'], p['y'], p['x'] + p['w'], p['y'] + p['h']))
        if x * T + prop.width > 13 * T and x < 17:
            x = 18
        if x * T + prop.width > W * T:
            break
        img.alpha_composite(prop, (x * T, 6 * T - prop.height))
        x += max(2, prop.width // T + 1)
    return img.resize((img.width * 2, img.height * 2), Image.NEAREST)


def free_sheet(name, tile_px=None):
    """Loose sheet (tiles + props): components grouped, sampled at a step that makes tiles 18px."""
    rgb = load(name)
    fg = key_mask(rgb)
    comps, label = raw_components(fg, min_area=12)
    groups = group_free(comps)
    groups.sort(key=lambda g: (round(g['cy'] / 120), g['cx']))
    if tile_px is None:
        squares = [max(g['x1'] - g['x0'], g['y1'] - g['y0']) for g in groups
                   if 0.85 < (g['x1'] - g['x0']) / max(1, g['y1'] - g['y0']) < 1.18]
        tile_px = float(np.median(squares)) if squares else 150.0
    s = tile_px / TILE
    members = {g['id']: [c for c in comps if c['id'] in g['members']] for g in groups}
    sprites = [extract(rgb, fg, label, members[g['id']], s) for g in groups]
    return sprites, s, tile_px


def build_tiles():
    notes = []
    for theme in ('garden', 'rooftops', 'kitchen'):
        sprites, s, tile_px = free_sheet(f'{theme}_tiles.png')
        items = [(f'#{i} {im.width}x{im.height}', im) for i, im in enumerate(sprites)]
        preview_frames(f'{theme}_tiles: {len(sprites)} sprites (step {s:.2f}, tile {tile_px:.0f} raw px)', items, zoom=4, cols=7).save(PREVIEW / f'{theme}_tiles.png')
        atlas, meta = make_tileset(theme, sprites)
        tile_demo(theme, atlas, meta).save(PREVIEW / f'{theme}_tiles_demo.png')
        notes.append(f'{theme} tiles step {s:.2f}: {len(meta["tiles"])} tiles, {len(meta["props"])} props')
    return notes


# ================================================================= backgrounds, title, logo, cards

def green_row_strips(rgb, min_gap=3):
    rows_green = (green_dist(rgb) < KEY_TOL).mean(axis=1) > 0.97
    strips, start = [], None
    for y, g in enumerate(list(rows_green) + [True]):
        if not g and start is None:
            start = y
        if g and start is not None:
            if y - start > 8:
                strips.append((start, y))
            start = None
    return strips


def repeat_width(a, min_frac=0.55, probe=4):
    """Best width p so that column p continues seamlessly into column 0. Returns (p, error)."""
    w = a.shape[1]
    best, best_err = w, 1e9
    for p in range(int(w * min_frac), w - probe):
        err = np.abs(a[:, p:p + probe] - a[:, :probe]).mean()
        if err < best_err:
            best, best_err = p, err
    return best, best_err


def crossfade(a, n=32, binary=True):
    """No clean repeat point: blend a band of n edge columns (last n into the first n) so the wrap is seamless."""
    w = a.shape[1]
    out = a[:, :w - n].copy().astype(np.float64)
    tail = a[:, w - n:].astype(np.float64)
    t = np.linspace(0, 1, n)[None, :, None]
    out[:, :n] = tail * (1 - t) + out[:, :n] * t
    if binary:
        out[..., 3] = np.where(out[..., 3] >= 128, 255, 0)
    return out.astype(np.int16)


# Per theme: 'overlap' = layers overlap (keyed tops; game.js staggers them so they fill the view height);
# 'stack' = the kitchen's interior bands, a deliberate window/wall split.
BG_LAYOUT = {'garden': 'overlap', 'rooftops': 'overlap', 'kitchen': 'stack'}
# Strips painted with a sky band behind their scenery: key that band by colour similarity to the top rows
# layer: colour tolerance; 'soft' = alpha fades with colour distance (hazy far layers that sit on the sky)
BG_SKY_KEY = {'rooftops': {2: 'soft', 3: 30, 4: 30}}


def soft_sky_key(a, near=8, far=34):
    """Hazy far layer painted over sky: alpha follows the colour distance to each row's sky reference
    (taken from the top rows and blended down), so the sky dissolves and the haze fades into the real sky."""
    h, w = a.shape[:2]
    rgb = a[..., :3].astype(np.float64)
    opaque = a[..., 3] > 0
    top = int(np.argmax(opaque.mean(axis=1) > 0.9))
    sky_top = np.median(rgb[top:top + 3][opaque[top:top + 3]], axis=0)
    out = a.copy().astype(np.float64)
    for y in range(h):
        d = np.sqrt(((rgb[y] - sky_top) ** 2).sum(axis=1))
        out[y, :, 3] = np.where(opaque[y], np.clip((d - near) / (far - near), 0, 1) * 255, 0)
    return out.astype(np.int16)


def key_top_band(a, tol=30, drift=14, min_island=60):
    """Transparent sky band behind a layer's scenery. Per row, the sky reference is the median of the pixels
    close to the previous row's reference (so it follows the painted gradient but cannot jump to the scenery);
    pixels near it that are connected to the top become transparent. Small islands are removed afterwards."""
    h, w = a.shape[:2]
    rgb = a[..., :3].astype(np.float64)
    opaque = a[..., 3] > 0
    top = int(np.argmax(opaque.mean(axis=1) > 0.9))  # first fully painted row
    ref = np.median(rgb[top:top + 3][opaque[top:top + 3]], axis=0)
    cand = np.zeros((h, w), bool)
    for y in range(top, h):
        d = np.sqrt(((rgb[y] - ref) ** 2).sum(axis=1))
        near = opaque[y] & (d < tol)
        if near.sum() > w * 0.05:
            new_ref = np.median(rgb[y][near], axis=0)
            step = new_ref - ref
            n = np.linalg.norm(step)
            ref = ref + (step if n <= drift else step / n * drift)
        cand[y] = opaque[y] & (np.sqrt(((rgb[y] - ref) ** 2).sum(axis=1)) < tol)
    # flood from the top through sky candidates
    sky = np.zeros((h, w), bool)
    q = deque((top, x) for x in range(w) if cand[top, x])
    for y, x in q:
        sky[y, x] = True
    while q:
        y, x = q.popleft()
        for yy, xx in ((y + 1, x), (y, x + 1), (y, x - 1), (y - 1, x)):
            if 0 <= yy < h and 0 <= xx < w and cand[yy, xx] and not sky[yy, xx]:
                sky[yy, xx] = True
                q.append((yy, xx))
    out = a.copy()
    out[sky, 3] = 0
    # drop small opaque specks left inside the removed sky
    keep = out[..., 3] > 0
    comps, label = components(keep)
    for c in comps:
        if c['area'] < min_island:
            out[label == c['id'], 3] = 0
    return out


def solid_top(img, frac=0.9):
    rows = (np.asarray(img)[..., 3] > 0).mean(axis=1)
    ok = np.nonzero(rows >= frac)[0]
    return int(ok[0]) if len(ok) else img.height


def build_backgrounds():
    notes = []
    for theme in ('garden', 'rooftops', 'kitchen'):
        rgb = load(f'{theme}_bg.png')
        strips = green_row_strips(rgb)
        assert len(strips) == 4, f'{theme}_bg: expected 4 strips, found {len(strips)}'
        layers = []
        for i, (y0, y1) in enumerate(strips):
            part = rgb[y0:y1]
            if i == 0:
                # opaque sky: drop edge rows that still carry key-green from the gap
                g, rb = part[..., 1], np.maximum(part[..., 0], part[..., 2])
                greenish = ((g - rb > 40) & (g > 150)).mean(axis=1) > 0.01
                t0, t1 = 0, len(part)
                while t0 < 8 and greenish[t0]:
                    t0 += 1
                while t1 > len(part) - 8 and greenish[t1 - 1]:
                    t1 -= 1
                part = part[t0:t1]
            fg = np.ones(part.shape[:2], bool) if i == 0 else key_mask(part)
            cols = np.nonzero(fg.any(axis=0))[0]
            part, fg = part[:, cols.min():cols.max() + 1], fg[:, cols.min():cols.max() + 1]
            if i:
                # rows next to the green gap carry key-green fringe: drop green-dominant pixels there
                edge = np.zeros(fg.shape, bool)
                edge[:4] = True
                edge[-4:] = True
                g, rb = part[..., 1], np.maximum(part[..., 0], part[..., 2])
                fg &= ~(edge & (g - rb > 40))
            small, alpha = sample(part, fg, BG_STEP, 0, 0)
            img = np.asarray(to_rgba(small, alpha)).astype(np.int16)
            mode = BG_SKY_KEY.get(theme, {}).get(i + 1)
            if mode == 'soft':
                img = soft_sky_key(img)
            elif mode:
                img = key_top_band(img, tol=mode)
            if i:
                img = np.asarray(trim(Image.fromarray(img.astype(np.uint8), 'RGBA'))).astype(np.int16)
            p, err = repeat_width(img)
            if err < (5 if i < 2 else 9):
                img, how = img[:, :p], f'repeat@{p} (err {err:.1f})'
            elif err > 20:
                # very different ends: mirror-tile (image + its mirror), seamless at both joins
                img, how = np.concatenate([img, img[:, ::-1]], axis=1), f'mirror-tiled (best repeat err {err:.0f})'
            else:
                img, how = crossfade(img, 32, binary=mode != 'soft'), f'32px crossfade (best repeat err {err:.0f})'
            im = Image.fromarray(img.astype(np.uint8), 'RGBA')
            im.save(OUT / f'bg_{theme}_{i + 1}.png')
            layers.append(im)
            opaque = (np.asarray(im)[..., 3] > 0).mean()
            notes.append(f'{theme} layer {i + 1}: {im.width}x{im.height} {how}, {opaque:.0%} opaque')
        top = np.asarray(layers[0]).astype(np.int16)[:2, :, :3].reshape(-1, 3).mean(axis=0)
        (OUT / f'bg_{theme}.json').write_text(json.dumps({
            'sky': '#%02x%02x%02x' % tuple(int(v) for v in top),
            # solidTop: first row that is (almost) fully opaque; game.js tucks farther layers under it so nothing shows through
            'layers': [{'image': f'bg_{theme}_{i + 1}.png', 'w': l.width, 'h': l.height, 'solidTop': solid_top(l)} for i, l in enumerate(layers)],
            'factors': [0.05, 0.2, 0.45, 0.7], 'layout': BG_LAYOUT[theme]}, indent=1))
        # preview (half size): each layer tiled across two repeats on a checker, to check keying and seams
        pw = max(l.width for l in layers) * 2
        pv = Image.new('RGBA', (pw, sum(l.height + 8 for l in layers)), (30, 32, 44, 255))
        y = 0
        for l in layers:
            pv.paste(checker(pw, l.height), (0, y))
            for x in range(0, pw, l.width):
                pv.alpha_composite(l, (x, y))
            y += l.height + 8
        pv.resize((pv.width // 2, pv.height // 2), Image.NEAREST).save(PREVIEW / f'bg_{theme}.png')
    return notes


# Hazards sheet: 6 columns (garden bramble, garden stakes, roof broken tiles, roof aerial, kitchen forks,
# kitchen burner), row 1 static, row 2 pulse
HAZARD_NAMES = ['bramble', 'stakes', 'brokenTiles', 'aerial', 'forks', 'burner']
HAZARD_THEMES = {'garden': ['bramble', 'stakes'], 'rooftops': ['brokenTiles', 'aerial'], 'kitchen': ['forks', 'burner']}


def build_hazards():
    rgb = load('hazards.png')
    fg = key_mask(rgb)
    comps, label = raw_components(fg)
    cells = grid_cells(comps, 2, 6)
    width = lambda k: max(m['x1'] for m in cells[k]) - min(m['x0'] for m in cells[k])
    s = float(np.median([width((0, c)) for c in range(6)]) / HAZARD_WIDTH)
    frames = {k: extract(rgb, fg, label, v, s) for k, v in cells.items()}
    anims = {n: {'frames': [f'R1C{c + 1}', f'R2C{c + 1}'], 'fps': 2 / 1.5, 'loop': True} for c, n in enumerate(HAZARD_NAMES)}
    write_atlas('hazards', frames, 2, 6, lambda r, c: 'bottom', anims, {'themes': HAZARD_THEMES})
    anim_preview('hazards', frames, anims, zoom=5)
    return [f'hazards step {s:.2f} ({HAZARD_WIDTH}px wide)']


def build_title_logo():
    rgb = load('title_scene.png')
    fg = np.ones(rgb.shape[:2], bool)
    s = 1.0  # generated resolution; game.js draws it at whole device pixels
    small, alpha = sample(rgb, fg, s, grid_phase(rgb, fg, s, 1), grid_phase(rgb, fg, s, 0))
    title = to_rgba(small, alpha)
    title.save(OUT / 'title_bg.png')
    lrgb = load('logo.png')
    lfg = key_mask(lrgb)
    ls, _ = detect_scale(lrgb, lfg)
    lsmall, lalpha = sample(lrgb, lfg, ls, grid_phase(lrgb, lfg, ls, 1), grid_phase(lrgb, lfg, ls, 0))
    logo = trim(to_rgba(lsmall, lalpha))
    logo.save(OUT / 'logo.png')
    # Social preview (Open Graph / Twitter, 1200x630): the title scene covering the frame, logo at 3x on top
    k = max(1200 / title.width, 630 / title.height)
    scene = title.resize((round(title.width * k), round(title.height * k)), Image.LANCZOS)
    og = scene.crop(((scene.width - 1200) // 2, (scene.height - 630) // 2, (scene.width - 1200) // 2 + 1200, (scene.height - 630) // 2 + 630))
    big = logo.resize((logo.width * 3, logo.height * 3), Image.NEAREST)
    og.alpha_composite(big, ((1200 - big.width) // 2, (630 - big.height) // 2 - 40))
    og.convert('RGB').save(OUT / 'og_image.png', optimize=True)
    # left: title scene alone; right: logo alone on a dark background
    lg = logo.resize((logo.width * 2, logo.height * 2), Image.NEAREST)
    pv = Image.new('RGBA', (title.width // 2 + lg.width + 30, max(title.height // 2, lg.height)), (30, 32, 44, 255))
    pv.alpha_composite(title.resize((title.width // 2, title.height // 2), Image.NEAREST))
    pv.alpha_composite(lg, (title.width // 2 + 20, 10))
    pv.save(PREVIEW / 'title.png')
    return [f'title {title.width}x{title.height} (step {s:.2f}), logo {logo.width}x{logo.height} (step {ls:.2f})']


def build_cards():
    for name in ('card_photo', 'card_photo_gold'):
        img = Image.open(RAW / f'{name}.png').convert('RGB').resize((900, 900), Image.LANCZOS)
        img.save(OUT / f'{name}.jpg', quality=90)
    a = Image.open(OUT / 'card_photo.jpg').resize((300, 300), Image.LANCZOS)
    b = Image.open(OUT / 'card_photo_gold.jpg').resize((300, 300), Image.LANCZOS)
    pv = Image.new('RGB', (610, 300), (30, 32, 44))
    pv.paste(a, (0, 0)); pv.paste(b, (310, 0))
    pv.save(PREVIEW / 'card_photos.png')
    return ['card photos 900x900 (LANCZOS, JPEG q90)']


def write_manifest():
    """Every JSON in one script file, so the game also works from file:// (no fetch)."""
    manifest = {f.stem: json.loads(f.read_text()) for f in sorted(OUT.glob('*.json'))}
    body = json.dumps(manifest, separators=(',', ':'))
    (OUT / 'manifest.js').write_text('// Generated by scripts/build_assets.py - do not edit.\nwindow.ART_MANIFEST = ' + body + ';\n')
    return [f'manifest: {len(manifest)} entries']


def build_all():
    OUT.mkdir(parents=True, exist_ok=True)
    PREVIEW.mkdir(parents=True, exist_ok=True)
    notes = []
    *_, rep = build_characters()
    notes.append(rep['characters'])
    notes.append(build_items()[1])
    notes.append(build_ui()[1])
    notes += build_tiles()
    notes += build_backgrounds()
    notes += build_hazards()
    notes += build_title_logo()
    notes += build_cards()
    notes += write_manifest()
    print('\n'.join(notes))


if __name__ == '__main__':
    build_all()
