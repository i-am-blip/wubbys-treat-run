// Sound: a tiny Web Audio synth for the effects, plus the looping background music, on ONE AudioContext.
// Graph: music source -> duck (start / pause / jingles / tab hidden) -> music gain -> master
//        effects -> sfx gain -> master -> speakers.   master = 0 when muted (saved).
// The context is created and resumed on the first user gesture (autoplay rules). The music file is fetched once
// the title is interactive, but the music itself only starts when the player presses Play (1s fade-in); it then
// loops across the levels and the end screen, and fades out again back on the title screen.
// Levels were measured offline (see the commit): jump, bone and hazard peak ~6dB above the music's peak.

const AUDIO = {
    musicVolume: 0.25,
    sfxVolume: 4,     // +12dB: the voices below are authored small; this lifts them clearly over the music
    duck: 0.5,        // music level while paused or while a jingle plays
    restore: 0.5,     // seconds to fade back after a duck, or in after the tab returns
    fadeIn: 1         // seconds for the music to come in after Play
};

const sound = {
    ctx: null,
    nodes: null,
    music: { data: null, format: null, buffer: null, source: null, loading: null },
    state: { wanted: false, paused: false, hidden: false, jingleUntil: 0 },

    // The node graph on a context (also used with an OfflineAudioContext to measure levels)
    graph(ctx) {
        const gain = (value, to) => { const g = ctx.createGain(); g.gain.value = value; g.connect(to); return g; };
        // No compressor on the master: its look-ahead swallows the attack of short blips. Headroom is kept by the
        // levels themselves instead (loudest jingle peak stays below -1 dBFS over the ducked music).
        const master = gain(save.data.muted ? 0 : 1, ctx.destination);
        const musicBus = gain(AUDIO.musicVolume, master);
        return { master, musicBus, sfx: gain(AUDIO.sfxVolume, master), duck: gain(0, musicBus) };
    },

    // First user gesture: create / resume the one context. Effects work from here on; music waits for Play.
    unlock() {
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            this.ctx = new AC();
            this.nodes = this.graph(this.ctx);
        }
        if (this.ctx.state !== 'running' && !this.state.hidden) {
            this.ctx.resume().catch(() => {});
            // iOS Safari only unlocks once something plays inside the gesture: a one-sample silent buffer
            const src = this.ctx.createBufferSource();
            src.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
            src.connect(this.ctx.destination);
            src.start(0);
        }
        if (this.state.wanted) this.startMusic();
    },

    // Play pressed: bring the music in (from the top if it was stopped)
    musicOn() {
        this.state.wanted = true;
        clearTimeout(this.stopTimer);
        this.unlock();
        if (this.music.source) this.musicLevel(AUDIO.fadeIn);
    },

    // Back on the title screen: fade out, then stop
    musicOff() {
        if (!this.state.wanted) return;
        this.state.wanted = false;
        this.musicLevel(AUDIO.restore);
        clearTimeout(this.stopTimer);
        this.stopTimer = setTimeout(() => {
            if (this.state.wanted || !this.music.source) return;
            this.music.source.stop();
            this.music.source = null;
        }, AUDIO.restore * 1000 + 100);
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
        osc.connect(gain).connect(this.nodes.sfx);
        osc.start(t);
        osc.stop(t + duration);
    },

    // tone() with extras: a soft attack, a lowpass (muffled), and a pitch wobble (LFO depth in Hz)
    voice({ freq, endFreq = freq, duration, type = 'square', volume = 0.06, delay = 0, attack = 0, lowpass = 0, wobble = 0 }) {
        if (save.data.muted || !this.ctx) return;
        const c = this.ctx;
        const t = c.currentTime + delay;
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration);
        if (wobble) {
            const lfo = c.createOscillator();
            const depth = c.createGain();
            lfo.frequency.value = 22;
            depth.gain.value = wobble;
            lfo.connect(depth).connect(osc.frequency);
            lfo.start(t);
            lfo.stop(t + duration);
        }
        gain.gain.setValueAtTime(attack ? 0.0001 : volume, t);
        if (attack) gain.gain.exponentialRampToValueAtTime(volume, t + attack);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
        let out = osc;
        if (lowpass) {
            const f = c.createBiquadFilter();
            f.type = 'lowpass';
            f.frequency.value = lowpass;
            osc.connect(f);
            out = f;
        }
        out.connect(gain).connect(this.nodes.sfx);
        osc.start(t);
        osc.stop(t + duration);
    },

    // ----- Effects. Volumes are balanced (measured offline) so every blip peaks at about -5.5 dBFS, ~6dB above
    // the music's peak; the click stays quieter. -----
    jump() { this.tone(300, 600, 0.12, 'square', 0.14); },
    bone(step) {
        const f = CONFIG.bones.streakBaseFreq * Math.pow(2, PENTATONIC[step] / 12);
        this.tone(f, f * 1.02, 0.09, 'square', 0.14);
    },
    golden() { [0, 0.08, 0.16].forEach((d, i) => this.tone(700 + i * 250, 1000 + i * 300, 0.12, 'square', 0.13, d)); },
    heart() { [0, 0.1].forEach((d, i) => this.tone(500 + i * 300, 800 + i * 300, 0.15, 'triangle', 0.13, d)); },
    stomp() { this.tone(400, 80, 0.15, 'triangle', 0.14); },
    hurt() { this.tone(300, 90, 0.3, 'sawtooth', 0.14); },
    checkpoint() { [0, 0.1, 0.2].forEach((d, i) => this.tone(400 + i * 200, 420 + i * 200, 0.1, 'square', 0.13, d)); },
    thief() { [0, 0.09, 0.18].forEach((d, i) => this.tone(900 - i * 150, 700 - i * 150, 0.08, 'square', 0.13, d)); },
    munch() { [0, 0.12, 0.24].forEach(d => this.tone(180, 60, 0.07, 'square', 0.14, d)); },
    bark() { this.tone(520, 260, 0.12, 'sawtooth', 0.14); this.tone(560, 280, 0.14, 'sawtooth', 0.14, 0.18); },
    fail() { this.tone(400, 60, 0.7, 'sawtooth', 0.13); },
    // Hazard hit: short descending "ouch" with a quick wobble, muffled so it isn't harsh
    ouch() { this.voice({ freq: 620, endFreq: 240, duration: 0.25, volume: 0.115, lowpass: 1500, wobble: 45 }); },
    // Falling into a gap during the chase (outside it, gaps use hurt())
    fall() { this.voice({ freq: 900, endFreq: 220, duration: 0.32, type: 'triangle', volume: 0.13 }); },
    // Buttons
    click() { this.voice({ freq: 880, endFreq: 1180, duration: 0.05, type: 'triangle', volume: 0.05 }); },

    // ----- Jingles (duck the music while they play) -----
    // Level complete: C E G C' E' rising, ending on a bright held note (~1.5s)
    levelJingle() {
        const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
        notes.forEach((f, i) => {
            const last = i === notes.length - 1;
            const at = i * 0.13 + (last ? 0.03 : 0);
            const len = last ? 0.95 : 0.16;
            this.voice({ freq: f, duration: len, volume: 0.1, delay: at, lowpass: 3200 });
            this.voice({ freq: f / 2, duration: len, type: 'triangle', volume: 0.083, delay: at });
        });
        this.jingle(1.5);
    },
    // Game win (~3s): a rising run, a short melodic phrase, then a sparkle chord
    winFanfare() {
        const C5 = 523.25, D5 = 587.33, E5 = 659.25, F5 = 698.46, G5 = 783.99, A5 = 880, B5 = 987.77;
        const C6 = 1046.5, D6 = 1174.66, E6 = 1318.5, G6 = 1567.98, C7 = 2093;
        [C5, D5, E5, F5, G5, A5, B5, C6].forEach((f, i) => this.voice({ freq: f, duration: 0.09, volume: 0.06, delay: i * 0.055, lowpass: 3500 }));
        [[G5, 0.5, 0.16], [C6, 0.68, 0.16], [E6, 0.86, 0.26], [D6, 1.14, 0.14], [E6, 1.3, 0.14], [G6, 1.46, 0.34]]
            .forEach(([f, at, len]) => {
                this.voice({ freq: f, duration: len, volume: 0.072, delay: at, lowpass: 3500 });
                this.voice({ freq: f / 2, duration: len, type: 'triangle', volume: 0.048, delay: at });
            });
        [C6, E6, G6, C7].forEach(f => this.voice({ freq: f, duration: 1.1, type: 'triangle', volume: 0.054, delay: 1.9, attack: 0.02 }));
        this.voice({ freq: C5, duration: 1.1, volume: 0.042, delay: 1.9, lowpass: 2000 });
        [4186, 3136, 5274, 4186, 6272].forEach((f, i) => this.voice({ freq: f, endFreq: f * 1.01, duration: 0.07, type: 'triangle', volume: 0.03, delay: 2.0 + i * 0.12 }));
        this.jingle(3.1);
    },

    // ----- Music -----
    // Fetch the encoded loop (OGG where supported, else MP3); decoding waits for the audio context
    preloadMusic() {
        const m = art.meta.music;
        if (!m || this.music.loading || location.protocol === 'file:') return;
        const probe = document.createElement('audio');
        const ogg = probe.canPlayType && probe.canPlayType('audio/ogg; codecs="vorbis"');
        const get = (format) => fetch(assetUrls(m[format])[0]).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
            .then(data => { this.music.data = data; this.music.format = format; });
        this.music.loading = (ogg ? get('ogg').catch(() => get('mp3')) : get('mp3')).catch(() => null);
        this.music.loading.then(() => { if (this.ctx && this.state.wanted) this.startMusic(); });
    },

    async startMusic() {
        const m = this.music;
        if (!this.ctx || !this.state.wanted || m.source || m.starting || !m.data) return;
        m.starting = true;
        try {
            const decode = (data) => new Promise((resolve, reject) => this.ctx.decodeAudioData(data.slice(0), resolve, reject));
            try {
                if (!m.buffer) m.buffer = await decode(m.data);
            } catch (e) {
                if (m.format !== 'ogg') throw e;
                await fetch(assetUrls(art.meta.music.mp3)[0]).then(r => r.arrayBuffer()).then(d => { m.data = d; m.format = 'mp3'; });
                m.buffer = await decode(m.data);
            }
            // Some decoders add a few samples of padding at the start: loop from the first audible sample
            const ch = m.buffer.getChannelData(0);
            let offset = 0;
            while (offset < Math.min(ch.length, 4096) && Math.abs(ch[offset]) < 1e-4) offset++;
            const src = this.ctx.createBufferSource();
            src.buffer = m.buffer;
            src.loop = true;
            src.loopStart = offset / m.buffer.sampleRate;
            src.loopEnd = Math.min(m.buffer.duration, src.loopStart + art.meta.music.loopSeconds);
            src.connect(this.nodes.duck);
            src.start(0, src.loopStart);
            m.source = src;
            this.musicLevel(AUDIO.fadeIn);
        } catch (e) {
            console.warn('Music unavailable', e);
        } finally {
            m.starting = false;
        }
    },

    // Fade the music to where it should be: silent while the tab is hidden, ducked while paused or during a jingle
    musicLevel(fade = AUDIO.restore) {
        if (!this.ctx || !this.music.source) return;
        const t = this.ctx.currentTime;
        const s = this.state;
        const target = !s.wanted || s.hidden ? 0 : (s.paused || t < s.jingleUntil - 0.01 ? AUDIO.duck : 1);
        const g = this.nodes.duck.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(target, t + fade);
    },

    jingle(duration) {
        if (!this.ctx) return;
        this.state.jingleUntil = this.ctx.currentTime + duration;
        this.musicLevel(0.08);
        clearTimeout(this.jingleTimer);
        this.jingleTimer = setTimeout(() => this.musicLevel(AUDIO.restore), duration * 1000);
    },

    setPaused(paused) {
        if (this.state.paused === paused) return;
        this.state.paused = paused;
        this.musicLevel(paused ? 0.2 : AUDIO.restore);
    },

    // Tab hidden or phone locked: fade out, then suspend the whole context; on return resume and fade back in
    setHidden(hidden) {
        this.state.hidden = hidden;
        if (!this.ctx) return;
        clearTimeout(this.suspendTimer);
        if (hidden) {
            this.musicLevel(0.3);
            this.suspendTimer = setTimeout(() => { if (this.state.hidden) this.ctx.suspend().catch(() => {}); }, 350);
        } else {
            this.ctx.resume().catch(() => {}).then(() => this.musicLevel(AUDIO.restore));
        }
    },

    // Mute covers music and effects together (save.data.muted is persisted by toggleMute)
    applyMute() {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const g = this.nodes.master.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(save.data.muted ? 0 : 1, t + 0.08);
    }
};

