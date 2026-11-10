import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { parse } from 'yaml';
import { AGENTS, agentStatus, listModels, nativeEffort, type AgentId, type AgentStatus, type ModelList } from './agents/index.ts';
import { approval, approve } from './approvals.ts';
import { CHAT_CSS, CHAT_SCRIPT, chatShell, renderEntries } from './chat.ts';
import { brokenFiles, insideRoot } from './files.ts';
import { readHome, rememberChoice } from './home.ts';
import { INBOX_MAX_BYTES, INBOX_MAX_FILES, INBOX_TYPES, checkAttachments, cleanName, refuse, saveUpload, typeOf } from './inbox.ts';
import { log, logError, tail } from './log.ts';
import { mcpCommand, setupWorkspace } from './init.ts';
import { esc, markdown } from './md.ts';
import { Threads, type ThreadDeps } from './threads.ts';
import { exists } from './proc.ts';
import { buildShare } from './share.ts';
import { VERSION, selfCommand } from './paths.ts';
import { TEMPLATES } from './tex.ts';
import { ID, LESSON_STATUS, listStudents, readStudent, studentsDir, type Lesson, type LessonStatus, type Student } from './workspace.ts';

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
    todo: 'Needs you', nothing: 'Nothing waiting. The week is in order.', week: 'Week', students: 'Students', noStudents: 'No students yet. Describe your first student to the agent, in the conversation on the right.',
    stages: ['Plan', 'Approved', 'Materials', 'Taught'], notPrepared: 'Not prepared', status: { draft: 'Plan to approve', approved: 'Approved, materials next', ready: 'Materials ready', taught: 'Taught' },
    approve: 'Approve plan', approveAgain: 'Approve again', changed: 'Changed since you approved it', hand: 'Hand to agent', tell: 'Tell the agent', prev: '← Earlier', next: 'Later →', thisWeek: 'This week', today: 'Today',
    exam: 'Exam', target: 'Target', now: 'Now', days: 'days', past: 'past', roadmap: 'Course plan', noRoadmap: 'No course plan yet.', lessons: 'Lessons', noLessons: 'No lessons yet.', profile: 'Profile',
    materials: 'Materials', noMaterials: 'No PDFs yet.', record: 'After the lesson', plan: 'Plan', all: 'All students', share: 'Make parent page', shareOpen: 'Parent page', calendar: 'Calendar file',
    problems: 'Files to fix', studentEd: 'student', teacherEd: 'teacher', kinds: { handout: 'Handout', worksheet: 'Worksheet', script: 'Script', deck: 'Slides' } as Record<string, string>,
    weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    chat: {
      general: 'General', signIn: 'not signed in', missing: 'not installed', placeholder: 'Tell the agent what to do…', send: 'Send', stop: 'Stop', working: 'Working…',
      noAgent: 'No agent is ready. Install Codex, Claude Code or OpenCode, sign in once, then reload this page.',
      tools: { check_workspace: 'Checked the files', export_pdf: 'Exported PDF', share_with_parents: 'Made the parent page', setup_workspace: 'Set up the workspace' } as Record<string, string>,
      retry: 'Try again', older: 'Earlier conversation', stalled: 'No word from the agent for 20 minutes. It may be stuck.',
      details: (n: number, errors: number) => `Details · ${n} step${n === 1 ? '' : 's'}${errors ? ` · ${errors} failed` : ''}`,
      planDone: (done: number, total: number) => (done === total ? `Done ${total} step${total === 1 ? '' : 's'}` : `Done ${done} of ${total} steps`),
      did: { read: 'Read {x}', edit: 'Wrote {x}', command: 'Looked at the files', other: '{x}' },
      doing: { read: 'Reading {x}', edit: 'Writing {x}', command: 'Looking at the files', export_pdf: 'Making the PDF', check_workspace: 'Checking the files', share_with_parents: 'Making the parent page' } as { read: string; edit: string; command: string } & Record<string, string>,
      files: { profile: 'Profile', roadmap: 'Course plan', notes: 'Notes', plan: 'Plan', record: 'Lesson record', share: 'Parent page', calendar: 'Calendar file', student: 'student', teacher: 'teacher', kinds: { handout: 'Handout', worksheet: 'Worksheet', script: 'Script', deck: 'Slides' } as Record<string, string> },
      attach: { button: 'Attach', drop: 'Drop files to attach', uploading: 'Uploading…', type: '{x} cannot be attached. Pictures, PDF, Word, text.', size: '{x} is too large (20 MB at most).', many: '10 files at a time at most.' },
      queued: 'QUEUED', waiting: 'WAITING', unqueue: 'Take back',
      menu: { agent: 'AGENT', model: 'MODEL', effort: 'THINKING', byDefault: 'Default', loading: 'Asking the agent…', efforts: { fast: 'Fast', standard: 'Standard', deep: 'Deep' } },
      notes: {
        stopped: 'Stopped.',
        failed: (a: string) => `${a} stopped with an error.`,
        interrupted: (a: string) => `${a} was cut off before it finished.`,
        missing: (a: string) => `${a} is not installed. Install it, then try again.`,
        notSignedIn: (a: string) => `${a} is not signed in. Sign in once, then try again.`,
        noStart: (a: string) => `${a} did not start.`,
        restarted: (a: string) => `Could not continue the earlier ${a} conversation, so a new one began.`,
        restored: 'The agent changed its own instructions. They were put back:',
        unsent: 'This message was not sent: the desk closed first.',
      },
    },
    handAll: 'Hand all to agent', allSent: 'Handed {x} to the agent.', act: { working: 'WORKING', unread: 'NEW REPLY' },
    problem: {
      link: 'Something wrong?', intro: 'Copy this and send it to whoever helps you with TutorDesk. It holds no conversations and no student names.',
      version: 'Version', workspace: 'Workspace', agents: 'Agents', log: 'Recent log', copy: 'Copy', copied: 'Copied', empty: 'Nothing logged yet.',
      ready: 'ready', signIn: 'not signed in', missing: 'not installed',
    },
    broken: (kept: string) => `A file could not be read and was put aside as ${kept}. The desk carries on without it.`,
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
    todo: '待你处理', nothing: '没有待办，这周都安排好了。', week: '周', students: '学生', noStudents: '还没有学生。在右边的对话里，向 agent 描述你的第一个学生。',
    stages: ['计划', '确认', '材料', '上课'], notPrepared: '未备课', status: { draft: '计划待确认', approved: '已确认，待写材料', ready: '材料已出', taught: '已上课' },
    approve: '确认计划', approveAgain: '重新确认', changed: '计划在确认后有改动', hand: '交给 agent', tell: '告诉 agent', prev: '← 上一周', next: '下一周 →', thisWeek: '本周', today: '今天',
    exam: '考试', target: '目标', now: '现在', days: '天', past: '已过', roadmap: '课程规划', noRoadmap: '还没有课程规划。', lessons: '课次', noLessons: '还没有课次。', profile: '画像',
    materials: '材料', noMaterials: '还没有 PDF。', record: '课后记录', plan: '计划', all: '全部学生', share: '生成家长页', shareOpen: '家长页', calendar: '日历文件',
    problems: '需要修正的文件', studentEd: '学生版', teacherEd: '教师版', kinds: { handout: '讲义', worksheet: '练习卷', script: '教案', deck: '幻灯片' } as Record<string, string>,
    weekdays: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
    chat: {
      general: '通用对话', signIn: '未登录', missing: '未安装', placeholder: '告诉 agent 要做什么…', send: '发送', stop: '停止', working: '正在处理…',
      noAgent: '没有可用的 agent。请安装 Codex、Claude Code 或 OpenCode 并登录一次，然后刷新本页。',
      tools: { check_workspace: '检查文件', export_pdf: '导出 PDF', share_with_parents: '生成家长页', setup_workspace: '建立工作区' } as Record<string, string>,
      retry: '重试', older: '更早的对话', stalled: '20 分钟没有动静，可能卡住了。',
      details: (n: number, errors: number) => `细节 · ${n} 步${errors ? ` · ${errors} 步出错` : ''}`,
      planDone: (done: number, total: number) => (done === total ? `完成 ${total} 步` : `完成 ${done} / ${total} 步`),
      did: { read: '读 {x}', edit: '写 {x}', command: '查看文件', other: '{x}' },
      doing: { read: '正在读 {x}', edit: '正在写 {x}', command: '正在查看文件', export_pdf: '正在生成 PDF', check_workspace: '正在检查文件', share_with_parents: '正在生成家长页' } as { read: string; edit: string; command: string } & Record<string, string>,
      files: { profile: '画像', roadmap: '课程规划', notes: '笔记', plan: '计划', record: '课后记录', share: '家长页', calendar: '日历文件', student: '学生版', teacher: '教师版', kinds: { handout: '讲义', worksheet: '练习卷', script: '教案', deck: '幻灯片' } as Record<string, string> },
      attach: { button: '附件', drop: '松开即可附加', uploading: '正在上传…', type: '{x} 不能附加。可以附图片、PDF、Word 和文本。', size: '{x} 太大了（最多 20 MB）。', many: '一次最多 10 个文件。' },
      queued: '排队中', waiting: '等前面的做完', unqueue: '撤回',
      menu: { agent: 'AGENT', model: '模型', effort: '思考', byDefault: '默认', loading: '正在问 agent…', efforts: { fast: '快', standard: '标准', deep: '深入' } },
      notes: {
        stopped: '已停止。',
        failed: (a: string) => `${a} 出错停下了。`,
        interrupted: (a: string) => `${a} 没做完就中断了。`,
        missing: (a: string) => `${a} 没有安装。装好后点重试。`,
        notSignedIn: (a: string) => `${a} 还没登录。登录一次后点重试。`,
        noStart: (a: string) => `${a} 没能启动。`,
        restarted: (a: string) => `没能接上之前的 ${a} 对话，开了一个新的。`,
        restored: 'agent 改动了自己的说明文件，已经改回：',
        unsent: '这条消息没来得及发出：备课台先关了。',
      },
    },
    handAll: '全部交给 agent', allSent: '已交给 agent：{x} 项。', act: { working: '处理中', unread: '新回复' },
    problem: {
      link: '出了问题？', intro: '把下面的内容复制给帮你处理 TutorDesk 的人。里面没有对话内容，也没有学生姓名。',
      version: '版本', workspace: '工作区', agents: 'Agent', log: '最近的日志', copy: '复制', copied: '已复制', empty: '还没有日志。',
      ready: '可用', signIn: '未登录', missing: '未安装',
    },
    broken: (kept: string) => `有个文件读不了，已另存为 ${kept}。备课台先不用它，照常工作。`,
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
main{max-width:1200px;width:100%;margin:0 auto;padding:28px 40px 80px}
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
.foot{margin-top:72px;font-size:12px;color:var(--mute)}
.report{font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;padding:12px 0;border-top:1px solid var(--rule)}
@media (max-width:900px){main{padding:20px 16px 64px}.cols,.cols3{grid-template-columns:minmax(0,1fr);gap:28px}.week{grid-template-columns:minmax(0,1fr)}
.day,.day+.day{min-height:0;padding:12px 0;border-left:0;border-top:1px solid var(--rule)}.day .w{display:inline;margin-left:8px}.day .n{display:inline;font-size:22px}
.tasks li{grid-template-columns:64px minmax(0,1fr);gap:4px 12px}.roster li{display:flex;flex-wrap:wrap;gap:4px 14px}.roster li>a{flex-basis:100%}.tasks li>:nth-child(n+3){grid-column:2}.top nav{display:none}}
`;

class NotFound extends Error {}

/**
 * Every desk page: its own scripts, styles, fonts and frames only. Agent replies are escaped already;
 * this is the second line if something slips through.
 */
const SECURITY = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export interface Desk {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Tell open pages to reload. */
  changed(): void;
  /** How long nobody has looked: 0 while a page is open. */
  idleMs(): number;
  /** Stop the agents this desk started. */
  close(): Promise<void>;
}

export function createDesk(
  root: string,
  opts: { lang?: Lang; now?: () => Date; /** Tests: the agents on this computer, their models, and scripted sessions. */ agents?: AgentStatus[]; models?: (agent: AgentId) => Promise<ModelList>; threads?: Partial<ThreadDeps> } = {},
): Desk {
  const token = randomBytes(16).toString('hex');
  const now = opts.now ?? (() => new Date());
  const clients = new Set<ServerResponse>();
  let lastSeen = Date.now();

  // Which agents are installed and signed in: asked of their own programs, so remembered for a minute.
  let status: { at: number; list: Promise<AgentStatus[]> } | undefined;
  const agents = () => {
    if (!status || Date.now() - status.at > 60_000) status = { at: Date.now(), list: opts.agents ? Promise.resolve(opts.agents) : agentStatus() };
    return status.list;
  };
  const ready = (a: AgentStatus) => a.installed && a.signedIn !== false;
  /** The agent the tutor chose if it is ready, else the first that is. */
  async function currentAgent(): Promise<AgentId | null> {
    const list = (await agents()).filter(ready);
    const chosen = (await readHome()).agent;
    return (list.find((a) => a.id === chosen) ?? list[0])?.id ?? null;
  }
  // The models each agent offers: asked of the agent itself, then kept for ten minutes.
  const modelCache = new Map<AgentId, { at: number; list: Promise<ModelList> }>();
  const modelsOf = (id: AgentId): Promise<ModelList> => {
    const c = modelCache.get(id);
    if (c && Date.now() - c.at < 10 * 60_000) return c.list;
    const list = (opts.models ? opts.models(id) : listModels(id, { cwd: root })).catch((e: unknown) => {
      void log('models', { agent: id, message: (e as Error).message.slice(0, 200) });
      modelCache.delete(id);
      return { models: [], defaultEfforts: [] } as ModelList;
    });
    modelCache.set(id, { at: Date.now(), list });
    return list;
  };
  /** The tutor's pick for an agent, in the agent's own words: its model id and its name for the thinking level. */
  async function choiceFor(agent: AgentId): Promise<{ model?: string; effort?: string }> {
    const c = (await readHome()).choices?.[agent] ?? {};
    if (!c.effort) return { model: c.model };
    const list = await modelsOf(agent);
    const levels = c.model ? (list.models.find((m) => m.id === c.model)?.efforts ?? []) : list.defaultEfforts;
    return { model: c.model, effort: nativeEffort(c.effort, levels) };
  }
  const broadcast = (event: string, data: unknown) => {
    for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const threads = new Threads(root, {
    mcp: mcpCommand(root),
    agent: currentAgent,
    emit: (key, ev, seq) => broadcast('thread', { key, ev, seq }),
    activity: () => broadcast('activity', {}),
    choice: choiceFor,
    today: now,
    ...opts.threads,
  });

  async function config(): Promise<{ lang: Lang; studio?: string }> {
    const c = ((await readFile(path.join(root, 'tutordesk.yaml'), 'utf8').then(parse, () => null)) ?? {}) as { language?: string; studio?: string };
    const lang = opts.lang ?? (c.language === 'zh' || c.language === 'en' ? c.language : Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh') ? 'zh' : 'en');
    return { lang, studio: c.studio };
  }

  const pipe = (s?: LessonStatus) => `<span class="pipe${s === 'draft' ? ' draft' : ''}" aria-hidden="true">${LESSON_STATUS.map((x, i) => `<i${s && LESSON_STATUS.indexOf(s) >= i ? ' class="on"' : ''}></i>`).join('')}</span>`;
  const state = (t: Text, s?: LessonStatus) => `${pipe(s)}<span class="state${s === 'draft' ? ' draft' : ''}">${esc(s ? t.status[s] : t.notPrepared)}</span>`;
  const post = (action: string, label: string, primary = false, newTab = false) => `<form method="post" action="${esc(action)}"${newTab ? ' target="_blank"' : ''}><input type="hidden" name="token" value="${token}"><button class="btn${primary ? ' primary' : ''}">${esc(label)}</button></form>`;
  /** A sentence for the agent: sent to the student's conversation at once, or (fill) put in the box for the tutor to finish. */
  const hand = (t: Text, say: string, student: string, o: { fill?: boolean; small?: boolean } = {}) =>
    `<button class="btn${o.small === false ? '' : ' small'}" data-${o.fill ? 'fill' : 'say'}="${esc(say)}" data-key="${esc(student)}">${esc(o.fill ? t.tell : t.hand)}</button>`;
  /** A quiet word beside a student: the agent is working on them, or has replied since the tutor looked. */
  const mark = (t: Text, a: 'working' | 'unread') => `<span class="act ${a}">${esc(t.act[a])}</span>`;
  const fixes = (s: Student, t: Text, only?: string) => {
    const ps = only ? s.problems.filter((p) => p.file.includes(only)) : s.problems;
    return ps.length ? `<div class="warn"><b>${esc(t.problems)}</b><ul class="rows">${ps.map((p) => `<li><code>${esc(p.file)}</code> <span>${esc(p.message)}</span></li>`).join('')}</ul></div>` : '';
  };

  const page = (lang: Lang, t: Text, title: string, here: 'week' | 'students' | '', body: string, thread = '') => {
    const d = now();
    const kept = (f: string) => (insideRoot(root, f) ? path.relative(root, f) : f);
    const broken = brokenFiles().map((b) => `<p class="warn">${esc(t.broken(kept(b.kept)))}</p>`).join('');
    // Settings for the page script: a data block, not a script, so the page needs no inline code.
    const c = t.chat;
    const settings = JSON.stringify({
      token,
      working: c.working,
      noAgent: c.noAgent,
      signIn: c.signIn,
      missing: c.missing,
      older: c.older,
      stalled: c.stalled,
      doing: c.doing,
      queued: c.queued,
      waiting: c.waiting,
      unqueue: c.unqueue,
      menu: c.menu,
      attach: { ...c.attach, types: Object.keys(INBOX_TYPES), max: INBOX_MAX_BYTES, count: INBOX_MAX_FILES },
      allSent: t.allSent,
    }).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}${CHAT_CSS}</style></head><body><div class="app"><main id="view" data-thread="${esc(thread)}" data-title="${esc(title)}">
<header class="top"><a class="brand" href="/">TutorDesk</a><nav><a href="/"${here === 'week' ? ' aria-current="page"' : ''}>${esc(t.thisWeek)}</a><a href="/#students"${here === 'students' ? ' aria-current="page"' : ''}>${esc(t.students)}</a></nav><span class="date mono">${iso(d).replace(/-/g, '.')} ${esc(t.weekdays[(d.getDay() + 6) % 7]!)}</span></header>
${broken}${body}<footer class="foot"><a href="/problem">${esc(t.problem.link)}</a></footer></main>${chatShell(t.chat)}</div><script type="application/json" id="td">${settings}</script><script src="/assets/chat.js"></script></body></html>`;
  };

  async function problem(lang: Lang, t: Text): Promise<string> {
    const p = t.problem;
    const list = await agents();
    const lines = [
      `TutorDesk ${VERSION} · ${process.platform} ${process.arch} · Node ${process.versions.node}`,
      `${p.workspace}: ${path.resolve(root)}`,
      `${p.agents}: ${list.map((a) => `${a.label} ${ready(a) ? p.ready : a.installed ? p.signIn : p.missing}${a.version ? ` (${a.version})` : ''}`).join(', ') || '–'}`,
      '',
      (await tail(50)) || p.empty,
    ];
    return page(
      lang,
      t,
      p.link,
      '',
      `<div class="hero"><h1>${esc(p.link)}</h1><div class="actions"><button class="btn primary" data-copy="report" data-done="${esc(p.copied)}">${esc(p.copy)}</button></div></div>
<p class="mute" style="max-width:60ch">${esc(p.intro)}</p>
<section><div class="label"><b>${esc(p.log)}</b></div><pre id="report" class="report mono">${esc(lines.join('\n'))}</pre></section>`,
    );
  }

  async function home(url: URL, lang: Lang, t: Text): Promise<string> {
    const students = await listStudents(root);
    const today = now();
    const offset = Number(url.searchParams.get('w') ?? 0) || 0;
    const monday = addDays(mondayOf(today), offset * 7);
    const sunday = addDays(monday, 6);

    const todo = tasks(students, today, t);
    const act = threads.activity();
    // Work the agent can do on its own; the tutor's own words (a lesson record) and approvals are not.
    const forAgent = todo.filter((k) => k.say && k.kind !== 'record' && act[k.student.id] !== 'working');
    const taskList = todo.length
      ? `<ol class="tasks">${todo
          .map((k) => {
            const who = esc(k.student.profile?.name ?? k.student.id);
            const busy = act[k.student.id] === 'working' && k.say && k.kind !== 'record';
            const action = k.kind === 'approve' ? `<a class="btn small" href="${k.href}">${esc(t.approve)}</a>` : busy ? mark(t, 'working') : k.say ? hand(t, k.say, k.student.id, { fill: k.kind === 'record' }) : '';
            return `<li><span class="kind ${k.kind}">${esc(t.task[k.kind])}</span><span class="mono mute">${k.date ? md(k.date) : ''}</span><span><a href="${k.href ?? `/s/${k.student.id}`}">${who}</a> <span class="mute">${esc(k.what)}</span></span>${action}</li>`;
          })
          .join('')}</ol>`
      : `<p class="empty-note">${esc(t.nothing)}</p>`;
    const handAll = forAgent.length >= 2 ? `<div class="actions"><button class="btn" data-all>${esc(t.handAll)} <span class="mono">${forAgent.length}</span></button></div>` : '';

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
            return `<li><a href="/s/${s.id}"><b>${esc(p?.name ?? s.id)}</b>${act[s.id] ? mark(t, act[s.id]!) : ''}</a><span class="mute">${esc(p ? EXAM[p.exam] ?? p.exam : '')}</span><span class="mono">${p ? `${p.current ?? '–'} → ${p.target}` : ''}</span><span class="mono mute num">${left !== null && left >= 0 ? `${left} ${esc(t.days)}` : ''}</span>${progress}</li>`;
          })
          .join('')}</ul>`
      : `<p class="empty-note">${esc(t.noStudents)}</p>`;

    return page(
      lang,
      t,
      'TutorDesk',
      'week',
      `<div class="hero"><h1>${esc(t.todo)}</h1><span class="mono mute" style="font-size:20px">${todo.length}</span>${handAll}</div>
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
      `<div class="hero"><h1>${esc(name)}</h1><div class="actions">${shared ? `<a href="/files/students/${id}/share/index.html" target="_blank">${esc(t.shareOpen)}</a><a href="/files/students/${id}/share/lessons.ics">${esc(t.calendar)}</a>` : ''}${post(`/s/${id}/share`, t.share, false, true)}</div></div>
${facts}${fixes(s, t)}
<section class="cols3">
<div id="lessons"><div class="label"><b>${esc(t.lessons)}</b><span class="mono">${lessons.length}</span></div>${lessons.length ? `<ul class="rows">${lessons.map((l) => `<li><span class="mono mute">${esc(l.plan ? md(l.plan.date) : '')}</span><a class="grow" href="/s/${id}/l/${l.id}">${esc(l.plan?.topic ?? l.id)}</a>${pipe(l.plan?.status)}</li>`).join('')}</ul>` : `<p class="empty-note">${esc(t.noLessons)}</p>`}</div>
<div id="roadmap"><div class="label"><b>${esc(t.roadmap)}</b>${s.roadmap?.total ? `<span class="mono">${s.roadmap.done}/${s.roadmap.total}</span>` : ''}</div>${s.roadmap ? `<div class="prose">${markdown(s.roadmap.body)}</div>` : `<p class="empty-note">${esc(t.noRoadmap)}</p>${hand(t, t.say.roadmap(name), id)}`}</div>
<div id="profile"><div class="label"><b>${esc(t.profile)}</b></div><div class="prose">${markdown(s.profileBody) || '<p class="empty-note">–</p>'}</div></div>
</section>`,
      id,
    );
  }

  async function lesson(id: string, lessonId: string, lang: Lang, t: Text, pick?: string | null): Promise<string> {
    if (!(await exists(path.join(studentsDir(root), id, 'lessons', lessonId)))) throw new NotFound();
    const s = await readStudent(root, id);
    const x = s.lessons.find((y) => y.id === lessonId);
    if (!x) throw new NotFound();
    const p = x.plan;
    const name = s.profile?.name ?? id;
    const status = p?.status;
    const when = p ? md(p.date) : '';
    let action = '';
    // The desk's own record decides, not the status line: a plan edited after approval asks again.
    const recorded = await approval(root, id, lessonId);
    if (status === 'draft') action = post(`/s/${id}/l/${lessonId}/approve`, t.approve, true);
    else if (status !== 'taught' && recorded !== 'approved') action = `<span class="state draft">${esc(t.changed)}</span>${post(`/s/${id}/l/${lessonId}/approve`, t.approveAgain, true)}`;
    else if (status === 'approved') action = hand(t, t.say.write(name, when), id, { small: false });
    else if (status === 'ready' && p && p.date <= iso(now()) && !x.record) action = hand(t, t.say.record(name, when), id, { fill: true, small: false });

    // Student editions first, each named by what it is.
    const pdfs = [...x.pdfs]
      .sort((a, c) => Number(a.endsWith('-teacher.pdf')) - Number(c.endsWith('-teacher.pdf')) || a.localeCompare(c))
      .map((f) => {
        const kind = f.replace(/(-teacher)?\.pdf$/, '');
        return { file: f, url: `/files/students/${id}/lessons/${lessonId}/out/${f}`, label: `${t.kinds[kind] ?? kind} · ${f.endsWith('-teacher.pdf') ? t.teacherEd : t.studentEd}` };
      });
    // A link from the conversation opens the PDF it names.
    const shown = Math.max(0, pdfs.findIndex((f) => f.file === pick));
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
<div><div id="plan"><div class="label"><b>${esc(t.plan)}</b></div><div class="prose">${markdown(x.planBody) || '<p class="empty-note">–</p>'}</div></div>${record ? `<div id="record"><div class="label" style="margin-top:28px"><b>${esc(t.record)}</b></div><div class="prose">${markdown(record.replace(/^﻿?---[\s\S]*?---\r?\n?/, ''))}</div></div>` : ''}</div>
<div id="materials"><div class="label"><b>${esc(t.materials)}</b><span class="mono">${pdfs.length}</span></div>${pdfs.length ? `<nav class="tabs">${pdfs.map((f, i) => `<a href="${f.url}" target="pdf" data-tab${i === shown ? ' class="on"' : ''}>${esc(f.label)}</a>`).join('')}</nav><iframe name="pdf" title="${esc(t.materials)}" src="${pdfs[shown]!.url}"></iframe>` : `<p class="empty-note">${esc(t.noMaterials)}</p>`}</div>
</section>`,
      id,
    );
  }

  /** Only lesson PDFs, the generated parent page, the tutor's attachments and the desk's fonts leave the workspace this way. */
  async function file(rel: string, res: ServerResponse): Promise<void> {
    const parts = rel.split('/');
    const okPdf = parts.length === 6 && parts[0] === 'students' && ID.test(parts[1]!) && parts[2] === 'lessons' && ID.test(parts[3]!) && parts[4] === 'out' && /^[a-z0-9-]+\.pdf$/.test(parts[5]!);
    const okShare = parts.length === 4 && parts[0] === 'students' && ID.test(parts[1]!) && parts[2] === 'share' && /^(index\.html|lessons\.ics|[a-z0-9-]+\.pdf)$/.test(parts[3]!);
    const upload = parts.at(-1)!;
    const okInbox = ((parts.length === 4 && parts[0] === 'students' && ID.test(parts[1]!) && parts[2] === 'inbox') || (parts.length === 2 && parts[0] === 'inbox')) && upload === cleanName(upload) && refuse(upload, 1) === null;
    if (okInbox) {
      const full = path.join(root, ...parts);
      if (!insideRoot(root, full)) throw new NotFound();
      const data = await readFile(full).catch(() => {
        throw new NotFound();
      });
      const type = typeOf(upload)!;
      // An upload is someone else's file: shown as itself, never run. Word files download.
      const inline = type.startsWith('image/') || type === 'application/pdf' || type.startsWith('text/plain');
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(upload)}`,
        ...(type === 'application/pdf' ? {} : { 'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
      });
      res.end(data);
      return;
    }
    if (!okPdf && !okShare) throw new NotFound();
    // The same check the agents get: a linked folder cannot serve files from elsewhere.
    const full = path.join(root, ...parts);
    if (!insideRoot(root, full)) throw new NotFound();
    const data = await readFile(full).catch(() => {
      throw new NotFound();
    });
    const type = rel.endsWith('.pdf') ? 'application/pdf' : rel.endsWith('.ics') ? 'text/calendar; charset=utf-8' : 'text/html; charset=utf-8';
    // The parent page is plain HTML and styles; it runs nothing.
    const extra = type.startsWith('text/html') ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'", 'referrer-policy': 'no-referrer' } : {};
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    res.end(data);
  }

  /** A request body up to `max` bytes; null when it is larger (the rest is not read). */
  async function body(req: IncomingMessage, max: number): Promise<Buffer | null> {
    if (Number(req.headers['content-length'] ?? 0) > max) return null;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      size += c.length;
      // Past the limit the rest is read and dropped, so the answer still reaches the page.
      if (size <= max) chunks.push(c);
    }
    return size > max ? null : Buffer.concat(chunks);
  }

  async function raw(req: IncomingMessage): Promise<string> {
    let s = '';
    for await (const c of req) {
      s += c;
      if (s.length > 100_000) break;
    }
    return s;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    lastSeen = Date.now();
    // Only this computer: refuse other host names, which is how a web page could reach a local server.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) {
      res.writeHead(403).end();
      return;
    }
    // Anything that changes something must come from the desk's own pages: a page elsewhere could
    // otherwise post to it from the tutor's browser.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== `http://${req.headers.host}`) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { lang } = await config();
    const t = T[lang];
    const html = (h: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'SAMEORIGIN', ...SECURITY });
      res.end(h);
    };
    try {
      if (url.pathname === '/assets/chat.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(CHAT_SCRIPT);
        return;
      }
      if (url.pathname === '/problem') return html(await problem(lang, t));
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
      const json = (o: unknown, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(o));
      };
      // An attachment: the file itself is the body, so the token comes as a header.
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        if (req.headers['x-td-token'] !== token) return json({ error: 'Reload the page and try again.' }, 403);
        const key = url.searchParams.get('key') ?? '';
        const name = url.searchParams.get('name') ?? '';
        if (key !== '' && !ID.test(key)) return json({ error: 'Not a student' }, 400);
        if (refuse(name, 1) === 'type') return json({ error: t.chat.attach.type.replace('{x}', name) }, 415);
        const data = await body(req, INBOX_MAX_BYTES);
        if (!data) return json({ error: t.chat.attach.size.replace('{x}', name) }, 413);
        if (!data.length) return json({ error: 'Empty file' }, 400);
        return json({ file: await saveUpload(root, key, name, data, now()) });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        let a: { token?: string; key?: string; text?: string; agent?: string; files?: unknown; id?: string; model?: string; effort?: string };
        try {
          a = JSON.parse(await raw(req)) as typeof a;
        } catch {
          return json({ error: 'Bad request' }, 400);
        }
        if (a.token !== token) return json({ error: 'Reload the page and try again.' }, 403);
        const key = a.key ?? '';
        if (key !== '' && !ID.test(key)) return json({ error: 'Not a student' }, 400);
        try {
          if (url.pathname === '/api/send') return json(await threads.send(key, String(a.text ?? '').slice(0, 20_000), await checkAttachments(root, key, a.files)));
          if (url.pathname === '/api/stop') await threads.stop(key);
          else if (url.pathname === '/api/unqueue') await threads.unqueue(key, String(a.id ?? ''));
          else if (url.pathname === '/api/choice' && AGENTS.some((x) => x.id === a.agent)) {
            const model = typeof a.model === 'string' && /^[\w.:/@[\]-]{1,120}$/.test(a.model) ? a.model : undefined;
            await rememberChoice(a.agent!, { model, effort: a.effort === 'fast' || a.effort === 'deep' ? a.effort : undefined });
          } else if (url.pathname === '/api/all') {
            // Every task the agent can do alone goes to its student's conversation; the queue takes it from there.
            let sent = 0;
            for (const k of tasks(await listStudents(root), now(), t)) {
              if (!k.say || k.kind === 'record') continue;
              if (!(await threads.send(k.student.id, k.say, [], { unique: true })).skipped) sent++;
            }
            return json({ sent });
          } else throw new NotFound();
        } catch (e) {
          if (e instanceof NotFound) throw e;
          return json({ error: (e as Error).message }, 409);
        }
        return json({ ok: true });
      }
      if (url.pathname === '/api/models') {
        const id = AGENTS.find((x) => x.id === url.searchParams.get('agent'))?.id;
        const status = (await agents()).find((x) => x.id === id);
        if (!id || !status || !ready(status)) return json({ models: [], defaultEfforts: [] });
        return json(await modelsOf(id));
      }
      if (url.pathname === '/api/thread') {
        const key = url.searchParams.get('key') ?? '';
        if (key !== '' && !ID.test(key)) throw new NotFound();
        const part = url.searchParams.get('part');
        if (part) return json({ html: renderEntries(await threads.older(key, Number(part)), t.chat, key) });
        const v = await threads.view(key);
        const who = key ? ((await readStudent(root, key).catch(() => null))?.profile?.name ?? key) : t.chat.general;
        const list = await agents();
        const choices = (await readHome()).choices ?? {};
        return json({
          who,
          html: renderEntries(v.entries, t.chat, key),
          seq: v.seq,
          running: v.running,
          stalled: v.stalled,
          older: v.older,
          partial: v.partial,
          steps: v.steps,
          plan: v.plan,
          queue: v.queue,
          agent: await currentAgent(),
          agents: list.map((x) => ({ id: x.id, label: x.label, ready: ready(x), installed: x.installed, hint: x.hint ?? '', choice: choices[x.id] ?? {} })),
        });
      }
      if (req.method === 'POST') {
        const form = new URLSearchParams(await raw(req));
        if (form.get('token') !== token) {
          res.writeHead(403).end();
          return;
        }
        const approved = /^\/s\/([a-z0-9-]+)\/l\/([a-z0-9-]+)\/approve$/.exec(url.pathname);
        const share = /^\/s\/([a-z0-9-]+)\/share$/.exec(url.pathname);
        if (approved && ID.test(approved[1]!) && ID.test(approved[2]!)) {
          const [, sid, lid] = approved as unknown as [string, string, string];
          await approve(root, sid, lid);
          // Approving is the go-ahead: the agent starts on the materials without being asked again.
          const lessonPlan = (await readStudent(root, sid)).lessons.find((x) => x.id === lid)?.plan;
          const name = (await readStudent(root, sid)).profile?.name ?? sid;
          if (lessonPlan && (await currentAgent())) await threads.send(sid, t.say.write(name, md(lessonPlan.date)), [], { unique: true }).catch(() => {});
          res.writeHead(303, { location: `/s/${sid}/l/${lid}` }).end();
        } else if (share && ID.test(share[1]!)) {
          await buildShare(root, share[1]!, { lang, now: now() });
          res.writeHead(303, { location: `/files/students/${share[1]}/share/index.html` }).end();
        } else throw new NotFound();
        return;
      }
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ app: 'tutordesk', root: path.resolve(root), version: VERSION }));
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
      if (ls && ID.test(ls[1]!) && ID.test(ls[2]!)) return html(await lesson(ls[1]!, ls[2]!, lang, t, url.searchParams.get('pdf')));
      if (url.pathname.startsWith('/files/')) return await file(decodeURIComponent(url.pathname.slice(7)), res);
      throw new NotFound();
    } catch (e) {
      if (res.headersSent) return;
      const missing = e instanceof NotFound || e instanceof URIError;
      if (!missing) void logError(`${req.method} ${url.pathname.replace(/\/s\/[^/]+/, '/s/…')}`, e);
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
    close: () => threads.closeAll(),
  };
}

