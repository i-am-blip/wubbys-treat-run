# Editing levels

Each level is a plain-text tile map in `levels/levelN.js`. Every character is one 18×18 tile.
The map is split into **sections** (columns side by side) so it stays readable. The game
joins all the sections left-to-right into one map.

```js
(window.LEVELS = window.LEVELS || []).push({
    name: "Backyard Garden",
    theme: "garden",   // tiles, props and parallax: garden | rooftops | kitchen
    hints: [ { col: 20, row: 4, text: "SPACE / UP / W TO JUMP" },
             { col: 208, row: 9, text: "ouch, thorns!", fade: true } ],  // fade: centred, fades once passed
    sections: [
        [   // 16 rows; every row in a section must be the same width
            '................',
            ...
            '..P..o.o.o......',
            '################'
        ],
        [ ... next section ... ]
    ]
});
```

## Legend

| Char | Meaning |
|------|---------|
| `.` | empty sky |
| `#` | ground (grass is drawn automatically on exposed tops) |
| `o` | bone. Aim for 25-30 per level, placed as trails (see below) |
| `G` | golden bone. Exactly 3 per level, off the main path |
| `s` | squirrel. Put it on the tile just above the ground. It walks back and forth, turning at walls and ledges |
| `^` | hazard (thorns, broken tiles, forks... drawn from the level's theme). Put it on top of the ground. Touching it costs a heart and respawns Wubby at the checkpoint |
| `C` | checkpoint flag. Put it just above the ground |
| `P` | Wubby's start position (exactly one) |
| `E` | biscuit pedestal = level exit (every level except the last) |
| `T` | the thief (last level only). The chase starts when Wubby gets within `thief.triggerDistance`. The thief then runs right to the end of the map, hopping gaps of up to 2 tiles and steps of up to 2 tiles |
| `,` | prop decoration from the level's theme (no collision; the prop is picked per column) |

Falling below the bottom row is a gap: it costs a heart and respawns Wubby at the last checkpoint.
(During the thief chase it costs nothing. Wubby reappears just behind the thief.)

## Jump limits (one full jump, default physics in `config.js`)

A full jump is about **3.9 tiles high** and **4.7 tiles far**. To keep jumps comfortable, use these limits:

| Jump | Max gap |
|------|---------|
| same height | 3 tiles |
| 1 tile up | 3 tiles |
| 2-3 tiles up | 2 tiles |
| any drop | 4 tiles |

- Leave **at least 2 empty rows** under floating platforms Wubby can walk beneath.
- All sections in a level need the same number of rows (16). Sections can have different widths.
- About 250 columns gives 45-60s at normal pace.

## Bone trails

Bones should guide the player, not clutter the level:
- **Arcs over gaps**: put a bone 3 rows above the ground in each gap column, so the trail traces the jump.
- **Lines** on safe ground lead the way forward.
- **Pointers**: put one or two bones on the way up toward each golden bone.

Collecting every bone in a level gives "full belly ✓".

## Check your level

```bash
node tools/check-levels.js          # full check (about 2s)
node tools/check-levels.js --fast   # skip the physics search
```

The checker does three things:
- It simulates the max jump arc from `config.js` and confirms that the exit (or thief) and every golden bone can be reached, landing at least one tile past each edge and clearing heights by at least half a tile.
- It runs a search with the real physics.
- It simulates the thief through the chase.

It also checks the bone count, the golden bones and the checkpoint. If something fails, it names the furthest spot it could reach comfortably.

## Adding or reordering levels

Levels play in the order their `<script>` tags appear in `index.html`. To add a level, create
`levels/level4.js` and add `<script src="levels/level4.js"></script>` before `rewardCard.js`.
Only the last level should have `T`. Every other level ends with `E`.

If a map has a mistake (an unknown character, uneven rows, a missing `P` or exit), the title screen
shows the error and the Play button is disabled.
