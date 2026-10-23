// Wubby's Treat Run — screens, game state, rendering and UI.
// Physics and level parsing live in engine.js; tunables in config.js; levels in levels/;
// art loading/drawing in art.js; the reward card image in rewardCard.js; sharing helpers in share.js.

const T = CONFIG.tileSize;
const $ = (id) => document.getElementById(id);

// Bone states within a level
const BONE = { AVAILABLE: 0, HELD: 1, DROPPED: 2, LOST: 3 };
const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24]; // semitones
const PIXEL_FONT = "'Pixelify Sans', sans-serif";

// ---------- Save (localStorage can throw in private mode, so everything is guarded) ----------
const save = (() => {
    const defaults = { bestTime: null, maxGoldens: 0, completed: false, muted: false };
    let data = { ...defaults };
    try { data = { ...defaults, ...JSON.parse(localStorage.getItem(CONFIG.storageKey) || '{}') }; } catch (e) { /* fresh save */ }
    return {
        data,
        write() { try { localStorage.setItem(CONFIG.storageKey, JSON.stringify(data)); } catch (e) { /* not persisted */ } }
    };
})();

// ---------- Canvas: integer scaling in device pixels ----------
const canvas = $('gameCanvas');
const ctx = canvas.getContext('2d');
const view = { width: 0, height: 0, scale: 1 };

function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    // The canvas fills the layout viewport in CSS; the backing store matches its measured box,
    // so it is never stretched (100vh and innerHeight can disagree, e.g. with mobile toolbars)
    const box = canvas.getBoundingClientRect();
    canvas.width = Math.round((box.width || window.innerWidth) * dpr);
    canvas.height = Math.round((box.height || window.innerHeight) * dpr);
    // Whole device pixels per game pixel, so every art pixel is the same size on screen
    view.scale = Math.max(1, Math.round(CONFIG.scale * dpr));
    view.width = Math.ceil(canvas.width / view.scale);
    view.height = Math.ceil(canvas.height / view.scale);
    ctx.setTransform(view.scale, 0, 0, view.scale, 0, 0);
    ctx.imageSmoothingEnabled = false;
    // UI art pixels: also whole device pixels (screens, HUD, and the small journey markers)
    const vw = window.innerWidth;
    const ui = Math.max(1, Math.round(dpr * (vw >= 900 ? 2 : vw >= 600 ? 1.5 : 1)));
    const hud = Math.max(1, Math.round(dpr * (vw >= 1400 ? 1.5 : 1)));
    const root = document.documentElement.style;
    root.setProperty('--px', `${ui / dpr}px`);
    root.setProperty('--px-hud', `${hud / dpr}px`);
    root.setProperty('--px-mark', `${Math.max(1, Math.floor(hud / 2)) / dpr}px`);
}
resizeCanvas();
window.addEventListener('resize', () => {
    resizeCanvas();
    // A new view size moves the camera target; jump there instead of easing (no gap under the ground)
    if (game.lv) snapCamera();
});

// ---------- Sound (tiny WebAudio synth, created on first user input) ----------
const sound = {
    ctx: null,
    unlock() {
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) this.ctx = new AC();
        }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone(freq, endFreq, duration, type = 'square', volume = 0.08, delay = 0) {
        if (save.data.muted || !this.ctx) return;
        const t = this.ctx.currentTime + delay;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration);
        gain.gain.setValueAtTime(volume, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
        osc.connect(gain).connect(this.ctx.destination);
        osc.start(t);
        osc.stop(t + duration);
    },
    jump() { this.tone(300, 600, 0.12); },
    bone(step) {
        const f = CONFIG.bones.streakBaseFreq * Math.pow(2, PENTATONIC[step] / 12);
        this.tone(f, f * 1.02, 0.09, 'square', 0.05);
    },
    golden() { [0, 0.08, 0.16].forEach((d, i) => this.tone(700 + i * 250, 1000 + i * 300, 0.12, 'square', 0.06, d)); },
    heart() { [0, 0.1].forEach((d, i) => this.tone(500 + i * 300, 800 + i * 300, 0.15, 'triangle', 0.12, d)); },
    stomp() { this.tone(400, 80, 0.15, 'triangle', 0.15); },
    hurt() { this.tone(300, 90, 0.3, 'sawtooth', 0.08); },
    checkpoint() { [0, 0.1, 0.2].forEach((d, i) => this.tone(400 + i * 200, 420 + i * 200, 0.1, 'square', 0.06, d)); },
    thief() { [0, 0.09, 0.18].forEach((d, i) => this.tone(900 - i * 150, 700 - i * 150, 0.08, 'square', 0.06, d)); },
    munch() { [0, 0.12, 0.24].forEach(d => this.tone(180, 60, 0.07, 'square', 0.1, d)); },
    bark() { this.tone(520, 260, 0.12, 'sawtooth', 0.12); this.tone(560, 280, 0.14, 'sawtooth', 0.12, 0.18); },
    fail() { this.tone(400, 60, 0.7, 'sawtooth', 0.08); }
};

// ---------- Levels ----------
let levels = [];
let levelError = null;
try {
    levels = (window.LEVELS || []).map((def, i) => parseLevel(def, i));
    if (levels.length === 0) throw new Error('No levels found');
    if (!levels[levels.length - 1].thief) throw new Error("The last level needs the thief 'T'");
    levels.forEach(l => { if (!art.meta[`tiles_${l.theme}`]) throw new Error(`${l.name}: unknown theme '${l.theme}'`); });
} catch (e) {
    levelError = e.message;
    console.error(e);
}
const TOTAL_GOLDENS = levels.reduce((n, l) => n + l.goldens.length, 0);

// ---------- Game state ----------
// screen: loading | title | intro | playing | paused | respawning | failed | complete | ending | card
const game = {
    screen: 'loading',
    pausedFrom: null,
    clock: 0,       // seconds of simulated time, for streaks and animation
    run: null,      // whole-run state
    lv: null,       // current level attempt
    camera: { x: 0, y: 0 },
    particles: [],  // crumbs (no sprite)
    effects: [],    // sprite effects: dust, stars, sparkles...
    banner: null,   // { text, sub, time }
    timer: 0,       // countdown for transitions
    streak: { step: 0, last: -Infinity },
    journey: 0,     // eased overall progress shown in the HUD bar (0..1)
    intro: null,
    ending: null,
    card: null
};

const input = { left: false, right: false, jumpHeld: false, jumpPressed: false };

function newRun() {
    game.run = {
        levelIndex: 0,
        runTime: 0,
        hearts: CONFIG.health.startHearts,
        goldens: levels.map(() => new Set()),
        fullBelly: levels.map(() => false),
        bankedBones: 0,   // bones held at the end of completed levels
        extraBones: 0,    // quiet-assist bones (count toward hearts only)
        nextHeartAt: CONFIG.bones.perHeart
    };
    game.journey = 0;
    startLevel(0, false, false); // the level banner shows after the intro
    startIntro();
}

function startLevel(index, retry = false, showBanner = true) {
    const run = game.run;
    const level = levels[index];
    run.levelIndex = index;
    if (!retry) run.levelStart = { hearts: run.hearts, nextHeartAt: run.nextHeartAt, extraBones: run.extraBones };
    run.goldens[index] = new Set();
    const lvLevel = cloneLevel(level); // per-attempt copy: the quiet assist may change its tiles
    game.lv = {
        level: lvLevel,
        time: 0,
        player: Object.assign(createPlayer(level.start), { anim: 'idle', animT: 0, takeoff: 0, landing: 0, skid: 0, hurtT: 0, dustT: 0 }),
        squirrels: level.squirrels.map(createSquirrel),
        boneState: new Uint8Array(level.bones.length),
        heldOrder: [],     // indices in pickup order (most recent last)
        dropped: [],
        pendingDrop: false,
        checkpoint: -1,
        checkpointTime: 0,
        exitEaten: false,
        deaths: new Map(), // death bucket -> count (quiet assist)
        assisted: new Set(),
        assistBones: [],
        hintFade: {},      // hint index -> seconds since Wubby passed it
        chase: null
    };
    game.particles = [];
    game.effects = [];
    game.ending = null;
    input.jumpPressed = false;
    game.banner = null;
    snapCamera();
    setScreen('playing');
    if (showBanner) showLevelBanner(index);
    track('level_start', { level: index + 1, retry });
}

