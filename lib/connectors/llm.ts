/**
 * LLM connector — backs agent & Wizard chat through the Vercel AI Gateway.
 *
 * Mirrors the brain.ts provider shape: a real `gateway` provider (default) that
 * calls the AI SDK with a `"provider/model"` string, plus a `stub` provider
 * (LLM_PROVIDER=stub) that is deterministic and makes NO network call — so the
 * whole agent-chat stack is testable offline. Status stays honest: no
 * AI_GATEWAY_API_KEY ⇒ not_configured, never a fake "connected".
 */
import { z } from 'zod';
import { CRED_FILES, resolveCred } from '@/lib/creds';
import type { ConnectorStatus } from '@/lib/connectors/types';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';
export type LlmMessage = { role: LlmRole; content: string };

export type LlmToolSpec = {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export type LlmToolCall = { name: string; args: unknown; result: unknown };

export type LlmChatRequest = {
  system?: string;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  model?: string;
};

export type LlmChatResult = { text: string; toolCalls: LlmToolCall[] };

export interface LlmProvider {
  name: string;
  chat(req: LlmChatRequest): Promise<LlmChatResult>;
}

const GATEWAY_KEY = 'AI_GATEWAY_API_KEY';
const DEFAULT_MODEL = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-5';
/** The gateway model an agent with no stored model id runs on (the failover select's default, F9). */
export const LLM_DEFAULT_MODEL = DEFAULT_MODEL;

/** process.env first (Next auto-loads .env.local), then the operator's cred files. */
function resolveGatewayKey(): string | undefined {
  return resolveCred(GATEWAY_KEY, [CRED_FILES.agentsEnv, CRED_FILES.socialMedia]);
}

/** Stub trigger: a user message containing `use-tool:<name>` fires that tool. */
const STUB_TRIGGER = /use-tool:(\S+)/;

export const stubLlmProvider: LlmProvider = {
  name: 'stub',
  async chat(req) {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const text = lastUser ? `stub-reply: ${lastUser.content}` : 'stub-reply';
    const toolCalls: LlmToolCall[] = [];
    const trigger = lastUser?.content.match(STUB_TRIGGER);
    if (trigger && req.tools) {
      const spec = req.tools.find((t) => t.name === trigger[1]);
      if (spec) {
        const args: Record<string, unknown> = {};
        const result = await spec.execute(args);
        toolCalls.push({ name: spec.name, args, result });
      }
    }
    return { text, toolCalls };
  },
};

export function createGatewayProvider(model: string = DEFAULT_MODEL): LlmProvider {
  return {
    name: 'gateway',
    async chat(req) {
      // Fail fast with an honest message instead of letting the SDK hang —
      // and hydrate process.env from the operator's cred files so a key that
      // exists outside .env.local still works.
      const key = resolveGatewayKey();
      if (!key) {
        throw new Error('AI_GATEWAY_API_KEY is not set — add it to .env.local to enable agent chat.');
      }
      if (!process.env.AI_GATEWAY_API_KEY) process.env.AI_GATEWAY_API_KEY = key;
      const { generateText, tool, stepCountIs, gateway } = await import('ai');
      const tools = Object.fromEntries(
        (req.tools ?? []).map((t) => [
          t.name,
          tool({ description: t.description, inputSchema: t.parameters, execute: t.execute }),
        ]),
      );
      const messages = req.messages
        .filter((m) => m.role !== 'tool')
        .map((m) => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content }));

      const result = await generateText({
        model: gateway(req.model ?? model),
        system: req.system,
        messages,
        tools: req.tools?.length ? tools : undefined,
        stopWhen: stepCountIs(6),
      });

      const toolCalls: LlmToolCall[] = [];
      for (const step of result.steps ?? []) {
        const calls = step.toolCalls ?? [];
        const results = step.toolResults ?? [];
        for (const c of calls) {
          // Match the result to its call by id — a failed/missing tool result
          // can leave `toolResults` shorter than `toolCalls`, so positional
          // alignment would attach the wrong output to every later call.
          const hit = results.find((r) => r.toolCallId === c.toolCallId);
          toolCalls.push({ name: c.toolName, args: c.input, result: hit?.output });
        }
      }
      return { text: result.text, toolCalls };
    },
  };
}

