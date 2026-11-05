import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tutordeskHome } from './home.ts';
import { TEMPLATES } from './paths.ts';
import { exists, run, which, type RunResult } from './proc.ts';


/** The LaTeX classes, themes and fonts every document is set with. */
export { TEMPLATES };

export interface Engine {
  kind: 'tectonic' | 'xelatex';
  binary: string;
  /** Tectonic only: the offline package cache. */
  cacheDir?: string;
}

/** Where `tutordesk setup` puts Tectonic and its cache. TUTORDESK_TECTONIC points elsewhere. */
export function tectonicHome(): string {
  return process.env.TUTORDESK_TECTONIC ?? path.join(tutordeskHome(), 'tectonic');
}

/**
 * Tectonic from `tutordesk setup` when it is there: its package set is pinned, so a PDF comes out the
 * same on every computer. Otherwise the tutor's own XeLaTeX.
 */
export async function findEngine(): Promise<Engine | null> {
  const home = tectonicHome();
  const binary = path.join(home, 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'tectonic.exe' : 'tectonic');
  if (await exists(binary)) return { kind: 'tectonic', binary, cacheDir: path.join(home, 'cache') };
  const xelatex = await which('xelatex');
  return xelatex ? { kind: 'xelatex', binary: xelatex } : null;
}

export type Edition = 'student' | 'teacher';

export interface TexError {
  severity: 'error' | 'warning' | 'overfull';
  message: string;
  file?: string;
  line?: number;
  context?: string;
}

export interface CompileResult {
  ok: boolean;
  /** The PDF in the lesson's out/ folder, when it compiled. */
  pdf?: string;
  errors: TexError[];
  engine: Engine['kind'];
}

/**
 * Compile one .tex file of a lesson folder. The folder's other .tex files can be \input; the PDF lands
 * in out/<name>.pdf, or out/<name>-teacher.pdf for the edition with answers and notes.
 */
