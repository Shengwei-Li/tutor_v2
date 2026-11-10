import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listModels, nativeEffort } from '../src/agents/models.ts';
import { fileLink, renderEntries } from '../src/chat.ts';
import { T_EN } from '../src/desk.ts';
import { checkAttachments, cleanName, refuse, saveUpload } from '../src/inbox.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'td2-inbox-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const DAY = new Date(2026, 10, 10);

describe('attachments', () => {
  it('cleans names: no folders, no odd characters, Chinese kept', () => {
    expect(cleanName('../../AGENTS.md')).toBe('AGENTS.md');
    expect(cleanName('..\\..\\evil.png')).toBe('evil.png');
    expect(cleanName('王一然 作文 (1).JPG')).toBe('王一然-作文-1.jpg');
    expect(cleanName('.hidden.txt')).toBe('hidden.txt');
    expect(cleanName('a<b>:c|d?.pdf')).toBe('a-b-c-d.pdf');
    expect(cleanName('....png')).toBe('file.png');
  });

  it('takes pictures, PDFs, Word and text up to 20 MB, and nothing else', () => {
    for (const ok of ['a.png', 'a.jpeg', 'a.webp', 'a.heic', 'a.pdf', 'a.docx', 'a.txt', 'a.md']) expect(refuse(ok, 10)).toBeNull();
    for (const bad of ['a.exe', 'a.html', 'a.svg', 'a', 'a.js']) expect(refuse(bad, 10)).toBe('type');
    expect(refuse('a.png', 20 * 1024 * 1024 + 1)).toBe('size');
    expect(refuse('a.png', 0)).toBe('size');
  });

  it("saves into the conversation's inbox with the date, numbering a name already taken", async () => {
    expect(await saveUpload(root, 'mina', 'essay.jpg', Buffer.from('1'), DAY)).toBe('students/mina/inbox/2026-11-10-essay.jpg');
    expect(await saveUpload(root, 'mina', 'essay.jpg', Buffer.from('2'), DAY)).toBe('students/mina/inbox/2026-11-10-essay-2.jpg');
    expect(await saveUpload(root, '', '../../../AGENTS.md', Buffer.from('3'), DAY)).toBe('inbox/2026-11-10-AGENTS.md');
    expect(await readFile(path.join(root, 'students/mina/inbox/2026-11-10-essay.jpg'), 'utf8')).toBe('1');
    expect(await readdir(root)).toEqual(['inbox', 'students']);
    await expect(saveUpload(root, '../x', 'a.png', Buffer.from('1'), DAY)).rejects.toThrow(/Not a student/);
    await expect(saveUpload(root, 'mina', 'run.exe', Buffer.from('1'), DAY)).rejects.toThrow(/cannot be attached/);
  });

  it("accepts only files in the conversation's own inbox, at most ten", async () => {
    const f = await saveUpload(root, 'mina', 'essay.jpg', Buffer.from('1'), DAY);
    expect(await checkAttachments(root, 'mina', [f])).toEqual([f]);
    await mkdir(path.join(root, 'students/leo/inbox'), { recursive: true });
    await writeFile(path.join(root, 'students/leo/inbox/2026-11-10-x.png'), '1');
    for (const bad of ['students/leo/inbox/2026-11-10-x.png', 'students/mina/inbox/../profile.md', 'students/mina/inbox/sub/x.png', 'AGENTS.md', 'students/mina/inbox/2026-11-10-gone.png']) {
      await expect(checkAttachments(root, 'mina', [bad])).rejects.toThrow();
    }
    await expect(checkAttachments(root, 'mina', Array(11).fill(f))).rejects.toThrow(/at most 10/);
    await expect(checkAttachments(root, 'mina', 'x')).rejects.toThrow();
  });
});

