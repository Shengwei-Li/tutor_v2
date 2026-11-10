import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rememberWorkspace } from './home.ts';
import { SKILLS, selfCommand } from './paths.ts';
import { exists, findProgram, run } from './proc.ts';

/**
 * Setting up: a workspace (a folder of student files the agents work in), and the agents themselves
 * (optional: `tutordesk connect` puts the skills and MCP server into the tutor's own agents).
 */

const AGENTS_MD = `# TutorDesk workspace

You work for a private English tutor preparing one-to-one IELTS and PTE lessons. Answer in the language the tutor writes in; lesson materials are in English.

## Files

- \`tutordesk.yaml\`: the studio name and the tutor's name.
- \`students/<id>/profile.md\`: who the student is, exam, target, weekly schedule.
- \`students/<id>/roadmap.md\`: the course plan, one line per lesson.
- \`students/<id>/lessons/<date>-<topic>/\`: \`plan.md\`, the materials (\`*.tex\`), \`record.md\` after the lesson, PDFs in \`out/\`.
- \`students/<id>/essays/<date>-<task>/\`: \`essay.md\`, \`review.md\`.
- \`students/<id>/notes.md\`: the tutor's private notes. Read them; change them only when asked.
- \`students/<id>/share/\`: generated for parents. Do not edit.

## Rules

1. **The tutor decides.** A lesson plan starts as \`status: draft\`. The tutor approves it with a button on the TutorDesk desk; you cannot approve for them, and materials come only after.
2. **Follow the skills**: tutordesk-student-intake, tutordesk-course-roadmap, tutordesk-lesson-prep, tutordesk-lesson-materials, tutordesk-lesson-record, tutordesk-writing-review; tutordesk-teaching-standards and tutordesk-exam-ielts / tutordesk-exam-pte for every plan and material.
3. **Check your work.** After changing student files, run the \`check_workspace\` tool and fix what it reports. PDFs come only from \`export_pdf\`.
4. **Facts** about the exams come from the exam skills, never from memory.
5. **Privacy.** Student data stays in this folder: no web searches or other services with student names or writing.
6. **No terminal for the tutor.** Never ask the tutor to run a command; the desk is where they look and approve.
`;

const MARK = '<!-- Written by TutorDesk; it replaces this file. Delete this line to keep your own version. -->';

/** Write a file TutorDesk owns; a file someone else wrote (no mark) is left alone. */
async function writeOwn(file: string, text: string): Promise<string> {
  const name = path.basename(file);
  const old = await readFile(file, 'utf8').catch(() => null);
  if (old !== null && !old.startsWith(MARK) && !old.startsWith('<!-- Written by tutordesk init')) return `${name} left as it is (not written by TutorDesk)`;
  await writeFile(file, `${MARK}\n${text}`);
  return name;
}

/** Copy every skill folder into `dir`, replacing each whole so files a newer version dropped do not linger. */
async function copySkills(dir: string): Promise<void> {
  for (const skill of await readdir(SKILLS)) {
    await rm(path.join(dir, skill), { recursive: true, force: true });
    await cp(path.join(SKILLS, skill), path.join(dir, skill), { recursive: true });
  }
}

export interface WorkspaceOptions {
  studio?: string;
  tutor?: string;
  /** False when only refreshing a workspace that is being opened: opening is not choosing. */
  remember?: boolean;
}

/**
 * Make a folder a workspace, or refresh one: tutordesk.yaml, students/, AGENTS.md, CLAUDE.md and the skills. Student
 * files are never touched. It becomes the workspace the desk and agents fall back to.
 */
