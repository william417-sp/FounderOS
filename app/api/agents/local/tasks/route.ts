import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { runAgentTask } from '@/lib/agents/local-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({
  agentId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  detail: z.string().max(5000).optional(),
  run: z.boolean().optional(),
});

/** Create a task for a local agent; `run: true` executes it right away. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const db = getDb();
  const d = parsed.data;
  if (!db.agents.all().some((a) => a.id === d.agentId)) return NextResponse.json({ error: `no agent ${d.agentId}` }, { status: 404 });
  const id = randomUUID();
  const at = new Date().toISOString();
  db.agentTasks.insert({ id, agentId: d.agentId, title: d.title, detail: d.detail ?? '', status: 'open', createdAt: at, updatedAt: at, ownerKind: 'agent' });
  if (!d.run) return NextResponse.json({ task: db.agentTasks.get(id) }, { status: 201 });
  const result = await runAgentTask(db, id);
  return NextResponse.json({ task: db.agentTasks.get(id), ...result }, { status: 201 });
}
