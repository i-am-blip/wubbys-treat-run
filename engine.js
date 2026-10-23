// Pure game logic (no DOM): level parsing, tile collision, physics for Wubby, squirrels,
// the thief and dropped bones, plus jump-arc helpers. Shared by game.js and tools/check-levels.js.

const TILE = CONFIG.tileSize;

// Level tile legend — see levels/README.md
const LEGEND = {
    '.': 'empty',
    '#': 'ground',
    'o': 'bone',
    'G': 'golden bone',
    's': 'squirrel',
    '^': 'spike',
    'C': 'checkpoint',
    'P': 'player start',
    'E': 'biscuit pedestal (level exit)',
    'T': 'thief (final level: chase starts near here)',
    ',': 'plant decoration'
};

function parseLevel(def, index) {
    const height = def.sections[0].length;
    const rows = new Array(height).fill('');
    def.sections.forEach((section, s) => {
        if (section.length !== height) {
            throw new Error(`${def.name}: section ${s} has ${section.length} rows, expected ${height}`);
        }
        const width = section[0].length;
        section.forEach((row, r) => {
            if (row.length !== width) {
                throw new Error(`${def.name}: section ${s} row ${r} is ${row.length} wide, expected ${width}`);
            }
            rows[r] += row;
        });
    });

    const width = rows[0].length;
    const level = {
        index,
        name: def.name,
        theme: def.theme || 'garden',
        hints: def.hints || [],
        width,
        height,
        pixelWidth: width * TILE,
        pixelHeight: height * TILE,
        rows,
        solid: new Uint8Array(width * height),
        start: null,
        exit: null,
        thief: null,
        checkpoints: [],
        bones: [],
        goldens: [],
        squirrels: [],
        spikes: [],
        decorations: []
    };

    const p = CONFIG.player, sq = CONFIG.squirrel, th = CONFIG.thief;
    for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
            const ch = rows[r][c];
            const x = c * TILE, y = r * TILE;
            switch (ch) {
                case '.': break;
                case '#': level.solid[r * width + c] = 1; break;
                case 'o': level.bones.push({ x: x + TILE / 2, y: y + TILE / 2 }); break;
                case 'G': level.goldens.push({ x: x + TILE / 2, y: y + TILE / 2 }); break;
                case 's': level.squirrels.push({ x: x + (TILE - sq.width) / 2, y: y + TILE - sq.height }); break;
                case '^': level.spikes.push({ x, y, width: TILE, height: TILE }); break;
                case 'C': level.checkpoints.push({ x, y, width: TILE, height: TILE * 2, spawnX: x + TILE / 2 - p.width / 2, spawnY: y + TILE - p.height }); break;
                case 'P': level.start = { x: x + TILE / 2 - p.width / 2, y: y + TILE - p.height }; break;
                case 'E':
                    if (level.exit) throw new Error(`${def.name}: more than one exit 'E'`);
                    level.exit = { x, y: y - TILE, width: TILE, height: TILE * 2 };
                    break;
                case 'T':
                    if (level.thief) throw new Error(`${def.name}: more than one thief 'T'`);
                    level.thief = { x: x + (TILE - th.width) / 2, y: y + TILE - th.height };
                    break;
                case ',': level.decorations.push({ x, y }); break;
                default:
                    throw new Error(`${def.name}: unknown tile '${ch}' at column ${c}, row ${r}`);
            }
        }
    }
    if (!level.start) throw new Error(`${def.name}: missing player start 'P'`);
    if (!level.exit === !level.thief) throw new Error(`${def.name}: needs exactly one exit: 'E' (pedestal) or 'T' (thief chase)`);
    level.checkpoints.sort((a, b) => a.x - b.x);
    return level;
}

// A per-attempt copy whose tiles/spikes can change (quiet assist) without touching the original
function cloneLevel(level) {
    return { ...level, solid: level.solid.slice(), spikes: level.spikes.slice(), tileCanvas: null };
}

