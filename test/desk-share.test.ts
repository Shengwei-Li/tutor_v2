import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { markdown } from '../src/md.ts';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { CodexSession } from '../src/agents/codex.ts';
import { approval } from '../src/approvals.ts';
import { T_EN, createDesk, tasks } from '../src/desk.ts';
import { listStudents } from '../src/workspace.ts';
import { buildShare, calendar } from '../src/share.ts';

let root: string;
const put = async (rel: string, text: string) => {
  const f = path.join(root, rel);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, text);
};
// Wednesday 4 November 2026, 10:00.
const NOW = new Date(2026, 10, 4, 10, 0);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'td2-desk-'));
  await put('tutordesk.yaml', 'studio: Northbridge\ntutor: Ms Lin\n');
  await put('students/wang-yiran/profile.md', '---\nname: Wang Yiran\nexam: ielts-academic\ntarget: 7\ncurrent: 6.5\nexam_date: 2026-12-29\nschedule:\n  - { day: tue, time: "19:00", minutes: 90 }\n  - { day: thu, time: "19:00", minutes: 90 }\n---\nPRIVATE profile text.\n');
  await put('students/wang-yiran/notes.md', 'PRIVATE note: parents divorcing.');
  await put('students/wang-yiran/roadmap.md', '## 1. Diagnose\n- [x] Diagnostic\n## 2. Build\n- [ ] Position\n- [ ] PEEL\n');
  await put('students/wang-yiran/lessons/2026-11-03-diagnostic/plan.md', '---\ndate: 2026-11-03\ntime: "19:00"\ntopic: Diagnostic\nstatus: taught\n---\nPRIVATE plan.\n');
  await put('students/wang-yiran/lessons/2026-11-03-diagnostic/record.md', '---\nfor_parents: Yiran wrote a full essay under time.\n---\nPRIVATE: struggled with focus.\n');
  await put('students/wang-yiran/lessons/2026-11-03-diagnostic/out/handout.pdf', '%PDF-1 student');
  await put('students/wang-yiran/lessons/2026-11-03-diagnostic/out/handout-teacher.pdf', '%PDF-1 teacher');
  await put('students/wang-yiran/lessons/2026-11-05-position/plan.md', '---\ndate: 2026-11-05\ntime: "19:00"\ntopic: Stating a position\nstatus: draft\n---\n## Objectives\n- one\n');
  await put('students/wang-yiran/essays/2026-11-02-task2/review.md', '---\ndate: 2026-11-02\nestimate: { TR: "6" }\nfinal: { TR: 6, CC: 6, LR: 6.5, GRA: 6 }\n---\nPRIVATE review.\n');
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('parent page', () => {
  it('shows progress, the parent line, final bands and student handouts, and nothing private', async () => {
    const dir = await buildShare(root, 'wang-yiran', { lang: 'en', now: NOW });
    const html = await readFile(path.join(dir, 'index.html'), 'utf8');
    expect(html).toContain('55 days to the exam');
    expect(html).toContain('Yiran wrote a full essay under time.');
    expect(html).toContain('1/3');
    expect(html).toContain('<b style="float:right">6</b>');
    expect(html).toContain('Stating a position');
    expect(await readdir(dir)).toEqual(['2026-11-03-diagnostic-handout.pdf', 'index.html', 'lessons.ics']);
    const everything = (await Promise.all((await readdir(dir)).map((f) => readFile(path.join(dir, f), 'utf8')))).join('\n');
    expect(everything).not.toMatch(/PRIVATE|teacher/);
  });

  it('writes repeating calendar events until the exam', () => {
    const ics = calendar('Wang Yiran', [{ day: 'thu', time: '19:00', minutes: 90 }], '2026-12-29', NOW, 'English lesson', 'wang-yiran');
    expect(ics).toContain('DTSTART:20261105T190000\r\nDTEND:20261105T203000\r\nRRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261229T235959');
    expect(ics).toContain('SUMMARY:English lesson: Wang Yiran');
  });
});

