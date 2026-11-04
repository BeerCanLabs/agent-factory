// #436: People & Access grants, grouped per person by role and scope, with friendly names (no React here, so it is testable).
import type { GrantView, PrincipalView } from '../api/client.js';

export const FLEET_ROLES = ['viewer', 'operator', 'approver', 'admin', 'budget-owner'] as const;
export const AGENT_ROLES = ['member', 'accountable-lead', 'content-owner', 'agent-member'] as const;

export interface PersonAccess {
  subject: string;
  name: string;
  fleet: { role: string; grantId: string }[];
  /** Per-agent roles grouped by role: one row per role with the agents it covers. */
  agents: { role: string; items: { id: string; name: string; grantId: string }[] }[];
  other: { role: string; scope: string; grantId: string }[];
}

const active = (g: GrantView) => !g.state || g.state === 'active';

export function groupGrants(principals: PrincipalView[], grants: GrantView[], agentNames: Record<string, string> = {}): PersonAccess[] {
  const names = new Map(principals.map((p) => [p.id, p.displayName || p.id]));
  const by = new Map<string, PersonAccess>();
  const get = (subject: string) => {
    let p = by.get(subject);
    if (!p) by.set(subject, (p = { subject, name: names.get(subject) ?? subject, fleet: [], agents: [], other: [] }));
    return p;
  };
  for (const g of grants.filter(active)) {
    const p = get(g.subject);
    if (g.scope.kind === 'fleet') p.fleet.push({ role: g.role, grantId: g.id });
    else if (g.scope.kind === 'agent' && g.scope.id) {
      let row = p.agents.find((r) => r.role === g.role);
      if (!row) p.agents.push((row = { role: g.role, items: [] }));
      row.items.push({ id: g.scope.id, name: agentNames[g.scope.id] ?? g.scope.id, grantId: g.id });
    } else p.other.push({ role: g.role, scope: `${g.scope.kind}:${g.scope.id ?? ''}`, grantId: g.id });
  }
  for (const p of by.values()) {
    p.fleet.sort((a, b) => a.role.localeCompare(b.role));
    p.agents.sort((a, b) => a.role.localeCompare(b.role));
    for (const r of p.agents) r.items.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Case-insensitive search over the person's name and id, roles, and agent names/ids. */
export function filterAccess(rows: PersonAccess[], q: string): PersonAccess[] {
  const t = q.trim().toLowerCase();
  if (!t) return rows;
  return rows.filter((p) =>
    [p.name, p.subject, ...p.fleet.map((f) => f.role), ...p.agents.flatMap((r) => [r.role, ...r.items.flatMap((i) => [i.id, i.name])]), ...p.other.flatMap((o) => [o.role, o.scope])]
      .some((s) => s.toLowerCase().includes(t)),
  );
}

/** The grants one Grant action creates: one fleet grant, or one per selected agent. */
export function grantsToCreate(subject: string, role: string, scope: 'fleet' | 'agents', agentIds: string[]): { subject: string; role: string; scope: GrantView['scope'] }[] {
  if (!subject || !role) return [];
  if (scope === 'fleet') return (FLEET_ROLES as readonly string[]).includes(role) ? [{ subject, role, scope: { kind: 'fleet' } }] : [];
  if (!(AGENT_ROLES as readonly string[]).includes(role)) return [];
  return [...new Set(agentIds)].map((id) => ({ subject, role, scope: { kind: 'agent', id } }));
}
