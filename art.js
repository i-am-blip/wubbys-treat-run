// Final art: atlases, tiles, backgrounds and UI built by scripts/build_assets.py.
// Metadata comes from public/assets/game/manifest.js (window.ART_MANIFEST), so no fetch is needed.

const ART_DIR = 'public/assets/game/';
const art = { meta: window.ART_MANIFEST || {}, images: {} };

function loadArt(onDone) {
    const files = new Set(['title_bg.png', 'logo.png', 'card_photo.jpg', 'card_photo_gold.jpg']);
    for (const m of Object.values(art.meta)) {
        if (m.image) files.add(m.image);
        if (m.layers) m.layers.forEach(l => files.add(l.image));
    }
    let pending = files.size;
    const done = () => { if (--pending === 0) onDone(); };
    files.forEach(f => {
        const img = new Image();
        img.onload = done;
        img.onerror = () => { console.warn('Missing art', f); done(); };
        img.src = ART_DIR + f;
        art.images[f] = img;
    });
}

const artImage = (file) => art.images[file];

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

// Draws one atlas frame at its anchor: bottom-centre (characters, ground items) or centre (effects, pickups).
// Positions are rounded to whole pixels; flip mirrors horizontally around the anchor.
function drawFrame(c, sheet, frame, x, y, flip = false, alpha = 1) {
    const m = art.meta[sheet];
    const f = m.frames[frame];
    const img = art.images[m.image];
    if (!f || !img || !img.naturalWidth) return;
    const ax = Math.floor(f.w / 2);
    const ay = f.anchor === 'bottom' ? f.h - 1 : Math.floor(f.h / 2);
    c.save();
    if (alpha !== 1) c.globalAlpha *= alpha;
    c.translate(Math.round(x), Math.round(y));
    if (flip) c.scale(-1, 1);
    c.drawImage(img, f.x, f.y, f.w, f.h, -ax, -ay, f.w, f.h);
    c.restore();
}

function drawAnim(c, sheet, name, t, x, y, flip = false, alpha = 1) {
    drawFrame(c, sheet, animFrame(sheet, name, t), x, y, flip, alpha);
}
