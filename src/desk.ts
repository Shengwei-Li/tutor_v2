import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { parse } from 'yaml';
import { esc, markdown } from './md.ts';
import { exists } from './proc.ts';
import { buildShare } from './share.ts';
import { selfCommand } from './paths.ts';
import { TEMPLATES } from './tex.ts';
import { ID, LESSON_STATUS, listStudents, readStudent, setLessonStatus, studentsDir, type Lesson, type LessonStatus, type Student } from './workspace.ts';

/**
 * The desk: a local web page over the workspace. It says what needs the tutor (plans to approve,
 * lessons to prepare or record), shows the week, the students and their lessons, approves plans and
 * makes the parent page. Work for the agent is a sentence to copy into it. Pages reload when a file
 * changes.
 */

type Lang = 'en' | 'zh';

/** A Latin name inside Chinese text gets a space on each side (帮 Wang Yiran 备). */
const cjk = (name: string) => (/[A-Za-z]/.test(name) ? ` ${name} ` : name);

const T = {
  en: {
    todo: 'Needs you', nothing: 'Nothing waiting. The week is in order.', week: 'Week', students: 'Students', noStudents: 'No students yet. Open your agent in this folder and describe your first student.',
    stages: ['Plan', 'Approved', 'Materials', 'Taught'], notPrepared: 'Not prepared', status: { draft: 'Plan to approve', approved: 'Approved, materials next', ready: 'Materials ready', taught: 'Taught' },
    approve: 'Approve plan', copy: 'Copy for your agent', copied: 'Copied', prev: '← Earlier', next: 'Later →', thisWeek: 'This week', today: 'Today',
    exam: 'Exam', target: 'Target', now: 'Now', days: 'days', past: 'past', roadmap: 'Course plan', noRoadmap: 'No course plan yet.', lessons: 'Lessons', noLessons: 'No lessons yet.', profile: 'Profile',
    materials: 'Materials', noMaterials: 'No PDFs yet.', record: 'After the lesson', plan: 'Plan', all: 'All students', share: 'Make parent page', shareOpen: 'Parent page', calendar: 'Calendar file',
    problems: 'Files to fix', studentEd: 'student', teacherEd: 'teacher', kinds: { handout: 'Handout', worksheet: 'Worksheet', script: 'Script', deck: 'Slides' } as Record<string, string>,
    weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    task: { approve: 'Approve', roadmap: 'Plan course', prepare: 'Prepare', write: 'Materials', record: 'Record', fix: 'Fix' }, countdown: 'Until exam',
    say: {
      prepare: (n: string, d: string) => `Prepare ${n}'s lesson on ${d}.`,
      write: (n: string, d: string) => `The plan for ${n}'s lesson on ${d} is approved. Write the materials and export the PDFs.`,
      record: (n: string, d: string) => `${n}'s lesson on ${d} is done. How it went: `,
      fix: (n: string) => `Run check_workspace for ${n} and fix every file it reports.`,
      roadmap: (n: string) => `Draft a course plan for ${n}.`,
    },
  },
  zh: {
    todo: '待你处理', nothing: '没有待办，这周都安排好了。', week: '周', students: '学生', noStudents: '还没有学生。在这个文件夹里打开你的 agent，描述第一个学生。',
    stages: ['计划', '确认', '材料', '上课'], notPrepared: '未备课', status: { draft: '计划待确认', approved: '已确认，待写材料', ready: '材料已出', taught: '已上课' },
    approve: '确认计划', copy: '复制给 agent', copied: '已复制', prev: '← 上一周', next: '下一周 →', thisWeek: '本周', today: '今天',
    exam: '考试', target: '目标', now: '现在', days: '天', past: '已过', roadmap: '课程规划', noRoadmap: '还没有课程规划。', lessons: '课次', noLessons: '还没有课次。', profile: '画像',
    materials: '材料', noMaterials: '还没有 PDF。', record: '课后记录', plan: '计划', all: '全部学生', share: '生成家长页', shareOpen: '家长页', calendar: '日历文件',
    problems: '需要修正的文件', studentEd: '学生版', teacherEd: '教师版', kinds: { handout: '讲义', worksheet: '练习卷', script: '教案', deck: '幻灯片' } as Record<string, string>,
    weekdays: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
    task: { approve: '确认', roadmap: '规划', prepare: '备课', write: '写材料', record: '记录', fix: '修正' }, countdown: '距考试',
    say: {
      prepare: (n: string, d: string) => `帮${cjk(n)}备 ${d} 的课。`,
      write: (n: string, d: string) => `${n} ${d} 那节课的计划我确认了，按计划把材料写出来并导出 PDF。`,
      record: (n: string, d: string) => `${n} ${d} 的课上完了，情况是：`,
      fix: (n: string) => `运行 check_workspace，把${cjk(n)}的文件问题都修好。`,
      roadmap: (n: string) => `帮${cjk(n)}起草课程规划。`,
    },
  },
};
type Text = (typeof T)['en'];
export const T_EN: Text = T.en;

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const EXAM: Record<string, string> = { 'ielts-academic': 'IELTS Academic', 'ielts-general': 'IELTS General', 'pte-academic': 'PTE Academic' };

