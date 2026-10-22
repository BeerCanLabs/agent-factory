/**
 * The person's own commands (§6.17 CL11): each is one tool from the catalog the manager uses, named and shaped for typing.
 * Parsing is all they do; whether the person may run a tool, the confirmation before a change and the call itself are
 * `exec.ts`'s, so a command cannot do what the manager could not.
 */

export class UsageError extends Error {}

export type Flags = { json: boolean; yes: boolean; active: boolean; limit?: number };

export type CommandSpec = {
  name: string;
  tool: string;
  /** Shown in help, e.g. `/budget <agent> <amount> daily|monthly`. */
  usage: string;
  summary: string;
  group: 'Look' | 'Money' | 'Agents' | 'Approvals';
  parse(args: string[], flags: Flags): Record<string, unknown>;
};

const one = (args: string[], what: string): string => {
  if (args.length !== 1) throw new UsageError(`give ${what}`);
  return args[0];
};
const none = (args: string[]): Record<string, never> => {
  if (args.length) throw new UsageError('this command takes no arguments');
  return {};
};
const idOf = (what: string) => (args: string[]) => ({ id: one(args, what) });

export function money(raw: string, what = 'an amount'): number {
  const n = Number(raw.replace(/^\$/, '').replace(/,/g, ''));
  if (!raw || !Number.isFinite(n) || n < 0) throw new UsageError(`${what} must be a number of dollars, like 5 or $12.50`);
  return n;
}

const PERIODS: Record<string, 'daily' | 'monthly'> = { daily: 'daily', day: 'daily', monthly: 'monthly', month: 'monthly' };
const FACTORY_KEYS: Record<string, string> = { total: 'totalMonthUsd', ai: 'aiMonthUsd', infra: 'infraMonthUsd' };

