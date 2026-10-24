# Setup: love counter, CTA clicks and notifications

The end screen has a "♥ Send Wubby some love" button and a creator block with LinkedIn and portfolio links.
Taps and clicks are counted by two serverless routes in `netlify/functions/`:

| Route | What it does |
|-------|--------------|
| `POST /api/love` | `INCR love:count`, returns `{ count }`. Max 3 per IP per day (over the limit it returns the count unchanged) |
| `GET /api/love` | Returns `{ count }` only |
| `POST /api/cta-click` `{ "target": "linkedin" \| "portfolio" }` | `INCR cta:{target}`, returns `{ count }` |

The browser also allows only one love per visitor (a `localStorage` flag). Raw IPs are never stored: the rate
limit keys use a salted SHA-256 hash of the IP and expire after two days.

**Without the env vars, everything still works.** The buttons, thanks message and creator block all show;
the routes answer `{ count: null }` and make no network calls. Locally (`http-server`) the routes don't exist,
so the page shows "Thanks for playing!".

## 1. Fill in the creator links

In `config.js`, set `CONFIG.creator.linkedinUrl` and `CONFIG.creator.portfolioUrl`. A link with an empty URL
is hidden.

## 2. Environment variables

Set these in Netlify under **Site configuration → Environment variables**, then redeploy:

| Variable | Required | Value |
|----------|----------|-------|
| `UPSTASH_REDIS_REST_URL` | for counting | REST URL of your Upstash database (`https://….upstash.io`) |
| `UPSTASH_REDIS_REST_TOKEN` | for counting | REST token of that database (also salts the IP hashes) |
| `LOVE_WEBHOOK_URL` | optional | A Discord webhook URL. Each love and CTA click posts a message to it |

## 3. Create the Upstash database

1. Sign in at [console.upstash.com](https://console.upstash.com) (the free tier is plenty).
2. **Create Database** → Redis. Pick a region close to your Netlify functions (for example `us-east-1`).
3. Open the database. In the **REST API** section, copy `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` into the Netlify environment variables.

To see the numbers at any time, open the database's **Data Browser** and look at `love:count`,
`cta:linkedin` and `cta:portfolio`.

## 4. Create a Discord webhook (optional)

1. In Discord, create a private server for yourself: **+** (Add a Server) → **Create My Own** → **For me and my friends**.
2. In a channel (for example `#wubby`), open **Edit Channel → Integrations → Webhooks → New Webhook**.
3. **Copy Webhook URL** and set it as `LOVE_WEBHOOK_URL` in Netlify.

You'll get messages like:

- `♥ Someone finished Wubby's Treat Run. Total: 12`
- `🔗 Someone clicked LinkedIn from the game. Total: 4`

Webhook failures are ignored and never slow down the player.

## 5. Deploy with functions

Netlify Drop (drag and drop) doesn't deploy functions. Use one of:

- **Git:** push the repo to GitHub and import it in Netlify (**Add new site → Import an existing project**).
  `netlify.toml` already sets the publish folder (`.`) and the functions folder, and Netlify installs
  `@upstash/redis` from `package.json`.
- **CLI:** `npx netlify-cli deploy --prod` from the project folder (it asks to link or create a site).

Check it: open `https://<your-site>/api/love`. It should return `{"count":0}` (or `{"count":null}` if the
Upstash variables are missing).
