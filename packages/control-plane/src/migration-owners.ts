/**
 * Owner-string conversion and zero-orphan dry-run verifier (DESIGN_AUTHORITY.md §6.12 A2, plans/factory-auth.md S18).
 *
 * Converts legacy owner strings (`cloudflare:<email>`, `oidc:<email>`, raw `<email>`, or `user:<id>`)
 * from ConfigStore and agent records into canonical `user:<id>` principals and GrantStore grants:
 * - Personal agents and skills -> single `content-owner` grant
 * - Team agents -> `accountable-lead` grant (designated primary lead) and `member` grants (co-owners)
 *
 * Zero-Orphan Cutover Gate:
 * Every non-retired, non-builtin agent must have a resolvable content-owner (for personal)
 * or accountable-lead (for team). If ANY live agent lacks a resolvable owner/lead, the gate returns
 * `ready: false` and blocks `apply` (`dryRun: false`) atomically before making any writes.
 *
 * Idempotent Apply + Audit Ledgering:
 * When `dryRun: false` and `ready: true`:
 * - Missing canonical principals are materialized in PrincipalStore.
 * - Grants are written in GrantStore (idempotently skipping existing active matching grants).
 * - Each converted mapping emits an `OWNER_CONVERTED` action row to the hash-chained audit ledger.
 * - Legacy ConfigStore owner metadata is preserved read-only for rollback safety.
 */

import {
  deriveSlugFromEmail,
  normalizeEmail,
  type GrantRecord,
  type GrantStore,
  type PrincipalRecord,
  type PrincipalStore,
} from '@beercanlabs/factory-bouncer';
import {
  BUILTIN_AGENT_IDS,
  effectiveAgentKind,
  loadDynamicRegistry,
  summarizeSkill,
  type AgentKind,
  type AgentRecord,
  type ConfigStore,
  type SkillRegistry,
} from '@beercanlabs/factory-registrar';
import type { LedgerStore } from '@beercanlabs/factory-ledger';
import { wireGrantStoreKindLookup, type FactoryState } from './app.js';
import { skillRegistry } from './skills.js';

export type OwnerConversionRole = 'content-owner' | 'accountable-lead' | 'member';

export type OwnerConversionMapping = {
  targetKind: 'agent' | 'skill';
  targetId: string;
  agentKind?: AgentKind;
  role: OwnerConversionRole;
  legacyOwner: string;
  principalId: string;
  materializedPrincipal?: boolean;
  alreadyGranted?: boolean;
};

export type OrphanReason =
  | 'no_owner'
  | 'no_lead'
  | 'unresolvable_owner'
  | 'multiple_owners_ambiguity'
  | string;

export type OrphanRecord = {
  targetKind: 'agent' | 'skill';
  targetId: string;
  agentKind?: AgentKind;
  reason: OrphanReason;
  message: string;
  legacyOwners?: string[];
};

export type OwnerConversionResult = {
  ready: boolean;
  dryRun: boolean;
  mappings: OwnerConversionMapping[];
  orphans: OrphanRecord[];
  convertedCount: number;
  skippedCount: number;
  materializedPrincipals: string[];
  ledgerRowsWritten: number;
};

export type MultiOwnerAmbiguityPolicy = 'orphan' | 'primary' | 'team';

export type ConvertLegacyOwnersOptions = {
  dryRun: boolean;
  by: string;
  defaultTeamAgents?: ReadonlySet<string>;
  resolveAmbiguity?: (agentId: string, owners: string[]) => MultiOwnerAmbiguityPolicy;
  multiOwnerPolicy?: MultiOwnerAmbiguityPolicy;
  throwOnOrphan?: boolean;
  now?: () => Date;
};

