import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GrantStore,
  PrincipalStore,
} from '@beercanlabs/factory-bouncer';
import {
  MemoryDocBackend,
} from '@beercanlabs/factory-bouncer';
import {
  VersionedConfigStore,
  type AgentRecord,
  type ConfigRecord,
  type ConfigContent,
  type ConfigBackend,
  type ConfigMeta,
  type ConfigExport,
} from '@beercanlabs/factory-registrar';
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

class MemoryLedgerStore {
  readonly rows: Array<Record<string, unknown>> = [];
  private seq = 0;
  private prevHash = '0'.repeat(64);

  append(event: Record<string, unknown>) {
    this.seq++;
    const row = {
      ...event,
      seq: this.seq,
      prevHash: this.prevHash,
      hash: `hash_${this.seq}_${this.prevHash.slice(0, 8)}`,
    };
    this.prevHash = row.hash;
    this.rows.push(row);
    return row as any;
  }

  query(filter?: { agent?: string | null }) {
    if (filter?.agent) {
      return this.rows.filter((r) => r.agentId === filter.agent);
    }
    return [...this.rows];
  }

  head() {
    return { seq: this.seq, hash: this.prevHash };
  }

  verify() {
    return { ok: true, rows: this.rows.length, head: this.prevHash, checkpointsChecked: 0 };
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
    const ledger = new MemoryLedgerStore();

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
      ledger: ledger as any,
    };

    const initialPrincipals = principals.list();
    const initialGrants = grants.list();
    const initialLedgerRows = ledger.rows.length;

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
    assert.equal(ledger.rows.length, initialLedgerRows);
  });

  it('zero-orphan refusal gate blocks apply with zero writes when any live agent lacks an owner/lead', async () => {
    const principalsBackend = new MemoryDocBackend<any>();
    const grantsBackend = new MemoryDocBackend<any>();
    const configBackend = new MemoryConfigBackend();

    const principals = await PrincipalStore.open(principalsBackend);
    const grants = await GrantStore.open(grantsBackend, { principals });
    const configs = await VersionedConfigStore.open(configBackend);
    const ledger = new MemoryLedgerStore();

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
      ledger: ledger as any,
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
    assert.equal(ledger.rows.length, 0);

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
    const ledger = new MemoryLedgerStore();

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
      ledger: ledger as any,
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
    const higginsRow = ledger.rows.find((r) => r.agentId === 'higgins');
    const finleyRow = ledger.rows.find((r) => r.agentId === 'finley');
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
    const ledger = new MemoryLedgerStore();

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
      ledger: ledger as any,
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
    assert.equal(ledger.rows.length, 3);
    assert.equal(ledger.verify().ok, true);
  });

  it('second apply run is completely idempotent with zero duplicate grants and zero new ledger rows', async () => {
    const principalsBackend = new MemoryDocBackend<any>();
    const grantsBackend = new MemoryDocBackend<any>();
    const configBackend = new MemoryConfigBackend();

    const principals = await PrincipalStore.open(principalsBackend);
    const grants = await GrantStore.open(grantsBackend, { principals });
    const configs = await VersionedConfigStore.open(configBackend);
    const ledger = new MemoryLedgerStore();

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
      ledger: ledger as any,
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
    const ledgerCountAfterFirst = ledger.rows.length;

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
    assert.equal(ledger.rows.length, ledgerCountAfterFirst);
    assert.equal(ledger.verify().ok, true);
  });

  it('handles multiple legacy owners on personal agent via resolveAmbiguity', async () => {
    const principalsBackend = new MemoryDocBackend<any>();
    const grantsBackend = new MemoryDocBackend<any>();
    const configBackend = new MemoryConfigBackend();

    const principals = await PrincipalStore.open(principalsBackend);
    const grants = await GrantStore.open(grantsBackend, { principals });
    const configs = await VersionedConfigStore.open(configBackend);
    const ledger = new MemoryLedgerStore();

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
      ledger: ledger as any,
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
    const ledger = new MemoryLedgerStore();

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
      ledger: ledger as any,
    };

    const res = await convertLegacyOwners(state, {
      dryRun: true,
      by: 'user:admin',
    });

    assert.equal(res.ready, false);
    assert.equal(res.orphans.length, 1);
    assert.equal(res.orphans[0].reason, 'unresolvable_owner');
  });
});
