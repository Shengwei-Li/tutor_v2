import { agentLabel } from './agents/index.ts';
import { esc, markdown } from './md.ts';
import type { Entry } from './threads.ts';

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
  steps: (n: number) => string;
  tools: Record<string, string>;
  retry: string;
  older: string;
  stalled: string;
  notes: {
    stopped: string;
    failed: (agent: string) => string;
    interrupted: (agent: string) => string;
    missing: (agent: string) => string;
    notSignedIn: (agent: string) => string;
    noStart: (agent: string) => string;
    restarted: (agent: string) => string;
    restored: string;
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
    default:
  }
  const loud = e.kind === 'failed' || e.kind === 'interrupted' || e.kind === 'no_start' || e.kind === 'restored';
  const retry = e.retry ? ` <button class="btn small" data-say="${esc(e.retry)}" data-key="${esc(key)}">${esc(t.retry)}</button>` : '';
  return `<div class="note${loud ? ' loud' : ''}">${esc(say)}${retry}${detail ? `<span class="detail">${esc(detail.slice(0, 600))}</span>` : ''}</div>`;
}

/** Our own tools get a name the tutor recognises; an agent's reading and searching is just a count. */
function toolLine(e: Extract<Entry, { role: 'tool' }>, t: ChatText): string {
  return `<div class="step${e.ok ? '' : ' err'}">${esc(t.tools[e.name] ?? e.name)}${e.target ? ` <span class="mono">${esc(e.target)}</span>` : ''}${e.ok ? '' : ' ✕'}</div>`;
}

export function renderEntries(entries: Entry[], t: ChatText, key = ''): string {
  const out: string[] = [];
  let quiet = 0;
  const flush = () => {
    if (quiet) out.push(`<div class="step dim">${esc(t.steps(quiet))}</div>`);
    quiet = 0;
  };
  for (const e of entries) {
    if (e.role === 'tool' && e.ok && !(e.name in t.tools)) {
      quiet++;
      continue;
    }
    flush();
    if (e.role === 'tutor') out.push(`<div class="msg me">${esc(e.text)}</div>`);
    else if (e.role === 'agent') out.push(`<div class="msg"><div class="who">${esc(agentLabel(e.agent))}</div><div class="prose">${markdown(e.text)}</div></div>`);
    else if (e.role === 'tool') out.push(toolLine(e, t));
    else out.push(noteLine(e, t, key));
  }
  flush();
  return out.join('');
}

export const chatShell = (t: ChatText) => `<aside id="chat" aria-label="Agent">
<header><b id="chat-who"></b><select id="chat-agent" aria-label="Agent"></select></header>
<div id="chat-log" aria-live="polite"></div>
<form id="chat-form"><textarea id="chat-input" rows="3" placeholder="${esc(t.placeholder)}"></textarea>
<div class="row"><span id="chat-state" class="mute"></span><button type="button" class="btn small" id="chat-stop" hidden>${esc(t.stop)}</button><button class="btn primary small" id="chat-send">${esc(t.send)}</button></div></form>
</aside>`;

