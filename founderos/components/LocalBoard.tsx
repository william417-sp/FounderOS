'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AgentTask } from '@/lib/schemas';
import type { TaskRun } from '@/lib/db-ext/task-runs';
import type { RuntimeReadiness } from '@/lib/agents/local-runtime';

export type LocalBoardData = {
  status: RuntimeReadiness;
  agents: { id: string; name: string; departmentId: string }[];
  tasks: AgentTask[];
  runs: TaskRun[];
};

const LANES: AgentTask['status'][] = ['open', 'doing', 'blocked', 'done'];
const fmt = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * The built-in local runtime board (used on /agents when Paperclip is absent):
 * give an agent a task, run it, and read the stored output.
 */
export function LocalBoard({ initial, defaultAgentId }: { initial: LocalBoardData; defaultAgentId?: string }) {
  const [data, setData] = useState(initial);
  const [agentId, setAgentId] = useState(defaultAgentId ?? initial.agents[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch('/api/agents/local', { cache: 'no-store' });
    if (r.ok) setData(await r.json());
  }, []);

  useEffect(() => {
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const names = Object.fromEntries(data.agents.map((a) => [a.id, a.name]));
  const runsById = Object.fromEntries(data.runs.map((r) => [r.id, r]));

  async function create(run: boolean) {
    if (!title.trim() || !agentId) return;
    setBusy('create');
    setError(null);
    try {
      const r = await fetch('/api/agents/local/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, title, detail, run }),
      });
      const j = await r.json();
      if (!r.ok) setError(typeof j.error === 'string' ? j.error : 'could not create the task');
      else {
        setTitle('');
        setDetail('');
        if (j.run) setOpenRun(j.run.id);
      }
    } finally {
      setBusy(null);
      refresh();
    }
  }

  async function runTask(id: string) {
    setBusy(id);
    try {
      const r = await fetch(`/api/agents/local/tasks/${id}/run`, { method: 'POST' });
      const j = await r.json();
      if (j.run) setOpenRun(j.run.id);
    } finally {
      setBusy(null);
      refresh();
    }
  }

  const shown = openRun ? runsById[openRun] : null;

  return (
    <div className="space-y-5" data-testid="local-board">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-os-dim">Local runtime</div>
        <div className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${data.status.ready ? 'border-emerald-500/40 text-emerald-400' : 'border-amber-500/40 text-amber-400'}`}>
          {data.status.ready ? `ready · ${({ groq: 'Groq', ollama: 'Ollama (local)', gateway: 'AI Gateway', stub: 'stub' } as Record<string, string>)[data.status.provider] ?? data.status.provider} · ${data.status.model}` : 'needs a model (Ollama, Groq or AI Gateway)'}
        </div>
      </div>
      {!data.status.ready && <p className="text-[12px] text-amber-300/90">{data.status.detail}</p>}

      <div className="grid gap-2 rounded-xl border border-os-border p-3">
        <div className="flex flex-wrap gap-2">
          <select aria-label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} className="rounded-md border border-os-border bg-transparent px-2 py-1.5 text-[12px]">
            {data.agents.map((a) => (
              <option key={a.id} value={a.id} className="bg-black">{a.name}</option>
            ))}
          </select>
          <input aria-label="Task title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task, e.g. Pitch a website to a bakery in Ponce" className="min-w-[240px] flex-1 rounded-md border border-os-border bg-transparent px-2 py-1.5 text-[12px]" />
        </div>
        <textarea aria-label="Task details" value={detail} onChange={(e) => setDetail(e.target.value)} rows={2} placeholder="Details (optional)" className="rounded-md border border-os-border bg-transparent px-2 py-1.5 text-[12px]" />
        <div className="flex gap-2">
          <button type="button" disabled={!!busy || !title.trim()} onClick={() => create(true)} className="rounded-md bg-white px-3 py-1.5 text-[12px] font-medium text-black disabled:opacity-40">
            {busy === 'create' ? 'Running…' : 'Create & run'}
          </button>
          <button type="button" disabled={!!busy || !title.trim()} onClick={() => create(false)} className="rounded-md border border-os-border px-3 py-1.5 text-[12px] disabled:opacity-40">
            Add task
          </button>
        </div>
        {error && <p className="text-[12px] text-red-400">{error}</p>}
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        {LANES.map((lane) => {
          const list = data.tasks.filter((t) => t.status === lane);
          return (
            <section key={lane} className="min-w-0 rounded-xl border border-os-border p-3">
              <div className="mb-2 flex justify-between font-mono text-[11px] uppercase tracking-[0.2em] text-os-dim">
                <span>{lane}</span><span>{list.length}</span>
              </div>
              <ul className="space-y-2">
                {list.slice(0, 12).map((t) => {
                  const run = t.runId ? runsById[t.runId] : undefined;
                  return (
                    <li key={t.id} className="rounded-lg border border-os-border/60 p-2 text-[12px]">
                      <div className="font-medium leading-snug">{t.title}</div>
                      <div className="text-os-dim">{t.agentId ? names[t.agentId] ?? t.agentId : ''}{run ? ` · ${run.status}` : ''}</div>
                      <div className="mt-1 flex gap-2">
                        {lane !== 'doing' && (
                          <button type="button" disabled={!!busy} onClick={() => runTask(t.id)} className="text-[11px] underline disabled:opacity-40">
                            {busy === t.id ? 'running…' : lane === 'done' ? 're-run' : 'run'}
                          </button>
                        )}
                        {run && <button type="button" onClick={() => setOpenRun(run.id)} className="text-[11px] underline">output</button>}
                      </div>
                    </li>
                  );
                })}
                {list.length === 0 && <li className="text-[12px] text-os-dim">—</li>}
              </ul>
            </section>
          );
        })}
      </div>

      <section className="rounded-xl border border-os-border p-3">
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-os-dim">Recent runs</div>
        {data.runs.length === 0 ? (
          <p className="text-[12px] text-os-dim">No runs yet. Give an agent a task above.</p>
        ) : (
          <ul className="space-y-1">
            {data.runs.slice(0, 10).map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setOpenRun(r.id)} className="w-full text-left text-[12px] hover:underline">
                  <span className={r.status === 'ok' ? 'text-emerald-400' : r.status === 'needs_key' ? 'text-amber-400' : 'text-red-400'}>{r.status}</span>
                  {' · '}{names[r.agentId] ?? r.agentId}{' · '}{fmt(r.startedAt)}
                </button>
              </li>
            ))}
          </ul>
        )}
        {shown && (
          <div className="mt-3 rounded-lg border border-os-border/60 p-3" data-testid="run-output">
            <div className="mb-1 font-mono text-[11px] text-os-dim">{names[shown.agentId] ?? shown.agentId} · {shown.status} · {shown.model}</div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed">{shown.output || shown.error}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