export const DESK_PORT = 4321;

/** A desk already serving this workspace (another agent conversation started it), if any. */
async function runningDesk(root: string, port: number): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    const h = (await r.json()) as { app?: string; root?: string; version?: string };
    // A desk left running by an older version is not reused: it would show the old pages.
    return h.app === 'tutordesk' && h.root === path.resolve(root) && h.version === VERSION ? `http://127.0.0.1:${port}/` : null;
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
  // The workspace carries the skills and instructions the agents read; keep them at this version.
  await setupWorkspace(root, { remember: false });
  const desk = createDesk(root);
  const server = createServer((req, res) => void desk.handle(req, res));
  const listen = (p: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' && p < port + 20 ? resolve(listen(p + 1)) : reject(e)));
      server.listen(p, '127.0.0.1', () => resolve(p));
    });
  const actual = await listen(port);
  void log('desk', { version: VERSION, port: actual, background: o.background ?? false });
  if (!o.background) {
    // The desk's own process: what kills it goes in the log first.
    process.on('uncaughtException', (e) => void logError('uncaught', e).finally(() => process.exit(1)));
    process.on('unhandledRejection', (e) => void logError('unhandled', e));
  }
  // Inside an agent's MCP server the desk must not keep the process alive after the agent leaves.
  if (o.background) server.unref();
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(root, { recursive: true }, (_e, f) => {
    if (f && /^(\.git|\.agents|\.claude|\.tutordesk|node_modules)[\\/]/.test(f)) return;
    clearTimeout(timer);
    timer = setTimeout(desk.changed, 300);
  });
  if (o.background) watcher.unref();
  // Agents started from the desk must not outlive it.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void desk.close().finally(() => process.exit(0)));
  if (o.idleExitMs) {
    const limit = o.idleExitMs;
    setInterval(() => desk.idleMs() > limit && void desk.close().finally(() => process.exit(0)), Math.min(60_000, limit)).unref();
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
