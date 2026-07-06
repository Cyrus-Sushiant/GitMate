import * as vscode from 'vscode';
import {
  DEFAULT_MAX_DIFF_BYTES,
  PROVIDERS,
  PROVIDER_IDS,
  ProviderId,
  getActiveProvider,
  getMaxDiffBytes,
  getProviderSettings,
  getRequestTimeoutMs,
  hasApiKey,
  resolveActiveConfig,
  setActiveProvider,
  setMaxDiffBytes,
  setProviderSettings,
  setApiKey
} from './config';
import { ChatTurn, listModels, streamChat, testConnection } from './providers';

interface ProviderFormValues {
  model: string;
  baseUrl: string;
  requestTimeoutMs?: number;
  contextWindow?: number;
}

interface SaveMessage {
  type: 'save';
  activeProvider: ProviderId;
  providers: Record<ProviderId, ProviderFormValues>;
  keys: Partial<Record<ProviderId, string>>;
  /** Diff size cap in bytes; undefined resets to the default. */
  maxDiffBytes?: number;
}

interface TestMessage {
  type: 'test';
  provider: ProviderId;
  model: string;
  baseUrl: string;
  key?: string;
  requestTimeoutMs?: number;
  contextWindow?: number;
}

interface FetchModelsMessage {
  type: 'fetchModels';
  provider: ProviderId;
  model: string;
  baseUrl: string;
  key?: string;
  requestTimeoutMs?: number;
  contextWindow?: number;
}

interface ChatMessage {
  type: 'chat';
  messages: ChatTurn[];
}

type Incoming =
  | { type: 'ready' }
  | SaveMessage
  | TestMessage
  | FetchModelsMessage
  | ChatMessage
  | { type: 'pickModel' }
  | { type: 'chatStop' };

