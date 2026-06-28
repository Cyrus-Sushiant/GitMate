import * as vscode from 'vscode';

/**
 * The three transport shapes GitMate knows how to talk to. Most hosted
 * services speak the OpenAI chat-completions format, so they all share the
 * `openai` kind and differ only by their default base URL and model.
 */
export type ProviderKind = 'anthropic' | 'openai' | 'ollama';

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'groq'
  | 'together'
  | 'deepseek'
  | 'mistral'
  | 'gemini'
  | 'lmstudio'
  | 'ollama'
  | 'custom';

export const PROVIDER_IDS: ProviderId[] = [
  'anthropic',
  'openai',
  'openrouter',
  'groq',
  'together',
  'deepseek',
  'mistral',
  'gemini',
  'lmstudio',
  'ollama',
  'custom'
];

export interface PerProviderSettings {
  model: string;
  baseUrl: string;
}

export interface ResolvedProviderConfig {
  provider: ProviderId;
  kind: ProviderKind;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  /** Whether the provider requires an API key. */
  needsKey: boolean;
  /** Whether the base URL is user-configurable and meaningful. */
  usesBaseUrl: boolean;
  /** True for services that run on the user's own machine. */
  local: boolean;
  defaults: PerProviderSettings;
  /** Short, friendly hint shown under the model field. */
  modelHint: string;
  /** A few well-known models offered in the quick picker. */
  suggestedModels: string[];
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude (cloud)',
    kind: 'anthropic',
    needsKey: true,
    usesBaseUrl: true,
    local: false,
    defaults: { model: 'claude-opus-4-8', baseUrl: '' },
    modelHint: 'Try claude-opus-4-8 or claude-sonnet-4-6.',
    suggestedModels: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (cloud)',
    kind: 'openai',
    needsKey: true,
    usesBaseUrl: true,
    local: false,
    defaults: { model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
    modelHint: 'Try gpt-4o or gpt-4o-mini.',
    suggestedModels: ['gpt-4o', 'gpt-4o-mini', 'o3-mini']
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter (cloud)',
    kind: 'openai',
    needsKey: true,
    usesBaseUrl: true,
    local: false,
    defaults: { model: 'anthropic/claude-3.5-sonnet', baseUrl: 'https://openrouter.ai/api/v1' },
    modelHint: 'Use any model slug, like anthropic/claude-3.5-sonnet or openai/gpt-4o.',
    suggestedModels: [
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o',
      'meta-llama/llama-3.3-70b-instruct',
      'google/gemini-2.0-flash-001'
    ]
  },
  groq: {
    id: 'groq',
    label: 'Groq (cloud)',
    kind: 'openai',
    needsKey: true,
    usesBaseUrl: true,
    local: false,
    defaults: { model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' },
    modelHint: 'Try llama-3.3-70b-versatile.',
    suggestedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']
  },
  together: {
    id: 'together',
    label: 'Together AI (cloud)',
    kind: 'openai',
    needsKey: true,
    usesBaseUrl: true,
    local: false,
    defaults: {
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      baseUrl: 'https://api.together.xyz/v1'
    },
    modelHint: 'Paste any model id from your Together dashboard.',
    suggestedModels: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'Qwen/Qwen2.5-Coder-32B-Instruct'
    ]
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek (cloud)',
    kind: 'openai',
    needsKey: true,
    usesBaseUrl: true,
    local: false,
    defaults: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
    modelHint: 'Try deepseek-chat or deepseek-reasoner.',
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner']
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral (cloud)',
    kind: 'openai',
    needsKey: true,
    usesBaseUrl: true,
    local: false,
    defaults: { model: 'mistral-large-latest', baseUrl: 'https://api.mistral.ai/v1' },
    modelHint: 'Try mistral-large-latest or codestral-latest.',
    suggestedModels: ['mistral-large-latest', 'codestral-latest', 'mistral-small-latest']
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini (cloud)',
    kind: 'openai',
    needsKey: true,
    usesBaseUrl: true,
    local: false,
    defaults: {
      model: 'gemini-2.0-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai'
    },
    modelHint: 'Try gemini-2.0-flash or gemini-1.5-pro.',
    suggestedModels: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    kind: 'openai',
    needsKey: false,
    usesBaseUrl: true,
    local: true,
    defaults: { model: 'local-model', baseUrl: 'http://localhost:1234/v1' },
    modelHint: 'Use the model id shown in the LM Studio server tab.',
    suggestedModels: []
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'ollama',
    needsKey: false,
    usesBaseUrl: true,
    local: true,
    defaults: { model: 'llama3.1', baseUrl: 'http://localhost:11434' },
    modelHint: 'Try llama3.1 or qwen2.5-coder. Use Fetch models to list what you have.',
    suggestedModels: ['llama3.1', 'qwen2.5-coder', 'deepseek-r1']
  },
  custom: {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    kind: 'openai',
    needsKey: false,
    usesBaseUrl: true,
    local: false,
    defaults: { model: '', baseUrl: '' },
    modelHint: 'Point the base URL at any service that speaks the OpenAI chat format.',
    suggestedModels: []
  }
};

function secretKey(provider: ProviderId): string {
  return `gitmate.apiKey.${provider}`;
}

function gitmateConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('gitmate');
}

export function getActiveProvider(): ProviderId {
  const value = gitmateConfig().get<string>('activeProvider', 'anthropic');
  return PROVIDER_IDS.includes(value as ProviderId) ? (value as ProviderId) : 'anthropic';
}

export function getProviderSettings(provider: ProviderId): PerProviderSettings {
  const all = gitmateConfig().get<Record<string, Partial<PerProviderSettings>>>('providers', {});
  const defaults = PROVIDERS[provider].defaults;
  const stored = all[provider] ?? {};
  return {
    model: (stored.model ?? '').trim() || defaults.model,
    baseUrl: (stored.baseUrl ?? defaults.baseUrl).trim() || defaults.baseUrl
  };
}

export function getApiKey(
  context: vscode.ExtensionContext,
  provider: ProviderId
): Thenable<string | undefined> {
  return context.secrets.get(secretKey(provider));
}

export async function hasApiKey(
  context: vscode.ExtensionContext,
  provider: ProviderId
): Promise<boolean> {
  const key = await context.secrets.get(secretKey(provider));
  return Boolean(key && key.length > 0);
}

export async function resolveActiveConfig(
  context: vscode.ExtensionContext
): Promise<ResolvedProviderConfig> {
  const provider = getActiveProvider();
  const meta = PROVIDERS[provider];
  const settings = getProviderSettings(provider);
  const apiKey = meta.needsKey ? await getApiKey(context, provider) : undefined;
  return { provider, kind: meta.kind, model: settings.model, baseUrl: settings.baseUrl, apiKey };
}

export async function setActiveProvider(provider: ProviderId): Promise<void> {
  await gitmateConfig().update('activeProvider', provider, vscode.ConfigurationTarget.Global);
}

export async function setProviderSettings(
  provider: ProviderId,
  settings: PerProviderSettings
): Promise<void> {
  const config = gitmateConfig();
  const all = { ...(config.get<Record<string, PerProviderSettings>>('providers', {})) };
  all[provider] = { model: settings.model.trim(), baseUrl: settings.baseUrl.trim() };
  await config.update('providers', all, vscode.ConfigurationTarget.Global);
}

export async function setApiKey(
  context: vscode.ExtensionContext,
  provider: ProviderId,
  key: string | undefined
): Promise<void> {
  if (key && key.length > 0) {
    await context.secrets.store(secretKey(provider), key);
  } else {
    await context.secrets.delete(secretKey(provider));
  }
}