// Level edges are walls; above the level is open sky, below is a pit
function isSolid(level, c, r) {
    if (c < 0 || c >= level.width) return true;
    if (r < 0 || r >= level.height) return false;
    return level.solid[r * level.width + c] === 1;
}

const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

// Axis-separated movement against the tile grid. Moves are always < 1 tile per step.
function moveAndCollide(level, body, dx, dy) {
    const EPS = 0.001;
    body.x += dx;
    body.hitWall = false;
    const r0 = Math.floor(body.y / TILE), r1 = Math.floor((body.y + body.height - EPS) / TILE);
    if (dx > 0) {
        const c = Math.floor((body.x + body.width - EPS) / TILE);
        for (let r = r0; r <= r1; r++) if (isSolid(level, c, r)) { body.x = c * TILE - body.width; body.hitWall = true; break; }
    } else if (dx < 0) {
        const c = Math.floor(body.x / TILE);
        for (let r = r0; r <= r1; r++) if (isSolid(level, c, r)) { body.x = (c + 1) * TILE; body.hitWall = true; break; }
    }

    body.y += dy;
    body.onGround = false;
    const c0 = Math.floor(body.x / TILE), c1 = Math.floor((body.x + body.width - EPS) / TILE);
    if (dy > 0) {
        const r = Math.floor((body.y + body.height - EPS) / TILE);
        for (let c = c0; c <= c1; c++) {
            if (isSolid(level, c, r)) { body.y = r * TILE - body.height; body.vy = 0; body.onGround = true; break; }
        }
    } else if (dy < 0) {
        const r = Math.floor(body.y / TILE);
        for (let c = c0; c <= c1; c++) {
            if (isSolid(level, c, r)) { body.y = (r + 1) * TILE; body.vy = 0; break; }
        }
    }
}

function createPlayer(spawn) {
    return {
        x: spawn.x, y: spawn.y,
        width: CONFIG.player.width, height: CONFIG.player.height,
        vx: 0, vy: 0,
        onGround: false,
        facingRight: true,
        coyote: 0,
        jumpBuffer: 0,
        canCutJump: false,
        knockback: 0,
        invincible: 0,
        animTime: 0
    };
}

// input: { left, right, jumpPressed (this step only), jumpHeld }. Returns sound/event names.
function stepPlayer(level, p, input, dt) {
    const cfg = CONFIG.player;
    const events = [];

    if (p.knockback > 0) {
        p.knockback -= dt;
    } else {
        const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        p.vx = dir * cfg.moveSpeed;
        if (dir && p.onGround && p.lastDir && dir !== p.lastDir) events.push('skid');
        if (dir) { p.facingRight = dir > 0; p.lastDir = dir; }
    }
    const wasOnGround = p.onGround;
    const fallSpeed = p.vy;

    if (p.onGround) p.coyote = cfg.coyoteTime;
    else p.coyote -= dt;

    if (input.jumpPressed) p.jumpBuffer = cfg.jumpBufferTime;
    else p.jumpBuffer -= dt;

    if (p.jumpBuffer > 0 && p.coyote > 0) {
        p.vy = -cfg.jumpVelocity;
        p.coyote = 0; p.jumpBuffer = 0; p.canCutJump = true;
        events.push('jump');
    }

    // Variable height: letting go early cuts the rise
    if (!input.jumpHeld && p.canCutJump && p.vy < 0) {
        p.vy *= cfg.jumpCutMultiplier;
        p.canCutJump = false;
    }

    p.vy = Math.min(p.vy + cfg.gravity * dt, cfg.maxFallSpeed);
    if (p.vy >= 0) p.canCutJump = false;
    moveAndCollide(level, p, p.vx * dt, p.vy * dt);
    if (!wasOnGround && p.onGround && fallSpeed > 150) events.push('land');
    if (p.invincible > 0) p.invincible -= dt;
    p.animTime += dt;
    return events;
}

