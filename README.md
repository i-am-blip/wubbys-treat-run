# 🐶 Wubby's Treat Run

A short pixel platformer in vanilla JavaScript and HTML5 Canvas. A squirrel stole Wubby's treat!
Chase it through three hand-designed levels, catch the thief, and copy your reward polaroid.

## Run it

```bash
npx -y http-server . -p 8000 -c-1
```

The `.` matters: without it, http-server serves the `public/` folder instead of the game.

Then open `http://localhost:8000`. Opening `index.html` directly also plays, but copying the reward
polaroid needs the local server (browsers block reading back canvases drawn from `file://` images).

## Controls

- **← → / A D**: move
- **SPACE / ↑ / W**: jump. Hold for a higher jump, tap for a short hop.
- **ESC / P**: pause
- **M**: sound on/off
- **Touch devices**: on-screen ◀ ▶ ▲ buttons
- **Enter / Space** on the title screen: play

Level 1 shows a short controls hint that fades once you've moved and jumped; Esc and M are listed in the pause menu.

## Gameplay

- 3 levels of about 45-60s each. Levels 1-2 end at a biscuit pedestal. Level 3 ends with a short
  chase: catch the thief to get the treat back.
- 3 hearts. A hit costs a heart and makes Wubby drop up to 5 bones. They scatter and can be picked
  up again for 3 seconds. Spikes and gaps send you back to the last checkpoint. Losing all hearts
  restarts the current level only.
- Bones: 25-30 per level, laid out as trails. Every 25 = +1 heart (max 5). Collect them all for
  "full belly ✓". Quick pickups play a rising note.
- Squirrels (the thief's gang): stomp from above. Touching them from the side costs a heart.
- Readability rule: crisp + outlined + saturated = interactive (Wubby, squirrels, hazards, bones, flags,
  pedestal, walkable tiles); soft + hazy = scenery (props and the parallax background).
- Hazards (thorns, stakes, broken tiles, aerials, forks, burners) have a red (#D9483B) outline that pulses
  with their 2 frames, over a faint red glow. Red is only used for things that hurt.
- Gaps show the background. Falling in costs a heart and respawns you at the last checkpoint.
- 3 hidden golden bones per level (9 total). Find them all for a gold-bordered card with a crown.
- The game quietly helps if you keep dying in the same spot.

## Files

| File | Purpose |
|------|---------|
| `config.js` | All tunables: physics, hearts, bones, dropped bones, assist, thief |
| `engine.js` | Pure logic: level parsing, tile collision, Wubby/squirrel/thief/bone physics, jump arcs |
| `levels/` | Level tile maps. See [levels/README.md](levels/README.md) |
| `game.js` | Screens, game state, intro, chase, end scene, rendering, HUD, save data |
| `rewardCard.js` | The reward card image: `renderRewardCard(data, art)` → canvas |
| `share.js` | Name validation, treat number, polaroid PNG (copy / download fallback) |
| `love.js` | End screen: "Send Wubby some love" and the creator credit (`CONFIG.creator`) |
| `netlify/` | API routes `/api/love` and `/api/cta-click` (Upstash Redis). See [SETUP.md](SETUP.md) |
| `analytics.js` | `track()` stub. Wire a provider in `analytics.send()` |
| `tools/check-levels.js` | Verifies every level with the jump arc from config and real physics |
| `art.js` | Loads the built art and draws atlas frames/animations |
| `public/assets/game/` | Built art: atlases + JSON, tiles, parallax layers, UI pieces + `ui.css`, `manifest.js` |
| `scripts/build_assets.py` | Builds `public/assets/game/` from `assets/raw/` (previews in `assets/preview/`) |

Progress (best time, most golden bones, completed) is saved in `localStorage`.

The end screen: the polaroid, a name field, **Copy image** (falls back to a download where browsers can't copy
images) and **Play again**, then "Send Wubby some love" and the creator credit. Run time and golden bones are
still tracked and saved, just not shown there. To count loves and link clicks, see [SETUP.md](SETUP.md).

The reward image is just the polaroid (1080×1350). Set `CONFIG.card.siteUrl` in `config.js` to the production
URL; it is printed on the polaroid and used in share links (localhost/file URLs are never shown).

## Art pipeline

The final art lives in `assets/raw/` (green-screen sheets). To rebuild the game assets:

```bash
py -3.12 -m venv .venv
.venv/Scripts/python -m pip install pillow numpy
.venv/Scripts/python scripts/build_assets.py
```

Check the labeled contact sheets in `assets/preview/` after a rebuild. Frame maps, target sizes,
tile roles and background layouts are set at the top of the script.

## License

Game code is free to use.
