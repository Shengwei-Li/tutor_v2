#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startDesk, startDetachedDesk } from './desk.ts';
import { findWorkspace } from './home.ts';
import { connectAgents, disconnectAgents, setupWorkspace } from './init.ts';
import { install, needsInstall, uninstall } from './install.ts';
import { serveMcp } from './mcp.ts';
import { SEA, VERSION } from './paths.ts';
import { checkWorkspace } from './tools.ts';
import { focusWindow, openWindow } from './window.ts';

const USAGE = `TutorDesk ${VERSION}: lesson preparation for one-to-one IELTS and PTE tutors

Tutors double-click the program once; after that the desktop shortcut opens the desk, where they talk
to the agent already signed in on this computer (Codex, Claude Code or OpenCode). For setting up and fixing:

  tutordesk install           the PDF engine, a workspace in Documents, the desktop shortcut
  tutordesk uninstall         undo install (student files stay)
  tutordesk open [folder]     open the desk
  tutordesk check [folder]    list students and lessons, and any file that needs fixing
  tutordesk init <folder>     make a folder a workspace
  tutordesk connect           optional: also use TutorDesk from your own agent (adds its skills and tools to
                              Codex, Claude Code and OpenCode); tutordesk disconnect removes them again
  tutordesk mcp               the tool server agents start (never run by hand)

Options: --studio, --tutor (init); --port, --no-browser, --foreground (open: keep the desk in this window)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: 'string' },
    studio: { type: 'string' },
    tutor: { type: 'string' },
    port: { type: 'string' },
    'no-browser': { type: 'boolean' },
    foreground: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

async function main(): Promise<void> {
  const [given, folder] = positionals;
  // Double-clicked: install the first time (or after an update), then open the desk.
  const command = given ?? (SEA ? ((await needsInstall()) ? 'install' : 'open') : 'help');
  const port = values.port ? Number(values.port) : undefined;

  async function openDesk(root: string | null): Promise<void> {
    if (!root) throw new Error('No TutorDesk workspace yet. Run `tutordesk install` first.');
    // Normally the desk runs on its own, without a window; --foreground keeps it here (development).
    const url = values.foreground ? await startDesk(root, { port }) : await startDetachedDesk(root, port);
    console.log(`TutorDesk desk: ${url}${values.foreground ? '  (Ctrl+C to stop)' : ''}`);
    if (values['no-browser']) return;
    // Double-clicked again: the window already open comes to the front instead of a second one.
    const pages = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json() as Promise<{ pages?: number }>)
      .then((h) => h.pages ?? 0, () => 0);
    if (!(pages > 0 && (await focusWindow()))) await openWindow(url);
  }

  switch (values.help ? 'help' : command) {
    case 'install': {
      await openDesk(await install());
      console.log('\nTutorDesk is ready: describe your first student in the conversation on the desk.');
      // Double-clicked: leave the message up long enough to read, then close the window.
      if (SEA && !given) {
        console.log('This window closes in 15 seconds.');
        await new Promise((r) => setTimeout(r, 15_000));
      }
      break;
    }
    case 'desk':
      // The background desk process startDetachedDesk starts; it quits after 30 minutes with no page open.
      if (!folder) throw new Error('desk needs a workspace folder.');
      await startDesk(path.resolve(folder), { port, idleExitMs: 30 * 60_000 });
      break;
    case 'uninstall':
      await uninstall();
      break;
    case 'open':
      await openDesk(await findWorkspace(folder ?? values.workspace));
      break;
    case 'check': {
      const root = await findWorkspace(folder ?? values.workspace);
      if (!root) throw new Error('No TutorDesk workspace here.');
      const r = await checkWorkspace(root);
      console.log(r.text);
      process.exitCode = r.isError ? 1 : 0;
      break;
    }
    case 'init':
      if (!folder) throw new Error('init needs a folder.');
      for (const line of await setupWorkspace(path.resolve(folder), { studio: values.studio, tutor: values.tutor })) console.log(`  ${line}`);
      break;
    case 'connect':
      for (const line of await connectAgents()) console.log(`Connected ${line}`);
      break;
    case 'disconnect':
      for (const line of await disconnectAgents()) console.log(`Disconnected ${line}`);
      break;
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
