import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startDesk } from './desk.ts';
import { openWindow } from './window.ts';
import { findWorkspace } from './home.ts';
import { setupWorkspace } from './init.ts';
import { checkWorkspace, exportPdf, shareWithParents, type ToolResult } from './tools.ts';

const INSTRUCTIONS = `TutorDesk: a private IELTS/PTE tutor's workspace of plain files (see its AGENTS.md and the tutordesk skill).
You read and write the student files yourself. These tools do what files cannot: set up the workspace, open the tutor's desk, check the files, turn lesson .tex files into PDFs once the tutor has approved the plan, and make the parent page.`;

const NO_WORKSPACE: ToolResult = {
  text: 'There is no TutorDesk workspace yet. Ask the tutor where to keep their student files (suggest a TutorDesk folder in their Documents), then call setup_workspace with that folder.',
  isError: true,
};

const reply = (r: ToolResult) => ({ content: [{ type: 'text' as const, text: r.text }], isError: r.isError });

export interface ServerOptions {
  /** A fixed workspace (development); otherwise it is found from the agent's folder on every call. */
  workspace?: string;
  /** Start the desk with the server (off in tests). */
  desk?: boolean;
  open?: (url: string) => void;
}

export function createServer(version: string, o: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'tutordesk', version }, { instructions: INSTRUCTIONS });
  const desks = new Map<string, Promise<string>>();
  const desk = (root: string) => {
    if (!desks.has(root)) desks.set(root, startDesk(root, { background: true }));
    return desks.get(root)!;
  };
  /** Run a tool against the workspace; the desk comes up with the first call that has one. */
  const within = async (fn: (root: string) => Promise<ToolResult>) => {
    const root = await findWorkspace(o.workspace);
    if (!root) return reply(NO_WORKSPACE);
    if (o.desk !== false) void desk(root).catch(() => {});
    return reply(await fn(root));
  };

  server.registerTool(
    'setup_workspace',
    {
      title: 'Set up the workspace',
      description: "Make a folder the tutor's TutorDesk workspace (or refresh one): student folders, the agent instructions, the tutor's name and studio. Existing student files are never touched.",
      inputSchema: {
        folder: z.string().describe('Absolute path the tutor chose, e.g. C:\\Users\\Lin\\Documents\\TutorDesk'),
        tutor: z.string().optional().describe("The tutor's name"),
        studio: z.string().optional().describe("The studio's name, shown on materials"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ folder, tutor, studio }) => {
      if (!path.isAbsolute(folder)) return reply({ text: 'folder must be an absolute path.', isError: true });
      const root = path.resolve(folder);
      const done = await setupWorkspace(root, { tutor, studio });
      return reply({ text: `Workspace ready at ${root} (${done.join(', ')}). Next: open_desk, then carry on with what the tutor asked.` });
    },
  );
  server.registerTool(
    'open_desk',
    {
      title: 'Open the desk',
      description: "Open the TutorDesk desk in the tutor's browser: the week, students, plans to approve, PDFs. Use it whenever the tutor wants to see or approve something.",
      inputSchema: { page: z.string().optional().describe('A student folder name, or student/lesson folder names, to open that page') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ page }) =>
      within(async (root) => {
        const base = await desk(root);
        const parts = (page ?? '').split('/').filter((p) => /^[a-z0-9][a-z0-9-]*$/.test(p));
        const url = parts.length === 2 ? `${base}s/${parts[0]}/l/${parts[1]}` : parts.length === 1 ? `${base}s/${parts[0]}` : base;
        void (o.open ?? openWindow)(url);
        return { text: `Opened the desk in the tutor's browser: ${url}. There is nothing for you to check there; tell the tutor what to look at.` };
      }),
  );
  server.registerTool(
    'check_workspace',
    {
      title: 'Check the workspace',
      description: 'Students, roadmap progress, lessons with their status and PDFs, and every file whose format is wrong. Run it after changing student files, and fix what it reports.',
      inputSchema: { student: z.string().optional().describe('A student folder name; omit for all students') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ student }) =>
      within(async (root) => {
        const r = await checkWorkspace(root, student);
        return { ...r, text: `Workspace: ${root}\n${r.text}` };
      }),
  );
  server.registerTool(
    'export_pdf',
    {
      title: 'Export a lesson PDF',
      description: "Typeset a lesson's .tex file with the TutorDesk templates into out/. Refuses until the plan is approved, and until the document compiles with nothing running off the page; it then lists what to fix, with file and line.",
      inputSchema: {
        student: z.string(),
        lesson: z.string().describe('The lesson folder name, e.g. 2026-11-06-task2-position'),
        file: z.string().describe('e.g. handout.tex'),
        edition: z.enum(['student', 'teacher']).optional().describe('teacher adds answers and notes; default student'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (a) => within((root) => exportPdf(root, a)),
  );
  server.registerTool(
    'share_with_parents',
    {
      title: 'Make the parent page',
      description: "Write the student's parent page (one HTML file for a phone) and a calendar file of the weekly lessons into share/. It shows progress, recent lessons with their for_parents line, final writing bands and student handouts; never the tutor's notes. Sends nothing.",
      inputSchema: { student: z.string(), language: z.enum(['en', 'zh']).describe("The family's language") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ student, language }) => within((root) => shareWithParents(root, student, language)),
  );
  return server;
}

export async function serveMcp(version: string, o: ServerOptions = {}): Promise<void> {
  await createServer(version, o).connect(new StdioServerTransport());
}
