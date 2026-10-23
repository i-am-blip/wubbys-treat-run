// Reward card image: one function, data in -> canvas out. A polaroid of Wubby on a cream backdrop
// with handwritten notes. This is illustration, not pixel art, so smoothing stays on.
//
// data: { name, treat, runTime (ms), goldens, totalGoldens, fullBelly, totalLevels, date, url }
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

    paper(c, W, H);

    // ---- Polaroid, tilted about -4 degrees
    const pw = 430, ph = 520, photo = 380;
    c.save();
    c.translate(300, H / 2 + 4);
    c.rotate(-4 * Math.PI / 180);
    c.shadowColor = 'rgba(60, 40, 20, 0.28)';
    c.shadowBlur = 28;
    c.shadowOffsetY = 12;
    c.fillStyle = '#fffdf8';
    c.fillRect(-pw / 2, -ph / 2, pw, ph);
    c.shadowColor = 'transparent';
    const img = perfect ? art.photoGold : art.photo;
    const px = -photo / 2, py = -ph / 2 + 25;
    c.fillStyle = '#e9e2d4';
    c.fillRect(px, py, photo, photo);
    if (img && img.naturalWidth) c.drawImage(img, px, py, photo, photo);
    c.strokeStyle = 'rgba(0, 0, 0, 0.08)';
    c.lineWidth = 1;
    c.strokeRect(px + 0.5, py + 0.5, photo - 1, photo - 1);

    // bottom strip: "Wubby & {name} ♥" and the date
    c.fillStyle = '#3b2a1e';
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    const line = `Wubby & ${data.name} ♥`;
    c.font = hand(fitSize(c, line, 46, 26, photo, (s) => hand(s, 700)), 700);
    c.fillText(line, 0, py + photo + 58);
    c.font = hand(26);
    c.fillStyle = '#7a6655';
    c.fillText(data.date, 0, py + photo + 92);

    if (perfect) star(c, pw / 2 - 18, -ph / 2 + 14, 30, 0.25);
    c.restore();

    // ---- Fridge note on the right
    c.save();
    c.translate(800, 300);
    c.rotate(2 * Math.PI / 180);
    c.shadowColor = 'rgba(60, 40, 20, 0.18)';
    c.shadowBlur = 14;
    c.shadowOffsetY = 6;
    c.fillStyle = '#fff6c9';
    c.fillRect(-210, -200, 420, 390);
    c.shadowColor = 'transparent';
    // faint ruled lines
    c.strokeStyle = 'rgba(120, 150, 200, 0.22)';
    c.lineWidth = 2;
    for (let y = -120; y < 180; y += 58) { c.beginPath(); c.moveTo(-185, y + 18); c.lineTo(185, y + 18); c.stroke(); }
    // tape
    c.fillStyle = 'rgba(230, 215, 170, 0.75)';
    c.save(); c.rotate(-6 * Math.PI / 180); c.fillRect(-60, -222, 120, 34); c.restore();

    c.textAlign = 'left';
    c.fillStyle = '#c0392b';
    c.font = hand(58, 700);
    c.fillText(`Treat #${data.treat}`, -180, -128);
    c.fillStyle = '#33415c';
    c.font = hand(40);
    [
        `run time  ${formatTime(data.runTime)}`,
        `golden bones  ${data.goldens}/${data.totalGoldens}`,
        `full belly  ${data.fullBelly}/${data.totalLevels}`
    ].forEach((t, i) => c.fillText(t, -180, -50 + i * 58));
    c.fillStyle = '#7a6655';
    c.font = hand(30);
    c.fillText('— thanks for the help! ♥', -180, 150);
    c.restore();

    // ---- Site URL, small, bottom right
    c.textAlign = 'right';
    c.fillStyle = 'rgba(70, 55, 40, 0.7)';
    c.font = hand(26);
    c.fillText(data.url, W - 28, H - 22);
    return canvas;
}

// Soft cream backdrop with a very subtle paper texture (deterministic, drawn in code)
function paper(c, W, H) {
    c.fillStyle = '#f5eedf';
    c.fillRect(0, 0, W, H);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 9000; i++) {
        const v = rnd();
        c.fillStyle = v < 0.5 ? `rgba(120, 95, 60, ${0.025 + rnd() * 0.03})` : `rgba(255, 255, 255, ${0.05 + rnd() * 0.06})`;
        c.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
    }
    c.strokeStyle = 'rgba(140, 110, 70, 0.035)';
    c.lineWidth = 1;
    for (let i = 0; i < 70; i++) {
        const x = rnd() * W, y = rnd() * H, len = 20 + rnd() * 60, a = rnd() * Math.PI;
        c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); c.stroke();
    }
    const g = c.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(110, 80, 40, 0.12)');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
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
    c.shadowBlur = 6;
    c.shadowOffsetY = 2;
    const g = c.createLinearGradient(-r, -r, r, r);
    g.addColorStop(0, '#ffe680');
    g.addColorStop(1, '#e0a400');
    c.fillStyle = g;
    c.fill();
    c.shadowColor = 'transparent';
    c.strokeStyle = '#b07d00';
    c.lineWidth = 2;
    c.stroke();
    c.restore();
}
