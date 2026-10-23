import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { localBoardSnapshot, localRuntimeStatus } from '@/lib/agents/local-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Local runtime board: readiness, agent tasks and recent runs (no Paperclip needed). */
export async function GET() {
  return NextResponse.json({ status: await localRuntimeStatus(), ...localBoardSnapshot(getDb()) });
}
