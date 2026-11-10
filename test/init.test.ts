import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHome } from '../src/home.ts';
import { setupWorkspace } from '../src/init.ts';
import { exists } from '../src/proc.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'td2-init-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('setting up a workspace', () => {
  it('puts everything the agents need inside the folder, and nothing anywhere else', async () => {
    await setupWorkspace(root, { studio: 'Northbridge' });
    await setupWorkspace(root);
    expect(await readFile(path.join(root, 'tutordesk.yaml'), 'utf8')).toContain('studio: "Northbridge"');
    expect(await exists(path.join(root, '.agents/skills/tutordesk-lesson-prep/SKILL.md'))).toBe(true);
    expect(await exists(path.join(root, '.claude/skills/tutordesk-lesson-materials/examples/handout.tex'))).toBe(true);
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toContain('approves it with a button');
    // No agent configuration files: the tools are passed to each conversation when it starts.
    expect(await exists(path.join(root, '.mcp.json'))).toBe(false);
    expect(await exists(path.join(root, 'opencode.json'))).toBe(false);
    expect((await readHome()).workspace).toBe(root);
  });

  it('keeps an AGENTS.md or CLAUDE.md the tutor wrote, and refreshes its own', async () => {
    await writeFile(path.join(root, 'CLAUDE.md'), 'My own instructions.\n');
    const done = await setupWorkspace(root);
    expect(done).toContain('CLAUDE.md left as it is (not written by TutorDesk)');
    expect(await readFile(path.join(root, 'CLAUDE.md'), 'utf8')).toBe('My own instructions.\n');
    expect(await setupWorkspace(root)).toContain('AGENTS.md');
  });
});
