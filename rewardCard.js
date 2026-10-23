// Reward card image: one function, data in -> canvas out. The image is only the polaroid
// (portrait, CONFIG.card size): white frame, the photo (gold version + star sticker at 9/9),
// the caption "Wubby & {name} ♥" with the date in Caveat, and the site URL very small.
// Illustration, not pixel art, so smoothing stays on.
//
// data: { name, date, url, goldens, totalGoldens }
// art:  { photo, photoGold } images (900x900)
// Returns the canvas (a new one unless `canvas` is passed). Expects the Caveat font to be loaded;
// if it isn't yet, text falls back to a cursive font and the caller can simply render again.
function renderRewardCard(data, art, canvas = document.createElement('canvas')) {
    const W = CONFIG.card.width, H = CONFIG.card.height;
    canvas.width = W;
    canvas.height = H;
    const c = canvas.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    const hand = (size, weight = 400) => `${weight} ${size}px Caveat, 'Segoe Script', cursive`;
    const perfect = data.goldens >= data.totalGoldens;

    // Frame: warm white with a whisper of paper grain
    c.fillStyle = '#fffdf7';
    c.fillRect(0, 0, W, H);
    grain(c, W, H);

    // Photo
    const m = 64, photo = W - m * 2;
    const img = perfect ? art.photoGold : art.photo;
    c.fillStyle = '#ece5d8';
    c.fillRect(m, m, photo, photo);
    if (img && img.naturalWidth) c.drawImage(img, m, m, photo, photo);
    // slight inner edge so the print sits in the frame
    c.strokeStyle = 'rgba(60, 40, 20, 0.12)';
    c.lineWidth = 2;
    c.strokeRect(m + 1, m + 1, photo - 2, photo - 2);

    // Caption strip
    const stripTop = m + photo;
    const line = `Wubby & ${data.name} ♥`;
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.fillStyle = '#3b2a1e';
    c.font = hand(fitSize(c, line, 92, 54, photo - 40, (s) => hand(s, 700)), 700);
    c.fillText(line, W / 2, stripTop + 132);
    c.font = hand(48);
    c.fillStyle = '#8a7462';
    c.fillText(data.date, W / 2, stripTop + 196);

    if (data.url) {
        c.textAlign = 'right';
        c.font = hand(26);
        c.fillStyle = 'rgba(110, 90, 70, 0.6)';
        c.fillText(data.url, W - 34, H - 26);
    }

    if (perfect) star(c, W - 78, 70, 54, 0.22);
    return canvas;
}

// Very subtle paper texture (deterministic)
function grain(c, W, H) {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 7000; i++) {
        c.fillStyle = rnd() < 0.5 ? `rgba(120, 95, 60, ${0.02 + rnd() * 0.025})` : `rgba(255, 255, 255, ${0.05 + rnd() * 0.05})`;
        c.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
    }
}

// Largest font size (between max and min) at which text fits the width
function fitSize(c, text, max, min, width, fontFor) {
    for (let s = max; s > min; s -= 2) {
        c.font = fontFor(s);
        if (c.measureText(text).width <= width) return s;
    }
    return min;
}

// Small gold star sticker
function star(c, x, y, r, rot) {
    c.save();
    c.translate(x, y);
    c.rotate(rot);
    c.beginPath();
    for (let i = 0; i < 10; i++) {
        const rad = i % 2 === 0 ? r : r * 0.45;
        const a = -Math.PI / 2 + i * Math.PI / 5;
        c.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    c.closePath();
    c.shadowColor = 'rgba(80, 50, 0, 0.3)';
    c.shadowBlur = 8;
    c.shadowOffsetY = 3;
    const g = c.createLinearGradient(-r, -r, r, r);
    g.addColorStop(0, '#ffe680');
    g.addColorStop(1, '#e0a400');
    c.fillStyle = g;
    c.fill();
    c.shadowColor = 'transparent';
    c.strokeStyle = '#b07d00';
    c.lineWidth = 3;
    c.stroke();
    c.restore();
}
