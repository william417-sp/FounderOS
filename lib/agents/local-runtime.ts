/**
 * Built-in local runtime: lets any local agent execute a task without Paperclip.
 *
 *   task (agent_tasks) ──run──▶ LLM via the existing gateway connector ──▶ agent_task_runs
 *
 * Honest by construction: with no AI_GATEWAY_API_KEY (and LLM_PROVIDER≠stub) a
 * run is recorded as 'needs_key' with a clear message, never fake output.
 */
import { randomUUID } from 'node:crypto';
import type { GladosDb } from '@/lib/db';
import type { Agent } from '@/lib/schemas';
import { getLlmProvider, llmStatus, LLM_DEFAULT_MODEL, type LlmProvider } from '@/lib/connectors/llm';
import type { TaskRun } from '@/lib/db-ext/task-runs';

export const NEEDS_KEY_MESSAGE =
  'Needs API key: set AI_GATEWAY_API_KEY in .env.local (Vercel AI Gateway) and restart, then run the task again.';

const STUDIO =
  "You work for William Rosado's web/app studio in Puerto Rico. The studio builds websites and mockups for local businesses, " +
  'pitches them through outbound sales, does front-end design and produces short-form video. Write in clear, practical English ' +
  '(add Spanish where it helps a Puerto Rico audience). Never invent facts about real businesses or numbers you were not given; mark assumptions.';

/** Role prompts for the agency seats; any other local agent falls back to its role description. */
export const AGENT_PROMPTS: Record<string, string> = {
  'sales-rep':
    'You are the Sales Representative. Draft outbound pitches to local Puerto Rico businesses (restaurants, salons, clinics, shops, contractors): ' +
    'a short cold email, a WhatsApp/DM version and a follow-up. Lead with a concrete website/mockup benefit, keep it under 150 words each, end with one clear ask.',
  'client-sites':
    'You are Client Sites. Produce a website plan for the client in the task: sitemap, section-by-section outline, draft headline and body copy, ' +
    'calls to action, and a short launch checklist (domain, hosting, Google Business Profile, analytics).',
  'frontend-designer':
    'You are the Front-End Designer. Write a design brief: audience, mood, colour palette (hex), type pairing, layout for key pages, ' +
    'component list, imagery direction and accessibility notes. Be specific enough that a developer can build a mockup from it.',
  'clip-studio':
    'You are Clip Studio. Write short-form video scripts (15–45s) for TikTok/Reels/Shorts: hook in the first 2 seconds, beat-by-beat shots, ' +
    'on-screen text, voiceover, caption and hashtags. Give 2–3 variations unless told otherwise.',
  jarvis:
    "You are JARVIS, William's agency assistant. Produce a concise daily agenda and triage summary from the open tasks and context given: " +
    'top 3 priorities, what each agent is working on, what is blocked, and what needs William. Do not invent meetings or emails you were not given.',
  bookkeeper:
    'You are the Bookkeeper. Summarize the ledger data provided: income vs expenses for the latest month, top spending categories, anything unusual, ' +
    'and 3 practical bookkeeping actions. If no ledger data is provided, say so and list what to upload (bank/card CSV with Date, Description, Amount).',
  'chief-of-staff':
    'You are the Chief of Staff. Break the goal into 2–6 concrete tasks and assign each to the best agent from the roster given. ' +
    'Write a short plan, then end with a fenced ```json block containing an array of {"agentId": string, "title": string, "detail": string}. ' +
    'Only use agentIds from the roster; never assign to yourself.',
};

export type RuntimeReadiness = { ready: boolean; provider: string; model: string; detail: string };

export async function localRuntimeStatus(): Promise<RuntimeReadiness> {
  const s = await llmStatus();
  const stub = process.env.LLM_PROVIDER === 'stub';
  const ready = stub || s.state !== 'not_configured';
  return {
    ready,
    provider: stub ? 'stub' : 'gateway',
    model: stub ? 'stub' : LLM_DEFAULT_MODEL,
    detail: ready ? s.detail : NEEDS_KEY_MESSAGE,
  };
}

export function systemPromptFor(agent: Agent): string {
  return `${STUDIO}\n\n${AGENT_PROMPTS[agent.id] ?? `You are ${agent.name}. Your role: ${agent.role || agent.description}`}`;
}

type Ctx = { db: GladosDb; agent: Agent; ledgerSummary?: () => string | null };

function contextFor({ db, agent, ledgerSummary }: Ctx): string {
  if (agent.id === 'chief-of-staff') {
    const roster = db.agents.all().filter((a) => a.id !== agent.id && a.id !== 'conductor');
    return 'Roster (agentId — role):\n' + roster.map((a) => `- ${a.id} — ${a.name}: ${a.role || a.description}`).join('\n');
  }
  if (agent.id === 'jarvis') {
    const names = Object.fromEntries(db.agents.all().map((a) => [a.id, a.name]));
    const open = db.agentTasks.all().filter((t) => t.status !== 'done').slice(0, 40);
    return open.length
      ? 'Open tasks:\n' + open.map((t) => `- [${t.status}] ${t.title} (${t.agentId ? names[t.agentId] ?? t.agentId : 'William'})`).join('\n')
      : 'Open tasks: none.';
  }
  if (agent.id === 'bookkeeper') {
    return `Ledger data:\n${ledgerSummary?.() ?? 'No ledger data has been imported yet.'}`;
  }
  return '';
}

