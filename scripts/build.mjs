// Build the single-file program for this computer's platform: dist/tutordesk(.exe).
//
// 1. esbuild bundles src/ and its dependencies into one CommonJS file.
// 2. Skills and templates (with fonts) go in as assets; `tutordesk install` unpacks them.
// 3. Node's single-executable support turns that into a blob, which postject injects into a copy of
//    the Node binary running this script.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

await build({
  entryPoints: [path.join(root, 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: path.join(dist, 'tutordesk.cjs'),
  // A CommonJS bundle has no import.meta.url; the Claude Agent SDK needs one when it loads.
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'warning',
});

const files = [];
const walk = (rel) => {
  for (const name of readdirSync(path.join(root, rel))) {
    const r = `${rel}/${name}`;
    if (statSync(path.join(root, r)).isDirectory()) walk(r);
    else if (!name.endsWith('.pdf') || r.includes('/licenses/')) files.push(r);
  }
};
walk('skills');
walk('templates');
writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(files));

const blob = path.join(dist, 'sea.blob');
writeFileSync(
  path.join(dist, 'sea-config.json'),
  JSON.stringify({
    main: path.join(dist, 'tutordesk.cjs'),
    output: blob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    assets: { 'manifest.json': path.join(dist, 'manifest.json'), ...Object.fromEntries(files.map((f) => [f, path.join(root, f)])) },
  }),
);
execFileSync(process.execPath, ['--experimental-sea-config', path.join(dist, 'sea-config.json')], { stdio: 'inherit' });

const exe = path.join(dist, win ? 'tutordesk.exe' : 'tutordesk');
copyFileSync(process.execPath, exe);
if (mac) execFileSync('codesign', ['--remove-signature', exe]);
const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(process.execPath, [postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(mac ? ['--macho-segment-name', 'NODE_SEA'] : [])], { stdio: 'inherit' });
if (mac) execFileSync('codesign', ['--sign', '-', exe]);
for (const f of ['tutordesk.cjs', 'sea.blob', 'sea-config.json', 'manifest.json']) rmSync(path.join(dist, f));
console.log(`Built ${path.relative(root, exe)} (${Math.round(statSync(exe).size / 1e6)} MB, ${files.length} files inside)`);