describe('results the tutor can click', () => {
  const t = T_EN.chat;
  it('names files the way the tutor does', () => {
    expect(fileLink('students/mina/profile.md', t, 'mina')).toEqual({ label: 'Profile', href: '/s/mina#profile' });
    expect(fileLink('students/mina/roadmap.md', t, 'mina')).toEqual({ label: 'Course plan', href: '/s/mina#roadmap' });
    expect(fileLink('students/mina/lessons/2026-11-12-task2/plan.md', t, 'mina')).toEqual({ label: '11/12 · Plan', href: '/s/mina/l/2026-11-12-task2#plan' });
    expect(fileLink('students/mina/lessons/2026-11-12-task2/out/worksheet-teacher.pdf', t, 'mina')).toEqual({
      label: '11/12 · Worksheet PDF · teacher',
      href: '/s/mina/l/2026-11-12-task2?pdf=worksheet-teacher.pdf#materials',
    });
    expect(fileLink('students/mina/share/index.html', t, 'mina')).toMatchObject({ label: 'Parent page', newTab: true });
    expect(fileLink('students/mina/essays/2026-11-02/review.md', t, 'mina')).toEqual({ label: 'review.md', href: '/s/mina' });
    // In the general conversation, whose file it is comes first.
    expect(fileLink('students/mina/profile.md', t, '').label).toBe('mina · Profile');
  });

  it('folds a turn: task list above, steps in one details line, files as links', () => {
    const at = 'x';
    const html = renderEntries(
      [
        { role: 'tutor', text: 'Prepare', at, files: ['students/mina/inbox/2026-11-10-essay.jpg', 'students/mina/inbox/2026-11-10-paper.pdf'] },
        { role: 'plan', items: [{ text: 'Read', status: 'done' }, { text: 'Write', status: 'done' }], at },
        { role: 'agent', text: 'Reading first.', at, agent: 'codex' },
        { role: 'tool', name: 'Read', kind: 'read', target: 'mina/profile.md', ok: true, at },
        { role: 'tool', name: 'export_pdf', kind: 'toolbox', ok: false, at },
        { role: 'agent', text: 'Done.', at, agent: 'codex' },
        { role: 'files', files: ['students/mina/roadmap.md'], at },
      ],
      t,
      'mina',
    );
    expect(html).toContain('<img class="thumb" src="/files/students/mina/inbox/2026-11-10-essay.jpg"');
    expect(html).toContain('<a class="att" href="/files/students/mina/inbox/2026-11-10-paper.pdf" target="_blank">paper.pdf</a>');
    expect(html).toContain('<summary>Done 2 steps</summary>');
    expect(html.match(/<div class="who">/g)).toHaveLength(1);
    expect(html).toContain('<summary>Details · 2 steps · 1 failed</summary><div class="step">Read mina/profile.md</div><div class="step err">Exported PDF ✕</div>');
    expect(html.indexOf('Done.')).toBeLessThan(html.indexOf('<details class="steps">'));
    expect(html).toContain('<div class="results"><a href="/s/mina#roadmap">Course plan</a></div>');
  });

  it('offers undo under the latest step only, and redo on the note of the step undone last', () => {
    const at = 'x';
    const entries = [
      { role: 'tutor', text: 'One', at },
      { role: 'files', files: [], at, step: 1 },
      { role: 'tutor', text: 'Two', at },
      { role: 'files', files: ['students/mina/roadmap.md'], at, step: 2 },
      { role: 'system', kind: 'undone', step: 2, text: 'students/mina/roadmap.md', pdfs: 1, at },
    ] as Parameters<typeof renderEntries>[0];
    const html = renderEntries(entries, t, 'mina', { undo: 1, redo: 2 });
    expect(html.match(/data-undo="1"/g)).toHaveLength(1);
    expect(html).not.toMatch(/data-undo="2">Undo/);
    expect(html).toContain('data-undo="2" data-redo>Put it back</button>');
    expect(html).toContain('Its PDFs were removed');
    // Each turn is its own box.
    expect(html.match(/<div class="turn">/g)).toHaveLength(2);
    // A step with nothing to link and nothing to undo shows nothing.
    expect(renderEntries(entries.slice(0, 2), t, 'mina', {})).not.toContain('results');
  });
});

describe('models and thinking', () => {
  const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
  const fake = (flavour: string) => ({ command: process.execPath, prefixArgs: [FAKE, flavour] });

  it('maps fast and deep to the levels the model has, and standard to nothing', () => {
    const levels = ['minimal', 'low', 'medium', 'high', 'xhigh'];
    expect(nativeEffort('fast', levels)).toBe('low');
    expect(nativeEffort('deep', levels)).toBe('xhigh');
    expect(nativeEffort('deep', ['low', 'medium', 'high', 'max'])).toBe('high');
    expect(nativeEffort('standard', levels)).toBeUndefined();
    expect(nativeEffort('deep', [])).toBeUndefined();
  });

  it("asks Codex and OpenCode for the account's own models, without starting a conversation", async () => {
    const codex = await listModels('codex', { cwd: root, executable: fake('codex') });
    // Hidden models are left out; levels come lowest first.
    expect(codex).toEqual({ models: [{ id: 'gpt-fast', label: 'GPT-FAST', efforts: [] }, { id: 'gpt-deep', label: 'GPT-DEEP', efforts: ['low', 'high', 'xhigh'] }], defaultEfforts: [], defaultLabel: 'GPT-FAST' });
    expect((await listModels('opencode', { cwd: root, executable: fake('opencode') })).models.map((m) => m.id)).toEqual(['zen/small', 'zen/big']);
  });
});
