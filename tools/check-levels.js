// Level checker. Usage: node tools/check-levels.js [--fast]
//
// 1. Data checks: bone count, 3 golden bones, checkpoint, exit/thief placement.
// 2. Jump-arc check: simulates the max single jump from config.js and builds a graph of the
//    surfaces Wubby can reach WITH COMFORTABLE MARGINS (land >= 1 tile past the edge, clear
//    heights by >= half a tile). The exit (or thief) and every golden bone must be in it.
// 3. Physics search (skipped with --fast): A* over real inputs with engine.js, proving the
//    exit and golden bones are reachable, and simulating the thief through the chase.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const fast = process.argv.includes('--fast');

const sandbox = { console, Math };
sandbox.window = sandbox;
vm.createContext(sandbox);
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const levelFiles = [...html.matchAll(/<script src="(levels\/[^"]+)"/g)].map(m => m[1]);
for (const f of ['config.js', 'engine.js', ...levelFiles]) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
const E = vm.runInContext(`({ CONFIG, parseLevel, createPlayer, stepPlayer, overlaps, spikeHitbox, nearPoint,
    findSurfaces, jumpArc, createThief, stepThief })`, sandbox);
const { CONFIG } = E;
const T = CONFIG.tileSize;
const PW = CONFIG.player.width, PH = CONFIG.player.height;

const MARGIN_X = T;       // must land at least one tile past the near edge of the target
const MARGIN_Y = T / 2;   // must clear target heights by half a tile
const BONES = [25, 30];

// ---------- Max jump arc (from config, via the real stepPlayer) ----------
const ARC = E.jumpArc({ jump: true, holdJump: true });
const FALL = E.jumpArc({ jump: false });
const PEAK = Math.max(...ARC.map(s => s.dy));

// Horizontal distance covered when the feet come back down to `rise` (px above take-off) during descent
function landingReach(arc, rise) {
    for (let i = 1; i < arc.length; i++) {
        if (arc[i].vy > 0 && arc[i - 1].dy >= rise && arc[i].dy < rise) return arc[i].dx;
    }
    return -1;
}
// Height of the feet when the arc has covered dx horizontally
function heightAt(arc, dx) {
    for (const s of arc) if (s.dx >= dx) return s.dy;
    return -Infinity;
}

// Can Wubby get from surface A to surface B with comfortable margins?
function canReach(A, B) {
    const rise = (A.row - B.row) * T; // px, positive = B is higher
    if (rise > 0 && PEAK < rise + MARGIN_Y) return false;
    const aL = A.c0 * T, aR = (A.c1 + 1) * T, bL = B.c0 * T, bR = (B.c1 + 1) * T;
    const arcs = rise >= 0 ? [ARC] : [ARC, FALL];

    // Take off from somewhere on A (up to its width), clear B's near edge, land >= MARGIN_X inside B
    const jumpAcross = (arc, gap) => {
        const reach = landingReach(arc, rise);
        if (reach < 0) return false;
        let offset = 0; // how far before A's edge Wubby takes off
        if (rise > 0) {
            const clear = arc.find(s => s.dy >= rise);
            if (!clear) return false;
            offset = Math.max(0, clear.dx - gap);
        }
        return offset <= (aR - aL) - PW && reach >= gap + offset + MARGIN_X;
    };
    for (const arc of arcs) {
        if (bL >= aR && jumpAcross(arc, bL - aR)) return true; // B to the right
        if (bR <= aL && jumpAcross(arc, aL - bR)) return true; // B to the left (mirror)
    }
    // Overlapping horizontally: B above A -> jump up beside B's edge (needs run-up room on A)
    if (rise > 0 && bL < aR && bR > aL) {
        const clearAt = ARC.find(s => s.dy >= rise + MARGIN_Y && s.vy < 0);
        if (!clearAt) return false;
        const runUp = clearAt.dx + PW;
        if (bL - aL >= runUp || aR - bR >= runUp) return true;
    }
    // Overlapping, B below A: walk off A's edge onto B
    if (rise < 0 && bL < aR && bR > aL && (bR > aR || bL < aL)) return true;
    return false;
}

