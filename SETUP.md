# Setup: deploying on Vercel, love counter and link clicks

The game is a static site (`npm run build` → `dist/`) plus two serverless functions in `api/`:

| Route | What it does |
|-------|--------------|
| `GET /api/love` | `{ count }` (max 120 per IP per hour). Shown as "♥ N players loved this" on the title and end screens |
| `POST /api/love` | `INCR love:count` → `{ count }`. Max 3 per IP per day; over the limit the count comes back unchanged |
| `POST /api/cta-click` `{ "target": "linkedin" \| "portfolio" }` | `INCR cta:{target}` → `{ count }` (max 20 per IP per day) |

Other methods get 405, bodies over 1 KB 413, bad bodies 400, and errors a generic 500. Browsers on other sites
can't write (CORS allows only https://play.devmehtaa.in, https://www.devmehtaa.in and https://devmehtaa.in;
localhost too outside production). Rate limits use a salted SHA-256 of the IP; raw IPs are never stored.

Without Redis the routes answer `{ count: null }` and the game hides the count. Without `LOVE_HASH_SALT` nothing
is written.

## Environment variables

| Variable | Value |
|----------|-------|
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Upstash REST credentials, or the `KV_REST_API_URL` + `KV_REST_API_TOKEN` pair the Vercel Marketplace integration sets |
| `LOVE_HASH_SALT` | A random secret: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |

Redis: Vercel dashboard → the project → **Storage** → **Create Database** → **Upstash** (Marketplace, free plan)
→ connect it to the project. The `Data Browser` in Upstash shows `love:count`, `cta:linkedin` and `cta:portfolio`.

## Deploying

The project is connected to the GitHub repo, so pushing `main` deploys production and other branches get preview
URLs. `vercel.json` sets the build (`npm run build` → `dist/`), cache headers (hashed `/assets/*` immutable for a
year, HTML `no-cache`) and the security headers (CSP, nosniff, Referrer-Policy, Permissions-Policy, HSTS,
frame-ancestors for devmehtaa.in).

From the CLI: `npx vercel` (preview) and `npx vercel --prod` (production).
