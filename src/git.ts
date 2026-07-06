import * as vscode from 'vscode';

/**
 * Minimal typings for the parts of the built-in Git extension API
 * (`vscode.git`) that GitMate uses. The full type definitions live in the
 * VS Code repository (extensions/git/src/api/git.d.ts); we only declare what
 * we need here so the extension stays dependency-free.
 */

export const enum RefType {
  Head = 0,
  RemoteHead = 1,
  Tag = 2
}

export interface Ref {
  readonly type: RefType;
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}

export interface Branch extends Ref {
  readonly upstream?: { name: string; remote: string };
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly refs: Ref[];
}

export interface InputBox {
  value: string;
}

export interface Repository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: InputBox;
  readonly state: RepositoryState;
  diff(cached?: boolean): Promise<string>;
  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
}

export interface GitAPI {
  readonly repositories: Repository[];
}

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

/** Returns the Git extension API, or undefined if it is unavailable. */
export function getGitAPI(): GitAPI | undefined {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    return undefined;
  }
  if (!extension.isActive) {
    // The extension is declared as a dependency, so by activation time it is
    // already active. Guard anyway for safety.
    return undefined;
  }
  return extension.exports.getAPI(1);
}

/**
 * Resolves the repository a command should act on.
 *
 * When invoked from the SCM title bar, VS Code passes the Git extension's
 * repository object (which carries a `rootUri`). When invoked from the command
 * palette there is no argument, so we fall back to the only repository, or a
 * quick pick when several are open.
 */
export async function pickRepository(api: GitAPI, arg: unknown): Promise<Repository | undefined> {
  const argUri = (arg as { rootUri?: vscode.Uri } | undefined)?.rootUri;
  if (argUri) {
    const match = api.repositories.find((r) => r.rootUri.toString() === argUri.toString());
    if (match) {
      return match;
    }
  }

  if (api.repositories.length === 0) {
    void vscode.window.showErrorMessage('GitMate: no Git repository is open.');
    return undefined;
  }
  if (api.repositories.length === 1) {
    return api.repositories[0];
  }

  const picked = await vscode.window.showQuickPick(
    api.repositories.map((repo) => ({
      label: repoName(repo),
      description: repo.rootUri.fsPath,
      repo
    })),
    { placeHolder: 'Select a repository' }
  );
  return picked?.repo;
}

export function repoName(repo: Repository): string {
  const path = repo.rootUri.fsPath.replace(/[\\/]+$/, '');
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/** Local branch names, sorted with the current HEAD first. */
export function localBranches(repo: Repository): string[] {
  const names = repo.state.refs
    .filter((r) => r.type === RefType.Head && r.name)
    .map((r) => r.name as string);
  return Array.from(new Set(names)).sort();
}

/** Remote branch names like `origin/main`. */
export function remoteBranches(repo: Repository): string[] {
  const names = repo.state.refs
    .filter((r) => r.type === RefType.RemoteHead && r.name)
    .map((r) => r.name as string)
    // `origin/HEAD` is a symbolic pointer, not a real start point.
    .filter((name) => !name.endsWith('/HEAD'));
  return Array.from(new Set(names)).sort();
}

/**
 * Best-effort detection of the repository's default branch: prefer a common
 * default name that exists locally, otherwise the current HEAD, otherwise the
 * first known branch.
 */
export function detectDefaultBranch(repo: Repository): string | undefined {
  const locals = localBranches(repo);
  for (const candidate of ['main', 'master', 'develop', 'trunk']) {
    if (locals.includes(candidate)) {
      return candidate;
    }
  }
  if (repo.state.HEAD?.name) {
    return repo.state.HEAD.name;
  }
  if (locals.length > 0) {
    return locals[0];
  }
  const remotes = remoteBranches(repo);
  return remotes[0];
}

/** Returns the staged diff, falling back to the working-tree diff. */
export async function collectDiff(repo: Repository): Promise<string> {
  const staged = await repo.diff(true);
  if (staged && staged.trim().length > 0) {
    return staged;
  }
  return repo.diff(false);
}

export interface CondensedDiff {
  text: string;
  /** Number of files whose patch body was replaced with a summary. */
  summarizedFiles: number;
}

/**
 * Shrinks a diff to fit within `maxBytes` without losing track of which files
 * changed. The diff is split into per-file patches; whole patches are kept
 * while they fit (smallest first, so one huge lockfile or bundle does not
 * crowd out the real code), and each remaining file is reduced to its header
 * plus a count of added and removed lines.
 */
export function condenseDiff(diff: string, maxBytes: number): CondensedDiff {
  if (byteLength(diff) <= maxBytes) {
    return { text: diff, summarizedFiles: 0 };
  }

  const files = splitDiffByFile(diff);
  const full = files.map((lines) => lines.join('\n'));
  const stubs = files.map((lines) => summarizeFilePatch(lines).join('\n'));

  // Start from the all-stubs form and upgrade files back to their full patch,
  // smallest first, while the budget allows.
  const separators = files.length - 1;
  let size = stubs.reduce((sum, stub) => sum + byteLength(stub), 0) + separators;
  if (size > maxBytes) {
    // Even one line per file does not fit; keep whatever whole lines do.
    return { text: truncateAtLine(diff, maxBytes), summarizedFiles: 0 };
  }

  const keepFull = new Array<boolean>(files.length).fill(false);
  const bySize = full
    .map((text, index) => ({ index, bytes: byteLength(text) }))
    .sort((a, b) => a.bytes - b.bytes);
  for (const { index, bytes } of bySize) {
    const grown = size - byteLength(stubs[index]) + bytes;
    if (grown > maxBytes) {
      break;
    }
    keepFull[index] = true;
    size = grown;
  }

  const summarizedFiles = keepFull.filter((kept) => !kept).length;
  if (summarizedFiles === 0) {
    return { text: diff, summarizedFiles: 0 };
  }
  const text = files.map((_, i) => (keepFull[i] ? full[i] : stubs[i])).join('\n');
  return { text, summarizedFiles };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Splits unified diff output into one group of lines per file. */
function splitDiffByFile(diff: string): string[][] {
  const files: string[][] = [];
  let current: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      files.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    files.push(current);
  }
  return files;
}

/** Reduces one file's patch to its header plus added/removed line counts. */
function summarizeFilePatch(lines: string[]): string[] {
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  if (firstHunk === -1) {
    // No hunks (binary file, rename, mode change): already just a header.
    return lines;
  }
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
    }
  }
  return [
    ...lines.slice(0, firstHunk),
    `[patch body omitted to fit the size limit: ${added} lines added, ${removed} lines removed]`
  ];
}

/** Cuts a diff at a whole-line boundary so it fits within `maxBytes`. */
function truncateAtLine(diff: string, maxBytes: number): string {
  const note = '\n[remaining diff omitted to fit the size limit]';
  const budget = Math.max(0, maxBytes - byteLength(note));
  // Slice as bytes, then drop the last (possibly split) line.
  let text = Buffer.from(diff, 'utf8').subarray(0, budget).toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline > 0) {
    text = text.slice(0, lastNewline);
  }
  return text + note;
}
