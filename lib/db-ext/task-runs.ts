/**
 * agent_task_runs — the built-in local runtime's run history (lib/agents/local-runtime.ts).
 * One row per attempt to execute an agent task: full output, error, model and
 * status ('ok' | 'error' | 'needs_key'). Self-creating so older databases gain it.
 */
import type Database from 'better-sqlite3';

export type TaskRunStatus = 'ok' | 'error' | 'needs_key';
export type TaskRun = {
  id: string;
  taskId: string;
  agentId: string;
  status: TaskRunStatus;
  model: string;
  output: string;
  error: string;
  startedAt: string;
  finishedAt: string;
};

type Raw = {
  id: string; task_id: string; agent_id: string; status: TaskRunStatus; model: string;
  output: string; error: string; started_at: string; finished_at: string;
};

const toRun = (r: Raw): TaskRun => ({
  id: r.id, taskId: r.task_id, agentId: r.agent_id, status: r.status, model: r.model,
  output: r.output, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at,
});

export function taskRunsRepo(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    output TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL
  )`);
  return {
    insert(run: TaskRun): TaskRun {
      db.prepare(
        `INSERT OR REPLACE INTO agent_task_runs (id, task_id, agent_id, status, model, output, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(run.id, run.taskId, run.agentId, run.status, run.model, run.output, run.error, run.startedAt, run.finishedAt);
      return run;
    },
    get(id: string): TaskRun | null {
      const r = db.prepare('SELECT * FROM agent_task_runs WHERE id = ?').get(id) as Raw | undefined;
      return r ? toRun(r) : null;
    },
    byTask(taskId: string): TaskRun[] {
      return (db.prepare('SELECT * FROM agent_task_runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC').all(taskId) as Raw[]).map(toRun);
    },
    recent(limit = 50): TaskRun[] {
      return (db.prepare('SELECT * FROM agent_task_runs ORDER BY started_at DESC, rowid DESC LIMIT ?').all(limit) as Raw[]).map(toRun);
    },
  };
}