function createSquirrel(spawn) {
    return {
        x: spawn.x, y: spawn.y, width: CONFIG.squirrel.width, height: CONFIG.squirrel.height, dir: -1,
        state: 'walk', stateTime: 0, alerted: false, defeated: false, defeatTime: 0, animTime: 0
    };
}

// Patrols back and forth: at walls and ledges it pauses (idle), turns, and walks back.
// The first time Wubby comes close it startles (alert) for a moment.
function stepSquirrel(level, s, dt, player) {
    if (s.defeated) { s.defeatTime += dt; return; }
    const cfg = CONFIG.squirrel;
    s.animTime += dt;
    s.stateTime += dt;
    const set = (state) => { s.state = state; s.stateTime = 0; s.animTime = 0; };
    if (player && !s.alerted && Math.abs(player.x + player.width / 2 - (s.x + s.width / 2)) < cfg.alertDistance &&
        Math.abs(player.y + player.height - (s.y + s.height)) < TILE * 2) {
        s.alerted = true;
        set('alert');
    }
    if (s.state === 'alert') { if (s.stateTime > cfg.alertTime) set('walk'); return; }
    if (s.state === 'idle') { if (s.stateTime > cfg.idleTime) set('turn'); return; }
    if (s.state === 'turn') { if (s.stateTime > cfg.turnTime) { s.dir *= -1; set('walk'); } return; }
    const nx = s.x + s.dir * cfg.speed * dt;
    const aheadCol = Math.floor((s.dir > 0 ? nx + s.width : nx) / TILE);
    const bodyRow = Math.floor((s.y + s.height - 1) / TILE);
    const footRow = bodyRow + 1;
    if (isSolid(level, aheadCol, bodyRow) || !isSolid(level, aheadCol, footRow)) set('idle');
    else s.x = nx;
}

function createThief(spawn) {
    return {
        x: spawn.x, y: spawn.y, width: CONFIG.thief.width, height: CONFIG.thief.height,
        vx: 0, vy: 0, onGround: false, dir: 1, speed: CONFIG.thief.chaseSpeed, cornered: false, animTime: 0
    };
}

// The thief runs in t.dir, hopping gaps and steps automatically. Running right, it stops ("cornered") at the level's end wall.
function stepThief(level, t, dt) {
    t.animTime += dt;
    if (t.cornered) return;
    t.vx = t.dir * t.speed;
    if (t.onGround) {
        const aheadCol = Math.floor((t.dir > 0 ? t.x + t.width + 6 : t.x - 6) / TILE);
        const bodyRow = Math.floor((t.y + t.height - 1) / TILE);
        const inLevel = aheadCol >= 0 && aheadCol < level.width;
        const wallAhead = isSolid(level, aheadCol, bodyRow);
        const gapAhead = !isSolid(level, aheadCol, bodyRow + 1);
        if (inLevel && (wallAhead || gapAhead)) t.vy = -CONFIG.player.jumpVelocity;
    }
    t.vy = Math.min(t.vy + CONFIG.player.gravity * dt, CONFIG.player.maxFallSpeed);
    moveAndCollide(level, t, t.vx * dt, t.vy * dt);
    if (t.dir > 0 && t.hitWall && t.onGround && Math.floor((t.x + t.width + 1) / TILE) >= level.width) t.cornered = true;
    if (t.y > level.pixelHeight) {
        // Safety net: never lose the thief in a pit
        const spot = groundSpotNear(level, t.x + t.dir * TILE * 3, t.dir);
        if (spot) { t.x = spot.x; t.y = spot.y - t.height; t.vy = 0; }
    }
}

