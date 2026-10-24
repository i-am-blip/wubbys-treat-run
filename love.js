// End screen: "Send Wubby some love" (one per browser) and the creator credit.
// Counts go to the serverless routes in netlify/functions (see SETUP.md). When those are unreachable
// (local server, missing env vars) the end screen still works and no error is shown.

const reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

const love = {
    sent() {
        try { return localStorage.getItem(CONFIG.loveKey) === '1'; } catch (e) { return false; }
    },
    remember() {
        try { localStorage.setItem(CONFIG.loveKey, '1'); } catch (e) { /* not persisted */ }
    }
};

// JSON from one of our API routes, or null on any failure (never throws)
async function apiCall(path, options = {}) {
    if (location.protocol === 'file:') return null;
    try {
        const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
        return res.ok ? await res.json() : null;
    } catch (e) {
        return null;
    }
}

// Social proof: "♥ N players loved this", or null when there's no count yet
function lovedByText(count) {
    if (!Number.isFinite(count) || count <= 0) return null;
    return `♥ ${count} ${count === 1 ? 'player' : 'players'} loved this`;
}

// Local dev (no Upstash, or no API at all) gets a mock count on the end screen so its layout can be checked;
// in production a failed request just hides the line
const LOCAL_DEV = location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(location.hostname);
const MOCK_LOVE_COUNT = 128;

async function fetchLoveCount(mock = false) {
    const res = await apiCall(CONFIG.api.love);
    const count = res && res.count != null ? Number(res.count) : NaN;
    return Number.isFinite(count) || !(mock && LOCAL_DEV) ? count : MOCK_LOVE_COUNT;
}

function setLoveText(text) {
    $('loveText').textContent = text || '';
    $('loveText').classList.toggle('hidden', !text);
}

// Title screen: quiet count near the bottom, hidden when there is none or the request fails
async function refreshTitleLove() {
    const text = lovedByText(await fetchLoveCount());
    $('titleLove').textContent = text || '';
    $('titleLove').classList.toggle('hidden', !text);
}

function loveThanksText(count) {
    if (!Number.isFinite(count) || count <= 1) return 'Thanks for playing!';
    const others = count - 1;
    return `Thanks! You and ${others} ${others === 1 ? 'other' : 'others'} enjoyed this.`;
}

function showLoveSent(count) {
    const btn = $('loveBtn');
    btn.disabled = true;
    btn.classList.add('sent');
    $('loveLabel').textContent = 'Love sent';
    setLoveText(loveThanksText(count));
    $('creatorBlock').classList.remove('hidden');
}

// A small burst of hearts from the button's heart, plus a subtle bounce
function heartBurst(btn) {
    if (reducedMotion()) return;
    btn.animate([{ transform: 'scale(0.96)' }, { transform: 'scale(1.04)' }, { transform: 'scale(1)' }],
        { duration: 360, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    const origin = btn.querySelector('.love-heart');
    for (let i = 0; i < 7; i++) {
        const h = document.createElement('span');
        h.className = 'love-particle';
        h.textContent = '♥';
        h.setAttribute('aria-hidden', 'true');
        origin.appendChild(h);
        const angle = -Math.PI / 2 + (i - 3) * 0.42;
        const dist = 26 + (i % 3) * 7;
        h.animate([
            { transform: 'translate(-50%, -50%) scale(0.6)', opacity: 1 },
            { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px)) scale(1)`, opacity: 0 }
        ], { duration: 560 + (i % 2) * 80, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }).onfinish = () => h.remove();
    }
}

$('loveBtn').addEventListener('click', async () => {
    const btn = $('loveBtn');
    if (btn.disabled) return;
    btn.disabled = true;
    heartBurst(btn);
    sound.heart();
    love.remember();
    track('love_sent');
    const res = await apiCall(CONFIG.api.love, { method: 'POST' });
    const count = res && res.count != null ? Number(res.count) : (LOCAL_DEV ? MOCK_LOVE_COUNT + 1 : NaN);
    showLoveSent(count);
});

// Fill in the creator credit once; links without a URL stay hidden
function setupCreator() {
    const c = CONFIG.creator;
    document.querySelectorAll('[data-creator]').forEach(el => { el.textContent = c[el.dataset.creator] || ''; });
    const link = (id, url) => {
        const el = $(id);
        if (url) el.href = url; else el.classList.add('hidden');
    };
    link('creatorLinkedIn', c.linkedinUrl);
    link('creatorPortfolio', c.portfolioUrl);
    link('footerLinkedIn', c.linkedinUrl);
    if (!c.linkedinUrl) $('footerLinkedInWrap').classList.add('hidden');
    document.querySelectorAll('[data-cta]').forEach(el => el.addEventListener('click', () => {
        const target = el.dataset.cta;
        track('cta_click', { target });
        // keepalive: the request survives the new tab taking focus
        if (location.protocol !== 'file:') {
            fetch(CONFIG.api.ctaClick, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) }).catch(() => {});
        }
    }));
}
setupCreator();

// Called each time the end screen opens
async function showLoveSection() {
    const btn = $('loveBtn');
    btn.classList.remove('sent');
    if (!love.sent()) {
        btn.disabled = false;
        $('loveLabel').textContent = 'Send Wubby some love';
        setLoveText('');
        $('creatorBlock').classList.add('hidden');
        // Social proof before the tap: "♥ N players loved this"
        const text = lovedByText(await fetchLoveCount(true));
        if (!love.sent()) setLoveText(text);
        return;
    }
    showLoveSent(NaN);
    const count = await fetchLoveCount(true);
    if (Number.isFinite(count)) setLoveText(loveThanksText(count));
}
