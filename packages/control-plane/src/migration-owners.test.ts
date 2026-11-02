import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GrantStore,
  PrincipalStore,
  MemoryDocBackend,
} from '@beercanlabs/factory-bouncer';
import {
  VersionedConfigStore,
  SkillRegistry,
  loadDynamicRegistry,
  effectiveAgentKind,
  registryOf,
  RETIRED_PLACEHOLDER_IDS,
  type AgentRecord,
  type ConfigRecord,
  type ConfigBackend,
  type SkillVersionRecord,
} from '@beercanlabs/factory-registrar';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import {
  convertLegacyOwners,
  ZeroOrphanCutoverError,
  type OwnerMigrationState,
} from './migration-owners.js';

class MemoryConfigBackend implements ConfigBackend {
  readonly description = 'memory-config-backend';
  private readonly records = new Map<string, ConfigRecord[]>();

  async loadAll(): Promise<ConfigRecord[]> {
    const list: ConfigRecord[] = [];
    for (const v of this.records.values()) {
      list.push(...v);
    }
    return list;
  }

  async write(record: ConfigRecord): Promise<void> {
    const existing = this.records.get(record.agentId) ?? [];
    existing.push(record);
    this.records.set(record.agentId, existing);
  }

  async remove(agentId: string): Promise<void> {
    this.records.delete(agentId);
  }
}

function makeAgent(
  id: string,
  overrides?: Partial<AgentRecord> & { owners?: string[]; status?: string },
): AgentRecord {
  return {
    id,
    name: id,
    role: `Role of ${id}`,
    state: 'IDLE',
    provider: 'cloud',
    artifact: 'factory-agent:latest',
    requires: [],
    ungated: [],
    gated: [],
    triggers: [{ type: 'http', path: `/api/v1/agents/${id}` }],
    dir: `/app/agents/${id}`,
    ...overrides,
  };
}

