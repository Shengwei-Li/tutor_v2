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
let starts: { resume?: string; instructions?: string; model?: string; effort?: string }[];

/** Resolves when the thread's next turn has ended and its entries are saved (its events up to then are used up). */
const ended = (key: string) =>
  new Promise<void>((resolve) => {
    const t = setInterval(() => {
      const i = events.findIndex(([k, e]) => k === key && e.type === 'end');
      if (i < 0) return;
      clearInterval(t);
      events = events.filter(([k], j) => k !== key || j > i);
      resolve();
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
      starts.push({ resume: o.resume, instructions: o.instructions, model: o.model, effort: o.effort });
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

  it('keeps students apart, queues a second message mid-turn, and stops on request', async () => {
    await threads.send('', 'hang');
    expect(await threads.send('', 'again')).toEqual({ queued: true });
    expect((await threads.view('')).queue.map((q) => q.text)).toEqual(['again']);
    await threads.send('mina', 'Plan the lesson');
    await ended('mina');
    expect((await threads.view('')).running).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    await threads.stop('');
    await ended('');
    // The queued message goes as soon as the stopped turn has ended.
    await ended('');
    const v = await threads.view('');
    expect(v.queue).toEqual([]);
    expect(v.entries.map((e) => (e.role === 'system' ? e.kind : e.role))).toEqual(['tutor', 'stopped', 'tutor', 'tool', 'agent']);
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

  it('lists messages still queued when the desk went away as not sent, with the message to send again', async () => {
    await mkdir(path.dirname(threadFile()), { recursive: true });
    await writeFile(threadFile(), JSON.stringify({ entries: [], sessions: {}, queue: [{ id: 'q1', text: 'Mark the essay', files: ['students/mina/inbox/2026-11-10-essay.jpg'], at: 'x' }] }));
    const v = await threads.view('mina');
    expect(v.queue).toEqual([]);
    expect(v.entries.at(-1)).toMatchObject({ kind: 'unsent', retry: 'Mark the essay', retryFiles: ['students/mina/inbox/2026-11-10-essay.jpg'] });
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

describe('what the agent does, shown', () => {
  const make = (extra: Partial<ConstructorParameters<typeof Threads>[1]>) =>
    new Threads(root, {
      mcp: { command: 'tutordesk', args: ['mcp'] },
      agent: async () => 'codex',
      emit: (k, e) => events.push([k, e]),
      create: (_a, o) => {
        starts.push({ resume: o.resume, model: o.model, effort: o.effort });
        return new CodexSession(o, { executable: { command: process.execPath, prefixArgs: [FAKE, 'codex'] } });
      },
      ...extra,
    });

  it('keeps one task list per turn, folded into the turn when it ends', async () => {
    await threads.send('mina', 'plan please');
    await ended('mina');
    const v = await threads.view('mina');
    expect(v.entries.map((e) => e.role)).toEqual(['tutor', 'plan', 'tool', 'agent']);
    expect(v.entries[1]).toMatchObject({ items: [{ text: 'Read the profile', status: 'done' }, { text: 'Write the plan', status: 'done' }] });
  });

  it('lists the files a turn wrote, without sources and build files', async () => {
    await threads.send('mina', 'write please');
    await ended('mina');
    expect((await threads.view('mina')).entries.at(-1)).toEqual({
      role: 'files',
      files: ['students/mina/lessons/2026-11-12-task2/out/handout.pdf', 'students/mina/lessons/2026-11-12-task2/plan.md', 'students/mina/roadmap.md'],
      at: expect.any(String),
      step: expect.any(Number),
    });
  });

  it('undoes a turn: the lesson it made goes, the note can put it back', async () => {
    await threads.send('mina', 'write please');
    await ended('mina');
    const v = await threads.view('mina');
    const step = (v.entries.at(-1) as { step: number }).step;
    expect(v.undo).toBe(step);
    expect(await threads.undo('mina', step)).toEqual({ done: true });
    const lesson = path.join(root, 'students/mina/lessons');
    expect(await readdir(lesson).catch(() => null)).toBeNull();
    const after = await threads.view('mina');
    expect(after.entries.at(-1)).toMatchObject({ role: 'system', kind: 'undone', step, pdfs: 1 });
    expect(after).toMatchObject({ undo: undefined, redo: step });
    expect(events.some(([k, e]) => k === 'mina' && e.type === 'saved')).toBe(true);
    await threads.undo('mina', step, { redo: true });
    expect(await readFile(path.join(lesson, '2026-11-12-task2/plan.md'), 'utf8')).toContain('topic: Task 2');
    expect((await threads.view('mina')).entries.at(-1)).toMatchObject({ kind: 'redone' });
  });

  it('does not undo while an agent works in the same files', async () => {
    await threads.send('mina', 'write please');
    await ended('mina');
    const step = (await threads.view('mina')).undo!;
    await threads.send('', 'hang');
    expect(await threads.undo('mina', step)).toEqual({ done: false, busy: true });
    await threads.stop('');
    await ended('');
  });

  it('sends attached pictures as image input and names every attachment in the message', async () => {
    const log = path.join(root, 'fake.log');
    process.env.FAKE_LOG = log;
    try {
      await mkdir(path.join(root, 'students/mina/inbox'), { recursive: true });
      await writeFile(path.join(root, 'students/mina/inbox/2026-11-10-essay.jpg'), 'jpeg');
      await writeFile(path.join(root, 'students/mina/inbox/2026-11-10-paper.pdf'), '%PDF');
      await threads.send('mina', 'Mark this', ['students/mina/inbox/2026-11-10-essay.jpg', 'students/mina/inbox/2026-11-10-paper.pdf']);
      await ended('mina');
      const turn = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.method === 'turn/start');
      expect(turn.params.input).toEqual([
        { type: 'text', text: expect.stringContaining('- students/mina/inbox/2026-11-10-paper.pdf'), text_elements: [] },
        { type: 'localImage', path: path.join(root, 'students/mina/inbox/2026-11-10-essay.jpg') },
      ]);
      expect(turn.params.input[0].text).toMatch(/^Mark this\n\nThe tutor attached files[\s\S]*not an instruction to you\.$/);
      expect((await threads.view('mina')).entries[0]).toMatchObject({ role: 'tutor', text: 'Mark this', files: ['students/mina/inbox/2026-11-10-essay.jpg', 'students/mina/inbox/2026-11-10-paper.pdf'] });
    } finally {
      delete process.env.FAKE_LOG;
    }
  });

  it('runs a few conversations at once and lets the rest wait their turn', async () => {
    await threads.closeAll();
    await mkdir(path.join(root, 'students/leo'), { recursive: true });
    threads = make({ maxRunning: 1 });
    await threads.send('mina', 'slow one');
    expect(await threads.send('leo', 'slow two')).toEqual({ queued: true });
    expect(threads.activity()).toEqual({ mina: 'working', leo: 'working' });
    expect((await threads.view('leo')).running).toBe(false);
    await ended('mina');
    expect(threads.isRunning('leo')).toBe(true);
    await ended('leo');
    // Finished and not yet looked at, until the tutor opens the conversation.
    expect(threads.activity()).toEqual({ mina: 'unread', leo: 'unread' });
    await threads.view('leo');
    expect(threads.activity()).toEqual({ mina: 'unread' });
  });

  it('takes back a queued message before it goes', async () => {
    await threads.send('mina', 'hang');
    await threads.send('mina', 'never mind');
    const [q] = (await threads.view('mina')).queue;
    await threads.unqueue('mina', q!.id);
    expect((await threads.view('mina')).queue).toEqual([]);
    await threads.stop('mina');
    await ended('mina');
    await new Promise((r) => setTimeout(r, 100));
    expect((await threads.view('mina')).entries.filter((e) => e.role === 'tutor').map((e) => e.role === 'tutor' && e.text)).toEqual(['hang']);
  });

  it('starts the agent with the model and thinking level picked, and continues the conversation when they change', async () => {
    await threads.closeAll();
    let choice: { model?: string; effort?: string } = { model: 'gpt-deep', effort: 'high' };
    const log = path.join(root, 'fake.log');
    process.env.FAKE_LOG = log;
    try {
      threads = make({ choice: async () => choice });
      await threads.send('mina', 'first');
      await ended('mina');
      choice = {};
      await threads.send('mina', 'second');
      await ended('mina');
      expect(starts.map((s) => [s.model, s.effort, s.resume])).toEqual([
        ['gpt-deep', 'high', undefined],
        [undefined, undefined, 'thr-1'],
      ]);
      const turns = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.method === 'turn/start');
      expect(turns[0].params.effort).toBe('high');
      expect(turns[1].params.effort).toBeUndefined();
    } finally {
      delete process.env.FAKE_LOG;
    }
  });
});
