import Anthropic from '@anthropic-ai/sdk';
import { PROVIDERS, ResolvedProviderConfig } from './config';

export interface CommitMessageRequest {
  config: ResolvedProviderConfig;
  diff: string;
  instructions: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  config: ResolvedProviderConfig;
  messages: ChatTurn[];
  signal?: AbortSignal;
  onDelta: (text: string) => void;
}

export interface BranchNameRequest {
  config: ResolvedProviderConfig;
  diff?: string;
  description?: string;
}

// In the spirit of Cline's commit generation: Conventional Commits, an
// imperative subject, and a short bulleted body for non-trivial changes.
const COMMIT_SYSTEM_PROMPT = [
  'You are an expert developer writing a git commit message for a set of staged changes.',
  'Follow the Conventional Commits format.',
  '',
  'Rules:',
  '- The first line is "type(scope): summary". Pick the type from feat, fix, refactor, perf, docs, style, test, build, ci, or chore. The scope is optional and names the area touched, in parentheses.',
  '- Write the summary in the imperative mood, lower case, with no trailing period, and keep the whole first line at or under 72 characters.',
  '- If the change is more than trivial, add a blank line and then a body that explains what changed and why. Use short bullet points that begin with "- " for the distinct changes.',
  '- Base the message only on the diff. Do not invent anything that is not in the changes.',
  '- Return only the commit message. No code fences, no surrounding quotes, and no lead in text.'
].join('\n');

const CHAT_SYSTEM_PROMPT = [
  'You are GitMate, a friendly coding assistant that lives inside VS Code.',
  'Help the developer with their code, their git workflow, and anything else they ask.',
  'Be clear and practical, and keep answers reasonably short unless asked for detail.',
  'Use Markdown, and put code inside fenced code blocks.'
].join(' ');

const BRANCH_SYSTEM_PROMPT = [
  'You suggest names for git branches. Reply with exactly one branch name and nothing else.',
  '',
  'Rules:',
  '- Use lower case kebab-case for the words.',
  '- You may start with a type prefix followed by a slash, one of: feature/, fix/, chore/, refactor/, docs/, or test/.',
  '- Keep it short, at most about 40 characters.',
  '- Do not add quotes, trailing punctuation, or any words of explanation.'
].join('\n');

function buildCommitContent(req: CommitMessageRequest): string {
  const extra = req.instructions.trim();
  const parts = ['Generate the commit message for the following diff.'];
  if (extra) {
    parts.push('', 'Additional guidance:', extra);
  }
  parts.push('', 'Diff:', '', req.diff);
  return parts.join('\n');
}

// --- Commit messages ---------------------------------------------------------

/** Turns a diff into a commit message with the active provider. */
export async function generateCommitMessage(req: CommitMessageRequest): Promise<string> {
  const text = await oneShot(req.config, COMMIT_SYSTEM_PROMPT, buildCommitContent(req), 1024);
  return ensureText(text);
}

/** Suggests a single branch name from a diff and/or a task description. */
export async function suggestBranchName(req: BranchNameRequest): Promise<string> {
  const parts: string[] = [];
  const description = req.description?.trim();
  const diff = req.diff?.trim();
  if (description) {
    parts.push('The work is about:', description);
  }
  if (diff) {
    const clipped = diff.length > 6000 ? diff.slice(0, 6000) : diff;
    parts.push('', 'Here are the current changes:', '', clipped);
  }
  if (parts.length === 0) {
    parts.push('Suggest a short, generic branch name.');
  }
  const text = await oneShot(req.config, BRANCH_SYSTEM_PROMPT, parts.join('\n'), 40);
  return text.trim();
}

function ensureText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('The model returned an empty response.');
  }
  return trimmed;
}

