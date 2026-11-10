import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEMPLATES, findEngine } from '../src/tex.ts';
import { checkWorkspace, exportPdf } from '../src/tools.ts';
import { approve } from '../src/approvals.ts';
import { setLessonStatus } from '../src/workspace.ts';

const engine = await findEngine();
let root: string;
const lessonDir = () => path.join(root, 'students/mina/lessons/2026-11-07-peel');
const plan = (status: string) => writeFile(path.join(lessonDir(), 'plan.md'), `---\ndate: 2026-11-07\ntopic: PEEL paragraphs\nstatus: ${status}\n---\n`);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'td2-tools-'));
  await mkdir(lessonDir(), { recursive: true });
  await writeFile(path.join(root, 'students/mina/profile.md'), '---\nname: Mina\nexam: ielts-academic\ntarget: 7\n---\n');
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('check_workspace', () => {
  it('summarises students and lessons, and flags broken files', async () => {
    await plan('draft');
    expect((await checkWorkspace(root)).text).toContain('mina: Mina, ielts-academic target 7; no roadmap.md; 1 lessons\n  - 2026-11-07-peel: draft');
    await plan('soon');
    const r = await checkWorkspace(root);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('students/mina/lessons/2026-11-07-peel/plan.md: status:');
  });
});

describe('export_pdf gates', () => {
  it('refuses a draft plan, bad names and missing files', async () => {
    await plan('draft');
    await writeFile(path.join(lessonDir(), 'handout.tex'), '');
    expect((await exportPdf(root, { student: 'mina', lesson: '2026-11-07-peel', file: 'handout.tex' })).text).toMatch(/has not approved/);
    expect((await exportPdf(root, { student: '..', lesson: '2026-11-07-peel', file: 'handout.tex' })).isError).toBe(true);
    expect((await exportPdf(root, { student: 'mina', lesson: '2026-11-07-peel', file: '../x.tex' })).isError).toBe(true);
    // Writing the status is not approval: only the desk's record counts.
    await setLessonStatus(root, 'mina', '2026-11-07-peel', 'approved');
    expect((await exportPdf(root, { student: 'mina', lesson: '2026-11-07-peel', file: 'handout.tex' })).text).toMatch(/has no effect/);
    await approve(root, 'mina', '2026-11-07-peel');
    // The status moving on keeps the approval; a changed plan loses it.
    await setLessonStatus(root, 'mina', '2026-11-07-peel', 'ready');
    expect((await exportPdf(root, { student: 'mina', lesson: '2026-11-07-peel', file: 'worksheet.tex' })).text).toMatch(/No worksheet.tex/);
    // Any .tex in the folder can be \input, so one that reads outside blocks every export.
    await writeFile(path.join(lessonDir(), 'notes.tex'), String.raw`\input{../../notes.md}`);
    const r = await exportPdf(root, { student: 'mina', lesson: '2026-11-07-peel', file: 'handout.tex' });
    expect(r.text).toContain('notes.tex reads files outside the lesson folder');
    await rm(path.join(lessonDir(), 'notes.tex'));
    await writeFile(path.join(lessonDir(), 'plan.md'), '---\ndate: 2026-11-07\ntopic: Something else\nstatus: approved\n---\n');
    expect((await exportPdf(root, { student: 'mina', lesson: '2026-11-07-peel', file: 'handout.tex' })).text).toMatch(/changed after the tutor approved/);
  });

  it.skipIf(!engine)('exports an approved lesson, and lists what to fix in a broken one', async () => {
    await plan('draft');
    await approve(root, 'mina', '2026-11-07-peel');
    await copyFile(path.join(TEMPLATES, 'samples', 'handout-peel.tex'), path.join(lessonDir(), 'handout.tex'));
    expect((await exportPdf(root, { student: 'mina', lesson: '2026-11-07-peel', file: 'handout.tex', edition: 'teacher' })).text).toMatch(/^Exported students\/mina\/lessons\/2026-11-07-peel\/out\/handout-teacher\.pdf/);
    await writeFile(path.join(lessonDir(), 'broken.tex'), '\\documentclass{article}\n\\begin{document}\n\\notamacro\n\\end{document}\n');
    const r = await exportPdf(root, { student: 'mina', lesson: '2026-11-07-peel', file: 'broken.tex' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/- broken\.tex:3: Undefined control sequence/);
  }, 120_000);
});