// "Level N of 3 · name": fades in, holds ~2s, fades out (CSS); gameplay keeps running
function showLevelBanner(index) {
    const el = $('levelBanner');
    $('levelBannerText').textContent = `Level ${index + 1} of ${levels.length} · ${levels[index].name}`;
    el.classList.remove('show');
    void el.offsetWidth; // restart the animation
    el.classList.add('show');
}

function goldenTotal() {
    return game.run ? game.run.goldens.reduce((n, s) => n + s.size, 0) : 0;
}

function heldCount(lv = game.lv) {
    return lv.heldOrder.length;
}

// Bones that count toward the next heart: everything held now plus banked levels plus assist bones
function boneProgress() {
    return game.run.bankedBones + heldCount() + game.run.extraBones;
}

function setScreen(screen) {
    game.screen = screen;
    const inLevel = ['intro', 'playing', 'paused', 'respawning', 'failed', 'complete', 'ending'].includes(screen);
    $('titleScreen').classList.toggle('hidden', screen !== 'title');
    $('pauseScreen').classList.toggle('hidden', screen !== 'paused');
    $('cardScreen').classList.toggle('hidden', screen !== 'card');
    $('hud').classList.toggle('hidden', !inLevel);
    document.body.classList.toggle('in-level', inLevel && screen !== 'paused');
    if (!inLevel) $('levelBanner').classList.remove('show');
    if (screen === 'title') renderTitleStats();
}

// ---------- Input ----------
function pressJump() {
    sound.unlock();
    if (game.screen === 'intro') { finishIntro(); return; }
    if (!input.jumpHeld) input.jumpPressed = true;
    input.jumpHeld = true;
}

function releaseJump() { input.jumpHeld = false; }

function togglePause() {
    if (game.screen === 'paused') { setScreen(game.pausedFrom); return; }
    if (['playing', 'respawning', 'complete'].includes(game.screen)) {
        game.pausedFrom = game.screen;
        input.left = input.right = false;
        releaseJump();
        setScreen('paused');
    }
}

function quitToTitle() {
    if (game.run) track('quit', { level: game.run.levelIndex + 1, reason: 'menu' });
    game.run = null; game.lv = null;
    setScreen('title');
}

function handleKey(e, isDown) {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT') return; // let the name field type freely
    const code = e.code;
    // Outside a level, focused buttons keep their normal Space/Enter behaviour
    if (tag === 'BUTTON' && !document.body.classList.contains('in-level') && code !== 'Escape') return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) e.preventDefault();
    if (code === 'ArrowRight' || code === 'KeyD') input.right = isDown;
    if (code === 'ArrowLeft' || code === 'KeyA') input.left = isDown;
    if (code === 'Space' || code === 'ArrowUp' || code === 'KeyW') {
        if (isDown) pressJump(); else releaseJump();
    }
    if (!isDown || e.repeat) return;
    if (code === 'Escape' || code === 'KeyP') togglePause();
    if (code === 'KeyM') toggleMute();
    if (code === 'Enter' && game.screen === 'intro') finishIntro();
    if ((code === 'Enter' || code === 'Space') && game.screen === 'title' && !levelError) { sound.unlock(); newRun(); }
}

function toggleMute() {
    save.data.muted = !save.data.muted;
    save.write();
}

document.addEventListener('keydown', e => handleKey(e, true));
document.addEventListener('keyup', e => handleKey(e, false));
window.addEventListener('blur', () => { input.left = input.right = false; releaseJump(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && game.screen === 'playing') togglePause(); });
window.addEventListener('pagehide', () => {
    if (game.run && !['card', 'title'].includes(game.screen)) track('quit', { level: game.run.levelIndex + 1, reason: 'pagehide' });
});

document.querySelectorAll('[data-control]').forEach(btn => {
    const control = btn.dataset.control;
    const down = (e) => { e.preventDefault(); btn.classList.add('pressed'); if (control === 'jump') pressJump(); else input[control] = true; };
    const up = (e) => { e.preventDefault(); btn.classList.remove('pressed'); if (control === 'jump') releaseJump(); else input[control] = false; };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
});
$('pauseBtn').addEventListener('click', togglePause);
$('muteBtn').addEventListener('click', toggleMute);

$('playBtn').addEventListener('click', () => { sound.unlock(); newRun(); });
$('resumeBtn').addEventListener('click', togglePause);
$('restartLevelBtn').addEventListener('click', restartLevel);
$('quitBtn').addEventListener('click', quitToTitle);

// ---------- Intro: the thief grabs Wubby's treat and runs off ----------
function startIntro() {
    const p = game.lv.player;
    const level = game.lv.level;
    const spot = groundSpotNear(level, p.x + CONFIG.thief.introDistance, -1) || { x: p.x + CONFIG.thief.introDistance, y: p.y + p.height };
    const thief = createThief({ x: spot.x, y: spot.y - CONFIG.thief.height });
    thief.dir = -1;
    thief.speed = CONFIG.thief.introSpeed;
    game.intro = {
        phase: 'wait', t: 0, thief, hasTreat: false,
        treat: { x: p.x + p.width + 16, y: p.y + p.height - 6 },
        jar: { x: p.x + p.width + 34, y: p.y + p.height }
    };
    game.banner = null;
    setScreen('intro');
}

function updateIntro(dt) {
    const it = game.intro;
    const level = game.lv.level;
    const th = it.thief;
    it.t += dt;
    setAnim(game.lv.player, it.hasTreat ? 'surprised' : 'idle', dt);
    const next = (phase) => { it.phase = phase; it.t = 0; };
    switch (it.phase) {
        case 'wait':
            if (it.t > 0.6) { sound.thief(); next('enter'); }
            break;
        case 'enter':
            stepThief(level, th, dt);
            if (th.x <= it.treat.x + 2) {
                it.hasTreat = true;
                th.dir = 1;
                sound.thief();
                game.banner = { text: 'HEY! A SQUIRREL STOLE', sub: "WUBBY'S TREAT! GET IT BACK!", time: 2.6 };
                next('grab');
            }
            break;
        case 'grab':
            th.animTime += dt;
            if (it.t > CONFIG.thief.introGrabPause) { th.animTime = 0; next('exit'); }
            break;
        case 'exit':
            // Runs off and fades out
            stepThief(level, th, dt);
            th.fade = Math.max(0, it.t - (CONFIG.thief.introExitTime - 0.4));
            if (it.t > CONFIG.thief.introExitTime) finishIntro();
            break;
    }
}

function finishIntro() {
    if (game.screen !== 'intro') return;
    game.intro = null;
    input.jumpPressed = false;
    game.banner = null;
    setScreen('playing');
    showLevelBanner(game.lv.level.index);
}

// ---------- Update ----------
function update(dt) {
    game.clock += dt;
    if (game.banner && (game.banner.time -= dt) <= 0) game.banner = null;
    updateParticles(dt);
    updateEffects(dt);

    switch (game.screen) {
        case 'intro': updateIntro(dt); break;
        case 'playing': updatePlaying(dt); break;
        case 'respawning':
        case 'failed':
            game.run.runTime += dt * 1000;
            game.lv.time += dt;
            updateDeadPlayer(dt);
            setAnim(game.lv.player, 'defeat', dt);
            if ((game.timer -= dt) <= 0) game.screen === 'failed' ? restartLevel() : respawn();
            break;
        case 'complete':
            // Keep gravity so Wubby lands if the pedestal was touched mid-jump
            stepPlayer(game.lv.level, game.lv.player, { left: false, right: false, jumpPressed: false, jumpHeld: false }, dt);
            setAnim(game.lv.player, 'munch', dt);
            if ((game.timer -= dt) <= 0) startLevel(game.run.levelIndex + 1);
            break;
        case 'ending': updateEnding(dt); break;
    }
    if (game.lv) updateCamera(dt);
}

