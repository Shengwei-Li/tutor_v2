import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    const desk = createDesk(root, { lang: 'en', now: () => NOW });
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
    expect((await fetch(url, { method: 'POST', body: new URLSearchParams({ token: 'forged' }), redirect: 'manual' })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', body: new URLSearchParams({ token }), redirect: 'manual' })).status).toBe(303);
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
});

describe('desk idleness', () => {
  it('is idle only while no page is open', async () => {
    const desk = createDesk(root, { lang: 'en', now: () => NOW });
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
