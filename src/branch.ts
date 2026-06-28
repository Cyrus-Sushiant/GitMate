import * as vscode from 'vscode';
import {
  Repository,
  collectDiff,
  detectDefaultBranch,
  localBranches,
  remoteBranches
} from './git';
import { PROVIDERS, resolveActiveConfig } from './config';
import { suggestBranchName } from './providers';

/**
 * Validates a branch name against the subset of `git check-ref-format` rules
 * that matter most. Returns an error string, or undefined when valid.
 */
export function validateBranchName(name: string): string | undefined {
  if (!name || name.trim().length === 0) {
    return 'Branch name is required.';
  }
  if (name !== name.trim()) {
    return 'Branch name cannot start or end with whitespace.';
  }
  if (/\s/.test(name)) {
    return 'Branch name cannot contain spaces.';
  }
  if (/[~^:?*\[\\]/.test(name)) {
    return 'Branch name cannot contain any of: ~ ^ : ? * [ \\';
  }
  if (name.includes('..')) {
    return 'Branch name cannot contain "..".';
  }
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return 'Branch name cannot start or end with "/" or contain "//".';
  }
  if (name.startsWith('.') || name.endsWith('.')) {
    return 'Branch name cannot start or end with ".".';
  }
  if (name.endsWith('.lock')) {
    return 'Branch name cannot end with ".lock".';
  }
  if (name === '@') {
    return 'Branch name cannot be "@".';
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) {
    return 'Branch name cannot contain control characters.';
  }
  return undefined;
}

/**
 * Runs the create-branch flow as a sequence of native quick inputs, which
 * overlay the editor like a modal rather than opening a page.
 *
 * If the working tree has changes, the suggested name is built from the diff.
 * Otherwise GitMate asks for a short description of the task and names the
 * branch from that. The suggestion is always shown in an editable field.
 */
export async function openCreateBranchModal(
  context: vscode.ExtensionContext,
  repo: Repository
): Promise<void> {
  let diff = '';
  try {
    diff = await collectDiff(repo);
  } catch {
    diff = '';
  }
  const hasChanges = diff.trim().length > 0;

  let description = '';
  if (!hasChanges) {
    const input = await vscode.window.showInputBox({
      title: 'Create branch',
      prompt: 'There are no changes yet. Describe what this branch is for, and GitMate will suggest a name.',
      placeHolder: 'e.g. add a password reset flow',
      ignoreFocusOut: true
    });
    if (input === undefined) {
      return;
    }
    description = input.trim();
  }

  // Pick the base branch, unless the repo has no branches yet.
  let base: string | undefined;
  if (localBranches(repo).length > 0 || remoteBranches(repo).length > 0) {
    const picked = await pickBaseBranch(repo);
    if (picked === undefined) {
      return;
    }
    base = picked;
  }

  // Suggest a name, with the model when one is configured.
  const config = await resolveActiveConfig(context);
  const canUseModel =
    Boolean(config.model) && (!PROVIDERS[config.provider].needsKey || Boolean(config.apiKey));

  let suggestion = '';
  if (canUseModel && (hasChanges || description)) {
    try {
      suggestion = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GitMate: suggesting a branch name...' },
        () =>
          suggestBranchName({
            config,
            diff: hasChanges ? diff : undefined,
            description: description || undefined
          })
      );
    } catch {
      suggestion = '';
    }
  }
  suggestion = sanitizeBranchName(suggestion) || fallbackName(description, diff);

  // Let the user review and edit the name. Enter creates the branch.
  const existing = new Set(localBranches(repo));
  const name = await vscode.window.showInputBox({
    title: base ? `Create branch from ${base}` : 'Create branch',
    value: suggestion,
    prompt: 'Review the name, edit it if you like, then press Enter to create the branch.',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      const problem = validateBranchName(trimmed);
      if (problem) {
        return problem;
      }
      if (existing.has(trimmed)) {
        return `A branch named "${trimmed}" already exists.`;
      }
      return undefined;
    }
  });
  if (name === undefined) {
    return;
  }
  const finalName = name.trim();

  try {
    await repo.createBranch(finalName, true, base);
    void vscode.window.showInformationMessage(
      base
        ? `GitMate: created and checked out "${finalName}" from "${base}".`
        : `GitMate: created and checked out "${finalName}".`
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`GitMate: ${describe(err)}`);
  }
}

/** Quick pick for the base branch, with the default branch listed first. */
async function pickBaseBranch(repo: Repository): Promise<string | undefined> {
  const def = detectDefaultBranch(repo);
  const locals = localBranches(repo);
  const remotes = remoteBranches(repo);

  type Item = vscode.QuickPickItem & { branch?: string };
  const items: Item[] = [];

  const localsOrdered = [def, ...locals.filter((b) => b !== def)].filter(
    (b): b is string => Boolean(b)
  );
  if (localsOrdered.length > 0) {
    items.push({ label: 'Local', kind: vscode.QuickPickItemKind.Separator });
    for (const b of localsOrdered) {
      items.push({ label: b, description: b === def ? 'default' : undefined, branch: b });
    }
  }
  if (remotes.length > 0) {
    items.push({ label: 'Remote', kind: vscode.QuickPickItemKind.Separator });
    for (const b of remotes) {
      items.push({ label: b, branch: b });
    }
  }

  const picked = (await vscode.window.showQuickPick(items, {
    title: 'Create branch from',
    placeHolder: 'Choose the base branch (the default is at the top)'
  })) as Item | undefined;
  return picked?.branch;
}

/** A reasonable name when no model is available or the call fails. */
function fallbackName(description: string, diff: string): string {
  if (description) {
    return 'feature/' + slug(description);
  }
  const file = firstChangedFile(diff);
  if (file) {
    return 'update/' + slug(file);
  }
  return 'new-branch';
}

function firstChangedFile(diff: string): string | undefined {
  const match = diff.match(/^diff --git a\/(\S+) b\//m);
  if (!match) {
    return undefined;
  }
  const segments = match[1].split('/');
  return segments[segments.length - 1];
}

function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const words = cleaned.split('-').filter(Boolean).slice(0, 6).join('-');
  return words || 'branch';
}

/** Cleans a model suggestion into a valid, tidy branch name. */
function sanitizeBranchName(raw: string): string {
  let name = (raw || '').split('\n')[0].trim();
  name = name.replace(/^["'`]+|["'`]+$/g, '');
  name = name.replace(/\s+/g, '-');
  name = name.replace(/[^a-zA-Z0-9._/-]/g, '-');
  name = name.replace(/-{2,}/g, '-').replace(/\/{2,}/g, '/');
  name = name.replace(/^[-./]+|[-./]+$/g, '');
  return name;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
