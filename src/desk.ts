import { randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse } from 'yaml';
import { esc, markdown } from './md.ts';
import { buildShare } from './share.ts';
import { ID, listStudents, readStudent, setLessonStatus, studentsDir, type Lesson, type LessonStatus, type Student } from './workspace.ts';

/**
 * The desk: a local web page over the workspace. It shows the week, the students and their lessons,
 * lets the tutor approve a plan and make the parent page, and reloads whenever a file changes.
 * Everything else is done by talking to the agent, or by editing the files.
 */

type Lang = 'en' | 'zh';
const T = {
  en: {
    week: 'This week', prev: 'Previous week', next: 'Next week', students: 'Students', noStudents: 'No students yet. Open your agent in this folder and describe your first student.',
    notPrepared: 'not prepared', draft: 'Plan to approve', approved: 'Approved, materials next', ready: 'Materials ready', taught: 'Taught',
    approve: 'Approve plan', target: 'target', current: 'now', examIn: 'exam in {n} days', examPast: 'exam was {d}', roadmap: 'Course plan', noRoadmap: 'No course plan yet: ask your agent for one.',
    lessons: 'Lessons', profile: 'Profile', materials: 'Materials', noMaterials: 'No PDFs yet.', record: 'After the lesson', plan: 'Plan', back: 'All students',
    share: 'Make parent page', shareOpen: 'Open parent page', studentEd: 'student', teacherEd: 'teacher',
    kinds: { handout: 'Handout', worksheet: 'Worksheet', script: 'Script', deck: 'Slides' }, calendar: 'Calendar file', problems: 'Files to fix', today: 'today',
    days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  },
  zh: {
    week: '本周', prev: '上一周', next: '下一周', students: '学生', noStudents: '还没有学生。在这个文件夹里打开你的 agent，描述第一个学生。',
    notPrepared: '未备课', draft: '计划待确认', approved: '已确认，待写材料', ready: '材料已出', taught: '已上课',
    approve: '确认计划', target: '目标', current: '现在', examIn: '距考试 {n} 天', examPast: '考试日 {d} 已过', roadmap: '课程规划', noRoadmap: '还没有课程规划：让 agent 起草一份。',
    lessons: '课次', profile: '画像', materials: '材料', noMaterials: '还没有 PDF。', record: '课后记录', plan: '计划', back: '全部学生',
    share: '生成家长页', shareOpen: '打开家长页', studentEd: '学生版', teacherEd: '教师版',
    kinds: { handout: '讲义', worksheet: '练习卷', script: '教案', deck: '幻灯片' }, calendar: '日历文件', problems: '需要修正的文件', today: '今天',
    days: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
  },
} satisfies Record<Lang, Record<string, string | string[] | Record<string, string>>>;

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const EXAM: Record<string, string> = { 'ielts-academic': 'IELTS Academic', 'ielts-general': 'IELTS General', 'pte-academic': 'PTE Academic' };

export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function mondayOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}

interface Slot {
  student: Student;
  lesson?: Lesson;
  time?: string;
}

