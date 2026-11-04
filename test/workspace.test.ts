import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listStudents, readStudent, setLessonStatus } from '../src/workspace.ts';

let root: string;
const put = async (rel: string, text: string) => {
  const f = path.join(root, rel);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, text);
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'td2-ws-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('student folders', () => {
  it('reads profile, roadmap progress and lessons', async () => {
    await put('students/wang-yiran/profile.md', '﻿---\r\nname: Wang Yiran\nexam: ielts-academic\ntarget: 7\ncurrent: 6.5\nschedule:\n  - { day: tue, time: "19:00", minutes: 90 }\n---\nLoves basketball.\n');
    await put('students/wang-yiran/roadmap.md', '# Ten weeks\n- [x] Diagnostic\n- [ ] Task 2 position\n- [ ] Task 2 concession\n');
    await put('students/wang-yiran/lessons/2026-11-06-task2/plan.md', '---\ndate: 2026-11-06\ntopic: Task 2 position\nstatus: draft\n---\nObjective: …\n');
    const s = await readStudent(root, 'wang-yiran');
    expect(s.problems).toEqual([]);
    expect(s.profile).toMatchObject({ name: 'Wang Yiran', target: 7, schedule: [{ day: 'tue', time: '19:00', minutes: 90 }] });
    expect(s.roadmap).toMatchObject({ done: 1, total: 3 });
    expect(s.lessons[0]).toMatchObject({ id: '2026-11-06-task2', plan: { status: 'draft' } });
  });

  it('names the file and field of each problem instead of failing', async () => {
    await put('students/mina/profile.md', '---\nname: Mina\nexam: toefl\ntarget: 7\n---\n');
    await put('students/mina/lessons/2026-11-07-x/plan.md', '---\ndate: 2026-11-08\ntopic: x\nstatus: maybe\n---\n');
    await put('students/Bad Name/profile.md', '');
    const [s] = await listStudents(root);
    expect(s!.id).toBe('mina');
    expect(s!.problems.map((p) => p.file)).toEqual(['students/mina/profile.md', 'students/mina/lessons/2026-11-07-x/plan.md']);
    expect(s!.problems[0]!.message).toMatch(/^exam:/);
  });

  it('changes a status and keeps the rest of the plan', async () => {
    await put('students/mina/lessons/2026-11-07-x/plan.md', '---\ndate: 2026-11-07\ntopic: x # the topic\nstatus: draft\n---\n\n## Objective\nText stays.\n');
    await setLessonStatus(root, 'mina', '2026-11-07-x', 'approved');
    const text = await readFile(path.join(root, 'students/mina/lessons/2026-11-07-x/plan.md'), 'utf8');
    expect(text).toContain('status: approved');
    expect(text).toContain('topic: x # the topic');
    expect(text).toContain('## Objective\nText stays.');
    await expect(setLessonStatus(root, 'mina', '../x', 'approved')).rejects.toThrow();
  });
});
