# 🐶 Wubby's Treat Run

A short pixel platformer in vanilla JavaScript and HTML5 Canvas. A squirrel stole Wubby's treat!
Chase it through three hand-designed levels, catch the thief, and share your reward card.

## Run it

```bash
npx -y http-server -p 8000 -c-1
```

Then open `http://localhost:8000`. Opening `index.html` directly also plays, but downloading or sharing
the reward card needs the local server (browsers block reading back canvases drawn from `file://` images).

## Controls

- **← → / A D**: move
- **SPACE / ↑ / W**: jump. Hold for a higher jump, tap for a short hop.
- **ESC / P**: pause
- **M**: sound on/off
- **Touch devices**: on-screen ◀ ▶ ▲ buttons

## Gameplay

- 3 levels of about 45-60s each. Levels 1-2 end at a biscuit pedestal. Level 3 ends with a short
  chase: catch the thief to get the treat back.
- 3 hearts. A hit costs a heart and makes Wubby drop up to 5 bones. They scatter and can be picked
  up again for 3 seconds. Spikes and gaps send you back to the last checkpoint. Losing all hearts
  restarts the current level only.
- Bones: 25-30 per level, laid out as trails. Every 25 = +1 heart (max 5). Collect them all for
  "full belly ✓". Quick pickups play a rising note.
- Squirrels (the thief's gang): stomp from above. Touching them from the side costs a heart.
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
| `share.js` | Name validation, treat number, download/share/copy link |
| `analytics.js` | `track()` stub. Wire a provider in `analytics.send()` |
| `tools/check-levels.js` | Verifies every level with the jump arc from config and real physics |
| `art.js` | Loads the built art and draws atlas frames/animations |
| `public/assets/game/` | Built art: atlases + JSON, tiles, parallax layers, UI pieces + `ui.css`, `manifest.js` |
| `scripts/build_assets.py` | Builds `public/assets/game/` from `assets/raw/` (previews in `assets/preview/`) |

Progress (best time, most golden bones, completed) is saved in `localStorage`.

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
