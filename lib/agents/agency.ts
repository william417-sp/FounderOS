import type { AgentRunResult, RuntimeAgent } from '@/lib/agents/runtime';

/**
 * William's agency roster (Puerto Rico web/app studio). Roster seats only:
 * no runtime is bound yet, so run() reports that honestly instead of faking work.
 */
function seat(id: string, name: string, departmentId: string, description: string): RuntimeAgent {
  return {
    id,
    name,
    description,
    departmentId,
    configured: () => false,
    async run(): Promise<AgentRunResult> {
      return { ok: false, summary: `${name} has no runtime bound yet — see /setup` };
    },
  };
}

export const agencyAgents: RuntimeAgent[] = [
  seat('chief-of-staff', 'Chief of Staff', 'dept-tech', 'Operations and routing: triages incoming work, assigns it to the right agent and keeps the studio on schedule.'),
  seat('sales-rep', 'Sales Representative', 'dept-sales', 'Outbound pitches to local Puerto Rico businesses: prospect lists, website/mockup pitches and follow-ups.'),
  seat('client-sites', 'Client Sites', 'dept-clients', 'Builds and ships client websites and mockups for local businesses, from brief to launch.'),
  seat('frontend-designer', 'Front-End Designer', 'dept-clients', 'Visual design for client sites and apps: layouts, mockups, brand styling and UI polish.'),
  seat('clip-studio', 'Clip Studio', 'dept-marketing-growth', 'Short-form video content: cuts, captions and posting for the studio and its clients.'),
  seat('jarvis', 'JARVIS', 'dept-comms', 'Agency assistant: inbox, calendar, reminders and quick answers for William across the studio.'),
  seat('bookkeeper', 'Bookkeeper', 'dept-finance', 'Finance and bookkeeping: categorizes statements, tracks client invoices and monthly income/expenses.'),
];