export const COMMANDS: CommandSpec[] = [
  { name: 'agents', tool: 'list_agents', usage: '/agents', summary: 'every agent with its state', group: 'Look', parse: (a) => none(a) },
  { name: 'agent', tool: 'get_agent', usage: '/agent <id>', summary: 'one agent in detail', group: 'Look', parse: idOf('an agent id') },
  { name: 'policy', tool: 'get_agent_policy', usage: '/policy <agent>', summary: "an agent's routes, models and budget", group: 'Look', parse: idOf('an agent id') },
  { name: 'status', tool: 'factory_metrics', usage: '/status', summary: 'active runs, agents by state, spend against budgets', group: 'Look', parse: (a) => none(a) },
  { name: 'runs', tool: 'list_runs', usage: '/runs [agent] [--active] [--limit n]', summary: 'recent runs', group: 'Look', parse: (a, f) => ({ ...(a[0] ? { agent: a[0] } : {}), ...(f.active ? { active: true } : {}), ...(f.limit ? { limit: f.limit } : {}) }) },
  { name: 'run', tool: 'get_run', usage: '/run <id>', summary: 'one run', group: 'Look', parse: idOf('a run id') },
  { name: 'ledger', tool: 'query_ledger', usage: '/ledger [agent] [--limit n]', summary: 'recent audit ledger rows', group: 'Look', parse: (a, f) => ({ ...(a[0] ? { agent: a[0] } : {}), ...(f.limit ? { limit: f.limit } : {}) }) },
  { name: 'models', tool: 'list_models', usage: '/models', summary: 'models the factory offers', group: 'Look', parse: (a) => none(a) },
  { name: 'skills', tool: 'list_skills', usage: '/skills', summary: 'the skills catalog', group: 'Look', parse: (a) => none(a) },
  { name: 'incidents', tool: 'get_triage', usage: '/incidents', summary: 'open faults', group: 'Look', parse: (a) => none(a) },
  { name: 'schedules', tool: 'list_schedules', usage: '/schedules', summary: 'scheduled wake-ups', group: 'Look', parse: (a) => none(a) },

  { name: 'spend', tool: 'get_spend', usage: '/spend', summary: 'spend so far, by agent', group: 'Money', parse: (a) => none(a) },
  {
    name: 'report',
    tool: 'get_spend_report',
    usage: '/report [current|last]',
    summary: 'the monthly spend report (AI and infrastructure)',
    group: 'Money',
    parse: (a) => {
      if (a.length > 1 || (a[0] && a[0] !== 'current' && a[0] !== 'last')) throw new UsageError('say current or last');
      return { period: a[0] ?? 'current' };
    },
  },
  { name: 'compute', tool: 'get_compute_spend', usage: '/compute', summary: 'infrastructure spend', group: 'Money', parse: (a) => none(a) },
  { name: 'budgets', tool: 'get_factory_budgets', usage: '/budgets', summary: 'the factory-wide monthly budgets', group: 'Money', parse: (a) => none(a) },
  {
    name: 'budget',
    tool: 'set_agent_budget',
    usage: '/budget <agent> <amount> daily|monthly',
    summary: "set an agent's spend limit",
    group: 'Money',
    parse: (a) => {
      if (a.length !== 3) throw new UsageError('usage: /budget <agent> <amount> daily|monthly');
      const period = PERIODS[a[2].toLowerCase()];
      if (!period) throw new UsageError('the period is daily or monthly');
      return { id: a[0], spendLimitUsd: money(a[1], 'the amount'), period };
    },
  },
  {
    name: 'factory-budget',
    tool: 'set_factory_budgets',
    usage: '/factory-budget total=<$> ai=<$> infra=<$> alert=0.8,1',
    summary: 'set the factory-wide monthly budgets (name only the ones to change)',
    group: 'Money',
    parse: (a) => {
      if (!a.length) throw new UsageError('usage: /factory-budget total=500 ai=300 infra=200 alert=0.8,1');
      const out: Record<string, unknown> = {};
      for (const pair of a) {
        const [k, v] = pair.split('=');
        if (v === undefined || v === '') throw new UsageError(`"${pair}" is not name=value`);
        if (k === 'alert') {
          const list = v.split(',').map(Number);
          if (!list.length || list.some((n) => !Number.isFinite(n) || n <= 0 || n > 10)) throw new UsageError('alert is fractions like 0.8,1');
          out.alertAt = list;
        } else if (FACTORY_KEYS[k]) out[FACTORY_KEYS[k]] = money(v, k);
        else throw new UsageError(`unknown budget "${k}": use total, ai, infra or alert`);
      }
      return out;
    },
  },

  { name: 'pause', tool: 'pause_agent', usage: '/pause <agent>', summary: 'the kill-switch: stop egress and wake-ups', group: 'Agents', parse: idOf('an agent id') },
  { name: 'resume', tool: 'resume_agent', usage: '/resume <agent>', summary: 'resume a paused agent', group: 'Agents', parse: idOf('an agent id') },
  { name: 'isolate', tool: 'isolate_agent', usage: '/isolate <agent>', summary: "isolate an agent's egress", group: 'Agents', parse: idOf('an agent id') },
  { name: 'wake', tool: 'wake_agent', usage: '/wake <agent>', summary: 'start a run', group: 'Agents', parse: idOf('an agent id') },
  { name: 'reset', tool: 'reset_agent', usage: '/reset <agent>', summary: "end an agent's runs and put it to sleep", group: 'Agents', parse: idOf('an agent id') },
  { name: 'cancel', tool: 'cancel_run', usage: '/cancel <run id>', summary: 'cancel an active run', group: 'Agents', parse: idOf('a run id') },
  { name: 'retire', tool: 'retire_agent', usage: '/retire <agent>', summary: 'retire an agent (reversible until purged)', group: 'Agents', parse: idOf('an agent id') },
  { name: 'reinstate', tool: 'reinstate_agent', usage: '/reinstate <agent>', summary: 'bring a retired agent back', group: 'Agents', parse: idOf('an agent id') },

  { name: 'approvals', tool: 'list_approvals', usage: '/approvals', summary: 'tool calls held for a person', group: 'Approvals', parse: (a) => none(a) },
  {
    name: 'approve',
    tool: 'decide_approval',
    usage: '/approve <id> [notes]',
    summary: 'approve a held tool call',
    group: 'Approvals',
    parse: (a) => {
      if (!a[0]) throw new UsageError('give an approval id');
      return { id: a[0], decision: 'approve', ...(a.length > 1 ? { notes: a.slice(1).join(' ') } : {}) };
    },
  },
  {
    name: 'reject',
    tool: 'decide_approval',
    usage: '/reject <id> [notes]',
    summary: 'reject a held tool call',
    group: 'Approvals',
    parse: (a) => {
      if (!a[0]) throw new UsageError('give an approval id');
      return { id: a[0], decision: 'reject', ...(a.length > 1 ? { notes: a.slice(1).join(' ') } : {}) };
    },
  },
];

export const findCommand = (name: string): CommandSpec | undefined => COMMANDS.find((c) => c.name === name.replace(/^\//, '').toLowerCase());

/** Words, with "double quotes" kept together. */
export function tokenize(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

export function parseFlags(tokens: string[]): { args: string[]; flags: Flags } {
  const flags: Flags = { json: false, yes: false, active: false };
  const args: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--json') flags.json = true;
    else if (t === '--yes' || t === '-y') flags.yes = true;
    else if (t === '--active') flags.active = true;
    else if (t === '--limit') {
      const n = Number(tokens[++i]);
      if (!Number.isInteger(n) || n < 1) throw new UsageError('--limit needs a whole number of 1 or more');
      flags.limit = n;
    } else if (t.startsWith('--')) throw new UsageError(`unknown option ${t}`);
    else args.push(t);
  }
  return { args, flags };
}

/** The command line as help: grouped, one line each. */
export function commandHelp(): string {
  const groups = ['Look', 'Money', 'Agents', 'Approvals'] as const;
  return groups
    .map((g) => `${g}:\n${COMMANDS.filter((c) => c.group === g).map((c) => `  ${c.usage.padEnd(46)} ${c.summary}`).join('\n')}`)
    .join('\n');
}
