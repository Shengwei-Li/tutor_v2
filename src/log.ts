import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { tutordeskHome } from './home.ts';

/**
 * ~/.tutordesk/log.txt: what the desk did, for when something goes wrong. Events and ids only, never
 * what anyone wrote and never a student's name. Past 2 MB it moves to log.1.txt (one old copy kept).
 */
const MAX = 2 * 1024 * 1024;
export const logFile = () => path.join(tutordeskHome(), 'log.txt');

type Fields = Record<string, string | number | boolean | undefined | null>;

let chain: Promise<void> = Promise.resolve();

const value = (v: string | number | boolean) => {
  const s = String(v).replace(/[\r\n]+/g, ' ');
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
};

export function log(event: string, fields: Fields = {}): Promise<void> {
  const line = `${new Date().toISOString()} ${event}${Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}=${value(v as string | number | boolean)}`)
    .join('')}\n`;
  chain = chain.then(async () => {
    try {
      await mkdir(tutordeskHome(), { recursive: true });
      const size = await stat(logFile()).then((s) => s.size, () => 0);
      if (size > MAX) await rename(logFile(), path.join(tutordeskHome(), 'log.1.txt')).catch(() => {});
      await appendFile(logFile(), line);
    } catch {
      // Logging never breaks the desk.
    }
  });
  return chain;
}

/** An error with its stack (stacks name code, not people). */
export function logError(where: string, e: unknown): Promise<void> {
  const err = e as Error;
  return log('error', { where, message: err?.message ?? String(e), stack: err?.stack?.split('\n').slice(1, 6).map((l) => l.trim()).join(' | ') });
}

/** The last lines, for the problem page. */
export async function tail(lines = 50): Promise<string> {
  await chain;
  const text = await readFile(logFile(), 'utf8').catch(() => '');
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}
