// Final art: atlases, tiles, backgrounds and UI built by scripts/build_assets.py.
// Metadata comes from public/assets/game/manifest.js (window.ART_MANIFEST), so no fetch is needed.
// In production, scripts/build-dist.mjs writes window.ASSET_MAP: each file name -> its content-hashed URLs, WebP
// first and the PNG / JPG as the fallback. In development the files load straight from public/assets/game/.

const ART_DIR = 'public/assets/game/';
const art = { meta: window.ART_MANIFEST || {}, images: {} };
const assetUrls = (file) => (window.ASSET_MAP && window.ASSET_MAP[file]) || [ART_DIR + file];

// Title scene for this screen shape: the tall one on portrait screens (aspect below ~0.8), the wide one otherwise
const titleSceneFile = () => (innerWidth / Math.max(1, innerHeight) < 0.8 ? 'title_mobile.png' : 'title_bg.png');

// One image, tried URL by URL (WebP, then the fallback). Resolves with the decoded image; a failure rejects and is
// forgotten, so a later call retries it.
const imageLoads = {};
function loadImage(file) {
    if (imageLoads[file]) return imageLoads[file];
    const urls = assetUrls(file);
    imageLoads[file] = new Promise((resolve, reject) => {
        const img = new Image();
        let i = 0;
        img.decoding = 'async';
        // decode() keeps the (large) decode off the main thread, so drawing it later doesn't stall a frame
        img.onload = () => (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).then(() => { art.images[file] = img; resolve(img); });
        img.onerror = () => {
            if (++i < urls.length) { img.src = urls[i]; return; }
            delete imageLoads[file];
            reject(new Error(`Could not load ${file}`));
        };
        img.src = urls[0];
    });
    return imageLoads[file];
}

// Several images; onProgress(done, total) after each one
function loadImages(files, onProgress) {
    let done = 0;
    return Promise.all(files.map(f => loadImage(f).then(img => { if (onProgress) onProgress(++done, files.length); return img; })));
}

// A loaded image, or undefined (drawing code skips images that aren't there yet)
const artImage = (file) => art.images[file];

// An image that isn't preloaded (the other title scene after a rotation): starts loading on first request
function lazyArtImage(file) {
    if (!art.images[file]) loadImage(file).catch(() => {});
    return art.images[file] || null;
}

function anim(sheet, name) {
    return art.meta[sheet].animations[name];
}

function animDuration(sheet, name) {
    const a = anim(sheet, name);
    return a.frames.length / a.fps;
}

// Frame name of an animation at time t (seconds since it started); non-looping ones hold the last frame
function animFrame(sheet, name, t) {
    const a = anim(sheet, name);
    const i = Math.floor(Math.max(0, t) * a.fps);
    return a.frames[a.loop ? i % a.frames.length : Math.min(i, a.frames.length - 1)];
}

// Interactive sprites get extra outline rings added in code (pixel-stepped, 4-neighbour dilation), innermost first,
// e.g. ['#1e1008'] or, for hazards, [dark, red]. scale enlarges the result with nearest-neighbour sampling.
// Each (frame, rings, scale) is built once and cached.
const OUTLINE_DARK = 'rgba(24, 12, 6, 0.9)';
const outlineCache = new Map();

function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    return [c, g];
}

function outlinedFrame(sheet, frame, rings, scale) {
    const key = `${sheet}|${frame}|${rings.join(',')}|${scale}`;
    if (outlineCache.has(key)) return outlineCache.get(key);
    const m = art.meta[sheet];
    const f = m.frames[frame];
    const img = art.images[m.image];
    const pad = rings.length;
    const w = f.w + pad * 2, h = f.h + pad * 2;
    const [base, bg] = makeCanvas(w, h);
    bg.drawImage(img, f.x, f.y, f.w, f.h, pad, pad, f.w, f.h);
    // Grow the silhouette one pixel per ring and colour each ring
    let shape = base;
    const layers = rings.map(color => {
        const [grown, g] = makeCanvas(w, h);
        for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) g.drawImage(shape, dx, dy);
        shape = grown;
        const [ring, rg] = makeCanvas(w, h);
        rg.drawImage(grown, 0, 0);
        rg.globalCompositeOperation = 'source-in';
        rg.fillStyle = color;
        rg.fillRect(0, 0, w, h);
        return ring;
    });
    const [out, og] = makeCanvas(w, h);
    for (let i = layers.length - 1; i >= 0; i--) og.drawImage(layers[i], 0, 0);
    og.drawImage(base, 0, 0);
    let result = { canvas: out, w, h, ax: Math.floor(f.w / 2) + pad, ay: (f.anchor === 'bottom' ? f.h - 1 : Math.floor(f.h / 2)) + pad };
    if (scale !== 1) {
        const sw = Math.round(w * scale), sh = Math.round(h * scale);
        const [big, bg2] = makeCanvas(sw, sh);
        bg2.drawImage(out, 0, 0, sw, sh);
        result = { canvas: big, w: sw, h: sh, ax: Math.round(result.ax * scale), ay: Math.round(result.ay * scale) };
    }
    outlineCache.set(key, result);
    return result;
}

// Draws one atlas frame at its anchor: bottom-centre (characters, ground items) or centre (effects, pickups).
// Positions are rounded to whole pixels; flip mirrors horizontally around the anchor.
// opts: { rings: [...colours], scale } draws the outlined (and scaled) version.
function drawFrame(c, sheet, frame, x, y, flip = false, alpha = 1, opts = null) {
    const m = art.meta[sheet];
    const f = m.frames[frame];
    const img = art.images[m.image];
    if (!f || !img || !img.naturalWidth) return;
    c.save();
    if (alpha !== 1) c.globalAlpha *= alpha;
    c.translate(Math.round(x), Math.round(y));
    if (flip) c.scale(-1, 1);
    if (opts) {
        const o = outlinedFrame(sheet, frame, opts.rings || [OUTLINE_DARK], opts.scale || 1);
        c.drawImage(o.canvas, -o.ax, -o.ay);
    } else {
        const ax = Math.floor(f.w / 2);
        const ay = f.anchor === 'bottom' ? f.h - 1 : Math.floor(f.h / 2);
        c.drawImage(img, f.x, f.y, f.w, f.h, -ax, -ay, f.w, f.h);
    }
    c.restore();
}

function drawAnim(c, sheet, name, t, x, y, flip = false, alpha = 1, opts = null) {
    drawFrame(c, sheet, animFrame(sheet, name, t), x, y, flip, alpha, opts);
}

// Interactive objects: the outlined sprite, crisp and fully saturated
const OUTLINED = { rings: [OUTLINE_DARK] };