function surfaceUnder(surfaces, x, y) {
    const c = Math.floor(x / T), feetRow = Math.ceil((y - 1) / T);
    return surfaces.filter(s => c >= s.c0 && c <= s.c1 && s.row >= feetRow).sort((a, b) => a.row - b.row)[0];
}

// Golden bone collectible from surface S: Wubby's center reaches it with margin
function canCollectFrom(S, g) {
    const top = S.row * T;
    const xOk = g.x >= S.c0 * T - T && g.x <= (S.c1 + 1) * T + T;
    const centerStanding = top - PH / 2;
    const highest = centerStanding - (PEAK - MARGIN_Y);
    return xOk && g.y < top && g.y >= highest - CONFIG.pickupRadius / 2;
}

function arcCheck(level) {
    const surfaces = E.findSurfaces(level);
    const start = surfaceUnder(surfaces, level.start.x + PW / 2, level.start.y + PH);
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
        const a = queue.shift();
        for (const b of surfaces) if (!seen.has(b) && canReach(a, b)) { seen.add(b); queue.push(b); }
    }
    const issues = [];
    const goal = level.exit || level.thief;
    const goalSurface = surfaceUnder(surfaces, goal.x + T / 2, goal.y + (level.exit ? T * 2 : CONFIG.thief.height));
    if (!goalSurface || !seen.has(goalSurface)) {
        const furthest = [...seen].reduce((m, s) => (s.c1 > m.c1 ? s : m), start);
        issues.push(`${level.exit ? 'exit' : 'thief'} not reachable with margins; furthest comfortable surface ends at col ${furthest.c1} row ${furthest.row}`);
    }
    level.goldens.forEach(g => {
        const ok = [...seen].some(s => canCollectFrom(s, g));
        if (!ok) issues.push(`golden bone at col ${Math.floor(g.x / T)} row ${Math.floor(g.y / T)} not reachable with margins`);
    });
    return issues;
}

// ---------- Physics search (weighted A* over 0.1s input chunks) ----------
function physicsSearch(level, startPos, isGoal, goalPoint) {
    const DT = CONFIG.fixedStep, CHUNK = 6;
    const actions = [];
    for (const d of [1, 0, -1]) for (const j of ['release', 'press', 'hold']) actions.push({ d, j });
    const key = p => `${Math.round(p.x / 3)},${Math.round(p.y / 3)},${Math.round(p.vy / 60)},${p.onGround ? 1 : 0},${p.canCutJump ? 1 : 0}`;
    const h = p => Math.hypot(p.x + PW / 2 - goalPoint.x, p.y + PH / 2 - goalPoint.y) / CONFIG.player.moveSpeed;
    const heap = [];
    const push = n => { heap.push(n); let i = heap.length - 1; while (i > 0) { const q = (i - 1) >> 1; if (heap[q].f <= n.f) break; heap[i] = heap[q]; i = q; } heap[i] = n; };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = -1, best = last.f; if (l < heap.length && heap[l].f < best) { m = l; best = heap[l].f; } if (r < heap.length && heap[r].f < best) m = r; if (m < 0) break; heap[i] = heap[m]; i = m; } heap[i] = last; } return top; };
    const start = E.createPlayer(startPos);
    const seen = new Set([key(start)]);
    push({ p: start, g: 0, f: 3 * h(start) });
    while (heap.length) {
        const { p: s, g } = pop();
        for (const a of actions) {
            const p = { ...s };
            let dead = false, won = false;
            for (let i = 0; i < CHUNK && !dead && !won; i++) {
                E.stepPlayer(level, p, { left: a.d < 0, right: a.d > 0, jumpPressed: a.j === 'press' && i === 0, jumpHeld: a.j !== 'release' }, DT);
                if (p.y > level.pixelHeight + CONFIG.fallMargin) dead = true;
                else if (level.spikes.some(sp => E.overlaps(p, E.spikeHitbox(sp)))) dead = true;
                else if (isGoal(p)) won = true;
            }
            const ng = g + CHUNK * DT;
            if (won) return ng;
            if (dead) continue;
            const k = key(p);
            if (seen.has(k)) continue;
            seen.add(k);
            push({ p, g: ng, f: ng + 3 * h(p) });
        }
        if (seen.size > 3e6) return -1;
    }
    return null;
}

