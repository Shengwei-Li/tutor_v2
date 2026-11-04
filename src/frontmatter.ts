import { parseDocument, stringify } from 'yaml';

/** A Markdown file with an optional YAML block at the top. */
export interface MdFile {
  data: Record<string, unknown>;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseMd(raw: string): MdFile {
  // Windows PowerShell writes UTF-8 with a byte-order mark.
  const text = raw.replace(/^﻿/, '');
  const m = FENCE.exec(text);
  if (!m) return { data: {}, body: text };
  const doc = parseDocument(m[1]!);
  if (doc.errors.length) {
    const e = doc.errors[0]!;
    // The usual cause: a value with ": " in it, such as a lesson topic.
    const hint = e.code === 'BLOCK_AS_IMPLICIT_KEY' || /mappings are not allowed/.test(e.message) ? ' (put a value that contains ": " in quotes)' : '';
    throw new Error(`YAML: ${e.message.split('\n')[0]}${hint}`);
  }
  const data = doc.toJS() as unknown;
  if (data !== null && (typeof data !== 'object' || Array.isArray(data))) throw new Error('YAML: the block at the top must be key: value lines');
  return { data: (data ?? {}) as Record<string, unknown>, body: text.slice(m[0].length) };
}

export function writeMd(f: MdFile): string {
  return `---\n${stringify(f.data).trimEnd()}\n---\n${f.body.startsWith('\n') ? '' : '\n'}${f.body}`;
}

/** Set one top-level YAML field and keep the rest of the file, comments included. */
export function setField(raw: string, key: string, value: unknown): string {
  const text = raw.replace(/^﻿/, '');
  const m = FENCE.exec(text);
  if (!m) return writeMd({ data: { [key]: value }, body: text });
  const doc = parseDocument(m[1]!);
  doc.set(key, value);
  return `---\n${doc.toString().trimEnd()}\n---\n${text.slice(m[0].length)}`;
}
