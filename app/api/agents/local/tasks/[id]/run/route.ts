import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { runAgentTask } from '@/lib/agents/local-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Run (or re-run) one agent task on the built-in local runtime. */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  try {
    const result = await runAgentTask(db, params.id);
    return NextResponse.json({ task: db.agentTasks.get(params.id), ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 });
  }
}
