// GET /api/love  -> { count }
// POST /api/love -> INCR love:count, { count }. Max 3 per IP per day; over the limit it returns the count unchanged.
import { redis, json, underDailyLimit } from '../lib/store.mjs';

export default async (req, context) => {
    if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!redis) return json({ count: null });
    try {
        if (req.method === 'GET') return json({ count: Number(await redis.get('love:count')) || 0 });
        if (!(await underDailyLimit(req, context, 'love', 3))) {
            return json({ count: Number(await redis.get('love:count')) || 0, limited: true });
        }
        const count = await redis.incr('love:count');
        return json({ count });
    } catch (e) {
        console.error('love', e);
        return json({ count: null });
    }
};

export const config = { path: '/api/love' };
