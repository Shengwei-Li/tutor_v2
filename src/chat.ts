import { agentLabel } from './agents/index.ts';
import { isPicture } from './inbox.ts';
import { esc, markdown } from './md.ts';
import type { Entry, Step } from './threads.ts';

/**
 * The conversation column of the desk: its markup, its styles, and the page script that keeps the
 * left side (the view) and the conversation in step without reloading the page.
 */
export interface ChatText {
  general: string;
  placeholder: string;
  send: string;
  stop: string;
  working: string;
  noAgent: string;
  signIn: string;
  missing: string;
  tools: Record<string, string>;
  retry: string;
  older: string;
  stalled: string;
  /** A finished turn's steps, folded: "Details · 12 steps". */
  details: (n: number, errors: number) => string;
  /** A finished turn's task list, folded. */
  planDone: (done: number, total: number) => string;
  /** One step, done: "{x}" is what it acted on. */
  did: { read: string; edit: string; command: string; other: string };
  /** The one line that changes while the agent works. */
  doing: { read: string; edit: string; command: string } & Record<string, string>;
  /** What the files a turn wrote are called. */
  files: { profile: string; roadmap: string; notes: string; plan: string; record: string; share: string; calendar: string; student: string; teacher: string; kinds: Record<string, string> };
  attach: { button: string; drop: string; uploading: string; type: string; size: string; many: string };
  queued: string;
  waiting: string;
  unqueue: string;
  menu: { agent: string; model: string; effort: string; byDefault: string; loading: string; efforts: { fast: string; standard: string; deep: string } };
  notes: {
    stopped: string;
    failed: (agent: string) => string;
    interrupted: (agent: string) => string;
    missing: (agent: string) => string;
    notSignedIn: (agent: string) => string;
    noStart: (agent: string) => string;
    restarted: (agent: string) => string;
    restored: string;
    unsent: string;
  };
}

type Note = Extract<Entry, { role: 'system' }>;

/** A desk note in the tutor's words; the agent's own error, if any, below it in small print. */
function noteLine(e: Note, t: ChatText, key: string): string {
  const who = e.agent ? agentLabel(e.agent) : 'Agent';
  let say = e.text;
  let detail = '';
  switch (e.kind) {
    case 'stopped':
      say = t.notes.stopped;
      break;
    case 'failed':
    case 'interrupted':
      say = t.notes[e.kind](who);
      detail = e.text;
      break;
    case 'no_start':
      say = /not installed/i.test(e.text) ? t.notes.missing(who) : /sign|log ?in|auth|401|unauthori[sz]ed|credential/i.test(e.text) ? t.notes.notSignedIn(who) : t.notes.noStart(who);
      detail = e.text;
      break;
    case 'restarted':
      say = t.notes.restarted(who);
      break;
    case 'restored':
      say = t.notes.restored;
      detail = e.text;
      break;
    case 'unsent':
      say = t.notes.unsent;
      detail = e.text;
      break;
    default:
  }
  const loud = e.kind === 'failed' || e.kind === 'interrupted' || e.kind === 'no_start' || e.kind === 'restored' || e.kind === 'unsent';
  const files = e.retryFiles?.length ? ` data-files="${esc(JSON.stringify(e.retryFiles))}"` : '';
  const retry = e.retry !== undefined ? ` <button class="btn small" data-say="${esc(e.retry)}"${files} data-key="${esc(key)}">${esc(t.retry)}</button>` : '';
  return `<div class="note${loud ? ' loud' : ''}">${esc(say)}${retry}${detail ? `<span class="detail">${esc(detail.slice(0, 600))}</span>` : ''}</div>`;
}

/** A finished step in the tutor's words. */
export function stepLine(s: Pick<Step, 'name' | 'kind' | 'target'>, t: ChatText): string {
  const fill = (f: string) => f.replace('{x}', s.target ?? '').trim();
  if (t.tools[s.name]) return t.tools[s.name]!;
  if (s.kind === 'read' || s.kind === 'edit') return fill(t.did[s.kind]);
  if (s.kind === 'command') return fill(t.did.command);
  return `${s.name}${s.target ? ` ${s.target}` : ''}`;
}

const slash = (rel: string) => rel.split('/').map(encodeURIComponent).join('/');
const dateOf = (lesson: string) => {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(lesson);
  return m ? `${m[1]}/${m[2]}` : lesson;
};