/** A single, non-streaming completion routed to the active provider. */
async function oneShot(
  config: ResolvedProviderConfig,
  system: string,
  user: string,
  maxTokens: number
): Promise<string> {
  switch (config.kind) {
    case 'anthropic': {
      const client = anthropicClient(config);
      const response = await client.messages.create(
        {
          model: config.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }]
        },
        { timeout: config.requestTimeoutMs || undefined }
      );
      if ((response.stop_reason as string) === 'refusal') {
        throw new Error('The model declined this request.');
      }
      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
    }
    case 'openai': {
      const url = joinUrl(openAiBase(config), 'chat/completions');
      const res = await fetchJson(url, {
        method: 'POST',
        headers: openAiHeaders(config),
        timeoutMs: config.requestTimeoutMs,
        body: JSON.stringify({
          model: config.model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        })
      });
      const text = res?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new Error('Unexpected response from the OpenAI-compatible endpoint.');
      }
      return text;
    }
    case 'ollama': {
      const base = config.baseUrl || PROVIDERS.ollama.defaults.baseUrl;
      const url = joinUrl(base, 'api/chat');
      const res = await fetchJson(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeoutMs: config.requestTimeoutMs,
          body: JSON.stringify({
            model: config.model,
            stream: false,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user }
            ],
            options: ollamaOptions(config)
          })
        },
        `Could not reach Ollama at ${base}. Is "ollama serve" running?`
      );
      const text = res?.message?.content;
      if (typeof text !== 'string') {
        throw new Error('Unexpected response from Ollama.');
      }
      return text;
    }
    default:
      throw new Error(`Unknown provider kind: ${config.kind}`);
  }
}

// --- Chat (streaming) --------------------------------------------------------

/** Streams a chat reply to req.onDelta. Resolves when the reply is complete. */
export async function streamChat(req: ChatRequest): Promise<void> {
  switch (req.config.kind) {
    case 'anthropic':
      return chatWithAnthropic(req);
    case 'openai':
      return chatWithOpenAI(req);
    case 'ollama':
      return chatWithOllama(req);
    default:
      throw new Error(`Unknown provider kind: ${req.config.kind}`);
  }
}

async function chatWithAnthropic(req: ChatRequest): Promise<void> {
  const client = anthropicClient(req.config);
  const stream = client.messages.stream(
    {
      model: req.config.model,
      max_tokens: 4096,
      system: CHAT_SYSTEM_PROMPT,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content }))
    },
    { signal: req.signal }
  );
  stream.on('text', (delta) => req.onDelta(delta));
  await stream.finalMessage();
}

async function chatWithOpenAI(req: ChatRequest): Promise<void> {
  const url = joinUrl(openAiBase(req.config), 'chat/completions');
  const t = withTimeout(req.config.requestTimeoutMs, req.signal);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: openAiHeaders(req.config),
      body: JSON.stringify({
        model: req.config.model,
        stream: true,
        messages: [
          { role: 'system', content: CHAT_SYSTEM_PROMPT },
          ...req.messages.map((m) => ({ role: m.role, content: m.content }))
        ]
      }),
      signal: t.signal
    });
  } catch (err) {
    t.done();
    throw t.timedOut() ? timeoutError(req.config.requestTimeoutMs) : err;
  }
  // The reply is on its way; stop the clock so a long stream is not cut off.
  t.clearTimer();
  if (!res.ok) {
    t.done();
    throw new Error(`HTTP ${res.status}: ${await readError(res)}`);
  }
  await readSse(res, (data) => {
    if (data === '[DONE]') {
      return;
    }
    try {
      const json = JSON.parse(data);
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        req.onDelta(delta);
      }
    } catch {
      // Ignore keep-alive comments and partial frames.
    }
  });
  t.done();
}