export class ZeroOrphanCutoverError extends Error {
  readonly orphans: readonly OrphanRecord[];
  constructor(orphans: readonly OrphanRecord[]) {
    super(
      `Zero-orphan cutover gate refused: ${orphans.length} orphan agent(s) detected: ${orphans
        .map((o) => `${o.targetId} (${o.reason})`)
        .join(', ')}`,
    );
    this.name = 'ZeroOrphanCutoverError';
    this.orphans = orphans;
  }
}

/** State dependencies needed for owner conversion. */
export type OwnerMigrationState = Pick<FactoryState, 'agents' | 'ledger'> & {
  configs?: ConfigStore;
  skills?: SkillRegistry;
  principals?: PrincipalStore;
  grants?: GrantStore;
  registryDir?: string;
};

function isBuiltinAgent(agent: AgentRecord): boolean {
  return Boolean(
    agent.isBuiltin ||
      agent.category === 'builtin' ||
      BUILTIN_AGENT_IDS.has(agent.id) ||
      agent.id === 'factory',
  );
}

function isRetiredAgent(agent: AgentRecord): boolean {
  const status = (agent as unknown as { status?: string }).status;
  return Boolean(
    agent.retiredAt !== undefined ||
      status === 'retired' ||
      status === 'decommissioned' ||
      agent.state === 'RETIRED_PENDING_PURGE' ||
      agent.state === 'PURGED',
  );
}

