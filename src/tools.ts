import path from 'node:path';
import { buildShare } from './share.ts';
import { readdir, readFile } from 'node:fs/promises';
import { compile, outsideReads, type Edition, type Engine, type TexError } from './tex.ts';
import { ID, listStudents, readLesson, readStudent, studentsDir, type Problem } from './workspace.ts';

/**
 * What the MCP tools do, as plain functions. Each returns the text the agent reads: what happened and,
 * when something blocks, exactly what to fix.
 */

export interface ToolResult {
  text: string;
  isError?: boolean;
}

const fail = (text: string): ToolResult => ({ text, isError: true });

const listProblems = (ps: Problem[]) => ps.map((p) => `- ${p.file}: ${p.message}`).join('\n');

export async function checkWorkspace(root: string, studentId?: string): Promise<ToolResult> {
  if (studentId !== undefined && !ID.test(studentId)) return fail('student is a folder name (lower-case letters, digits, dashes).');
  const students = studentId ? [await readStudent(root, studentId)] : await listStudents(root);
  if (!students.length) return { text: 'No students yet.' };
  const lines: string[] = [];
  for (const s of students) {
    const p = s.profile;
    const head = p ? `${s.id}: ${p.name}, ${p.exam} target ${p.target}${p.exam_date ? `, exam ${p.exam_date}` : ''}` : `${s.id}: (no valid profile)`;
    const roadmap = s.roadmap ? `roadmap ${s.roadmap.done}/${s.roadmap.total}` : 'no roadmap.md';
    lines.push(`${head}; ${roadmap}; ${s.lessons.length} lessons`);
    for (const l of s.lessons) lines.push(`  - ${l.id}: ${l.plan?.status ?? 'invalid plan'}${l.pdfs.length ? `, PDFs: ${l.pdfs.join(', ')}` : ''}`);
    if (s.problems.length) lines.push(`  Problems to fix:\n${listProblems(s.problems).replace(/^/gm, '  ')}`);
  }
  const problems = students.reduce((n, s) => n + s.problems.length, 0);
  return { text: `${lines.join('\n')}\n\n${problems ? `${problems} problem(s): fix them before going on.` : 'No problems.'}`, isError: problems > 0 };
}

/** Text running past the margin by more than this shows on the page. */
const OVERFULL_PT = 2;

function blocking(e: TexError): boolean {
  if (e.severity === 'error') return true;
  if (e.severity !== 'overfull') return false;
  const pt = Number(/([\d.]+)pt/.exec(e.message)?.[1] ?? 0);
  return pt > OVERFULL_PT;
}

const where = (e: TexError) => (e.file ? `${e.file}${e.line ? `:${e.line}` : ''}: ` : e.line ? `line ${e.line}: ` : '');

/**
 * The hard gates: a lesson's materials become PDFs only after the tutor approved its plan, and only
 * when the document compiles with nothing running off the page.
 */
export async function exportPdf(root: string, a: { student: string; lesson: string; file: string; edition?: Edition }, engine?: Engine): Promise<ToolResult> {
  if (!ID.test(a.student) || !ID.test(a.lesson)) return fail('student and lesson are folder names (lower-case letters, digits, dashes).');
  if (!/^[a-z0-9][a-z0-9-]*\.tex$/.test(a.file)) return fail('file is a .tex file in the lesson folder, e.g. handout.tex.');
  const problems: Problem[] = [];
  const lesson = await readLesson(root, a.student, a.lesson, problems);
  if (!lesson.plan) return fail(`The lesson has no valid plan.md:\n${listProblems(problems)}`);
  if (lesson.plan.status === 'draft') return fail('The tutor has not approved this plan yet (plan.md status: draft). Show the tutor the plan and wait; set status: approved only when the tutor says so.');
  if (!lesson.sources.includes(a.file)) return fail(`No ${a.file} in ${a.lesson}. The lesson has: ${lesson.sources.join(', ') || 'no .tex files'}.`);
  const dir = path.join(studentsDir(root), a.student, 'lessons', a.lesson);
  // Every .tex in the folder can be \input, so all of them are checked.
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.tex'))) {
    const reads = outsideReads(await readFile(path.join(dir, f), 'utf8'));
    if (reads.length) return fail(`Not exported: ${f} reads files outside the lesson folder, which materials never need. Remove:\n${reads.map((r) => `- ${r}`).join('\n')}`);
  }
  const file = path.join(dir, a.file);
  const r = await compile(file, a.edition ?? 'student', { engine });
  const blockers = r.errors.filter(blocking);
  if (blockers.length || !r.ok) {
    return fail(`Not exported. Fix these in ${a.file} and export again:\n${blockers.map((e) => `- ${where(e)}${e.message}${e.context ? ` (near: ${e.context.trim().slice(0, 80)})` : ''}`).join('\n')}`);
  }
  const rel = path.relative(root, r.pdf!).replace(/\\/g, '/');
  // Only warnings the document itself can fix; the templates' own (font features, LaTeX release) are not.
  const warnings = r.errors.filter((e) => e.severity === 'warning' && /undefined|multiply defined/i.test(e.message)).slice(0, 5);
  return { text: `Exported ${rel}.${warnings.length ? `\nWarnings worth a look:\n${warnings.map((e) => `- ${e.message}`).join('\n')}` : ''}` };
}

export async function shareWithParents(root: string, student: string, lang: 'en' | 'zh'): Promise<ToolResult> {
  if (!ID.test(student)) return fail('student is a folder name (lower-case letters, digits, dashes).');
  try {
    const dir = await buildShare(root, student, { lang });
    const rel = path.relative(root, dir).replace(/\\/g, '/');
    return { text: `Made ${rel}/index.html (the parent page) and ${rel}/lessons.ics (the weekly lessons for a phone calendar). The tutor sends these files to the family; nothing was sent.` };
  } catch (e) {
    return fail((e as Error).message);
  }
}