// Pause menu credit, read from CREDITS.md ("- Artist: …", "- Title: …"); hidden until the artist is filled in
function loadMusicCredit() {
    if (location.protocol === 'file:') return;
    fetch('CREDITS.md').then(r => (r.ok ? r.text() : '')).then(md => {
        const music = md.split(/^## /m).find(s => s.startsWith('Music')) || '';
        const field = (name) => {
            const line = music.split('\n').find(l => l.startsWith(`- ${name}:`));
            const v = line ? line.slice(name.length + 3).trim() : '';
            return v && !v.startsWith('[') ? v : '';
        };
        const artist = field('Artist'), title = field('Title');
        if (!artist) return;
        $('musicCredit').textContent = `Music by ${artist}` + (title ? ` · ${title}` : '');
        $('musicCredit').classList.remove('hidden');
    }).catch(() => {});
}

// The first input anywhere (tap, click or key) unlocks the audio. iOS only accepts some of these as a gesture,
// so the listeners stay until the context is actually running.
const UNLOCK_EVENTS = ['pointerdown', 'touchend', 'click', 'keydown'];
function unlockOnGesture() {
    sound.unlock();
    if (sound.ctx && sound.ctx.state === 'running') UNLOCK_EVENTS.forEach(t => window.removeEventListener(t, unlockOnGesture, true));
}
UNLOCK_EVENTS.forEach(t => window.addEventListener(t, unlockOnGesture, true));
window.addEventListener('pagehide', () => sound.setHidden(true));
window.addEventListener('pageshow', () => { if (!document.hidden) sound.setHidden(false); });
