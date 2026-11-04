import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { parseMd } from './frontmatter.ts';
import { esc } from './md.ts';
import { readStudent, studentsDir } from './workspace.ts';

/**
 * What a parent or student may see, written to students/<id>/share/: index.html (one file, opens on a
 * phone), lessons.ics (the weekly lessons for a calendar) and the student editions of lesson PDFs.
 *
 * It reads only: the profile's YAML fields, the roadmap, lesson dates, topics and statuses, each
 * record's `for_parents` line, final essay bands, and student-edition PDFs. Never notes.md, the profile
 * text, the rest of a record, plans, or teacher editions.
 */

const Review = z.object({ date: z.string(), task: z.string().optional(), final: z.record(z.string(), z.number()).optional() });

const TEXT = {
  en: { progress: 'Course progress', done: 'Lessons done', lessons: 'lessons', examIn: '{n} days to the exam', target: 'Target', now: 'Latest', recent: 'Recent lessons', next: 'Next lessons', writing: 'Writing bands', materials: 'Lesson materials', updated: 'Updated', calendar: 'Add the lessons to your calendar', lesson: 'English lesson' },
  zh: { progress: '课程进度', done: '已完成', lessons: '节课', examIn: '距考试 {n} 天', target: '目标', now: '最近成绩', recent: '最近的课', next: '接下来的课', writing: '写作分数', materials: '课堂讲义', updated: '更新于', calendar: '把上课时间加入手机日历', lesson: '英语课' },
};
const DAY_RRULE = { mon: 'MO', tue: 'TU', wed: 'WE', thu: 'TH', fri: 'FR', sat: 'SA', sun: 'SU' } as const;
const EXAM: Record<string, string> = { 'ielts-academic': 'IELTS Academic', 'ielts-general': 'IELTS General', 'pte-academic': 'PTE Academic' };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function buildShare(root: string, id: string, o: { lang: 'en' | 'zh'; now?: Date }): Promise<string> {
  const t = TEXT[o.lang];
  const now = o.now ?? new Date();
  const today = iso(now);
  const s = await readStudent(root, id);
  const p = s.profile;
  if (!p) throw new Error(`students/${id}/profile.md needs fixing first: ${s.problems.map((x) => x.message).join('; ')}`);
  const dir = path.join(studentsDir(root), id, 'share');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const config = (parse(await readFile(path.join(root, 'tutordesk.yaml'), 'utf8').catch(() => '')) ?? {}) as { studio?: string; tutor?: string };

  // Roadmap: progress per section, from its headings and checkboxes only.
  const phases: { title: string; done: number; total: number }[] = [];
  if (s.roadmap) {
    for (const line of s.roadmap.body.split(/\r?\n/)) {
      const h = /^##\s+(.*)$/.exec(line);
      if (h) phases.push({ title: h[1]!.trim(), done: 0, total: 0 });
      const c = /^\s*[-*] \[([ xX])\]/.exec(line);
      if (c && phases.length) {
        phases.at(-1)!.total++;
        if (c[1] !== ' ') phases.at(-1)!.done++;
      }
    }
  }

  const taught = s.lessons.filter((l) => l.plan?.status === 'taught').reverse().slice(0, 6);
  const upcoming = s.lessons.filter((l) => l.plan && l.plan.date >= today && l.plan.status !== 'taught').slice(0, 4);

  // Student editions of the handout and worksheet of recent lessons.
  const pdfs: string[] = [];
  for (const l of s.lessons.filter((x) => x.plan && x.plan.status !== 'draft').reverse().slice(0, 4)) {
    for (const f of l.pdfs.filter((f) => /^(handout|worksheet)\.pdf$/.test(f))) {
      const name = `${l.id}-${f}`;
      await copyFile(path.join(studentsDir(root), id, 'lessons', l.id, 'out', f), path.join(dir, name));
      pdfs.push(name);
    }
  }

  const bands: { date: string; overall: number }[] = [];
  for (const e of (await readdir(path.join(studentsDir(root), id, 'essays')).catch(() => [] as string[])).sort()) {
    const text = await readFile(path.join(studentsDir(root), id, 'essays', e, 'review.md'), 'utf8').catch(() => null);
    const r = text ? Review.safeParse(parseMd(text).data) : null;
    const scores = r?.success ? Object.values(r.data.final ?? {}) : [];
    if (r?.success && scores.length) bands.push({ date: r.data.date, overall: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 2) / 2 });
  }

  const daysLeft = p.exam_date ? Math.ceil((new Date(`${p.exam_date}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86_400_000) : null;
  const done = s.roadmap?.done ?? 0;
  const total = s.roadmap?.total ?? 0;
  const html = `<!doctype html><html lang="${o.lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)}</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--text:#1d1d1b;--muted:#6b6a66;--line:#e4e3de;--accent:#24508f}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1e;--text:#ecebe6;--muted:#9c9a93;--line:#33322f;--accent:#8fb2e6}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0}h2{font-size:15px;margin:24px 0 8px;color:var(--muted);font-weight:500}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.muted{color:var(--muted)}
.bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden;margin:6px 0}.bar i{display:block;height:100%;background:var(--accent)}
.stats{display:flex;gap:12px}.stats div{flex:1}.big{font-size:24px;font-weight:600}
ul{list-style:none;padding:0;margin:0}li{padding:8px 0;border-bottom:1px solid var(--line)}li:last-child{border:0}a{color:var(--accent)}
</style></head><body><main>
<h1>${esc(p.name)}</h1>
<div class="muted">${esc([EXAM[p.exam] ?? p.exam, config.studio, daysLeft !== null && daysLeft >= 0 ? t.examIn.replace('{n}', String(daysLeft)) : ''].filter(Boolean).join(' · '))}</div>
<h2>${esc(t.progress)}</h2><div class="card">
<div class="stats"><div><div class="muted">${esc(t.target)}</div><div class="big">${p.target}</div></div>${p.current !== undefined ? `<div><div class="muted">${esc(t.now)}</div><div class="big">${p.current}</div></div>` : ''}${total ? `<div><div class="muted">${esc(t.done)}</div><div class="big">${done}/${total}</div></div>` : ''}</div>
${phases.map((ph) => `<div style="margin-top:10px">${esc(ph.title)} <span class="muted">${ph.done}/${ph.total}</span><div class="bar"><i style="width:${ph.total ? Math.round((100 * ph.done) / ph.total) : 0}%"></i></div></div>`).join('')}
</div>
${bands.length ? `<h2>${esc(t.writing)}</h2><div class="card"><ul>${bands.map((b) => `<li>${esc(b.date)} <b style="float:right">${b.overall}</b></li>`).join('')}</ul></div>` : ''}
${taught.length ? `<h2>${esc(t.recent)}</h2><div class="card"><ul>${taught.map((l) => `<li><span class="muted">${esc(l.plan!.date)}</span> ${esc(l.plan!.topic)}${l.record?.for_parents ? `<div>${esc(l.record.for_parents)}</div>` : ''}</li>`).join('')}</ul></div>` : ''}
${upcoming.length ? `<h2>${esc(t.next)}</h2><div class="card"><ul>${upcoming.map((l) => `<li><span class="muted">${esc(l.plan!.date)} ${esc(l.plan!.time ?? '')}</span> ${esc(l.plan!.topic)}</li>`).join('')}</ul></div>` : ''}
${pdfs.length ? `<h2>${esc(t.materials)}</h2><div class="card"><ul>${pdfs.map((f) => `<li><a href="${esc(f)}">${esc(f)}</a></li>`).join('')}</ul></div>` : ''}
${p.schedule.length ? `<p><a href="lessons.ics">${esc(t.calendar)}</a></p>` : ''}
<p class="muted" style="font-size:13px">${esc(t.updated)} ${esc(today)}${config.tutor ? ` · ${esc(config.tutor)}` : ''}</p>
</main></body></html>`;
  await writeFile(path.join(dir, 'index.html'), html);
  await writeFile(path.join(dir, 'lessons.ics'), calendar(p.name, p.schedule, p.exam_date, now, `${t.lesson}${config.tutor ? ` · ${config.tutor}` : ''}`, id));
  return dir;
}

/** The weekly lessons as repeating events (local time), until the exam if there is one. */
export function calendar(name: string, schedule: { day: keyof typeof DAY_RRULE; time: string; minutes: number }[], examDate: string | undefined, now: Date, title: string, uid: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const icsText = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const events = schedule.map((slot, i) => {
    // The first occurrence on or after today.
    const first = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const want = Object.keys(DAY_RRULE).indexOf(slot.day);
    while ((first.getDay() + 6) % 7 !== want) first.setDate(first.getDate() + 1);
    const [h, m] = slot.time.split(':').map(Number) as [number, number];
    const start = new Date(first.getFullYear(), first.getMonth(), first.getDate(), h, m);
    const end = new Date(start.getTime() + slot.minutes * 60_000);
    const local = (d: Date) => `${iso(d).replace(/-/g, '')}T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`;
    const until = examDate ? `;UNTIL=${examDate.replace(/-/g, '')}T235959` : '';
    return ['BEGIN:VEVENT', `UID:${uid}-${slot.day}-${slot.time.replace(':', '')}-${i}@tutordesk`, `DTSTAMP:${stamp}`, `DTSTART:${local(start)}`, `DTEND:${local(end)}`, `RRULE:FREQ=WEEKLY;BYDAY=${DAY_RRULE[slot.day]}${until}`, `SUMMARY:${icsText(`${title}: ${name}`)}`, 'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(title)}`, 'END:VALARM', 'END:VEVENT'].join('\r\n');
  });
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TutorDesk//EN', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR', ''].join('\r\n');
}
