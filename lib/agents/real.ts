import { z } from 'zod';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { getBrainProvider } from '@/lib/brain';
import { createGBrainProvider } from '@/lib/connectors/gbrain';
import { parseInboxConfigs, unreadCounts } from '@/lib/connectors/email';
import { runtimeEnv } from '@/lib/creds';
import { recentMessages } from '@/lib/connectors/slack';
import { recentPages } from '@/lib/connectors/notion';
import { attioStatus } from '@/lib/connectors/attio';
import { whatsappStatus } from '@/lib/connectors/whatsapp';
import { localStackStatus } from '@/lib/connectors/local-stack';
import { getBrandDeals } from '@/lib/brand-deals';
import { createForeplayClient } from '@/lib/foreplay/client';
import { runSyncCycle } from '@/lib/foreplay/sync';
import { buildBrandDossier, renderDossier } from '@/lib/foreplay/dossier';
import type { LlmToolSpec } from '@/lib/connectors/llm';
import { bdpilotStatePath, gbrainBin, gbrainConfigured } from '@/lib/stores';
import type { AgentRunResult, RuntimeAgent } from '@/lib/agents/runtime';
import { contentLabAgent } from '@/lib/agents/content-lab';
import { agencyAgents } from '@/lib/agents/agency';

/**
 * The agent roster. Every run() reports live, honest status: an agent whose
 * backing connector or daemon is not configured says so and points at
 * /setup — it never fakes "connected". Wire a real integration by giving the
 * agent's run() something real to check (see the connector-backed agents
 * below), or replace the stub with your own daemon/binding.
 */

/** Honest placeholder for an agent whose backing job is not installed yet. */
function notConfigured(what: string): AgentRunResult {
  return { ok: false, summary: `${what} is not configured on this host — see /setup` };
}

/** Is the engine CLI reachable? A configured binary on disk, or `gbrain` on PATH. */
function gbrainInstalled(): boolean {
  if (gbrainConfigured()) return fs.existsSync(gbrainBin());
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, 'gbrain')));
}

function envPresent(...keys: string[]): boolean {
  const env = runtimeEnv();
  return keys.every((k) => Boolean(env[k]));
}

const home = () => os.homedir();

/** Honest fs probe: the target either exists on this host or it does not. */
function probePaths(targets: Array<{ label: string; p: string }>): { found: string[]; missing: string[] } {
  const found: string[] = [];
  const missing: string[] = [];
  for (const t of targets) (fs.existsSync(t.p) ? found : missing).push(t.label);
  return { found, missing };
}

/** The brain's Automation folder, wherever this host keeps it. */
function automationDir(): string | null {
  const candidates = [process.env.GLADOS_AUTOMATION_DIR, path.join(home(), 'Sync/brain/Automation'), path.join(home(), 'Desktop/brain/Automation')];
  return candidates.find((p): p is string => Boolean(p && fs.existsSync(p))) ?? null;
}

const gsendBin = () => process.env.GSEND_BIN ?? path.join(home(), 'bin/gsend');
const drafterRails = () => [
  { label: 'claude CLI', p: process.env.CLAUDE_BIN ?? path.join(home(), '.local/bin/claude') },
  { label: 'playbook skill', p: process.env.BRAND_DEALS_SKILL ?? path.join(home(), '.claude/skills/brand-deals/SKILL.md') },
];
const bdpilotState = () => bdpilotStatePath();

async function gmailRun(): Promise<AgentRunResult> {
  if (parseInboxConfigs(runtimeEnv()).length === 0) {
    return notConfigured('No inboxes (INBOX_1..4_HOST/_USER/_PASS)');
  }
  const counts = await unreadCounts(runtimeEnv());
  const failed = counts.filter((c) => c.error);
  const total = counts.reduce((sum, c) => sum + c.unread, 0);
  return {
    ok: failed.length < counts.length,
    summary: counts
      .map((c) => `${c.inbox}: ${c.error ? `ERROR ${c.error.slice(0, 60)}` : `${c.unread} unread`}`)
      .join(' · ')
      .concat(` · total ${total} unread`),
    data: counts,
  };
}

