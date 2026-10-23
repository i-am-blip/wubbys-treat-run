// Reward card helpers: name validation, treat number, download / share / copy link.

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

function shareText(data) {
    return `Wubby got his treat back, thanks to ${data.name} ♥`;
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

// Returns 'web_share' when shared natively, 'cancelled', or 'fallback' when links should be shown instead
async function shareCard(canvas, data) {
    try {
        const blob = await canvasToBlob(canvas);
        const file = new File([blob], `wubby-treat-${data.treat}.png`, { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            const url = siteUrl();
            await navigator.share({ files: [file], text: shareText(data), ...(url ? { url } : {}) });
            return 'web_share';
        }
    } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
    }
    return 'fallback';
}

function shareLinks(data) {
    const text = shareText(data), url = siteUrl();
    return {
        x: `https://x.com/intent/post?text=${encodeURIComponent(text)}` + (url ? `&url=${encodeURIComponent(url)}` : ''),
        linkedin: `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(url ? text + ' ' + url : text)}`
    };
}

async function copyLink() {
    const url = siteUrl() || location.href;
    try {
        await navigator.clipboard.writeText(url);
        return true;
    } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    }
}
