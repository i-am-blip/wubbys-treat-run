// POST /api/cta-click { target: "linkedin" | "portfolio" } -> INCR cta:{target}, { count }
import { redis, json, underDailyLimit } from '../lib/store.mjs';

const TARGETS = ['linkedin', 'portfolio'];

export default async (req, context) => {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let target;
    try { ({ target } = await req.json()); } catch (e) { /* invalid body */ }
    if (!TARGETS.includes(target)) return json({ error: 'Unknown target' }, 400);
    if (!redis) return json({ count: null });
    try {
        // Generous limit: it only keeps one visitor from flooding the counter
        if (!(await underDailyLimit(req, context, 'cta', 20))) return json({ count: null, limited: true });
        const count = await redis.incr(`cta:${target}`);
        return json({ count });
    } catch (e) {
        console.error('cta-click', e);
        return json({ count: null });
    }
};

export const config = { path: '/api/cta-click' };
