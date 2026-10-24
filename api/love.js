// GET  /api/love -> { count }                       (max 120 per IP per hour)
// POST /api/love -> INCR love:count, { count }       (max 3 per IP per day; over it, the count comes back unchanged)
const { redis, salt, send, gate, underLimit } = require('./_lib/store');

module.exports = async function love(req, res) {
    if (!gate(req, res, ['GET', 'POST'])) return;
    if (!redis) return send(res, 200, { count: null });
    try {
        const current = async () => Number(await redis.get('love:count')) || 0;
        if (req.method === 'GET') {
            if (salt && !(await underLimit(req, 'love-get', 120, 3600))) return send(res, 429, { error: 'Too many requests' });
            return send(res, 200, { count: await current() });
        }
        if (!salt) {
            console.warn('love: LOVE_HASH_SALT is not set, not counting');
            return send(res, 200, { count: await current() });
        }
        if (!(await underLimit(req, 'love', 3, 86400))) return send(res, 200, { count: await current(), limited: true });
        return send(res, 200, { count: await redis.incr('love:count') });
    } catch (e) {
        console.error('love', e && e.message);
        return send(res, 500, { error: 'Something went wrong' });
    }
};