async function chatWithOllama(req: ChatRequest): Promise<void> {
  const base = req.config.baseUrl || PROVIDERS.ollama.defaults.baseUrl;
  const url = joinUrl(base, 'api/chat');
  const t = withTimeout(req.config.requestTimeoutMs, req.signal);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.config.model,
        stream: true,
        messages: [
          { role: 'system', content: CHAT_SYSTEM_PROMPT },
          ...req.messages.map((m) => ({ role: m.role, content: m.content }))
        ],
        options: ollamaOptions(req.config)
      }),
      signal: t.signal
    });
  } catch (err) {
    t.done();
    if (t.timedOut()) {
      throw timeoutError(req.config.requestTimeoutMs);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach Ollama at ${base}. Is "ollama serve" running? (${reason})`);
  }
  // First bytes are in; lift the timeout so a slow, steady stream can finish.
  t.clearTimer();
  if (!res.ok) {
    t.done();
    throw new Error(`HTTP ${res.status}: ${await readError(res)}`);
  }
  await readLines(res, (line) => {
    try {
      const json = JSON.parse(line);
      const delta = json?.message?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        req.onDelta(delta);
      }
    } catch {
      // Skip non-JSON lines.
    }
  });
  t.done();
}

// --- Connection test and model discovery ------------------------------------

/** Verifies the provider is reachable and authenticated. Throws on failure. */
export async function testConnection(config: ResolvedProviderConfig): Promise<string> {
  switch (config.kind) {
    case 'ollama': {
      const models = await listOllamaModels(config.baseUrl, config.requestTimeoutMs);
      return models.length > 0
        ? `Connected. ${models.length} model(s) available.`
        : `Connected, but no models are installed yet (try "ollama pull ${config.model || 'llama3.1'}").`;
    }
    case 'openai': {
      if (PROVIDERS[config.provider].needsKey && !config.apiKey) {
        throw new Error('No API key set.');
      }
      const url = joinUrl(openAiBase(config), 'models');
      await fetchJson(url, { headers: openAiHeaders(config), timeoutMs: config.requestTimeoutMs });
      return 'Connected and authenticated.';
    }
    case 'anthropic': {
      if (!config.apiKey) {
        throw new Error('No API key set.');
      }
      const client = anthropicClient(config);
      await client.messages.create(
        {
          model: config.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        },
        { timeout: config.requestTimeoutMs || undefined }
      );
      return 'Connected and authenticated.';
    }
    default:
      throw new Error(`Unknown provider kind: ${config.kind}`);
  }
}

/** Lists available models for the given provider. */
export async function listModels(config: ResolvedProviderConfig): Promise<string[]> {
  switch (config.kind) {
    case 'ollama':
      return listOllamaModels(config.baseUrl, config.requestTimeoutMs);
    case 'openai': {
      const url = joinUrl(openAiBase(config), 'models');
      const res = await fetchJson(url, { headers: openAiHeaders(config), timeoutMs: config.requestTimeoutMs });
      const data = res?.data;
      if (!Array.isArray(data)) {
        return [];
      }
      return data
        .map((m: { id?: string }) => m?.id)
        .filter((id): id is string => typeof id === 'string')
        .sort();
    }
    case 'anthropic':
      return [
        'claude-opus-4-8',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001'
      ];
    default:
      return [];
  }
}

/** Lists locally installed Ollama models via /api/tags. */
export async function listOllamaModels(baseUrl: string, timeoutMs?: number): Promise<string[]> {
  const base = baseUrl || PROVIDERS.ollama.defaults.baseUrl;
  const url = joinUrl(base, 'api/tags');
  const res = await fetchJson(
    url,
    { method: 'GET', timeoutMs },
    `Could not reach Ollama at ${base}. Is "ollama serve" running?`
  );
  const models = res?.models;
  if (!Array.isArray(models)) {
    return [];
  }
  return models
    .map((m: { name?: string }) => m?.name)
    .filter((name): name is string => typeof name === 'string')
    .sort();
}

// --- helpers -----------------------------------------------------------------

function anthropicClient(config: ResolvedProviderConfig): Anthropic {
  if (!config.apiKey) {
    throw new Error('No Anthropic API key configured. Add one in GitMate settings.');
  }
  return new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl ? config.baseUrl : undefined
  });
}

/** Ollama runtime options. Returns undefined when there is nothing to set. */
function ollamaOptions(config: ResolvedProviderConfig): { num_ctx: number } | undefined {
  return config.contextWindow && config.contextWindow > 0
    ? { num_ctx: config.contextWindow }
    : undefined;
}

function openAiBase(config: ResolvedProviderConfig): string {
  return config.baseUrl || PROVIDERS[config.provider].defaults.baseUrl || 'https://api.openai.com/v1';
}

function openAiHeaders(config: ResolvedProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Abort after this many ms. 0 or undefined means no timeout. */
  timeoutMs?: number;
  /** A caller-owned abort signal, combined with the timeout. */
  signal?: AbortSignal;
}

/** fetch + JSON parse with friendly error messages and an optional timeout. */
async function fetchJson(url: string, options: FetchOptions, networkHint?: string): Promise<any> {
  const t = withTimeout(options.timeoutMs, options.signal);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: t.signal
      });
    } catch (err) {
      if (t.timedOut()) {
        throw timeoutError(options.timeoutMs ?? 0);
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(networkHint ? `${networkHint} (${reason})` : `Network error: ${reason}`);
    }
    const text = await response.text();
    if (!response.ok) {
      const detail = extractErrorMessage(text) ?? text.slice(0, 300);
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error('Received a non-JSON response from the provider.');
    }
  } finally {
    t.done();
  }
}

interface TimeoutHandle {
  /** Pass to fetch. Undefined when there is neither a timeout nor a caller signal. */
  signal: AbortSignal | undefined;
  /** True once the timeout (not the caller) triggered the abort. */
  timedOut: () => boolean;
  /** Stop the countdown but keep forwarding caller aborts (used once a stream starts). */
  clearTimer: () => void;
  /** Release the timer and listeners. Safe to call more than once. */
  done: () => void;
}

/**
 * Builds an AbortSignal that fires when either a timeout elapses or a
 * caller-supplied signal aborts, so requests cannot hang forever.
 */
function withTimeout(timeoutMs: number | undefined, userSignal?: AbortSignal): TimeoutHandle {
  if ((!timeoutMs || timeoutMs <= 0) && !userSignal) {
    return { signal: undefined, timedOut: () => false, clearTimer: () => {}, done: () => {} };
  }
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  const forward = () => controller.abort();
  if (userSignal) {
    if (userSignal.aborted) {
      controller.abort();
    } else {
      userSignal.addEventListener('abort', forward, { once: true });
    }
  }
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clearTimer,
    done: () => {
      clearTimer();
      userSignal?.removeEventListener('abort', forward);
    }
  };
}

function timeoutError(timeoutMs: number): Error {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return new Error(
    `The request timed out after ${seconds}s. Increase "gitmate.requestTimeoutMs" in settings, ` +
      'or check that your model server is responding.'
  );
}

async function readError(res: Response): Promise<string> {
  const text = await res.text();
  return extractErrorMessage(text) ?? text.slice(0, 300) ?? res.statusText;
}

function extractErrorMessage(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message ?? parsed?.error ?? parsed?.message;
  } catch {
    return undefined;
  }
}

/** Reads a Server-Sent-Events stream, calling onData for each "data:" payload. */
async function readSse(res: Response, onData: (data: string) => void): Promise<void> {
  await readLines(res, (line) => {
    if (line.startsWith('data:')) {
      onData(line.slice(5).trim());
    }
  });
}

/** Reads a streamed body line by line. */
async function readLines(res: Response, onLine: (line: string) => void): Promise<void> {
  if (!res.body) {
    throw new Error('The provider returned an empty stream.');
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        onLine(line);
      }
    }
  }
  const tail = buffer.trim();
  if (tail.length > 0) {
    onLine(tail);
  }
}