/** Each day of the week: the lessons that exist, and weekly slots with no lesson folder yet. */
export function weekSlots(students: Student[], monday: Date): Slot[][] {
  return DAY_KEYS.map((key, i) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    const date = iso(day);
    const slots: Slot[] = [];
    for (const s of students) {
      const lessons = s.lessons.filter((l) => l.plan?.date === date);
      for (const l of lessons) slots.push({ student: s, lesson: l, time: l.plan?.time });
      if (!lessons.length) for (const r of s.profile?.schedule ?? []) if (r.day === key) slots.push({ student: s, time: r.time });
    }
    return slots.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
  });
}

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--text:#1d1d1b;--muted:#6b6a66;--line:#e4e3de;--accent:#24508f;--accent-bg:#e8eef7;--warn:#8a5a00;--warn-bg:#fbf0d9;--ok:#2f6b3a;--ok-bg:#e6f2e7}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1e;--text:#ecebe6;--muted:#9c9a93;--line:#33322f;--accent:#8fb2e6;--accent-bg:#1e2a3b;--warn:#e7b85c;--warn-bg:#3a2e17;--ok:#8fcf98;--ok-bg:#1c2f1f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1080px;margin:0 auto;padding:28px 24px 64px}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:22px;font-weight:600;margin:0 0 4px}h2{font-size:16px;font-weight:600;margin:28px 0 10px}h3,h4{font-size:15px;font-weight:600;margin:18px 0 6px}
.muted{color:var(--muted)}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.spacer{flex:1}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px}.card>:first-child{margin-top:0}.card>:last-child{margin-bottom:0}
.week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--line);gap:1px}
.day{background:var(--card);min-height:130px;padding:8px}.day.today{box-shadow:inset 0 2px 0 var(--accent)}.day h3{margin:0 0 6px;font-size:13px;color:var(--muted);font-weight:500}
.slot{display:block;border-radius:6px;padding:6px 8px;margin-bottom:6px;font-size:13px;line-height:1.4;color:var(--text);border:1px solid var(--line)}
.slot:hover{text-decoration:none;border-color:var(--accent)}.slot b{font-weight:600}.slot small{display:block;color:var(--muted)}.slot.ghost{border-style:dashed}
.chip{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;background:var(--line);color:var(--muted);white-space:nowrap}
.chip.draft{background:var(--warn-bg);color:var(--warn)}.chip.approved,.chip.ready{background:var(--accent-bg);color:var(--accent)}.chip.taught{background:var(--ok-bg);color:var(--ok)}
.slot.draft{border-color:var(--warn)}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
.list{list-style:none;padding:0;margin:0}.list li{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}.list li:last-child{border-bottom:0}
.bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;min-width:120px}.bar i{display:block;height:100%;background:var(--accent)}
ul{padding-left:20px}li.check{list-style:none;margin-left:-20px}.box{display:inline-block;width:13px;height:13px;border:1.5px solid var(--muted);border-radius:3px;margin-right:8px;vertical-align:-1px}.box.done{background:var(--accent);border-color:var(--accent)}
button{font:inherit;font-size:14px;padding:6px 14px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--card)}
iframe{width:100%;height:78vh;border:1px solid var(--line);border-radius:10px;background:#fff}
.grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}@media (max-width:760px){main{padding:20px 16px 48px}.grid2,.week{grid-template-columns:minmax(0,1fr)}.day{min-height:0}}
.problems{border-color:var(--warn)}.problems li{color:var(--warn)}
code{font-size:13px;background:var(--line);padding:0 4px;border-radius:4px}
`;

export interface Desk {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Tell open pages to reload. */
  changed(): void;
}

export function createDesk(root: string, opts: { lang?: Lang; now?: () => Date } = {}): Desk {
  const token = randomBytes(16).toString('hex');
  const now = opts.now ?? (() => new Date());
  const clients = new Set<ServerResponse>();
  const lang = (): Promise<Lang> =>
    opts.lang
      ? Promise.resolve(opts.lang)
      : readFile(path.join(root, 'tutordesk.yaml'), 'utf8')
          .then((t) => (parse(t) as { language?: string })?.language)
          .catch(() => undefined)
          .then((l) => (l === 'zh' || l === 'en' ? l : Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh') ? 'zh' : 'en'));

  const page = (title: string, body: string, l: Lang) =>
    `<!doctype html><html lang="${l === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · TutorDesk</title><style>${CSS}</style></head><body><main>${body}</main><script>new EventSource('/events').onmessage=()=>location.reload()</script></body></html>`;
  const form = (action: string, label: string, primary = false) =>
    `<form method="post" action="${esc(action)}"><input type="hidden" name="token" value="${token}"><button${primary ? ' class="primary"' : ''}>${esc(label)}</button></form>`;
  const chip = (s: LessonStatus | undefined, t: (typeof T)[Lang]) => (s ? `<span class="chip ${s}">${esc(t[s])}</span>` : `<span class="chip">${esc(t.notPrepared)}</span>`);
  const problems = (s: Student, t: (typeof T)[Lang]) =>
    s.problems.length ? `<div class="card problems"><b>${esc(t.problems)}</b><ul>${s.problems.map((p) => `<li><code>${esc(p.file)}</code> ${esc(p.message)}</li>`).join('')}</ul></div>` : '';

  async function home(url: URL, l: Lang): Promise<string> {
    const t = T[l];
    const students = await listStudents(root);
    const offset = Number(url.searchParams.get('w') ?? 0) || 0;
    const monday = mondayOf(now());
    monday.setDate(monday.getDate() + offset * 7);
    const today = iso(now());
    const days = weekSlots(students, monday)
      .map((slots, i) => {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const items = slots
          .map((s) => {
            const name = esc(s.student.profile?.name ?? s.student.id);
            if (!s.lesson) return `<a class="slot ghost" href="/s/${s.student.id}"><b>${esc(s.time ?? '')} ${name}</b><small>${esc(t.notPrepared)}</small></a>`;
            return `<a class="slot ${s.lesson.plan?.status ?? ''}" href="/s/${s.student.id}/l/${s.lesson.id}"><b>${esc(s.time ?? '')} ${name}</b><small>${esc(s.lesson.plan?.topic ?? '')}</small><small>${esc(s.lesson.plan ? t[s.lesson.plan.status] : '')}</small></a>`;
          })
          .join('');
        return `<div class="day${iso(d) === today ? ' today' : ''}"><h3>${esc(t.days[i]!)} ${d.getMonth() + 1}/${d.getDate()}</h3>${items}</div>`;
      })
      .join('');
    const end = new Date(monday);
    end.setDate(monday.getDate() + 6);
    const list = students.length
      ? `<ul class="list">${students
          .map((s) => {
            const p = s.profile;
            const r = s.roadmap;
            return `<li><a href="/s/${s.id}"><b>${esc(p?.name ?? s.id)}</b></a><span class="muted">${p ? `${esc(EXAM[p.exam] ?? p.exam)} · ${esc(t.target)} ${p.target}` : ''}</span><span class="spacer"></span>${r && r.total ? `<span class="muted">${r.done}/${r.total}</span><div class="bar" style="width:120px"><i style="width:${Math.round((100 * r.done) / r.total)}%"></i></div>` : ''}${s.problems.length ? `<span class="chip draft">${s.problems.length} ${esc(t.problems)}</span>` : ''}</li>`;
          })
          .join('')}</ul>`
      : `<p class="muted">${esc(t.noStudents)}</p>`;
    return page(
      t.week,
      `<div class="row"><h1>${esc(offset === 0 ? t.week : `${monday.getMonth() + 1}/${monday.getDate()} – ${end.getMonth() + 1}/${end.getDate()}`)}</h1><span class="spacer"></span><a href="/?w=${offset - 1}">← ${esc(t.prev)}</a>${offset ? `<a href="/">${esc(t.today)}</a>` : ''}<a href="/?w=${offset + 1}">${esc(t.next)} →</a></div>
<div class="week" style="margin-top:12px">${days}</div>
<h2>${esc(t.students)}</h2><div class="card">${list}</div>`,
      l,
    );
  }

  async function student(id: string, l: Lang): Promise<string> {
    const t = T[l];
    const s = await readStudent(root, id);
    const p = s.profile;
    const daysLeft = p?.exam_date ? Math.ceil((new Date(`${p.exam_date}T00:00:00`).getTime() - new Date(`${iso(now())}T00:00:00`).getTime()) / 86_400_000) : null;
    const facts = p
      ? [EXAM[p.exam] ?? p.exam, `${t.target} ${p.target}`, p.current !== undefined ? `${t.current} ${p.current}` : '', daysLeft === null ? '' : daysLeft >= 0 ? t.examIn.replace('{n}', String(daysLeft)) : t.examPast.replace('{d}', p.exam_date!)].filter(Boolean).join(' · ')
      : '';
    const lessons = [...s.lessons].reverse();
    const shared = await readFile(path.join(studentsDir(root), id, 'share', 'index.html')).then(() => true, () => false);
    return page(
      p?.name ?? id,
      `<p><a href="/">← ${esc(t.back)}</a></p>
<div class="row"><div><h1>${esc(p?.name ?? id)}</h1><div class="muted">${esc(facts)}</div></div><span class="spacer"></span>${shared ? `<a href="/files/students/${id}/share/index.html" target="_blank">${esc(t.shareOpen)}</a> <a href="/files/students/${id}/share/lessons.ics">${esc(t.calendar)}</a>` : ''}${form(`/s/${id}/share`, t.share)}</div>
${problems(s, t)}
<div class="grid2"><div>
<h2>${esc(t.lessons)}</h2><div class="card">${lessons.length ? `<ul class="list">${lessons.map((x) => `<li><span class="muted" style="min-width:92px">${esc(x.plan?.date ?? '')}</span><a href="/s/${id}/l/${x.id}">${esc(x.plan?.topic ?? x.id)}</a><span class="spacer"></span>${chip(x.plan?.status, t)}</li>`).join('')}</ul>` : `<p class="muted">—</p>`}</div>
<h2>${esc(t.profile)}</h2><div class="card">${markdown(s.profileBody) || '<p class="muted">—</p>'}</div>
</div><div>
<h2>${esc(t.roadmap)}${s.roadmap?.total ? ` <span class="muted">${s.roadmap.done}/${s.roadmap.total}</span>` : ''}</h2><div class="card">${s.roadmap ? markdown(s.roadmap.body) : `<p class="muted">${esc(t.noRoadmap)}</p>`}</div>
</div></div>`,
      l,
    );
  }

  async function lesson(id: string, lessonId: string, l: Lang): Promise<string> {
    const t = T[l];
    const s = await readStudent(root, id);
    const x = s.lessons.find((y) => y.id === lessonId);
    if (!x) throw new NotFound();
    const status = x.plan?.status;
    // Student editions first, each named by what it is.
    const pdfs = [...x.pdfs]
      .sort((a, c) => Number(a.endsWith('-teacher.pdf')) - Number(c.endsWith('-teacher.pdf')) || a.localeCompare(c))
      .map((f) => {
        const base = f.replace(/(-teacher)?\.pdf$/, '');
        const kind = (t.kinds as Record<string, string>)[base] ?? base;
        return { url: `/files/students/${id}/lessons/${lessonId}/out/${f}`, label: `${kind} · ${f.endsWith('-teacher.pdf') ? t.teacherEd : t.studentEd}` };
      });
    const record = await readFile(path.join(studentsDir(root), id, 'lessons', lessonId, 'record.md'), 'utf8').catch(() => null);
    return page(
      x.plan?.topic ?? lessonId,
      `<p><a href="/s/${id}">← ${esc(s.profile?.name ?? id)}</a></p>
<div class="row"><div><h1>${esc(x.plan?.topic ?? lessonId)}</h1><div class="muted">${esc([x.plan?.date, x.plan?.time, x.plan?.minutes ? `${x.plan.minutes} min` : ''].filter(Boolean).join(' · '))}</div></div><span class="spacer"></span>${chip(status, t)}${status === 'draft' ? form(`/s/${id}/l/${lessonId}/approve`, t.approve, true) : ''}</div>
${problems({ ...s, problems: s.problems.filter((p) => p.file.includes(`/lessons/${lessonId}/`)) }, t)}
<div class="grid2"><div><h2>${esc(t.plan)}</h2><div class="card">${markdown(x.planBody) || '<p class="muted">—</p>'}</div>${record ? `<h2>${esc(t.record)}</h2><div class="card">${markdown(record.replace(/^---[\s\S]*?---\n?/, ''))}</div>` : ''}</div>
<div><h2>${esc(t.materials)}</h2>${pdfs.length ? `<div class="row" style="margin-bottom:8px">${pdfs.map((p) => `<a href="${p.url}" target="pdf">${esc(p.label)}</a>`).join('')}</div><iframe name="pdf" src="${pdfs[0]!.url}"></iframe>` : `<p class="muted">${esc(t.noMaterials)}</p>`}</div></div>`,
      l,
    );
  }

  /** Only lesson PDFs and the generated parent page leave the workspace this way. */
  async function file(rel: string, res: ServerResponse): Promise<void> {
    const parts = rel.split('/');
    const okPdf = parts.length === 6 && parts[0] === 'students' && ID.test(parts[1]!) && parts[2] === 'lessons' && ID.test(parts[3]!) && parts[4] === 'out' && /^[a-z0-9-]+\.pdf$/.test(parts[5]!);
    const okShare = parts.length === 4 && parts[0] === 'students' && ID.test(parts[1]!) && parts[2] === 'share' && /^(index\.html|lessons\.ics|[a-z0-9-]+\.pdf)$/.test(parts[3]!);
    if (!okPdf && !okShare) throw new NotFound();
    const data = await readFile(path.join(root, ...parts)).catch(() => {
      throw new NotFound();
    });
    const type = rel.endsWith('.pdf') ? 'application/pdf' : rel.endsWith('.ics') ? 'text/calendar; charset=utf-8' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
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
    // Only this computer: refuse other host names, which is how a web page could reach a local server.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const l = await lang();
    const html = (h: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(h);
    };
    try {
      if (url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': ok\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
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
        if (approve) {
          await setLessonStatus(root, approve[1]!, approve[2]!, 'approved');
          res.writeHead(303, { location: `/s/${approve[1]}/l/${approve[2]}` }).end();
        } else if (share) {
          await buildShare(root, share[1]!, { lang: l, now: now() });
          res.writeHead(303, { location: `/files/students/${share[1]}/share/index.html` }).end();
        } else throw new NotFound();
        return;
      }
      if (url.pathname === '/') return html(await home(url, l));
      const st = /^\/s\/([a-z0-9-]+)$/.exec(url.pathname);
      if (st && ID.test(st[1]!)) return html(await student(st[1]!, l));
      const ls = /^\/s\/([a-z0-9-]+)\/l\/([a-z0-9-]+)$/.exec(url.pathname);
      if (ls) return html(await lesson(ls[1]!, ls[2]!, l));
      if (url.pathname.startsWith('/files/')) return await file(decodeURIComponent(url.pathname.slice(7)), res);
      throw new NotFound();
    } catch (e) {
      if (res.headersSent) return;
      const missing = e instanceof NotFound;
      res.writeHead(missing ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(missing ? 'Not found' : (e as Error).message);
    }
  }

  return {
    handle,
    changed: () => {
      for (const c of clients) c.write('data: changed\n\n');
    },
  };
}

class NotFound extends Error {}

/** Serve the desk on this computer only, reload pages when the workspace changes, open the browser. */
export async function openDesk(root: string, port: number, browser = true): Promise<void> {
  const desk = createDesk(root);
  const server = createServer((req, res) => void desk.handle(req, res));
  const listen = (p: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' && p < port + 20 ? resolve(listen(p + 1)) : reject(e)));
      server.listen(p, '127.0.0.1', () => resolve(p));
    });
  const actual = await listen(port);
  let timer: NodeJS.Timeout | undefined;
  watch(root, { recursive: true }, (_e, f) => {
    if (f && /^(\.git|\.agents|\.claude|node_modules)[\\/]/.test(f)) return;
    clearTimeout(timer);
    timer = setTimeout(desk.changed, 300);
  });
  const url = `http://127.0.0.1:${actual}/`;
  console.log(`TutorDesk desk: ${url}  (Ctrl+C to stop)`);
  if (!browser) return;
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(opener[0] as string, opener[1] as string[], { stdio: 'ignore', detached: true }).unref();
}
