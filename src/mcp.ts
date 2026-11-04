import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkWorkspace, exportPdf, shareWithParents, type ToolResult } from './tools.ts';

const INSTRUCTIONS = `TutorDesk: a private IELTS/PTE tutor's workspace of plain files (see AGENTS.md).
You read and write the student files yourself. These tools do what files cannot: check the workspace, turn lesson .tex files into PDFs once the tutor has approved the plan, and make the parent page.`;

const reply = (r: ToolResult) => ({ content: [{ type: 'text' as const, text: r.text }], isError: r.isError });

export function createServer(root: string, version: string): McpServer {
  const server = new McpServer({ name: 'tutordesk', version }, { instructions: INSTRUCTIONS });
  server.registerTool(
    'check_workspace',
    {
      title: 'Check the workspace',
      description: 'Students, roadmap progress, lessons with their status and PDFs, and every file whose format is wrong. Run it after changing student files, and fix what it reports.',
      inputSchema: { student: z.string().optional().describe('A student folder name; omit for all students') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ student }) => reply(await checkWorkspace(root, student)),
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
    async (a) => reply(await exportPdf(root, a)),
  );
  server.registerTool(
    'share_with_parents',
    {
      title: 'Make the parent page',
      description: "Write the student's parent page (one HTML file for a phone) and a calendar file of the weekly lessons into share/. It shows progress, recent lessons with their for_parents line, final writing bands and student handouts; never the tutor's notes. Sends nothing.",
      inputSchema: { student: z.string(), language: z.enum(['en', 'zh']).describe("The family's language") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ student, language }) => reply(await shareWithParents(root, student, language)),
  );
  return server;
}

export async function serveMcp(root: string, version: string): Promise<void> {
  await createServer(root, version).connect(new StdioServerTransport());
}
