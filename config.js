// All gameplay tunables live here. Units: pixels (logical), seconds.
const CONFIG = {
    scale: 1.7,            // target CSS px per game pixel; snapped to whole device pixels (~38% more world than 2)
    tileSize: 18,
    fixedStep: 1 / 60,     // physics timestep; identical speed on 60/120/144Hz screens
    maxFrameTime: 0.25,    // clamp long frames (tab switches) so physics never explodes

    player: {
        width: 22,         // hitbox; Wubby's sprite is drawn bottom-centered on it
        height: 22,
        moveSpeed: 150,
        gravity: 1800,
        maxFallSpeed: 600,
        jumpVelocity: 520,        // full jump: ~4 tiles high, ~4.8 tiles far at full speed
        jumpCutMultiplier: 0.5,   // releasing jump early cuts upward speed
        coyoteTime: 0.1,
        jumpBufferTime: 0.1,
        stompBounce: 380,
        knockbackSpeed: 170,
        knockbackTime: 0.2
    },

    health: {
        startHearts: 3,
        maxHearts: 5,
        invincibleTime: 1.2,
        respawnDelay: 0.6,        // pause after a spike/gap hit before respawning at the checkpoint
        levelRestartDelay: 1.6    // pause after losing the last heart
    },

    bones: {
        perHeart: 25,             // every N bones collected = +1 heart (up to maxHearts)
        streakWindow: 0.5,        // pickups within this many seconds raise the pickup note
        streakSteps: 8,           // pentatonic steps before the pitch stops rising
        streakBaseFreq: 523.25    // first note (C5)
    },

    droppedBones: {
        max: 5,                   // a hit drops min(max, bones held in this level)
        lifetime: 3,
        blinkTime: 1,             // blink during the last N seconds
        pickupDelay: 0.5,         // can't be re-collected immediately
        speedX: [60, 160],
        speedY: [200, 320],
        bounce: 0.45,
        groundFriction: 4,        // horizontal slowdown per second while on the ground
        size: 10
    },

    assist: {
        bucketSize: 200,          // deaths are grouped into horizontal buckets of this many pixels
        deathThreshold: 3,        // deaths in one bucket before the quiet assist kicks in
        widenTiles: 1,            // gap-adjacent platforms grow by this much toward the gap
        trailAlpha: 0.45,         // the extra bone trail is drawn faintly
        trailSpacing: 5           // physics steps between assist-trail bones
    },

    squirrel: {
        width: 18,
        height: 16,
        speed: 40,
        idleTime: 0.5,            // pause at each end of the patrol
        turnTime: 0.2,
        alertDistance: 70,        // startles once when Wubby gets this close
        alertTime: 0.4
    },

    thief: {
        width: 18,
        height: 16,
        introSpeed: 220,          // intro: runs in, grabs the treat, runs off
        introDistance: 280,       // where the thief starts, to the right of Wubby
        introGrabPause: 0.5,
        introExitTime: 1.3,
        chaseSpeed: 120,          // a bit slower than Wubby (player.moveSpeed)
        triggerDistance: 230,     // chase starts when Wubby is this close to the 'T' tile
        respawnBehind: 54         // after a fall in the chase, Wubby reappears this far behind the thief
    },

    spikeHitbox: { inset: 3, top: 8 }, // spikes only hurt on their pointy lower part

    pickupRadius: 16,
    fallMargin: 40,                    // pixels below the level before a fall counts
    levelCompleteTime: 2.2,
    camera: { leadRatio: 0.35, smoothing: 10 },

    card: {
        width: 1080,       // the shared image is just the polaroid, portrait
        height: 1350,
        // Production URL printed on the polaroid and used in share links. When empty, the page's own URL is
        // used only if it is a real site (never localhost or file://); otherwise no URL is shown.
        siteUrl: ''
    },

    // Creator credit on the end screen. A link whose URL is empty is hidden.
    creator: {
        name: 'Dev Mehta',
        tagline: 'Product designer who ships. Open to roles and freelance work.',
        linkedinUrl: 'https://www.linkedin.com/in/dev-mehtaa',
        portfolioUrl: 'https://www.devmehtaa.in/'
    },

    // "Send Wubby some love" and CTA counters: serverless routes in netlify/functions (see SETUP.md)
    api: { love: '/api/love', ctaClick: '/api/cta-click' },

    storageKey: 'wubby-save-v1',
    loveKey: 'wubby-love-v1'   // one love per browser
};
