/**
 * The Markdown the workspace uses, as HTML: headings, paragraphs, lists with checkboxes, tables,
 * **bold**, *emphasis*, `code` and [links](…). Everything is escaped; no raw HTML passes through.
 */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const emphasis = (s: string) =>
  esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');

/**
 * Where a link may go: a web page (opened in a new tab), or a student or lesson in the workspace (the
 * desk's own page for it). Anything else (javascript:, file:, paths outside students/) stays plain text.
 */
export function linkTarget(url: string): { href: string; external: boolean } | null {
  if (/^https?:\/\//i.test(url)) {
    try {
      return { href: new URL(url).href, external: true };
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || /^[\\/]/.test(url)) return null;
  const parts: string[] = [];
  for (const p of url.split('#')[0]!.replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (!parts.pop()) return null;
    } else parts.push(p);
  }
  const id = /^[a-z0-9-]+$/;
  if (parts[0] !== 'students' || !parts[1] || !id.test(parts[1])) return null;
  if (parts[2] === 'lessons' && parts[3] && id.test(parts[3])) return { href: `/s/${parts[1]}/l/${parts[3]}`, external: false };
  return { href: `/s/${parts[1]}`, external: false };
}

function links(s: string): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    out += emphasis(s.slice(last, m.index));
    const to = linkTarget(m[2]!);
    out += to ? `<a href="${esc(to.href)}"${to.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${emphasis(m[1]!)}</a>` : emphasis(m[1]!);
    last = m.index + m[0].length;
  }
  return out + emphasis(s.slice(last));
}

function inline(s: string): string {
  // Code first, so nothing inside it turns into a link or emphasis.
  return s
    .split(/(`[^`]+`)/)
    .map((part, i) => (i % 2 ? `<code>${esc(part.slice(1, -1))}</code>` : links(part)))
    .join('');
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function markdown(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    if (list.length) out.push(`<ul>${list.join('')}</ul>`);
    para = [];
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    const item = /^\s*[-*]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(l);
    if (h) {
      flush();
      const n = Math.min(h[1]!.length + 1, 4);
      out.push(`<h${n}>${inline(h[2]!)}</h${n}>`);
    } else if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '')) {
      flush();
      const head = cells(l);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]!); i++) rows.push(cells(lines[i]!));
      i--;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (item) {
      if (para.length) flush();
      const box = item[1] === undefined ? '' : `<span class="box${item[1] === ' ' ? '' : ' done'}" aria-label="${item[1] === ' ' ? 'to do' : 'done'}"></span>`;
      list.push(`<li${box ? ' class="check"' : ''}>${box}${inline(item[2]!)}</li>`);
    } else if (!l.trim()) {
      flush();
    } else {
      if (list.length) flush();
      para.push(l.trim());
    }
  }
  flush();
  return out.join('\n');
}