function updatePlaying(dt) {
    const { lv, run } = game;
    const level = lv.level;
    const p = lv.player;
    run.runTime += dt * 1000;
    lv.time += dt;

    const prevBottom = p.y + p.height;
    const events = stepPlayer(level, p, input, dt);
    input.jumpPressed = false;
    for (const e of events) {
        if (e === 'jump') { sound.jump(); p.takeoff = 0.08; }
        if (e === 'land') { p.landing = 0.1; spawnEffect('gang_effects', 'landDust', p.x + p.width / 2, p.y + p.height - 4); }
        if (e === 'skid') p.skid = 0.15;
    }
    if (p.onGround && p.vx !== 0 && (p.dustT -= dt) <= 0) {
        p.dustT = 0.22;
        spawnEffect('gang_effects', 'runDust', p.x + p.width / 2 - Math.sign(p.vx) * 10, p.y + p.height - 4, p.vx < 0);
    }
    updatePlayerAnim(p, dt);

    lv.squirrels.forEach(s => stepSquirrel(level, s, dt, p));
    lv.squirrels = lv.squirrels.filter(s => !s.defeated || s.defeatTime < 0.5);
    updateDroppedBones(dt);

    // Squirrels: stomp from above, side contact hurts
    for (const s of lv.squirrels) {
        if (s.defeated || !overlaps(p, s)) continue;
        if (p.vy > 0 && prevBottom <= s.y + 6) {
            s.defeated = true;
            p.vy = -CONFIG.player.stompBounce;
            p.canCutJump = false;
            sound.stomp();
            spawnEffect('gang_effects', 'stompRing', s.x + s.width / 2, s.y + s.height - 3);
        } else if (p.invincible <= 0) {
            hurt('squirrel', false, Math.sign(p.x + p.width / 2 - (s.x + s.width / 2)) || -1);
            return;
        }
    }

    if (p.y > level.pixelHeight + CONFIG.fallMargin) {
        if (lv.chase) chaseRespawn(); else hurt('gap', true);
        return;
    }
    if (p.invincible <= 0 && level.spikes.some(s => overlaps(p, spikeHitbox(s)))) { hurt('spike', true); return; }

    collectBones(p);

    const found = run.goldens[level.index];
    level.goldens.forEach((g, i) => {
        if (found.has(i) || !nearPoint(p, g, CONFIG.pickupRadius)) return;
        found.add(i);
        sound.golden();
        spawnEffect('items', 'goldenCollect', g.x, g.y);
        game.banner = { text: 'GOLDEN BONE!', sub: `${goldenTotal()}/${TOTAL_GOLDENS}`, time: 1.4 };
    });

    level.checkpoints.forEach((c, i) => {
        if (i <= lv.checkpoint || !overlaps(p, c)) return;
        lv.checkpoint = i;
        lv.checkpointTime = game.clock;
        sound.checkpoint();
        // gold sparkle (the checkpoint burst art is red/pink, and red is reserved for hazards)
        spawnEffect('gang_effects', 'streakSparkle', c.x + T / 2, c.y + 6);
        game.banner = { text: 'CHECKPOINT!', sub: '', time: 1.2 };
    });

    // 'fade' hints fade out once Wubby has passed them
    level.hints.forEach((h, i) => {
        if (h.fade && (lv.hintFade[i] || p.x > h.col * T + T * 2)) lv.hintFade[i] = (lv.hintFade[i] || 0) + dt;
    });

    if (level.exit && overlaps(p, level.exit)) completeLevel();
    if (level.thief) updateChase(dt);
}

// ---------- Wubby's animation state ----------
function setAnim(p, name, dt) {
    if (p.anim !== name) { p.anim = name; p.animT = 0; }
    else p.animT += dt;
}

function updatePlayerAnim(p, dt) {
    p.takeoff -= dt; p.landing -= dt; p.skid -= dt; p.hurtT -= dt;
    let name;
    if (p.knockback > 0) name = 'knockback';
    else if (p.hurtT > 0) name = 'hurt';
    else if (!p.onGround) {
        if (p.takeoff > 0) name = 'jumpTakeoff';
        else if (p.vy < -140) name = 'jumpRise';
        else if (p.vy <= 140) name = 'jumpApex';
        else name = 'jumpFall';
    } else if (p.landing > 0) name = 'land';
    else if (p.skid > 0 && p.vx !== 0) name = 'skid';
    else name = p.vx !== 0 ? 'run' : 'idle';
    setAnim(p, name, dt);
}

// ---------- Bones: pickups, streak pitch, hearts, drops ----------
function onBonePickup(x, y) {
    const cfg = CONFIG.bones;
    const st = game.streak;
    st.step = game.clock - st.last <= cfg.streakWindow ? Math.min(st.step + 1, cfg.streakSteps - 1) : 0;
    st.last = game.clock;
    sound.bone(st.step);
    spawnEffect('items', 'boneCollect', x, y);
    if (st.step > 0) spawnEffect('gang_effects', 'streakSparkle', x, y - 6);
    checkHeartReward();
}

function checkHeartReward() {
    const run = game.run;
    while (boneProgress() >= run.nextHeartAt) {
        run.nextHeartAt += CONFIG.bones.perHeart;
        if (run.hearts < CONFIG.health.maxHearts) {
            run.hearts++;
            sound.heart();
            const p = game.lv.player;
            spawnEffect('items', 'heartCollect', p.x + p.width / 2, p.y - 6);
            game.banner = { text: '+1 HEART!', sub: '', time: 1.2 };
        }
    }
}

function holdBone(i) {
    game.lv.boneState[i] = BONE.HELD;
    game.lv.heldOrder.push(i);
}

function collectBones(p) {
    const lv = game.lv;
    const r = CONFIG.pickupRadius;
    lv.level.bones.forEach((b, i) => {
        if (lv.boneState[i] !== BONE.AVAILABLE || !nearPoint(p, b, r)) return;
        holdBone(i);
        onBonePickup(b.x, b.y);
    });
    lv.dropped = lv.dropped.filter(d => {
        if (d.age < CONFIG.droppedBones.pickupDelay || !nearPoint(p, { x: d.x + d.width / 2, y: d.y + d.height / 2 }, r)) return true;
        holdBone(d.index); // re-collecting restores the same bone, so it never counts twice
        onBonePickup(d.x + d.width / 2, d.y + d.height / 2);
        return false;
    });
    lv.assistBones.forEach(b => {
        if (b.taken || !nearPoint(p, b, r)) return;
        b.taken = true;
        game.run.extraBones++;
        onBonePickup(b.x, b.y);
    });
}

// On a hit, the most recently collected bones scatter and can be re-collected for a few seconds
function dropBones(cx, cy) {
    const lv = game.lv;
    const cfg = CONFIG.droppedBones;
    const n = Math.min(cfg.max, lv.heldOrder.length);
    const rnd = (range) => range[0] + Math.random() * (range[1] - range[0]);
    for (let k = 0; k < n; k++) {
        const index = lv.heldOrder.pop();
        lv.boneState[index] = BONE.DROPPED;
        const dir = k % 2 === 0 ? 1 : -1;
        lv.dropped.push({
            index, x: cx - cfg.size / 2, y: cy - cfg.size, width: cfg.size, height: cfg.size,
            vx: dir * rnd(cfg.speedX), vy: -rnd(cfg.speedY), age: 0, onGround: false
        });
    }
}

function updateDroppedBones(dt) {
    const lv = game.lv;
    lv.dropped = lv.dropped.filter(d => {
        stepDroppedBone(lv.level, d, dt);
        if (d.age < CONFIG.droppedBones.lifetime && d.y < lv.level.pixelHeight + CONFIG.fallMargin) return true;
        lv.boneState[d.index] = BONE.LOST;
        return false;
    });
}

// ---------- Hits, respawns, quiet assist ----------
function hurt(cause, respawnAfter, knockDir = -1) {
    const { lv, run } = game;
    const p = lv.player;
    run.hearts--;
    track('death', { level: lv.level.index + 1, x: Math.round(p.x), cause, heartsLeft: run.hearts });
    recordDeath(p.x);
    spawnEffect('gang_effects', 'heartLost', p.x + p.width / 2, p.y - 4, false, { vy: -30 });
    if (cause !== 'gap') spawnEffect('gang_effects', 'hitStars', p.x + p.width / 2, p.y - 2, false, { life: 0.6 });

    if (run.hearts <= 0) {
        sound.fail();
        p.vy = -300; p.vx = 0;
        game.timer = CONFIG.health.levelRestartDelay;
        game.banner = { text: 'OUCH!', sub: 'BACK TO THE START OF THE LEVEL', time: CONFIG.health.levelRestartDelay };
        setScreen('failed');
        return;
    }
    sound.hurt();
    if (respawnAfter) {
        // Bones scatter at the respawn point so they can be recovered
        lv.pendingDrop = true;
        p.vx = 0;
        if (cause === 'spike') p.vy = -250;
        game.timer = CONFIG.health.respawnDelay;
        setScreen('respawning');
    } else {
        dropBones(p.x + p.width / 2, p.y + p.height / 2);
        p.vx = knockDir * CONFIG.player.knockbackSpeed;
        p.vy = -250;
        p.knockback = CONFIG.player.knockbackTime;
        p.hurtT = 0.25;
        p.invincible = CONFIG.health.invincibleTime;
    }
}