/**
 * What the tutor calls a file the agent wrote, and where it opens on the desk. In the general
 * conversation the student comes first, since the files may be anyone's.
 */
export function fileLink(rel: string, t: ChatText, key: string): { label: string; href: string; newTab?: boolean } {
  const m = /^students\/([a-z0-9-]+)\/(.+)$/.exec(rel);
  const name = rel.split('/').pop() ?? rel;
  if (!m) return { label: name, href: '/' };
  const [, id, rest] = m as unknown as [string, string, string];
  const who = key ? '' : `${id} · `;
  const s = `/s/${id}`;
  let r: { label: string; href: string; newTab?: boolean } = { label: name, href: s };
  const lesson = /^lessons\/([a-z0-9-]+)\/(.+)$/.exec(rest);
  if (rest === 'profile.md') r = { label: t.files.profile, href: `${s}#profile` };
  else if (rest === 'roadmap.md') r = { label: t.files.roadmap, href: `${s}#roadmap` };
  else if (rest === 'notes.md') r = { label: t.files.notes, href: s };
  else if (rest === 'share/index.html') r = { label: t.files.share, href: `/files/${slash(rel)}`, newTab: true };
  else if (rest === 'share/lessons.ics') r = { label: t.files.calendar, href: `/files/${slash(rel)}` };
  else if (lesson) {
    const [, lid, file] = lesson as unknown as [string, string, string];
    const at = `${s}/l/${lid}`;
    const when = dateOf(lid);
    const pdf = /^out\/([a-z0-9-]+)\.pdf$/.exec(file);
    if (file === 'plan.md') r = { label: `${when} · ${t.files.plan}`, href: `${at}#plan` };
    else if (file === 'record.md') r = { label: `${when} · ${t.files.record}`, href: `${at}#record` };
    else if (pdf) {
      const kind = pdf[1]!.replace(/-teacher$/, '');
      r = { label: `${when} · ${t.files.kinds[kind] ?? kind} PDF · ${pdf[1]!.endsWith('-teacher') ? t.files.teacher : t.files.student}`, href: `${at}?pdf=${encodeURIComponent(`${pdf[1]}.pdf`)}#materials` };
    } else r = { label: `${when} · ${name}`, href: at };
  }
  return { ...r, label: who + r.label };
}

/** Attachments under a message: pictures as small previews, other files by name. Each opens the original. */
export function attachments(files: string[]): string {
  return `<div class="atts">${files
    .map((f) => {
      const href = `/files/${slash(f)}`;
      const name = esc(f.split('/').pop()!.replace(/^\d{4}-\d{2}-\d{2}-/, ''));
      return isPicture(f) ? `<a href="${href}" target="_blank" title="${name}"><img class="thumb" src="${href}" alt="${name}" loading="lazy"></a>` : `<a class="att" href="${href}" target="_blank">${name}</a>`;
    })
    .join('')}</div>`;
}

const planList = (items: { text: string; status: string }[]) => `<ol>${items.map((i) => `<li class="${esc(i.status)}">${esc(i.text)}</li>`).join('')}</ol>`;

/**
 * The saved conversation. Within each turn the agent's steps fold into one "details" line under its
 * reply, the task list into one line above it, and the files it wrote follow as links.
 */