// Scattered bones: arc, bounce, slide to a stop
function stepDroppedBone(level, b, dt) {
    const cfg = CONFIG.droppedBones;
    b.age += dt;
    const fallingVy = b.vy;
    b.vy = Math.min(b.vy + CONFIG.player.gravity * dt, CONFIG.player.maxFallSpeed);
    moveAndCollide(level, b, b.vx * dt, b.vy * dt);
    if (b.hitWall) b.vx = -b.vx * cfg.bounce;
    if (b.onGround) {
        if (fallingVy > 60) b.vy = -fallingVy * cfg.bounce;
        b.vx *= Math.max(0, 1 - cfg.groundFriction * dt);
    }
}

function spikeHitbox(s) {
    const { inset, top } = CONFIG.spikeHitbox;
    return { x: s.x + inset, y: s.y + top, width: s.width - inset * 2, height: s.height - top };
}

function nearPoint(p, point, radius) {
    return Math.hypot(p.x + p.width / 2 - point.x, p.y + p.height / 2 - point.y) < radius;
}

// ---------- Surfaces & jump arcs (used by the quiet assist and tools/check-levels.js) ----------

function hasSpikeAt(level, c, r) {
    return level.spikes.some(s => s.x === c * TILE && s.y === r * TILE);
}

// A tile Wubby can stand on: solid, two free tiles of headroom, no spike on top
function isStandable(level, c, r) {
    return c >= 0 && c < level.width && isSolid(level, c, r) && !isSolid(level, c, r - 1) && !isSolid(level, c, r - 2) && !hasSpikeAt(level, c, r - 1);
}

// Horizontal runs of standable tiles: { row, c0, c1 }
function findSurfaces(level) {
    const out = [];
    for (let r = 0; r < level.height; r++) {
        let start = -1;
        for (let c = 0; c <= level.width; c++) {
            const ok = c < level.width && isStandable(level, c, r);
            if (ok && start < 0) start = c;
            if (!ok && start >= 0) { out.push({ row: r, c0: start, c1: c - 1 }); start = -1; }
        }
    }
    return out;
}

// Columns with nowhere safe to land (no standable tile at all)
function isHazardColumn(level, c) {
    for (let r = 0; r < level.height; r++) if (isStandable(level, c, r)) return false;
    return true;
}

// Nearest standable ground at or near pixel x, searching in direction dir (+1 right / -1 left)
function groundSpotNear(level, x, dir) {
    const startCol = Math.max(0, Math.min(level.width - 1, Math.floor(x / TILE)));
    for (let i = 0; i < level.width; i++) {
        const c = startCol + i * dir;
        if (c < 0 || c >= level.width) break;
        for (let r = 0; r < level.height; r++) {
            if (isStandable(level, c, r)) return { x: c * TILE, y: r * TILE, col: c, row: r };
        }
    }
    return null;
}

// Feet positions of a full-speed jump (or walk-off when jump=false) in open air, relative to take-off.
// dy is positive upward. Uses stepPlayer itself, so it always matches the real physics.
function jumpArc({ jump = true, holdJump = true, dir = 1, maxSteps = 240 } = {}) {
    const open = { width: 1e9, height: 1e9, solid: {} };
    const origin = 5e8; // far from the level edges, which count as walls
    const p = createPlayer({ x: origin, y: origin });
    p.onGround = jump;
    p.coyote = 0;
    const out = [];
    for (let i = 0; i < maxSteps; i++) {
        stepPlayer(open, p, { left: dir < 0, right: dir > 0, jumpPressed: jump && i === 0, jumpHeld: jump && holdJump }, CONFIG.fixedStep);
        const dy = origin - p.y;
        out.push({ dx: Math.abs(p.x - origin), dy, vy: p.vy });
        if (dy < -TILE * 12) break;
    }
    return out;
}

function formatTime(ms, decimals = 2) {
    if (ms == null || !Number.isFinite(ms)) return '--:--';
    const totalCs = Math.floor(ms / 10);
    const m = Math.floor(totalCs / 6000);
    const s = Math.floor(totalCs / 100) % 60;
    const frac = String(totalCs % 100).padStart(2, '0').slice(0, decimals);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${decimals ? '.' + frac : ''}`;
}