// Wubby tumbles (no collisions) while waiting to respawn
function updateDeadPlayer(dt) {
    const p = game.lv.player;
    p.vy = Math.min(p.vy + CONFIG.player.gravity * dt, CONFIG.player.maxFallSpeed);
    p.y += p.vy * dt;
}

function respawn() {
    const { lv } = game;
    const cp = lv.level.checkpoints[lv.checkpoint];
    const spawn = cp ? { x: cp.spawnX, y: cp.spawnY } : lv.level.start;
    const p = lv.player;
    Object.assign(p, { x: spawn.x, y: spawn.y, vx: 0, vy: 0, knockback: 0, facingRight: true, invincible: CONFIG.health.invincibleTime });
    if (lv.pendingDrop) {
        lv.pendingDrop = false;
        dropBones(p.x + p.width / 2, p.y + p.height / 2);
    }
    snapCamera();
    setScreen('playing');
}

// New attempt at the current level (after losing all hearts, or from the pause menu)
function restartLevel() {
    const run = game.run;
    Object.assign(run, run.levelStart);
    startLevel(run.levelIndex, true);
}

// Quiet assist: 3 deaths in one ~200px bucket -> faint bone trail + slightly wider landings there
function recordDeath(x) {
    const lv = game.lv;
    const { bucketSize, deathThreshold } = CONFIG.assist;
    const bucket = Math.floor(x / bucketSize);
    const count = (lv.deaths.get(bucket) || 0) + 1;
    lv.deaths.set(bucket, count);
    if (count >= deathThreshold && !lv.assisted.has(bucket)) {
        lv.assisted.add(bucket);
        applyAssist(bucket);
    }
}

function applyAssist(bucket) {
    const lv = game.lv;
    const level = lv.level;
    const cfg = CONFIG.assist;
    const c0 = Math.max(0, Math.floor((bucket * cfg.bucketSize) / T) - 2);
    const c1 = Math.min(level.width - 1, Math.ceil(((bucket + 1) * cfg.bucketSize) / T) + 2);
    const hazard = (c) => c >= 0 && c < level.width && isHazardColumn(level, c);

    // 1. Widen landings next to gaps/spikes, always leaving at least one hazard tile
    const surfaces = findSurfaces(level).filter(s => s.c1 >= c0 - 1 && s.c0 <= c1 + 1);
    for (const s of surfaces) {
        for (let k = 1; k <= cfg.widenTiles; k++) {
            [[s.c1 + k, 1], [s.c0 - k, -1]].forEach(([c, dir]) => {
                if (c < c0 || c > c1 || !hazard(c) || !hazard(c + dir)) return;
                level.solid[s.row * level.width + c] = 1;
                level.spikes = level.spikes.filter(sp => !(sp.x === c * T && (sp.y === s.row * T || sp.y === (s.row - 1) * T)));
            });
        }
    }
    level.tileCanvas = null;
    level.hazardNames = null; // spike list may have changed

    // 2. Faint bone trail along a real full jump over each remaining hazard run
    for (let c = c0; c <= c1; c++) {
        if (!hazard(c) || hazard(c - 1)) continue;
        let end = c;
        while (hazard(end + 1)) end++;
        const from = findSurfaces(level).find(s => s.c1 === c - 1);
        if (from) addAssistTrail(level, c, end, from.row);
        c = end;
    }
}

function addAssistTrail(level, h0, h1, row) {
    const lv = game.lv;
    const p = createPlayer({ x: h0 * T - CONFIG.player.width, y: row * T - CONFIG.player.height });
    p.onGround = true;
    for (let i = 1; i <= 120; i++) {
        stepPlayer(level, p, { left: false, right: true, jumpPressed: i === 1, jumpHeld: true }, CONFIG.fixedStep);
        if (p.onGround || p.y > level.pixelHeight) break;
        const cx = p.x + p.width / 2;
        if (i % CONFIG.assist.trailSpacing === 0 && cx > (h0 - 1) * T && cx < (h1 + 2) * T) {
            lv.assistBones.push({ x: cx, y: p.y + p.height / 2, taken: false });
        }
    }
}

// ---------- Level complete ----------
function bankLevel() {
    const { lv, run } = game;
    const i = lv.level.index;
    run.fullBelly[i] = heldCount() === lv.level.bones.length;
    run.bankedBones += heldCount();
    track('level_complete', { level: i + 1, time: Math.round(lv.time * 1000), fullBelly: run.fullBelly[i] });
}

function completeLevel() {
    const { lv, run } = game;
    bankLevel();
    lv.exitEaten = true;
    lv.player.vx = 0;
    sound.munch();
    crumbs(lv.level.exit.x + T / 2, lv.level.exit.y + 6, 14);
    const full = run.fullBelly[lv.level.index];
    const total = lv.level.bones.length;
    game.banner = {
        text: 'LEVEL COMPLETE!',
        sub: `TIME ${formatTime(lv.time * 1000, 1)}  ·  ` + (full ? 'FULL BELLY ✓' : `BONES ${heldCount()}/${total}`),
        time: CONFIG.levelCompleteTime
    };
    game.timer = CONFIG.levelCompleteTime;
    setScreen('complete');
}

// ---------- Chase (last level) ----------
function updateChase(dt) {
    const { lv } = game;
    const level = lv.level;
    const p = lv.player;
    if (!lv.chase) {
        if (p.x + p.width < level.thief.x - CONFIG.thief.triggerDistance) return;
        const thief = createThief(level.thief);
        lv.chase = { thief };
        sound.thief();
        game.banner = { text: 'STOP, THIEF!', sub: 'CATCH IT TO GET THE TREAT BACK', time: 2 };
    }
    const thief = lv.chase.thief;
    stepThief(level, thief, dt);
    if (overlaps(p, thief)) startEnding();
}

// No fail state in the chase: a fall puts Wubby back on the ground just behind the thief
function chaseRespawn() {
    const { lv } = game;
    const thief = lv.chase.thief;
    const spot = groundSpotNear(lv.level, thief.x - CONFIG.thief.respawnBehind, -1);
    const p = lv.player;
    if (spot) Object.assign(p, { x: spot.x, y: spot.y - p.height, vx: 0, vy: 0, knockback: 0, facingRight: true });
    snapCamera();
}

// ---------- End scene: thief is caught, treat drops, Wubby walks over, munches, celebrates ----------
function startEnding() {
    const { lv } = game;
    const thief = lv.chase.thief;
    bankLevel();
    thief.caught = 0;
    thief.fade = 0;
    sound.stomp();
    sound.thief();
    spawnEffect('gang_effects', 'hitStars', thief.x + thief.width / 2, thief.y - 4, false, { life: 0.9 });
    const s = CONFIG.droppedBones.size;
    game.ending = {
        phase: 'drop', t: 0, thief,
        treat: { x: thief.x + thief.width / 2 - s / 2, y: thief.y - s, width: s, height: s, vx: -70, vy: -320, onGround: false }
    };
    game.banner = { text: 'GOT IT!', sub: '', time: 1.4 };
    input.left = input.right = false;
    releaseJump();
    setScreen('ending');
}

function updateEnding(dt) {
    const { lv } = game;
    const e = game.ending;
    const p = lv.player;
    e.t += dt;
    const next = (phase) => { e.phase = phase; e.t = 0; };

    // The thief is caught (dizzy for a moment), then flees off-screen ignoring walls
    const th = e.thief;
    th.caught += dt;
    th.animTime += dt;
    if (th.caught > 1.1) {
        th.fleeing = true;
        th.x += 260 * dt; th.y -= 60 * dt; th.fade += dt;
    }
    if (e.treat && e.phase === 'drop') {
        e.treat.vy = Math.min(e.treat.vy + CONFIG.player.gravity * dt, CONFIG.player.maxFallSpeed);
        moveAndCollide(lv.level, e.treat, e.treat.vx * dt, e.treat.vy * dt);
        if (e.treat.onGround) e.treat.vx = 0;
    }

    switch (e.phase) {
        case 'drop':
            stepPlayer(lv.level, p, { left: false, right: false, jumpPressed: false, jumpHeld: false }, dt);
            setAnim(p, 'surprised', dt);
            if ((e.treat.onGround && e.t > 0.5) || e.t > 2) {
                e.targetX = p.x < e.treat.x ? e.treat.x - p.width - 2 : e.treat.x + e.treat.width + 2;
                next('walk');
            }
            break;
        case 'walk': {
            const dir = Math.sign(e.targetX - p.x);
            const arrived = Math.abs(e.targetX - p.x) < 2 && p.onGround;
            stepPlayer(lv.level, p, { left: !arrived && dir < 0, right: !arrived && dir > 0, jumpPressed: false, jumpHeld: false }, dt);
            setAnim(p, p.vx !== 0 ? 'run' : 'idle', dt);
            if (arrived || e.t > 3) {
                p.vx = 0;
                p.facingRight = e.treat.x > p.x;
                next('sit');
            }
            break;
        }
        case 'sit':
            setAnim(p, 'idle', dt);
            if (e.t > 0.4) { sound.munch(); next('munch'); }
            break;
        case 'munch':
            setAnim(p, 'munch', dt);
            if (Math.floor(e.t / 0.3) !== Math.floor((e.t - dt) / 0.3)) {
                sound.munch();
                crumbs(e.treat.x + e.treat.width / 2, e.treat.y, 6);
            }
            if (e.t > 1.2) { e.treat = null; sound.bark(); next('wag'); }
            break;
        case 'wag':
            setAnim(p, 'celebrate', dt);
            if (e.t > 1.8) finishRun();
            break;
    }
}