export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const md = (date: string) => date.slice(5).replace('-', '/');
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysBetween = (from: string, to: string) => Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000);

export function mondayOf(d: Date): Date {
  return addDays(d, -((d.getDay() + 6) % 7));
}

interface Slot {
  student: Student;
  date: string;
  lesson?: Lesson;
  time?: string;
}

/** Each day of the week: the lessons that exist, and weekly slots with no lesson folder yet. */
export function weekSlots(students: Student[], monday: Date): Slot[][] {
  return DAY_KEYS.map((key, i) => {
    const date = iso(addDays(monday, i));
    const slots: Slot[] = [];
    for (const s of students) {
      const lessons = s.lessons.filter((l) => l.plan?.date === date);
      for (const l of lessons) slots.push({ student: s, date, lesson: l, time: l.plan?.time });
      if (!lessons.length) for (const r of s.profile?.schedule ?? []) if (r.day === key) slots.push({ student: s, date, time: r.time });
    }
    return slots.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
  });
}

export interface Task {
  kind: keyof Text['task'];
  student: Student;
  date?: string;
  what: string;
  /** A page to open, or a sentence to give the agent. */
  href?: string;
  say?: string;
}

/**
 * What needs the tutor, in the order to do it: plans to approve, fixes, materials to commission,
 * lessons in the coming week with nothing prepared, and finished lessons with no record.
 */
export function tasks(students: Student[], today: Date, t: Text): Task[] {
  const now = iso(today);
  const out: Task[] = [];
  const name = (s: Student) => s.profile?.name ?? s.id;
  for (const s of students) {
    if (s.problems.length) out.push({ kind: 'fix', student: s, what: `${s.problems.length} ${t.problems}`, say: t.say.fix(name(s)) });
    if (s.profile && !s.roadmap) out.push({ kind: 'roadmap', student: s, what: t.roadmap, say: t.say.roadmap(name(s)) });
    for (const l of s.lessons) {
      const p = l.plan;
      if (!p) continue;
      const link = `/s/${s.id}/l/${l.id}`;
      if (p.status === 'draft') out.push({ kind: 'approve', student: s, date: p.date, what: p.topic, href: link });
      else if (p.status === 'approved') out.push({ kind: 'write', student: s, date: p.date, what: p.topic, href: link, say: t.say.write(name(s), md(p.date)) });
      else if (p.status === 'ready' && p.date < now && !l.record) out.push({ kind: 'record', student: s, date: p.date, what: p.topic, href: link, say: t.say.record(name(s), md(p.date)) });
    }
  }
  for (let i = 0; i < 7; i++) {
    const day = addDays(today, i);
    const date = iso(day);
    for (const s of students) {
      if (s.lessons.some((l) => l.plan?.date === date)) continue;
      for (const r of s.profile?.schedule ?? []) {
        if (r.day === DAY_KEYS[(day.getDay() + 6) % 7]) out.push({ kind: 'prepare', student: s, date, what: `${t.notPrepared} · ${r.time}`, say: t.say.prepare(name(s), md(date)) });
      }
    }
  }
  const order = ['approve', 'fix', 'write', 'roadmap', 'prepare', 'record'];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.date ?? '').localeCompare(b.date ?? ''));
}

const PLEX = ['IBMPlexSans-Regular.otf', 'IBMPlexSans-Medium.otf', 'IBMPlexSans-SemiBold.otf', 'IBMPlexMono-Regular.otf', 'IBMPlexMono-Medium.otf'];

