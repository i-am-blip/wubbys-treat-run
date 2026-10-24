// Syntax check for every JavaScript file in the project (the game is plain classic scripts: no compiler step).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const skip = new Set(['node_modules', 'dist', '.git', '.venv', '.vercel', 'assets']);
const files = [];
(function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) { if (!skip.has(f)) walk(p); }
        else if (/\.(m?js)$/.test(f)) files.push(p);
    }
})('.');
let failed = 0;
for (const f of files) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { failed++; console.error(String(e.stderr || e.message)); }
}
console.log(`${files.length} files checked, ${failed} with syntax errors`);
process.exitCode = failed ? 1 : 0;