/** Default ledger reader for the Bookkeeper: the latest month's totals by category. */
export async function defaultLedgerSummary(): Promise<string | null> {
  try {
    const { openLedger } = await import('@/lib/ledger');
    const l = openLedger();
    try {
      if (l.rowCount() === 0) return null;
      const month = l.latestMonth();
      const cats = l.monthly().map((c) => `- ${c.category}: $${(c.total / 100).toFixed(2)}`).join('\n');
      return `Rows: ${l.rowCount()}. Latest month: ${month ?? 'n/a'}.\nSpend by category (latest month):\n${cats || '- none'}`;
    } finally {
      l.close();
    }
  } catch {
    return null;
  }
}

/** Pull the Chief of Staff's ```json [...] ``` assignments out of its reply. */
export function parseAssignments(text: string): { agentId: string; title: string; detail: string }[] {
  const m = text.match(/```json\s*([\s\S]*?)```/i);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.agentId === 'string' && typeof x.title === 'string' && x.title.trim())
      .map((x) => ({ agentId: x.agentId, title: String(x.title).slice(0, 200), detail: typeof x.detail === 'string' ? x.detail : '' }));
  } catch {
    return [];
  }
}

export type RunOptions = {
  provider?: LlmProvider;
  readiness?: RuntimeReadiness;
  ledgerSummary?: string | null;
  now?: () => Date;
};

export type RunResult = { run: TaskRun; createdTaskIds: string[] };

/** Execute one agent task and persist the run. Throws only for an unknown task/agent. */
export async function runAgentTask(db: GladosDb, taskId: string, opts: RunOptions = {}): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  const task = db.agentTasks.get(taskId);
  if (!task) throw new Error(`no task ${taskId}`);
  if (!task.agentId) throw new Error('task has no agent');
  const agent = db.agents.all().find((a) => a.id === task.agentId);
  if (!agent) throw new Error(`no agent ${task.agentId}`);

  const readiness = opts.readiness ?? (await localRuntimeStatus());
  const startedAt = now().toISOString();
  const base = { id: randomUUID(), taskId, agentId: agent.id, model: readiness.model, startedAt };

  if (!readiness.ready) {
    const run = db.taskRuns.insert({ ...base, status: 'needs_key', output: '', error: NEEDS_KEY_MESSAGE, finishedAt: now().toISOString() });
    db.agentTasks.update(taskId, { runId: run.id }, run.finishedAt);
    return { run, createdTaskIds: [] };
  }

  db.agentTasks.setStatus(taskId, 'doing', startedAt);
  const ledger = agent.id === 'bookkeeper'
    ? (opts.ledgerSummary !== undefined ? opts.ledgerSummary : await defaultLedgerSummary())
    : null;
  const context = contextFor({ db, agent, ledgerSummary: () => ledger });
  const prompt = [`Task: ${task.title}`, task.detail ? `Details: ${task.detail}` : '', context].filter(Boolean).join('\n\n');

  try {
    const provider = opts.provider ?? getLlmProvider();
    const reply = await provider.chat({ system: systemPromptFor(agent), messages: [{ role: 'user', content: prompt }] });
    const createdTaskIds: string[] = [];
    let output = reply.text;
    if (agent.id === 'chief-of-staff') {
      const known = new Set(db.agents.all().map((a) => a.id));
      for (const a of parseAssignments(reply.text)) {
        if (!known.has(a.agentId) || a.agentId === agent.id) continue;
        const id = randomUUID();
        const at = now().toISOString();
        db.agentTasks.insert({ id, agentId: a.agentId, title: a.title, detail: a.detail, status: 'open', createdAt: at, updatedAt: at, ownerKind: 'agent' });
        createdTaskIds.push(id);
      }
      if (createdTaskIds.length) output += `\n\n— Created ${createdTaskIds.length} task(s) for other agents.`;
    }
    const finishedAt = now().toISOString();
    const run = db.taskRuns.insert({ ...base, status: 'ok', output, error: '', finishedAt });
    db.agentRuns.insert({ id: run.id, agentId: agent.id, startedAt, finishedAt, ok: true, summary: `${task.title}: ${output.slice(0, 200)}` });
    db.agentTasks.setStatus(taskId, 'done', finishedAt);
    db.agentTasks.update(taskId, { runId: run.id }, finishedAt);
    return { run, createdTaskIds };
  } catch (err) {
    const finishedAt = now().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    const run = db.taskRuns.insert({ ...base, status: 'error', output: '', error: message, finishedAt });
    db.agentRuns.insert({ id: run.id, agentId: agent.id, startedAt, finishedAt, ok: false, summary: `${task.title}: ${message.slice(0, 200)}` });
    db.agentTasks.setStatus(taskId, 'blocked', finishedAt);
    db.agentTasks.update(taskId, { runId: run.id }, finishedAt);
    return { run, createdTaskIds: [] };
  }
}

/** Snapshot for the /agents local board. */
export function localBoardSnapshot(db: GladosDb) {
  const agents = db.agents.all();
  const ids = new Set(agents.map((a) => a.id));
  const tasks = db.agentTasks.all().filter((t) => t.ownerKind === 'agent' && t.agentId && ids.has(t.agentId)).slice(0, 200);
  return {
    agents: agents.map((a) => ({ id: a.id, name: a.name, departmentId: a.departmentId })),
    tasks,
    runs: db.taskRuns.recent(30),
  };
}
