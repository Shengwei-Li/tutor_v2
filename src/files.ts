import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Files the desk itself keeps (conversations, approvals, settings) and the one check of whether a path
 * is inside the workspace. Writes go through a temporary file, so a crash never leaves half a file.
 */

const CASELESS = process.platform === 'win32' || process.platform === 'darwin';

/** A path with every link resolved, as far as it exists: a link inside the workspace cannot point out of it. */
function real(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Windows paths that name devices, other computers or a file's hidden streams. */
function oddWindowsPath(p: string): boolean {
  if (process.platform !== 'win32') return false;
  if (/^[\\/]{2}/.test(p)) return true; // \\?\, \\.\ and \\server\share
  return p.replace(/^[A-Za-z]:/, '').includes(':');
}

/** True when `file` (absolute, or relative to root) is inside `root`, after links are followed. */
export function insideRoot(root: string, file: string): boolean {
  if (!file || file.includes('\0') || oddWindowsPath(file)) return false;
  const base = real(root);
  const target = real(path.resolve(root, file));
  const fold = (s: string) => (CASELESS ? s.toLowerCase() : s);
  const rel = path.relative(fold(base), fold(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The parts of the workspace the agent reads but never writes: its own instructions and skills, the
 * workspace settings and the desk's records. Otherwise a planted line in a student's essay could make
 * the agent rewrite its skills, and every later conversation would follow them.
 */
export const PROTECTED = ['AGENTS.md', 'CLAUDE.md', 'tutordesk.yaml', '.agents', '.claude', '.tutordesk'];

/** The protected entry a path falls under, if any (relative to root, as written in PROTECTED). */
export function protectedPart(root: string, file: string): string | undefined {
  const rel = path.relative(real(root), real(path.resolve(root, file)));
  const first = rel.split(/[\\/]/)[0] ?? '';
  return PROTECTED.find((p) => (CASELESS ? p.toLowerCase() === first.toLowerCase() : p === first));
}

/** The protected files a turn is checked against: what the agent reads as instructions. */
const GUARDED = ['AGENTS.md', 'CLAUDE.md', 'tutordesk.yaml'];
const GUARDED_DIRS = ['.agents', '.claude'];

export type Snapshot = Map<string, Buffer>;

export async function snapshotProtected(root: string): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  const files = [...GUARDED, ...(await Promise.all(GUARDED_DIRS.map(async (d) => (await walk(path.join(root, d))).map((f) => `${d}/${f}`)))).flat()];
  for (const f of files) {
    const data = await readFile(path.join(root, f)).catch(() => null);
    if (data) snap.set(f, data);
  }
  return snap;
}

/**
 * Put the protected files back as they were before a turn: changed ones rewritten, new ones removed.
 * Codex works in its own sandbox, so this is how the rule holds for it; for the others it is a second
 * line. Returns what had changed.
 */
export async function restoreProtected(root: string, before: Snapshot): Promise<string[]> {
  const now = await snapshotProtected(root);
  const changed: string[] = [];
  for (const [f, data] of before) {
    if (!now.get(f)?.equals(data)) {
      changed.push(f);
      await mkdir(path.dirname(path.join(root, f)), { recursive: true });
      await writeFile(path.join(root, f), data);
    }
  }
  for (const f of now.keys()) {
    if (before.has(f)) continue;
    changed.push(f);
    await rm(path.join(root, f), { force: true });
    // And the folders it came in, once empty.
    for (let d = path.dirname(f); d !== '.' && d !== ''; d = path.dirname(d)) {
      if (!(await rmdir(path.join(root, d)).then(() => true, () => false))) break;
    }
  }
  return changed;
}

/** Write a file whole or not at all. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text);
  // Windows refuses to replace a file another program has open for a moment (an indexer, antivirus).
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        await rm(tmp, { force: true });
        throw e;
      }
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

/** Files found broken since the desk started, and where each was put aside. Shown at the top of the desk. */
const broken: { file: string; kept: string }[] = [];
export const brokenFiles = (): readonly { file: string; kept: string }[] => broken;

/**
 * Read a JSON file the desk keeps. Missing: undefined. Unreadable: it is renamed to
 * <name>.broken-<time> (nothing is lost), noted for the desk, and treated as missing.
 */
export async function readJson<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as T;
  } catch {
    const kept = `${file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    // Two readers may find it at once; the first one moves it.
    await rename(file, kept).then(
      () => broken.push({ file, kept }),
      () => {},
    );
    return undefined;
  }
}

/** Every file under a folder, relative to it, with forward slashes. */
export async function walk(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) out.push(...(await walk(full, `${prefix}${name}/`)));
    else out.push(`${prefix}${name}`);
  }
  return out;
}