export function renderEntries(entries: Entry[], t: ChatText, key = ''): string {
  const out: string[] = [];
  let steps: Extract<Entry, { role: 'tool' }>[] = [];
  let lastWho = '';
  const flush = () => {
    if (!steps.length) return;
    const errors = steps.filter((s) => !s.ok).length;
    out.push(`<details class="steps"><summary>${esc(t.details(steps.length, errors))}</summary>${steps.map((s) => `<div class="step${s.ok ? '' : ' err'}">${esc(stepLine(s, t))}${s.ok ? '' : ' ✕'}</div>`).join('')}</details>`);
    steps = [];
  };
  for (const e of entries) {
    if (e.role === 'tool') {
      steps.push(e);
      continue;
    }
    if (e.role === 'tutor' || e.role === 'files') flush();
    if (e.role === 'tutor') {
      lastWho = '';
      out.push(`<div class="msg me">${esc(e.text)}${e.files?.length ? attachments(e.files) : ''}</div>`);
    } else if (e.role === 'agent') {
      // A reply split by steps reads as one: the name only once.
      const who = e.agent === lastWho ? '' : `<div class="who">${esc(agentLabel(e.agent))}</div>`;
      lastWho = e.agent;
      out.push(`<div class="msg">${who}<div class="prose">${markdown(e.text)}</div></div>`);
    } else if (e.role === 'plan') {
      const done = e.items.filter((i) => i.status === 'done').length;
      out.push(`<details class="plan"><summary>${esc(t.planDone(done, e.items.length))}</summary>${planList(e.items)}</details>`);
    } else if (e.role === 'files') {
      out.push(
        `<div class="results">${e.files
          .map((f) => {
            const l = fileLink(f, t, key);
            return `<a href="${esc(l.href)}"${l.newTab ? ' target="_blank"' : ''}>${esc(l.label)}</a>`;
          })
          .join('')}</div>`,
      );
    } else {
      flush();
      out.push(noteLine(e, t, key));
    }
  }
  flush();
  return out.join('');
}

export const chatShell = (t: ChatText) => `<aside id="chat" aria-label="Agent">
<header><b id="chat-who"></b><button type="button" id="chat-pick" class="pick" aria-haspopup="true" aria-expanded="false"></button><div id="chat-menu" class="menu" hidden></div></header>
<div id="chat-log" aria-live="polite"></div>
<div id="chat-queue"></div>
<form id="chat-form"><div id="chat-files"></div><textarea id="chat-input" rows="3" placeholder="${esc(t.placeholder)}"></textarea>
<div class="row"><button type="button" class="link" id="chat-attach">${esc(t.attach.button)}</button><input type="file" id="chat-file" multiple hidden><span id="chat-state" class="mute"></span><button type="button" class="btn small" id="chat-stop" hidden>${esc(t.stop)}</button><button class="btn primary small" id="chat-send">${esc(t.send)}</button></div></form>
<div class="drop-hint">${esc(t.attach.drop)}</div>
</aside>`;

