/**
 * The Markdown the workspace uses, as HTML: headings, paragraphs, lists with checkboxes, tables,
 * **bold**, *emphasis* and `code`. Everything is escaped first; no raw HTML passes through.
 */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
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
