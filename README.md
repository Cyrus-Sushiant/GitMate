# GitMate

GitMate is a git sidekick for VS Code. It puts a chat with your model right in the sidebar, writes commit messages from your diff, and creates branches through a quick dialog. Bring your own model, cloud or local.

## What you get

- **A chat panel** in the activity bar (its own GitMate icon). It is just the chat: ask your model anything, with replies that stream in as they are written and a Stop button to cut one short. The input sits at the bottom with a provider picker and a send button, in the style of Copilot Chat.
- **Settings**, reached from the gear in the panel's toolbar. It opens over the chat with two tabs:
  - **Settings**: pick a provider, set the model and base URL, and store your API key. The key lives in the VS Code secret store, not in a settings file.
  - **About**: what GitMate is and what it does.
  A back arrow returns you to the chat.
- **Generate Commit Message** button in the Source Control title bar: sends your diff to the model and drops a commit message into the message box.
- **Create Branch** button in the Source Control title bar: a small dialog with a base-branch picker and a live preview of the branch that will be made.

## Providers

GitMate speaks to a range of services. Most of them use the OpenAI chat format under the hood, so adding your own is usually just a base URL away.

| Provider | Type | Needs key |
| --- | --- | --- |
| Anthropic Claude | cloud | yes |
| OpenAI | cloud | yes |
| OpenRouter | cloud | yes |
| Groq | cloud | yes |
| Together AI | cloud | yes |
| DeepSeek | cloud | yes |
| Mistral | cloud | yes |
| Google Gemini | cloud | yes |
| LM Studio | local | no |
| Ollama | local | no |
| Custom OpenAI-compatible | either | optional |

Each provider remembers its own model and base URL. Use **Test connection** to check your setup, and **Fetch models** to list what an endpoint offers (or what you have pulled locally).

## How it works

### Chat
The chat tab sends your conversation to the active provider and streams the reply back into the panel. Anthropic uses the official SDK; OpenAI-style services and Ollama are called over their streaming HTTP APIs.

### Generate Commit Message
- Reads the **staged** diff, and falls back to the working-tree diff when nothing is staged.
- Sends it to the active provider with a short prompt.
- Writes the result into the Source Control message box.
- If the active provider needs a key and none is set, it points you to the Settings tab.

### Create Branch
- Opens a dialog with a base-branch picker (local and remote branches, default branch preselected), a name field, a live preview, and inline validation.
- Creates and checks out the branch from the chosen base.

## Setup

1. `npm install`
2. Press **F5** (Run GitMate) to launch an Extension Development Host, or run `npm run compile` and package with `vsce package`.
3. Click the **GitMate icon** in the activity bar, open the **Settings** tab, pick a provider, fill in the fields, run **Test connection**, then **Save**.

## Settings reference

| Setting | Default | Description |
| --- | --- | --- |
| `gitmate.activeProvider` | `anthropic` | Which provider GitMate uses. |
| `gitmate.providers` | empty | Per-provider model and base URL. Blank entries fall back to defaults. |
| `gitmate.commitMessageInstructions` | Conventional Commits prompt | Extra instructions added to the commit prompt. |
| `gitmate.maxDiffBytes` | `100000` | Diff size cap. Larger diffs are truncated with a warning. |

API keys are never stored in settings. They live in the VS Code secret store, set from the Settings tab.

## Notes
- The Source Control buttons appear when a Git repository is open (`scmProvider == git`).
- GitMate depends on the built-in `vscode.git` extension and uses its public API.
- Cloud providers and local servers are called with the `fetch` built into the VS Code runtime; Anthropic uses `@anthropic-ai/sdk`.