function finishRun() {
    const run = game.run;
    const goldens = goldenTotal();
    const isBest = save.data.bestTime == null || run.runTime < save.data.bestTime;
    if (isBest) save.data.bestTime = run.runTime;
    save.data.maxGoldens = Math.max(save.data.maxGoldens, goldens);
    save.data.completed = true;
    save.write();
    track('game_complete', { time: Math.round(run.runTime), goldens, fullBelly: run.fullBelly.filter(Boolean).length, best: isBest });

    game.card = {
        runTime: run.runTime,
        goldens,
        totalGoldens: TOTAL_GOLDENS,
        fullBelly: run.fullBelly.filter(Boolean).length,
        totalLevels: levels.length,
        goldensByLevel: run.goldens.map((s, i) => ({ found: s.size, total: levels[i].goldens.length })),
        date: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
        url: siteUrl().replace(/^https?:\/\//, '').replace(/\/$/, '')
    };
    $('nameInput').value = '';
    renderGoldenSummary(game.card);
    $('shareFallback').classList.add('hidden');
    $('cardTimes').textContent = `Run ${formatTime(run.runTime)} · Best ${formatTime(save.data.bestTime)}` + (isBest ? ' · new best!' : '');
    $('cardStatus').textContent = '';
    setScreen('card');
    updateCard();
    // The handwriting font may still be loading; draw again once it is ready
    if (document.fonts && document.fonts.load) {
        Promise.all([document.fonts.load('48px Caveat'), document.fonts.load('700 48px Caveat')]).then(updateCard, () => {});
    }
}

// ---------- Reward card screen ----------
function updateCard() {
    const c = game.card;
    if (!c) return;
    c.name = sanitizeName($('nameInput').value);
    c.treat = treatNumber(c.name, c.runTime);
    renderRewardCard(c, { photo: artImage('card_photo.jpg'), photoGold: artImage('card_photo_gold.jpg') }, $('cardCanvas'));
}

function renderGoldenSummary(c) {
    const groups = c.goldensByLevel.map((g, i) => {
        let icons = '';
        for (let k = 0; k < g.total; k++) {
            icons += k < g.found
                ? '<span class="ui-icon-golden" role="img" aria-label="found"></span>'
                : '<span class="ui-icon-golden-empty" role="img" aria-label="missing"></span>';
        }
        return `<span class="golden-group"><span class="golden-level">L${i + 1}</span>${icons}</span>`;
    }).join('');
    $('goldenIcons').innerHTML = groups;
    const missing = c.goldensByLevel.map((g, i) => ({ n: g.total - g.found, level: i + 1 })).filter(m => m.n > 0);
    $('goldenHint').textContent = missing.map((m, k) => (k === 0 ? `${m.n} still hiding in level ${m.level}` : `${m.n} in level ${m.level}`)).join(', ');
    $('goldenHint').classList.toggle('hidden', missing.length === 0);
}

$('nameInput').addEventListener('input', (e) => {
    // Live filter: only allowed characters, max 20; the card redraws as you type
    const el = e.target;
    const filtered = el.value.replace(/[^\p{L}\p{N} .,'!?&_-]/gu, '').slice(0, 20);
    if (filtered !== el.value) el.value = filtered;
    updateCard();
});

function cardStatus(text) { $('cardStatus').textContent = text; }

$('downloadBtn').addEventListener('click', async () => {
    await downloadCard($('cardCanvas'), game.card);
    track('card_shared', { method: 'download' });
    cardStatus('Saved!');
});

$('shareBtn').addEventListener('click', async () => {
    const result = await shareCard($('cardCanvas'), game.card);
    if (result === 'web_share') { track('card_shared', { method: 'web_share' }); cardStatus('Thanks for sharing!'); }
    if (result === 'fallback') {
        const links = shareLinks(game.card);
        $('shareX').href = links.x;
        $('shareLinkedIn').href = links.linkedin;
        $('shareFallback').classList.remove('hidden');
    }
});
$('shareX').addEventListener('click', () => track('card_shared', { method: 'x' }));
$('shareLinkedIn').addEventListener('click', () => track('card_shared', { method: 'linkedin' }));

$('copyLinkBtn').addEventListener('click', async () => {
    const ok = await copyLink();
    if (ok) track('card_shared', { method: 'copy_link' });
    cardStatus(ok ? 'Link copied!' : 'Could not copy the link');
});

$('playAgainBtn').addEventListener('click', () => { sound.unlock(); newRun(); });

// ---------- Effects, crumbs & camera ----------
// Sprite effects play once (or for `life` seconds when looping) and drift by vy
function spawnEffect(sheet, name, x, y, flip = false, opts = {}) {
    const a = anim(sheet, name);
    game.effects.push({ sheet, name, x, y, flip, t: 0, vy: opts.vy || 0, life: opts.life || (a.loop ? 0.5 : animDuration(sheet, name)) });
}

function updateEffects(dt) {
    game.effects = game.effects.filter(f => {
        f.t += dt;
        f.y += f.vy * dt;
        return f.t < f.life;
    });
}

function crumbs(x, y, count) {
    for (let i = 0; i < count; i++) {
        game.particles.push({ x, y, vx: (Math.random() - 0.5) * 200, vy: -Math.random() * 160 + 20, life: 0.4 + Math.random() * 0.3, color: Math.random() < 0.5 ? '#d9a066' : '#a8673a' });
    }
}

function updateParticles(dt) {
    game.particles = game.particles.filter(pt => {
        pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vy += 540 * dt;
        return (pt.life -= dt) > 0;
    });
}

function cameraTarget() {
    const { level, player } = game.lv;
    const x = Math.max(0, Math.min(player.x - view.width * CONFIG.camera.leadRatio, level.pixelWidth - view.width));
    // Short levels sit on the bottom of the screen; tall ones follow Wubby vertically
    const y = level.pixelHeight <= view.height
        ? level.pixelHeight - view.height
        : Math.max(0, Math.min(player.y - view.height / 2, level.pixelHeight - view.height));
    return { x: level.pixelWidth < view.width ? (level.pixelWidth - view.width) / 2 : x, y };
}

function snapCamera() { Object.assign(game.camera, cameraTarget()); }

function updateCamera(dt) {
    const t = cameraTarget();
    const k = Math.min(1, CONFIG.camera.smoothing * dt);
    game.camera.x += (t.x - game.camera.x) * k;
    game.camera.y += (t.y - game.camera.y) * k;
}

// ---------- Rendering ----------
const hash = (n) => { let h = (n * 2654435761) >>> 0; h ^= h >>> 15; return h >>> 0; };

// Pre-render the level's tiles and props once per attempt (and again if the quiet assist changes them).
// Exposed tops use the theme's ground tiles, one-tile-thick ledges its platform tiles, everything else the fill.
function renderLevelTiles(level) {
    const ts = art.meta[`tiles_${level.theme}`];
    const img = artImage(ts.image);
    const off = document.createElement('canvas');
    off.width = level.pixelWidth;
    off.height = level.pixelHeight;
    const c = off.getContext('2d');
    c.imageSmoothingEnabled = false;
    const solid = (cc, r) => cc >= 0 && cc < level.width && isSolid(level, cc, r);
    const tile = (name, x, y) => {
        const t = ts.tiles[name];
        c.drawImage(img, t.x, t.y, t.w, t.h, x, y, T, T);
    };

    // Ground top per column: highest row from which the column is solid all the way down (pits have none)
    const groundTop = new Array(level.width).fill(Infinity);
    for (let cc = 0; cc < level.width; cc++) {
        for (let r = level.height - 1; r >= 0 && solid(cc, r); r--) groundTop[cc] = r;
    }

    // 1. Pits read as pits: below the surrounding ground level, the background fades to a deep shade
    const PIT = '20, 14, 12';
    for (let cc = 0; cc < level.width; cc++) {
        if (groundTop[cc] !== Infinity) continue;
        let l = cc, r = cc;
        while (l > 0 && groundTop[l] === Infinity) l--;
        while (r < level.width - 1 && groundTop[r] === Infinity) r++;
        const edge = Math.max(groundTop[l] === Infinity ? 0 : groundTop[l], groundTop[r] === Infinity ? 0 : groundTop[r]);
        const y0 = edge * T - 2;
        const steps = [0.3, 0.5, 0.66, 0.78, 0.87]; // pixel-stepped, 3px bands
        steps.forEach((a, k) => { c.fillStyle = `rgba(${PIT}, ${a})`; c.fillRect(cc * T, y0 + k * 3, T, 3); });
        c.fillStyle = `rgba(${PIT}, 0.94)`;
        c.fillRect(cc * T, y0 + steps.length * 3, T, level.pixelHeight - y0);
    }

    // 2. Soft pixel-stepped shadows (~25%): under floating platforms, and from ground edges into pits
    const SHADOW = [0.25, 0.16, 0.08]; // 2px steps
    for (let r = 0; r < level.height; r++) {
        for (let cc = 0; cc < level.width; cc++) {
            if (!solid(cc, r)) continue;
            if (!solid(cc, r - 1) && !solid(cc, r + 1)) {
                SHADOW.forEach((a, k) => { c.fillStyle = `rgba(0, 0, 0, ${a})`; c.fillRect(cc * T + 1, (r + 1) * T + k * 2, T - 2, 2); });
            }
            for (const dir of [-1, 1]) {
                const nc = cc + dir;
                if (nc < 0 || nc >= level.width || groundTop[nc] !== Infinity || solid(nc, r)) continue;
                SHADOW.forEach((a, k) => {
                    c.fillStyle = `rgba(0, 0, 0, ${a})`;
                    c.fillRect(dir > 0 ? (cc + 1) * T + k * 2 : cc * T - (k + 1) * 2, r * T, 2, T);
                });
            }
        }
    }

    // 3. Tiles, with a 1px darker line along the top edge of every walkable surface
    const edges = [];
    for (let r = 0; r < level.height; r++) {
        for (let cc = 0; cc < level.width; cc++) {
            if (!solid(cc, r)) continue;
            if (solid(cc, r - 1)) { tile(ts.roles.ground.fill, cc * T, r * T); continue; }
            const role = solid(cc, r + 1) ? ts.roles.ground : ts.roles.platform;
            const leftOpen = !solid(cc - 1, r) || solid(cc - 1, r - 1);
            const rightOpen = !solid(cc + 1, r) || solid(cc + 1, r - 1);
            const name = leftOpen && rightOpen ? (role.single || role.mid[0])
                : leftOpen ? role.left
                    : rightOpen ? role.right
                        : role.mid[hash(cc * 31 + r) % role.mid.length];
            tile(name, cc * T, r * T);
            edges.push([name, cc * T, r * T]);
        }
    }
    c.fillStyle = 'rgba(30, 16, 8, 0.45)';
    edges.forEach(([name, x, y]) => {
        const top = ts.tiles[name].top;
        if (top) top.forEach((ty, i) => { if (ty < T) c.fillRect(x + i, y + ty, 1, 1); });
    });
    // Props: decoration only, bottom-centred on their tile
    level.decorations.forEach(d => {
        const p = ts.props[hash(d.x / T + level.index * 101) % ts.props.length];
        c.drawImage(img, p.x, p.y, p.w, p.h, Math.round(d.x + T / 2 - p.w / 2), d.y + T - p.h, p.w, p.h);
    });
    return off;
}

// Title scene: kept at its generated resolution, covering the screen at whole device pixels
function drawTitleScene() {
    const img = artImage('title_bg.png');
    ctx.fillStyle = '#2a3a4a';
    ctx.fillRect(0, 0, view.width, view.height);
    if (!img || !img.naturalWidth) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const k = Math.max(1, Math.ceil(Math.max(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight)));
    const w = img.naturalWidth * k, h = img.naturalHeight * k;
    ctx.drawImage(img, Math.floor((canvas.width - w) / 2), Math.floor((canvas.height - h) / 2), w, h);
    ctx.restore();
}

// Atmospheric depth: far layers lean toward the sky colour (lower contrast); near layers are slightly desaturated.
// Layer 1 is the sky itself (untinted). Every layer's top fades out so layers overlap without hard lines.
const BG_DEPTH = [
    { tint: 0, saturate: 1 },
    { tint: 0.55, saturate: 0.9 },
    { tint: 0.35, saturate: 0.95 },
    { tint: 0.2, saturate: 0.85 }
];
const BG_TOP_FADE = 16;
const BG_BOTTOM_FADE = 24;
const bgLayers = {}; // theme -> pre-rendered layer canvases

function prepareBackgrounds() {
    for (const [key, bg] of Object.entries(art.meta)) {
        if (!key.startsWith('bg_')) continue;
        bgLayers[key] = bg.layers.map((l, i) => {
            const img = artImage(l.image);
            const c = document.createElement('canvas');
            c.width = l.w;
            c.height = l.h;
            const g = c.getContext('2d');
            const depth = BG_DEPTH[i] || BG_DEPTH[BG_DEPTH.length - 1];
            if (depth.saturate !== 1) g.filter = `saturate(${depth.saturate})`;
            if (img && img.naturalWidth) g.drawImage(img, 0, 0);
            g.filter = 'none';
            if (depth.tint) {
                g.globalCompositeOperation = 'source-atop';
                g.globalAlpha = depth.tint;
                g.fillStyle = bg.sky;
                g.fillRect(0, 0, l.w, l.h);
                g.globalAlpha = 1;
            }
            {
                // fade the top to transparent (the sky layer fades into the sky fill colour behind it)
                g.globalCompositeOperation = 'destination-out';
                const fade = g.createLinearGradient(0, 0, 0, BG_TOP_FADE);
                fade.addColorStop(0, 'rgba(0,0,0,1)');
                fade.addColorStop(1, 'rgba(0,0,0,0)');
                g.fillStyle = fade;
                g.fillRect(0, 0, l.w, BG_TOP_FADE);
                // middle layers also fade at the bottom, so nothing hard shows through gaps in the layer in front
                if (i > 0 && i < bg.layers.length - 1) {
                    const bottom = g.createLinearGradient(0, l.h - BG_BOTTOM_FADE, 0, l.h);
                    bottom.addColorStop(0, 'rgba(0,0,0,0)');
                    bottom.addColorStop(1, 'rgba(0,0,0,1)');
                    g.fillStyle = bottom;
                    g.fillRect(0, l.h - BG_BOTTOM_FADE, l.w, BG_BOTTOM_FADE);
                }
            }
            g.globalCompositeOperation = 'source-over';
            return c;
        });
    }
}

// Vertical placement (top y of each layer) so the scene fills the view height without gaps.
// The near layer sits on the view bottom; each farther layer's bottom tucks under the solid part of the layer
// in front of it, so the sky colour never shows between layers. For 'overlap' themes, when the scene is taller
// than the view, farther layers slide down (more overlap) so most of the sky stays visible.
function backgroundLayout(bg, H) {
    const L = bg.layers;
    const n = L.length;
    const tops = new Array(n);
    tops[n - 1] = H - L[n - 1].h;
    for (let i = n - 2; i >= 0; i--) {
        const fadedBottom = i > 0 ? BG_BOTTOM_FADE / 2 : 0; // middle layers' soft bottom stays mostly covered
        const bottom = tops[i + 1] + Math.max(L[i + 1].solidTop, BG_TOP_FADE) + fadedBottom + 4;
        tops[i] = bottom - L[i].h;
    }
    if (bg.layout !== 'stack') {
        const excess = -tops[0] - L[0].h * 0.35;
        if (excess > 0) for (let i = 0; i < n - 1; i++) tops[i] += excess * (n - 1 - i) / (n - 1);
    }
    return tops.map(Math.round);
}

// '#rrggbb' scaled toward black by k (0..1)
function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => Math.round(v * k);
    return `rgb(${ch(n >> 16)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
}

// Pits (columns with no ground down to the bottom) as [x0, x1, groundLineY] in world px; cached per level attempt.
// The ground line is the top of the lower of the two banks.
function levelPits(level) {
    if (level.pits) return level.pits;
    const top = (c) => { let t = level.height; for (let r = level.height - 1; r >= 0 && isSolid(level, c, r); r--) t = r; return t; };
    level.pits = [];
    let start = -1;
    for (let c = 0; c <= level.width; c++) {
        const pit = c < level.width && !isSolid(level, c, level.height - 1);
        if (pit && start < 0) start = c;
        if (!pit && start >= 0) {
            const banks = [start - 1, c].filter(b => b >= 0 && b < level.width).map(top);
            level.pits.push([start * T, c * T, Math.max(...banks) * T]);
            start = -1;
        }
    }
    return level.pits;
}

// Parallax at 0.05 / 0.2 / 0.45 / 0.7; layers are drawn 1:1 with game pixels (same density as the tiles)
function drawBackground() {
    if (!game.lv) { drawTitleScene(); return; }
    const W = view.width, H = view.height;
    const key = `bg_${game.lv.level.theme}`;
    const bg = art.meta[key];
    const layers = bgLayers[key] || [];
    const tops = backgroundLayout(bg, H);
    // Above the sky layer (very tall views only): a soft zenith gradient into the sky colour, never a flat band
    const sky = ctx.createLinearGradient(0, 0, 0, Math.max(1, tops[0] + BG_TOP_FADE));
    sky.addColorStop(0, shade(bg.sky, 0.86));
    sky.addColorStop(1, bg.sky);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    const camX = Math.round(game.camera.x);
    layers.forEach((img, i) => {
        const w = img.width;
        const offset = Math.round(((camX * bg.factors[i]) % w + w) % w);
        if (i === layers.length - 1) { drawNearLayer(img, offset, tops[i], camX); return; }
        for (let x = -offset; x < W; x += w) ctx.drawImage(img, x, tops[i]);
    });
}

// Near layer: nothing from it (fences, gates...) may show inside a pit. Over each pit it fades out from
// about two tiles above the ground line, so there are no hard cut-outs.
const nearCanvas = document.createElement('canvas');
function drawNearLayer(img, offset, top, camX) {
    const W = view.width, H = view.height;
    if (nearCanvas.width !== W || nearCanvas.height !== H) { nearCanvas.width = W; nearCanvas.height = H; }
    const g = nearCanvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    for (let x = -offset; x < W; x += img.width) g.drawImage(img, x, top);
    const camY = Math.round(game.camera.y);
    g.globalCompositeOperation = 'destination-out';
    levelPits(game.lv.level).forEach(([x0, x1, edgeY]) => {
        if (x1 <= camX || x0 >= camX + W) return;
        const y = edgeY - camY;
        const fade = g.createLinearGradient(0, y - T * 2, 0, y);
        fade.addColorStop(0, 'rgba(0,0,0,0)');
        fade.addColorStop(1, 'rgba(0,0,0,1)');
        g.fillStyle = fade;
        g.fillRect(x0 - camX, y - T * 2, x1 - x0, T * 2);
        g.fillStyle = '#000';
        g.fillRect(x0 - camX, y, x1 - x0, H - y);
    });
    g.globalCompositeOperation = 'source-over';
    ctx.drawImage(nearCanvas, 0, 0);
}

function drawWubby(p) {
    // Flicker while invincible
    if (p.invincible > 0 && game.screen === 'playing' && Math.floor(p.invincible / 0.08) % 2 === 0) return;
    // Wubby faces right in the sheet
    drawAnim(ctx, 'wubby', p.anim, p.animT, p.x + p.width / 2, p.y + p.height, !p.facingRight);
}

// The thief faces right in the sheet; its flee loop faces left
function drawThief(th, mode) {
    let name;
    if (mode === 'intro') name = game.intro.phase === 'grab' ? 'grab' : game.intro.hasTreat ? 'runTreat' : 'sneak';
    else if (mode === 'ending') name = th.fleeing ? 'flee' : th.caught < 0.3 ? 'caught' : 'dizzy';
    else name = th.cornered ? 'taunt' : th.onGround ? 'runTreat' : 'jump';
    const alpha = th.fade ? Math.max(0, 1 - th.fade / (th.fleeing ? 0.8 : 0.4)) : 1;
    const movingRight = mode === 'ending' ? true : th.dir > 0;
    const flip = name === 'flee' ? movingRight : !movingRight;
    const t = mode === 'intro' && game.intro.phase === 'grab' ? game.intro.t
        : mode === 'ending' ? (name === 'dizzy' ? th.caught - 0.3 : th.caught)
            : th.animTime;
    drawAnim(ctx, 'thief', name, t, th.x + th.width / 2, th.y + th.height, flip, alpha);
}

// Hazards: the theme's two variants alternate per group of adjacent hazard tiles. Each pulses (2 frames, ~1.5s)
// over a soft red glow; red is reserved for things that hurt.
function hazardVariants(level) {
    if (level.hazardNames) return level.hazardNames;
    const names = art.meta.hazards.themes[level.theme];
    const sorted = level.spikes.map((s, i) => ({ s, i })).sort((a, b) => a.s.x - b.s.x || a.s.y - b.s.y);
    level.hazardNames = new Array(level.spikes.length);
    let group = -1, last = null;
    sorted.forEach(({ s, i }) => {
        if (!last || s.y !== last.y || s.x - last.x > T) group++;
        level.hazardNames[i] = names[group % names.length];
        last = s;
    });
    return level.hazardNames;
}

function drawHazards(level, visible, time) {
    const names = hazardVariants(level);
    const period = 1.5;
    level.spikes.forEach((s, i) => {
        if (!visible(s.x)) return;
        const phase = (time + (s.x % 97) * 0.003) % period;
        const pulse = 0.5 - 0.5 * Math.cos((phase / period) * Math.PI * 2);
        const cx = s.x + T / 2, cy = s.y + T - 5;
        const glow = ctx.createRadialGradient(cx, cy, 1, cx, cy, 22);
        glow.addColorStop(0, `rgba(255, 40, 40, ${0.45 + pulse * 0.25})`);
        glow.addColorStop(0.6, `rgba(255, 40, 40, ${0.16 + pulse * 0.1})`);
        glow.addColorStop(1, 'rgba(255, 40, 40, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(cx - 23, cy - 23, 46, 30);
        drawAnim(ctx, 'hazards', names[i], phase, cx, s.y + T);
    });
}

function drawWorld() {
    const { lv } = game;
    const level = lv.level;
    if (!level.tileCanvas) level.tileCanvas = renderLevelTiles(level);
    const camX = Math.round(game.camera.x), camY = Math.round(game.camera.y);
    const time = game.clock;
    const visible = (x, w = T) => x + w > camX - 30 && x < camX + view.width + 30;

    ctx.save();
    ctx.translate(-camX, -camY);
    ctx.drawImage(level.tileCanvas, 0, 0);

    // Hints ('fade' hints sit centred over their tile and fade out once Wubby has passed them)
    ctx.font = `10px ${PIXEL_FONT}`;
    level.hints.forEach((h, i) => {
        if (!visible(h.col * T - 125, 250)) return;
        const alpha = h.fade ? 1 - Math.min(1, (lv.hintFade[i] || 0) / 0.6) : 1;
        if (alpha <= 0) return;
        const x = h.fade ? h.col * T + T / 2 : h.col * T;
        ctx.textAlign = h.fade ? 'center' : 'left';
        ctx.globalAlpha = alpha;
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillText(h.text, x + 1, h.row * T + 1);
        ctx.fillStyle = '#ffffff'; ctx.fillText(h.text, x, h.row * T);
        ctx.globalAlpha = 1;
    });
    ctx.textAlign = 'left';

    drawHazards(level, visible, time);

    level.checkpoints.forEach((c, i) => {
        if (!visible(c.x)) return;
        const active = i <= lv.checkpoint;
        drawAnim(ctx, 'items', active ? 'flagWave' : 'flagDown', active ? time - lv.checkpointTime : 0, c.x + T / 2, c.y + T * 2);
    });

    if (level.exit) drawAnim(ctx, 'items', lv.exitEaten ? 'pedestalEmpty' : 'pedestalFull', 0, level.exit.x + T / 2, level.exit.y + T * 2);

    level.bones.forEach((b, i) => {
        if (lv.boneState[i] !== BONE.AVAILABLE || !visible(b.x - 9)) return;
        drawAnim(ctx, 'items', 'bone', time + b.x * 0.013, b.x, b.y);
    });
    lv.assistBones.forEach(b => { if (!b.taken && visible(b.x - 9)) drawAnim(ctx, 'items', 'bone', time, b.x, b.y, false, CONFIG.assist.trailAlpha); });
    const dropCfg = CONFIG.droppedBones;
    lv.dropped.forEach(d => {
        const blinking = d.age > dropCfg.lifetime - dropCfg.blinkTime;
        if (blinking && Math.floor(d.age / 0.1) % 2 === 0) return;
        drawAnim(ctx, 'items', 'droppedBone', 0, d.x + d.width / 2, d.y + d.height / 2);
    });

    const found = game.run.goldens[level.index];
    level.goldens.forEach((g, i) => {
        if (!found.has(i) && visible(g.x - 9)) drawAnim(ctx, 'items', 'golden', time + g.x * 0.01, g.x, g.y);
    });

    lv.squirrels.forEach(s => {
        if (!visible(s.x)) return;
        const name = s.defeated ? (s.defeatTime < 0.25 ? 'squished' : 'poof') : s.state;
        const t = s.defeated ? (s.defeatTime < 0.25 ? s.defeatTime : s.defeatTime - 0.25) : s.animTime;
        // gang sheet faces left
        drawAnim(ctx, 'gang_effects', name, t, s.x + s.width / 2, s.y + s.height, s.dir > 0);
    });

    // Story: intro thief + Wubby's treat jar, chase thief, dropped treat
    if (game.screen === 'intro' && game.intro) {
        const it = game.intro;
        drawAnim(ctx, 'items', 'jarOpen', 0, it.jar.x, it.jar.y);
        if (!it.hasTreat) drawAnim(ctx, 'items', 'treat', time, it.treat.x, it.treat.y);
        if (it.phase !== 'wait') drawThief(it.thief, 'intro'); // its run frames carry the treat
    }
    if (lv.chase && game.screen !== 'ending') drawThief(lv.chase.thief, 'chase');
    if (game.ending) {
        const e = game.ending;
        drawThief(e.thief, 'ending');
        if (e.treat) drawAnim(ctx, 'items', 'treat', time, e.treat.x + e.treat.width / 2, e.treat.y + e.treat.height / 2);
    }

    drawWubby(lv.player);

    if (game.ending && game.ending.phase === 'wag') {
        const p = lv.player;
        ctx.font = `12px ${PIXEL_FONT}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Math.round(p.x - 14), Math.round(p.y - 34), 50, 16);
        ctx.fillStyle = '#2a2a40';
        ctx.fillText('WOOF!', Math.round(p.x + p.width / 2), Math.round(p.y - 22));
    }

    game.effects.forEach(f => drawAnim(ctx, f.sheet, f.name, f.t, f.x, f.y, f.flip));
    game.particles.forEach(pt => {
        ctx.globalAlpha = Math.min(1, pt.life / 0.25);
        ctx.fillStyle = pt.color;
        ctx.fillRect(Math.round(pt.x) - 1, Math.round(pt.y) - 1, 2, 2);
    });
    ctx.globalAlpha = 1;
    ctx.restore();
}

