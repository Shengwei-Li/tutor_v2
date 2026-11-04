import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists } from './proc.ts';

export const SKILLS = fileURLToPath(new URL('../skills/', import.meta.url));
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

/** Skill folders the agents read: Codex and OpenCode `.agents/skills`, Claude Code `.claude/skills`. */
const SKILL_ROOTS = ['.agents/skills', '.claude/skills'];

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

1. **The tutor decides.** A lesson plan starts as \`status: draft\`. Write materials only after the tutor approves it.
2. **Follow the skills**: student-intake, course-roadmap, lesson-prep, lesson-materials, lesson-record, writing-review; teaching-standards and exam-ielts / exam-pte for every plan and material.
3. **Check your work.** After changing student files, run the \`check_workspace\` tool and fix what it reports. PDFs come only from \`export_pdf\`.
4. **Facts** about the exams come from the exam skills, never from memory.
5. **Privacy.** Student data stays in this folder: no web searches or other services with student names or writing.
`;

export interface InitOptions {
  studio?: string;
  tutor?: string;
  /** Register the MCP server with Codex (user-wide, through `codex mcp add`). */
  codex?: boolean;
}

/** The command an agent runs to start the TutorDesk MCP server for this workspace. */
export function mcpCommand(root: string): { command: string; args: string[]; env: Record<string, string> } {
  // A Tectonic outside ~/.tutordesk (TUTORDESK_TECTONIC) travels with the command: agents start
  // MCP servers with an environment of their own.
  const env: Record<string, string> = process.env.TUTORDESK_TECTONIC ? { TUTORDESK_TECTONIC: process.env.TUTORDESK_TECTONIC } : {};
  return { command: process.execPath, args: [CLI, 'mcp', '--workspace', root], env };
}

/**
 * Make a folder a TutorDesk workspace, or refresh one: AGENTS.md, the skills, and the MCP server
 * registered for Claude Code (.mcp.json), OpenCode (opencode.json) and Codex. Student files are
 * never touched. Returns what it did, one line each.
 */
export async function init(dir: string, o: InitOptions = {}): Promise<string[]> {
  const root = path.resolve(dir);
  const done: string[] = [];
  await mkdir(path.join(root, 'students'), { recursive: true });

  const config = path.join(root, 'tutordesk.yaml');
  if (!(await exists(config))) {
    await writeFile(config, `studio: ${JSON.stringify(o.studio ?? 'My Tutoring Studio')}\ntutor: ${JSON.stringify(o.tutor ?? '')}\n`);
    done.push('tutordesk.yaml');
  }
  await writeFile(path.join(root, 'AGENTS.md'), AGENTS_MD);
  await writeFile(path.join(root, 'CLAUDE.md'), '@AGENTS.md\n');
  done.push('AGENTS.md, CLAUDE.md');

  for (const r of SKILL_ROOTS) {
    // Replace each skill folder whole, so files a newer version dropped do not linger.
    for (const skill of await readdir(SKILLS)) {
      await rm(path.join(root, r, skill), { recursive: true, force: true });
      await cp(path.join(SKILLS, skill), path.join(root, r, skill), { recursive: true });
    }
  }
  done.push(`skills in ${SKILL_ROOTS.join(' and ')}`);

  const mcp = mcpCommand(root);
  await mergeJson(path.join(root, '.mcp.json'), (j) => ({ ...j, mcpServers: { ...(j.mcpServers as object), tutordesk: { type: 'stdio', ...mcp } } }));
  await mergeJson(path.join(root, 'opencode.json'), (j) => ({
    $schema: 'https://opencode.ai/config.json',
    ...j,
    mcp: { ...(j.mcp as object), tutordesk: { type: 'local', command: [mcp.command, ...mcp.args], environment: mcp.env, enabled: true } },
  }));
  done.push('MCP server for Claude Code (.mcp.json) and OpenCode (opencode.json)');

  if (o.codex !== false) {
    await registerCodex(mcp);
    done.push(`MCP server for Codex (${codexConfig()})`);
  }
  return done;
}

async function mergeJson(file: string, change: (j: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const text = await readFile(file, 'utf8').catch(() => null);
  let j: Record<string, unknown> = {};
  if (text !== null) {
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`${path.basename(file)} is not valid JSON; fix or remove it, then run init again.`);
    }
  }
  await writeFile(file, `${JSON.stringify(change(j), null, 2)}\n`);
}

export function codexConfig(): string {
  return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');
}

/**
 * Codex reads MCP servers from the user's own config.toml only. Replace our [mcp_servers.tutordesk]
 * table there (it points at the latest workspace) and leave every other line alone.
 */
async function registerCodex(mcp: { command: string; args: string[]; env: Record<string, string> }): Promise<void> {
  const file = codexConfig();
  const text = (await readFile(file, 'utf8').catch(() => '')).replace(/\r\n/g, '\n');
  const kept = text.replace(/^\[mcp_servers\.tutordesk(?:\.[^\]]+)?\]\n(?:(?!\[)[^\n]*\n?)*/gm, '').trimEnd();
  const table = `[mcp_servers.tutordesk]\ncommand = ${JSON.stringify(mcp.command)}\nargs = ${JSON.stringify(mcp.args)}\n${Object.keys(mcp.env).length ? `env = { ${Object.entries(mcp.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')} }\n` : ''}`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${kept ? `${kept}\n\n` : ''}${table}`);
}