describe('Owner migration converter (S18)', () => {
  it('dryRun: true makes ZERO mutations to PrincipalStore, GrantStore, and Ledger', async () => {
    const principalsBackend = new MemoryDocBackend<any>();
    const grantsBackend = new MemoryDocBackend<any>();
    const configBackend = new MemoryConfigBackend();

    const principals = await PrincipalStore.open(principalsBackend);
    const grants = await GrantStore.open(grantsBackend, { principals });
    const configs = await VersionedConfigStore.open(configBackend);
    const ledger = new MemoryLedger();

    // Create an initial admin in PrincipalStore
    await principals.create({
      id: 'user:admin',
      displayName: 'Admin User',
      emails: ['admin@example.com'],
      by: 'bootstrap',
    });

    // Populate a live personal agent with legacy owner in config store
    await configs.put(
      {
        agentId: 'donna',
        source: { repo: 'BeerCanLabs/donna' },
        skills: [],
        policy: null,
        owners: ['cloudflare:stephanie@example.com'],
      },
      { by: 'user:admin', reason: 'initial' },
    );

    const agents = new Map<string, AgentRecord>();
    agents.set('donna', makeAgent('donna'));

    const state: OwnerMigrationState = {
      agents,
      configs,
      principals,
      grants,
      ledger,
    };

    const initialPrincipals = principals.list();
    const initialGrants = grants.list();
    const initialLedgerRows = ledger.query().length;

    // Run dry-run
    const res = await convertLegacyOwners(state, {
      dryRun: true,
      by: 'user:admin',
    });

    assert.equal(res.ready, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.orphans.length, 0);
    assert.equal(res.mappings.length, 1);
    assert.equal(res.mappings[0].targetId, 'donna');
    assert.equal(res.mappings[0].targetKind, 'agent');
    assert.equal(res.mappings[0].role, 'content-owner');
    assert.equal(res.mappings[0].legacyOwner, 'cloudflare:stephanie@example.com');
    assert.equal(res.mappings[0].principalId, 'user:stephanie');

    // Verify ZERO mutations occurred!
    assert.deepEqual(principals.list(), initialPrincipals);
    assert.deepEqual(grants.list(), initialGrants);
    assert.equal(ledger.query().length, initialLedgerRows);
  });

  it('zero-orphan refusal gate blocks apply with zero writes when any live agent lacks an owner/lead', async () => {
    const principalsBackend = new MemoryDocBackend<any>();
    const grantsBackend = new MemoryDocBackend<any>();
    const configBackend = new MemoryConfigBackend();

    const principals = await PrincipalStore.open(principalsBackend);
    const grants = await GrantStore.open(grantsBackend, { principals });
    const configs = await VersionedConfigStore.open(configBackend);
    const ledger = new MemoryLedger();

    await principals.create({
      id: 'user:admin',
      displayName: 'Admin User',
      emails: ['admin@example.com'],
      by: 'bootstrap',
    });

    // Agent 1: Valid owner
    await configs.put(
      {
        agentId: 'good-agent',
        source: { repo: 'BeerCanLabs/good' },
        skills: [],
        policy: null,
        owners: ['cloudflare:good@example.com'],
      },
      { by: 'user:admin', reason: 'initial' },
    );

    // Agent 2: Missing owners completely (orphan!)
    await configs.put(
      {
        agentId: 'orphan-agent',
        source: { repo: 'BeerCanLabs/orphan' },
        skills: [],
        policy: null,
        owners: [],
      },
      { by: 'user:admin', reason: 'initial' },
    );

    // Agent 3: Built-in agent (must be skipped, NOT treated as orphan)
    const builtinAgent = makeAgent('gatekeeper-ingress', { isBuiltin: true, category: 'builtin' });

    // Agent 4: Retired agent (must be skipped, NOT treated as orphan)
    const retiredAgent = makeAgent('retired-agent', {
      state: 'RETIRED_PENDING_PURGE',
      retiredAt: new Date().toISOString(),
    });

    const agents = new Map<string, AgentRecord>();
    agents.set('good-agent', makeAgent('good-agent'));
    agents.set('orphan-agent', makeAgent('orphan-agent'));
    agents.set('gatekeeper-ingress', builtinAgent);
    agents.set('retired-agent', retiredAgent);

    const state: OwnerMigrationState = {
      agents,
      configs,
      principals,
      grants,
      ledger,
    };

    // 1. Dry run identifies orphan and reports ready: false
    const dryRunRes = await convertLegacyOwners(state, {
      dryRun: true,
      by: 'user:admin',
    });

    assert.equal(dryRunRes.ready, false);
    assert.equal(dryRunRes.orphans.length, 1);
    assert.equal(dryRunRes.orphans[0].targetId, 'orphan-agent');
    assert.equal(dryRunRes.orphans[0].reason, 'no_owner');

    // 2. Apply mode (dryRun: false) refuses cutover atomically with zero writes!
    const applyRes = await convertLegacyOwners(state, {
      dryRun: false,
      by: 'user:admin',
    });

    assert.equal(applyRes.ready, false);
    assert.equal(applyRes.convertedCount, 0);
    assert.equal(applyRes.ledgerRowsWritten, 0);

    // Check zero grants written and zero ledger rows
    assert.equal(grants.list().length, 0);
    assert.equal(ledger.query().length, 0);

    // 3. throwOnOrphan throws ZeroOrphanCutoverError
    await assert.rejects(
      convertLegacyOwners(state, {
        dryRun: false,
        by: 'user:admin',
        throwOnOrphan: true,
      }),
      (err: any) => {
        assert.ok(err instanceof ZeroOrphanCutoverError);
        assert.equal(err.orphans.length, 1);
        assert.equal(err.orphans[0].targetId, 'orphan-agent');
        return true;
      },
    );
  });

  it('normalizes cloudflare:<email> and oidc:<email> with mixed case to same multi-email canonical principal', async () => {
    const principalsBackend = new MemoryDocBackend<any>();
    const grantsBackend = new MemoryDocBackend<any>();
    const configBackend = new MemoryConfigBackend();

    const principals = await PrincipalStore.open(principalsBackend);
    const grants = await GrantStore.open(grantsBackend, { principals });
    const configs = await VersionedConfigStore.open(configBackend);
    const ledger = new MemoryLedger();

    // Seed Stephanie's canonical principal with both hotmail and gmail emails
    await principals.create({
      id: 'user:stephanie',
      displayName: 'Stephanie Sackrider',
      emails: ['stephaniesackrider@hotmail.com', 'stephanie.sackrider@gmail.com'],
      by: 'bootstrap',
    });

    // Agent 1: Personal agent with mixed-case Cloudflare hotmail
    await configs.put(
      {
        agentId: 'higgins',
        source: { repo: 'BeerCanLabs/higgins' },
        skills: [],
        policy: null,
        owners: ['CloudFlare:StephanieSackrider@Hotmail.Com'],
      },
      { by: 'user:stephanie', reason: 'initial' },
    );

    // Agent 2: Personal agent with OIDC gmail
    await configs.put(
      {
        agentId: 'finley',
        source: { repo: 'BeerCanLabs/finley' },
        skills: [],
        policy: null,
        owners: ['oidc:Stephanie.Sackrider@Gmail.Com'],
      },
      { by: 'user:stephanie', reason: 'initial' },
    );

    const agents = new Map<string, AgentRecord>();
    agents.set('higgins', makeAgent('higgins'));
    agents.set('finley', makeAgent('finley'));

    const state: OwnerMigrationState = {
      agents,
      configs,
      principals,
      grants,
      ledger,
    };

    const dryRes = await convertLegacyOwners(state, {
      dryRun: true,
      by: 'user:stephanie',
    });

    assert.equal(dryRes.ready, true);
    assert.equal(dryRes.mappings.length, 2);
    // Both mapped to user:stephanie!
    assert.equal(dryRes.mappings[0].principalId, 'user:stephanie');
    assert.equal(dryRes.mappings[1].principalId, 'user:stephanie');
    assert.equal(dryRes.mappings[0].role, 'content-owner');
    assert.equal(dryRes.mappings[1].role, 'content-owner');

    // Run apply
    const applyRes = await convertLegacyOwners(state, {
      dryRun: false,
      by: 'user:stephanie',
    });

    assert.equal(applyRes.ready, true);
    assert.equal(applyRes.convertedCount, 2);
    assert.equal(applyRes.ledgerRowsWritten, 2);

    // Verify grants in GrantStore
    const higginsOwner = grants.activeContentOwnerOf({ kind: 'agent', id: 'higgins' });
    const finleyOwner = grants.activeContentOwnerOf({ kind: 'agent', id: 'finley' });
    assert.equal(higginsOwner, 'user:stephanie');
    assert.equal(finleyOwner, 'user:stephanie');

    // Verify OWNER_CONVERTED ledger rows
    const higginsRow = ledger.query().find((r) => r.agentId === 'higgins');
    const finleyRow = ledger.query().find((r) => r.agentId === 'finley');
    assert.ok(higginsRow);
    assert.ok(finleyRow);
    assert.equal(higginsRow.action, 'OWNER_CONVERTED');
    assert.equal(higginsRow.subject, 'user:stephanie');
    assert.equal(finleyRow.action, 'OWNER_CONVERTED');
    assert.equal(finleyRow.subject, 'user:stephanie');
    assert.equal(ledger.verify().ok, true);

    // Rollback safety: ConfigStore records remain untouched read-only!
    assert.deepEqual(configs.current('higgins')?.owners, ['CloudFlare:StephanieSackrider@Hotmail.Com']);
    assert.deepEqual(configs.current('finley')?.owners, ['oidc:Stephanie.Sackrider@Gmail.Com']);
  });

  it('converts personal agent -> content-owner and team agent -> accountable-lead + member', async () => {
    const principalsBackend = new MemoryDocBackend<any>();
    const grantsBackend = new MemoryDocBackend<any>();
    const configBackend = new MemoryConfigBackend();

    const principals = await PrincipalStore.open(principalsBackend);
    const grants = await GrantStore.open(grantsBackend, { principals });
    const configs = await VersionedConfigStore.open(configBackend);
    const ledger = new MemoryLedger();

    // Personal agent: Dale is owner
    await configs.put(
      {
        agentId: 'dale-assistant',
        source: { repo: 'BeerCanLabs/dale-assistant' },
        skills: [],
        policy: null,
        owners: ['cloudflare:dale@example.com'],
      },
      { by: 'bootstrap', reason: 'initial' },
    );

    // Team agent: lead is Dale, co-owner/member is Alice
    await configs.put(
      {
        agentId: 'core-team-agent',
        source: { repo: 'BeerCanLabs/core-team-agent' },
        skills: [],
        policy: null,
        owners: ['cloudflare:dale@example.com', 'cloudflare:alice@example.com'],
      },
      { by: 'bootstrap', reason: 'initial' },
    );

    const agents = new Map<string, AgentRecord>();
    agents.set('dale-assistant', makeAgent('dale-assistant', { kind: 'personal' }));
    agents.set('core-team-agent', makeAgent('core-team-agent', { kind: 'team' }));

    const state: OwnerMigrationState = {
      agents,
      configs,
      principals,
      grants,
      ledger,
    };

    const res = await convertLegacyOwners(state, {
      dryRun: false,
      by: 'user:admin',
      defaultTeamAgents: new Set(['core-team-agent']),
    });

    assert.equal(res.ready, true);
    assert.equal(res.convertedCount, 3);
    assert.equal(res.ledgerRowsWritten, 3);

    // Check grants
    const daleAssistantOwner = grants.activeContentOwnerOf({ kind: 'agent', id: 'dale-assistant' });
    assert.equal(daleAssistantOwner, 'user:dale');

    const teamGrants = grants.list({ scopeKind: 'agent', scopeId: 'core-team-agent' });
    const leadGrant = teamGrants.find((g) => g.role === 'accountable-lead');
    const memberGrant = teamGrants.find((g) => g.role === 'member');
    assert.ok(leadGrant);
    assert.ok(memberGrant);
    assert.equal(leadGrant.subject, 'user:dale');
    assert.equal(memberGrant.subject, 'user:alice');

    // Verify ledger entries
    assert.equal(ledger.query().length, 3);
    assert.equal(ledger.verify().ok, true);
  });

  it('second apply run is completely idempotent with zero duplicate grants and zero new ledger rows', async () => {
    const principalsBackend = new MemoryDocBackend<any>();
    const grantsBackend = new MemoryDocBackend<any>();
    const configBackend = new MemoryConfigBackend();

    const principals = await PrincipalStore.open(principalsBackend);
    const grants = await GrantStore.open(grantsBackend, { principals });
    const configs = await VersionedConfigStore.open(configBackend);
    const ledger = new MemoryLedger();

    await configs.put(
      {
        agentId: 'echo',
        source: { repo: 'BeerCanLabs/echo' },
        skills: [],
        policy: null,
        owners: ['cloudflare:tester@example.com'],
      },
      { by: 'bootstrap', reason: 'initial' },
    );

    const agents = new Map<string, AgentRecord>();
    agents.set('echo', makeAgent('echo'));

    const state: OwnerMigrationState = {
      agents,
      configs,
      principals,
      grants,
      ledger,
    };

    // First apply
    const firstRes = await convertLegacyOwners(state, {
      dryRun: false,
      by: 'user:admin',
    });
    assert.equal(firstRes.ready, true);
    assert.equal(firstRes.convertedCount, 1);
    assert.equal(firstRes.ledgerRowsWritten, 1);

    const grantsCountAfterFirst = grants.list().length;
    const ledgerCountAfterFirst = ledger.query().length;

    // Second apply
    const secondRes = await convertLegacyOwners(state, {
      dryRun: false,
      by: 'user:admin',
    });
    assert.equal(secondRes.ready, true);
    assert.equal(secondRes.convertedCount, 0); // zero new grants
    assert.equal(secondRes.ledgerRowsWritten, 0); // zero new ledger rows
    assert.equal(secondRes.skippedCount, 1); // skipped because already held active grant

    // Grant store count and ledger row count remain identical
    assert.equal(grants.list().length, grantsCountAfterFirst);
    assert.equal(ledger.query().length, ledgerCountAfterFirst);
    assert.equal(ledger.verify().ok, true);
  });

  it('handles multiple legacy owners on personal agent via resolveAmbiguity', async () => {
    const principalsBackend = new MemoryDocBackend<any>();
    const grantsBackend = new MemoryDocBackend<any>();
    const configBackend = new MemoryConfigBackend();

    const principals = await PrincipalStore.open(principalsBackend);
    const grants = await GrantStore.open(grantsBackend, { principals });
    const configs = await VersionedConfigStore.open(configBackend);
    const ledger = new MemoryLedger();

    await configs.put(
      {
        agentId: 'multi-owner-agent',
        source: { repo: 'BeerCanLabs/multi' },
        skills: [],
        policy: null,
        owners: ['cloudflare:first@example.com', 'cloudflare:second@example.com'],
      },
      { by: 'bootstrap', reason: 'initial' },
    );

    const agents = new Map<string, AgentRecord>();
    agents.set('multi-owner-agent', makeAgent('multi-owner-agent', { kind: 'personal' }));

    const state: OwnerMigrationState = {
      agents,
      configs,
      principals,
      grants,
      ledger,
    };

    // 1. Default policy is 'orphan'
    const orphanRes = await convertLegacyOwners(state, {
      dryRun: true,
      by: 'user:admin',
    });
    assert.equal(orphanRes.ready, false);
    assert.equal(orphanRes.orphans[0].reason, 'multiple_owners_ambiguity');

    // 2. resolveAmbiguity -> 'primary' maps first owner to content-owner
    const primaryRes = await convertLegacyOwners(state, {
      dryRun: true,
      by: 'user:admin',
      resolveAmbiguity: () => 'primary',
    });
    assert.equal(primaryRes.ready, true);
    assert.equal(primaryRes.mappings.length, 1);
    assert.equal(primaryRes.mappings[0].role, 'content-owner');
    assert.equal(primaryRes.mappings[0].principalId, 'user:first');

    // 3. resolveAmbiguity -> 'team' reclassifies as team agent with lead and member
    const teamRes = await convertLegacyOwners(state, {
      dryRun: true,
      by: 'user:admin',
      resolveAmbiguity: () => 'team',
    });
    assert.equal(teamRes.ready, true);
    assert.equal(teamRes.mappings.length, 2);
    assert.equal(teamRes.mappings[0].role, 'accountable-lead');
    assert.equal(teamRes.mappings[0].principalId, 'user:first');
    assert.equal(teamRes.mappings[1].role, 'member');
    assert.equal(teamRes.mappings[1].principalId, 'user:second');
  });

  it('unparseable owner string triggers unresolvable_owner orphan', async () => {
    const principalsBackend = new MemoryDocBackend<any>();
    const grantsBackend = new MemoryDocBackend<any>();
    const configBackend = new MemoryConfigBackend();

    const principals = await PrincipalStore.open(principalsBackend);
    const grants = await GrantStore.open(grantsBackend, { principals });
    const configs = await VersionedConfigStore.open(configBackend);
    const ledger = new MemoryLedger();

    await configs.put(
      {
        agentId: 'broken-agent',
        source: { repo: 'BeerCanLabs/broken' },
        skills: [],
        policy: null,
        owners: ['not-an-email-or-valid-prefix'],
      },
      { by: 'bootstrap', reason: 'initial' },
    );

    const agents = new Map<string, AgentRecord>();
    agents.set('broken-agent', makeAgent('broken-agent'));

    const state: OwnerMigrationState = {
      agents,
      configs,
      principals,
      grants,
      ledger,
    };

    const res = await convertLegacyOwners(state, {
      dryRun: true,
      by: 'user:admin',
    });

    assert.equal(res.ready, false);
    assert.equal(res.orphans.length, 1);
    assert.equal(res.orphans[0].reason, 'unresolvable_owner');
  });

  describe('F1: team-kind conversion crash & persistence and zero dryRun mutation', () => {
    it('apply mode converts legacy (kind: undefined) agent to team via defaultTeamAgents without 409 conflict and updates kind', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const configs = await VersionedConfigStore.open(new MemoryConfigBackend());
      const ledger = new MemoryLedger();

      await configs.put(
        {
          agentId: 'legacy-agent',
          source: { repo: 'BeerCanLabs/legacy' },
          skills: [],
          policy: null,
          owners: ['cloudflare:lead@example.com'],
        },
        { by: 'bootstrap', reason: 'initial' },
      );

      // Pre-S2b agent record with kind: undefined
      const agent = makeAgent('legacy-agent', { kind: undefined });
      const agents = new Map<string, AgentRecord>();
      agents.set('legacy-agent', agent);

      const state: OwnerMigrationState = { agents, configs, principals, grants, ledger };

      // Apply mode with defaultTeamAgents specifying legacy-agent
      const res = await convertLegacyOwners(state, {
        dryRun: false,
        by: 'user:admin',
        defaultTeamAgents: new Set(['legacy-agent']),
      });

      assert.equal(res.ready, true);
      assert.equal(res.convertedCount, 1);
      assert.equal(agent.kind, 'team');
      assert.equal(effectiveAgentKind(agent), 'team');

      const lead = grants.list({ scopeKind: 'agent', scopeId: 'legacy-agent' }).find((g) => g.role === 'accountable-lead');
      assert.equal(lead?.subject, 'user:lead');
    });

    it('apply mode persists kind: "team" to registryDir via registryOf(state) so it survives restart', async () => {
      const registryDir = mkdtempSync(join(tmpdir(), 'reg-test-'));
      try {
        const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
        const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
        const configs = await VersionedConfigStore.open(new MemoryConfigBackend());
        const ledger = new MemoryLedger();

        await configs.put(
          {
            agentId: 'persisted-agent',
            source: { repo: 'BeerCanLabs/persisted' },
            skills: [],
            policy: null,
            owners: ['cloudflare:lead@example.com'],
          },
          { by: 'bootstrap', reason: 'initial' },
        );

        const agent = makeAgent('persisted-agent', { kind: undefined });
        registryOf({ registryDir }).save(agent);

        const agents = new Map<string, AgentRecord>();
        agents.set('persisted-agent', agent);

        const state: OwnerMigrationState = { agents, configs, principals, grants, ledger, registryDir };

        const res = await convertLegacyOwners(state, {
          dryRun: false,
          by: 'user:admin',
          defaultTeamAgents: new Set(['persisted-agent']),
        });

        assert.equal(res.ready, true);
        assert.equal(agent.kind, 'team');

        // Reload from dynamic registry to prove persistence survives restart
        const loaded = loadDynamicRegistry(registryDir);
        const reloadedAgent = loaded.find((a) => a.id === 'persisted-agent');
        assert.ok(reloadedAgent);
        assert.equal(reloadedAgent.kind, 'team');
        assert.equal(effectiveAgentKind(reloadedAgent), 'team');
      } finally {
        rmSync(registryDir, { recursive: true, force: true });
      }
    });

    it('apply mode converts kind: "personal" agent to "team" via resolveAmbiguity', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const configs = await VersionedConfigStore.open(new MemoryConfigBackend());
      const ledger = new MemoryLedger();

      await configs.put(
        {
          agentId: 'reclass-agent',
          source: { repo: 'BeerCanLabs/reclass' },
          skills: [],
          policy: null,
          owners: ['cloudflare:lead@example.com', 'cloudflare:member@example.com'],
        },
        { by: 'bootstrap', reason: 'initial' },
      );

      const agent = makeAgent('reclass-agent', { kind: 'personal' });
      const agents = new Map<string, AgentRecord>();
      agents.set('reclass-agent', agent);

      const state: OwnerMigrationState = { agents, configs, principals, grants, ledger };

      const res = await convertLegacyOwners(state, {
        dryRun: false,
        by: 'user:admin',
        resolveAmbiguity: () => 'team',
      });

      assert.equal(res.ready, true);
      assert.equal(res.convertedCount, 2);
      assert.equal(agent.kind, 'team');
      assert.equal(effectiveAgentKind(agent), 'team');

      const lead = grants.list({ scopeKind: 'agent', scopeId: 'reclass-agent' }).find((g) => g.role === 'accountable-lead');
      assert.equal(lead?.subject, 'user:lead');
    });

    it('dryRun: true does not call wireGrantStoreKindLookup or mutate grants', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const ledger = new MemoryLedger();

      const agent = makeAgent('test-agent', { kind: undefined });
      const agents = new Map<string, AgentRecord>();
      agents.set('test-agent', agent);

      const state: OwnerMigrationState = { agents, principals, grants, ledger };

      const res = await convertLegacyOwners(state, {
        dryRun: true,
        by: 'user:admin',
      });

      // wireGrantStoreKindLookup was NOT called (agent.kind is untouched)
      assert.equal(agent.kind, undefined);
    });
  });

  describe('F2: skills human owner resolution, no ambient mkdirSync, skill:<id> ledger agentId', () => {
    const makeSkillVersion = (id: string, over: Partial<SkillVersionRecord> = {}): SkillVersionRecord => ({
      id,
      version: '1.0.0',
      repo: 'https://github.com/BeerCanLabs/skills',
      path: id,
      commit: '0'.repeat(40),
      manifest: { id, name: id, description: `${id} skill`, version: '1.0.0', tools: [] },
      status: 'approved',
      tests: 'passed',
      registeredBy: 'cloudflare:dale@example.com',
      registeredAt: '2026-10-08T00:00:00.000Z',
      ...over,
    });

    it('converts public skill with human owner and emits agentId: "skill:<id>" on ledger row', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const ledger = new MemoryLedger();
      const skills = new SkillRegistry();

      skills.save(makeSkillVersion('web-search', {
        owner: 'cloudflare:dale@example.com',
        registeredBy: 'cloudflare:dale@example.com',
        published: true,
      }));

      const state: OwnerMigrationState = {
        agents: new Map(),
        principals,
        grants,
        ledger,
        skills,
      };

      const res = await convertLegacyOwners(state, {
        dryRun: false,
        by: 'user:admin',
      });

      assert.equal(res.ready, true);
      assert.equal(res.convertedCount, 1);
      assert.equal(res.mappings[0].targetKind, 'skill');
      assert.equal(res.mappings[0].targetId, 'web-search');
      assert.equal(res.mappings[0].role, 'content-owner');
      assert.equal(res.mappings[0].principalId, 'user:dale');

      const owner = grants.activeContentOwnerOf({ kind: 'skill', id: 'web-search' });
      assert.equal(owner, 'user:dale');

      // Verify agentId: "skill:web-search" on ledger row
      const skillRow = ledger.query().find((r) => r.agentId === 'skill:web-search');
      assert.ok(skillRow, 'expected ledger row with agentId: skill:web-search');
      assert.equal(skillRow.action, 'OWNER_CONVERTED');
      assert.equal(skillRow.principalId, 'user:dale');
      assert.equal(ledger.verify().ok, true);
    });

    it('resolves agent-private skill to human owner, NOT manifest.owner agent ID (SK1)', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const ledger = new MemoryLedger();
      const skills = new SkillRegistry();

      skills.save(makeSkillVersion('donna-notes', {
        manifest: { id: 'donna-notes', name: 'donna-notes', description: 'private', version: '1.0.0', tools: [], owner: 'donna' },
        owner: 'cloudflare:sarah@example.com',
        registeredBy: 'cloudflare:sarah@example.com',
      }));

      const state: OwnerMigrationState = {
        agents: new Map(),
        principals,
        grants,
        ledger,
        skills,
      };

      const res = await convertLegacyOwners(state, {
        dryRun: true,
        by: 'user:admin',
      });

      assert.equal(res.ready, true);
      assert.equal(res.mappings.length, 1);
      assert.equal(res.mappings[0].principalId, 'user:sarah'); // NOT donna!
      assert.equal(res.mappings[0].legacyOwner, 'cloudflare:sarah@example.com');
    });

    it('resolves registeredBy-only skill to human registrant', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const ledger = new MemoryLedger();
      const skills = new SkillRegistry();

      skills.save(makeSkillVersion('legacy-skill', {
        owner: undefined,
        registeredBy: 'cloudflare:bob@example.com',
      }));

      const state: OwnerMigrationState = {
        agents: new Map(),
        principals,
        grants,
        ledger,
        skills,
      };

      const res = await convertLegacyOwners(state, {
        dryRun: true,
        by: 'user:admin',
      });

      assert.equal(res.ready, true);
      assert.equal(res.mappings.length, 1);
      assert.equal(res.mappings[0].principalId, 'user:bob');
    });

    it('records no_owner orphan when live skill has neither grant nor legacy human owner', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const ledger = new MemoryLedger();
      const skills = new SkillRegistry();

      skills.save(makeSkillVersion('unowned-skill', {
        owner: undefined,
        registeredBy: undefined as any,
      }));

      const state: OwnerMigrationState = {
        agents: new Map(),
        principals,
        grants,
        ledger,
        skills,
      };

      const res = await convertLegacyOwners(state, {
        dryRun: true,
        by: 'user:admin',
      });

      assert.equal(res.ready, false);
      assert.equal(res.orphans.length, 1);
      assert.equal(res.orphans[0].targetKind, 'skill');
      assert.equal(res.orphans[0].targetId, 'unowned-skill');
      assert.equal(res.orphans[0].reason, 'no_owner');
    });

    it('skips skill inspection when state.skills is omitted (no ambient disk read)', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const ledger = new MemoryLedger();

      const state: OwnerMigrationState = {
        agents: new Map(),
        principals,
        grants,
        ledger,
      };

      const res = await convertLegacyOwners(state, {
        dryRun: true,
        by: 'user:admin',
      });

      assert.equal(res.ready, true);
      assert.equal(res.mappings.length, 0);
    });
  });

  describe('F3: canonical multi-email alias deduplication', () => {
    it('personal agent with multiple email aliases resolving to 1 canonical principal is unambiguous', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const ledger = new MemoryLedger();

      await principals.create({
        id: 'user:steph',
        displayName: 'Steph S',
        emails: ['steph@hotmail.com', 'steph@gmail.com'],
        by: 'bootstrap',
      });

      const agent = makeAgent('steph-agent', {
        kind: 'personal',
        owners: ['cloudflare:steph@hotmail.com', 'oidc:steph@gmail.com'],
      });
      const agents = new Map<string, AgentRecord>([['steph-agent', agent]]);

      const state: OwnerMigrationState = { agents, principals, grants, ledger };

      const res = await convertLegacyOwners(state, {
        dryRun: true,
        by: 'user:admin',
      });

      assert.equal(res.ready, true);
      assert.equal(res.orphans.length, 0);
      assert.equal(res.mappings.length, 1);
      assert.equal(res.mappings[0].principalId, 'user:steph');
      assert.equal(res.mappings[0].role, 'content-owner');
    });

    it('team agent deduplicates co-owner member mappings and grants', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const ledger = new MemoryLedger();

      await principals.create({
        id: 'user:coowner',
        displayName: 'Co Owner',
        emails: ['co@hotmail.com', 'co@gmail.com'],
        by: 'bootstrap',
      });

      const agent = makeAgent('team-agent', {
        kind: 'team',
        owners: ['cloudflare:lead@example.com', 'cloudflare:co@hotmail.com', 'oidc:co@gmail.com'],
      });
      const agents = new Map<string, AgentRecord>([['team-agent', agent]]);

      const state: OwnerMigrationState = { agents, principals, grants, ledger };

      const res = await convertLegacyOwners(state, {
        dryRun: false,
        by: 'user:admin',
      });

      assert.equal(res.ready, true);
      assert.equal(res.convertedCount, 2); // 1 lead + 1 member (NOT 2 members)
      assert.equal(res.mappings.length, 2);
      assert.equal(res.mappings[0].role, 'accountable-lead');
      assert.equal(res.mappings[0].principalId, 'user:lead');
      assert.equal(res.mappings[1].role, 'member');
      assert.equal(res.mappings[1].principalId, 'user:coowner');

      // Idempotent second run skips
      const rerun = await convertLegacyOwners(state, {
        dryRun: false,
        by: 'user:admin',
      });
      assert.equal(rerun.convertedCount, 0);
      assert.equal(rerun.skippedCount, 1);
    });
  });

  describe('F4: fail-closed store reads & D15 pending-revoked slot occupancy', () => {
    it('fails closed when state.principals is unhealthy', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      Object.defineProperty(principals, 'healthy', { value: false });
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const ledger = new MemoryLedger();

      const state: OwnerMigrationState = {
        agents: new Map(),
        principals,
        grants,
        ledger,
      };

      await assert.rejects(
        convertLegacyOwners(state, { dryRun: true, by: 'user:admin' }),
        /state\.principals is unhealthy/i,
      );
    });

    it('fails closed when state.grants is unhealthy', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      Object.defineProperty(grants, 'healthy', { value: false });
      const ledger = new MemoryLedger();

      const state: OwnerMigrationState = {
        agents: new Map(),
        principals,
        grants,
        ledger,
      };

      await assert.rejects(
        convertLegacyOwners(state, { dryRun: true, by: 'user:admin' }),
        /state\.grants is unhealthy/i,
      );
    });

    it('treats non-expired pending-revoked content-owner grant as occupying slot (skips without 409 conflict)', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const ledger = new MemoryLedger();

      await principals.create({
        id: 'user:existing',
        displayName: 'Existing User',
        emails: ['existing@example.com'],
        by: 'bootstrap',
      });
      await principals.create({
        id: 'user:next',
        displayName: 'Next User',
        emails: ['next@example.com'],
        by: 'bootstrap',
      });

      // Create an active grant then start transfer so it enters pending-revoked
      await grants.grant({
        subject: 'user:existing',
        scope: { kind: 'agent', id: 'transferring-agent' },
        role: 'content-owner',
        by: 'user:admin',
        granterRole: 'admin',
        granterIsAdmin: true,
      });

      await grants.startOwnershipTransfer({
        scope: { kind: 'agent', id: 'transferring-agent' },
        fromSubject: 'user:existing',
        toSubject: 'user:next',
        by: 'user:existing',
        ttlMs: 60_000,
      });

      const agent = makeAgent('transferring-agent', {
        kind: 'personal',
        owners: ['cloudflare:existing@example.com'],
      });
      const agents = new Map<string, AgentRecord>([['transferring-agent', agent]]);

      const state: OwnerMigrationState = { agents, principals, grants, ledger };

      // Dry run skips because slot is occupied
      const dryRes = await convertLegacyOwners(state, {
        dryRun: true,
        by: 'user:admin',
      });
      assert.equal(dryRes.ready, true);
      assert.equal(dryRes.skippedCount, 1);
      assert.equal(dryRes.mappings.length, 0);

      // Apply mode also skips cleanly without throwing 409 owner_exists
      const applyRes = await convertLegacyOwners(state, {
        dryRun: false,
        by: 'user:admin',
      });
      assert.equal(applyRes.ready, true);
      assert.equal(applyRes.skippedCount, 1);
      assert.equal(applyRes.convertedCount, 0);
    });
  });

  describe('F5: RFC 5322 apostrophe emails and real MemoryLedger hash-chain verification', () => {
    it('converts email with apostrophe, preserves principalId in real MemoryLedger, and passes verify()', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const ledger = new MemoryLedger();

      await principals.create({
        id: "user:o'connor@example.com",
        displayName: "Liam O'Connor",
        emails: ["o'connor@example.com"],
        by: 'bootstrap',
      });

      const agent = makeAgent('oconnor-agent', {
        kind: 'personal',
        owners: ["cloudflare:o'connor@example.com"],
      });
      const agents = new Map<string, AgentRecord>([['oconnor-agent', agent]]);

      const state: OwnerMigrationState = { agents, principals, grants, ledger };

      const res = await convertLegacyOwners(state, {
        dryRun: false,
        by: 'user:admin',
      });

      assert.equal(res.ready, true);
      assert.equal(res.convertedCount, 1);
      assert.equal(res.mappings[0].principalId, "user:o'connor@example.com");

      // Verify real MemoryLedger
      assert.equal(ledger.query().length, 1);
      const row = ledger.query()[0];
      assert.equal(row.agentId, 'oconnor-agent');
      assert.equal(row.action, 'OWNER_CONVERTED');
      assert.equal(row.legacyOwner, "cloudflare:o'connor@example.com");
      assert.equal(row.principalId, "user:o'connor@example.com");
      assert.equal(row.role, 'content-owner');
      assert.equal(row.subject, "user:o'connor@example.com");
      assert.equal(ledger.verify().ok, true);
    });
  });

  describe('F6: dryRun materializedPrincipals & RETIRED_PLACEHOLDER_IDS / __* keys', () => {
    it('dryRun only returns missing principals in materializedPrincipals and sets mapping.materializedPrincipal', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const ledger = new MemoryLedger();

      // Seed user:existing
      await principals.create({
        id: 'user:existing',
        displayName: 'Existing User',
        emails: ['existing@example.com'],
        by: 'bootstrap',
      });

      const agents = new Map<string, AgentRecord>([
        ['agent-1', makeAgent('agent-1', { owners: ['cloudflare:existing@example.com'] })],
        ['agent-2', makeAgent('agent-2', { owners: ['cloudflare:brandnew@example.com'] })],
      ]);

      const state: OwnerMigrationState = { agents, principals, grants, ledger };

      const res = await convertLegacyOwners(state, {
        dryRun: true,
        by: 'user:admin',
      });

      assert.equal(res.ready, true);
      assert.equal(res.mappings.length, 2);
      // Only brandnew is in materializedPrincipals
      assert.deepEqual(res.materializedPrincipals, ['user:brandnew']);

      const m1 = res.mappings.find((m) => m.targetId === 'agent-1');
      const m2 = res.mappings.find((m) => m.targetId === 'agent-2');
      assert.equal(m1?.materializedPrincipal, undefined);
      assert.equal(m2?.materializedPrincipal, true);
    });

    it('ignores RETIRED_PLACEHOLDER_IDS and __* keys in ConfigStore without tripping orphans', async () => {
      const principals = await PrincipalStore.open(new MemoryDocBackend<any>());
      const grants = await GrantStore.open(new MemoryDocBackend<any>(), { principals });
      const ledger = new MemoryLedger();

      // Mock ConfigStore with reserved __ keys in agentIds()
      const configs = {
        agentIds: () => ['__runtime_meta', '__global__', 'normal-agent'],
        current: (id: string) =>
          id === 'normal-agent'
            ? { agentId: 'normal-agent', owners: ['cloudflare:normal@example.com'] }
            : id.startsWith('__')
              ? { agentId: id, owners: [] }
              : undefined,
      } as any;

      // RETIRED_PLACEHOLDER_IDS agents
      const agents = new Map<string, AgentRecord>();
      for (const retiredId of RETIRED_PLACEHOLDER_IDS) {
        agents.set(retiredId, makeAgent(retiredId, { owners: [] }));
      }
      agents.set('normal-agent', makeAgent('normal-agent'));

      const state: OwnerMigrationState = { agents, configs, principals, grants, ledger };

      const res = await convertLegacyOwners(state, {
        dryRun: true,
        by: 'user:admin',
      });

      assert.equal(res.ready, true);
      assert.equal(res.orphans.length, 0);
      assert.equal(res.mappings.length, 1);
      assert.equal(res.mappings[0].targetId, 'normal-agent');
      assert.equal(res.skippedCount, RETIRED_PLACEHOLDER_IDS.size);
    });
  });
});