async function whatsappRun(): Promise<AgentRunResult> {
  const status = await whatsappStatus();
  return { ok: status.state === 'connected', summary: status.detail, data: status.meta };
}

async function slackRun(): Promise<AgentRunResult> {
  if (!runtimeEnv().SLACK_BOT_TOKEN) return notConfigured('Slack (SLACK_BOT_TOKEN)');
  const messages = await recentMessages(10);
  return {
    ok: true,
    summary: `${messages.length} recent messages across ${new Set(messages.map((m) => m.channel)).size} channels`,
    data: messages,
  };
}

/** The brand-deal daemon (bdpilot) keeps its state in one JSON file. */
async function bdpilotStateRun(kind: 'approval' | 'inbound'): Promise<AgentRunResult> {
  const statePath = bdpilotState();
  if (!fs.existsSync(statePath)) return notConfigured('The brand-deal daemon state (BDPILOT_STATE)');
  const snap = await getBrandDeals();
  if (kind === 'approval') {
    return {
      ok: snap.sources.state,
      summary: `daemon state live · ${snap.counts.approval} drafts awaiting approval · ${snap.counts.sent} sent · ${snap.counts.unique} unique · last activity ${snap.lastActivityAt ?? 'n/a'}`,
      data: snap.counts,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    const seen = Array.isArray(raw.seen) ? raw.seen.length : null;
    return {
      ok: true,
      summary: seen === null ? 'daemon state readable · no inbound keys in it yet' : `inbound watcher live · ${seen} inbound messages tracked`,
      data: { seen },
    };
  } catch (err) {
    return { ok: false, summary: `daemon state unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const realAgents: RuntimeAgent[] = [
  // ── TECH ─────────────────────────────────────────────────────────────
  {
    id: 'conductor',
    name: 'Wizard',
    description: 'Broadcast fan-out plus instance-host availability for future bindings.',
    departmentId: 'dept-tech',
    configured: () => true,
    async run() {
      const stack = await localStackStatus();
      return {
        ok: stack.state === 'connected',
        summary: `Instance hosts on this machine: ${stack.detail} · all agents bound to the builtin runtime`,
        data: stack.meta,
      };
    },
  },
  {
    id: 'data-agent',
    name: 'Optimal Engine',
    description: 'Retrieval over the brain store; answers broadcasts by querying it. Grep fallback until the engine CLI is installed.',
    departmentId: 'dept-tech',
    configured: gbrainInstalled,
    async run() {
      const overview = await createGBrainProvider().overview();
      const { store, doctor } = overview;
      const biggest = [...store.folders].sort((a, b) => b.files - a.files)[0];
      return {
        ok: store.totalFiles > 0,
        summary: `${doctor.detail} · ${store.totalFiles} md pages on disk (largest: ${biggest?.name ?? 'n/a'} ${biggest?.files ?? 0})${doctor.connected ? '' : ' · grep fallback active (engine CLI pending from the maintainer)'}`,
        data: overview,
      };
    },
    async respond(message: string) {
      const results = await getBrainProvider().search(message);
      if (results.length === 0) {
        return { ok: false, summary: `Nothing in the brain matches "${message.slice(0, 80)}"` };
      }
      return {
        ok: true,
        summary: results
          .slice(0, 3)
          .map((r) => `${r.title}: ${r.snippet.slice(0, 100)}`)
          .join(' · '),
        data: results,
      };
    },
    chatTools(): LlmToolSpec[] {
      return [
        {
          name: 'searchGBrain',
          description: 'Search the brain store (markdown knowledge base) and return the top matching notes. Read-only.',
          parameters: z.object({ query: z.string().describe('what to look up in the knowledge base') }),
          execute: async (args) => {
            const query = typeof args.query === 'string' ? args.query : '';
            const results = await getBrainProvider().search(query);
            return results.slice(0, 5);
          },
        },
      ];
    },
  },
  {
    id: 'markdown-auditor',
    name: 'Markdown Auditor',
    description: 'Counts and sanity-checks the markdown pages in the brain store.',
    departmentId: 'dept-tech',
    configured: gbrainInstalled,
    async run() {
      const { store } = await createGBrainProvider().overview();
      return {
        ok: store.totalFiles > 0,
        summary: store.totalFiles > 0 ? `${store.totalFiles} markdown pages across ${store.folders.length} folders` : `No markdown pages found at ${store.path}`,
        data: store,
      };
    },
  },
  {
    id: 'vector-auditor',
    name: 'Vector Auditor',
    description: 'Reports embedding coverage from the engine index.',
    departmentId: 'dept-tech',
    configured: gbrainInstalled,
    async run() {
      const stats = await createGBrainProvider().stats();
      if (!stats) return notConfigured('The engine CLI (embeddings)');
      return { ok: stats.embedded > 0, summary: `${stats.embedded}/${stats.chunks} chunks embedded across ${stats.pages} pages`, data: stats };
    },
  },
  {
    id: 'notion-sync',
    name: 'Notion Sync',
    description: 'Mirrors Notion pages into the brain store.',
    departmentId: 'dept-tech',
    configured: () => envPresent('NOTION_API_KEY'),
    async run() {
      if (!envPresent('NOTION_API_KEY')) return notConfigured('Notion (NOTION_API_KEY)');
      const pages = await recentPages(10);
      return { ok: true, summary: `${pages.length} recently edited pages · latest: ${pages[0]?.title ?? 'none'}`, data: pages };
    },
  },
  {
    id: 'stack-monitor',
    name: 'Stack Monitor',
    description: 'Watches the local service ports and daemons on this host.',
    departmentId: 'dept-tech',
    configured: () => true,
    async run() {
      const stack = await localStackStatus();
      return { ok: stack.state === 'connected', summary: stack.detail, data: stack.meta };
    },
  },
  {
    id: 'daily-briefing',
    name: 'Daily Briefing',
    description: 'Morning digest compiled from the brain and the day\'s inboxes.',
    departmentId: 'dept-comms',
    configured: () => automationDir() != null && fs.existsSync(gsendBin()),
    async run() {
      const dir = automationDir();
      const probe = probePaths([
        { label: 'brain/Automation', p: dir ?? path.join(home(), 'Sync/brain/Automation') },
        { label: 'gsend', p: gsendBin() },
      ]);
      if (probe.found.length === 0) return notConfigured('The daily briefing job');
      return {
        ok: probe.missing.length === 0,
        summary: `Briefing rails: ${probe.found.join(' + ')} present${probe.missing.length ? ` · missing ${probe.missing.join(', ')}` : ' · job scheduled by the host'}`,
        data: probe,
      };
    },
  },
  {
    id: 'automation-jobs',
    name: 'Automation Jobs',
    description: 'Scheduled jobs registered with the host scheduler (launchd, cron or systemd).',
    departmentId: 'dept-comms',
    configured: () => automationDir() != null,
    async run() {
      const dir = automationDir();
      if (!dir) return notConfigured('The automation job runner (GLADOS_AUTOMATION_DIR)');
      const paused = fs.existsSync(path.join(dir, 'PAUSED'));
      const prefix = process.env.GLADOS_AGENT_JOB_PREFIX ?? 'glados.agent.';
      const laDir = path.join(home(), 'Library/LaunchAgents');
      const jobs = fs.existsSync(laDir) ? fs.readdirSync(laDir).filter((f) => f.startsWith(prefix)) : [];
      return {
        ok: true,
        summary: `${jobs.length} job definition(s) written · kill switch ${paused ? 'ON (PAUSED)' : 'off'}`,
        data: { jobs, paused },
      };
    },
  },
  // ── COMMS ────────────────────────────────────────────────────────────
  {
    id: 'comms-agent',
    name: 'Comms Agent',
    description: 'Unified feed over email and messaging inboxes.',
    departmentId: 'dept-comms',
    configured: () => envPresent('INBOX_1_USER', 'INBOX_1_PASS'),
    async run() {
      const [gmail, whatsapp, slack] = await Promise.all([gmailRun(), whatsappRun(), slackRun()]);
      const live = [gmail, whatsapp, slack].filter((r) => r.ok).length;
      const l = (r: AgentRunResult) => (r.ok ? 'LIVE' : 'DOWN');
      return {
        ok: live > 0,
        summary: `${live}/3 channels live · Email ${l(gmail)} · WhatsApp ${l(whatsapp)} · Slack ${l(slack)}`,
        data: { gmail, whatsapp, slack },
      };
    },
  },
  { id: 'gmail-worker', name: 'Email Worker', description: 'Unread counts and recent mail from the IMAP inboxes.', departmentId: 'dept-comms', configured: () => parseInboxConfigs(runtimeEnv()).length > 0, run: gmailRun },
  { id: 'whatsapp-worker', name: 'WhatsApp Worker', description: 'Local WhatsApp ChatStorage, read-only.', departmentId: 'dept-comms', configured: () => true, run: whatsappRun },
  { id: 'slack-worker', name: 'Slack Worker', description: 'Latest messages across joined Slack channels.', departmentId: 'dept-comms', configured: () => envPresent('SLACK_BOT_TOKEN'), run: slackRun },
  {
    id: 'draft-approval-bot',
    name: 'Draft Approval Bot',
    description: 'Announces every outbound draft to a chat channel for a one-tap approve or skip.',
    departmentId: 'dept-sales',
    configured: () => fs.existsSync(bdpilotState()),
    run: () => bdpilotStateRun('approval'),
  },
  {
    id: 'inbound-watcher',
    name: 'Inbound Watcher',
    description: 'Classifies new inbound mail into deal, support or noise.',
    departmentId: 'dept-sales',
    configured: () => fs.existsSync(bdpilotState()),
    run: () => bdpilotStateRun('inbound'),
  },
  {
    id: 'brand-deal-drafter',
    name: 'Brand Deal Drafter',
    description: 'Drafts negotiation replies from your rate card and playbook. Draft-only; never sends.',
    departmentId: 'dept-marketing-growth',
    configured: () => probePaths(drafterRails()).missing.length === 0,
    async run() {
      const probe = probePaths(drafterRails());
      return {
        ok: probe.missing.length === 0,
        summary: probe.missing.length === 0
          ? 'Drafting rails present: headless Claude + the playbook skill'
          : `Not wired on this host — missing ${probe.missing.join(', ')}`,
        data: probe,
      };
    },
  },
  {
    id: 'gsend-sender',
    name: 'Verified Sender',
    description: 'The single sanctioned send path: only approved drafts leave, from a verified address.',
    departmentId: 'dept-comms',
    configured: () => fs.existsSync(gsendBin()),
    async run() {
      const probe = probePaths([
        { label: 'gsend binary', p: gsendBin() },
        { label: 'gsend token', p: path.join(home(), '.config/gsend/token.json') },
        ...(process.env.GSEND_QUEUE_PLIST ? [{ label: 'queue daemon', p: process.env.GSEND_QUEUE_PLIST }] : []),
      ]);
      if (probe.found.length === 0) return notConfigured('The verified sender (GSEND_BIN)');
      return {
        ok: probe.found.includes('gsend binary') && probe.found.includes('gsend token'),
        summary: probe.missing.length === 0
          ? `Send path wired on this host: ${probe.found.join(' + ')}`
          : `Present: ${probe.found.join(', ')} · missing: ${probe.missing.join(', ')}`,
        data: probe,
      };
    },
  },
  // ── SALES ────────────────────────────────────────────────────────────
  {
    id: 'sales-agent',
    name: 'Sales Agent',
    description: 'Owns the pipeline: stage moves, follow-ups and proposal reminders.',
    departmentId: 'dept-sales',
    configured: () => envPresent('ATTIO_API_KEY') || fs.existsSync(bdpilotState()),
    async run() {
      const [crm, deals] = await Promise.all([attioStatus(), getBrandDeals()]);
      return {
        ok: crm.state === 'connected' || deals.sources.state,
        summary: `CRM ${crm.state} · brand deals ${deals.sources.state ? `LIVE (${deals.counts.approval} awaiting approval, ${deals.counts.sent} sent)` : 'not on this host'}`,
        data: { crm: crm.state, deals: deals.counts },
      };
    },
  },
  {
    id: 'crm-pulse',
    name: 'CRM Pulse',
    description: 'Reads the pipeline from your CRM. Read-only by default.',
    departmentId: 'dept-sales',
    configured: () => envPresent('ATTIO_API_KEY'),
    async run() {
      const s = await attioStatus();
      return { ok: s.state === 'connected', summary: s.detail, data: s.meta };
    },
  },
  {
    id: 'deal-scanner',
    name: 'Deal Scanner',
    description: 'Scans inbound for sponsorship and partnership offers.',
    departmentId: 'dept-sales',
    configured: () => false,
    async run() {
      return notConfigured('The deal scanner');
    },
  },
  {
    id: 'deal-alerts',
    name: 'Deal Alerts',
    description: 'Pushes deal-closed and action-needed alerts to your chat channel.',
    departmentId: 'dept-clients',
    configured: () => false,
    async run() {
      return notConfigured('Deal alerts');
    },
  },
  // ── MARKETING / GROWTH ───────────────────────────────────────────────
  {
    id: 'team-briefing',
    name: 'Team Briefing',
    description: 'Daily digest to your media or ops lead after the last send window.',
    departmentId: 'dept-marketing-growth',
    configured: () => false,
    async run() {
      return notConfigured('The team briefing');
    },
  },
  {
    id: 'adscout',
    name: 'Ad Scout',
    description: 'Ad intelligence: brand dossiers and creative signals from an ad library.',
    departmentId: 'dept-marketing-growth',
    configured: () => envPresent('FOREPLAY_API_KEY'),
    async run() {
      const client = createForeplayClient();
      if (!client) return notConfigured('Ad Scout (FOREPLAY_API_KEY)');
      const result = await runSyncCycle(client);
      const credits = result.remainingCredits != null ? ` · ${result.remainingCredits} credits left` : '';
      return {
        ok: true,
        summary: `${result.brands} brands · ${result.adsSeen} ads · ${result.signals.length} signals (${result.apiCalls} calls${credits}) — ${result.digest.slice(0, 300)}`,
        data: result,
      };
    },
    chatTools(): LlmToolSpec[] {
      return [
        {
          name: 'brandAdDossier',
          description:
            'Build an ad dossier for a brand by domain (e.g. "example.com"): live ad count, creative velocity, formats, longest-running creative with hooks, multi-page/whitelisting signal. Read-only; costs a few ad-library API credits.',
          parameters: z.object({ domain: z.string().describe('the brand website domain') }),
          execute: async (args) => {
            const domain = typeof args.domain === 'string' ? args.domain : '';
            const client = createForeplayClient();
            if (!client) return 'Ad library not configured — set FOREPLAY_API_KEY';
            const dossier = await buildBrandDossier(client, domain);
            return dossier ? renderDossier(dossier) : `No ad-library brand profiles found for ${domain}`;
          },
        },
      ];
    },
  },
  // Content Lab (docs/projects/content-lab SPEC §8): organic content intelligence, modelled on Ad Scout
  contentLabAgent(),
  ...agencyAgents,
];