function physicsCheck(level) {
    const issues = [];
    const times = [];
    const goal = level.exit || { x: level.thief.x - CONFIG.thief.triggerDistance, y: level.thief.y - T, width: T, height: T * 2 };
    const tExit = physicsSearch(level, level.start, p => E.overlaps(p, goal), { x: goal.x + T / 2, y: goal.y + T });
    if (tExit == null || tExit < 0) issues.push(`${level.exit ? 'exit' : 'chase start'} unreachable with real physics`);
    times.push(tExit);
    level.goldens.forEach(g => {
        const spawns = [level.start, ...level.checkpoints.map(c => ({ x: c.spawnX, y: c.spawnY }))].filter(s => s.x < g.x);
        const t = physicsSearch(level, spawns[spawns.length - 1] || level.start, p => E.nearPoint(p, g, CONFIG.pickupRadius), g);
        if (t == null || t < 0) issues.push(`golden at col ${Math.floor(g.x / T)} unreachable with real physics`);
        times.push(t);
    });
    if (level.thief) {
        // The thief must make it from its tile to the end wall without falling
        const thief = E.createThief(level.thief);
        let fell = false, t = 0;
        for (; t < 60 && !thief.cornered; t += CONFIG.fixedStep) {
            const y0 = thief.y;
            E.stepThief(level, thief, CONFIG.fixedStep);
            if (thief.y < y0 - T * 6) fell = true; // teleported by the safety net
        }
        if (fell || !thief.cornered) issues.push('thief does not reach the end wall cleanly');
        times.push(t);
    }
    return { issues, times };
}

// ---------- Run ----------
let failed = false;
let totalGoldens = 0;
console.log(`Max jump from config: ${(PEAK / T).toFixed(2)} tiles high, ${(landingReach(ARC, 0) / T).toFixed(2)} tiles far (margins: ${MARGIN_X / T} tile landing, ${MARGIN_Y / T} tile height)`);
sandbox.LEVELS.forEach((def, i) => {
    const level = E.parseLevel(def, i);
    const last = i === sandbox.LEVELS.length - 1;
    const issues = [];
    totalGoldens += level.goldens.length;
    if (level.bones.length < BONES[0] || level.bones.length > BONES[1]) issues.push(`${level.bones.length} bones (target ${BONES[0]}-${BONES[1]})`);
    if (level.goldens.length !== 3) issues.push(`${level.goldens.length} golden bones (expected 3)`);
    if (level.checkpoints.length < 1) issues.push('no checkpoint');
    if (last && !level.thief) issues.push("last level needs the thief 'T'");
    if (!last && !level.exit) issues.push("needs a pedestal 'E'");
    issues.push(...arcCheck(level));
    let timing = '';
    if (!fast) {
        const r = physicsCheck(level);
        issues.push(...r.issues);
        const [tExit, ...rest] = r.times;
        timing = `, fastest ${level.exit ? 'exit' : 'chase start'} ${tExit?.toFixed(1)}s` + (level.thief ? `, thief run ${rest.pop()?.toFixed(1)}s` : '');
    }
    console.log(`${issues.length ? 'FAIL' : 'ok  '} ${level.name}: ${level.width} cols, ${level.bones.length} bones, ${level.squirrels.length} squirrels, ${level.spikes.length} spikes${timing}`);
    issues.forEach(m => console.log('       - ' + m));
    if (issues.length) failed = true;
});
if (totalGoldens !== 9) { console.log(`FAIL total golden bones ${totalGoldens} (expected 9)`); failed = true; }
console.log(failed ? 'LEVEL CHECK FAILED' : 'ALL LEVELS OK');
process.exit(failed ? 1 : 0);
