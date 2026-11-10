import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tutordeskHome } from './home.ts';
import { exists, run, which } from './proc.ts';

/**
 * The desk in a window of its own: the browser already on the computer in app mode (Edge on Windows,
 * else Chrome), with its own profile in ~/.tutordesk/window so it remembers its size and keeps away
 * from the tutor's browsing. Without either, the default browser opens a tab.
 */

export const windowProfile = () => path.join(tutordeskHome(), 'window');

async function first(candidates: string[]): Promise<string | null> {
  for (const c of candidates) if (c && (await exists(c))) return c;
  return null;
}

/** Edge or Chrome, whichever is found first; null when neither is. */
export async function appBrowser(): Promise<string | null> {
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
    return first([...roots.map((r) => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')), ...roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))]);
  }
  if (process.platform === 'darwin') {
    const apps = ['/Applications', path.join(os.homedir(), 'Applications')];
    return first(apps.flatMap((a) => [path.join(a, 'Google Chrome.app/Contents/MacOS/Google Chrome'), path.join(a, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge')]));
  }
  for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    const f = await which(n);
    if (f) return f;
  }
  return null;
}

export function openBrowser(url: string): void {
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(opener[0] as string, opener[1] as string[], { stdio: 'ignore', detached: true }).unref();
}

/** The desk's window: app mode if the computer has Edge or Chrome, else a tab. */
export async function openWindow(url: string): Promise<void> {
  const browser = await appBrowser();
  if (!browser) return openBrowser(url);
  spawn(browser, [`--app=${url}`, `--user-data-dir=${windowProfile()}`, '--no-first-run', '--no-default-browser-check'], { stdio: 'ignore', detached: true }).unref();
}

/**
 * Bring the desk's window to the front, if one is open (Windows). False when there is none, or it could
 * not be found: then a new one is opened instead.
 */
export async function focusWindow(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const dir = windowProfile().replace(/'/g, "''");
  // The browser's main process is the one without --type; its window is the desk's.
  const ps = `$p = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir}') -and -not $_.CommandLine.Contains('--type=') } | Select-Object -First 1; if ($p -and (New-Object -ComObject WScript.Shell).AppActivate([int]$p.ProcessId)) { 'yes' }`;
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { cwd: os.homedir(), timeoutMs: 8000 });
  return r.output.trim() === 'yes';
}

/**
 * The agent's own sign-in, in a console window of its own: it opens the browser and may ask a
 * question there. TutorDesk only starts it; the credentials stay between the agent and its service.
 */
export async function openConsole(name: string, command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  if (process.platform === 'win32') {
    // A small script, so no quoting passes through two shells. It stays open on an error, so it can be read.
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const script = path.join(tutordeskHome(), `signin-${name}.cmd`);
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, ['@echo off', 'chcp 65001 >nul', [command, ...args].map(q).join(' '), 'if errorlevel 1 pause', ''].join('\r\n'));
    spawn('cmd.exe', [`/d /c start "TutorDesk" ${q(script)}`], { windowsVerbatimArguments: true, stdio: 'ignore', detached: true, env }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    const sh = [command, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    const apple = sh.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${apple}"`], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  spawn('x-terminal-emulator', ['-e', command, ...args], { stdio: 'ignore', detached: true, env }).unref();
}