// ── OpenAI-compatible providers: Groq (free tier) and local Ollama ─────────
const GROQ_KEY = 'GROQ_API_KEY';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';

function resolveGroqKey(): string | undefined {
  return resolveCred(GROQ_KEY, [CRED_FILES.agentsEnv, CRED_FILES.socialMedia]);
}

/** The Groq model in force: GROQ_MODEL, then LLM_MODEL, then the free-tier default. */
export function groqModel(): string {
  return process.env.GROQ_MODEL || process.env.LLM_MODEL || GROQ_DEFAULT_MODEL;
}

type OaiToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type OaiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Any OpenAI-compatible chat completions endpoint, via plain fetch (no extra
 * dependency). Tools run in a bounded loop (6 steps, like the gateway).
 * `req.model` is ignored: stored agent model ids are gateway-shaped.
 */
export function createOpenAiCompatProvider(opts: {
  name: string;
  url: string;
  model: string;
  key?: () => string | undefined;
  fetchImpl?: typeof fetch;
}): LlmProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const label = opts.name === 'groq' ? 'Groq' : opts.name === 'ollama' ? 'Ollama' : opts.name;
  return {
    name: opts.name,
    async chat(req) {
      const key = opts.key?.();
      const { zodSchema } = await import('ai');
      const tools = (req.tools ?? []).map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: zodSchema(t.parameters as never).jsonSchema },
      }));
      const messages: OaiMessage[] = [
        ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
        ...req.messages
          .filter((m) => m.role !== 'tool')
          .map((m) => (m.role === 'assistant' ? { role: 'assistant' as const, content: m.content } : { role: m.role as 'system' | 'user', content: m.content })),
      ];
      const toolCalls: LlmToolCall[] = [];
      for (let step = 0; step < 6; step++) {
        const res = await fetchImpl(opts.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ model: opts.model, messages, ...(tools.length ? { tools } : {}) }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          let msg = body;
          try { msg = JSON.parse(body)?.error?.message ?? body; } catch { /* raw text */ }
          throw new Error(`${label} ${res.status}: ${String(msg).slice(0, 300)}`);
        }
        const json = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: OaiToolCall[] } }[] };
        const msg = json.choices?.[0]?.message;
        const calls = msg?.tool_calls ?? [];
        if (!calls.length || !req.tools?.length) return { text: msg?.content ?? '', toolCalls };
        messages.push({ role: 'assistant', content: msg?.content ?? null, tool_calls: calls });
        for (const c of calls) {
          const spec = req.tools.find((t) => t.name === c.function.name);
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* empty args */ }
          const result = spec ? await spec.execute(args) : { error: `unknown tool ${c.function.name}` };
          toolCalls.push({ name: c.function.name, args, result });
          messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result ?? null) });
        }
      }
      return { text: '', toolCalls };
    },
  };
}

export function createGroqProvider(model: string = groqModel(), fetchImpl: typeof fetch = fetch): LlmProvider {
  return createOpenAiCompatProvider({
    name: 'groq',
    url: GROQ_URL,
    model,
    fetchImpl,
    key: () => {
      const key = resolveGroqKey();
      if (!key) throw new Error('GROQ_API_KEY is not set — add it to the environment or .env.local.');
      return key;
    },
  });
}

