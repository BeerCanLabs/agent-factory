// #520: what the Approvals page shows for a GAP-259 decision hold. The payload shape is whatever the
// conductor already sends (a budget object, or a bare number). Richer fields (stories, DoR, rates, a
// FinOps link) are rendered when they are present. Fields the conductor does not send stay on
// BeerCanLabs/agentic-sdlc#136; this module does not invent them.
import type { ApprovalItem } from '../api/types.js';

/** The page subtitle for an egress hold or a tool call. Kept identical to the pre-#520 copy. */
export const EGRESS_PAGE_INTRO =
  'Held by the gatekeeper-egress: nothing here has been sent. Approving sends exactly what you see, once.';

/** The page subtitle while a decision hold is selected. The run is not paused, and approving sends nothing. */
export const DECISION_PAGE_INTRO = 'A decision the agent asked for. The run is not paused, and approving sends nothing.';

/** Shown when the payload has no story list. Exact copy from the #520 plan. */
export const STORIES_NOT_FILED = 'stories not filed yet';

/**
 * A cap in USD, from a number or the text a person types. `null` when it is not one.
 * Same amounts the control plane accepts (`parseCapUsd` in `packages/control-plane/src/decision-holds.ts`):
 * `2500`, `2500.5`, `$2,500.00`.
 */
const CAP_TEXT = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?$/;

export function parseCapUsd(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= 1e9 ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(CAP_TEXT);
  if (!m) return null;
  const n = Number(`${m[1].replace(/,/g, '')}${m[2] ?? ''}`);
  return Number.isFinite(n) && n <= 1e9 ? n : null;
}

/** The text to put in the cap field for a payload number, or '' when it is not a usable cap. */
export function capInputFromNumber(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e9) return '';
  const plain = String(n);
  const parsed = parseCapUsd(plain);
  if (parsed !== null && Math.abs(parsed - n) < 1e-9) return plain;
  const text = (Math.round(n * 100) / 100).toFixed(2);
  return parseCapUsd(text) === null ? '' : text;
}

