/**
 * The skills screen's logic, with no React and no browser (DESIGN_AUTHORITY.md §6.14 SK1 to SK7). The console has no
 * component test runner, so anything that decides what the screen shows or allows lives here, where `tsx --test` can
 * prove it. The components only draw what this says.
 *
 * The control plane enforces every role and rule (§6.12 A2). This file only decides what to *offer*: a button hidden
 * here is still refused there.
 */
import type { SkillAction, SkillAdopter, SkillSummary, SkillVersion, SkillVisibility } from '../../api/types.js';

export type StatusKey = 'pending' | 'running' | 'passed' | 'failed' | 'approved' | 'rejected' | 'revoked' | 'retired';

/** What a version's badge says: its decision, or where its checks are. A retired version says so, whatever else it was. */
export function statusOf(v: Pick<SkillVersion, 'status' | 'tests' | 'checkRun' | 'revoked' | 'retired'>): StatusKey {
  if (v.retired) return 'retired';
  if (v.status === 'approved') return 'approved';
  if (v.status === 'rejected') return v.revoked ? 'revoked' : 'rejected';
  if (v.tests === 'passed') return 'passed';
  if (v.tests === 'failed') return 'failed';
  return v.checkRun ? 'running' : 'pending';
}

/**
 * What an admin decided about a version, in words: it stays "Approved" or "Rejected" after the skill is retired, because
 * retiring is a separate act by someone else, shown on its own line (SK6).
 */
export const decisionLabel = (v: Pick<SkillVersion, 'status' | 'revoked'>): string =>
  v.status === 'approved' ? 'Approved' : v.status === 'rejected' ? (v.revoked ? 'Revoked' : 'Rejected') : 'Pending';

export const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '');
export const shortSha = (sha: string) => sha.slice(0, 7);
export const key = (id: string, version: string) => `${id}@${version}`;
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A browsable link for the pin: GitHub-style `tree/<sha>/<path>` on github.com, the repository itself elsewhere. */
export function sourceLinks(v: { repo: string; path: string; commit: string }): { repo: string; pin: string } {
  const base = v.repo.replace(/\/+$/, '').replace(/\.git$/, '');
  let host = '';
  try {
    host = new URL(base).hostname;
  } catch {
    // shown as text only
  }
  const pin = host === 'github.com' ? `${base}/tree/${v.commit}${v.path === '.' ? '' : `/${v.path}`}` : base;
  return { repo: base, pin };
}

// ---- Public and private (SK1, SK7) ------------------------------------------------------------------------------

/** A control plane or record that predates public and private skills sends neither field: the skill is public. */
export const visibilityOf = (s: { visibility?: SkillVisibility }): SkillVisibility => (s.visibility === 'private' ? 'private' : 'public');

export type VisibilityFilter = 'all' | 'public' | 'private';

export function visibilityCounts(skills: ReadonlyArray<{ visibility?: SkillVisibility }>): Record<VisibilityFilter, number> {
  const priv = skills.filter((s) => visibilityOf(s) === 'private').length;
  return { all: skills.length, public: skills.length - priv, private: priv };
}

/** The catalog narrowed by visibility and by a search over id, name, description and owner (case-insensitive). */
export function filterSkills<T extends Pick<SkillSummary, 'id' | 'name' | 'description' | 'visibility' | 'owner'>>(skills: readonly T[], filter: VisibilityFilter, query: string): T[] {
  const q = query.trim().toLowerCase();
  return skills.filter((s) => {
    if (filter !== 'all' && visibilityOf(s) !== filter) return false;
    if (!q) return true;
    return [s.id, s.name, s.description, s.owner ?? ''].some((field) => field.toLowerCase().includes(q));
  });
}

// ---- Actions and holds (SK2, E9) --------------------------------------------------------------------------------

export type HoldKind = 'hitl' | 'autonomous';
export const holdKind = (a: Pick<SkillAction, 'hold'>): HoldKind => (a.hold ? 'hitl' : 'autonomous');
export const holdLabel = (a: Pick<SkillAction, 'hold'>): string => (a.hold ? 'Human approval' : 'Autonomous');

export function actionCounts(actions: readonly SkillAction[] | undefined): { hitl: number; autonomous: number } {
  const list = actions ?? [];
  const hitl = list.filter((a) => a.hold).length;
  return { hitl, autonomous: list.length - hitl };
}

/** Held actions first (they need a person), then by route, path and method, so the table reads the same every time. */
export function sortActions(actions: readonly SkillAction[] | undefined): SkillAction[] {
  return [...(actions ?? [])].sort((a, b) => Number(b.hold) - Number(a.hold) || a.route.localeCompare(b.route) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.id.localeCompare(b.id));
}

