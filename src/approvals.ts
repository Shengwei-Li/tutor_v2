import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeAtomic } from './files.ts';
import { tutordeskHome } from './home.ts';
import { ID, setLessonStatus, studentsDir } from './workspace.ts';

/**
 * The tutor's approval of a lesson plan. It is recorded in ~/.tutordesk, outside the workspace, with a
 * fingerprint of the plan as approved: an agent can write `status: approved` into plan.md, but that
 * alone approves nothing, and a plan edited after approval needs approving again.
 */
const file = () => path.join(tutordeskHome(), 'approvals.json');
const key = (root: string, student: string, lesson: string) => `${path.resolve(root).toLowerCase()}|${student}/${lesson}`;
const planFile = (root: string, student: string, lesson: string) => path.join(studentsDir(root), student, 'lessons', lesson, 'plan.md');

async function records(): Promise<Record<string, string>> {
  return (await readJson<Record<string, string>>(file())) ?? {};
}

/** The plan without its status line (which moves on to ready and taught), line endings and BOM aside. */
export function fingerprint(planText: string): string {
  const text = planText.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/^status:.*\n/m, '');
  return createHash('sha256').update(text).digest('hex');
}

/** The tutor approves: only the desk calls this. */
export async function approve(root: string, student: string, lesson: string): Promise<void> {
  if (!ID.test(student) || !ID.test(lesson)) throw new Error('Not a lesson');
  await setLessonStatus(root, student, lesson, 'approved');
  const all = await records();
  all[key(root, student, lesson)] = fingerprint(await readFile(planFile(root, student, lesson), 'utf8'));
  await writeAtomic(file(), `${JSON.stringify(all, null, 2)}\n`);
}

export type Approval = 'approved' | 'none' | 'changed';

export async function approval(root: string, student: string, lesson: string): Promise<Approval> {
  const recorded = (await records())[key(root, student, lesson)];
  if (!recorded) return 'none';
  const plan = await readFile(planFile(root, student, lesson), 'utf8').catch(() => '');
  return fingerprint(plan) === recorded ? 'approved' : 'changed';
}
