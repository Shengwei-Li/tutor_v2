import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getAsset } from 'node:sea';
import { findWorkspace, isWorkspace, tutordeskHome } from './home.ts';
import { connectAgents, disconnectAgents, setupWorkspace } from './init.ts';
import { SEA, VERSION, installedBinary, selfCommand } from './paths.ts';
import { exists, run } from './proc.ts';
import { setupTectonic } from './tectonic.ts';

/**
 * Everything a tutor needs, from one double-click: the program and its files in ~/.tutordesk, the PDF
 * engine, the skills and MCP server in each agent on this computer, a workspace in Documents, and a
 * desktop shortcut to the desk. Running it again updates in place; student files are never touched.
 */
export async function install(say: (line: string) => void = console.log): Promise<string> {
  if (SEA) {
    say(`Installing TutorDesk ${VERSION}…`);
    await unpack();
  }
  await setupTectonic(say);
  for (const line of await connectAgents()) say(`Connected ${line}`);
  let workspace = await findWorkspace();
  if (!workspace) {
    workspace = await freeFolder(await documentsFolder());
    await setupWorkspace(workspace);
    say(`Your student files will live in ${workspace}`);
  }
  await shortcut();
  say('Added a TutorDesk shortcut to your desktop.');
  return workspace;
}

export async function uninstall(say: (line: string) => void = console.log): Promise<void> {
  for (const line of await disconnectAgents()) say(`Disconnected ${line}`);
  await rm(await shortcutPath(), { force: true });
  for (const d of ['bin', 'app', 'tectonic']) await rm(path.join(tutordeskHome(), d), { recursive: true, force: true });
  say('TutorDesk is removed. Your student files are where they were.');
}

/** True when this program is not (yet) the installed copy of this version. */
export async function needsInstall(): Promise<boolean> {
  if (!SEA) return false;
  const installed = await readFile(path.join(tutordeskHome(), 'app', 'VERSION'), 'utf8').catch(() => '');
  return installed.trim() !== VERSION || path.resolve(process.execPath) !== path.resolve(installedBinary());
}

/** The single-file program carries skills and templates as assets (see scripts/build.mjs). */
async function unpack(): Promise<void> {
  const app = path.join(tutordeskHome(), 'app');
  await rm(app, { recursive: true, force: true });
  const files = JSON.parse(getAsset('manifest.json', 'utf8')) as string[];
  for (const f of files) {
    const to = path.join(app, ...f.split('/'));
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, Buffer.from(getAsset(f)));
  }
  await writeFile(path.join(app, 'VERSION'), VERSION);
  const bin = installedBinary();
  if (path.resolve(process.execPath) !== path.resolve(bin)) {
    await mkdir(path.dirname(bin), { recursive: true });
    // A running copy cannot be overwritten on Windows; move it aside first.
    await rm(`${bin}.old`, { force: true });
    if (await exists(bin)) await rename(bin, `${bin}.old`).catch(() => {});
    await copyFile(process.execPath, bin);
    if (process.platform !== 'win32') await chmod(bin, 0o755);
    // Gone now unless that copy is still running (an open desk); then the next install removes it.
    await rm(`${bin}.old`, { force: true }).catch(() => {});
  }
}

/**
 * Documents/TutorDesk, or TutorDesk 2, 3… when that name holds something else (a TutorDesk 1 workspace,
 * say): a new workspace never moves into a folder that is already in use.
 */
async function freeFolder(documents: string): Promise<string> {
  for (let n = 1; ; n++) {
    const dir = path.join(documents, n === 1 ? 'TutorDesk' : `TutorDesk ${n}`);
    if (await isWorkspace(dir)) return dir;
    const entries = await readdir(dir).catch(() => null);
    if (!entries || entries.length === 0) return dir;
  }
}

async function documentsFolder(): Promise<string> {
  if (process.env.TUTORDESK_DOCUMENTS) return process.env.TUTORDESK_DOCUMENTS;
  if (process.platform === 'win32') {
    // Documents may be redirected (OneDrive).
    const r = await run('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"], { cwd: os.homedir(), timeoutMs: 20_000 });
    const dir = r.output.trim();
    if (r.code === 0 && dir) return dir;
  }
  return path.join(os.homedir(), 'Documents');
}

async function desktopFolder(): Promise<string> {
  if (process.env.TUTORDESK_DESKTOP) return process.env.TUTORDESK_DESKTOP;
  if (process.platform === 'win32') {
    const r = await run('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { cwd: os.homedir(), timeoutMs: 20_000 });
    if (r.code === 0 && r.output.trim()) return r.output.trim();
  }
  return path.join(os.homedir(), 'Desktop');
}

async function shortcutPath(): Promise<string> {
  if (process.platform === 'linux') return path.join(os.homedir(), '.local', 'share', 'applications', 'tutordesk.desktop');
  return path.join(await desktopFolder(), process.platform === 'win32' ? 'TutorDesk.lnk' : 'TutorDesk.command');
}

/** A desktop shortcut that opens the desk. */
async function shortcut(): Promise<void> {
  const self = selfCommand();
  const args = [...self.args, 'open'];
  const file = await shortcutPath();
  await mkdir(path.dirname(file), { recursive: true });
  if (process.platform === 'win32') {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${q(file)});$s.TargetPath=${q(self.command)};$s.Arguments=${q(args.map((a) => `"${a}"`).join(' '))};$s.WorkingDirectory=${q(os.homedir())};$s.Description='TutorDesk';$s.Save()`;
    const r = await run('powershell', ['-NoProfile', '-Command', ps], { cwd: os.homedir(), timeoutMs: 20_000 });
    if (r.code !== 0) throw new Error(`Could not create the desktop shortcut: ${r.output.trim()}`);
  } else if (process.platform === 'darwin') {
    await writeFile(file, `#!/bin/sh\nexec ${[self.command, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}\n`);
    await chmod(file, 0o755);
  } else {
    await writeFile(file, `[Desktop Entry]\nType=Application\nName=TutorDesk\nExec=${[self.command, ...args].map((a) => `"${a}"`).join(' ')}\nTerminal=false\n`);
  }
}