export async function compile(texFile: string, edition: Edition = 'student', opts: { timeoutMs?: number; engine?: Engine; /** Tectonic may fetch packages (setup only). */ online?: boolean } = {}): Promise<CompileResult> {
  const engine = opts.engine ?? (await findEngine());
  if (!engine) return { ok: false, engine: 'xelatex', errors: [{ severity: 'error', message: 'No TeX engine. Run `tutordesk setup` once to install one.' }] };
  const dir = path.dirname(texFile);
  const name = path.basename(texFile, '.tex');
  const build = await mkdtemp(path.join(os.tmpdir(), 'tutordesk-tex-'));
  try {
    await stage(dir, build);
    const job = 'main';
    // Teacher edition: \TDmode is set before the document loads. Tectonic takes no code on its command
    // line, so a two-line wrapper does it.
    const pretex = edition === 'teacher' ? '\\def\\TDmode{teacher}' : '';
    await copyFile(texFile, path.join(build, `${name}.tex`));
    await writeFile(path.join(build, `${job}.tex`), `${pretex}\\input{${name}.tex}\n`, 'utf8');
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const env: NodeJS.ProcessEnv = { ...process.env, openout_any: 'p', openin_any: 'p', TEXMFHOME: path.join(build, '.none'), max_print_line: '10000' };
    let r: RunResult = { code: null, output: '', timedOut: false };
    if (engine.kind === 'tectonic') {
      r = await run(engine.binary, ['-X', 'compile', `${job}.tex`, '--untrusted', ...(opts.online ? [] : ['--only-cached']), '--keep-logs'], { cwd: build, env: { ...env, TECTONIC_CACHE_DIR: engine.cacheDir }, timeoutMs });
    } else {
      // Rerun while cross-references settle, as latexmk would, all within one time budget.
      const deadline = Date.now() + timeoutMs;
      for (let pass = 0; pass < 3; pass++) {
        r = await run(engine.binary, ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-no-shell-escape', `${job}.tex`], { cwd: build, env, timeoutMs: Math.max(1000, deadline - Date.now()) });
        const log = await readFile(path.join(build, `${job}.log`), 'utf8').catch(() => '');
        if (r.code !== 0 || r.timedOut || !/Rerun to get|Label\(s\) may have changed|rerunfilecheck/.test(log)) break;
      }
    }
    const log = await readFile(path.join(build, `${job}.log`), 'utf8').catch(() => r.output);
    // Without a file name (Tectonic's `!` errors), a line number is in the document being compiled.
    const errors = parseLog(log).map((e) => (e.line !== undefined && !e.file ? { ...e, file: `${name}.tex` } : e));
    if (r.timedOut) errors.unshift({ severity: 'error', message: `Stopped after ${Math.round(timeoutMs / 1000)} s: the document may loop.` });
    const built = path.join(build, `${job}.pdf`);
    const ok = r.code === 0 && !r.timedOut && (await exists(built)) && !errors.some((e) => e.severity === 'error');
    if (!ok && !errors.some((e) => e.severity === 'error')) errors.push({ severity: 'error', message: `TeX stopped (exit ${r.code})`, context: r.output.slice(-400) });
    if (!ok) return { ok, errors, engine: engine.kind };
    const pdf = path.join(dir, 'out', edition === 'teacher' ? `${name}-teacher.pdf` : `${name}.pdf`);
    await mkdir(path.dirname(pdf), { recursive: true });
    await copyFile(built, pdf);
    return { ok, pdf, errors, engine: engine.kind };
  } finally {
    await rm(build, { recursive: true, force: true }).catch(() => {});
  }
}

/** The lesson's .tex files, the templates, and fonts/ (linked, not copied: it is large). */
async function stage(lessonDir: string, build: string): Promise<void> {
  // Regular files only: a link named handout.tex could point anywhere on the computer.
  for (const d of await readdir(lessonDir, { withFileTypes: true })) if (d.isFile() && d.name.endsWith('.tex')) await copyFile(path.join(lessonDir, d.name), path.join(build, d.name));
  for (const f of await readdir(TEMPLATES)) if (/\.(cls|sty)$/.test(f)) await copyFile(path.join(TEMPLATES, f), path.join(build, f));
  const fonts = path.join(TEMPLATES, 'fonts');
  try {
    await symlink(fonts, path.join(build, 'fonts'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    await mkdir(path.join(build, 'fonts'));
    for (const f of await readdir(fonts)) if (/\.(otf|ttf)$/.test(f)) await copyFile(path.join(fonts, f), path.join(build, 'fonts', f));
  }
}

/** Commands that read a file; reading \input{...} arguments is how a document pulls in other files. */
const READS = /\\(?:input|include|InputIfFileExists|IfFileExists|includegraphics|includepdf|verbatiminput|lstinputlisting|import|subimport|openin|read|readline|directlua|immediate)(?![A-Za-z])\*?\s*(?:\[[^\]]*\]\s*)?(\{[^}]*\}|\S+)/g;

/**
 * Files a document reaches outside its lesson folder: absolute paths, drive letters, `..`, or the raw
 * file primitives. XeLaTeX refuses these itself (openin_any=p); Tectonic's --untrusted does not, and
 * a PDF that quotes another file could end up in front of a parent. Returns what to remove.
 */
export function outsideReads(tex: string): string[] {
  const out: string[] = [];
  const body = tex.replace(/(^|[^\\])%.*$/gm, '$1');
  for (const m of body.matchAll(READS)) {
    const cmd = /^\\[A-Za-z]+/.exec(m[0])![0];
    const arg = m[1]!.replace(/^\{|\}$/g, '');
    if (/^\\(openin|read|readline|directlua|immediate)$/.test(cmd) || /^[\\/]|^[a-zA-Z]:|\.\.|^~/.test(arg)) out.push(m[0].slice(0, 80));
  }
  return out;
}

/**
 * Errors with file and line (-file-line-error), fatal `!` errors, glyphs the font lacks (they print as
 * empty boxes), overfull boxes (text running off the page) and LaTeX warnings.
 */
export function parseLog(log: string): TexError[] {
  const lines = log.split(/\r?\n/);
  const out: TexError[] = [];
  const seen = new Set<string>();
  const push = (e: TexError) => {
    const key = `${e.severity}|${e.file}|${e.line}|${e.message}`;
    if (!seen.has(key)) out.push(e), seen.add(key);
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const fle = /^(?:\.\/)?([^:\s][^:]*\.(?:tex|sty|cls)):(\d+): (.*)$/.exec(l);
    if (fle) {
      const ctx = lines.slice(i + 1, i + 4).find((x) => /^l\.\d+/.test(x));
      push({ severity: 'error', file: fle[1]!.replace(/\\/g, '/'), line: Number(fle[2]), message: fle[3]!.trim(), context: ctx?.replace(/^l\.\d+\s*/, '') });
      continue;
    }
    if (l.startsWith('! ')) {
      const at = lines.slice(i + 1, i + 12).map((x) => /^l\.(\d+)\s*(.*)$/.exec(x)).find(Boolean);
      push({ severity: 'error', message: l.slice(2).trim(), line: at ? Number(at[1]) : undefined, context: at?.[2] });
      continue;
    }
    const missing = /^Missing character: There is no (\S+) \((U\+[0-9A-F]+)\)/.exec(l);
    if (missing) {
      push({ severity: 'error', message: `The font has no "${missing[1]}" (${missing[2]}); it would print as an empty box.` });
      continue;
    }
    const box = /^Overfull \\[hv]box \((.+?)\)(?:.*?at lines? (\d+))?/.exec(l);
    if (box) {
      push({ severity: 'overfull', message: `Text runs past the margin (${box[1]})`, line: box[2] ? Number(box[2]) : undefined });
      continue;
    }
    const warn = /^(?:LaTeX|Package \S+) Warning: (.*)$/.exec(l);
    if (warn) push({ severity: 'warning', message: warn[1]!.trim() });
  }
  return out;
}
