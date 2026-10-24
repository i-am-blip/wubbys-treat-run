// Reward card helpers: name validation, treat number, PNG blob and download (the copy fallback).

const DEFAULT_NAME = 'a kind stranger';

// Letters, numbers, spaces and basic punctuation only; max 20 chars after trimming
function sanitizeName(raw) {
    const cleaned = String(raw || '')
        .replace(/[^\p{L}\p{N} .,'!?&_-]/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 20)
        .trim();
    return cleaned || DEFAULT_NAME;
}

// Stable 4-digit number from a hash (FNV-1a) of the name and finish time
function treatNumber(name, finishTimeMs) {
    let h = 0x811c9dc5;
    const s = `${name}|${Math.round(finishTimeMs)}`;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return String(h % 10000).padStart(4, '0');
}

// Production URL from config; the page's own URL only when it is a real site. '' = no URL.
function siteUrl() {
    if (CONFIG.card.siteUrl) return CONFIG.card.siteUrl;
    const local = location.protocol === 'file:' || /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/.test(location.hostname);
    return local ? '' : location.origin + location.pathname;
}

function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
}

async function downloadCard(canvas, data) {
    const blob = await canvasToBlob(canvas);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wubby-treat-${data.treat}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