export async function setupWorkspace(dir: string, o: WorkspaceOptions = {}): Promise<string[]> {
  const root = path.resolve(dir);
  const done: string[] = [];
  const config = path.join(root, 'tutordesk.yaml');
  // TutorDesk 1 kept its students in a different format, which these agents would misread.
  if ((await exists(path.join(root, 'workspace.json'))) && !(await exists(config))) {
    throw new Error(`${root} is a TutorDesk 1 workspace. Choose another folder for TutorDesk 2; the old one stays as it is.`);
  }
  await mkdir(path.join(root, 'students'), { recursive: true });
  if (!(await exists(config))) {
    await writeFile(config, `studio: ${JSON.stringify(o.studio ?? 'My Tutoring Studio')}\ntutor: ${JSON.stringify(o.tutor ?? '')}\n`);
    done.push('tutordesk.yaml');
  }
  for (const [name, text] of [['AGENTS.md', AGENTS_MD], ['CLAUDE.md', '@AGENTS.md\n']] as const) done.push(await writeOwn(path.join(root, name), text));
  // The skills live in the workspace (Codex and OpenCode read .agents/skills, Claude Code .claude/skills),
  // so nothing is installed into the agents themselves.
  for (const r of ['.agents/skills', '.claude/skills']) await copySkills(path.join(root, r));
  done.push('skills in .agents/skills and .claude/skills');
  if (o.remember !== false) await rememberWorkspace(root);
  return done;
}

/** The command an agent runs to start the TutorDesk MCP server. */
export function mcpCommand(workspace?: string): { command: string; args: string[]; env: Record<string, string> } {
  // A Tectonic outside ~/.tutordesk (TUTORDESK_TECTONIC) travels with the command: agents start
  // MCP servers with an environment of their own.
  const env: Record<string, string> = {};
  for (const k of ['TUTORDESK_TECTONIC', 'TUTORDESK_HOME']) if (process.env[k]) env[k] = process.env[k]!;
  const self = selfCommand();
  return { command: self.command, args: [...self.args, 'mcp', ...(workspace ? ['--workspace', workspace] : [])], env };
}

const home = () => os.homedir();
export const codexConfig = () => path.join(process.env.CODEX_HOME ?? path.join(home(), '.codex'), 'config.toml');
const claudeConfig = () => path.join(home(), '.claude.json');

/**
 * Claude Code's own command line: it rewrites ~/.claude.json while it runs, so the entry is added the
 * way Claude Code itself does it. TUTORDESK_CLAUDE_CLI (a JSON array, or empty for none) is for tests.
 */
async function claudeCli(): Promise<string[] | null> {
  const given = process.env.TUTORDESK_CLAUDE_CLI;
  if (given !== undefined) return given ? (JSON.parse(given) as string[]) : null;
  return findProgram('claude');
}

const claudeRun = (cli: string[], args: string[]) => run(cli[0]!, [...cli.slice(1), 'mcp', ...args], { cwd: home(), timeoutMs: 60_000 });
/** OpenCode reads opencode.json or opencode.jsonc (JSON with comments); use the one the tutor has. */
async function opencodeConfig(): Promise<string> {
  const dir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(home(), '.config'), 'opencode');
  return (await exists(path.join(dir, 'opencode.jsonc'))) ? path.join(dir, 'opencode.jsonc') : path.join(dir, 'opencode.json');
}

/**
 * Connect the agents on this computer, user-wide: the skills where each agent looks for them, and the
 * MCP server in each agent's own config. Agents that are not set up on this computer are skipped.
 */
