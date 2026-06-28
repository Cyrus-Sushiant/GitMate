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