function defaultDisplayName(email: string): string {
  const local = email.split('@')[0] ?? 'user';
  return local
    .replace(/[._-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'User';
}

type LegacyOwnerParseResult =
  | { ok: true; kind: 'email'; normalizedEmail: string }
  | { ok: true; kind: 'slug'; slugId: string }
  | { ok: false; reason: string };

function parseLegacyOwnerString(raw: string): LegacyOwnerParseResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'owner must be a string' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'empty owner string' };

  let extractedEmail: string | undefined;
  let explicitSlug: string | undefined;

  const colon = trimmed.indexOf(':');
  if (colon === -1) {
    if (trimmed.includes('@')) {
      extractedEmail = trimmed;
    } else {
      return { ok: false, reason: `unrecognized bare identifier '${trimmed}' (missing @ or prefix)` };
    }
  } else {
    const prefix = trimmed.slice(0, colon).toLowerCase();
    const rest = trimmed.slice(colon + 1).trim();
    if (!rest) return { ok: false, reason: `empty target after prefix '${prefix}:'` };

    if (prefix === 'cloudflare') {
      extractedEmail = rest;
    } else if (prefix === 'oidc') {
      if (rest.includes('@')) {
        extractedEmail = rest;
      } else {
        explicitSlug = `user:${rest.toLowerCase()}`;
      }
    } else if (prefix === 'user') {
      if (rest.includes('@')) {
        extractedEmail = rest;
      } else {
        explicitSlug = `user:${rest.toLowerCase()}`;
      }
    } else {
      return { ok: false, reason: `unsupported owner prefix '${prefix}:'` };
    }
  }

  if (extractedEmail !== undefined) {
    try {
      const normalizedEmail = normalizeEmail(extractedEmail);
      return { ok: true, kind: 'email', normalizedEmail };
    } catch (err) {
      return {
        ok: false,
        reason: `invalid email format '${extractedEmail}': ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { ok: true, kind: 'slug', slugId: explicitSlug! };
}

function resolveCanonicalPrincipalId(
  parsed: Extract<LegacyOwnerParseResult, { ok: true }>,
  principals: PrincipalStore | undefined,
  simulatedCache: Map<string, string>,
  knownPrincipalIds: Set<string>,
): { ok: true; principalId: string; normalizedEmail?: string } | { ok: false; reason: string } {
  if (parsed.kind === 'email') {
    const email = parsed.normalizedEmail;
    // 1. Check dry-run / apply simulation cache
    const cached = simulatedCache.get(email);
    if (cached) return { ok: true, principalId: cached, normalizedEmail: email };

    // 2. Check PrincipalStore for existing principal by email
    const existing = principals?.findByEmail(email);
    if (existing) {
      simulatedCache.set(email, existing.id);
      knownPrincipalIds.add(existing.id);
      return { ok: true, principalId: existing.id, normalizedEmail: email };
    }

    // 3. Check if user:<email> exists directly by id
    const byId = principals?.get(`user:${email}`);
    if (byId) {
      simulatedCache.set(email, byId.id);
      knownPrincipalIds.add(byId.id);
      return { ok: true, principalId: byId.id, normalizedEmail: email };
    }

    // 4. Derive deterministic canonical slug ID
    // Create temporary map view for deriveSlugFromEmail
    const existingView = new Map<string, PrincipalRecord>();
    for (const id of knownPrincipalIds) {
      existingView.set(id, { id } as PrincipalRecord);
    }
    const derivedId = deriveSlugFromEmail(email, existingView);
    simulatedCache.set(email, derivedId);
    knownPrincipalIds.add(derivedId);
    return { ok: true, principalId: derivedId, normalizedEmail: email };
  }

  // Slug ID (e.g. user:alice)
  const slugId = parsed.slugId;
  const existing = principals?.get(slugId);
  if (existing) {
    knownPrincipalIds.add(existing.id);
    return { ok: true, principalId: existing.id };
  }

  // If already known in cache
  if (knownPrincipalIds.has(slugId)) {
    return { ok: true, principalId: slugId };
  }

  // A slug principal without an email cannot be materialized into PrincipalStore
  return {
    ok: false,
    reason: `principal '${slugId}' not found in PrincipalStore and lacks verified email for auto-creation`,
  };
}

/**
 * Converts legacy owner strings across agents, config store, and skills into canonical
 * PrincipalStore principals and GrantStore grants with zero-orphan verification.
 */
export async function convertLegacyOwners(
  state: OwnerMigrationState,
  opts: ConvertLegacyOwnersOptions,
): Promise<OwnerConversionResult> {
  const by = typeof opts.by === 'string' ? opts.by.trim() : '';
  if (!by) {
    throw new Error('opts.by actor string is required');
  }

  const dryRun = Boolean(opts.dryRun);
  const now = opts.now ?? (() => new Date());

  if (!dryRun) {
    if (!state.grants) throw new Error('state.grants is required for apply mode');
    if (!state.principals) throw new Error('state.principals is required for apply mode');
    if (!state.ledger) throw new Error('state.ledger is required for apply mode');
  }

  if (state.grants && (state as FactoryState).agents) {
    try {
      wireGrantStoreKindLookup(state as FactoryState);
    } catch {
      // In minimal test harnesses wireGrantStoreKindLookup might be a no-op
    }
  }

  // 1. Gather all candidate agents
  const agentsMap = new Map<string, AgentRecord>();

  if (state.registryDir) {
    try {
      for (const a of loadDynamicRegistry(state.registryDir)) {
        agentsMap.set(a.id, a);
      }
    } catch {
      // Ignore registry read error
    }
  }

  for (const [id, a] of state.agents) {
    agentsMap.set(id, a);
  }

  if (state.configs) {
    for (const agentId of state.configs.agentIds()) {
      if (!agentsMap.has(agentId)) {
        const cur = state.configs.current(agentId);
        if (cur) {
          agentsMap.set(agentId, {
            id: agentId,
            name: agentId,
            role: '',
            state: 'IDLE',
            provider: 'config',
            artifact: '',
            requires: [],
            ungated: [],
            gated: [],
            triggers: [],
            dir: '',
            ...(cur.owners ? { owners: cur.owners } : {}),
          });
        }
      }
    }
  }

  // 2. Setup simulation caches for deterministic resolution
  const simulatedEmailToPrincipal = new Map<string, string>();
  const knownPrincipalIds = new Set<string>();

  if (state.principals) {
    try {
      for (const p of state.principals.list()) {
        knownPrincipalIds.add(p.id);
        for (const e of p.emails) {
          simulatedEmailToPrincipal.set(e, p.id);
        }
      }
    } catch {
      // If store list fails
    }
  }

  const mappings: OwnerConversionMapping[] = [];
  const orphans: OrphanRecord[] = [];
  let skippedCount = 0;

  // 3. Inspect agents
  const sortedAgents = [...agentsMap.values()].sort((a, b) => a.id.localeCompare(b.id));

  for (const agent of sortedAgents) {
    if (isBuiltinAgent(agent)) {
      skippedCount++;
      continue;
    }

    if (isRetiredAgent(agent)) {
      skippedCount++;
      continue;
    }

    // Determine kind
    const isTeam = Boolean(
      opts.defaultTeamAgents?.has(agent.id) ||
        agent.kind === 'team' ||
        effectiveAgentKind(agent) === 'team',
    );
    const agentKind: AgentKind = isTeam ? 'team' : 'personal';

    // Check existing active grants in GrantStore
    let existingGrants: GrantRecord[] = [];
    if (state.grants && state.grants.healthy) {
      try {
        existingGrants = state.grants.list({
          scopeKind: 'agent',
          scopeId: agent.id,
          includeExpired: false,
          at: now(),
        });
      } catch {
        existingGrants = [];
      }
    }

    const activeContentOwnerGrant = existingGrants.find(
      (g) => g.role === 'content-owner' && g.state === 'active',
    );
    const activeLeadGrant = existingGrants.find(
      (g) => g.role === 'accountable-lead' && g.state === 'active',
    );
    const activeMemberGrants = existingGrants.filter(
      (g) => g.role === 'member' && g.state === 'active',
    );

    // Get legacy owners from ConfigStore, falling back to agent.owners
    const configOwners = state.configs?.current(agent.id)?.owners;
    const agentOwners = (agent as unknown as { owners?: string[] }).owners;
    const legacyOwners: string[] = Array.isArray(configOwners) && configOwners.length > 0
      ? configOwners
      : Array.isArray(agentOwners)
        ? agentOwners
        : [];

    if (agentKind === 'personal') {
      if (activeContentOwnerGrant) {
        // Personal agent already holds active canonical content-owner grant
        skippedCount++;
        continue;
      }

      if (legacyOwners.length === 0) {
        orphans.push({
          targetKind: 'agent',
          targetId: agent.id,
          agentKind: 'personal',
          reason: 'no_owner',
          message: `live personal agent '${agent.id}' lacks content-owner grant and has empty legacy owners`,
          legacyOwners: [],
        });
        continue;
      }

      if (legacyOwners.length === 1) {
        const rawOwner = legacyOwners[0];
        const parsed = parseLegacyOwnerString(rawOwner);
        if (!parsed.ok) {
          orphans.push({
            targetKind: 'agent',
            targetId: agent.id,
            agentKind: 'personal',
            reason: 'unresolvable_owner',
            message: `unresolvable legacy owner '${rawOwner}' on personal agent '${agent.id}': ${parsed.reason}`,
            legacyOwners,
          });
          continue;
        }

        const resolved = resolveCanonicalPrincipalId(
          parsed,
          state.principals,
          simulatedEmailToPrincipal,
          knownPrincipalIds,
        );
        if (!resolved.ok) {
          orphans.push({
            targetKind: 'agent',
            targetId: agent.id,
            agentKind: 'personal',
            reason: 'unresolvable_owner',
            message: `unresolvable principal for owner '${rawOwner}' on personal agent '${agent.id}': ${resolved.reason}`,
            legacyOwners,
          });
          continue;
        }

        mappings.push({
          targetKind: 'agent',
          targetId: agent.id,
          agentKind: 'personal',
          role: 'content-owner',
          legacyOwner: rawOwner,
          principalId: resolved.principalId,
        });
      } else {
        // Multiple legacy owners on personal agent
        let ambiguityDecision: MultiOwnerAmbiguityPolicy = 'orphan';
        if (opts.resolveAmbiguity) {
          ambiguityDecision = opts.resolveAmbiguity(agent.id, legacyOwners);
        } else if (opts.multiOwnerPolicy) {
          ambiguityDecision = opts.multiOwnerPolicy;
        }

        if (ambiguityDecision === 'orphan') {
          orphans.push({
            targetKind: 'agent',
            targetId: agent.id,
            agentKind: 'personal',
            reason: 'multiple_owners_ambiguity',
            message: `personal agent '${agent.id}' has multiple legacy owners without team designation: [${legacyOwners.join(', ')}]`,
            legacyOwners,
          });
          continue;
        }

        if (ambiguityDecision === 'primary') {
          const rawOwner = legacyOwners[0];
          const parsed = parseLegacyOwnerString(rawOwner);
          if (!parsed.ok) {
            orphans.push({
              targetKind: 'agent',
              targetId: agent.id,
              agentKind: 'personal',
              reason: 'unresolvable_owner',
              message: `unresolvable primary owner '${rawOwner}' on personal agent '${agent.id}': ${parsed.reason}`,
              legacyOwners,
            });
            continue;
          }
          const resolved = resolveCanonicalPrincipalId(
            parsed,
            state.principals,
            simulatedEmailToPrincipal,
            knownPrincipalIds,
          );
          if (!resolved.ok) {
            orphans.push({
              targetKind: 'agent',
              targetId: agent.id,
              agentKind: 'personal',
              reason: 'unresolvable_owner',
              message: `unresolvable principal for primary owner '${rawOwner}' on personal agent '${agent.id}': ${resolved.reason}`,
              legacyOwners,
            });
            continue;
          }
          mappings.push({
            targetKind: 'agent',
            targetId: agent.id,
            agentKind: 'personal',
            role: 'content-owner',
            legacyOwner: rawOwner,
            principalId: resolved.principalId,
          });
        } else if (ambiguityDecision === 'team') {
          // Reclassify as team agent
          const leadOwner = legacyOwners[0];
          const coOwners = legacyOwners.slice(1);
          const parsedLead = parseLegacyOwnerString(leadOwner);
          if (!parsedLead.ok) {
            orphans.push({
              targetKind: 'agent',
              targetId: agent.id,
              agentKind: 'team',
              reason: 'unresolvable_owner',
              message: `unresolvable lead '${leadOwner}' on converted team agent '${agent.id}': ${parsedLead.reason}`,
              legacyOwners,
            });
            continue;
          }
          const resolvedLead = resolveCanonicalPrincipalId(
            parsedLead,
            state.principals,
            simulatedEmailToPrincipal,
            knownPrincipalIds,
          );
          if (!resolvedLead.ok) {
            orphans.push({
              targetKind: 'agent',
              targetId: agent.id,
              agentKind: 'team',
              reason: 'unresolvable_owner',
              message: `unresolvable lead principal '${leadOwner}' on converted team agent '${agent.id}': ${resolvedLead.reason}`,
              legacyOwners,
            });
            continue;
          }
          mappings.push({
            targetKind: 'agent',
            targetId: agent.id,
            agentKind: 'team',
            role: 'accountable-lead',
            legacyOwner: leadOwner,
            principalId: resolvedLead.principalId,
          });

          let memberFailed = false;
          for (const memberRaw of coOwners) {
            const parsedMember = parseLegacyOwnerString(memberRaw);
            if (!parsedMember.ok) {
              orphans.push({
                targetKind: 'agent',
                targetId: agent.id,
                agentKind: 'team',
                reason: 'unresolvable_owner',
                message: `unresolvable member '${memberRaw}' on team agent '${agent.id}': ${parsedMember.reason}`,
                legacyOwners,
              });
              memberFailed = true;
              break;
            }
            const resolvedMember = resolveCanonicalPrincipalId(
              parsedMember,
              state.principals,
              simulatedEmailToPrincipal,
              knownPrincipalIds,
            );
            if (!resolvedMember.ok) {
              orphans.push({
                targetKind: 'agent',
                targetId: agent.id,
                agentKind: 'team',
                reason: 'unresolvable_owner',
                message: `unresolvable member principal '${memberRaw}' on team agent '${agent.id}': ${resolvedMember.reason}`,
                legacyOwners,
              });
              memberFailed = true;
              break;
            }
            if (resolvedMember.principalId !== resolvedLead.principalId) {
              mappings.push({
                targetKind: 'agent',
                targetId: agent.id,
                agentKind: 'team',
                role: 'member',
                legacyOwner: memberRaw,
                principalId: resolvedMember.principalId,
              });
            }
          }
          if (memberFailed) continue;
        }
      }
    } else {
      // Team agent
      const candidateLead = agent.accountableLead || legacyOwners[0];
      const candidateMembers = agent.accountableLead
        ? legacyOwners.filter((o) => o !== agent.accountableLead)
        : legacyOwners.slice(1);

      if (activeLeadGrant) {
        // Accountable lead grant already held
        let memberFailed = false;
        for (const memberRaw of candidateMembers) {
          const parsed = parseLegacyOwnerString(memberRaw);
          if (!parsed.ok) {
            orphans.push({
              targetKind: 'agent',
              targetId: agent.id,
              agentKind: 'team',
              reason: 'unresolvable_owner',
              message: `unresolvable member owner '${memberRaw}' on team agent '${agent.id}': ${parsed.reason}`,
              legacyOwners,
            });
            memberFailed = true;
            break;
          }
          const resolved = resolveCanonicalPrincipalId(
            parsed,
            state.principals,
            simulatedEmailToPrincipal,
            knownPrincipalIds,
          );
          if (!resolved.ok) {
            orphans.push({
              targetKind: 'agent',
              targetId: agent.id,
              agentKind: 'team',
              reason: 'unresolvable_owner',
              message: `unresolvable member principal '${memberRaw}' on team agent '${agent.id}': ${resolved.reason}`,
              legacyOwners,
            });
            memberFailed = true;
            break;
          }
          const alreadyMember = activeMemberGrants.some(
            (g) => g.subject === resolved.principalId,
          );
          if (!alreadyMember && resolved.principalId !== activeLeadGrant.subject) {
            mappings.push({
              targetKind: 'agent',
              targetId: agent.id,
              agentKind: 'team',
              role: 'member',
              legacyOwner: memberRaw,
              principalId: resolved.principalId,
            });
          }
        }
        if (memberFailed) continue;
        if (candidateMembers.length === 0) {
          skippedCount++;
        }
        continue;
      }

      if (!candidateLead) {
        orphans.push({
          targetKind: 'agent',
          targetId: agent.id,
          agentKind: 'team',
          reason: 'no_lead',
          message: `team agent '${agent.id}' lacks accountable-lead grant, accountableLead metadata, and legacy owners`,
          legacyOwners: [],
        });
        continue;
      }

      // Resolve candidate lead
      const parsedLead = parseLegacyOwnerString(candidateLead);
      if (!parsedLead.ok) {
        orphans.push({
          targetKind: 'agent',
          targetId: agent.id,
          agentKind: 'team',
          reason: 'unresolvable_owner',
          message: `unresolvable accountable-lead '${candidateLead}' on team agent '${agent.id}': ${parsedLead.reason}`,
          legacyOwners,
        });
        continue;
      }

      const resolvedLead = resolveCanonicalPrincipalId(
        parsedLead,
        state.principals,
        simulatedEmailToPrincipal,
        knownPrincipalIds,
      );
      if (!resolvedLead.ok) {
        orphans.push({
          targetKind: 'agent',
          targetId: agent.id,
          agentKind: 'team',
          reason: 'unresolvable_owner',
          message: `unresolvable accountable-lead principal '${candidateLead}' on team agent '${agent.id}': ${resolvedLead.reason}`,
          legacyOwners,
        });
        continue;
      }

      mappings.push({
        targetKind: 'agent',
        targetId: agent.id,
        agentKind: 'team',
        role: 'accountable-lead',
        legacyOwner: candidateLead,
        principalId: resolvedLead.principalId,
      });

      let memberFailed = false;
      for (const memberRaw of candidateMembers) {
        const parsedMember = parseLegacyOwnerString(memberRaw);
        if (!parsedMember.ok) {
          orphans.push({
            targetKind: 'agent',
            targetId: agent.id,
            agentKind: 'team',
            reason: 'unresolvable_owner',
            message: `unresolvable member owner '${memberRaw}' on team agent '${agent.id}': ${parsedMember.reason}`,
            legacyOwners,
          });
          memberFailed = true;
          break;
        }
        const resolvedMember = resolveCanonicalPrincipalId(
          parsedMember,
          state.principals,
          simulatedEmailToPrincipal,
          knownPrincipalIds,
        );
        if (!resolvedMember.ok) {
          orphans.push({
            targetKind: 'agent',
            targetId: agent.id,
            agentKind: 'team',
            reason: 'unresolvable_owner',
            message: `unresolvable member principal '${memberRaw}' on team agent '${agent.id}': ${resolvedMember.reason}`,
            legacyOwners,
          });
          memberFailed = true;
          break;
        }
        if (resolvedMember.principalId !== resolvedLead.principalId) {
          mappings.push({
            targetKind: 'agent',
            targetId: agent.id,
            agentKind: 'team',
            role: 'member',
            legacyOwner: memberRaw,
            principalId: resolvedMember.principalId,
          });
        }
      }
      if (memberFailed) continue;
    }
  }

  // 4. Inspect skills (if skill registry is accessible)
  let skillsReg: SkillRegistry | undefined = state.skills;
  if (!skillsReg) {
    try {
      skillsReg = skillRegistry(state as FactoryState);
    } catch {
      // Skill registry not configured or not loaded
    }
  }

  if (skillsReg) {
    try {
      for (const skillId of skillsReg.ids()) {
        const summary = summarizeSkill(skillsReg, skillId);
        if (!summary || summary.retired) {
          skippedCount++;
          continue;
        }

        // Check if skill already has active content-owner grant
        const hasSkillGrant = state.grants?.activeContentOwnerOf({ kind: 'skill', id: skillId }, now());
        if (hasSkillGrant) {
          skippedCount++;
          continue;
        }

        const skillOwner = summary.userOwner || summary.owner;
        if (!skillOwner) {
          continue;
        }

        const parsed = parseLegacyOwnerString(skillOwner);
        if (!parsed.ok) {
          orphans.push({
            targetKind: 'skill',
            targetId: skillId,
            reason: 'unresolvable_owner',
            message: `unresolvable legacy owner '${skillOwner}' on skill '${skillId}': ${parsed.reason}`,
            legacyOwners: [skillOwner],
          });
          continue;
        }

        const resolved = resolveCanonicalPrincipalId(
          parsed,
          state.principals,
          simulatedEmailToPrincipal,
          knownPrincipalIds,
        );
        if (!resolved.ok) {
          orphans.push({
            targetKind: 'skill',
            targetId: skillId,
            reason: 'unresolvable_owner',
            message: `unresolvable principal for skill owner '${skillOwner}' on skill '${skillId}': ${resolved.reason}`,
            legacyOwners: [skillOwner],
          });
          continue;
        }

        mappings.push({
          targetKind: 'skill',
          targetId: skillId,
          role: 'content-owner',
          legacyOwner: skillOwner,
          principalId: resolved.principalId,
        });
      }
    } catch {
      // Ignore skill iteration failures
    }
  }

  const ready = orphans.length === 0;

  // 5. Dry-Run Mode: ZERO writes to any store or ledger!
  if (dryRun) {
    return {
      ready,
      dryRun: true,
      mappings,
      orphans,
      convertedCount: mappings.length,
      skippedCount,
      materializedPrincipals: [...new Set(mappings.map((m) => m.principalId))],
      ledgerRowsWritten: 0,
    };
  }

  // 6. Apply Mode Refusal Gate: If not ready, refuse atomically before making ANY writes
  if (!ready) {
    if (opts.throwOnOrphan) {
      throw new ZeroOrphanCutoverError(orphans);
    }
    return {
      ready: false,
      dryRun: false,
      mappings,
      orphans,
      convertedCount: 0,
      skippedCount,
      materializedPrincipals: [],
      ledgerRowsWritten: 0,
    };
  }

  // 7. Apply Mode: Perform writes
  const principalsStore = state.principals!;
  const grantStore = state.grants!;
  const ledger = state.ledger;
  const materializedPrincipals = new Set<string>();

  // A. Materialize any missing canonical principals in PrincipalStore
  for (const mapping of mappings) {
    const existing = principalsStore.get(mapping.principalId);
    if (!existing) {
      const parsed = parseLegacyOwnerString(mapping.legacyOwner);
      const email = parsed.ok && parsed.kind === 'email' ? parsed.normalizedEmail : undefined;
      if (email) {
        const created = await principalsStore.create({
          id: mapping.principalId,
          displayName: defaultDisplayName(email),
          emails: [email],
          by,
        });
        materializedPrincipals.add(created.id);
        mapping.materializedPrincipal = true;
      }
    }
  }

  // B. Write grants in GrantStore idempotently and append to Ledger
  let convertedCount = 0;
  let ledgerRowsWritten = 0;

  for (const mapping of mappings) {
    // Check if active grant already exists
    const existingGrants = grantStore.list({
      scopeKind: mapping.targetKind,
      scopeId: mapping.targetId,
      includeExpired: false,
      at: now(),
    });

    const alreadyGranted = existingGrants.some(
      (g) =>
        g.subject === mapping.principalId &&
        g.role === mapping.role &&
        g.state === 'active',
    );

    if (alreadyGranted) {
      mapping.alreadyGranted = true;
      skippedCount++;
      continue;
    }

    // Write grant
    await grantStore.grant({
      subject: mapping.principalId,
      scope: {
        kind: mapping.targetKind,
        id: mapping.targetId,
      },
      role: mapping.role,
      agentKind: mapping.agentKind,
      by,
      granterRole: 'admin',
      granterIsAdmin: true,
      initialSubmission: true,
    });

    convertedCount++;

    // Update in-memory AgentRecord kind if omitted
    if (mapping.targetKind === 'agent' && mapping.agentKind) {
      const agentRec = state.agents.get(mapping.targetId);
      if (agentRec && !agentRec.kind) {
        agentRec.kind = mapping.agentKind;
      }
    }

    // Append OWNER_CONVERTED to hash-chained audit ledger
    ledger.append({
      timestamp: now().toISOString(),
      agentId: mapping.targetKind === 'agent' ? mapping.targetId : 'factory',
      type: 'action',
      action: 'OWNER_CONVERTED',
      actor: by,
      subject: mapping.principalId,
      legacyOwner: mapping.legacyOwner,
      principalId: mapping.principalId,
      role: mapping.role,
      payload: {
        targetKind: mapping.targetKind,
        targetId: mapping.targetId,
        legacyOwner: mapping.legacyOwner,
        principalId: mapping.principalId,
        role: mapping.role,
      },
    });

    ledgerRowsWritten++;
  }

  return {
    ready: true,
    dryRun: false,
    mappings,
    orphans: [],
    convertedCount,
    skippedCount,
    materializedPrincipals: [...materializedPrincipals],
    ledgerRowsWritten,
  };
}