describe('desk', () => {
  let server: Server;
  let base: string;
  beforeEach(async () => {
    const desk = createDesk(root, { lang: 'en', now: () => NOW, agents: [] });
    server = createServer((req, res) => void desk.handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('lists what needs the tutor, approvals first, with a sentence for the agent', async () => {
    const students = await listStudents(root);
    const list = tasks(students, NOW, { ...T_EN });
    expect(list.map((k) => [k.kind, k.date])).toEqual([
      ['approve', '2026-11-05'],
      ['prepare', '2026-11-10'],
    ]);
    expect(list[1]!.say).toBe("Prepare Wang Yiran's lesson on 11/10.");
    // A finished lesson with materials but no record asks for one.
    await put('students/wang-yiran/lessons/2026-11-03-diagnostic/plan.md', '---\ndate: 2026-11-03\ntopic: Diagnostic\nstatus: ready\n---\n');
    await rm(path.join(root, 'students/wang-yiran/lessons/2026-11-03-diagnostic/record.md'));
    expect(tasks(await listStudents(root), NOW, T_EN).map((k) => k.kind)).toContain('record');
  });

  it('shows the week with prepared lessons and empty slots', async () => {
    const html = await (await fetch(`${base}/?static`)).text();
    expect(html).toMatch(/<div class="n">03<\/div><div class="w">Tue<\/div><a class="slot" href="\/s\/wang-yiran\/l\/2026-11-03-diagnostic">.*?Diagnostic/s);
    expect(html).toMatch(/<div class="n">05<\/div>.*?Stating a position<\/div><span class="pipe draft"/s);
    const next = await (await fetch(`${base}/?w=1`)).text();
    expect(next).toMatch(/<div class="n">10<\/div><div class="w">Tue<\/div><a class="slot empty" href="\/s\/wang-yiran"><div class="t">19:00<\/div><div class="who">Wang Yiran<\/div><div class="what">Not prepared/);
    expect((await fetch(`${base}/s/nobody`)).status).toBe(404);
    expect((await fetch(`${base}/s/wang-yiran/l/2026-01-01-none`)).status).toBe(404);
  });

  it('approves a plan only with the page token', async () => {
    const page = await (await fetch(`${base}/s/wang-yiran/l/2026-11-05-position`)).text();
    const token = /name="token" value="([0-9a-f]+)"/.exec(page)![1]!;
    const url = `${base}/s/wang-yiran/l/2026-11-05-position/approve`;
    expect((await fetch(url, { method: 'POST', headers: { origin: base }, body: new URLSearchParams({ token: 'forged' }), redirect: 'manual' })).status).toBe(403);
    // The right token from another site's page, or with no origin at all, is refused too.
    for (const headers of [{ origin: 'http://evil.example' }, { origin: 'null' }, {}]) expect((await fetch(url, { method: 'POST', headers, body: new URLSearchParams({ token }), redirect: 'manual' })).status).toBe(403);
    expect(await readFile(path.join(root, 'students/wang-yiran/lessons/2026-11-05-position/plan.md'), 'utf8')).toContain('status: draft');
    expect((await fetch(url, { method: 'POST', headers: { origin: base }, body: new URLSearchParams({ token }), redirect: 'manual' })).status).toBe(303);
    expect(await readFile(path.join(root, 'students/wang-yiran/lessons/2026-11-05-position/plan.md'), 'utf8')).toContain('status: approved');
  });

  it('serves lesson PDFs and the parent page, nothing else, to this computer only', async () => {
    expect((await fetch(`${base}/files/students/wang-yiran/lessons/2026-11-03-diagnostic/out/handout.pdf`)).status).toBe(200);
    for (const p of ['students/wang-yiran/notes.md', 'students/wang-yiran/profile.md', 'students/wang-yiran/lessons/2026-11-03-diagnostic/record.md', 'students/wang-yiran/../../tutordesk.yaml', 'students/wang-yiran/lessons/2026-11-03-diagnostic/out/..%2F..%2F..%2Fnotes.md'])
      expect((await fetch(`${base}/files/${p}`)).status, p).toBe(404);
    // A page on another site can reach a local server through its own host name (DNS rebinding).
    const status = await new Promise<number | undefined>((resolve) => request(`${base}/`, { headers: { host: 'evil.example' } }, (r) => resolve(r.statusCode)).end());
    expect(status).toBe(403);
  });

  it('runs only its own script, and says where to look when something goes wrong', async () => {
    const res = await fetch(`${base}/s/wang-yiran`);
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'self';/);
    const html = await res.text();
    // No inline code: the only scripts are the settings block and /assets/chat.js.
    expect([...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1])).toEqual([' type="application/json" id="td"', ' src="/assets/chat.js"']);
    expect(html).not.toMatch(/\son[a-z]+=/);
    expect((await fetch(`${base}/assets/chat.js`)).headers.get('content-type')).toContain('javascript');
    expect(html).toContain('href="/problem"');
    const problem = await (await fetch(`${base}/problem`)).text();
    expect(problem).toContain('TutorDesk 2.');
    expect(problem).not.toContain('Wang Yiran');
  });

  it('serves nothing through a folder linked from elsewhere', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'td2-outside-'));
    try {
      await mkdir(path.join(outside, 'out'), { recursive: true });
      await writeFile(path.join(outside, 'out', 'secret.pdf'), '%PDF secret');
      await symlink(outside, path.join(root, 'students/wang-yiran/lessons/2026-11-09-linked'), 'junction');
      expect((await fetch(`${base}/files/students/wang-yiran/lessons/2026-11-09-linked/out/secret.pdf`)).status).toBe(404);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('markdown from agents and files', () => {
  it('escapes HTML and lets links go only to web pages and the workspace', () => {
    expect(markdown('<script>alert(1)</script> **b**')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; <strong>b</strong></p>');
    expect(markdown('[x](javascript:alert(1)) [y](file:///etc/passwd) [z](/etc) [w](../../x)')).not.toContain('<a');
    expect(markdown('[site](https://ielts.org/a?b=1&c=2)')).toBe('<p><a href="https://ielts.org/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">site</a></p>');
    expect(markdown('[plan](students/mina/lessons/2026-11-12-task2/plan.md)')).toBe('<p><a href="/s/mina/l/2026-11-12-task2">plan</a></p>');
    expect(markdown('[profile](./students/mina/profile.md)')).toBe('<p><a href="/s/mina">profile</a></p>');
    expect(markdown('`[a](https://x.org)` "q"')).toBe('<p><code>[a](https://x.org)</code> &quot;q&quot;</p>');
  });
});

describe('desk idleness', () => {
  it('is idle only while no page is open', async () => {
    const desk = createDesk(root, { lang: 'en', now: () => NOW, agents: [] });
    const server = createServer((req, res) => void desk.handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const events = new AbortController();
      const res = await fetch(`${base}/events`, { signal: events.signal });
      await res.body!.getReader().read();
      await new Promise((r) => setTimeout(r, 30));
      expect(desk.idleMs()).toBe(0);
      events.abort();
      await new Promise((r) => setTimeout(r, 50));
      expect(desk.idleMs()).toBeGreaterThanOrEqual(0);
      expect(desk.idleMs()).toBeLessThan(1000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('desk conversation', () => {
  const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
  let server: Server;
  let base: string;
  let desk: ReturnType<typeof createDesk>;
  beforeEach(async () => {
    desk = createDesk(root, {
      lang: 'en',
      now: () => NOW,
      agents: [{ id: 'codex', label: 'Codex', installed: true, signedIn: true }, { id: 'claude-code', label: 'Claude Code', installed: false, hint: 'Install Claude Code' }],
      threads: { create: (_a, o) => new CodexSession(o, { executable: { command: process.execPath, prefixArgs: [FAKE, 'codex'] } }) },
    });
    server = createServer((req, res) => void desk.handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await desk.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const token = async () => /"token":"([0-9a-f]+)"/.exec(await (await fetch(`${base}/?static`)).text())![1]!;
  const thread = async (key: string) => (await (await fetch(`${base}/api/thread?key=${key}`)).json()) as { who: string; html: string; running: boolean; agent: string; agents: { id: string; ready: boolean }[] };
  const settled = async (key: string) => {
    for (let i = 0; i < 100; i++) {
      const t = await thread(key);
      if (!t.running) return t;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('turn did not end');
  };

  it('sends the tutor\'s message to the ready agent and shows the reply', async () => {
    const t = await token();
    expect((await fetch(`${base}/api/send`, { method: 'POST', headers: { origin: base }, body: JSON.stringify({ token: 'x', key: 'wang-yiran', text: 'hi' }) })).status).toBe(403);
    expect((await fetch(`${base}/api/send`, { method: 'POST', headers: { origin: base }, body: JSON.stringify({ token: t, key: 'wang-yiran', text: 'Plan the lesson' }) })).status).toBe(200);
    const v = await settled('wang-yiran');
    expect(v).toMatchObject({ who: 'Wang Yiran', agent: 'codex' });
    expect(v.agents).toEqual([expect.objectContaining({ id: 'codex', ready: true }), expect.objectContaining({ id: 'claude-code', ready: false })]);
    expect(v.html).toContain('<div class="msg me">Plan the lesson</div>');
    expect(v.html).toMatch(/<div class="who">Codex<\/div><div class="prose"><p>Hello tutor<\/p>\n<p>Done\.<\/p>/);
    // The general conversation is a different one.
    expect((await thread('')).html).toBe('');
  });

  it('takes attachments into the inbox, passes them on, and shows them as they are', async () => {
    const t = await token();
    const up = (name: string, data: Buffer | string, tok = t) => fetch(`${base}/api/upload?key=wang-yiran&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { origin: base, 'x-td-token': tok }, body: data });
    expect((await up('essay.jpg', 'x', 'bad')).status).toBe(403);
    expect((await up('run.exe', 'x')).status).toBe(415);
    expect((await up('big.png', Buffer.alloc(20 * 1024 * 1024 + 1))).status).toBe(413);
    const r = await up('Essay 1.jpg', 'jpeg bytes');
    expect(r.status).toBe(200);
    const { file } = (await r.json()) as { file: string };
    expect(file).toBe('students/wang-yiran/inbox/2026-11-04-Essay-1.jpg');
    const send = (files: unknown) => fetch(`${base}/api/send`, { method: 'POST', headers: { origin: base }, body: JSON.stringify({ token: t, key: 'wang-yiran', text: 'Mark it', files }) });
    expect((await send(['students/wang-yiran/notes.md'])).status).toBe(409);
    expect((await send([file])).status).toBe(200);
    const v = await settled('wang-yiran');
    expect(v.html).toContain(`<img class="thumb" src="/files/${file}"`);
    const img = await fetch(`${base}/files/${file}`);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    expect(img.headers.get('content-security-policy')).toMatch(/^sandbox/);
    expect(await img.text()).toBe('jpeg bytes');
    expect((await fetch(`${base}/files/students/wang-yiran/inbox/..%2Fnotes.md`)).status).toBe(404);
  });

  it('hands every task the agent can do alone to its conversation, once', async () => {
    const t = await token();
    const all = () => fetch(`${base}/api/all`, { method: 'POST', headers: { origin: base }, body: JSON.stringify({ token: t }) }).then((r) => r.json() as Promise<{ sent: number }>);
    expect(await all()).toEqual({ sent: 1 });
    expect(await all()).toEqual({ sent: 0 });
    const v = await settled('wang-yiran');
    expect(v.html.match(/Prepare Wang Yiran&#39;s lesson on 11\/10\./g) ?? v.html.match(/Prepare Wang Yiran's lesson on 11\/10\./g)).toHaveLength(1);
    // The approval stays the tutor's.
    expect(await approval(root, 'wang-yiran', '2026-11-05-position')).toBe('none');
  });

  it("remembers the model and thinking level per agent, for the desk's own conversations", async () => {
    const t = await token();
    const choose = (body: object) => fetch(`${base}/api/choice`, { method: 'POST', headers: { origin: base }, body: JSON.stringify({ token: t, ...body }) });
    expect((await choose({ agent: 'codex', model: 'gpt-deep', effort: 'deep' })).status).toBe(200);
    expect((await choose({ agent: 'nope', model: 'x' })).status).toBe(404);
    const v = (await thread('')) as unknown as { agents: { id: string; choice: object }[] };
    expect(v.agents.find((a) => a.id === 'codex')!.choice).toEqual({ model: 'gpt-deep', effort: 'deep' });
  });

  it('records the approval and hands the materials to the agent in one click', async () => {
    const url = `${base}/s/wang-yiran/l/2026-11-05-position/approve`;
    expect((await fetch(url, { method: 'POST', headers: { origin: base }, body: new URLSearchParams({ token: await token() }), redirect: 'manual' })).status).toBe(303);
    expect(await approval(root, 'wang-yiran', '2026-11-05-position')).toBe('approved');
    const v = await settled('wang-yiran');
    expect(v.html).toContain("The plan for Wang Yiran's lesson on 11/05 is approved. Write the materials and export the PDFs.");
  });
});
