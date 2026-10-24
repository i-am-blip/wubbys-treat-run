// Shared helpers for the API routes: Upstash Redis, per-IP rate limiting, Discord notifications.
// Without UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN every route still answers, with { count: null },
// and makes no network calls.
import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';

const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = process.env;
// One quick retry at most: the end screen waits on this answer
export const redis = url && token ? new Redis({ url, token, retry: { retries: 1, backoff: () => 200 } }) : null;

export const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

// True while this IP has used fewer than `limit` calls today. Only a salted SHA-256 of the IP is stored
// (salted with the Redis token, so the hash can't be reversed with a lookup table); raw IPs never are.
export async function underDailyLimit(req, context, name, limit) {
    const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'unknown';
    const hash = createHash('sha256').update(`${token}|${ip}`).digest('hex').slice(0, 32);
    const day = new Date().toISOString().slice(0, 10);
    const key = `rl:${name}:${day}:${hash}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 60 * 60 * 48);
    return n <= limit;
}

// Posts a Discord-format message to LOVE_WEBHOOK_URL, if set. Never throws and never delays the response:
// it runs after the response when the platform supports waitUntil, and gives up after 3s otherwise.
export function notify(context, content) {
    const hook = process.env.LOVE_WEBHOOK_URL;
    if (!hook) return;
    const send = fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(3000)
    }).catch(() => {});
    if (context && typeof context.waitUntil === 'function') context.waitUntil(send);
    else return send;
}
