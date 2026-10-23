import { describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import { seedDatabase } from '@/lib/seed';
import type { LlmProvider } from '@/lib/connectors/llm';
import {
  AGENT_PROMPTS,
  NEEDS_KEY_MESSAGE,
  localBoardSnapshot,
  parseAssignments,
  runAgentTask,
  systemPromptFor,
} from '@/lib/agents/local-runtime';

const READY = { ready: true, provider: 'test', model: 'test-model', detail: '' };
const NOT_READY = { ready: false, provider: 'gateway', model: 'm', detail: NEEDS_KEY_MESSAGE };

function fresh() {
  const db = openDb(':memory:');
  seedDatabase(db);
  return db;
}
function task(db: ReturnType<typeof fresh>, agentId: string, title = 'Do it', detail = '') {
  const id = `t-${Math.random().toString(36).slice(2)}`;
  const at = new Date().toISOString();
  db.agentTasks.insert({ id, agentId, title, detail, status: 'open', createdAt: at, updatedAt: at, ownerKind: 'agent' });
  return id;
}
const echo = (calls: { system?: string; content: string }[] = []): LlmProvider => ({
  name: 'test',
  async chat(req) {
    calls.push({ system: req.system, content: req.messages[0].content });
    return { text: `OUT: ${req.messages[0].content.split('\n')[0]}`, toolCalls: [] };
  },
});

describe('local runtime', () => {
  test('every agency seat has a role prompt and the seeded roster includes them', () => {
    const db = fresh();
    const ids = db.agents.all().map((a) => a.id);
    for (const id of ['chief-of-staff', 'sales-rep', 'client-sites', 'frontend-designer', 'clip-studio', 'jarvis', 'bookkeeper']) {
      expect(ids).toContain(id);
      expect(AGENT_PROMPTS[id]).toBeTruthy();
    }
    const sales = db.agents.all().find((a) => a.id === 'sales-rep')!;
    expect(systemPromptFor(sales)).toMatch(/Puerto Rico/);
  });

  test('without a key a run is stored as needs_key and no output is faked', async () => {
    const db = fresh();
    const id = task(db, 'sales-rep');
    const calls: { content: string }[] = [];
    const { run } = await runAgentTask(db, id, { readiness: NOT_READY, provider: echo(calls) });
    expect(run.status).toBe('needs_key');
    expect(run.output).toBe('');
    expect(run.error).toMatch(/AI_GATEWAY_API_KEY/);
    expect(calls).toHaveLength(0);
    expect(db.agentTasks.get(id)!.status).toBe('open');
    expect(db.agentTasks.get(id)!.runId).toBe(run.id);
  });

  test('a ready run stores output, marks the task done and logs an agent run', async () => {
    const db = fresh();
    const id = task(db, 'clip-studio', 'Reel for a Ponce bakery');
    const calls: { system?: string; content: string }[] = [];
    const { run } = await runAgentTask(db, id, { readiness: READY, provider: echo(calls) });
    expect(run.status).toBe('ok');
    expect(run.output).toBe('OUT: Task: Reel for a Ponce bakery');
    expect(calls[0].system).toMatch(/Clip Studio/);
    expect(db.taskRuns.byTask(id)).toHaveLength(1);
    expect(db.agentTasks.get(id)!.status).toBe('done');
    expect(db.agentRuns.byAgent('clip-studio')[0].ok).toBe(true);
  });

  test('a provider error blocks the task and records the error', async () => {
    const db = fresh();
    const id = task(db, 'client-sites');
    const boom: LlmProvider = { name: 'x', chat: async () => { throw new Error('rate limited'); } };
    const { run } = await runAgentTask(db, id, { readiness: READY, provider: boom });
    expect(run.status).toBe('error');
    expect(run.error).toBe('rate limited');
    expect(db.agentTasks.get(id)!.status).toBe('blocked');
  });

  test('chief of staff assignments become tasks for known agents only', async () => {
    const db = fresh();
    const id = task(db, 'chief-of-staff', 'Land 3 new clients in Mayagüez');
    const reply = 'Plan.\n```json\n[{"agentId":"sales-rep","title":"Pitch 10 restaurants","detail":"cold email"},{"agentId":"nobody","title":"x"},{"agentId":"chief-of-staff","title":"self"}]\n```';
    const provider: LlmProvider = { name: 't', chat: async (req) => {
      expect(req.messages[0].content).toMatch(/sales-rep/); // roster is in context
      return { text: reply, toolCalls: [] };
    } };
    const { createdTaskIds } = await runAgentTask(db, id, { readiness: READY, provider });
    expect(createdTaskIds).toHaveLength(1);
    const created = db.agentTasks.get(createdTaskIds[0])!;
    expect(created.agentId).toBe('sales-rep');
    expect(created.status).toBe('open');
  });

  test('bookkeeper gets ledger context; jarvis gets open tasks', async () => {
    const db = fresh();
    const calls: { content: string }[] = [];
    await runAgentTask(db, task(db, 'bookkeeper', 'Monthly summary'), { readiness: READY, provider: echo(calls), ledgerSummary: 'Rows: 3. Software: $40.00' });
    expect(calls[0].content).toMatch(/Software: \$40\.00/);
    await runAgentTask(db, task(db, 'bookkeeper', 'Again'), { readiness: READY, provider: echo(calls), ledgerSummary: null });
    expect(calls[1].content).toMatch(/No ledger data/);
    task(db, 'sales-rep', 'Pitch the barbershop');
    await runAgentTask(db, task(db, 'jarvis', 'Daily agenda'), { readiness: READY, provider: echo(calls) });
    expect(calls[2].content).toMatch(/Pitch the barbershop/);
  });

  test('parseAssignments tolerates junk and the snapshot lists tasks and runs', async () => {
    expect(parseAssignments('no json')).toEqual([]);
    expect(parseAssignments('```json\nnot json\n```')).toEqual([]);
    const db = fresh();
    const id = task(db, 'frontend-designer');
    await runAgentTask(db, id, { readiness: READY, provider: echo() });
    const snap = localBoardSnapshot(db);
    expect(snap.tasks.map((t) => t.id)).toContain(id);
    expect(snap.runs[0].taskId).toBe(id);
  });

  test('unknown task throws', async () => {
    await expect(runAgentTask(fresh(), 'missing', { readiness: READY })).rejects.toThrow(/no task/);
  });
});
