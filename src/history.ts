import { createHash } from 'node:crypto';
import { readdir, readFile, rm, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { insideRoot, readJson, walk, writeAtomic } from './files.ts';

/**
 * Every turn can be taken back. Before a turn the text files it may touch are read (a student's
 * folder, or all students' for the general conversation); after it, what changed is kept:
 * the contents as objects named by their hash (<workspace>/.tutordesk/history/objects/), and one
 * record per turn of each file's before and after (turns/<thread>/<step>.json).
 *
 * Undo goes back from the newest step, one at a time; an undone step can be redone until a new turn
 * is recorded. PDFs and other generated files are not kept: undoing a turn removes the ones it made,
 * and they are made again when needed.
 */

/** Files the history keeps: what the agent writes by hand. Not output, uploads, or anything large. */
const TEXT = /\.(md|markdown|tex|bib|ya?ml|ics|html?|txt|csv)$/i;
const MAX_BYTES = 1_000_000;
export const KEEP_STEPS = 200;
export const KEEP_DAYS = 90;

const kept = (rel: string) => TEXT.test(rel) && !/(^|\/)(out|inbox)\//.test(rel) && !/(^|\/)\./.test(rel);
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The folder as a turn found it, paths relative to the workspace. */
export interface Snap {
  /** Contents of the text files the history keeps. */
  texts: Map<string, Buffer>;
  /** Size and time of every file: what else a turn made. */
  stamps: Map<string, string>;
}

/** Read the folder `prefix` (relative to the workspace, ending in /) for a turn. */
export async function snapshot(root: string, prefix: string): Promise<Snap> {
  const texts = new Map<string, Buffer>();
  const stamps = new Map<string, string>();
  const dir = path.join(root, prefix);
  for (const f of await walk(dir)) {
    const rel = prefix + f;
    const s = await stat(path.join(dir, f)).catch(() => null);
    if (!s) continue;
    stamps.set(rel, `${s.size}:${s.mtimeMs}`);
    if (kept(rel) && s.size <= MAX_BYTES) {
      const data = await readFile(path.join(dir, f)).catch(() => null);
      if (data) texts.set(rel, data);
    }
  }
  return { texts, stamps };
}

/** One turn's changes: each file's content hash before and after (null: not there). */
interface Rec {
  step: number;
  at: string;
  files: Record<string, [string | null, string | null]>;
  /** Files the turn made that are not kept (PDFs, build output, pictures): removed on undo while unchanged. */
  drop?: Record<string, string>;
  undone?: boolean;
}

export type Outcome =
  | { done: true; files: string[]; removed: number; pdfs: number }
  /** Files changed again since: undoing would lose that; the tutor decides. */
  | { done: false; conflict: string[] };

const HEX = /^[0-9a-f]{64}$/;

/** A record is the desk's own file, but the workspace is the agent's: one that points outside students/ is ignored. */
function sound(root: string, r: unknown): r is Rec {
  if (!r || typeof r !== 'object') return false;
  const x = r as Rec;
  if (!Number.isSafeInteger(x.step) || typeof x.files !== 'object' || !x.files) return false;
  const okPath = (p: string) => p.startsWith('students/') && !p.split('/').some((s) => s === '..' || s === '' || s === '.') && insideRoot(root, p);
  for (const [p, v] of Object.entries(x.files)) {
    if (!okPath(p) || !Array.isArray(v) || v.length !== 2 || !v.every((h) => h === null || (typeof h === 'string' && HEX.test(h)))) return false;
  }
  for (const p of Object.keys(x.drop ?? {})) if (!okPath(p)) return false;
  return true;
}

export class History {
  private readonly root: string;
  private readonly base: string;
  /** Each thread's records, oldest first, read once. */
  private cache = new Map<string, Promise<Rec[]>>();
  /** One change at a time per thread. */
  private queue = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = root;
    this.base = path.join(root, '.tutordesk', 'history');
  }

  private dir(thread: string): string {
    return path.join(this.base, 'turns', thread || '_general');
  }

  private records(thread: string): Promise<Rec[]> {
    let c = this.cache.get(thread);
    if (!c) {
      c = (async () => {
        const names = await readdir(this.dir(thread)).catch(() => [] as string[]);
        const out: Rec[] = [];
        for (const n of names) {
          if (!/^\d+\.json$/.test(n)) continue;
          const r = await readJson<Rec>(path.join(this.dir(thread), n)).catch(() => undefined);
          if (sound(this.root, r) && `${r.step}.json` === n) out.push(r);
        }
        return out.sort((a, b) => a.step - b.step);
      })();
      this.cache.set(thread, c);
    }
    return c;
  }

  private serial<T>(thread: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queue.get(thread) ?? Promise.resolve()).then(fn, fn);
    this.queue.set(thread, next.catch(() => {}));
    return next;
  }

  private async save(thread: string, r: Rec): Promise<void> {
    await writeAtomic(path.join(this.dir(thread), `${r.step}.json`), `${JSON.stringify(r)}\n`);
  }

  private async put(data: Buffer): Promise<string> {
    const h = hash(data);
    const file = path.join(this.base, 'objects', h);
    if (!(await stat(file).then(() => true, () => false))) await writeAtomic(file, data);
    return h;
  }

  /** An object's contents, checked against its name. */
  private async get(h: string): Promise<Buffer> {
    const data = await readFile(path.join(this.base, 'objects', h));
    if (hash(data) !== h) throw new Error('A saved version is damaged.');
    return data;
  }

  /**
   * Keep what a turn changed. `skip`: folders another conversation was working in at the same time,
   * whose changes are that conversation's. Returns the step, or null when nothing changed.
   */
  record(thread: string, before: Snap, after: Snap, skip: string[] = []): Promise<number | null> {
    return this.serial(thread, async () => {
      const mine = (p: string) => !skip.some((s) => p.startsWith(s));
      const files: Rec['files'] = {};
      for (const p of new Set([...before.texts.keys(), ...after.texts.keys()])) {
        if (!mine(p)) continue;
        const a = before.texts.get(p);
        const b = after.texts.get(p);
        if (a && b && a.equals(b)) continue;
        files[p] = [a ? await this.put(a) : null, b ? await this.put(b) : null];
      }
      const drop: Record<string, string> = {};
      for (const [p, s] of after.stamps) {
        if (!mine(p) || after.texts.has(p) || before.stamps.get(p) === s || /(^|\/)inbox\//.test(p)) continue;
        // New files, and output made again (an old PDF no longer matches the plan it came from).
        if (!before.stamps.has(p) || /(^|\/)out\//.test(p)) drop[p] = s;
      }
      if (!Object.keys(files).length && !Object.keys(drop).length) return null;
      const list = await this.records(thread);
      // A new step ends the redo of steps undone before it.
      for (const r of list.filter((x) => x.undone)) await rm(path.join(this.dir(thread), `${r.step}.json`), { force: true });
      const kept = list.filter((x) => !x.undone);
      const step = Math.max(Date.now(), (kept.at(-1)?.step ?? 0) + 1);
      const r: Rec = { step, at: new Date().toISOString(), files, ...(Object.keys(drop).length ? { drop } : {}) };
      await this.save(thread, r);
      kept.push(r);
      // The oldest go once there are too many.
      for (const old of kept.splice(0, Math.max(0, kept.length - KEEP_STEPS))) await rm(path.join(this.dir(thread), `${old.step}.json`), { force: true });
      this.cache.set(thread, Promise.resolve(kept));
      return step;
    });
  }

  /** The step undo would take back, and the one redo would put back. */
  async state(thread: string): Promise<{ undo?: number; redo?: number }> {
    const list = await this.records(thread);
    const firstUndone = list.findIndex((r) => r.undone);
    const top = firstUndone < 0 ? list.length - 1 : firstUndone - 1;
    return { undo: list[top]?.step, redo: firstUndone < 0 ? undefined : list[firstUndone]!.step };
  }

  private async current(p: string): Promise<string | null> {
    const data = await readFile(path.join(this.root, p)).catch(() => null);
    return data ? hash(data) : null;
  }

  /** Put each file at one side of the record: 0 before the turn, 1 after it. */
  private async apply(r: Rec, side: 0 | 1, force: boolean): Promise<Outcome> {
    const other = side === 0 ? 1 : 0;
    const conflict: string[] = [];
    for (const [p, v] of Object.entries(r.files)) if ((await this.current(p)) !== v[other]) conflict.push(p);
    if (conflict.length && !force) return { done: false, conflict };
    // Every saved version is read first, so a damaged one changes nothing.
    const writes: [string, Buffer | null][] = [];
    for (const [p, v] of Object.entries(r.files)) writes.push([p, v[side] ? await this.get(v[side]!) : null]);
    let removed = 0;
    const emptied = new Set<string>();
    for (const [p, data] of writes) {
      const full = path.join(this.root, p);
      if (data) await writeAtomic(full, data);
      else if (await unlink(full).then(() => true, () => false)) {
        removed++;
        emptied.add(path.posix.dirname(p));
      }
    }
    let pdfs = 0;
    if (side === 0) {
      for (const [p, s] of Object.entries(r.drop ?? {})) {
        const full = path.join(this.root, p);
        const now = await stat(full).catch(() => null);
        // Only what is still as the turn left it.
        if (!now || `${now.size}:${now.mtimeMs}` !== s) continue;
        if (await unlink(full).then(() => true, () => false)) {
          if (p.endsWith('.pdf')) pdfs++;
          emptied.add(path.posix.dirname(p));
        }
      }
    }
    // Folders the turn made, once empty, go too; students/ itself stays.
    for (let d of emptied) {
      for (; d.startsWith('students/'); d = path.posix.dirname(d)) {
        if (!(await rmdir(path.join(this.root, d)).then(() => true, () => false))) break;
      }
    }
    return { done: true, files: Object.keys(r.files).sort(), removed, pdfs };
  }

  /** Take back the newest step that is not undone yet. */
  undo(thread: string, step: number, force = false): Promise<Outcome> {
    return this.serial(thread, async () => {
      const list = await this.records(thread);
      const s = await this.state(thread);
      if (s.undo !== step) throw new Error('Only the latest step can be undone.');
      const r = list.find((x) => x.step === step)!;
      const out = await this.apply(r, 0, force);
      if (out.done) {
        r.undone = true;
        await this.save(thread, r);
      }
      return out;
    });
  }

  /** Put back the step undone last. */
  redo(thread: string, step: number, force = false): Promise<Outcome> {
    return this.serial(thread, async () => {
      const list = await this.records(thread);
      const s = await this.state(thread);
      if (s.redo !== step) throw new Error('Only the step undone last can be put back.');
      const r = list.find((x) => x.step === step)!;
      const out = await this.apply(r, 1, force);
      if (out.done) {
        delete r.undone;
        await this.save(thread, r);
      }
      return out;
    });
  }

  /** On start-up: records past the limits go, and with them the versions nothing refers to. */
  async prune(now = new Date()): Promise<void> {
    const threads = await readdir(path.join(this.base, 'turns')).catch(() => [] as string[]);
    const cutoff = now.getTime() - KEEP_DAYS * 86_400_000;
    const used = new Set<string>();
    for (const t of threads) {
      const thread = t === '_general' ? '' : t;
      if (thread && !/^[a-z0-9-]+$/.test(thread)) continue;
      await this.serial(thread, async () => {
        const list = await this.records(thread);
        const old = list.filter((r, i) => i < list.length - KEEP_STEPS || Date.parse(r.at) < cutoff);
        for (const r of old) await rm(path.join(this.dir(thread), `${r.step}.json`), { force: true });
        const rest = list.filter((r) => !old.includes(r));
        this.cache.set(thread, Promise.resolve(rest));
        for (const r of rest) for (const v of Object.values(r.files)) for (const h of v) if (h) used.add(h);
      });
    }
    for (const h of await readdir(path.join(this.base, 'objects')).catch(() => [] as string[])) {
      if (!used.has(h)) await rm(path.join(this.base, 'objects', h), { force: true });
    }
  }
}