/** Hosts the GitMate sidebar: a chat view with a settings screen behind it. */
export class GitMateViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gitmate.chatView';

  private view?: vscode.WebviewView;
  private chatAbort?: AbortController;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    webviewView.webview.html = renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: Incoming) => this.onMessage(message),
      undefined,
      this.context.subscriptions
    );
  }

  /** Reveals the view and switches it to the Settings screen. */
  public async showSettings(): Promise<void> {
    await vscode.commands.executeCommand('gitmate.chatView.focus');
    this.post({ type: 'showSettings' });
  }

  /** Clears the current conversation and returns to the chat screen. */
  public newChat(): void {
    this.post({ type: 'newChat' });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private async onMessage(message: Incoming): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.sendState();
        break;
      case 'save':
        await this.handleSave(message);
        break;
      case 'test':
        await this.handleTest(message);
        break;
      case 'fetchModels':
        await this.handleFetchModels(message);
        break;
      case 'pickModel':
        await this.handlePickModel();
        break;
      case 'chat':
        await this.handleChat(message);
        break;
      case 'chatStop':
        this.chatAbort?.abort();
        break;
    }
  }

  private async sendState(): Promise<void> {
    const providers: Record<string, unknown> = {};
    for (const id of PROVIDER_IDS) {
      const meta = PROVIDERS[id];
      const settings = getProviderSettings(id);
      providers[id] = {
        label: meta.label,
        kind: meta.kind,
        needsKey: meta.needsKey,
        usesBaseUrl: meta.usesBaseUrl,
        local: meta.local,
        modelHint: meta.modelHint,
        defaults: meta.defaults,
        model: settings.model,
        baseUrl: settings.baseUrl,
        requestTimeoutMs: settings.requestTimeoutMs,
        contextWindow: settings.contextWindow,
        defaultTimeoutMs: getRequestTimeoutMs(),
        hasKey: meta.needsKey ? await hasApiKey(this.context, id) : false
      };
    }
    this.post({
      type: 'state',
      activeProvider: getActiveProvider(),
      providers,
      maxDiffBytes: getMaxDiffBytes(),
      defaultMaxDiffBytes: DEFAULT_MAX_DIFF_BYTES
    });
  }

  private async handleSave(message: SaveMessage): Promise<void> {
    try {
      for (const id of PROVIDER_IDS) {
        const incoming = message.providers[id];
        if (incoming) {
          await setProviderSettings(id, {
            model: incoming.model,
            baseUrl: incoming.baseUrl,
            requestTimeoutMs: incoming.requestTimeoutMs,
            contextWindow: incoming.contextWindow
          });
        }
        const key = message.keys[id];
        if (key !== undefined) {
          await setApiKey(this.context, id, key.length > 0 ? key : undefined);
        }
      }
      await setActiveProvider(message.activeProvider);
      await setMaxDiffBytes(message.maxDiffBytes);
      this.post({ type: 'saved' });
      await this.sendState();
      void vscode.window.showInformationMessage('GitMate: settings saved.');
    } catch (err) {
      this.post({ type: 'error', message: describe(err) });
    }
  }

  private async handleTest(message: TestMessage): Promise<void> {
    try {
      const detail = await testConnection({
        provider: message.provider,
        kind: PROVIDERS[message.provider].kind,
        model: message.model,
        baseUrl: message.baseUrl,
        apiKey: message.key,
        requestTimeoutMs: message.requestTimeoutMs ?? getRequestTimeoutMs(),
        contextWindow: message.contextWindow
      });
      this.post({ type: 'testResult', ok: true, message: detail });
    } catch (err) {
      this.post({ type: 'testResult', ok: false, message: describe(err) });
    }
  }

  private async handleFetchModels(message: FetchModelsMessage): Promise<void> {
    try {
      const models = await listModels({
        provider: message.provider,
        kind: PROVIDERS[message.provider].kind,
        model: message.model,
        baseUrl: message.baseUrl,
        apiKey: message.key,
        requestTimeoutMs: message.requestTimeoutMs ?? getRequestTimeoutMs(),
        contextWindow: message.contextWindow
      });
      this.post({ type: 'models', models });
    } catch (err) {
      this.post({ type: 'modelsError', message: describe(err) });
    }
  }

  /** Opens a searchable quick pick so the user can choose a model (and provider). */
  private async handlePickModel(): Promise<void> {
    const active = getActiveProvider();
    const activeModel = getProviderSettings(active).model;

    type ModelItem = vscode.QuickPickItem & {
      providerId?: ProviderId;
      model?: string;
      action?: 'custom' | 'settings';
    };

    const items: ModelItem[] = [];
    for (const id of PROVIDER_IDS) {
      const meta = PROVIDERS[id];
      const current = getProviderSettings(id).model;
      const models = Array.from(
        new Set([...meta.suggestedModels, current].filter((m) => m && m.length > 0))
      );
      if (models.length === 0) {
        continue;
      }
      items.push({ label: meta.label, kind: vscode.QuickPickItemKind.Separator });
      for (const model of models) {
        const isActive = id === active && model === activeModel;
        items.push({
          label: `${isActive ? '$(check) ' : '$(blank) '}${model}`,
          description: meta.local ? 'local' : 'cloud',
          providerId: id,
          model
        });
      }
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(edit) Enter a custom model name', action: 'custom' });
    items.push({ label: '$(gear) Open GitMate settings', action: 'settings' });

    const picked = (await vscode.window.showQuickPick(items, {
      title: 'GitMate: choose a model',
      placeHolder: `Currently using ${PROVIDERS[active].label}: ${activeModel || 'no model set'}`,
      matchOnDescription: true
    })) as ModelItem | undefined;

    if (!picked) {
      return;
    }
    if (picked.action === 'settings') {
      await this.showSettings();
      return;
    }
    if (picked.action === 'custom') {
      const value = await vscode.window.showInputBox({
        title: `Model for ${PROVIDERS[active].label}`,
        value: activeModel,
        prompt: 'Type the exact model id this provider expects'
      });
      if (value && value.trim()) {
        await setProviderSettings(active, { ...getProviderSettings(active), model: value.trim() });
        await this.sendState();
      }
      return;
    }
    if (picked.providerId && picked.model) {
      await setProviderSettings(picked.providerId, {
        ...getProviderSettings(picked.providerId),
        model: picked.model
      });
      await setActiveProvider(picked.providerId);
      await this.sendState();
    }
  }

  private async handleChat(message: ChatMessage): Promise<void> {
    this.chatAbort?.abort();
    const abort = new AbortController();
    this.chatAbort = abort;

    const config = await resolveActiveConfig(this.context);
    if (!config.model) {
      this.post({ type: 'chatError', message: 'No model is set for this provider. Open Settings and pick one.' });
      return;
    }
    if (PROVIDERS[config.provider].needsKey && !config.apiKey) {
      this.post({
        type: 'chatError',
        message: `No API key set for ${PROVIDERS[config.provider].label}. Add one in Settings.`
      });
      return;
    }

    try {
      await streamChat({
        config,
        messages: message.messages,
        signal: abort.signal,
        onDelta: (text) => this.post({ type: 'chatDelta', text })
      });
      this.post({ type: 'chatDone' });
    } catch (err) {
      if (abort.signal.aborted) {
        this.post({ type: 'chatDone' });
        return;
      }
      this.post({ type: 'chatError', message: describe(err) });
    } finally {
      if (this.chatAbort === abort) {
        this.chatAbort = undefined;
      }
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function renderHtml(webview: vscode.Webview): string {
  const nonce = makeNonce();
  const csp =
    `default-src 'none'; img-src ${webview.cspSource} data:; ` +
    `style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      font-size: var(--vscode-font-size);
      display: flex; flex-direction: column; height: 100vh;
    }
    .screen { flex: 1 1 auto; min-height: 0; display: none; flex-direction: column; }
    .screen.active { display: flex; }

    /* ---- Chat ---- */
    #messages { flex: 1 1 auto; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
    .empty { margin: auto; text-align: center; color: var(--vscode-descriptionForeground); max-width: 280px; padding: 16px; }
    .empty .logo { width: 42px; height: 42px; margin-bottom: 12px; }
    .empty .title { font-size: 1.25em; font-weight: 600; color: var(--vscode-foreground); margin-bottom: 6px; }
    .empty .line { line-height: 1.5; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 16px; }
    .chip {
      border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground);
      border-radius: 999px; padding: 5px 12px; font-size: 0.85em; cursor: pointer; font-family: inherit;
    }
    .chip:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }

    .msg { display: flex; gap: 9px; align-items: flex-start; max-width: 100%; }
    /* Assistant on the left, you on the right (standard chat layout). */
    .msg.user { flex-direction: row-reverse; }
    .avatar { width: 22px; height: 22px; border-radius: 6px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; font-size: 0.66em; font-weight: 700; }
    .avatar.you { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .avatar.bot { background: linear-gradient(135deg, #6e8bff, #9b6bff); color: #fff; }
    .col { flex: 1 1 auto; min-width: 0; }
    .msg.user .col { text-align: right; }
    .who { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
    .bubble {
      display: inline-block; text-align: left; max-width: 100%;
      background: var(--vscode-editorWidget-background, rgba(127,127,127,0.08));
      border: 1px solid var(--vscode-editorWidget-border, transparent);
      border-radius: 10px 10px 10px 4px; padding: 8px 11px; line-height: 1.5; overflow-wrap: anywhere;
    }
    .msg.user .bubble {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
      border-radius: 10px 10px 4px 10px;
    }
    .bubble.error { background: var(--vscode-inputValidation-errorBackground, transparent); border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); color: var(--vscode-errorForeground); }
    .bubble p { margin: 0 0 8px; } .bubble p:last-child { margin-bottom: 0; }
    .bubble pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12)); padding: 9px 11px; border-radius: 6px; overflow-x: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; }
    .bubble code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; }
    .bubble :not(pre) > code { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.16)); padding: 1px 5px; border-radius: 4px; }
    /* Typing indicator: three soft bouncing dots while we wait for the reply. */
    .typing { display: inline-flex; align-items: center; gap: 5px; padding: 3px 1px; }
    .typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: 0.5; animation: bounce 1.3s infinite ease-in-out both; }
    .typing span:nth-child(2) { animation-delay: 0.18s; }
    .typing span:nth-child(3) { animation-delay: 0.36s; }
    @keyframes bounce { 0%, 70%, 100% { transform: translateY(0); opacity: 0.4; } 35% { transform: translateY(-5px); opacity: 0.9; } }

    /* ---- Composer (Copilot style) ---- */
    .composer { padding: 8px 10px 12px; }
    .inputwrap {
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 12px; background: var(--vscode-input-background);
      transition: border-color 0.1s ease, box-shadow 0.1s ease;
    }
    .inputwrap:focus-within {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }
    textarea#chatInput {
      width: 100%; border: none; outline: none; background: transparent; resize: none;
      color: var(--vscode-input-foreground); font-family: inherit; font-size: inherit;
      padding: 11px 13px 5px; line-height: 1.45; max-height: 180px;
    }
    .toolbar { display: flex; align-items: center; gap: 4px; padding: 3px 7px 7px; }
    .modelpick {
      display: inline-flex; align-items: center; gap: 6px; max-width: 74%;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: transparent; color: var(--vscode-foreground);
      border-radius: 999px; padding: 3px 10px; cursor: pointer; font-family: inherit; font-size: 0.8em;
    }
    .modelpick:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }
    .modelpick .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .modelpick > svg:first-child { color: var(--vscode-textLink-foreground); opacity: 0.9; }
    .modelpick > svg:last-child { opacity: 0.7; }
    .spacer { flex: 1 1 auto; }
    .sendbtn {
      flex: 0 0 auto; width: 28px; height: 28px; border: none; border-radius: 7px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }
    .sendbtn:hover { background: var(--vscode-button-hoverBackground); }
    .sendbtn:disabled { opacity: 0.4; cursor: default; }
    .sendbtn.stop { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .hint { color: var(--vscode-descriptionForeground); font-size: 0.76em; margin: 6px 4px 0; text-align: center; }

    /* ---- Settings screen ---- */
    .subhead { display: flex; align-items: center; gap: 6px; padding: 10px 12px 6px; }
    .backbtn { border: none; background: transparent; color: var(--vscode-foreground); cursor: pointer; border-radius: 5px; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; }
    .backbtn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .subhead .t { font-weight: 600; font-size: 1.02em; }
    .tabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    .tab { appearance: none; border: none; background: transparent; cursor: pointer; color: var(--vscode-descriptionForeground); padding: 8px 12px; font-family: inherit; font-size: 0.92em; border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .tab:hover { color: var(--vscode-foreground); }
    .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
    .pane { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 16px 20px; display: none; }
    .pane.active { display: block; }

    .card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 14px 16px; background: var(--vscode-editorWidget-background, transparent); }
    .card h2 { font-size: 1em; margin: 0 0 2px; }
    .card .desc { color: var(--vscode-descriptionForeground); font-size: 0.86em; margin: 0 0 6px; }
    label { display: block; margin: 14px 0 5px; font-weight: 600; font-size: 0.92em; }
    .with-badge { display: flex; align-items: center; gap: 8px; }
    .pill { font-size: 0.72em; padding: 2px 8px; border-radius: 999px; }
    .pill.local { background: var(--vscode-charts-green, #3fb950); color: #08240f; }
    .pill.cloud { background: var(--vscode-charts-blue, #4c9aff); color: #04122b; }
    input, select { width: 100%; padding: 7px 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; font-family: inherit; font-size: inherit; }
    input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .row { display: flex; gap: 8px; align-items: center; }
    .dropdown { border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-input-background); overflow: hidden; }
    .dropdown input { border: none; border-bottom: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 0; }
    .dropdown input:focus { outline: none; border-bottom-color: var(--vscode-focusBorder); }
    .dropdown-list { max-height: 180px; overflow-y: auto; }
    .dropdown-item { padding: 6px 10px; cursor: pointer; font-size: 0.92em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dropdown-item:hover, .dropdown-item.active { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
    .dropdown-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .dropdown-empty { padding: 8px 10px; color: var(--vscode-descriptionForeground); font-size: 0.88em; }
    .field-note { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 5px; }
    .hidden { display: none !important; }
    button.btn { padding: 7px 14px; border: none; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: inherit; white-space: nowrap; }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .actions { margin-top: 18px; display: flex; gap: 8px; }
    .status { margin-top: 12px; min-height: 1.2em; font-size: 0.9em; }
    .status.ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
    .status.err { color: var(--vscode-errorForeground); }

    .about { line-height: 1.6; }
    .about h2 { font-size: 1.15em; margin: 2px 0 10px; }
    .about p { margin: 0 0 12px; }
    .about .feat { display: flex; gap: 10px; margin: 10px 0; }
    .about .feat .dot { color: var(--vscode-textLink-foreground); font-weight: 700; }
    .about .small { color: var(--vscode-descriptionForeground); font-size: 0.86em; margin-top: 16px; }
  </style>
</head>
<body>
  <!-- ===== Chat screen ===== -->
  <section class="screen active" id="screen-chat">
    <div id="messages">
      <div class="empty" id="emptyState">
        <svg class="logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6e8bff"/><stop offset="1" stop-color="#9b6bff"/></linearGradient></defs>
          <path d="M6 4H18A3 3 0 0 1 21 7V13A3 3 0 0 1 18 16H10L7 19V16H6A3 3 0 0 1 3 13V7A3 3 0 0 1 6 4Z" fill="none" stroke="url(#g)" stroke-width="1.6" stroke-linejoin="round"/>
          <path d="M9 9.2V10.8" stroke="url(#g)" stroke-width="1.6" stroke-linecap="round"/>
          <path d="M15 9.2C15 11.2 12.8 11.9 10.4 12" fill="none" stroke="url(#g)" stroke-width="1.6" stroke-linecap="round"/>
          <circle cx="9" cy="8" r="1.25" fill="url(#g)"/><circle cx="9" cy="12" r="1.25" fill="url(#g)"/><circle cx="15" cy="8" r="1.25" fill="url(#g)"/>
        </svg>
        <div class="title">Ask GitMate</div>
        <div class="line">Your git sidekick is here. Ask about your code, your history, or whatever you are stuck on.</div>
        <div class="chips">
          <button class="chip">Write a commit message</button>
          <button class="chip">Explain this error</button>
          <button class="chip">Review my approach</button>
        </div>
      </div>
    </div>
    <div class="composer">
      <div class="inputwrap">
        <textarea id="chatInput" rows="1" placeholder="Ask GitMate..."></textarea>
        <div class="toolbar">
          <button class="modelpick" id="modelPick" title="Choose a model">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 5.8L20 10l-5.8 2.2L12 18l-2.2-5.8L4 10l5.8-2.2z"/></svg>
            <span class="name" id="modelPickName">No model</span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
          </button>
          <span class="spacer"></span>
          <button class="sendbtn" id="sendBtn" title="Send" disabled>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a1 1 0 0 0-1.39 1.2L4.6 11l-2.6 6.2a1 1 0 0 0 1.4 1.2zM6.2 12l-1.6-3.9L16.9 12 4.6 15.9z"/></svg>
          </button>
          <button class="sendbtn stop hidden" id="stopBtn" title="Stop">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
          </button>
        </div>
      </div>
      <div class="hint">Enter to send, Shift + Enter for a new line.</div>
    </div>
  </section>

  <!-- ===== Settings screen ===== -->
  <section class="screen" id="screen-settings">
    <div class="subhead">
      <button class="backbtn" id="backBtn" title="Back to chat">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15 5l-7 7 7 7z"/></svg>
      </button>
      <span class="t">Settings</span>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="settings">Settings</button>
      <button class="tab" data-tab="about">About</button>
    </div>

    <div class="pane active" id="pane-settings">
      <div class="card">
        <h2>Model provider</h2>
        <p class="desc">Choose where GitMate sends your requests. Cloud services need a key. Local servers run on your own machine.</p>

        <label for="provider">Provider</label>
        <div class="with-badge">
          <select id="provider"></select>
          <span class="pill" id="kindPill"></span>
        </div>

        <div id="modelRow">
          <label for="model">Model</label>
          <div class="row">
            <input id="model" type="text" />
            <button class="btn secondary" id="fetchModels">Fetch models</button>
          </div>
          <div id="modelDropdown" class="dropdown hidden" style="margin-top:8px">
            <input id="modelSearch" type="text" placeholder="Search models..." />
            <div id="modelOptions" class="dropdown-list"></div>
          </div>
          <div class="field-note" id="modelNote"></div>
        </div>

        <div id="baseUrlRow">
          <label for="baseUrl">Base URL</label>
          <input id="baseUrl" type="text" />
          <div class="field-note" id="baseUrlNote"></div>
        </div>

        <div id="ctxRow">
          <label for="contextWindow">Context window (num_ctx)</label>
          <input id="contextWindow" type="number" min="0" step="1024" placeholder="Model default" />
          <div class="field-note">Tokens of context sent to Ollama. Leave blank to use the model default. Try 8192 for long diffs.</div>
        </div>

        <div id="timeoutRow">
          <label for="timeoutMs">Request timeout (ms)</label>
          <input id="timeoutMs" type="number" min="0" step="1000" placeholder="Default" />
          <div class="field-note" id="timeoutNote"></div>
        </div>

        <div id="keyRow">
          <label for="apiKey">API key</label>
          <input id="apiKey" type="password" />
          <div class="field-note" id="keyNote"></div>
        </div>

        <div class="actions">
          <button class="btn secondary" id="test">Test connection</button>
        </div>
      </div>

      <div class="card" style="margin-top: 12px">
        <h2>Commit messages</h2>
        <p class="desc">Applies to every provider.</p>
        <label for="maxDiffBytes">Max diff size (bytes)</label>
        <input id="maxDiffBytes" type="number" min="1000" step="10000" />
        <div class="field-note" id="maxDiffNote">Cap on the diff sent to the model. Bigger changes are condensed: the largest file patches are replaced with per-file summaries so every changed file is still mentioned. Leave blank for the default.</div>
      </div>

      <div class="actions">
        <button class="btn primary" id="save">Save</button>
      </div>
      <div class="status" id="status"></div>
    </div>

    <div class="pane" id="pane-about">
      <div class="about">
        <h2>About GitMate</h2>
        <p>GitMate is a small helper that sits next to your Source Control panel and takes the busywork out of git.</p>
        <p>It began with one simple wish: stop staring at an empty commit box. Point GitMate at your changes and it writes a clear commit message for you. Need a fresh branch? Open the branch dialog, type a name, and it gets created and checked out in one move. And when you just want to think out loud about your code, the chat is right here in the sidebar.</p>
        <div class="feat"><span class="dot">1</span><span><b>Write commit messages.</b> Turn your staged diff into a tidy, conventional commit message.</span></div>
        <div class="feat"><span class="dot">2</span><span><b>Create branches.</b> A quick dialog with a live preview of what will be made.</span></div>
        <div class="feat"><span class="dot">3</span><span><b>Chat in place.</b> Talk to your model without leaving the editor.</span></div>
        <p style="margin-top:14px">You bring your own model. GitMate works with cloud services like Anthropic, OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, and Gemini, and it runs fully offline with local servers like Ollama and LM Studio. Your API keys live in the VS Code secret store, never in a plain settings file.</p>
        <p>Made for people who like their tools quiet, fast, and out of the way.</p>
        <p class="small">GitMate, version 1.0.2. Built with care for the people who ship code every day.</p>
      </div>
    </div>
  </section>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const el = (id) => document.getElementById(id);
    let state = null;

    /* ---- Screens and tabs ---- */
    function showScreen(name) {
      document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
      if (name === 'chat') chatInput.focus();
    }
    function showTab(name) {
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
      document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + name));
    }
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
    el('backBtn').addEventListener('click', () => showScreen('chat'));

    /* ---- Chat ---- */
    const messagesEl = el('messages');
    const emptyState = el('emptyState');
    const chatInput = el('chatInput');
    const sendBtn = el('sendBtn');
    const stopBtn = el('stopBtn');
    let history = [];
    let streaming = false;
    let liveBubble = null;
    let liveText = '';
    const TYPING_HTML = '<div class="typing"><span></span><span></span><span></span></div>';

    function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function renderMarkdown(text) {
      const parts = text.split(/\`\`\`/);
      let out = '';
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
          const body = parts[i].replace(/^[a-zA-Z0-9_-]*\\n/, '');
          out += '<pre><code>' + escapeHtml(body) + '</code></pre>';
        } else {
          let chunk = escapeHtml(parts[i]);
          chunk = chunk.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
          chunk = chunk.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
          chunk = chunk.split(/\\n{2,}/).map(p => '<p>' + p.replace(/\\n/g, '<br>') + '</p>').join('');
          out += chunk;
        }
      }
      return out;
    }
    function addMessage(role, text, opts) {
      emptyState.classList.add('hidden');
      const wrap = document.createElement('div');
      wrap.className = 'msg ' + role;
      const avatar = document.createElement('div');
      avatar.className = 'avatar ' + (role === 'user' ? 'you' : 'bot');
      avatar.textContent = role === 'user' ? 'You' : 'GM';
      const col = document.createElement('div');
      col.className = 'col';
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = role === 'user' ? 'You' : 'GitMate';
      const bubble = document.createElement('div');
      bubble.className = 'bubble' + (opts && opts.error ? ' error' : '');
      if (role === 'user') bubble.textContent = text; else bubble.innerHTML = renderMarkdown(text);
      col.appendChild(who); col.appendChild(bubble);
      wrap.appendChild(avatar); wrap.appendChild(col);
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return bubble;
    }
    function setStreaming(on) {
      streaming = on;
      sendBtn.classList.toggle('hidden', on);
      stopBtn.classList.toggle('hidden', !on);
      updateSendEnabled();
    }
    function updateSendEnabled() { sendBtn.disabled = streaming || chatInput.value.trim().length === 0; }
    function send() {
      const text = chatInput.value.trim();
      if (!text || streaming) return;
      addMessage('user', text);
      history.push({ role: 'user', content: text });
      chatInput.value = ''; autoGrow(); updateSendEnabled();
      liveText = '';
      liveBubble = addMessage('assistant', '');
      liveBubble.innerHTML = TYPING_HTML;
      setStreaming(true);
      vscode.postMessage({ type: 'chat', messages: history });
    }
    function autoGrow() {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 180) + 'px';
    }
    chatInput.addEventListener('input', () => { autoGrow(); updateSendEnabled(); });
    chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    sendBtn.addEventListener('click', send);
    stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'chatStop' }));
    document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
      chatInput.value = c.textContent; autoGrow(); updateSendEnabled(); chatInput.focus();
    }));

    function newChat() {
      history = []; liveBubble = null; liveText = '';
      messagesEl.querySelectorAll('.msg').forEach(m => m.remove());
      emptyState.classList.remove('hidden');
      setStreaming(false);
      showScreen('chat');
    }

    /* ---- Model picker in the composer (opens a native quick pick) ---- */
    const modelPick = el('modelPick');
    const modelPickName = el('modelPickName');
    modelPick.addEventListener('click', () => vscode.postMessage({ type: 'pickModel' }));

    /* ---- Settings ---- */
    const providerEl = el('provider');
    const kindPill = el('kindPill');
    const modelEl = el('model');
    const modelDropdown = el('modelDropdown');
    const modelSearch = el('modelSearch');
    const modelOptions = el('modelOptions');
    const modelNoteEl = el('modelNote');
    const fetchBtn = el('fetchModels');
    const baseUrlRow = el('baseUrlRow');
    const baseUrlEl = el('baseUrl');
    const baseUrlNote = el('baseUrlNote');
    const ctxRow = el('ctxRow');
    const ctxEl = el('contextWindow');
    const timeoutEl = el('timeoutMs');
    const timeoutNote = el('timeoutNote');
    const keyRow = el('keyRow');
    const keyEl = el('apiKey');
    const keyNote = el('keyNote');
    const maxDiffEl = el('maxDiffBytes');
    const maxDiffNote = el('maxDiffNote');
    const statusEl = el('status');

    function parsePositive(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : undefined; }
    function current() { return state.providers[providerEl.value]; }
    function applyProvider() {
      const p = current();
      modelEl.value = p.model;
      baseUrlEl.value = p.baseUrl;
      ctxEl.value = p.contextWindow != null ? p.contextWindow : '';
      timeoutEl.value = p.requestTimeoutMs != null ? p.requestTimeoutMs : '';
      timeoutNote.textContent = 'How long to wait before giving up. Leave blank for the default (' + (p.defaultTimeoutMs ? p.defaultTimeoutMs + ' ms' : 'no limit') + '). Streaming replies are not cut off.';
      ctxRow.classList.toggle('hidden', p.kind !== 'ollama');
      kindPill.textContent = p.local ? 'local' : 'cloud';
      kindPill.className = 'pill ' + (p.local ? 'local' : 'cloud');
      baseUrlRow.classList.toggle('hidden', !p.usesBaseUrl);
      keyRow.classList.toggle('hidden', !p.needsKey);
      keyEl.value = '';
      keyEl.placeholder = p.hasKey ? 'Saved. Leave blank to keep it.' : 'Paste your API key';
      keyNote.textContent = p.needsKey ? 'Stored in the VS Code secret store, not in settings.json.' : '';
      modelNoteEl.textContent = p.modelHint || '';
      hideModelDropdown();
      baseUrlNote.textContent = p.local ? 'The address of your local server.' : 'Leave blank to use the provider default.';
      statusEl.textContent = ''; statusEl.className = 'status';
    }
    function syncLocal() {
      const p = current();
      p.model = modelEl.value.trim();
      p.baseUrl = baseUrlEl.value.trim();
      p.contextWindow = parsePositive(ctxEl.value);
      p.requestTimeoutMs = parsePositive(timeoutEl.value);
    }
    function collectSave() {
      const providers = {};
      for (const id of Object.keys(state.providers)) {
        const s = state.providers[id];
        providers[id] = { model: s.model, baseUrl: s.baseUrl, requestTimeoutMs: s.requestTimeoutMs, contextWindow: s.contextWindow };
      }
      const active = providerEl.value;
      providers[active] = { model: modelEl.value.trim(), baseUrl: baseUrlEl.value.trim(), requestTimeoutMs: parsePositive(timeoutEl.value), contextWindow: parsePositive(ctxEl.value) };
      const keys = {};
      if (current().needsKey && keyEl.value.length > 0) keys[active] = keyEl.value;
      return { type: 'save', activeProvider: active, providers, keys, maxDiffBytes: parsePositive(maxDiffEl.value) };
    }
    providerEl.addEventListener('change', applyProvider);
    modelEl.addEventListener('input', syncLocal);
    baseUrlEl.addEventListener('input', syncLocal);
    ctxEl.addEventListener('input', syncLocal);
    timeoutEl.addEventListener('input', syncLocal);
    el('save').addEventListener('click', () => { syncLocal(); vscode.postMessage(collectSave()); });
    el('test').addEventListener('click', () => {
      syncLocal();
      statusEl.textContent = 'Testing...'; statusEl.className = 'status';
      vscode.postMessage({ type: 'test', provider: providerEl.value, model: modelEl.value.trim(), baseUrl: baseUrlEl.value.trim(), key: keyEl.value.length > 0 ? keyEl.value : undefined, requestTimeoutMs: parsePositive(timeoutEl.value), contextWindow: parsePositive(ctxEl.value) });
    });
    fetchBtn.addEventListener('click', () => {
      modelNoteEl.textContent = 'Loading models...';
      vscode.postMessage({ type: 'fetchModels', provider: providerEl.value, model: modelEl.value.trim(), baseUrl: baseUrlEl.value.trim(), key: keyEl.value.length > 0 ? keyEl.value : undefined, requestTimeoutMs: parsePositive(timeoutEl.value), contextWindow: parsePositive(ctxEl.value) });
    });
    /* ---- Searchable model dropdown ---- */
    let fetchedModels = [];
    let filteredModels = [];
    let activeModelIndex = -1;

    function hideModelDropdown() {
      modelDropdown.classList.add('hidden');
      fetchedModels = []; filteredModels = []; activeModelIndex = -1;
      modelSearch.value = '';
    }
    function filterModels() {
      const q = modelSearch.value.trim().toLowerCase();
      filteredModels = q ? fetchedModels.filter(m => m.toLowerCase().includes(q)) : fetchedModels.slice();
      activeModelIndex = -1;
      renderModelOptions();
    }
    function renderModelOptions() {
      modelOptions.innerHTML = '';
      if (!filteredModels.length) {
        const d = document.createElement('div');
        d.className = 'dropdown-empty';
        d.textContent = 'No models match your search.';
        modelOptions.appendChild(d);
        return;
      }
      const currentModel = modelEl.value.trim();
      filteredModels.forEach((name, i) => {
        const item = document.createElement('div');
        item.className = 'dropdown-item' + (name === currentModel ? ' selected' : '') + (i === activeModelIndex ? ' active' : '');
        item.textContent = name;
        item.title = name;
        item.addEventListener('click', () => chooseModel(name));
        modelOptions.appendChild(item);
      });
    }
    function chooseModel(name) {
      modelEl.value = name;
      syncLocal();
      renderModelOptions();
    }
    modelSearch.addEventListener('input', filterModels);
    modelSearch.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!filteredModels.length) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        activeModelIndex = (activeModelIndex + step + filteredModels.length) % filteredModels.length;
        renderModelOptions();
        const active = modelOptions.querySelector('.dropdown-item.active');
        if (active) active.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeModelIndex >= 0) chooseModel(filteredModels[activeModelIndex]);
        else if (filteredModels.length === 1) chooseModel(filteredModels[0]);
      } else if (e.key === 'Escape') {
        hideModelDropdown();
      }
    });

    /* ---- Incoming ---- */
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'state': {
          state = msg;
          const ids = Object.keys(state.providers);
          providerEl.innerHTML = '';
          for (const id of ids) {
            const o1 = document.createElement('option'); o1.value = id; o1.textContent = state.providers[id].label; providerEl.appendChild(o1);
          }
          providerEl.value = state.activeProvider;
          maxDiffEl.placeholder = String(state.defaultMaxDiffBytes);
          maxDiffEl.value = state.maxDiffBytes !== state.defaultMaxDiffBytes ? String(state.maxDiffBytes) : '';
          maxDiffNote.textContent = 'Cap on the diff sent to the model. Bigger changes are condensed: the largest file patches are replaced with per-file summaries so every changed file is still mentioned. Leave blank for the default (' + state.defaultMaxDiffBytes + ' bytes).';
          const active = state.providers[state.activeProvider];
          modelPickName.textContent = active.model || 'Set a model';
          modelPick.title = active.label + (active.model ? (' · ' + active.model) : '') + ' (click to change)';
          applyProvider();
          break;
        }
        case 'saved': statusEl.textContent = 'Saved.'; statusEl.className = 'status ok'; break;
        case 'testResult': statusEl.textContent = msg.message; statusEl.className = 'status ' + (msg.ok ? 'ok' : 'err'); break;
        case 'error': statusEl.textContent = msg.message; statusEl.className = 'status err'; break;
        case 'models': {
          if (!msg.models.length) { modelNoteEl.textContent = 'No models found from this endpoint.'; hideModelDropdown(); break; }
          fetchedModels = msg.models.slice();
          modelSearch.value = '';
          filterModels();
          modelDropdown.classList.remove('hidden');
          modelNoteEl.textContent = msg.models.length + ' model(s) available. Type to filter, click one to use it.';
          modelSearch.focus();
          break;
        }
        case 'modelsError': modelNoteEl.textContent = msg.message; break;
        case 'chatDelta': {
          if (!liveBubble) break;
          liveText += msg.text; liveBubble.innerHTML = renderMarkdown(liveText);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        }
        case 'chatDone': {
          if (liveText.trim().length > 0) {
            history.push({ role: 'assistant', content: liveText });
          } else if (liveBubble) {
            // No content arrived: drop the empty placeholder so the dots don't linger.
            const msgEl = liveBubble.closest('.msg');
            if (msgEl) msgEl.remove();
          }
          liveBubble = null; setStreaming(false); chatInput.focus();
          break;
        }
        case 'chatError': {
          if (liveBubble) { liveBubble.classList.remove('cursor'); liveBubble.classList.add('error'); liveBubble.textContent = msg.message; }
          else { addMessage('assistant', msg.message, { error: true }); }
          liveBubble = null; setStreaming(false);
          break;
        }
        case 'showSettings': showScreen('settings'); showTab('settings'); break;
        case 'newChat': newChat(); break;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
