#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { init } from './init.ts';
import { serveMcp } from './mcp.ts';
import { checkWorkspace } from './tools.ts';

const USAGE = `tutordesk: lesson preparation for one-to-one IELTS and PTE tutors

  tutordesk init [folder]     make a folder a workspace (or refresh one) and connect your agents
  tutordesk open [folder]     open the desk in your browser
  tutordesk check [folder]    list students and lessons, and any file that needs fixing
  tutordesk mcp               the MCP server your agent starts (you never run this yourself)

Options: --studio "Name" --tutor "Name" (init), --no-codex (init: leave Codex alone), --port 4321 and --no-browser (open)`;

const version = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: 'string' },
    studio: { type: 'string' },
    tutor: { type: 'string' },
    'no-codex': { type: 'boolean' },
    port: { type: 'string' },
    'no-browser': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
const [command, folder] = positionals;
const root = path.resolve(values.workspace ?? folder ?? '.');

switch (values.help ? 'help' : command) {
  case 'init':
    for (const line of await init(root, { studio: values.studio, tutor: values.tutor, codex: !values['no-codex'] })) console.log(`  ${line}`);
    console.log(`\n${root} is ready. Open your agent in this folder and describe your first student.`);
    break;
  case 'mcp':
    await serveMcp(root, version);
    break;
  case 'check': {
    const r = await checkWorkspace(root);
    console.log(r.text);
    process.exitCode = r.isError ? 1 : 0;
    break;
  }
  case 'open': {
    const { openDesk } = await import('./desk.ts');
    await openDesk(root, Number(values.port ?? 4321), !values['no-browser']);
    break;
  }
  default:
    console.log(USAGE);
    process.exitCode = command && command !== 'help' ? 1 : 0;
}
