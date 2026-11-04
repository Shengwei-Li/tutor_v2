import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
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
