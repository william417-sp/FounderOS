import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  activeLlmProvider,
  createGroqProvider,
  createOllamaProvider,
  llmStatus,
  modelFor,
  ollamaModel,
  ollamaReachable,
  resetOllamaProbe,
} from '@/lib/connectors/llm';
import { localRuntimeStatus } from '@/lib/agents/local-runtime';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const reply = (content: string) => json({ choices: [{ message: { content } }] });

beforeEach(() => {
  resetOllamaProbe();
  vi.stubEnv('LLM_PROVIDER', '');
  vi.stubEnv('GROQ_API_KEY', '');
  vi.stubEnv('AI_GATEWAY_API_KEY', '');
  vi.stubEnv('OLLAMA_DISABLED', '1');
  vi.stubEnv('LLM_MODEL', '');
  vi.stubEnv('GROQ_MODEL', '');
  vi.stubEnv('OLLAMA_MODEL', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetOllamaProbe();
});

describe('provider priority: Groq → Ollama → Gateway → needs key', () => {
  test('nothing configured → null and needs-key readiness', async () => {
    expect(await activeLlmProvider()).toBeNull();
    const s = await localRuntimeStatus();
    expect(s.ready).toBe(false);
    expect(s.detail).toMatch(/Ollama/);
    expect((await llmStatus()).state).toBe('not_configured');
  });

  test('gateway key only → gateway', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gw');
    expect(await activeLlmProvider()).toBe('gateway');
  });

  test('reachable Ollama with the model pulled beats the gateway', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gw');
    vi.stubEnv('OLLAMA_DISABLED', '');
    vi.stubGlobal('fetch', vi.fn(async () => json({ models: [{ name: 'qwen2.5:3b' }] })));
    expect(await activeLlmProvider()).toBe('ollama');
    expect(modelFor('ollama')).toBe('qwen2.5:3b');
    const s = await localRuntimeStatus();
    expect(s).toMatchObject({ ready: true, provider: 'ollama', model: 'qwen2.5:3b' });
  });

  test('Ollama without the configured model is not reachable', async () => {
    vi.stubEnv('OLLAMA_DISABLED', '');
    vi.stubEnv('OLLAMA_MODEL', 'llama3.2:3b');
    expect(await ollamaReachable(vi.fn(async () => json({ models: [{ name: 'qwen2.5:3b' }] })) as never)).toBe(false);
  });

  test('Ollama down (fetch throws) falls through', async () => {
    vi.stubEnv('OLLAMA_DISABLED', '');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await activeLlmProvider()).toBeNull();
  });

  test('a Groq key wins over everything, with the free default model', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gw');
    vi.stubEnv('GROQ_API_KEY', 'gk');
    expect(await activeLlmProvider()).toBe('groq');
    expect(modelFor('groq')).toBe('llama-3.3-70b-versatile');
    vi.stubEnv('LLM_MODEL', 'llama-3.1-8b-instant');
    expect(modelFor('groq')).toBe('llama-3.1-8b-instant');
  });

  test('LLM_PROVIDER forces a provider', async () => {
    vi.stubEnv('GROQ_API_KEY', 'gk');
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gw');
    vi.stubEnv('LLM_PROVIDER', 'gateway');
    expect(await activeLlmProvider()).toBe('gateway');
  });

  test('OLLAMA_MODEL / LLM_MODEL override the Ollama default', () => {
    expect(ollamaModel()).toBe('qwen2.5:3b');
    vi.stubEnv('LLM_MODEL', 'llama3.2:3b');
    expect(ollamaModel()).toBe('llama3.2:3b');
    vi.stubEnv('OLLAMA_MODEL', 'phi3:mini');
    expect(ollamaModel()).toBe('phi3:mini');
  });
});

describe('OpenAI-compatible chat', () => {
  test('Groq sends the bearer key, model and system prompt', async () => {
    vi.stubEnv('GROQ_API_KEY', 'secret-k');
    const f = vi.fn(async (_url: string, _init: RequestInit) => reply('hola'));
    const out = await createGroqProvider('m1', f as never).chat({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }] });
    expect(out.text).toBe('hola');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-k');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('m1');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
  });

  test('Ollama posts to the local /v1 endpoint with no auth header', async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => reply('ok'));
    await createOllamaProvider('qwen2.5:3b', f as never).chat({ messages: [{ role: 'user', content: 'hi' }] });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test('HTTP errors surface the provider message', async () => {
    const f = vi.fn(async () => json({ error: { message: 'model not found' } }, 404));
    await expect(createOllamaProvider('x', f as never).chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/Ollama 404: model not found/);
  });

  test('tool calls run and loop back to the model', async () => {
    const execute = vi.fn(async () => ({ temp: 30 }));
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Ponce"}' } }] } }] }))
      .mockResolvedValueOnce(reply('30 degrees'));
    const out = await createOllamaProvider('m', f as never).chat({
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ name: 'weather', description: 'w', parameters: z.object({ city: z.string() }), execute }],
    });
    expect(execute).toHaveBeenCalledWith({ city: 'Ponce' });
    expect(out).toEqual({ text: '30 degrees', toolCalls: [{ name: 'weather', args: { city: 'Ponce' }, result: { temp: 30 } }] });
    const second = JSON.parse(String(f.mock.calls[1][1].body));
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
  });
});