const CSS = `
@font-face{font-family:Plex;src:url(/fonts/IBMPlexSans-Regular.otf);font-weight:400}
@font-face{font-family:Plex;src:url(/fonts/IBMPlexSans-Medium.otf);font-weight:500}
@font-face{font-family:Plex;src:url(/fonts/IBMPlexSans-SemiBold.otf);font-weight:600}
@font-face{font-family:PlexMono;src:url(/fonts/IBMPlexMono-Regular.otf);font-weight:400}
@font-face{font-family:PlexMono;src:url(/fonts/IBMPlexMono-Medium.otf);font-weight:500}
:root{--paper:#fff;--ink:#111;--mute:#6b6b6b;--rule:#dcdcdc;--accent:#24508f;--on-accent:#fff}
@media (prefers-color-scheme:dark){:root{--paper:#121212;--ink:#efefef;--mute:#9b9b9b;--rule:#343434;--accent:#94b6ea;--on-accent:#121212}}
*{box-sizing:border-box;margin:0}
body{background:var(--paper);color:var(--ink);font:15px/1.55 Plex,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px}
main{max-width:1200px;margin:0 auto;padding:28px 40px 80px}
.mono{font-family:PlexMono,ui-monospace,monospace;font-variant-numeric:tabular-nums}
.mute{color:var(--mute)}
.top{display:flex;align-items:baseline;gap:28px;padding-bottom:14px;border-bottom:2px solid var(--ink)}
.brand{font-weight:600;letter-spacing:-.01em}.top nav{display:flex;gap:20px;color:var(--mute)}.top .date{margin-left:auto}
.hero{display:flex;align-items:flex-end;gap:24px;flex-wrap:wrap;margin:36px 0 28px}
h1{font-size:clamp(34px,5.4vw,64px);font-weight:600;line-height:.95;letter-spacing:-.025em}
.label{font:500 12px/1 PlexMono,ui-monospace,monospace;letter-spacing:.04em;color:var(--mute);display:flex;gap:10px;align-items:baseline;padding:10px 0;border-top:2px solid var(--ink)}
.label b{color:var(--ink);font-weight:500}
section{margin-top:44px}
.tasks{list-style:none;padding:0}
.tasks li{display:grid;grid-template-columns:84px 64px minmax(0,1fr) auto;gap:16px;align-items:baseline;padding:12px 0;border-bottom:1px solid var(--rule)}
.tasks .kind{font-weight:600}.tasks .kind.approve{color:var(--accent)}
.facts{display:flex;flex-wrap:wrap;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
.facts div{padding:10px 28px 10px 0;margin-right:28px;border-right:1px solid var(--rule)}.facts div:last-child{border:0}
.facts dt{font:500 11px/1.4 PlexMono,ui-monospace,monospace;color:var(--mute);letter-spacing:.04em}.facts dd{font:500 20px/1.3 PlexMono,ui-monospace,monospace}
.week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-top:1px solid var(--ink)}
.day{padding:10px 12px 18px 0;min-height:160px}.day+.day{padding-left:12px;border-left:1px solid var(--rule)}
.day .n{font:400 34px/1 PlexMono,ui-monospace,monospace;letter-spacing:-.03em}.day .w{font-size:12px;color:var(--mute);margin:4px 0 12px}
.day.today .n{color:var(--accent)}.day.today .w{color:var(--accent);font-weight:500}
.slot{display:block;padding:8px 0;border-top:1px solid var(--rule)}.slot:hover{text-decoration:none}.slot:hover .who{text-decoration:underline;text-underline-offset:3px}
.slot .t{font:500 12px/1.3 PlexMono,ui-monospace,monospace}.slot .who{font-weight:500;line-height:1.3;margin-top:2px}.slot .what{font-size:13px;color:var(--mute);line-height:1.35;margin:2px 0 6px}
.slot.empty .who,.slot.empty .t{color:var(--mute);font-weight:400}
.pipe{display:inline-flex;gap:3px;vertical-align:middle}.pipe i{width:14px;height:5px;background:var(--rule)}.pipe i.on{background:var(--ink)}.pipe.draft i.on{background:var(--accent)}
.state{font-size:12px;color:var(--mute);margin-left:8px}.state.draft{color:var(--accent);font-weight:500}
.rows{list-style:none;padding:0}.rows li{display:flex;gap:18px;align-items:baseline;padding:11px 0;border-bottom:1px solid var(--rule);flex-wrap:wrap}
.rows .grow{flex:1;min-width:0}
.roster li{display:grid;grid-template-columns:minmax(0,1fr) 150px 96px 72px 170px;gap:16px}.roster .num{text-align:right}
.bar{display:inline-block;width:120px;height:3px;background:var(--rule);vertical-align:middle}.bar i{display:block;height:100%;background:var(--ink)}
.cols{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:56px}.cols3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:40px}
.prose h2,.prose h3,.prose h4{font-size:15px;font-weight:600;margin:20px 0 6px}.prose>:first-child{margin-top:0}.prose p,.prose ul,.prose table{margin:8px 0}
.prose ul{padding-left:18px}.prose li.check{list-style:none;margin-left:-18px}
.box{display:inline-block;width:11px;height:11px;border:1.5px solid var(--ink);margin-right:9px;vertical-align:-1px}.box.done{background:var(--ink)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:7px 10px 7px 0;border-bottom:1px solid var(--rule);vertical-align:top}th{font:500 11px PlexMono,ui-monospace,monospace;color:var(--mute);letter-spacing:.04em;border-bottom:1px solid var(--ink)}
code{font-family:PlexMono,ui-monospace,monospace;font-size:13px}
.btn{font:500 14px/1 Plex,"PingFang SC","Microsoft YaHei",sans-serif;padding:10px 16px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--ink);color:var(--paper);text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}.btn.primary:hover{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.btn.small{font-size:13px;padding:6px 10px;border-width:1px}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-left:auto}form{display:inline}
.stages{display:flex;gap:0;margin:20px 0 0}.stages span{flex:1;min-width:84px;padding-top:8px;border-top:5px solid var(--rule);font-size:12px;color:var(--mute);margin-right:3px}
.stages span.on{border-color:var(--ink);color:var(--ink)}.stages.draft span.on{border-color:var(--accent);color:var(--accent)}
.tabs{display:flex;gap:18px;flex-wrap:wrap;margin:2px 0 12px;font-size:14px}.tabs a{color:var(--mute)}.tabs a.on{color:var(--ink);text-decoration:underline;text-underline-offset:5px;text-decoration-thickness:2px}
iframe{display:block;width:100%;height:80vh;border:1px solid var(--ink);background:#fff}
.warn{border-top:2px solid var(--accent);padding:10px 0;color:var(--accent)}.warn li{margin:2px 0}
.empty-note{padding:14px 0;color:var(--mute)}
@media (max-width:900px){main{padding:20px 16px 64px}.cols,.cols3{grid-template-columns:minmax(0,1fr);gap:28px}.week{grid-template-columns:minmax(0,1fr)}
.day,.day+.day{min-height:0;padding:12px 0;border-left:0;border-top:1px solid var(--rule)}.day .w{display:inline;margin-left:8px}.day .n{display:inline;font-size:22px}
.tasks li{grid-template-columns:64px minmax(0,1fr);gap:4px 12px}.roster li{display:flex;flex-wrap:wrap;gap:4px 14px}.roster li>a{flex-basis:100%}.tasks li>:nth-child(n+3){grid-column:2}.top nav{display:none}}
`;

