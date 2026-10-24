// Shared helpers for the API routes (Vercel serverless functions): Upstash Redis, per-IP rate limiting, CORS,
// method / body checks and JSON responses. Files under api/_lib are not routes.
//
// Env: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or KV_REST_API_URL + KV_REST_API_TOKEN (what the Vercel
// Marketplace integration sets), and LOVE_HASH_SALT (random secret for the IP hashes). Without Redis every route
// still answers with { count: null } and makes no network calls; without the salt nothing is written.
const { createHash } = require('node:crypto');
const { Redis } = require('@upstash/redis');

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const salt = process.env.LOVE_HASH_SALT || '';

// One quick retry at most: the end screen waits on these answers
const redis = url && token ? new Redis({ url, token, retry: { retries: 1, backoff: () => 200 } }) : null;

const MAX_BODY = 1024;
const PROD_ORIGINS = ['https://play.devmehtaa.in', 'https://www.devmehtaa.in', 'https://devmehtaa.in'];
const isProd = process.env.VERCEL_ENV === 'production';

function allowedOrigin(origin) {
    if (!origin) return null;
    if (PROD_ORIGINS.includes(origin)) return origin;
    if (!isProd && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
    // Preview deployments call themselves; same-origin requests send Origin too
    if (!isProd && process.env.VERCEL_URL && origin === `https://${process.env.VERCEL_URL}`) return origin;
    return null;
}

function send(res, status, body, headers = {}) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(JSON.stringify(body));
}

// CORS + method gate. Returns false when the request was already answered (preflight, 403, 405).
function gate(req, res, methods) {
    const origin = req.headers.origin;
    const allowed = allowedOrigin(origin);
    res.setHeader('Vary', 'Origin');
    if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', allowed);
        res.setHeader('Access-Control-Allow-Methods', [...methods, 'OPTIONS'].join(', '));
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
        res.statusCode = allowed ? 204 : 403;
        res.end();
        return false;
    }
    if (!methods.includes(req.method)) {
        send(res, 405, { error: 'Method not allowed' }, { Allow: [...methods, 'OPTIONS'].join(', ') });
        return false;
    }
    if (+req.headers['content-length'] > MAX_BODY) {
        send(res, 413, { error: 'Payload too large' });
        return false;
    }
    // A browser on another site may not write to the counters
    if (req.method !== 'GET' && origin && !allowed) {
        send(res, 403, { error: 'Forbidden' });
        return false;
    }
    return true;
}

// The JSON body, capped at 1 KB; null when it's missing, too big or not an object
async function readJson(req) {
    if (req.body !== undefined && req.body !== null && typeof req.body !== 'string') {
        // Vercel already parsed it; still enforce the size cap from the header
        if (+req.headers['content-length'] > MAX_BODY) return null;
        return typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    }
    let raw = typeof req.body === 'string' ? req.body : '';
    if (!raw && req.readable) {
        for await (const chunk of req) {
            raw += chunk;
            if (raw.length > MAX_BODY) return null;
        }
    }
    if (raw.length > MAX_BODY) return null;
    try {
        const v = JSON.parse(raw || 'null');
        return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch (e) {
        return null;
    }
}

function clientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    return (req.headers['x-real-ip'] || (fwd && String(fwd).split(',')[0]) || req.socket?.remoteAddress || 'unknown').trim();
}

// True while this IP has used fewer than `limit` calls in the window. Only a salted SHA-256 of the IP is stored
// (the key expires with the window); raw IPs never are.
async function underLimit(req, name, limit, windowSeconds) {
    const hash = createHash('sha256').update(`${salt}|${clientIp(req)}`).digest('hex').slice(0, 32);
    const slot = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `rl:${name}:${slot}:${hash}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowSeconds * 2);
    return n <= limit;
}

module.exports = { redis, salt, send, gate, readJson, underLimit };
