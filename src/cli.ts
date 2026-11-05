#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openBrowser, startDesk } from './desk.ts';
import { findWorkspace } from './home.ts';
import { init } from './init.ts';
import { install, needsInstall, uninstall } from './install.ts';
import { serveMcp } from './mcp.ts';
import { SEA, VERSION } from './paths.ts';
import { checkWorkspace } from './tools.ts';

const USAGE = `TutorDesk ${VERSION}: lesson preparation for one-to-one IELTS and PTE tutors

Tutors double-click the program once; after that, the desktop shortcut opens the desk, and their
agent (Codex, Claude Code, OpenCode) does the rest. These commands are for setting up and fixing:

  tutordesk install           connect the agents on this computer, the PDF engine, a workspace, the shortcut
  tutordesk uninstall         undo install (student files stay)
  tutordesk open [folder]     open the desk
  tutordesk check [folder]    list students and lessons, and any file that needs fixing
  tutordesk init <folder>     development: a workspace that carries its own skills and agent config
  tutordesk mcp               the MCP server agents start (never run by hand)

Options: --studio, --tutor, --no-codex (init); --port, --no-browser (open)`;

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
async function main(): Promise<void> {
  const [given, folder] = positionals;
  // Double-clicked: install the first time (or after an update), then open the desk.
  const command = given ?? (SEA ? ((await needsInstall()) ? 'install' : 'open') : 'help');

  async function openDesk(root: string | null): Promise<void> {
    if (!root) {
      console.error('No TutorDesk workspace yet. Run `tutordesk install`, or open your agent and describe your first student.');
      process.exitCode = 1;
      return;
    }
    const url = await startDesk(root, { port: values.port ? Number(values.port) : undefined });
    console.log(`TutorDesk desk: ${url}  (keep this window open while you use it)`);
    if (!values['no-browser']) openBrowser(url);
  }

  switch (values.help ? 'help' : command) {
    case 'install': {
      const workspace = await install();
      console.log(`\nTutorDesk is ready. Open your agent (Codex, Claude Code or OpenCode) and say hello to your first student.`);
      await openDesk(workspace);
      break;
    }
    case 'uninstall':
      await uninstall();
      break;
    case 'open':
      await openDesk(await findWorkspace(folder ?? values.workspace));
      break;
    case 'check': {
      const root = await findWorkspace(folder ?? values.workspace);
      if (!root) {
        console.error('No TutorDesk workspace here.');
        process.exitCode = 1;
        break;
      }
      const r = await checkWorkspace(root);
      console.log(r.text);
      process.exitCode = r.isError ? 1 : 0;
      break;
    }
    case 'init': {
      if (!folder) {
        console.error('init needs a folder.');
        process.exitCode = 1;
        break;
      }
      const root = path.resolve(folder);
      for (const line of await init(root, { studio: values.studio, tutor: values.tutor, codex: !values['no-codex'] })) console.log(`  ${line}`);
      console.log(`\n${root} is ready. Open your agent in this folder and describe your first student.`);
      break;
    }
    case 'mcp':
      await serveMcp(VERSION, { workspace: values.workspace });
      break;
    default:
      console.log(USAGE);
      process.exitCode = given && given !== 'help' ? 1 : 0;
  }
}

main().catch(async (e: unknown) => {
  console.error((e as Error).message);
  process.exitCode = 1;
  // Double-clicked: the window would close before the tutor could read what went wrong.
  if (SEA && !positionals.length) {
    console.error('\nPress Enter to close.');
    await new Promise((r) => process.stdin.once('data', r));
  }
});
