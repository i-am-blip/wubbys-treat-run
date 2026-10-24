// POST /api/cta-click { "target": "linkedin" | "portfolio" } -> INCR cta:{target}, { count }  (max 20 per IP per day)
const { redis, salt, send, gate, readJson, underLimit } = require('./_lib/store');

const TARGETS = ['linkedin', 'portfolio'];

module.exports = async function ctaClick(req, res) {
    if (!gate(req, res, ['POST'])) return;
    const body = await readJson(req);
    const target = body && body.target;
    if (typeof target !== 'string' || !TARGETS.includes(target)) return send(res, 400, { error: 'Bad request' });
    if (!redis) return send(res, 200, { count: null });
    if (!salt) {
        console.warn('cta-click: LOVE_HASH_SALT is not set, not counting');
        return send(res, 200, { count: null });
    }
    try {
        if (!(await underLimit(req, 'cta', 20, 86400))) return send(res, 200, { count: null, limited: true });
        return send(res, 200, { count: await redis.incr(`cta:${target}`) });
    } catch (e) {
        console.error('cta-click', e && e.message);
        return send(res, 500, { error: 'Something went wrong' });
    }
};