export async function connectAgents(): Promise<string[]> {
  const done: string[] = [];
  const mcp = mcpCommand();
  // Codex and OpenCode read ~/.agents/skills; Claude Code reads ~/.claude/skills.
  await copySkills(path.join(home(), '.agents', 'skills'));
  done.push(`skills in ${path.join(home(), '.agents', 'skills')}`);
  if (await exists(path.join(home(), '.claude'))) {
    await copySkills(path.join(home(), '.claude', 'skills'));
    done.push(`skills in ${path.join(home(), '.claude', 'skills')}`);
  }
  if (await exists(path.dirname(codexConfig()))) {
    await registerCodex(mcp);
    done.push(`Codex: ${codexConfig()}`);
  }
  const claude = await claudeCli();
  if (claude) {
    await claudeRun(claude, ['remove', '--scope', 'user', 'tutordesk']);
    const env = Object.entries(mcp.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const r = await claudeRun(claude, ['add', '--scope', 'user', 'tutordesk', ...env, '--', mcp.command, ...mcp.args]);
    done.push(r.code === 0 ? 'Claude Code (claude mcp add)' : `Claude Code: could not add the server (${r.output.trim().split('\n').at(-1)})`);
  } else if (await exists(claudeConfig())) {
    // No claude command (rare): edit the file. Claude Code may write over it if it is open right now.
    await mergeJson(claudeConfig(), (j) => ({ ...j, mcpServers: { ...(j.mcpServers as object), tutordesk: { type: 'stdio', ...mcp } } }));
    done.push(`Claude Code: ${claudeConfig()} (if Claude Code was open, restart it)`);
  }
  const opencode = await opencodeConfig();
  if (await exists(path.dirname(opencode))) {
    await mergeJson(opencode, (j) => ({ $schema: 'https://opencode.ai/config.json', ...j, mcp: { ...(j.mcp as object), tutordesk: { type: 'local', command: [mcp.command, ...mcp.args], environment: mcp.env, enabled: true } } }));
    done.push(`OpenCode: ${opencode}`);
  }
  return done;
}

/** Undo connectAgents: our skills and our MCP entries go, everything else stays. */
export async function disconnectAgents(): Promise<string[]> {
  const done: string[] = [];
  for (const dir of [path.join(home(), '.agents', 'skills'), path.join(home(), '.claude', 'skills')]) {
    for (const skill of await readdir(SKILLS)) await rm(path.join(dir, skill), { recursive: true, force: true });
  }
  done.push('skills');
  if (await exists(codexConfig())) {
    const text = (await readFile(codexConfig(), 'utf8')).replace(/\r\n/g, '\n');
    await writeFile(codexConfig(), `${withoutCodexTable(text)}\n`);
    done.push('Codex');
  }
  const claude = await claudeCli();
  if (claude) {
    await claudeRun(claude, ['remove', '--scope', 'user', 'tutordesk']);
    done.push('Claude Code');
  }
  for (const [file, key] of [...(claude ? [] : [[claudeConfig(), 'mcpServers'] as const]), [await opencodeConfig(), 'mcp'] as const]) {
    if (!(await exists(file))) continue;
    await mergeJson(file, (j) => {
      const servers = { ...(j[key] as Record<string, unknown>) };
      delete servers.tutordesk;
      return { ...j, [key]: servers };
    });
    done.push(path.basename(file));
  }
  return done;
}

async function mergeJson(file: string, change: (j: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const text = await readFile(file, 'utf8').catch(() => null);
  let j: Record<string, unknown> = {};
  if (text !== null) {
    const plain = withoutComments(text);
    try {
      j = JSON.parse(plain) as Record<string, unknown>;
    } catch {
      throw new Error(`${path.basename(file)} is not valid JSON; fix or remove it, then try again.`);
    }
    // Rewriting drops comments: keep the tutor's version next to it.
    if (plain.trim() !== text.trim()) await writeFile(`${file}.bak`, text);
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(change(j), null, 2)}\n`);
}

const withoutCodexTable = (text: string) => text.replace(/^\[mcp_servers\.tutordesk(?:\.[^\]]+)?\]\n(?:(?!\[)[^\n]*\n?)*/gm, '').trimEnd();

/** Codex reads MCP servers from the user's own config.toml only: replace our table, keep every other line. */
async function registerCodex(mcp: { command: string; args: string[]; env: Record<string, string> }): Promise<void> {
  const file = codexConfig();
  const kept = withoutCodexTable((await readFile(file, 'utf8').catch(() => '')).replace(/\r\n/g, '\n'));
  const table = `[mcp_servers.tutordesk]\ncommand = ${JSON.stringify(mcp.command)}\nargs = ${JSON.stringify(mcp.args)}\n${Object.keys(mcp.env).length ? `env = { ${Object.entries(mcp.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')} }\n` : ''}`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${kept ? `${kept}\n\n` : ''}${table}`);
}

/** JSON with line and block comments (and trailing commas) as plain JSON; text inside strings is kept. */
export function withoutComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
