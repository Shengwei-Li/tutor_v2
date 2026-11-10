import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexSession } from '../src/agents/codex.ts';
import { brokenFiles } from '../src/files.ts';
import { Threads, type ThreadEvent } from '../src/threads.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
let root: string;
let threads: Threads;
let events: [string, ThreadEvent][];
let starts: { resume?: string; instructions?: string }[];

/** Resolves when the thread's turn has ended and its entries are saved. */
const ended = (key: string) =>
  new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (events.some(([k, e]) => k === key && e.type === 'end')) {
        clearInterval(t);
        events = events.filter(([k]) => k !== key);
        resolve();
      }
    }, 10);
  });

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'td2-threads-'));
  await mkdir(path.join(root, 'students/mina'), { recursive: true });
  await writeFile(path.join(root, 'students/mina/profile.md'), '---\nname: Mina Park\nexam: ielts-academic\ntarget: 7\n---\n');
  events = [];
  starts = [];
  threads = new Threads(root, {
    mcp: { command: 'tutordesk', args: ['mcp'] },
    agent: async () => 'codex',
    emit: (k, e) => events.push([k, e]),
    today: () => new Date(2026, 10, 10),
    stallMs: 100,
    create: (_a, o) => {
      starts.push({ resume: o.resume, instructions: o.instructions });
      return new CodexSession(o, { executable: { command: process.execPath, prefixArgs: [FAKE, 'codex'] } });
    },
  });
});
afterEach(async () => {
  await threads.closeAll();
  await rm(root, { recursive: true, force: true });
});

describe('conversations', () => {
  it('runs a turn, streams it, saves it, and continues the same conversation next time', async () => {
    await threads.send('mina', 'Plan the lesson');
    await ended('mina');
    const v = await threads.view('mina');
    expect(v.running).toBe(false);
    expect(v.entries.map((e) => e.role)).toEqual(['tutor', 'tool', 'agent']);
    expect(v.entries[2]).toMatchObject({ role: 'agent', text: 'Hello tutor\n\nDone.', agent: 'codex' });
    expect(starts[0]!.instructions).toContain('about the student Mina Park in students/mina/');
    expect(starts[0]!.instructions).toContain('Today is 2026-11-10 (Tuesday)');

    // A new service (the app restarted) resumes the agent's own conversation.
    await threads.closeAll();
    await threads.send('mina', 'And the next one');
    await ended('mina');
    expect(starts[1]!.resume).toBe('thr-1');
    expect(JSON.parse(await readFile(path.join(root, '.tutordesk/threads/mina.json'), 'utf8')).sessions).toEqual({ codex: 'thr-1' });
  });

  it('keeps students apart, refuses a second message mid-turn, and stops on request', async () => {
    await threads.send('', 'hang');
    await expect(threads.send('', 'again')).rejects.toThrow(/still working/);
    await threads.send('mina', 'Plan the lesson');
    await ended('mina');
    expect((await threads.view('')).running).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    await threads.stop('');
    await ended('');
    expect((await threads.view('')).entries.at(-1)).toMatchObject({ role: 'system', kind: 'stopped' });
    await expect(threads.send('../x', 'hi')).rejects.toThrow(/Not a student/);
  });

  it('starts afresh, and says so, when the earlier conversation cannot be continued', async () => {
    await mkdir(path.join(root, '.tutordesk/threads'), { recursive: true });
    await writeFile(path.join(root, '.tutordesk/threads/mina.json'), JSON.stringify({ entries: [], sessions: { codex: 'thr-gone' } }));
    await threads.send('mina', 'Plan the lesson');
    await ended('mina');
    expect(starts.map((s) => s.resume)).toEqual(['thr-gone', undefined]);
    expect((await threads.view('mina')).entries.map((e) => e.role)).toEqual(['tutor', 'system', 'tool', 'agent']);
  });
});

describe('when things go wrong', () => {
  const threadFile = (key = 'mina') => path.join(root, '.tutordesk/threads', key + '.json');

  it('puts back the instructions and skills an agent changed, and says so', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'The real instructions.');
    await threads.send('mina', 'tamper');
    await ended('mina');
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('The real instructions.');
    expect(await readdir(path.join(root, '.agents/skills')).catch(() => [])).toEqual([]);
    expect((await threads.view('mina')).entries.at(-1)).toMatchObject({ role: 'system', kind: 'restored', text: expect.stringContaining('AGENTS.md') });
  });

  it('marks a turn cut off by a crash, with the message to send again', async () => {
    await threads.send('mina', 'crash now');
    await ended('mina');
    expect((await threads.view('mina')).entries.at(-1)).toMatchObject({ role: 'system', kind: 'interrupted', retry: 'crash now' });
  });

  it('marks a turn the desk never finished (it was closed) as cut off', async () => {
    await mkdir(path.dirname(threadFile()), { recursive: true });
    await writeFile(threadFile(), JSON.stringify({ entries: [{ role: 'tutor', text: 'Plan it', at: 'x' }], sessions: {}, running: { text: 'Plan it', at: 'x', agent: 'codex' } }));
    const v = await threads.view('mina');
    expect(v.entries.at(-1)).toMatchObject({ kind: 'interrupted', retry: 'Plan it' });
    expect(JSON.parse(await readFile(threadFile(), 'utf8')).running).toBeUndefined();
  });

  it('keeps a broken conversation file aside and carries on', async () => {
    await mkdir(path.dirname(threadFile()), { recursive: true });
    await writeFile(threadFile(), '{"entries": [');
    expect((await threads.view('mina')).entries).toEqual([]);
    const kept = (await readdir(path.dirname(threadFile()))).filter((f) => f.startsWith('mina.json.broken-'));
    expect(kept).toHaveLength(1);
    expect(await readFile(path.join(path.dirname(threadFile()), kept[0]!), 'utf8')).toBe('{"entries": [');
    expect(brokenFiles().some((b) => b.file === threadFile())).toBe(true);
  });

  it('moves old parts of a long conversation aside instead of dropping them', async () => {
    const entries = Array.from({ length: 400 }, (_, i) => ({ role: 'tutor', text: 'm' + i, at: 'x' }));
    await mkdir(path.dirname(threadFile()), { recursive: true });
    await writeFile(threadFile(), JSON.stringify({ entries, sessions: {} }));
    await threads.send('mina', 'Plan the lesson');
    await ended('mina');
    const v = await threads.view('mina');
    expect(v.older).toBe(1);
    expect(v.entries.length).toBeLessThanOrEqual(203);
    const old = await threads.older('mina', 1);
    expect(old[0]).toMatchObject({ text: 'm0' });
    expect(old.length + v.entries.length).toBe(403);
  });

  it('says when the agent has gone quiet for a long time', async () => {
    await threads.send('mina', 'quiet please');
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toContainEqual(['mina', { type: 'stalled' }]);
    expect((await threads.view('mina')).stalled).toBe(true);
    await ended('mina');
    expect((await threads.view('mina')).stalled).toBe(false);
  });
});
