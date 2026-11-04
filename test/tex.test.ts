import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEMPLATES, compile, findEngine, parseLog } from '../src/tex.ts';

describe('parseLog', () => {
  it('finds errors with file and line, missing glyphs and overfull boxes', () => {
    const log = [
      './handout.tex:14: Undefined control sequence.',
      'l.14 \\badmacro',
      'Missing character: There is no ɪ (U+026A) in font Inter',
      'Overfull \\hbox (12.5pt too wide) in paragraph at lines 20--22',
      'Underfull \\hbox (badness 10000) in paragraph at lines 5--5',
    ].join('\n');
    expect(parseLog(log)).toEqual([
      { severity: 'error', file: 'handout.tex', line: 14, message: 'Undefined control sequence.', context: '\\badmacro' },
      { severity: 'error', message: 'The font has no "ɪ" (U+026A); it would print as an empty box.' },
      { severity: 'overfull', message: 'Text runs past the margin (12.5pt too wide)', line: 20 },
    ]);
  });
});

const engine = await findEngine();

describe.skipIf(!engine)(`compiling with ${engine?.kind}`, () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'td2-tex-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('puts student and teacher editions in out/', async () => {
    await copyFile(path.join(TEMPLATES, 'samples', 'handout-peel.tex'), path.join(dir, 'handout.tex'));
    const student = await compile(path.join(dir, 'handout.tex'));
    expect(student.errors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(student.pdf).toBe(path.join(dir, 'out', 'handout.pdf'));
    const teacher = await compile(path.join(dir, 'handout.tex'), 'teacher');
    expect(teacher.pdf).toBe(path.join(dir, 'out', 'handout-teacher.pdf'));
    expect((await readFile(teacher.pdf!)).length).toBeGreaterThan((await readFile(student.pdf!)).length);
  }, 120_000);

  it("reports the tutor's file and line", async () => {
    await writeFile(path.join(dir, 'broken.tex'), '\\documentclass{article}\n\\begin{document}\nFine.\n\\notamacro\n\\end{document}\n');
    const r = await compile(path.join(dir, 'broken.tex'));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ severity: 'error', file: 'broken.tex', line: 4 });
  }, 60_000);
});
