# 🚀 Deploying Wubby's Treat Run

Since `node`, `npm`, and `git` are not detected in your terminal, the easiest way to deploy your game is using **Drag & Drop** services.

> The love counter and CTA tracking need Netlify Functions, which Netlify Drop doesn't deploy.
> To use them, deploy from Git or the Netlify CLI instead: see [SETUP.md](SETUP.md).

## Option 1: Netlify Drop (Recommended)
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop).
2. Locate your project folder:
   `D:\My Work\AI Exploration\wubbys-treat-run`
3. Drag the entire **"wubbys-treat-run"** folder onto the Netlify drop zone.
4. Netlify will deploy it instantly and give you a public URL (e.g., `fluffy-unicorn-123456.netlify.app`).

## Option 2: Surge.sh (Requires Node/NPM)
If you install Node.js later:
1. Open terminal in this folder.
2. Run `npx surge`.
3. Follow the prompts to create an account and pick a domain.

## Files to Deploy
Ensure these files are in the folder you upload:
- `index.html` (The entry point)
- `style.css`
- `game.js`
- `public/assets/game/` (built art, see `scripts/build_assets.py`)
- `*.js` game scripts and `levels/`