export const CHAT_CSS = `
.app{display:grid;grid-template-columns:minmax(0,1fr) 400px;min-height:100vh}
#chat{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;border-left:2px solid var(--ink);background:var(--paper)}
#chat header{position:relative;z-index:3;display:flex;align-items:baseline;gap:12px;padding:28px 20px 14px;border-bottom:1px solid var(--rule)}
#chat header b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pick{font:inherit;font-size:13px;color:var(--mute);background:none;border:0;padding:0;cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pick:hover,.pick[aria-expanded=true]{color:var(--ink)}
.menu{position:absolute;right:12px;top:calc(100% - 6px);z-index:5;width:280px;max-height:70vh;overflow-y:auto;background:var(--paper);border:1.5px solid var(--ink);padding:6px 0;transform-origin:top right;animation:menu-in .14s ease-out}
@keyframes menu-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.menu .h{font:500 11px/1 PlexMono,ui-monospace,monospace;letter-spacing:.04em;color:var(--mute);padding:10px 14px 6px}
.menu .h+.opt{margin-top:0}.menu hr{border:0;border-top:1px solid var(--rule);margin:6px 0}
.opt{display:flex;gap:8px;width:100%;font:inherit;font-size:14px;text-align:left;background:none;border:0;padding:7px 14px;color:var(--ink);cursor:pointer}
.opt:hover:not(:disabled){background:var(--ink);color:var(--paper)}.opt:disabled{color:var(--mute);cursor:default}
.opt::before{content:'';flex:none;width:7px;height:7px;margin-top:.55em;border:1.5px solid currentColor}.opt[aria-pressed=true]::before{background:currentColor}
.opt .sub{color:var(--mute);margin-left:auto;font-size:12px}.opt:hover .sub{color:inherit}
.seg{display:flex;margin:2px 14px 8px;border:1px solid var(--ink)}.seg button{flex:1;font:inherit;font-size:13px;padding:6px 0;background:none;border:0;color:var(--ink);cursor:pointer}
.seg button+button{border-left:1px solid var(--ink)}.seg button[aria-pressed=true]{background:var(--ink);color:var(--paper)}
.menu .wait{font-size:13px;color:var(--mute);padding:4px 14px 8px}
#chat-log{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:14px}
#chat-log>*{animation:rise .18s ease-out}
@keyframes rise{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.msg{line-height:1.55}.msg.me{align-self:flex-end;max-width:88%;border:1px solid var(--ink);padding:8px 12px;white-space:pre-wrap}
.msg+.msg:not(.me){margin-top:-6px}
.msg .who{font:500 11px/1 PlexMono,ui-monospace,monospace;letter-spacing:.04em;color:var(--mute);margin-bottom:6px}
.msg .live{white-space:pre-wrap}
.atts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;white-space:normal}.atts:first-child{margin-top:0}
.thumb{display:block;width:72px;height:72px;object-fit:cover;border:1px solid var(--rule)}
.att{font-size:13px;border-bottom:1px solid var(--rule)}
.step{font-size:13px;color:var(--mute);padding-left:12px;border-left:2px solid var(--rule)}.step.err{color:var(--accent);border-color:var(--accent)}
details.steps,details.plan{font-size:13px;color:var(--mute)}
details>summary{cursor:pointer;list-style:none;display:inline-block}details>summary::-webkit-details-marker{display:none}
details>summary::before{content:'+';display:inline-block;width:1.1em;font-family:PlexMono,ui-monospace,monospace}details[open]>summary::before{content:'\\2212'}
details>summary:hover{color:var(--ink)}details[open]>summary{margin-bottom:6px}
details.steps .step+.step{margin-top:2px}
.plan ol,ol.plan{list-style:none;padding:0;margin:0;font-size:13px}
.plan li{position:relative;padding:2px 0 2px 20px;color:var(--mute)}
.plan li::before{content:'';position:absolute;left:2px;top:.62em;width:8px;height:8px;border:1.5px solid var(--rule)}
.plan li.active{color:var(--ink)}.plan li.active::before{border-color:var(--ink)}
.plan li.done::before{background:var(--ink);border-color:var(--ink)}.plan li.done{color:var(--mute)}
ol.plan.live{border-left:2px solid var(--ink);padding-left:10px}
.status{font-size:13px;color:var(--mute);display:flex;gap:8px;align-items:baseline}
.status::before{content:'';flex:none;width:12px;height:2px;align-self:center;background:var(--ink);animation:tick 1.4s ease-in-out infinite}
@keyframes tick{0%,100%{transform:scaleX(.3);transform-origin:left}50%{transform:scaleX(1);transform-origin:left}}
.results{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:13px;padding-top:8px;border-top:1px solid var(--rule)}
.results a{text-decoration:underline;text-decoration-color:var(--rule);text-underline-offset:3px}.results a:hover{text-decoration-color:currentColor}
.note{font-size:13px;color:var(--mute)}.note.loud{color:var(--ink);padding-left:12px;border-left:2px solid var(--accent)}
.note .btn{margin-left:8px;vertical-align:baseline}.note .detail{display:block;margin-top:4px;font:12px/1.45 PlexMono,ui-monospace,monospace;color:var(--mute);overflow-wrap:anywhere;white-space:pre-wrap}
.older{align-self:center;font:inherit;font-size:13px;color:var(--mute);background:none;border:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
#chat-queue{padding:0 20px}#chat-queue:empty{display:none}
.queued{display:flex;gap:10px;align-items:baseline;font-size:13px;padding:8px 0;border-top:1px dashed var(--rule)}
.queued .q{font:500 11px/1 PlexMono,ui-monospace,monospace;letter-spacing:.04em;color:var(--mute);flex:none}
.queued .qt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.queued .x{font:inherit;background:none;border:0;color:var(--mute);cursor:pointer;padding:0 2px}.queued .x:hover{color:var(--ink)}
#chat-form{border-top:2px solid var(--ink);padding:12px 20px 16px}
#chat-input{width:100%;border:0;outline:0;resize:none;background:transparent;color:var(--ink);font:inherit}
#chat-files{display:flex;flex-wrap:wrap;gap:6px}#chat-files:not(:empty){margin-bottom:8px}
.chip{display:inline-flex;gap:6px;align-items:baseline;font-size:12px;border:1px solid var(--ink);padding:3px 4px 3px 8px;max-width:100%}
.chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}.chip button{font:inherit;background:none;border:0;color:var(--mute);cursor:pointer}.chip button:hover{color:var(--ink)}
#chat-form .row{display:flex;gap:8px;align-items:center;justify-content:flex-end}#chat-state{margin-right:auto;font-size:13px}
.link{font:inherit;font-size:13px;color:var(--mute);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--rule)}.link:hover{color:var(--ink)}
.drop-hint{display:none}
#chat.drop{outline:2px dashed var(--accent);outline-offset:-8px}
#chat.drop .drop-hint{display:flex;position:absolute;inset:0;align-items:center;justify-content:center;background:color-mix(in srgb,var(--paper) 88%,transparent);color:var(--accent);font-weight:500;pointer-events:none}
.act{font:500 11px/1 PlexMono,ui-monospace,monospace;letter-spacing:.04em;color:var(--mute);margin-left:8px;white-space:nowrap}.act.unread{color:var(--accent)}
.flash{animation:flash 1.8s ease-out}
@keyframes flash{from{background:color-mix(in srgb,var(--accent) 16%,transparent)}to{background:transparent}}
@media (prefers-reduced-motion:reduce){#chat-log>*,.menu,.flash,.status::before{animation:none}}
@media (max-width:1100px){.app{grid-template-columns:minmax(0,1fr)}#chat{position:relative;height:auto;border-left:0;border-top:2px solid var(--ink)}#chat-log{max-height:60vh}}
`;

