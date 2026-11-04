import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseMd, setField } from './frontmatter.ts';

/**
 * The workspace is a folder of plain files; this module reads it and says what is wrong with it.
 * Nothing here caches: every view is built from the files as they are now.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-11-06');
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time like 19:00');
const DAY = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const SCORE = z.number().min(0).max(90);

export const Profile = z.object({
  name: z.string().min(1),
  exam: z.enum(['ielts-academic', 'ielts-general', 'pte-academic']),
  target: SCORE,
  current: SCORE.optional(),
  exam_date: DATE.optional(),
  /** Weekly lesson slots. */
  schedule: z.array(z.object({ day: DAY, time: TIME, minutes: z.number().int().min(15).max(240).default(60) })).default([]),
  parent: z.object({ name: z.string().optional(), contact: z.string().optional() }).optional(),
});
export type Profile = z.infer<typeof Profile>;

export const LESSON_STATUS = ['draft', 'approved', 'ready', 'taught'] as const;
export type LessonStatus = (typeof LESSON_STATUS)[number];

export const Plan = z.object({
  date: DATE,
  time: TIME.optional(),
  minutes: z.number().int().min(15).max(240).optional(),
  topic: z.string().min(1),
  status: z.enum(LESSON_STATUS),
});
export type Plan = z.infer<typeof Plan>;

export const Record_ = z.object({
  /** One or two sentences the parent page may show. Everything else in record.md stays with the tutor. */
  for_parents: z.string().optional(),
  homework: z.string().optional(),
});

export interface Problem {
  file: string;
  message: string;
}

export interface Lesson {
  id: string;
  plan: Plan | null;
  /** The plan's text below the YAML block. */
  planBody: string;
  record: z.infer<typeof Record_> | null;
  /** Materials written in this lesson folder (handout.tex …) and PDFs made from them. */
  sources: string[];
  pdfs: string[];
}

export interface Student {
  id: string;
  profile: Profile | null;
  profileBody: string;
  roadmap: { done: number; total: number; body: string } | null;
  lessons: Lesson[];
  problems: Problem[];
}

/** Folder names that become ids: lower-case letters, digits and dashes. */
export const ID = /^[a-z0-9][a-z0-9-]{0,80}$/;

export function studentsDir(root: string): string {
  return path.join(root, 'students');
}

async function read(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function dirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && ID.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function issues(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
}

/** Parse one Markdown file against a schema, adding a problem instead of throwing. */
async function load<T extends z.ZodType>(file: string, rel: string, schema: T, problems: Problem[], required: boolean): Promise<{ data: z.infer<T> | null; body: string } | null> {
  const text = await read(file);
  if (text === null) {
    if (required) problems.push({ file: rel, message: 'missing' });
    return null;
  }
  try {
    const md = parseMd(text);
    const r = schema.safeParse(md.data);
    if (!r.success) problems.push({ file: rel, message: issues(r.error) });
    return { data: r.success ? r.data : null, body: md.body };
  } catch (e) {
    problems.push({ file: rel, message: (e as Error).message });
    return { data: null, body: text };
  }
}

/** `- [x]` lines count as done, `- [ ]` as planned. */
export function checklist(body: string): { done: number; total: number } {
  const all = body.match(/^\s*[-*] \[[ xX]\]/gm) ?? [];
  const done = body.match(/^\s*[-*] \[[xX]\]/gm) ?? [];
  return { done: done.length, total: all.length };
}

export async function readLesson(root: string, studentId: string, lessonId: string, problems: Problem[] = []): Promise<Lesson> {
  const dir = path.join(studentsDir(root), studentId, 'lessons', lessonId);
  const rel = `students/${studentId}/lessons/${lessonId}`;
  const plan = await load(path.join(dir, 'plan.md'), `${rel}/plan.md`, Plan, problems, true);
  const record = await load(path.join(dir, 'record.md'), `${rel}/record.md`, Record_, problems, false);
  const files = await readdir(dir).catch(() => [] as string[]);
  const pdfs = await readdir(path.join(dir, 'out')).catch(() => [] as string[]);
  if (plan?.data && !lessonId.startsWith(plan.data.date)) problems.push({ file: `${rel}/plan.md`, message: `the folder name should start with the lesson date ${plan.data.date}` });
  return {
    id: lessonId,
    plan: plan?.data ?? null,
    planBody: plan?.body ?? '',
    record: record?.data ?? null,
    sources: files.filter((f) => f.endsWith('.tex')).sort(),
    pdfs: pdfs.filter((f) => f.endsWith('.pdf')).sort(),
  };
}

export async function readStudent(root: string, id: string): Promise<Student> {
  if (!ID.test(id)) throw new Error(`Not a student id: ${id}`);
  const dir = path.join(studentsDir(root), id);
  const problems: Problem[] = [];
  const profile = await load(path.join(dir, 'profile.md'), `students/${id}/profile.md`, Profile, problems, true);
  const roadmapText = await read(path.join(dir, 'roadmap.md'));
  const lessons: Lesson[] = [];
  for (const l of await dirs(path.join(dir, 'lessons'))) lessons.push(await readLesson(root, id, l, problems));
  return {
    id,
    profile: profile?.data ?? null,
    profileBody: profile?.body ?? '',
    roadmap: roadmapText === null ? null : { ...checklist(roadmapText), body: parseMd(roadmapText).body },
    lessons,
    problems,
  };
}

export async function listStudents(root: string): Promise<Student[]> {
  const out: Student[] = [];
  for (const id of await dirs(studentsDir(root))) out.push(await readStudent(root, id));
  return out;
}

/** Change a lesson's status, keeping everything else in plan.md as it is. */
export async function setLessonStatus(root: string, studentId: string, lessonId: string, status: LessonStatus): Promise<void> {
  if (!ID.test(studentId) || !ID.test(lessonId)) throw new Error('Not a lesson');
  const file = path.join(studentsDir(root), studentId, 'lessons', lessonId, 'plan.md');
  const text = await readFile(file, 'utf8');
  Plan.parse({ ...parseMd(text).data, status });
  await writeFile(file, setField(text, 'status', status), 'utf8');
}
