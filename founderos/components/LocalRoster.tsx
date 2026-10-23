import type { Agent, Department } from '@/lib/schemas';

/**
 * Fallback roster for /agents when no Paperclip board is configured or
 * reachable: the local agents from the OS database, grouped by department.
 * Read-only and honest — it shows seats, not runs.
 */
export function LocalRoster({ departments, agents }: { departments: Department[]; agents: Agent[] }) {
  const groups = [...departments]
    .sort((a, b) => a.order - b.order)
    .map((d) => ({ department: d, agents: agents.filter((a) => a.departmentId === d.id) }))
    .filter((g) => g.agents.length > 0);
  return (
    <div className="mb-6" data-testid="local-roster">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-os-dim">Local roster</div>
        <div className="font-mono text-[11px] text-os-dim">{agents.length} agents · no live board configured</div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
        {groups.map(({ department, agents: list }) => (
          <section key={department.id} className="rounded-xl border border-os-border p-3">
            <div className="mb-2 text-[13px] font-medium">{department.name}</div>
            <ul className="space-y-2">
              {list.map((a) => (
                <li key={a.id} className="text-[12px] leading-snug">
                  <span className="font-medium">{a.name}</span>
                  <span className="text-os-dim"> · {a.role || a.description}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