/** Runs in the page, served as /assets/chat.js. Its settings (token, strings) are a JSON block, #td. */
export const CHAT_SCRIPT = String.raw`
(() => {
  const TD = JSON.parse(document.getElementById('td').textContent);
  const $ = (id) => document.getElementById(id);
  const view = $('view'), log = $('chat-log'), input = $('chat-input'), stopBtn = $('chat-stop'), state = $('chat-state');
  const queueBox = $('chat-queue'), filesBox = $('chat-files'), fileInput = $('chat-file'), pick = $('chat-pick'), menu = $('chat-menu'), form = $('chat-form'), chat = $('chat');
  let running = false, live = null, planEl = null, statusEl = null, queue = [], attached = [];
  let loading = 0, buffered = [];
  let thread = { agent: null, agents: [] };
  const models = {};
  const key = () => view.dataset.thread || '';
  const bottom = () => { log.scrollTop = log.scrollHeight; };
  const el = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text !== undefined && text !== null) d.textContent = text; return d; };
  const fill = (s, x) => s.replace('{x}', x || '').trim();
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let hint = null;
  function say(text) {
    state.textContent = text;
    clearTimeout(hint);
    hint = setTimeout(() => { if (state.textContent === text) state.textContent = ''; }, 6000);
  }

  function post(path, body) {
    body.token = TD.token;
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) =>
      r.ok ? r.json() : r.json().then((j) => { throw new Error(j.error || 'Failed'); }));
  }

  // While the agent works: its task list, its reply as it comes, and one line saying what it is doing.
  function setRunning(on) {
    running = on;
    stopBtn.hidden = !on;
    if (!on) {
      live = null;
      planEl = null;
      if (statusEl) statusEl.remove();
      statusEl = null;
    }
    renderQueue();
  }
  function status(text) {
    if (!statusEl) statusEl = el('div', 'status');
    statusEl.textContent = text;
    log.appendChild(statusEl);
    bottom();
  }
  function liveText(delta) {
    if (!live) {
      const m = el('div', 'msg');
      live = el('div', 'live');
      m.appendChild(live);
      log.insertBefore(m, statusEl && statusEl.parentNode === log ? statusEl : null);
    }
    live.textContent += delta;
    bottom();
  }
  function renderPlan(items) {
    if (!planEl) {
      planEl = el('ol', 'plan live');
      const mine = log.querySelectorAll('.msg.me');
      const last = mine[mine.length - 1];
      if (last) last.after(planEl); else log.prepend(planEl);
    }
    planEl.replaceChildren(...items.map((i) => el('li', i.status, i.text)));
    bottom();
  }
  function doing(s) {
    if (s.kind === 'toolbox' && TD.doing[s.name]) return TD.doing[s.name];
    if (s.kind === 'read' || s.kind === 'edit') return fill(TD.doing[s.kind], s.target);
    if (s.kind === 'command') return TD.doing.command;
    return TD.working;
  }
  function renderQueue() {
    queueBox.replaceChildren(...queue.map((q) => {
      const row = el('div', 'queued');
      row.appendChild(el('span', 'q', running ? TD.queued : TD.waiting));
      row.appendChild(el('span', 'qt', q.text || q.files.map((f) => f.split('/').pop()).join(', ')));
      const x = el('button', 'x', '×');
      x.type = 'button';
      x.dataset.unqueue = q.id;
      x.title = TD.unqueue;
      x.setAttribute('aria-label', TD.unqueue);
      row.appendChild(x);
      return row;
    }));
  }

  function apply(ev) {
    if (ev.type === 'start' || ev.type === 'end') return loadThread();
    if (ev.type === 'queue') { queue = ev.items; renderQueue(); return; }
    if (!running) setRunning(true);
    if (ev.type === 'text') { liveText(ev.delta); if (!statusEl || statusEl.textContent !== TD.working) status(TD.working); }
    else if (ev.type === 'plan') renderPlan(ev.items);
    else if (ev.type === 'tool') { live = null; if (ev.status === 'running') status(doing(ev)); }
    else if (ev.type === 'stalled') status(TD.stalled);
  }

  function loadThread() {
    const k = key();
    loading++;
    return fetch('/api/thread?key=' + encodeURIComponent(k)).then((r) => r.json()).then((t) => {
      if (k !== key()) return;
      thread = t;
      $('chat-who').textContent = t.who;
      setRunning(false);
      log.innerHTML = t.html;
      if (t.older) {
        const more = el('button', 'older', TD.older);
        more.type = 'button';
        more.dataset.older = String(t.older);
        log.prepend(more);
      }
      renderPick();
      if (!t.agent) log.appendChild(el('div', 'note', TD.noAgent));
      queue = t.queue;
      setRunning(t.running);
      if (t.running) {
        if (t.plan) renderPlan(t.plan);
        if (t.partial) liveText(t.partial);
        const now = t.steps.filter((s) => s.status === 'running').pop();
        status(t.stalled ? TD.stalled : now ? doing(now) : TD.working);
      }
      bottom();
      return t.seq;
    }).then((seq) => {
      const later = buffered.filter((d) => d.key === k && d.seq > seq);
      buffered = [];
      loading--;
      later.forEach((d) => apply(d.ev));
    }, () => { loading--; buffered = []; });
  }

  // The agent, its model and how hard it thinks: one menu, remembered per agent.
  function current() { return thread.agents.find((a) => a.id === thread.agent); }
  function levels(a) {
    const m = models[a.id];
    if (!m || !m.list) return [];
    if (!a.choice.model) return m.list.defaultEfforts;
    const x = m.list.models.find((y) => y.id === a.choice.model);
    return x ? x.efforts : [];
  }
  function renderPick() {
    const a = current();
    if (!a) { pick.textContent = ''; pick.hidden = true; return; }
    pick.hidden = false;
    const m = models[a.id] && models[a.id].list;
    const model = a.choice.model ? ((m && m.models.find((x) => x.id === a.choice.model)) || { label: a.choice.model }).label : '';
    const effort = a.choice.effort && levels(a).length ? TD.menu.efforts[a.choice.effort] : '';
    pick.textContent = [a.label, model, effort].filter(Boolean).join(' · ') + ' ▾';
  }
  function loadModels(id) {
    if (models[id]) return;
    models[id] = { list: null };
    fetch('/api/models?agent=' + encodeURIComponent(id)).then((r) => r.json()).then((list) => {
      models[id] = { list: list.models ? list : { models: [], defaultEfforts: [] } };
      renderPick();
      if (!menu.hidden) renderMenu();
    }, () => { models[id] = { list: { models: [], defaultEfforts: [] } }; if (!menu.hidden) renderMenu(); });
  }
  function opt(label, on, disabled, act, sub) {
    const b = el('button', 'opt');
    b.type = 'button';
    b.appendChild(el('span', '', label));
    if (sub) b.appendChild(el('span', 'sub', sub));
    b.setAttribute('aria-pressed', String(on));
    b.disabled = disabled;
    b.addEventListener('click', act);
    return b;
  }
  function choose(agent, choice) {
    thread.agent = agent.id;
    agent.choice = choice;
    post('/api/choice', { agent: agent.id, model: choice.model || '', effort: choice.effort || '' }).catch((e) => say(e.message));
    renderPick();
    renderMenu();
  }
  function renderMenu() {
    const a = current();
    const parts = [el('div', 'h', TD.menu.agent)];
    thread.agents.forEach((x) => parts.push(opt(x.label, x.id === thread.agent, !x.ready, () => { choose(x, x.choice); loadModels(x.id); }, x.ready ? '' : x.installed ? TD.signIn : TD.missing)));
    if (a) {
      parts.push(el('hr'), el('div', 'h', TD.menu.model));
      const m = models[a.id] && models[a.id].list;
      parts.push(opt(TD.menu.byDefault, !a.choice.model, false, () => choose(a, { effort: a.choice.effort }), m && m.defaultLabel ? m.defaultLabel : ''));
      if (!m) parts.push(el('div', 'wait', TD.menu.loading));
      else m.models.forEach((x) => parts.push(opt(x.label, a.choice.model === x.id, false, () => choose(a, { model: x.id, effort: a.choice.effort }))));
      if (levels(a).length) {
        parts.push(el('hr'), el('div', 'h', TD.menu.effort));
        const seg = el('div', 'seg');
        ['fast', 'standard', 'deep'].forEach((lv) => {
          const b = el('button', '', TD.menu.efforts[lv]);
          b.type = 'button';
          b.setAttribute('aria-pressed', String((a.choice.effort || 'standard') === lv));
          b.addEventListener('click', () => choose(a, { model: a.choice.model, effort: lv === 'standard' ? undefined : lv }));
          seg.appendChild(b);
        });
        parts.push(seg);
      }
    }
    menu.replaceChildren(...parts);
  }
  function toggleMenu(open) {
    menu.hidden = !open;
    pick.setAttribute('aria-expanded', String(open));
    if (open) { renderMenu(); if (thread.agent) loadModels(thread.agent); }
  }
  pick.addEventListener('click', () => toggleMenu(menu.hidden));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { toggleMenu(false); pick.focus(); } });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== pick) toggleMenu(false); });

  // Attachments: picked, pasted or dropped; checked here, saved when the message goes.
  function addFiles(list) {
    for (const f of list) {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (TD.attach.types.indexOf(ext) < 0) { say(fill(TD.attach.type, f.name)); continue; }
      if (f.size > TD.attach.max || f.size === 0) { say(fill(TD.attach.size, f.name)); continue; }
      if (attached.length >= TD.attach.count) { say(TD.attach.many); break; }
      attached.push(f);
    }
    renderFiles();
  }
  function renderFiles() {
    filesBox.replaceChildren(...attached.map((f, i) => {
      const c = el('span', 'chip');
      c.appendChild(el('span', '', f.name));
      const x = el('button', '', '×');
      x.type = 'button';
      x.setAttribute('aria-label', TD.unqueue);
      x.addEventListener('click', () => { attached.splice(i, 1); renderFiles(); });
      c.appendChild(x);
      return c;
    }));
  }
  function upload(f) {
    return fetch('/api/upload?key=' + encodeURIComponent(key()) + '&name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'x-td-token': TD.token, 'content-type': 'application/octet-stream' }, body: f })
      .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || 'Failed'); return j.file; }));
  }
  $('chat-attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(Array.from(fileInput.files)); fileInput.value = ''; });
  input.addEventListener('paste', (e) => {
    const fs = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (fs.length) { e.preventDefault(); addFiles(fs); }
  });
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).indexOf('Files') >= 0;
  chat.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); chat.classList.add('drop'); } });
  chat.addEventListener('dragleave', (e) => { if (!chat.contains(e.relatedTarget)) chat.classList.remove('drop'); });
  chat.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    chat.classList.remove('drop');
    addFiles(Array.from(e.dataTransfer.files));
    input.focus();
  });

  // Sending never waits: while the agent works, the message is queued and goes after.
  async function send(text, files) {
    text = text.trim();
    if (!text && !files.length) return true;
    return post('/api/send', { key: key(), text: text, files: files }).then(() => true, (e) => { say(e.message); return false; });
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim() && !attached.length) return;
    input.value = '';
    const files = [];
    if (attached.length) {
      state.textContent = TD.attach.uploading;
      try {
        for (const f of attached) files.push(await upload(f));
      } catch (err) {
        input.value = text;
        say(err.message);
        return;
      }
      state.textContent = '';
      attached = [];
      renderFiles();
    }
    if (!(await send(text, files))) input.value = text;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  stopBtn.addEventListener('click', () => post('/api/stop', { key: key() }));

  // The changed part of a page glows once, so the eye finds it.
  function flash(hash) {
    const t = hash && document.getElementById(hash);
    if (!t) return;
    t.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
    t.classList.remove('flash');
    void t.offsetWidth;
    t.classList.add('flash');
  }

  // The left side is replaced in place, so the conversation and its scroll position stay.
  function show(url, push) {
    return fetch(url).then((r) => r.text()).then((html) => {
      const next = new DOMParser().parseFromString(html, 'text/html').getElementById('view');
      if (!next) { location.href = url; return; }
      const was = key();
      const frame = view.querySelector('iframe');
      const nf = next.querySelector('iframe');
      if (frame && nf && frame.getAttribute('src') === nf.getAttribute('src')) nf.replaceWith(frame);
      view.replaceChildren(...Array.from(next.childNodes));
      view.dataset.thread = next.dataset.thread || '';
      document.title = next.dataset.title || document.title;
      if (push) { history.pushState(null, '', url); window.scrollTo(0, 0); }
      if (was !== key()) return loadThread();
    });
  }
  let again = null;
  function refresh() {
    clearTimeout(again);
    again = setTimeout(() => show(location.href, false), 120);
  }

  document.addEventListener('click', (e) => {
    const older = e.target.closest('[data-older]');
    if (older) {
      const part = Number(older.dataset.older);
      fetch('/api/thread?key=' + encodeURIComponent(key()) + '&part=' + part).then((r) => r.json()).then((t) => {
        const box = el('div');
        box.style.display = 'contents';
        box.innerHTML = t.html;
        older.after(box);
        if (part > 1) older.dataset.older = String(part - 1); else older.remove();
      });
      return;
    }
    const un = e.target.closest('[data-unqueue]');
    if (un) { post('/api/unqueue', { key: key(), id: un.dataset.unqueue }).catch((err) => say(err.message)); return; }
    const all = e.target.closest('[data-all]');
    if (all) {
      all.disabled = true;
      post('/api/all', {}).then((r) => say(fill(TD.allSent, String(r.sent))), (err) => { all.disabled = false; say(err.message); });
      return;
    }
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      e.preventDefault();
      tab.parentNode.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a === tab));
      const frame = view.querySelector('iframe');
      if (frame) frame.src = tab.getAttribute('href');
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      navigator.clipboard.writeText(document.getElementById(copy.dataset.copy).textContent).then(() => { copy.textContent = copy.dataset.done; });
      return;
    }
    const sayBtn = e.target.closest('[data-say],[data-fill]');
    if (sayBtn) {
      const text = sayBtn.dataset.say !== undefined ? sayBtn.dataset.say : sayBtn.dataset.fill;
      const files = sayBtn.dataset.files ? JSON.parse(sayBtn.dataset.files) : [];
      const go = sayBtn.dataset.key !== undefined && sayBtn.dataset.key !== key() ? show('/s/' + sayBtn.dataset.key, true) : Promise.resolve();
      go.then(() => {
        if (sayBtn.dataset.say !== undefined) return send(text, files);
        input.value = text;
        input.focus();
      });
      return;
    }
    const a = e.target.closest('a[href]');
    if (!a || a.target || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const href = a.getAttribute('href');
    if (href.charAt(0) !== '/' || href.indexOf('/files/') === 0) return;
    e.preventDefault();
    const [path, hash] = href.split('#');
    const same = path === location.pathname + location.search;
    (same ? Promise.resolve() : show(href, true)).then(() => flash(hash));
  });
  window.addEventListener('popstate', () => show(location.href, false));

  // ?static: no live updates (printing, screenshots).
  if (!new URLSearchParams(location.search).has('static')) {
    const es = new EventSource('/events');
    es.onmessage = refresh;
    es.addEventListener('activity', refresh);
    es.addEventListener('thread', (m) => {
      const d = JSON.parse(m.data);
      if (d.key !== key()) return;
      if (loading) buffered.push(d); else apply(d.ev);
    });
  }
  loadThread().then(() => flash(location.hash.slice(1)));
})();
`;