export const CHAT_CSS = `
.app{display:grid;grid-template-columns:minmax(0,1fr) 400px;min-height:100vh}
#chat{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;border-left:2px solid var(--ink);background:var(--paper)}
#chat header{display:flex;align-items:baseline;gap:12px;padding:28px 20px 14px;border-bottom:1px solid var(--rule)}
#chat header b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#chat select{font:inherit;font-size:13px;color:var(--mute);background:var(--paper);border:0;cursor:pointer;max-width:170px}
#chat-log{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:14px}
.msg{line-height:1.55}.msg.me{align-self:flex-end;max-width:88%;border:1px solid var(--ink);padding:8px 12px;white-space:pre-wrap}
.msg .who{font:500 11px/1 PlexMono,ui-monospace,monospace;letter-spacing:.04em;color:var(--mute);margin-bottom:6px}
.msg .live{white-space:pre-wrap}
.step{font-size:13px;color:var(--ink);padding-left:12px;border-left:2px solid var(--ink)}.step.dim{color:var(--mute);border-color:var(--rule)}.step.err{color:var(--accent);border-color:var(--accent)}
.note{font-size:13px;color:var(--mute)}.note.loud{color:var(--ink);padding-left:12px;border-left:2px solid var(--accent)}
.note .btn{margin-left:8px;vertical-align:baseline}.note .detail{display:block;margin-top:4px;font:12px/1.45 PlexMono,ui-monospace,monospace;color:var(--mute);overflow-wrap:anywhere}
.older{align-self:center;font:inherit;font-size:13px;color:var(--mute);background:none;border:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
#chat-form{border-top:2px solid var(--ink);padding:12px 20px 16px}
#chat-input{width:100%;border:0;outline:0;resize:none;background:transparent;color:var(--ink);font:inherit}
#chat-form .row{display:flex;gap:8px;align-items:center;justify-content:flex-end}#chat-state{margin-right:auto;font-size:13px}
@media (max-width:1100px){.app{grid-template-columns:minmax(0,1fr)}#chat{position:static;height:auto;border-left:0;border-top:2px solid var(--ink)}#chat-log{max-height:60vh}}
`;