const SCRIPT = `
// ?static: no live reload (printing, screenshots).
if (!new URLSearchParams(location.search).has('static')) new EventSource('/events').onmessage = () => location.reload();
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const text = b.dataset.copy;
  let ok = await navigator.clipboard?.writeText(text).then(() => true, () => false);
  if (!ok) {
    const area = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(area);
    area.select();
    ok = document.execCommand('copy');
    area.remove();
  }
  // Last resort: show the sentence selected, ready for Ctrl+C.
  if (!ok) return void prompt('', text);
  const was = b.textContent;
  b.textContent = b.dataset.done;
  setTimeout(() => (b.textContent = was), 1600);
});
`;

class NotFound extends Error {}

export interface Desk {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Tell open pages to reload. */
  changed(): void;
  /** How long nobody has looked: 0 while a page is open. */
  idleMs(): number;
}

export function createDesk(root: string, opts: { lang?: Lang; now?: () => Date } = {}): Desk {
  const token = randomBytes(16).toString('hex');
  const now = opts.now ?? (() => new Date());
  const clients = new Set<ServerResponse>();
  let lastSeen = Date.now();

  async function config(): Promise<{ lang: Lang; studio?: string }> {
    const c = ((await readFile(path.join(root, 'tutordesk.yaml'), 'utf8').then(parse, () => null)) ?? {}) as { language?: string; studio?: string };
    const lang = opts.lang ?? (c.language === 'zh' || c.language === 'en' ? c.language : Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh') ? 'zh' : 'en');
    return { lang, studio: c.studio };
  }

  const pipe = (s?: LessonStatus) => `<span class="pipe${s === 'draft' ? ' draft' : ''}" aria-hidden="true">${LESSON_STATUS.map((x, i) => `<i${s && LESSON_STATUS.indexOf(s) >= i ? ' class="on"' : ''}></i>`).join('')}</span>`;
  const state = (t: Text, s?: LessonStatus) => `${pipe(s)}<span class="state${s === 'draft' ? ' draft' : ''}">${esc(s ? t.status[s] : t.notPrepared)}</span>`;
  const post = (action: string, label: string, primary = false) => `<form method="post" action="${esc(action)}"><input type="hidden" name="token" value="${token}"><button class="btn${primary ? ' primary' : ''}">${esc(label)}</button></form>`;
  const copy = (t: Text, say: string, small = true) => `<button class="btn${small ? ' small' : ''}" data-copy="${esc(say)}" data-done="${esc(t.copied)}">${esc(t.copy)}</button>`;
  const fixes = (s: Student, t: Text, only?: string) => {
    const ps = only ? s.problems.filter((p) => p.file.includes(only)) : s.problems;
    return ps.length ? `<div class="warn"><b>${esc(t.problems)}</b><ul class="rows">${ps.map((p) => `<li><code>${esc(p.file)}</code> <span>${esc(p.message)}</span></li>`).join('')}</ul></div>` : '';
  };

  const page = (lang: Lang, t: Text, title: string, here: 'week' | 'students' | '', body: string) => {
    const d = now();
    return `<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>
<header class="top"><a class="brand" href="/">TutorDesk</a><nav><a href="/"${here === 'week' ? ' aria-current="page"' : ''}>${esc(t.thisWeek)}</a><a href="/#students"${here === 'students' ? ' aria-current="page"' : ''}>${esc(t.students)}</a></nav><span class="date mono">${iso(d).replace(/-/g, '.')} ${esc(t.weekdays[(d.getDay() + 6) % 7]!)}</span></header>
${body}</main><script>${SCRIPT}</script></body></html>`;
  };

  async function home(url: URL, lang: Lang, t: Text): Promise<string> {
    const students = await listStudents(root);
    const today = now();
    const offset = Number(url.searchParams.get('w') ?? 0) || 0;
    const monday = addDays(mondayOf(today), offset * 7);
    const sunday = addDays(monday, 6);

    const todo = tasks(students, today, t);
    const taskList = todo.length
      ? `<ol class="tasks">${todo
          .map((k) => {
            const who = esc(k.student.profile?.name ?? k.student.id);
            const action = k.kind === 'approve' ? `<a class="btn small" href="${k.href}">${esc(t.approve)}</a>` : k.say ? copy(t, k.say) : '';
            return `<li><span class="kind ${k.kind}">${esc(t.task[k.kind])}</span><span class="mono mute">${k.date ? md(k.date) : ''}</span><span><a href="${k.href ?? `/s/${k.student.id}`}">${who}</a> <span class="mute">${esc(k.what)}</span></span>${action}</li>`;
          })
          .join('')}</ol>`
      : `<p class="empty-note">${esc(t.nothing)}</p>`;

    const todayIso = iso(today);
    const days = weekSlots(students, monday)
      .map((slots, i) => {
        const d = addDays(monday, i);
        const items = slots
          .map((s) => {
            const who = esc(s.student.profile?.name ?? s.student.id);
            if (!s.lesson) return `<a class="slot empty" href="/s/${s.student.id}"><div class="t">${esc(s.time ?? '')}</div><div class="who">${who}</div><div class="what">${esc(t.notPrepared)}</div></a>`;
            const p = s.lesson.plan;
            return `<a class="slot" href="/s/${s.student.id}/l/${s.lesson.id}"><div class="t">${esc(s.time ?? '')}</div><div class="who">${who}</div><div class="what">${esc(p?.topic ?? s.lesson.id)}</div>${pipe(p?.status)}</a>`;
          })
          .join('');
        return `<div class="day${iso(d) === todayIso ? ' today' : ''}"><div class="n">${String(d.getDate()).padStart(2, '0')}</div><div class="w">${esc(t.weekdays[i]!)}${iso(d) === todayIso ? ` · ${esc(t.today)}` : ''}</div>${items}</div>`;
      })
      .join('');

    const roster = students.length
      ? `<ul class="rows roster">${students
          .map((s) => {
            const p = s.profile;
            const r = s.roadmap;
            const left = p?.exam_date ? daysBetween(todayIso, p.exam_date) : null;
            const progress = r && r.total ? `<span class="mono">${r.done}/${r.total} <span class="bar" style="width:100px;margin-left:8px"><i style="width:${Math.round((100 * r.done) / r.total)}%"></i></span></span>` : '<span></span>';
            return `<li><a href="/s/${s.id}"><b>${esc(p?.name ?? s.id)}</b></a><span class="mute">${esc(p ? EXAM[p.exam] ?? p.exam : '')}</span><span class="mono">${p ? `${p.current ?? '–'} → ${p.target}` : ''}</span><span class="mono mute num">${left !== null && left >= 0 ? `${left} ${esc(t.days)}` : ''}</span>${progress}</li>`;
          })
          .join('')}</ul>`
      : `<p class="empty-note">${esc(t.noStudents)}</p>`;

    return page(
      lang,
      t,
      'TutorDesk',
      'week',
      `<div class="hero"><h1>${esc(t.todo)}</h1><span class="mono mute" style="font-size:20px">${todo.length}</span></div>
${taskList}
<section><div class="label"><b>${esc(offset === 0 ? t.thisWeek : t.week)}</b><span class="mono">${md(iso(monday))} – ${md(iso(sunday))}</span><span style="margin-left:auto;display:flex;gap:16px"><a href="/?w=${offset - 1}">${esc(t.prev)}</a>${offset ? `<a href="/">${esc(t.thisWeek)}</a>` : ''}<a href="/?w=${offset + 1}">${esc(t.next)}</a></span></div>
<div class="week">${days}</div></section>
<section id="students"><div class="label"><b>${esc(t.students)}</b><span class="mono">${students.length}</span></div>${roster}</section>`,
    );
  }

  async function student(id: string, lang: Lang, t: Text): Promise<string> {
    if (!(await exists(path.join(studentsDir(root), id)))) throw new NotFound();
    const s = await readStudent(root, id);
    const p = s.profile;
    const name = p?.name ?? id;
    const today = iso(now());
    const left = p?.exam_date ? daysBetween(today, p.exam_date) : null;
    const facts = p
      ? `<dl class="facts"><div><dt>${esc(t.exam)}</dt><dd>${esc(EXAM[p.exam] ?? p.exam)}</dd></div><div><dt>${esc(t.now)} → ${esc(t.target)}</dt><dd>${p.current ?? '–'} → ${p.target}</dd></div>${p.exam_date ? `<div><dt>${esc(t.countdown)} · ${esc(md(p.exam_date))}</dt><dd>${left !== null && left >= 0 ? `${left} ${esc(t.days)}` : esc(t.past)}</dd></div>` : ''}${s.roadmap?.total ? `<div><dt>${esc(t.roadmap)}</dt><dd>${s.roadmap.done}/${s.roadmap.total}</dd></div>` : ''}</dl>`
      : '';
    const shared = await exists(path.join(studentsDir(root), id, 'share', 'index.html'));
    const lessons = [...s.lessons].reverse();
    return page(
      lang,
      t,
      name,
      'students',
      `<div class="hero"><h1>${esc(name)}</h1><div class="actions">${shared ? `<a href="/files/students/${id}/share/index.html" target="_blank">${esc(t.shareOpen)}</a><a href="/files/students/${id}/share/lessons.ics">${esc(t.calendar)}</a>` : ''}${post(`/s/${id}/share`, t.share)}</div></div>
${facts}${fixes(s, t)}
<section class="cols3">
<div><div class="label"><b>${esc(t.lessons)}</b><span class="mono">${lessons.length}</span></div>${lessons.length ? `<ul class="rows">${lessons.map((l) => `<li><span class="mono mute">${esc(l.plan ? md(l.plan.date) : '')}</span><a class="grow" href="/s/${id}/l/${l.id}">${esc(l.plan?.topic ?? l.id)}</a>${pipe(l.plan?.status)}</li>`).join('')}</ul>` : `<p class="empty-note">${esc(t.noLessons)}</p>`}</div>
<div><div class="label"><b>${esc(t.roadmap)}</b>${s.roadmap?.total ? `<span class="mono">${s.roadmap.done}/${s.roadmap.total}</span>` : ''}</div>${s.roadmap ? `<div class="prose">${markdown(s.roadmap.body)}</div>` : `<p class="empty-note">${esc(t.noRoadmap)}</p>${copy(t, t.say.roadmap(name))}`}</div>
<div><div class="label"><b>${esc(t.profile)}</b></div><div class="prose">${markdown(s.profileBody) || '<p class="empty-note">–</p>'}</div></div>
</section>`,
    );
  }

  async function lesson(id: string, lessonId: string, lang: Lang, t: Text): Promise<string> {
    if (!(await exists(path.join(studentsDir(root), id, 'lessons', lessonId)))) throw new NotFound();
    const s = await readStudent(root, id);
    const x = s.lessons.find((y) => y.id === lessonId);
    if (!x) throw new NotFound();
    const p = x.plan;
    const name = s.profile?.name ?? id;
    const status = p?.status;
    const when = p ? md(p.date) : '';
    let action = '';
    if (status === 'draft') action = post(`/s/${id}/l/${lessonId}/approve`, t.approve, true);
    else if (status === 'approved') action = copy(t, t.say.write(name, when), false);
    else if (status === 'ready' && p && p.date <= iso(now()) && !x.record) action = copy(t, t.say.record(name, when), false);

    // Student editions first, each named by what it is.
    const pdfs = [...x.pdfs]
      .sort((a, c) => Number(a.endsWith('-teacher.pdf')) - Number(c.endsWith('-teacher.pdf')) || a.localeCompare(c))
      .map((f) => {
        const kind = f.replace(/(-teacher)?\.pdf$/, '');
        return { url: `/files/students/${id}/lessons/${lessonId}/out/${f}`, label: `${t.kinds[kind] ?? kind} · ${f.endsWith('-teacher.pdf') ? t.teacherEd : t.studentEd}` };
      });
    const record = await readFile(path.join(studentsDir(root), id, 'lessons', lessonId, 'record.md'), 'utf8').catch(() => null);
    const stages = `<div class="stages${status === 'draft' ? ' draft' : ''}">${t.stages.map((label, i) => `<span${status && LESSON_STATUS.indexOf(status) >= i ? ' class="on"' : ''}>${esc(label)}</span>`).join('')}</div>`;
    return page(
      lang,
      t,
      p?.topic ?? lessonId,
      'students',
      `<div class="hero" style="margin-bottom:8px"><div><p style="margin-bottom:14px"><a href="/s/${id}">← ${esc(name)}</a></p><h1>${esc(p?.topic ?? lessonId)}</h1></div><div class="actions">${action}</div></div>
<p class="mono mute">${esc([p?.date.replace(/-/g, '.'), p?.time, p?.minutes ? `${p.minutes} min` : ''].filter(Boolean).join('  ·  '))}</p>
${stages}${fixes(s, t, `/lessons/${lessonId}/`)}
<section class="cols">
<div><div class="label"><b>${esc(t.plan)}</b></div><div class="prose">${markdown(x.planBody) || '<p class="empty-note">–</p>'}</div>${record ? `<div class="label" style="margin-top:28px"><b>${esc(t.record)}</b></div><div class="prose">${markdown(record.replace(/^﻿?---[\s\S]*?---\r?\n?/, ''))}</div>` : ''}</div>
<div><div class="label"><b>${esc(t.materials)}</b><span class="mono">${pdfs.length}</span></div>${pdfs.length ? `<nav class="tabs">${pdfs.map((f, i) => `<a href="${f.url}" target="pdf"${i === 0 ? ' class="on"' : ''} onclick="document.querySelectorAll('.tabs a').forEach(a=>a.classList.toggle('on',a===this))">${esc(f.label)}</a>`).join('')}</nav><iframe name="pdf" title="${esc(t.materials)}" src="${pdfs[0]!.url}"></iframe>` : `<p class="empty-note">${esc(t.noMaterials)}</p>`}</div>
</section>`,
    );
  }

  /** Only lesson PDFs, the generated parent page and the desk's fonts leave the workspace this way. */
  async function file(rel: string, res: ServerResponse): Promise<void> {
    const parts = rel.split('/');
    const okPdf = parts.length === 6 && parts[0] === 'students' && ID.test(parts[1]!) && parts[2] === 'lessons' && ID.test(parts[3]!) && parts[4] === 'out' && /^[a-z0-9-]+\.pdf$/.test(parts[5]!);
    const okShare = parts.length === 4 && parts[0] === 'students' && ID.test(parts[1]!) && parts[2] === 'share' && /^(index\.html|lessons\.ics|[a-z0-9-]+\.pdf)$/.test(parts[3]!);
    if (!okPdf && !okShare) throw new NotFound();
    const data = await readFile(path.join(root, ...parts)).catch(() => {
      throw new NotFound();
    });
    const type = rel.endsWith('.pdf') ? 'application/pdf' : rel.endsWith('.ics') ? 'text/calendar; charset=utf-8' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(data);
  }

  async function body(req: IncomingMessage): Promise<URLSearchParams> {
    let s = '';
    for await (const c of req) {
      s += c;
      if (s.length > 10_000) break;
    }
    return new URLSearchParams(s);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    lastSeen = Date.now();
    // Only this computer: refuse other host names, which is how a web page could reach a local server.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { lang } = await config();
    const t = T[lang];
    const html = (h: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'SAMEORIGIN', 'x-content-type-options': 'nosniff' });
      res.end(h);
    };
    try {
      if (url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': ok\n\n');
        clients.add(res);
        req.on('close', () => {
          clients.delete(res);
          lastSeen = Date.now();
        });
        return;
      }
      if (req.method === 'POST') {
        const form = await body(req);
        if (form.get('token') !== token) {
          res.writeHead(403).end();
          return;
        }
        const approve = /^\/s\/([a-z0-9-]+)\/l\/([a-z0-9-]+)\/approve$/.exec(url.pathname);
        const share = /^\/s\/([a-z0-9-]+)\/share$/.exec(url.pathname);
        if (approve && ID.test(approve[1]!) && ID.test(approve[2]!)) {
          await setLessonStatus(root, approve[1]!, approve[2]!, 'approved');
          res.writeHead(303, { location: `/s/${approve[1]}/l/${approve[2]}` }).end();
        } else if (share && ID.test(share[1]!)) {
          await buildShare(root, share[1]!, { lang, now: now() });
          res.writeHead(303, { location: `/files/students/${share[1]}/share/index.html` }).end();
        } else throw new NotFound();
        return;
      }
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ app: 'tutordesk', root: path.resolve(root) }));
        return;
      }
      if (url.pathname === '/') return html(await home(url, lang, t));
      const font = /^\/fonts\/([\w-]+\.otf)$/.exec(url.pathname);
      if (font && PLEX.includes(font[1]!)) {
        res.writeHead(200, { 'content-type': 'font/otf', 'cache-control': 'max-age=86400' });
        res.end(await readFile(path.join(TEMPLATES, 'fonts', font[1]!)));
        return;
      }
      const st = /^\/s\/([a-z0-9-]+)$/.exec(url.pathname);
      if (st && ID.test(st[1]!)) return html(await student(st[1]!, lang, t));
      const ls = /^\/s\/([a-z0-9-]+)\/l\/([a-z0-9-]+)$/.exec(url.pathname);
      if (ls && ID.test(ls[1]!) && ID.test(ls[2]!)) return html(await lesson(ls[1]!, ls[2]!, lang, t));
      if (url.pathname.startsWith('/files/')) return await file(decodeURIComponent(url.pathname.slice(7)), res);
      throw new NotFound();
    } catch (e) {
      if (res.headersSent) return;
      const missing = e instanceof NotFound || e instanceof URIError;
      res.writeHead(missing ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(missing ? 'Not found' : (e as Error).message);
    }
  }

  return {
    handle,
    changed: () => {
      for (const c of clients) c.write('data: changed\n\n');
    },
    idleMs: () => (clients.size ? 0 : Date.now() - lastSeen),
  };
}

