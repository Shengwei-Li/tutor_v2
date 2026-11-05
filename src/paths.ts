import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { tutordeskHome } from './home.ts';

/**
 * Where TutorDesk's own files are. Run from the repository: next to src/. As the single-file program:
 * `tutordesk install` unpacks skills and templates into ~/.tutordesk/app and the program into
 * ~/.tutordesk/bin.
 */
export const SEA = isSea();
export const VERSION: string = pkg.version;

const APP = SEA ? path.join(tutordeskHome(), 'app') : fileURLToPath(new URL('..', import.meta.url));
export const SKILLS = path.join(APP, 'skills');
export const TEMPLATES = path.join(APP, 'templates', 'tex');

export const installedBinary = () => path.join(tutordeskHome(), 'bin', process.platform === 'win32' ? 'tutordesk.exe' : 'tutordesk');

/** How to run this program again: the installed binary, or Node with the CLI script in development. */
export function selfCommand(): { command: string; args: string[] } {
  return SEA ? { command: installedBinary(), args: [] } : { command: process.execPath, args: [fileURLToPath(new URL('./cli.ts', import.meta.url))] };
}
