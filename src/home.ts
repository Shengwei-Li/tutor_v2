import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exists } from './proc.ts';

/**
 * ~/.tutordesk: the installed program, Tectonic, and which workspace was used last. Overridden by
 * TUTORDESK_HOME (tests).
 */
export function tutordeskHome(): string {
  return process.env.TUTORDESK_HOME ?? path.join(os.homedir(), '.tutordesk');
}

interface HomeConfig {
  /** The workspace used last: the desk and the agents fall back to it. */
  workspace?: string;
}

const configFile = () => path.join(tutordeskHome(), 'config.json');

export async function readHome(): Promise<HomeConfig> {
  try {
    return JSON.parse(await readFile(configFile(), 'utf8')) as HomeConfig;
  } catch {
    return {};
  }
}

export async function rememberWorkspace(root: string): Promise<void> {
  await mkdir(tutordeskHome(), { recursive: true });
  await writeFile(configFile(), `${JSON.stringify({ ...(await readHome()), workspace: root }, null, 2)}\n`);
}

/** A folder is a workspace when it has tutordesk.yaml. */
export const isWorkspace = (dir: string) => exists(path.join(dir, 'tutordesk.yaml'));

/** The workspace at or above a folder. */
async function above(dir: string): Promise<string | null> {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (await isWorkspace(d)) return d;
    if (path.dirname(d) === d) return null;
  }
}

/**
 * Which workspace an agent session is about. Agents start the MCP server differently: Claude Code
 * names the project in CLAUDE_PROJECT_DIR, Codex and OpenCode start it in the conversation's folder.
 * Outside any workspace, the one used last.
 */
export async function findWorkspace(explicit?: string): Promise<string | null> {
  if (explicit) return path.resolve(explicit);
  for (const dir of [process.env.CLAUDE_PROJECT_DIR, process.cwd()]) {
    const found = dir ? await above(dir) : null;
    if (found) return found;
  }
  const last = (await readHome()).workspace;
  return last && (await isWorkspace(last)) ? last : null;
}
