import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { History, KEEP_STEPS, snapshot } from '../src/history.ts';

let root: string;
let h: History;
const S = 'students/mina/';
const put = async (rel: string, text: string | Buffer) => {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text);
};
const read = (rel: string) => readFile(path.join(root, rel));
const gone = (rel: string) => stat(path.join(root, rel)).then(() => false, () => true);

/** A turn: the folder before, the change, the folder after, recorded. */
async function turn(change: () => Promise<void>, thread = 'mina', prefix = S): Promise<number | null> {
  const before = await snapshot(root, prefix);
  await change();
  return h.record(thread, before, await snapshot(root, prefix));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'td2-history-'));
  await put(`${S}profile.md`, '---\nname: Mina\n---\nLikes tennis.\n');
  h = new History(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('undo', () => {
  it('puts a changed file back byte for byte and removes what the turn made', async () => {
    const original = await read(`${S}profile.md`);
    const step = await turn(async () => {
      await put(`${S}profile.md`, '---\nname: Mina\n---\nLikes basketball.\r\né\n');
      await put(`${S}lessons/2026-11-12-task2/plan.md`, 'plan');
      await put(`${S}lessons/2026-11-12-task2/out/handout.pdf`, '%PDF');
      await put(`${S}lessons/2026-11-12-task2/out/handout.log`, 'log');
    });
    expect(step).toBeTypeOf('number');
    expect(await h.state('mina')).toEqual({ undo: step, redo: undefined });
    const r = await h.undo('mina', step!);
    expect(r).toMatchObject({ done: true, removed: 1, pdfs: 1 });
    expect((await read(`${S}profile.md`)).equals(original)).toBe(true);
    // The lesson folder the turn made is gone with everything in it.
    expect(await gone(`${S}lessons`)).toBe(true);
    expect(await h.state('mina')).toEqual({ undo: undefined, redo: step });
  });

  it('undoes two turns in a row, newest first, and redoes them', async () => {
    const a = await turn(() => put(`${S}roadmap.md`, 'one'));
    const b = await turn(() => put(`${S}roadmap.md`, 'two'));
    await expect(h.undo('mina', a!)).rejects.toThrow(/latest/);
    await h.undo('mina', b!);
    expect(String(await read(`${S}roadmap.md`))).toBe('one');
    await h.undo('mina', a!);
    expect(await gone(`${S}roadmap.md`)).toBe(true);
    expect(await h.state('mina')).toEqual({ undo: undefined, redo: a });
    // Back again: the undo itself is undone.
    await h.redo('mina', a!);
    expect(String(await read(`${S}roadmap.md`))).toBe('one');
    await h.redo('mina', b!);
    expect(String(await read(`${S}roadmap.md`))).toBe('two');
    expect(await h.state('mina')).toEqual({ undo: b, redo: undefined });
  });

  it('a new turn after an undo ends the redo', async () => {
    const a = await turn(() => put(`${S}roadmap.md`, 'one'));
    await h.undo('mina', a!);
    const b = await turn(() => put(`${S}notes.md`, 'note'));
    expect(await h.state('mina')).toEqual({ undo: b, redo: undefined });
    await expect(h.redo('mina', a!)).rejects.toThrow();
    expect(await readdir(path.join(root, '.tutordesk/history/turns/mina'))).toEqual([`${b}.json`]);
  });

  it('names files changed since, and undoes them only when asked', async () => {
    const a = await turn(() => put(`${S}roadmap.md`, 'agent'));
    await put(`${S}roadmap.md`, 'tutor edited');
    expect(await h.undo('mina', a!)).toEqual({ done: false, conflict: [`${S}roadmap.md`] });
    expect(String(await read(`${S}roadmap.md`))).toBe('tutor edited');
    expect(await h.undo('mina', a!, true)).toMatchObject({ done: true });
    expect(await gone(`${S}roadmap.md`)).toBe(true);
  });

  it('records nothing for a turn that changed nothing, and leaves uploads and big files alone', async () => {
    expect(await turn(async () => {})).toBeNull();
    const step = await turn(async () => {
      await put(`${S}inbox/2026-11-11-essay.png`, 'png');
      await put(`${S}notes.md`, 'x');
    });
    await h.undo('mina', step!);
    expect(await gone(`${S}inbox/2026-11-11-essay.png`)).toBe(false);
    expect(await gone(`${S}notes.md`)).toBe(true);
  });

  it('keeps conversations apart and skips folders another conversation worked in', async () => {
    const before = await snapshot(root, 'students/');
    await put('students/mina/roadmap.md', 'mina');
    await put('students/joe/profile.md', 'joe');
    const g = await h.record('', before, await snapshot(root, 'students/'), ['students/mina/']);
    await h.undo('', g!);
    expect(await gone('students/joe')).toBe(true);
    expect(await gone('students/mina/roadmap.md')).toBe(false);
    expect(await h.state('mina')).toEqual({});
  });

  it('ignores a record that points outside the students folder', async () => {
    const step = await turn(() => put(`${S}roadmap.md`, 'x'));
    const file = path.join(root, `.tutordesk/history/turns/mina/${step}.json`);
    const r = JSON.parse(await readFile(file, 'utf8'));
    r.files['students/../AGENTS.md'] = [null, null];
    await writeFile(file, JSON.stringify(r));
    expect(await new History(root).state('mina')).toEqual({});
  });

  it('refuses a damaged saved version and changes nothing', async () => {
    await put(`${S}roadmap.md`, 'before');
    const step = await turn(() => put(`${S}roadmap.md`, 'after'));
    const objects = path.join(root, '.tutordesk/history/objects');
    for (const o of await readdir(objects)) await writeFile(path.join(objects, o), 'tampered');
    await expect(h.undo('mina', step!)).rejects.toThrow(/damaged/);
    expect(String(await read(`${S}roadmap.md`))).toBe('after');
  });

  it('prunes old steps and the versions only they used', async () => {
    const a = await turn(() => put(`${S}roadmap.md`, 'old'));
    const file = path.join(root, `.tutordesk/history/turns/mina/${a}.json`);
    const r = JSON.parse(await readFile(file, 'utf8'));
    r.at = '2026-01-01T00:00:00.000Z';
    await writeFile(file, JSON.stringify(r));
    const b = await turn(() => put(`${S}notes.md`, 'new'));
    await new History(root).prune(new Date('2026-11-11T00:00:00Z'));
    expect(await readdir(path.join(root, '.tutordesk/history/turns/mina'))).toEqual([`${b}.json`]);
    // notes.md's version stays; "old" (roadmap after step a) is gone.
    expect((await readdir(path.join(root, '.tutordesk/history/objects'))).length).toBe(1);
    expect(KEEP_STEPS).toBe(200);
  });
});