export const DESK_PORT = 4321;

/** A desk already serving this workspace (another agent conversation started it), if any. */
async function runningDesk(root: string, port: number): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    const h = (await r.json()) as { app?: string; root?: string };
    return h.app === 'tutordesk' && h.root === path.resolve(root) ? `http://127.0.0.1:${port}/` : null;
  } catch {
    return null;
  }
}

/**
 * Serve the desk for a workspace on this computer only, reloading pages when files change. If a desk
 * for the same workspace is already up, that one is used. Returns its address.
 */
export async function startDesk(root: string, o: { port?: number; background?: boolean; /** Quit after this long with no page open. */ idleExitMs?: number } = {}): Promise<string> {
  const port = o.port ?? DESK_PORT;
  for (let p = port; p < port + 20; p++) {
    const existing = await runningDesk(root, p);
    if (existing) return existing;
  }
  const desk = createDesk(root);
  const server = createServer((req, res) => void desk.handle(req, res));
  const listen = (p: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' && p < port + 20 ? resolve(listen(p + 1)) : reject(e)));
      server.listen(p, '127.0.0.1', () => resolve(p));
    });
  const actual = await listen(port);
  // Inside an agent's MCP server the desk must not keep the process alive after the agent leaves.
  if (o.background) server.unref();
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(root, { recursive: true }, (_e, f) => {
    if (f && /^(\.git|\.agents|\.claude|node_modules)[\\/]/.test(f)) return;
    clearTimeout(timer);
    timer = setTimeout(desk.changed, 300);
  });
  if (o.background) watcher.unref();
  if (o.idleExitMs) {
    const limit = o.idleExitMs;
    setInterval(() => desk.idleMs() > limit && process.exit(0), Math.min(60_000, limit)).unref();
  }
  return `http://127.0.0.1:${actual}/`;
}

/**
 * The desk as its own quiet process (the desktop shortcut): no window, it outlives this command and
 * quits after half an hour with no page open. An agent's or an earlier desk for the workspace is reused.
 */
export async function startDetachedDesk(root: string, port = DESK_PORT): Promise<string> {
  const find = async () => {
    for (let p = port; p < port + 20; p++) {
      const url = await runningDesk(root, p);
      if (url) return url;
    }
    return null;
  };
  const running = await find();
  if (running) return running;
  const self = selfCommand();
  spawn(self.command, [...self.args, 'desk', root, '--port', String(port)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const url = await find();
    if (url) return url;
  }
  throw new Error('The desk did not start.');
}

export function openBrowser(url: string): void {
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(opener[0] as string, opener[1] as string[], { stdio: 'ignore', detached: true }).unref();
}