/** Runs in the page, served as /assets/chat.js. Its settings (token, strings) are a JSON block, #td. */
export const CHAT_SCRIPT = `
(function () {
  var TD = JSON.parse(document.getElementById('td').textContent);
  var view = document.getElementById('view');
  var log = document.getElementById('chat-log');
  var input = document.getElementById('chat-input');
  var stopBtn = document.getElementById('chat-stop');
  var sendBtn = document.getElementById('chat-send');
  var state = document.getElementById('chat-state');
  var agentSel = document.getElementById('chat-agent');
  var running = false;
  var live = null;
  function key() { return view.dataset.thread || ''; }
  function bottom() { log.scrollTop = log.scrollHeight; }
  function el(cls, text) { var d = document.createElement('div'); d.className = cls; if (text) d.textContent = text; return d; }
  function setRunning(on) {
    running = on;
    stopBtn.hidden = !on;
    sendBtn.disabled = on;
    state.textContent = on ? TD.working : '';
    if (!on) live = null;
  }
  function liveText(delta) {
    if (!live) {
      var m = el('msg');
      live = el('live');
      m.appendChild(live);
      log.appendChild(m);
    }
    live.textContent += delta;
    bottom();
  }
  function post(path, body) {
    body.token = TD.token;
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (j) { throw new Error(j.error || 'Failed'); });
    });
  }
  function loadThread() {
    var k = key();
    return fetch('/api/thread?key=' + encodeURIComponent(k)).then(function (r) { return r.json(); }).then(function (t) {
      if (k !== key()) return;
      document.getElementById('chat-who').textContent = t.who;
      log.innerHTML = t.html;
      if (t.older) {
        var more = el('older', TD.older);
        more.dataset.older = String(t.older);
        log.prepend(more);
      }
      agentSel.innerHTML = '';
      t.agents.forEach(function (a) {
        var o = new Option(a.label + (a.ready ? '' : ' · ' + (a.installed ? TD.signIn : TD.missing)), a.id, false, a.id === t.agent);
        o.disabled = !a.ready;
        o.title = a.hint;
        agentSel.appendChild(o);
      });
      if (!t.agent) log.appendChild(el('note', TD.noAgent));
      setRunning(t.running);
      if (t.stalled) state.textContent = TD.stalled;
      t.steps.forEach(function (s) { log.appendChild(el('step dim', s.name + (s.target ? ' ' + s.target : ''))); });
      if (t.partial) liveText(t.partial);
      bottom();
    });
  }
  function send(text) {
    text = text.trim();
    if (!text || running) return;
    log.appendChild(el('msg me', text));
    setRunning(true);
    bottom();
    post('/api/send', { key: key(), text: text }).catch(function (e) {
      log.appendChild(el('note', e.message));
      setRunning(false);
    });
  }
  // The left side is replaced in place, so the conversation and its scroll position stay.
  function show(url, push) {
    return fetch(url).then(function (r) { return r.text(); }).then(function (html) {
      var next = new DOMParser().parseFromString(html, 'text/html').getElementById('view');
      if (!next) { location.href = url; return; }
      var was = key();
      var frame = view.querySelector('iframe');
      var keep = frame && next.querySelector('iframe') && frame.getAttribute('src') === next.querySelector('iframe').getAttribute('src');
      if (keep) next.querySelector('iframe').replaceWith(frame);
      view.replaceChildren.apply(view, Array.from(next.childNodes));
      view.dataset.thread = next.dataset.thread || '';
      document.title = next.dataset.title || document.title;
      if (push) { history.pushState(null, '', url); window.scrollTo(0, 0); }
      if (was !== key()) return loadThread();
    });
  }
  document.addEventListener('click', function (e) {
    var older = e.target.closest('[data-older]');
    if (older) {
      var part = Number(older.dataset.older);
      fetch('/api/thread?key=' + encodeURIComponent(key()) + '&part=' + part).then(function (r) { return r.json(); }).then(function (t) {
        var box = document.createElement('div');
        box.style.display = 'contents';
        box.innerHTML = t.html;
        older.after(box);
        if (part > 1) older.dataset.older = String(part - 1);
        else older.remove();
      });
      return;
    }
    var tab = e.target.closest('[data-tab]');
    if (tab) {
      e.preventDefault();
      tab.parentNode.querySelectorAll('a').forEach(function (a) { a.classList.toggle('on', a === tab); });
      var frame = view.querySelector('iframe');
      if (frame) frame.src = tab.getAttribute('href');
      return;
    }
    var copy = e.target.closest('[data-copy]');
    if (copy) {
      navigator.clipboard.writeText(document.getElementById(copy.dataset.copy).textContent).then(function () { copy.textContent = copy.dataset.done; });
      return;
    }
    var say = e.target.closest('[data-say],[data-fill]');
    if (say) {
      var text = say.dataset.say || say.dataset.fill;
      var go = say.dataset.key !== undefined && say.dataset.key !== key() ? show('/s/' + say.dataset.key, true) : Promise.resolve();
      go.then(function () {
        if (say.dataset.say) return send(text);
        input.value = text;
        input.focus();
      });
      return;
    }
    var a = e.target.closest('a[href]');
    if (!a || a.target || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var href = a.getAttribute('href');
    if (href.charAt(0) !== '/' || href.indexOf('/files/') === 0) return;
    e.preventDefault();
    show(href, true).then(function () {
      var hash = href.split('#')[1];
      if (hash && document.getElementById(hash)) document.getElementById(hash).scrollIntoView();
    });
  });
  window.addEventListener('popstate', function () { show(location.href, false); });
  document.getElementById('chat-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value;
    input.value = '';
    send(text);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); document.getElementById('chat-form').requestSubmit(); }
  });
  stopBtn.addEventListener('click', function () { post('/api/stop', { key: key() }); });
  agentSel.addEventListener('change', function () { post('/api/agent', { agent: agentSel.value }); });
  // ?static: no live updates (printing, screenshots).
  if (!new URLSearchParams(location.search).has('static')) {
    var es = new EventSource('/events');
    es.onmessage = function () { show(location.href, false); };
    es.addEventListener('thread', function (m) {
      var d = JSON.parse(m.data);
      if (d.key !== key()) return;
      if (d.ev.type === 'text' || d.ev.type === 'tool') state.textContent = TD.working;
      if (d.ev.type === 'text') { if (!running) setRunning(true); liveText(d.ev.delta); }
      else if (d.ev.type === 'tool') {
        live = null;
        if (d.ev.status === 'running') { log.appendChild(el('step dim', (TD.tools[d.ev.name] || d.ev.name) + (d.ev.target ? ' ' + d.ev.target : ''))); bottom(); }
      } else if (d.ev.type === 'stalled') state.textContent = TD.stalled;
      else if (d.ev.type === 'end') loadThread();
    });
  }
  loadThread();
})();
`;
