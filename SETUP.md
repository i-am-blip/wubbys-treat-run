# Setup: love counter and CTA clicks

Wubby's Treat Run counts two things in Upstash Redis, through serverless routes in `netlify/functions/`:

| Route | What it does |
|-------|--------------|
| `POST /api/love` | `INCR love:count`, returns `{ count }`. Max 3 per IP per day (over the limit it returns the count unchanged) |
| `GET /api/love` | Returns `{ count }`. Shown to players as "♥ N players loved this" on the title and end screens |
| `POST /api/cta-click` `{ "target": "linkedin" \| "portfolio" }` | `INCR cta:{target}`, returns `{ count }` |

The browser also allows one love per visitor (a `localStorage` flag). Raw IPs are never stored: rate-limit keys
use a salted SHA-256 hash of the IP and expire after two days.

Without the env vars everything still works: the routes answer `{ count: null }`, make no network calls, and
the love count simply isn't shown.

## Environment variables (Netlify)

Set these under **Site configuration → Environment variables**, then redeploy:

| Variable | Value |
|----------|-------|
| `UPSTASH_REDIS_REST_URL` | REST URL of your Upstash database (`https://….upstash.io`) |
| `UPSTASH_REDIS_REST_TOKEN` | REST token of that database (also salts the IP hashes) |

To get them: sign in at [console.upstash.com](https://console.upstash.com), **Create Database** (Redis, free tier,
a region near your Netlify functions such as `us-east-1`), then copy both values from its **REST API** section.
The **Data Browser** there shows `love:count`, `cta:linkedin` and `cta:portfolio` at any time.

## Deploying the functions

Netlify Drop (drag and drop) doesn't deploy functions. Deploy from **Git** (import the GitHub repo in Netlify;
`netlify.toml` sets the publish and functions folders, and Netlify installs `@upstash/redis` from
`package.json`) or with the **Netlify CLI** (`npx netlify-cli deploy --prod` from the project folder).

Check it: `https://<your-site>/api/love` should return `{"count":0}`, or `{"count":null}` without the env vars.
