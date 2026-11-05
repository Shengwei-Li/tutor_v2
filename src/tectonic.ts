import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exists, run } from './proc.ts';
import { TEMPLATES, compile, findEngine, tectonicHome, type Edition } from './tex.ts';

/**
 * Tectonic for tutors with no TeX: the pinned release, checked against its SHA-256, and an offline
 * cache of exactly the packages and fonts the templates use, so PDFs come out the same everywhere and
 * need no network after setup.
 */
const VERSION = '0.17.0';
const ASSETS: Record<string, { name: string; sha256: string }> = {
  'win32-x64': { name: 'x86_64-pc-windows-msvc.zip', sha256: 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f' },
  'darwin-arm64': { name: 'aarch64-apple-darwin.tar.gz', sha256: 'a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667' },
  'darwin-x64': { name: 'x86_64-apple-darwin.tar.gz', sha256: '7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80' },
  'linux-x64': { name: 'x86_64-unknown-linux-gnu.tar.gz', sha256: '1a715688baf591e650c8aeb160ae934e181685eecbb38b317de30b269ac5d606' },
};
/** Tectonic's default bundle (TeX Live 2022) as of 0.17.0; the cache must come from exactly this one. */
const BUNDLE_DIGEST = '6ffe055852f8faf66c0acbe1a7fb27f87b869a90bad1204f3bf4d9683f597c7c';

const target = `${process.platform}-${process.arch}`;
const exe = process.platform === 'win32' ? 'tectonic.exe' : 'tectonic';

/** Download Tectonic and fill its cache, unless a TeX engine is already there. Reports progress. */
export async function setupTectonic(say: (line: string) => void = () => {}): Promise<void> {
  if ((await findEngine())?.kind === 'tectonic') return;
  const asset = ASSETS[target];
  if (!asset) throw new Error(`TutorDesk has no TeX engine for ${target} yet. Install TeX Live and try again.`);
  const home = tectonicHome();
  const binary = path.join(home, 'bin', target, exe);
  const cacheDir = path.join(home, 'cache');

  if (!(await exists(binary))) {
    const file = `tectonic-${VERSION}-${asset.name}`;
    say(`Downloading Tectonic ${VERSION}…`);
    const res = await fetch(`https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}/${file}`);
    if (!res.ok) throw new Error(`Could not download Tectonic (HTTP ${res.status}).`);
    const data = Buffer.from(await res.arrayBuffer());
    const sha = createHash('sha256').update(data).digest('hex');
    if (sha !== asset.sha256) throw new Error(`The Tectonic download does not match its checksum (${sha}); nothing was installed.`);
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'tectonic-'));
    try {
      await writeFile(path.join(tmp, file), data);
      // bsdtar reads both zip and tar.gz. On Windows name the system one: Git's GNU tar may come first on PATH.
      const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      const r = await run(tar, ['-xf', file], { cwd: tmp, timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error(`Could not unpack Tectonic: ${r.output.trim()}`);
      await mkdir(path.dirname(binary), { recursive: true });
      await cp(path.join(tmp, exe), binary);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  // Compile every document type once online, so the cache holds everything; then prove it offline.
  const engine = { kind: 'tectonic' as const, binary, cacheDir };
  for (const online of [true, false]) {
    say(online ? 'Fetching the fonts and packages the materials use (once)…' : 'Checking that PDFs work offline…');
    for (const job of warmJobs()) {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tectonic-warm-'));
      try {
        await cp(path.join(TEMPLATES, 'samples', 'lesson-peel.tex'), path.join(dir, 'lesson-peel.tex'));
        let body = await readFile(path.join(TEMPLATES, 'samples', `${job.sample}.tex`), 'utf8');
        if (job.theme) body = body.replace(/\\usetheme\{[^}]*\}/, `\\usetheme{${job.theme}}`);
        await writeFile(path.join(dir, 'doc.tex'), body);
        const r = await compile(path.join(dir, 'doc.tex'), job.edition, { engine, online, timeoutMs: 300_000 });
        if (!r.ok) throw new Error(`${job.sample}${job.theme ? ` (${job.theme})` : ''} did not compile ${online ? 'while fetching' : 'offline'}: ${r.errors[0]?.message ?? 'unknown error'}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    if (online && !(await exists(path.join(cacheDir, 'bundles', 'data', BUNDLE_DIGEST)))) {
      throw new Error("The downloaded packages are not from the bundle TutorDesk was tested with (Tectonic's default changed).");
    }
  }
  say('PDF engine ready.');
}

function warmJobs(): { sample: string; edition: Edition; theme?: string }[] {
  const list: { sample: string; edition: Edition; theme?: string }[] = [];
  for (const sample of ['handout-peel', 'worksheet-mixed', 'lesson-script']) for (const edition of ['student', 'teacher'] as const) list.push({ sample, edition });
  for (const theme of ['tutorswiss', 'tutorbook', 'tutorsheet', 'tutorfocus']) list.push({ sample: 'deck', edition: 'student', theme });
  return list;
}