export function formatUsd(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  const sign = n < 0 ? '-' : '';
  const [whole, frac] = (Math.round(Math.abs(n) * 100) / 100).toFixed(2).split('.');
  return `${sign}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

export interface RoleCostRow {
  stage: string;
  role: string;
  model: string;
  costUsd?: number;
}

export interface StoryRow {
  title: string;
  dor?: string;
  dod?: string;
  costUsd?: number;
}

export interface EpicRow {
  title: string;
  dor?: string;
  dod?: string;
}

export interface StageCostRow {
  stage: string;
  costUsd?: number;
}

export interface ModelRateRow {
  model: string;
  inputPerMTok?: number;
  outputPerMTok?: number;
}

export interface BudgetView {
  /** Set when `payload.budget` is a number rather than an estimate object. */
  amountOnly?: number;
  expectedUsd?: number;
  p90Usd?: number;
  modelCostUsd?: number;
  infraCostUsd?: number;
  method?: string;
  uncertainty?: string;
  estimate?: string;
  effortPasses?: number;
  passesPerStory?: number;
  byAgent: RoleCostRow[];
  byStage: StageCostRow[];
  byStory: StoryRow[];
  rates: ModelRateRow[];
}

export interface DecisionCard {
  title: string;
  summary: string;
  link?: string;
  requestKey?: string;
  agentId: string;
  runId: string;
  approvers: string[];
  requiresCap: boolean;
  budget?: BudgetView;
  stories: StoryRow[];
  /** True when at least one story row was present (possibly with DoR / DoD). */
  storiesFiled: boolean;
  epics: EpicRow[];
  finopsUrl?: string;
}

export function isDecisionHold(a: ApprovalItem | undefined | null): a is ApprovalItem & { kind: 'decision' } {
  return a?.kind === 'decision';
}

/** Approve stays off while a requiresCap hold has no usable cap. Reject is never blocked by this. */
export function approveBlocked(a: ApprovalItem, capText: string): boolean {
  if (!isDecisionHold(a) || !a.hold?.requiresCap) return false;
  return parseCapUsd(capText) === null;
}

/** What Approve / Reject hand to `decideApproval`. Egress Reject drops notes, matching the button that clears them. */
export function decisionSubmit(
  a: ApprovalItem,
  decision: 'approve' | 'reject',
  notes: string,
  capText: string,
): { blocked: true } | { blocked: false; notes?: string; capUsd?: number } {
  if (decision === 'approve' && approveBlocked(a, capText)) return { blocked: true };
  const trimmed = notes.trim();
  const sendNotes = decision === 'reject' && !isDecisionHold(a) ? undefined : trimmed || undefined;
  const capUsd = decision === 'approve' && isDecisionHold(a) && a.hold?.requiresCap ? (parseCapUsd(capText) ?? undefined) : undefined;
  return { blocked: false, notes: sendNotes, capUsd };
}

/**
 * `passes_per_story` is the revision assumption. `effort_passes` is the total
 * (stories times that assumption), not the assumption itself.
 */
export function revisionLines(budget: BudgetView): string[] {
  const out: string[] = [];
  if (budget.passesPerStory !== undefined) out.push(`Passes per story: ${budget.passesPerStory}`);
  if (budget.effortPasses !== undefined) out.push(`Effort passes: ${budget.effortPasses}`);
  return out;
}

/** Confirm-dialog body. Decision holds never say the run is paused or that an egress request will be sent. */
export function approveConfirm(a: ApprovalItem, opts: { capUsd?: number; linkedIn?: boolean } = {}): string {
  if (isDecisionHold(a)) {
    const cap = opts.capUsd !== undefined ? ` with a cap of ${formatUsd(opts.capUsd)}` : '';
    return `The run is not paused. Approving records this decision${cap}. Nothing is sent.`;
  }
  if (a.kind === 'held') {
    return `${a.agentId} will send exactly what you reviewed, once${opts.linkedIn ? ', and it goes live on your LinkedIn profile' : ''}. Any change would need your approval again.`;
  }
  return 'The run continues and makes this tool call once.';
}

export function rejectConfirm(a: ApprovalItem, notes: string): string {
  if (isDecisionHold(a)) return `Nothing is sent. ${a.agentId} is told it was rejected${notes.trim() ? ', with your notes' : ''}.`;
  if (notes.trim()) return `Nothing is sent. ${a.agentId} gets your notes and can submit a revised version for you to review.`;
  return `Nothing is sent, and ${a.agentId} is told it was rejected.`;
}

const DOR_KEYS = ['dor', 'dor_status', 'dorStatus', 'definition_of_ready', 'ready'];
const DOD_KEYS = ['dod', 'dod_status', 'dodStatus', 'definition_of_done', 'done'];
const FINOPS_KEYS = ['finops_url', 'finops_link', 'estimate_url', 'estimate_link', 'estimate_comment_url', 'comment_url', 'commit_url'];

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function text(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return '';
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function httpsUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function statusText(v: unknown): string | undefined {
  if (typeof v === 'boolean') return v ? 'pass' : 'not passed';
  const direct = text(v);
  if (direct && typeof v !== 'object') return direct;
  const rec = asRecord(v);
  if (!rec) return undefined;
  const nested = text(rec.status ?? rec.state ?? rec.result);
  return nested || undefined;
}

function pick(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const s = statusText(rec[k]);
    if (s) return s;
  }
  return undefined;
}

function storyRow(v: unknown): StoryRow {
  if (typeof v === 'string') return { title: v.trim() };
  const rec = asRecord(v) ?? {};
  return {
    title: text(rec.title ?? rec.name ?? rec.summary ?? rec.story ?? rec.id),
    dor: pick(rec, DOR_KEYS),
    dod: pick(rec, DOD_KEYS),
    costUsd: num(rec.cost_usd ?? rec.costUsd),
  };
}

function epicRow(v: unknown): EpicRow {
  if (typeof v === 'string') return { title: v.trim() };
  const rec = asRecord(v) ?? {};
  return {
    title: text(rec.title ?? rec.name ?? rec.summary ?? rec.id),
    dor: pick(rec, DOR_KEYS),
    dod: pick(rec, DOD_KEYS),
  };
}

function listOf(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function epicSource(payload: Record<string, unknown> | undefined, budget: Record<string, unknown> | undefined): unknown[] | undefined {
  return listOf(payload?.epics) ?? listOf(budget?.epics);
}

function storySource(payload: Record<string, unknown> | undefined, budget: Record<string, unknown> | undefined, epics: unknown[] | undefined): unknown[] | undefined {
  const direct = listOf(payload?.stories) ?? listOf(budget?.stories);
  if (direct) return direct;
  if (!epics) return undefined;
  const nested: unknown[] = [];
  let any = false;
  for (const epic of epics) {
    const stories = listOf(asRecord(epic)?.stories);
    if (stories) {
      any = true;
      nested.push(...stories);
    }
  }
  return any ? nested : undefined;
}

function roleRows(v: unknown): RoleCostRow[] {
  const list = listOf(v);
  if (!list) return [];
  return list.map((item) => {
    const rec = asRecord(item) ?? {};
    return {
      stage: text(rec.stage),
      role: text(rec.role),
      model: text(rec.model),
      costUsd: num(rec.cost_usd ?? rec.costUsd),
    };
  });
}

function stageRows(v: unknown): StageCostRow[] {
  const list = listOf(v);
  if (list) {
    return list.map((item) => {
      const rec = asRecord(item) ?? {};
      return { stage: text(rec.stage ?? rec.name), costUsd: num(rec.cost_usd ?? rec.costUsd ?? rec.cost) };
    });
  }
  const rec = asRecord(v);
  if (!rec) return [];
  return Object.entries(rec).map(([stage, val]) => ({
    stage,
    costUsd: num(val) ?? num(asRecord(val)?.cost_usd),
  }));
}

function rateRows(v: unknown): ModelRateRow[] {
  const list = listOf(v);
  if (list) {
    return list
      .map((item) => {
        const rec = asRecord(item) ?? {};
        return {
          model: text(rec.model ?? rec.name ?? rec.id),
          inputPerMTok: num(rec.input_per_mtok ?? rec.input_per_1m ?? rec.inputPerMTok ?? rec.input),
          outputPerMTok: num(rec.output_per_mtok ?? rec.output_per_1m ?? rec.outputPerMTok ?? rec.output),
        };
      })
      .filter((r) => r.model || r.inputPerMTok !== undefined || r.outputPerMTok !== undefined);
  }
  const rec = asRecord(v);
  if (!rec) return [];
  return Object.entries(rec).map(([model, val]) => {
    const inner = asRecord(val);
    if (!inner) return { model, inputPerMTok: num(val) };
    return {
      model,
      inputPerMTok: num(inner.input_per_mtok ?? inner.input_per_1m ?? inner.input),
      outputPerMTok: num(inner.output_per_mtok ?? inner.output_per_1m ?? inner.output),
    };
  });
}

function finopsFrom(rec: Record<string, unknown> | undefined): string | undefined {
  if (!rec) return undefined;
  for (const key of FINOPS_KEYS) {
    const url = httpsUrl(rec[key]);
    if (url) return url;
  }
  return undefined;
}

function readBudget(payload: Record<string, unknown> | undefined): { budget?: BudgetView; finopsUrl?: string } {
  const finopsOnPayload = finopsFrom(payload);
  const raw = payload?.budget;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { budget: emptyBudget({ amountOnly: raw }), finopsUrl: finopsOnPayload };
  }
  const b = asRecord(raw);
  if (!b) return { finopsUrl: finopsOnPayload };
  const estimateRaw = b.estimate;
  const estimateUrl = httpsUrl(estimateRaw);
  const estimate = typeof estimateRaw === 'string' && !estimateUrl ? estimateRaw.trim() : undefined;
  const budget = emptyBudget({
    expectedUsd: num(b.total_expected_usd),
    p90Usd: num(b.total_p90_usd),
    modelCostUsd: num(b.model_cost_usd),
    infraCostUsd: num(b.infra_cost_usd),
    method: text(b.method) || undefined,
    uncertainty: text(b.uncertainty) || undefined,
    estimate: estimate || undefined,
    effortPasses: num(b.effort_passes ?? payload?.effort_passes),
    passesPerStory: num(b.passes_per_story ?? payload?.passes_per_story),
    byAgent: roleRows(b.by_agent),
    byStage: stageRows(b.by_stage),
    byStory: (listOf(b.by_story) ?? []).map(storyRow),
    rates: rateRows(b.model_rates ?? b.rates ?? payload?.model_rates),
  });
  const finopsUrl = finopsFrom(b) ?? estimateUrl ?? finopsOnPayload;
  const has =
    budget.expectedUsd !== undefined ||
    budget.p90Usd !== undefined ||
    budget.modelCostUsd !== undefined ||
    budget.infraCostUsd !== undefined ||
    budget.method ||
    budget.uncertainty ||
    budget.estimate ||
    budget.effortPasses !== undefined ||
    budget.passesPerStory !== undefined ||
    budget.byAgent.length > 0 ||
    budget.byStage.length > 0 ||
    budget.byStory.length > 0 ||
    budget.rates.length > 0;
  return { budget: has ? budget : undefined, finopsUrl };
}

function emptyBudget(over: Omit<BudgetView, 'byAgent' | 'byStage' | 'byStory' | 'rates'> & Partial<Pick<BudgetView, 'byAgent' | 'byStage' | 'byStory' | 'rates'>>): BudgetView {
  return {
    byAgent: [],
    byStage: [],
    byStory: [],
    rates: [],
    ...over,
  };
}

/** The list label. LinkedIn posts and held requests keep the wording they had before decision holds. */
export function approvalLabel(a: ApprovalItem): string {
  if (a.request?.preview === 'linkedin-post') return 'LinkedIn post';
  if (a.kind === 'held') return `${a.request?.method ?? ''} ${a.route}`;
  if (a.kind === 'decision') return a.hold?.title?.trim() || a.tool;
  return a.tool;
}

export function decisionCard(a: ApprovalItem): DecisionCard | null {
  if (!isDecisionHold(a)) return null;
  const hold = a.hold;
  const payload = asRecord(hold?.payload);
  const budgetRec = asRecord(payload?.budget);
  const epics = (epicSource(payload, budgetRec) ?? []).map(epicRow).filter((e) => e.title || e.dor || e.dod);
  const storiesRaw = storySource(payload, budgetRec, epicSource(payload, budgetRec));
  const stories = (storiesRaw ?? []).map(storyRow).filter((s) => s.title || s.dor || s.dod || s.costUsd !== undefined);
  const { budget, finopsUrl } = readBudget(payload);
  return {
    title: hold?.title?.trim() || a.tool,
    summary: hold?.summary?.trim() ?? '',
    link: httpsUrl(hold?.link),
    requestKey: hold?.requestKey,
    agentId: a.agentId,
    runId: a.runId,
    approvers: (hold?.approvers ?? []).filter((x): x is string => typeof x === 'string' && x.trim() !== ''),
    requiresCap: Boolean(hold?.requiresCap),
    budget,
    stories,
    storiesFiled: stories.length > 0,
    epics,
    finopsUrl,
  };
}

/** Cap field default: the payload P90 when this hold requires a cap and that number is usable. */
export function defaultCapText(a: ApprovalItem | undefined | null): string {
  if (!a) return '';
  const card = decisionCard(a);
  if (!card?.requiresCap || card.budget?.p90Usd === undefined) return '';
  return capInputFromNumber(card.budget.p90Usd);
}
