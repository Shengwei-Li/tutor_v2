import { spawn, type ChildProcess } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const isWin = process.platform === 'win32';

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** An executable on PATH (only real binaries: TeX ships .exe files on Windows). */
export async function which(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const f = path.join(d, isWin ? `${name}.exe` : name);
    if (await exists(f)) return f;
  }
  return null;
}

/**
 * A command line program as [program, ...leading args], following npm's Windows .cmd launchers to what
 * they start: a .cmd file can only run through a shell, which breaks paths with spaces.
 */
export async function findProgram(name: string): Promise<string[] | null> {
  const direct = await which(name);
  if (direct || !isWin) return direct ? [direct] : null;
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const shim = path.join(d, `${name}.cmd`);
    if (!(await exists(shim))) continue;
    const text = await readFile(shim, 'utf8');
    const target = [...text.matchAll(/"%~?dp0%\\?([^"]+)"/gi)].map((m) => m[1]!).reverse().find((t) => !/node(\.exe)?$/i.test(t));
    if (!target) continue;
    const full = path.join(d, target);
    if (/\.exe$/i.test(full)) return [full];
    const node = await which('node');
    if (/\.[cm]?js$/i.test(full) && node) return [node, full];
  }
  return null;
}

export interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** Run a program to the end or the timeout; on timeout the whole process tree is killed. */
export function run(command: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin });
    let output = '';
    let timedOut = false;
    const collect = (c: Buffer) => {
      output = (output + c.toString('utf8')).slice(-200_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) return;
      if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGKILL');
    }, opts.timeoutMs);
    child.on('error', (e) => {
      output += `\n${e.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/** A program to start: the executable and the arguments that come before ours. */
export interface Program {
  command: string;
  prefixArgs: string[];
}

export async function program(name: string): Promise<Program | null> {
  const found = await findProgram(name);
  return found ? { command: found[0]!, prefixArgs: found.slice(1) } : null;
}

/** Kill a child and everything it started (agents run tool subprocesses). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}

/** Kill the process tree and wait until it has exited (its files and folder are released). */
export async function stopProcess(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  killTree(child);
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

/** Split a byte stream into complete lines, tolerating chunks that end mid-line. */
export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split(/\r?\n/);
    this.buf = parts.pop() ?? '';
    return parts.filter((l) => l.trim().length > 0);
  }
}