export const OLLAMA_DEFAULT_MODEL = 'qwen2.5:3b';
export const ollamaBaseUrl = (): string => (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
/** The Ollama model in force: OLLAMA_MODEL, then LLM_MODEL, then the default. */
export function ollamaModel(): string {
  return process.env.OLLAMA_MODEL || process.env.LLM_MODEL || OLLAMA_DEFAULT_MODEL;
}
export function createOllamaProvider(model: string = ollamaModel(), fetchImpl: typeof fetch = fetch): LlmProvider {
  return createOpenAiCompatProvider({ name: 'ollama', url: `${ollamaBaseUrl()}/v1/chat/completions`, model, fetchImpl });
}

let ollamaCache: { ok: boolean; at: number } | null = null;
/** Is a local Ollama answering with the configured model pulled? Cached 10s. */
export async function ollamaReachable(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (process.env.OLLAMA_DISABLED === '1') return false;
  if (ollamaCache && Date.now() - ollamaCache.at < 10_000) return ollamaCache.ok;
  let ok = false;
  try {
    const res = await fetchImpl(`${ollamaBaseUrl()}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const j = (await res.json()) as { models?: { name?: string; model?: string }[] };
      const want = ollamaModel();
      const names = (j.models ?? []).flatMap((m) => [m.name, m.model]).filter(Boolean) as string[];
      ok = names.some((n) => n === want || n === `${want}:latest`);
    }
  } catch {
    ok = false;
  }
  ollamaCache = { ok, at: Date.now() };
  return ok;
}
/** Test hook: forget the cached Ollama probe. */
export function resetOllamaProbe(): void {
  ollamaCache = null;
}

export type ActiveProvider = 'stub' | 'groq' | 'ollama' | 'gateway';

/** Which provider runs, in preference order: Groq (key), local Ollama (reachable), the AI Gateway (key). */
export async function activeLlmProvider(): Promise<ActiveProvider | null> {
  const forced = process.env.LLM_PROVIDER;
  if (forced === 'stub') return 'stub';
  if (forced === 'groq') return resolveGroqKey() ? 'groq' : null;
  if (forced === 'ollama') return (await ollamaReachable()) ? 'ollama' : null;
  if (forced === 'gateway') return resolveGatewayKey() ? 'gateway' : null;
  if (resolveGroqKey()) return 'groq';
  if (await ollamaReachable()) return 'ollama';
  if (resolveGatewayKey()) return 'gateway';
  return null;
}

/** The model a provider will use. */
export function modelFor(active: ActiveProvider | null): string {
  if (active === 'stub') return 'stub';
  if (active === 'groq') return groqModel();
  if (active === 'ollama') return ollamaModel();
  return DEFAULT_MODEL;
}

function providerFor(active: ActiveProvider | null): LlmProvider {
  if (active === 'stub') return stubLlmProvider;
  if (active === 'groq') return createGroqProvider();
  if (active === 'ollama') return createOllamaProvider();
  return createGatewayProvider();
}

/** Synchronous pick (no network probe): stub, Groq when keyed, else the gateway. Prefer resolveLlmProvider. */
export function getLlmProvider(): LlmProvider {
  if (process.env.LLM_PROVIDER === 'stub') return stubLlmProvider;
  if (process.env.LLM_PROVIDER !== 'gateway' && resolveGroqKey()) return createGroqProvider();
  return createGatewayProvider();
}

/** Full pick including a live Ollama probe. */
export async function resolveLlmProvider(): Promise<LlmProvider> {
  return providerFor(await activeLlmProvider());
}

export async function chat(req: LlmChatRequest): Promise<LlmChatResult> {
  return (await resolveLlmProvider()).chat(req);
}

export async function llmStatus(): Promise<ConnectorStatus> {
  const base = { id: 'llm', name: 'LLM (Gateway)', kind: 'orchestration' } as const;
  if (process.env.LLM_PROVIDER === 'stub') {
    return { ...base, state: 'connected', detail: 'stub provider active (tests)' };
  }
  const active = await activeLlmProvider();
  if (active === 'groq') {
    return { ...base, name: 'LLM (Groq)', state: 'connected', detail: `Groq · model ${groqModel()}` };
  }
  if (active === 'ollama') {
    return { ...base, name: 'LLM (Ollama)', state: 'connected', detail: `Local Ollama · model ${ollamaModel()}` };
  }
  if (active !== 'gateway') {
    return {
      ...base,
      state: 'not_configured',
      detail: 'Set AI_GATEWAY_API_KEY in .env.local (or GROQ_API_KEY, or run a local Ollama) to enable agent chat.',
    };
  }
  return { ...base, state: 'connected', detail: `Vercel AI Gateway · default model ${DEFAULT_MODEL}` };
}
