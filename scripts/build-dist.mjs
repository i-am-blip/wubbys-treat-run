// Production build: dist/ with content-hashed, long-cacheable assets.
//   - every image, font and audio file used at runtime is copied as name.<hash>.ext under dist/assets/
//   - window.ASSET_MAP maps each file name to its hashed URLs (WebP first, then the PNG / JPG fallback)
//   - the classic scripts are concatenated in page order into one minified bundle; ui.css + style.css into one CSS
//   - index.html points at the hashed files; og-image.jpg, favicon, CREDITS.md and robots.txt keep stable names
// Source files are never modified. assets/raw/ (the art sources) is never deployed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const GAME = 'public/assets/game';
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });

// ---------------------------------------------------------------- hashed copies
const emitted = new Map(); // source path -> /assets/... URL
function emit(src) {
    if (emitted.has(src)) return emitted.get(src);
    const buf = read(src);
    const rel = src.startsWith(GAME + '/') ? 'game/' + src.slice(GAME.length + 1) : src.replace(/^public\/assets\//, '');
    const ext = path.extname(rel);
    const out = `assets/${rel.slice(0, -ext.length)}.${hash(buf)}${ext}`;
    fs.mkdirSync(path.join(DIST, path.dirname(out)), { recursive: true });
    fs.writeFileSync(path.join(DIST, out), buf);
    emitted.set(src, '/' + out);
    return '/' + out;
}

// Files the game loads by name (art.js / audio.js), from the generated manifest
const manifestSrc = read(`${GAME}/manifest.js`).toString();
const manifest = JSON.parse(manifestSrc.slice(manifestSrc.indexOf('{'), manifestSrc.lastIndexOf('}') + 1));
const runtimeFiles = new Set(['title_bg.png', 'title_mobile.png', 'card_photo.jpg', 'card_photo_gold.jpg']);
for (const [key, m] of Object.entries(manifest)) {
    if (key === 'ui') continue; // the UI atlas is only a build input; the CSS uses the ui/ pieces
    if (m.image) runtimeFiles.add(m.image);
    if (m.layers) m.layers.slice(0, -1).forEach(l => runtimeFiles.add(l.image)); // the near layer isn't drawn
    if (m.ogg) { runtimeFiles.add(m.ogg); runtimeFiles.add(m.mp3); }
}
const ASSET_MAP = {};
for (const f of runtimeFiles) {
    const src = `${GAME}/${f}`;
    if (!exists(src)) throw new Error(`missing runtime asset ${src}`);
    const webp = src.replace(/\.(png|jpg)$/, '.webp');
    ASSET_MAP[f] = [...(webp !== src && exists(webp) ? [emit(webp)] : []), emit(src)];
}

// ---------------------------------------------------------------- CSS: ui.css + style.css, url()s rewritten
function rewriteUrls(css, fromDir) {
    return css.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, u) => {
        if (/^(data:|https?:|#)/.test(u)) return m;
        const src = path.posix.normalize(path.posix.join(fromDir, u));
        if (!exists(src)) throw new Error(`CSS url not found: ${u} (from ${fromDir})`);
        return `url("${emit(src)}")`;
    });
}
const cssSource = rewriteUrls(read(`${GAME}/ui.css`).toString(), GAME) + '\n' + rewriteUrls(read('style.css').toString(), '.');
const css = (await transform(cssSource, { loader: 'css', minify: true, target: ['chrome100', 'safari15', 'firefox100'] })).code;
const cssUrl = `/assets/app.${hash(Buffer.from(css))}.css`;
fs.writeFileSync(path.join(DIST, cssUrl), css);

// ---------------------------------------------------------------- JS: classic scripts in page order, one bundle
const html = read('index.html').toString();
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
if (!scripts.length) throw new Error('no scripts found in index.html');
// Whitespace + syntax minification only: the scripts share globals, so names are kept
// The manifest goes in without the UI atlas metadata (only the build uses it)
const runtimeManifest = { ...manifest };
delete runtimeManifest.ui;
delete runtimeManifest.ui_slices;
const source = (s) => (s === `${GAME}/manifest.js` ? `window.ART_MANIFEST=${JSON.stringify(runtimeManifest)};` : read(s));
const jsSource = `window.ASSET_MAP=${JSON.stringify(ASSET_MAP)};\n` + scripts.map(s => `// ${s}\n${source(s)}`).join('\n;\n');
const js = (await transform(jsSource, { loader: 'js', minifyWhitespace: true, minifySyntax: true, target: 'es2020', legalComments: 'none' })).code;
const jsUrl = `/assets/app.${hash(Buffer.from(js))}.js`;
fs.writeFileSync(path.join(DIST, jsUrl), js);

// ---------------------------------------------------------------- stable-name files
fs.copyFileSync(path.join(ROOT, GAME, 'og_image.jpg'), path.join(DIST, 'og-image.jpg'));
fs.copyFileSync(path.join(ROOT, 'CREDITS.md'), path.join(DIST, 'CREDITS.md'));
fs.writeFileSync(path.join(DIST, 'robots.txt'), 'User-agent: *\nAllow: /\n');

// ---------------------------------------------------------------- index.html
const webpOf = (f) => ASSET_MAP[f][0];
let page = html
    .replace(/\s*<script src="[^"]+"><\/script>/g, '')
    .replace(/\s*<link rel="stylesheet" href="[^"]+">/g, '')
    .replace('</head>', `    <link rel="stylesheet" href="${cssUrl}">\n</head>`)
    .replace('</body>', `    <script src="${jsUrl}"></script>\n</body>`)
    .replace('href="public/assets/fonts/pixelify-sans-latin.woff2"', `href="${emit('public/assets/fonts/pixelify-sans-latin.woff2')}"`)
    .replace('href="public/assets/game/title_mobile.png" as="image"', `href="${webpOf('title_mobile.png')}" as="image" type="image/webp"`)
    .replace('href="public/assets/game/title_bg.png" as="image"', `href="${webpOf('title_bg.png')}" as="image" type="image/webp"`)
    .replaceAll('href="public/assets/game/favicon.png"', `href="${emit(`${GAME}/favicon.png`)}"`)
    .replace(/<img class="logo" src="public\/assets\/game\/logo.png"([^>]*)>/,
        `<picture><source srcset="${emit(`${GAME}/logo.webp`)}" type="image/webp"><img class="logo" src="${emit(`${GAME}/logo.png`)}" width="212" height="89"$1></picture>`);
const leftover = page.match(/(?:src|href)="(?!https?:|\/|#)[^"]+"/g);
if (leftover) throw new Error('unrewritten references in index.html: ' + leftover.join(', '));
fs.writeFileSync(path.join(DIST, 'index.html'), page);

// ---------------------------------------------------------------- report
let total = 0, count = 0;
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else { total += fs.statSync(p).size; count++; } } })(DIST);
console.log(`dist: ${count} files, ${(total / 1024 / 1024).toFixed(2)} MB (JS ${(js.length / 1024).toFixed(0)} KB, CSS ${(css.length / 1024).toFixed(0)} KB)`);
