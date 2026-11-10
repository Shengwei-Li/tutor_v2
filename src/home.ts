import { readJson, writeAtomic } from './files.ts';
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
  /** The agent the tutor picked on the desk. */
  agent?: string;
  /** Per agent, the model and thinking level picked on the desk; absent means the agent's own default. */
  choices?: Record<string, Choice>;
}

export interface Choice {
  model?: string;
  effort?: 'fast' | 'deep';
}

/** Only for conversations TutorDesk starts: the agent's own settings are not touched. */
export async function rememberChoice(agent: string, choice: Choice): Promise<void> {
  const home = await readHome();
  const clean: Choice = {};
  if (choice.model) clean.model = choice.model;
  if (choice.effort === 'fast' || choice.effort === 'deep') clean.effort = choice.effort;
  await writeAtomic(configFile(), `${JSON.stringify({ ...home, agent, choices: { ...home.choices, [agent]: clean } }, null, 2)}\n`);
}

const configFile = () => path.join(tutordeskHome(), 'config.json');

export async function readHome(): Promise<HomeConfig> {
  return (await readJson<HomeConfig>(configFile())) ?? {};
}

export async function rememberWorkspace(root: string): Promise<void> {
  await writeAtomic(configFile(), `${JSON.stringify({ ...(await readHome()), workspace: root }, null, 2)}\n`);
}

export async function rememberAgent(agent: string): Promise<void> {
  await writeAtomic(configFile(), `${JSON.stringify({ ...(await readHome()), agent }, null, 2)}\n`);
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
