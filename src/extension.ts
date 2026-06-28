import * as vscode from 'vscode';
import { collectDiff, getGitAPI, pickRepository } from './git';
import { generateCommitMessage } from './providers';
import { openCreateBranchModal } from './branch';
import { GitMateViewProvider } from './panel';
import { PROVIDERS, resolveActiveConfig } from './config';

export function activate(context: vscode.ExtensionContext): void {
  const viewProvider = new GitMateViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GitMateViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('gitmate.generateCommitMessage', (arg) =>
      runGenerateCommitMessage(context, arg)
    ),
    vscode.commands.registerCommand('gitmate.createBranch', (arg) =>
      runCreateBranch(context, arg)
    ),
    vscode.commands.registerCommand('gitmate.openSettings', () => viewProvider.showSettings()),
    vscode.commands.registerCommand('gitmate.openChat', () =>
      vscode.commands.executeCommand('gitmate.chatView.focus')
    ),
    vscode.commands.registerCommand('gitmate.newChat', () => viewProvider.newChat())
  );
}

export function deactivate(): void {
  // Nothing to clean up.
}

async function runGenerateCommitMessage(
  context: vscode.ExtensionContext,
  arg: unknown
): Promise<void> {
  const api = getGitAPI();
  if (!api) {
    void vscode.window.showErrorMessage('GitMate: the Git extension is not available.');
    return;
  }

  const repo = await pickRepository(api, arg);
  if (!repo) {
    return;
  }

  let diff: string;
  try {
    diff = await collectDiff(repo);
  } catch (err) {
    void vscode.window.showErrorMessage(`GitMate: could not read the diff (${describe(err)}).`);
    return;
  }

  if (!diff || diff.trim().length === 0) {
    void vscode.window.showInformationMessage(
      'GitMate: no staged or unstaged changes to summarize.'
    );
    return;
  }

  const llmConfig = await resolveActiveConfig(context);
  if (PROVIDERS[llmConfig.provider].needsKey && !llmConfig.apiKey) {
    const choice = await vscode.window.showErrorMessage(
      `GitMate: no API key configured for "${PROVIDERS[llmConfig.provider].label}".`,
      'Open Settings'
    );
    if (choice === 'Open Settings') {
      void vscode.commands.executeCommand('gitmate.openSettings');
    }
    return;
  }

  const config = vscode.workspace.getConfiguration('gitmate');
  const instructions = config.get<string>('commitMessageInstructions', '');
  const maxDiffBytes = config.get<number>('maxDiffBytes', 100000);

  if (Buffer.byteLength(diff, 'utf8') > maxDiffBytes) {
    diff = diff.slice(0, maxDiffBytes);
    void vscode.window.showWarningMessage(
      `GitMate: the diff is larger than ${maxDiffBytes} bytes and was truncated before sending to the model.`
    );
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.SourceControl, title: 'GitMate: generating commit message...' },
    async () => {
      try {
        const message = await generateCommitMessage({ config: llmConfig, diff, instructions });
        repo.inputBox.value = message;
      } catch (err) {
        void vscode.window.showErrorMessage(`GitMate: ${describe(err)}`);
      }
    }
  );
}

async function runCreateBranch(context: vscode.ExtensionContext, arg: unknown): Promise<void> {
  const api = getGitAPI();
  if (!api) {
    void vscode.window.showErrorMessage('GitMate: the Git extension is not available.');
    return;
  }
  const repo = await pickRepository(api, arg);
  if (!repo) {
    return;
  }
  openCreateBranchModal(context, repo);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