// ---- Adopters (SK3, SK5, SK7) ----------------------------------------------------------------------------------

/** What an admin may do to one adopter row. A request is approved or rejected (withdrawing it is the requester's act); an adoption is removed or upgraded. */
export type AdopterOffer = { approve: boolean; reject: boolean; remove: boolean; upgrade: boolean };
export type AdopterRow = SkillAdopter & { offer: AdopterOffer };

export function adopterRows(adopters: readonly SkillAdopter[] | undefined, skill: Pick<SkillSummary, 'retired'>, perms: { canDecide: boolean }): AdopterRow[] {
  const rows = (adopters ?? []).map((a) => {
    const requested = a.state === 'requested';
    const offer: AdopterOffer = {
      approve: perms.canDecide && requested && !skill.retired,
      reject: perms.canDecide && requested,
      remove: perms.canDecide && !requested,
      // An upgrade is a request for the newer version that an admin approves in the same step; never for a retired skill.
      upgrade: perms.canDecide && a.state === 'approved' && a.upgradeAvailable === true && !skill.retired,
    };
    return { ...a, offer };
  });
  // Requests first (they wait on someone), then by agent.
  return rows.sort((a, b) => Number(b.state === 'requested') - Number(a.state === 'requested') || a.agentId.localeCompare(b.agentId));
}

export function adopterCounts(adopters: readonly SkillAdopter[] | undefined): { approved: number; requested: number } {
  const list = adopters ?? [];
  const requested = list.filter((a) => a.state === 'requested').length;
  return { approved: list.length - requested, requested };
}

/** Versions whose checks passed and that wait for an admin. */
export const queueCount = (skills: readonly Pick<SkillSummary, 'versions'>[]): number =>
  skills.reduce((n, s) => n + s.versions.filter((v) => v.status === 'pending' && v.tests === 'passed').length, 0);

export const adoptionRequestCount = (skills: readonly Pick<SkillSummary, 'adopters'>[]): number =>
  skills.reduce((n, s) => n + (s.adopters ?? []).filter((a) => a.state === 'requested').length, 0);

/** The skills open when the screen first loads: the ones with work waiting. */
export const openByDefault = (skills: readonly (Pick<SkillSummary, 'id' | 'versions' | 'adopters'>)[]): string[] =>
  skills.filter((s) => s.versions.some((v) => v.status === 'pending') || (s.adopters ?? []).some((a) => a.state === 'requested')).map((s) => s.id);

// ---- Retiring a skill (SK6) --------------------------------------------------------------------------------------

/** Retiring is offered to an admin, once: a retired skill has nothing left to retire. */
export const canRetire = (s: Pick<SkillSummary, 'retired'>, perms: { canRetireSkills: boolean }): boolean => perms.canRetireSkills && s.retired !== true;

/**
 * Who retiring a skill would affect: the agents that run it (their configuration pins it). Pending requests do not count;
 * they are simply dropped. While any agent runs it the control plane refuses a plain retire, and a forced one pauses them
 * and rebuilds them without the skill.
 */
export function retireImpact(adopters: readonly SkillAdopter[] | undefined): { agents: string[]; inUse: boolean; requestsDropped: number } {
  const list = adopters ?? [];
  const agents = [...new Set(list.filter((a) => a.state === 'approved').map((a) => a.agentId))].sort();
  return { agents, inUse: agents.length > 0, requestsDropped: list.filter((a) => a.state === 'requested').length };
}

/** A forced retire reaches running agents, so it asks for the skill's id typed out; a retire that reaches none does not. */
export function retireConfirmed(typed: string, skillId: string, impact: { inUse: boolean }): boolean {
  return impact.inUse ? typed.trim() === skillId : true;
}

/** A short line for the dialog: what this will do to the agents named. */
export function retireEffect(impact: { agents: string[]; requestsDropped: number }): string {
  const parts: string[] = [];
  if (impact.agents.length) parts.push(`pause ${impact.agents.join(', ')}, remove the skill from ${impact.agents.length === 1 ? 'its' : 'their'} configuration, and rebuild ${impact.agents.length === 1 ? 'it' : 'them'} without it`);
  if (impact.requestsDropped) parts.push(`drop ${impact.requestsDropped} pending adoption request${impact.requestsDropped === 1 ? '' : 's'}`);
  return parts.length ? `This will ${parts.join(' and ')}.` : 'No agent runs this skill.';
}