function drawBanner() {
    const b = game.banner;
    if (!b) return;
    const W = view.width;
    ctx.textAlign = 'center';
    ctx.font = `600 18px ${PIXEL_FONT}`;
    const y = Math.round(Math.max(80, view.height * 0.32));
    ctx.fillStyle = 'rgba(40, 22, 12, 0.5)';
    ctx.fillRect(0, y - 22, W, b.sub ? 48 : 32);
    ctx.fillStyle = '#ffd84a';
    ctx.fillText(b.text, Math.round(W / 2), y);
    if (b.sub) {
        ctx.font = `11px ${PIXEL_FONT}`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(b.sub, Math.round(W / 2), y + 17);
    }
    if (game.screen === 'intro') {
        ctx.font = `10px ${PIXEL_FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText('PRESS JUMP TO SKIP', Math.round(W / 2), view.height - 20);
    }
}

function draw() {
    drawBackground();
    if (game.lv) {
        drawWorld();
        drawBanner();
    }
}

// ---------- HUD ----------
const hudCache = {};
function setHud(id, value, html = false) {
    if (hudCache[id] === value) return;
    hudCache[id] = value;
    if (html) $(id).innerHTML = value; else $(id).textContent = value;
}

function updateHud(dt) {
    if (!game.run || !game.lv) return;
    const run = game.run;
    const heartSlots = Math.max(CONFIG.health.startHearts, run.hearts);
    let hearts = '';
    for (let i = 0; i < heartSlots; i++) hearts += `<span class="${i < run.hearts ? 'ui-icon-heart' : 'ui-icon-heart-empty'}"></span>`;
    setHud('hearts', hearts, true);
    setHud('bones', `${heldCount()}/${game.lv.level.bones.length}`);
    setHud('goldens', `${goldenTotal()}/${TOTAL_GOLDENS}`);
    const muted = save.data.muted;
    if (hudCache.muted !== muted) {
        hudCache.muted = muted;
        $('muteBtn').className = `icon-btn ${muted ? 'ui-btn-sound-off' : 'ui-btn-sound-on'}`;
    }
    updateJourney(dt);
}

// Overall progress: (completed levels + player x / level end x) / number of levels
function journeyTarget() {
    const { run, lv } = game;
    const n = levels.length;
    if (game.screen === 'ending' || game.screen === 'card') return 1;
    if (game.screen === 'complete') return (run.levelIndex + 1) / n;
    const level = lv.level;
    const startX = level.start.x;
    const endX = level.exit ? level.exit.x : level.pixelWidth - T * 2;
    const frac = Math.max(0, Math.min(1, (lv.player.x - startX) / (endX - startX)));
    return (run.levelIndex + frac) / n;
}

function updateJourney(dt) {
    // Exponential ease: smooth, and never overshoots the real position (also when moving back after a respawn)
    const target = journeyTarget();
    game.journey += (target - game.journey) * Math.min(1, dt * 6);
    if (Math.abs(target - game.journey) < 0.0005) game.journey = target;
    const pct = (game.journey * 100).toFixed(2) + '%';
    if (hudCache.journey !== pct) {
        hudCache.journey = pct;
        $('journeyFill').style.width = pct;
        $('journeyFill').classList.toggle('hidden', game.journey < 0.01);
        $('journeyWubby').style.left = pct;
    }
    const chasing = !!game.lv.chase && game.screen !== 'ending';
    if (hudCache.chasing !== chasing) {
        hudCache.chasing = chasing;
        $('journeyThief').className = `journey-thief ${chasing ? 'ui-bar-thief-pulse pulsing' : 'ui-bar-thief'}`;
    }
}

// Dividers and level numbers for the journey bar, one segment per level
function buildJourney() {
    const n = Math.max(1, levels.length);
    let dividers = '';
    for (let i = 1; i < n; i++) dividers += `<span class="journey-divider ui-bar-divider" style="left: ${(i * 100 / n).toFixed(3)}%"></span>`;
    $('journeyInner').insertAdjacentHTML('beforeend', dividers);
    $('journeyLabels').innerHTML = levels.map((_, i) => `<span>${i + 1}</span>`).join('');
}
buildJourney();

function renderTitleStats() {
    const s = save.data;
    $('titleBest').classList.toggle('hidden', s.bestTime == null);
    $('titleBestText').textContent = s.bestTime == null ? '' : `Best ${formatTime(s.bestTime)} · ${s.maxGoldens}/${TOTAL_GOLDENS} golden bones`;
    if (levelError) {
        $('levelError').textContent = 'Level error: ' + levelError;
        $('levelError').classList.remove('hidden');
        $('playBtn').disabled = true;
    }
}

// ---------- Main loop (fixed timestep) ----------
let lastTime = null;
let accumulator = 0;

function gameLoop(now) {
    if (lastTime === null) lastTime = now;
    const frameTime = Math.min((now - lastTime) / 1000, CONFIG.maxFrameTime);
    accumulator += frameTime;
    lastTime = now;
    while (accumulator >= CONFIG.fixedStep) {
        update(CONFIG.fixedStep);
        accumulator -= CONFIG.fixedStep;
    }
    updateHud(frameTime);
    draw();
    requestAnimationFrame(gameLoop);
}

function onAssetsLoaded() {
    prepareBackgrounds();
    setScreen('title');
    document.body.classList.add('ready');
    requestAnimationFrame(gameLoop);
}

loadArt(onAssetsLoaded);
