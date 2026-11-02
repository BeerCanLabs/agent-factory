import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOMAIN_SUBJECT,
  FileDocBackend,
  GRANT_SUBJECT,
  GROUP_SUBJECT,
  GcsDocBackend,
  GrantStore,
  GrantStoreError,
  GrantStoreUnavailableError,
  PrincipalStore,
  PrincipalStoreUnavailableError,
  S3CliDocBackend,
  authorize,
  docBackendFromUri,
  normalizeDomain,
  normalizeGrantScope,
  parseGrantSubject,
  parseIsoTimestamp,
  type AwsCliRunner,
  type GrantsDoc,
  type PrincipalsDoc,
  type VersionedDocBackend,
  type VersionedSnapshot,
} from './index.js';

describe('GrantStore & domain grants (S2 #351)', () => {
  it('AC1: domain:sackrider.org -> viewer auto-materializes principal on first verified @sackrider.org sign-in, revokes immediately, and writes zero state for ungranted strangers', async () => {
    let clock = Date.parse('2026-11-02T10:00:00.000Z');
    const now = () => new Date((clock += 1000));

    const principals = await PrincipalStore.open(undefined, { now });
    const grants = await GrantStore.open(undefined, { now, principals });

    const domainGrant = await grants.grant({
      subject: 'DOMAIN:Sackrider.ORG',
      scope: { kind: 'fleet' },
      role: 'viewer',
      by: 'user:dale',
    });
    assert.equal(domainGrant.subject, 'domain:sackrider.org');
    assert.equal(domainGrant.role, 'viewer');
    assert.equal(domainGrant.state, 'active');
    assert.equal(grants.hasActiveDomainGrant('sackrider.org'), true);
    assert.equal(grants.hasActiveDomainGrant('SACKRIDER.ORG'), true);
    assert.equal(grants.hasActiveDomainGrant('other.org'), false);

    // 1. Ungranted stranger (@other.org) creates ZERO principal record and receives zero grants (D6).
    const stranger = await grants.materializeOnVerifiedSignIn({
      idp: 'cloudflare-access',
      sub: 'cf-stranger-1',
      email: 'Mallory@Other.ORG',
      emailVerified: true,
    });
    assert.equal(stranger.ok, true);
    if (!stranger.ok) throw new Error('expected ok');
    assert.equal(stranger.admitted, false);
    assert.equal(stranger.materialized, false);
    assert.equal(stranger.principal, null);
    assert.equal(stranger.record, null);
    assert.deepEqual(stranger.grants, []);
    assert.deepEqual(principals.list(), [], 'zero shadow/placeholder principal records written for ungranted stranger');

    // 2. Unverified @sackrider.org email is rejected with zero writes (R13).
    const unverified = await grants.materializeOnVerifiedSignIn({
      idp: 'oidc',
      sub: 'oidc-unverified-1',
      email: 'sam@sackrider.org',
      emailVerified: false,
    });
    assert.deepEqual(unverified, { ok: false, reason: 'email_not_verified' });
    assert.deepEqual(principals.list(), []);

    // 3. First verified @sackrider.org sign-in auto-materializes canonical principal + viewer fleet grant.
    const firstSignIn = await grants.materializeOnVerifiedSignIn({
      idp: 'cloudflare-access',
      sub: 'cf-sub-sam',
      email: 'Sam@Sackrider.ORG',
      emailVerified: true,
      displayName: 'Sam Sackrider',
    });
    assert.equal(firstSignIn.ok, true);
    if (!firstSignIn.ok || !firstSignIn.principal || !firstSignIn.record) {
      throw new Error('expected materialized principal');
    }
    assert.equal(firstSignIn.admitted, true);
    assert.equal(firstSignIn.materialized, true);
    assert.equal(firstSignIn.principal.actor, 'user:sam');
    assert.deepEqual(firstSignIn.principal.roles, ['viewer']);
    assert.deepEqual(firstSignIn.fleetRoles, ['viewer']);
    assert.equal(firstSignIn.grants.length, 1);
    assert.equal(firstSignIn.grants[0].source, 'domain');
    assert.equal(firstSignIn.grants[0].grant.id, domainGrant.id);
    assert.equal(firstSignIn.record.idpBindings.length, 1);
    assert.equal(firstSignIn.record.idpBindings[0].sub, 'cf-sub-sam');

    // Bouncer privilege check with derived viewer role succeeds on read privilege and denies admin privilege.
    assert.equal(authorize({ principal: firstSignIn.principal, privilege: 'agents.read' }).allowed, true);
    assert.equal(authorize({ principal: firstSignIn.principal, privilege: 'policy.set' }).allowed, false);

    // Second sign-in for already-materialized user updates binding without re-creating.
    const secondSignIn = await grants.materializeOnVerifiedSignIn({
      idp: 'cloudflare-access',
      sub: 'cf-sub-sam',
      email: 'sam@sackrider.org',
      emailVerified: true,
    });
    assert.equal(secondSignIn.ok, true);
    if (!secondSignIn.ok) throw new Error('expected ok');
    assert.equal(secondSignIn.materialized, false);
    assert.equal(secondSignIn.admitted, true);
    assert.deepEqual(secondSignIn.principal?.roles, ['viewer']);

    // 4. Revoking the domain grant removes access immediately on next evaluation / sign-in.
    await grants.revoke(domainGrant.id, { by: 'user:dale' });
    assert.equal(grants.hasActiveDomainGrant('sackrider.org'), false);
    assert.deepEqual(grants.effectiveGrantsFor({ subject: 'user:sam' }), []);
    assert.deepEqual(grants.effectiveFleetRolesFor({ subject: 'user:sam' }), []);

    const afterRevoke = await grants.materializeOnVerifiedSignIn({
      idp: 'cloudflare-access',
      sub: 'cf-sub-sam',
      email: 'sam@sackrider.org',
      emailVerified: true,
    });
    assert.equal(afterRevoke.ok, true);
    if (!afterRevoke.ok || !afterRevoke.principal) throw new Error('expected existing principal');
    assert.equal(afterRevoke.admitted, false);
    assert.deepEqual(afterRevoke.principal.roles, []);
    assert.deepEqual(afterRevoke.grants, []);
    assert.equal(authorize({ principal: afterRevoke.principal, privilege: 'agents.read' }).allowed, false);

    // Brand-new @sackrider.org user after revocation does NOT materialize a principal.
    const lateUser = await grants.materializeOnVerifiedSignIn({
      idp: 'cloudflare-access',
      sub: 'cf-sub-late',
      email: 'newbie@sackrider.org',
      emailVerified: true,
    });
    assert.equal(lateUser.ok, true);
    if (!lateUser.ok) throw new Error('expected ok');
    assert.equal(lateUser.admitted, false);
    assert.equal(lateUser.materialized, false);
    assert.equal(lateUser.principal, null);
    assert.equal(principals.findByEmail('newbie@sackrider.org'), undefined);
  });

  it('AC1 + multi-email: canonical principal signing in via @hotmail.com still inherits domain:sackrider.org grant from linked @sackrider.org alias until unlinked', async () => {
    let clock = Date.parse('2026-11-02T11:00:00.000Z');
    const now = () => new Date((clock += 1000));
    const principals = await PrincipalStore.open(undefined, { now });
    const grants = await GrantStore.open(undefined, { now, principals });

    await principals.create({
      id: 'user:stephanie',
      displayName: 'Stephanie Sackrider',
      emails: ['stephaniesackrider@hotmail.com', 'stephanie@sackrider.org'],
      by: 'user:dale',
    });
    await grants.grant({
      subject: 'domain:sackrider.org',
      scope: { kind: 'fleet' },
      role: 'viewer',
      by: 'user:dale',
    });

    const hotmailSignIn = await grants.materializeOnVerifiedSignIn({
      idp: 'microsoft',
      sub: 'ms-oid-steph',
      email: 'StephanieSackrider@Hotmail.com',
      emailVerified: true,
    });
    assert.equal(hotmailSignIn.ok, true);
    if (!hotmailSignIn.ok || !hotmailSignIn.principal) throw new Error('expected ok');
    assert.equal(hotmailSignIn.principal.actor, 'user:stephanie');
    assert.deepEqual(hotmailSignIn.principal.roles, ['viewer']);
    assert.equal(hotmailSignIn.grants[0].source, 'domain');

    // Removing the @sackrider.org email from user:stephanie immediately drops domain-derived access.
    await principals.removeEmail('user:stephanie', 'stephanie@sackrider.org', 'user:dale');
    assert.deepEqual(grants.effectiveGrantsFor({ subject: 'user:stephanie' }), []);

    // Concurrent first-time verified sign-ins for the same @sackrider.org email resolve cleanly without 409 races.
    const [raceA, raceB] = await Promise.all([
      grants.materializeOnVerifiedSignIn({
        idp: 'cloudflare-access',
        sub: 'cf-jordan',
        email: 'Jordan@Sackrider.ORG',
        emailVerified: true,
      }),
      grants.materializeOnVerifiedSignIn({
        idp: 'cloudflare-access',
        sub: 'cf-jordan',
        email: 'jordan@sackrider.org',
        emailVerified: true,
      }),
    ]);
    assert.equal(raceA.ok, true);
    assert.equal(raceB.ok, true);
    if (!raceA.ok || !raceB.ok) throw new Error('expected ok');
    assert.equal(raceA.principal?.actor, 'user:jordan');
    assert.equal(raceB.principal?.actor, 'user:jordan');
    assert.deepEqual(raceA.principal?.roles, ['viewer']);
    assert.deepEqual(raceB.principal?.roles, ['viewer']);
  });

  it('AC2: refuses revoking, downgrading, expiring, or removing the last active human admin with 409 last_admin and zero writes', async () => {
    let clock = Date.parse('2026-11-02T12:00:00.000Z');
    const now = () => new Date(clock);

    let writeCount = 0;
    const baseBackend = docBackendFromUri<GrantsDoc>(undefined, mkdtempSync(join(tmpdir(), 'grants-ac2-')));
    const trackedBackend: VersionedDocBackend<GrantsDoc> = {
      description: baseBackend.description,
      loadLatest: () => baseBackend.loadLatest(),
      loadState: () => baseBackend.loadState!(),
      write: async (snap) => {
        writeCount += 1;
        await baseBackend.write(snap);
      },
    };

    try {
      const store = await GrantStore.open(trackedBackend, { now });

      const daleAdmin = await store.grant({
        subject: 'user:dale',
        scope: { kind: 'fleet' },
        role: 'admin',
        by: 'user:dale',
      });
      // Non-human, domain, group, and soon-to-expire human admin grants MUST NOT satisfy the active human admin invariant.
      await store.grant({
        subject: 'service:break-glass',
        scope: { kind: 'fleet' },
        role: 'admin',
        by: 'user:dale',
      });
      await store.grant({
        subject: 'domain:sackrider.org',
        scope: { kind: 'fleet' },
        role: 'admin',
        by: 'user:dale',
      });
      await store.grant({
        subject: 'group:ops',
        scope: { kind: 'fleet' },
        role: 'admin',
        by: 'user:dale',
      });
      await store.grant({
        subject: 'user:temp-admin',
        scope: { kind: 'fleet' },
        role: 'admin',
        expiresAt: '2026-11-02T12:05:00.000Z',
        by: 'user:dale',
      });

      // Advance past temp-admin expiry so user:dale is the sole active human admin.
      clock = Date.parse('2026-11-02T12:10:00.000Z');
      const writesBeforeRefusals = writeCount;
      const versionBeforeRefusals = store.version;

      await assert.rejects(
        () => store.revoke(daleAdmin.id, { by: 'user:dale' }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'last_admin',
      );
      await assert.rejects(
        () =>
          store.revokeMatching(
            { subject: 'user:dale', scope: { kind: 'fleet' }, role: 'admin' },
            { by: 'user:dale' },
          ),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'last_admin',
      );
      await assert.rejects(
        () => store.revokeAllForSubject('user:dale', { by: 'user:dale' }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'last_admin',
      );
      await assert.rejects(
        () => store.downgrade(daleAdmin.id, 'operator', { by: 'user:dale' }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'last_admin',
      );
      await assert.rejects(
        () => store.downgrade('user:dale', 'viewer', { by: 'user:dale' }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'last_admin',
      );
      await assert.rejects(
        () => store.update(daleAdmin.id, { role: 'approver', by: 'user:dale' }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'last_admin',
      );
      await assert.rejects(
        () => store.update(daleAdmin.id, { expiresAt: '2026-11-02T12:00:00.000Z', by: 'user:dale' }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'last_admin',
      );
      assert.throws(
        () => store.assertCanRemovePrincipal('user:dale'),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'last_admin',
      );

      assert.equal(writeCount, writesBeforeRefusals, 'refused last_admin mutations must make zero backend writes');
      assert.equal(store.version, versionBeforeRefusals);

      // Adding a second active human admin permits downgrading user:dale, then protects the new sole human admin.
      const stephAdmin = await store.grant({
        subject: 'user:stephanie',
        scope: { kind: 'fleet' },
        role: 'admin',
        by: 'user:dale',
      });
      const downgraded = await store.downgrade('user:dale', 'operator', { by: 'user:stephanie' });
      assert.equal(downgraded.role, 'operator');
      assert.deepEqual(store.effectiveFleetRolesFor({ subject: 'user:dale' }), ['operator']);

      await assert.rejects(
        () => store.revoke(stephAdmin.id, { by: 'user:stephanie' }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'last_admin',
      );
    } finally {
      const dir = trackedBackend.description.replace(/^file:\/\//, '');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC3: fails closed (503) on backend read/reload/write errors, corrupt snapshots, or unhealthy PrincipalStore (R8)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grants-ac3-'));
    try {
      const principals = await PrincipalStore.open();
      await principals.create({
        id: 'user:dale',
        displayName: 'Dale',
        emails: ['dale@sackrider.org'],
        by: 'bootstrap',
      });

      const fileBackend = new FileDocBackend<GrantsDoc>(dir);
      const store = await GrantStore.open(fileBackend, { principals });
      await store.grant({
        subject: 'user:dale',
        scope: { kind: 'fleet' },
        role: 'admin',
        by: 'user:dale',
      });
      assert.deepEqual(store.effectiveFleetRolesFor({ subject: 'user:dale' }), ['admin']);

      // Corrupt 1.json SHA-256 on disk and reload -> fails closed with 503 GrantStoreUnavailableError, never serving cached grants.
      const snapPath = join(dir, '1.json');
      const raw = JSON.parse(readFileSync(snapPath, 'utf8')) as VersionedSnapshot<GrantsDoc>;
      raw.data.grants[0].role = 'viewer';
      writeFileSync(snapPath, JSON.stringify(raw, null, 2));

      await assert.rejects(
        () => store.reload(),
        (err: unknown) => err instanceof GrantStoreUnavailableError && err.status === 503,
      );
      assert.equal(store.healthy, false);

      assert.throws(
        () => store.effectiveGrantsFor({ subject: 'user:dale' }),
        (err: unknown) => err instanceof GrantStoreUnavailableError && err.status === 503,
      );
      assert.throws(
        () => store.effectiveFleetRolesFor({ subject: 'user:dale' }),
        (err: unknown) => err instanceof GrantStoreUnavailableError && err.status === 503,
      );
      assert.throws(
        () => store.list(),
        (err: unknown) => err instanceof GrantStoreUnavailableError && err.status === 503,
      );
      await assert.rejects(
        () =>
          store.materializeOnVerifiedSignIn({
            idp: 'cloudflare-access',
            sub: 'sub-1',
            email: 'dale@sackrider.org',
            emailVerified: true,
          }),
        (err: unknown) => err instanceof GrantStoreUnavailableError && err.status === 503,
      );

      const evaluated = store.evaluateEffectiveGrants({ subject: 'user:dale' });
      assert.deepEqual(evaluated, {
        ok: false,
        allowed: false,
        status: 503,
        code: 'grant_store_unavailable',
        message: evaluated.ok ? '' : evaluated.message,
      });

      // Transient backend throwing on open/loadState also fails closed with 503.
      const throwingBackend: VersionedDocBackend<GrantsDoc> = {
        description: 's3://broken-bucket/grants',
        loadLatest: async () => {
          throw new Error('S3 network timeout');
        },
        loadState: async () => {
          throw new Error('S3 network timeout');
        },
        write: async () => {
          throw new Error('S3 write timeout');
        },
      };
      await assert.rejects(
        () => GrantStore.open(throwingBackend),
        (err: unknown) => err instanceof GrantStoreUnavailableError && err.status === 503,
      );

      // Healthy GrantStore paired with an unhealthy PrincipalStore also fails closed (503).
      const healthyGrants = await GrantStore.open(undefined, { principals });
      await healthyGrants.grant({
        subject: 'user:dale',
        scope: { kind: 'fleet' },
        role: 'admin',
        by: 'user:dale',
      });
      principals.markUnhealthy(new Error('principals S3 read error'));
      assert.throws(
        () => healthyGrants.effectiveGrantsFor({ subject: 'user:dale' }),
        (err: unknown) => err instanceof PrincipalStoreUnavailableError && err.status === 503,
      );
      const evalPrincipalDown = healthyGrants.evaluateEffectiveGrants({ subject: 'user:dale' });
      assert.equal(evalPrincipalDown.ok, false);
      if (evalPrincipalDown.ok) throw new Error('expected 503');
      assert.equal(evalPrincipalDown.status, 503);
      assert.equal(evalPrincipalDown.code, 'principal_store_unavailable');
      assert.equal(evalPrincipalDown.allowed, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces scopes, roles, E12 sub-role reservation, machine service subjects, group grants, and unique owner/lead/budget-owner invariants', async () => {
    const store = await GrantStore.open();

    // Subject & scope regexes / validators
    assert.equal(DOMAIN_SUBJECT.test('domain:sackrider.org'), true);
    assert.equal(DOMAIN_SUBJECT.test('domain:sub.sackrider.org'), true);
    assert.equal(DOMAIN_SUBJECT.test('domain:localhost'), false);
    assert.equal(GROUP_SUBJECT.test('group:family_team.1'), true);
    assert.equal(GRANT_SUBJECT.test('service:gatekeeper'), true);
    assert.equal(normalizeDomain(' Sackrider.ORG '), 'sackrider.org');
    assert.deepEqual(parseGrantSubject(' GROUP:Eng-Team '), { subject: 'group:eng-team', kind: 'group' });
    assert.deepEqual(normalizeGrantScope({ kind: 'agent', id: ' Higgins ' }), { kind: 'agent', id: 'higgins' });

    // Machine-only fleet roles require service:<name>
    await assert.rejects(
      () => store.grant({ subject: 'user:dale', scope: { kind: 'fleet' }, role: 'ingest', by: 'user:dale' }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 400 && err.code === 'invalid_role',
    );
    const svcGrant = await store.grant({
      subject: 'service:ingest-worker',
      scope: { kind: 'fleet' },
      role: 'ingest',
      by: 'user:dale',
    });
    assert.equal(svcGrant.role, 'ingest');
    assert.deepEqual(store.effectiveFleetGrantRolesFor({ subject: 'service:ingest-worker' }), ['ingest']);
    // service:<name> cannot hold agent/skill grants
    await assert.rejects(
      () =>
        store.grant({
          subject: 'service:ingest-worker',
          scope: { kind: 'agent', id: 'higgins' },
          role: 'member',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 400 && err.code === 'invalid_role',
    );

    // Personal agent unique content-owner + mutual exclusion with accountable-lead (D10, D11)
    await store.grant({
      subject: 'user:dale',
      scope: { kind: 'agent', id: 'donna' },
      role: 'content-owner',
      agentKind: 'personal',
      by: 'user:dale',
    });
    assert.equal(store.isActiveContentOwner('user:dale', { kind: 'agent', id: 'donna' }), true);

    await assert.rejects(
      () =>
        store.grant({
          subject: 'user:stephanie',
          scope: { kind: 'agent', id: 'donna' },
          role: 'content-owner',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'owner_exists',
    );
    await assert.rejects(
      () =>
        store.grant({
          subject: 'user:stephanie',
          scope: { kind: 'agent', id: 'donna' },
          role: 'accountable-lead',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'agent_kind_conflict',
    );

    // Agent custom sub-roles allowed, while 'Owner' (E12) and fleet role names are rejected on agent scope
    const familySubRole = await store.grant({
      subject: 'group:family',
      scope: { kind: 'agent', id: 'donna' },
      role: 'Family',
      by: 'user:dale',
    });
    assert.equal(familySubRole.role, 'Family');

    const agentPeer = await store.grant({
      subject: 'user:switch-owner',
      scope: { kind: 'agent', id: 'donna' },
      role: 'agent-member',
      by: 'user:dale',
    });
    assert.equal(agentPeer.role, 'agent-member');

    for (const forbiddenAgentRole of ['owner', 'Owner', 'subrole:owner', 'admin', 'viewer']) {
      await assert.rejects(
        () =>
          store.grant({
            subject: 'user:stephanie',
            scope: { kind: 'agent', id: 'donna' },
            role: forbiddenAgentRole,
            by: 'user:dale',
          }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 400 && err.code === 'invalid_role',
      );
    }

    // Group grant resolution in effectiveGrantsFor
    const stephEffective = store.effectiveGrantsFor({
      subject: 'user:stephanie',
      groupIds: ['family'],
    });
    assert.equal(stephEffective.length, 1);
    assert.equal(stephEffective[0].source, 'group');
    assert.equal(stephEffective[0].grant.role, 'Family');

    // Team agent unique accountable-lead + admin replaceExisting
    await store.grant({
      subject: 'user:dale',
      scope: { kind: 'agent', id: 'archie' },
      role: 'accountable-lead',
      agentKind: 'team',
      by: 'user:dale',
    });
    await assert.rejects(
      () =>
        store.grant({
          subject: 'user:geordi',
          scope: { kind: 'agent', id: 'archie' },
          role: 'accountable-lead',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'lead_exists',
    );
    const replacedLead = await store.grant({
      subject: 'user:geordi',
      scope: { kind: 'agent', id: 'archie' },
      role: 'accountable-lead',
      replaceExisting: true,
      by: 'user:dale',
    });
    assert.equal(replacedLead.subject, 'user:geordi');
    assert.equal(
      store.list({ scopeKind: 'agent', scopeId: 'archie' }).filter((g) => g.role === 'accountable-lead').length,
      1,
    );

    // Skill unique content-owner & member grants (D25)
    await store.grant({
      subject: 'user:dale',
      scope: { kind: 'skill', id: 'deploy-helper' },
      role: 'content-owner',
      by: 'user:dale',
    });
    await assert.rejects(
      () =>
        store.grant({
          subject: 'user:stephanie',
          scope: { kind: 'skill', id: 'deploy-helper' },
          role: 'content-owner',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'owner_exists',
    );
    await store.grant({
      subject: 'group:eng',
      scope: { kind: 'skill', id: 'deploy-helper' },
      role: 'member',
      by: 'user:dale',
    });

    // Unique fleet budget-owner (D26)
    await store.grant({
      subject: 'user:dale',
      scope: { kind: 'fleet' },
      role: 'budget-owner',
      by: 'user:dale',
    });
    await assert.rejects(
      () =>
        store.grant({
          subject: 'user:stephanie',
          scope: { kind: 'fleet' },
          role: 'budget-owner',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'budget_owner_exists',
    );
  });

  it('enforces strict ISO-8601 expiry, excludes expired grants immediately, and frees unique slots after expiry', async () => {
    let clock = Date.parse('2026-11-02T14:00:00.000Z');
    const store = await GrantStore.open(undefined, { now: () => new Date(clock) });

    for (const badTs of ['1', 'tomorrow', '2026-02-31T00:00:00Z', '2026-11-02 15:00:00Z', '2026-13-01T00:00:00Z']) {
      assert.throws(
        () => parseIsoTimestamp(badTs),
        (err: unknown) => err instanceof GrantStoreError && err.status === 400 && err.code === 'invalid_expiry',
      );
    }

    // Past timestamp rejected on create with 400 expired_timestamp
    await assert.rejects(
      () =>
        store.grant({
          subject: 'user:guest',
          scope: { kind: 'fleet' },
          role: 'viewer',
          expiresAt: '2026-11-02T13:59:59Z',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 400 && err.code === 'expired_timestamp',
    );

    const tempOwner = await store.grant({
      subject: 'user:alice',
      scope: { kind: 'skill', id: 'temp-skill' },
      role: 'content-owner',
      expiresAt: '2026-11-02T15:00:00+00:00',
      by: 'user:dale',
    });
    assert.equal(tempOwner.expiresAt, '2026-11-02T15:00:00.000Z');
    assert.equal(store.isActiveContentOwner('user:alice', { kind: 'skill', id: 'temp-skill' }), true);

    // Advance clock to exact expiry -> excluded from effective grants and frees content-owner slot
    clock = Date.parse('2026-11-02T15:00:00.000Z');
    assert.equal(store.isActiveContentOwner('user:alice', { kind: 'skill', id: 'temp-skill' }), false);
    assert.deepEqual(store.effectiveGrantsFor({ subject: 'user:alice' }), []);

    const nextOwner = await store.grant({
      subject: 'user:bob',
      scope: { kind: 'skill', id: 'temp-skill' },
      role: 'content-owner',
      by: 'user:dale',
    });
    assert.equal(nextOwner.subject, 'user:bob');
  });

  it('enforces D13/D32 pre-grant boundaries: admin pre-grant auto-creates principal; non-admin grant to unseen subject/group/domain/fleet rejects with 403 and zero writes', async () => {
    let clock = Date.parse('2026-11-02T16:00:00.000Z');
    const now = () => new Date((clock += 1000));
    const principals = await PrincipalStore.open(undefined, { now });
    const knownGroups = new Set(['family']);
    const grants = await GrantStore.open(undefined, { now, principals, knownGroups });

    await principals.create({
      id: 'user:dale',
      displayName: 'Dale',
      emails: ['dale@sackrider.org'],
      by: 'bootstrap',
    });
    await principals.create({
      id: 'user:stephanie',
      displayName: 'Stephanie',
      emails: ['stephanie@sackrider.org'],
      by: 'user:dale',
    });

    await grants.grant({
      subject: 'user:dale',
      scope: { kind: 'agent', id: 'donna' },
      role: 'content-owner',
      by: 'user:dale',
    });

    const principalsVersionBefore = principals.version;
    const grantsVersionBefore = grants.version;

    // Non-admin (content-owner) attempting to grant to unseen email -> 403 unknown_subject, ZERO writes in PrincipalStore or GrantStore
    await assert.rejects(
      () =>
        grants.grant({
          subject: 'unseen.friend@gmail.com',
          scope: { kind: 'agent', id: 'donna' },
          role: 'member',
          granterRole: 'content-owner',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 403 && err.code === 'unknown_subject',
    );
    // Non-admin attempting to grant to unknown user:<id> -> 403 unknown_subject
    await assert.rejects(
      () =>
        grants.grant({
          subject: 'user:ghost',
          scope: { kind: 'agent', id: 'donna' },
          role: 'member',
          granterIsAdmin: false,
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 403 && err.code === 'unknown_subject',
    );
    // Non-admin attempting to grant to unknown group -> 403 unknown_subject
    await assert.rejects(
      () =>
        grants.grant({
          subject: 'group:nonexistent',
          scope: { kind: 'agent', id: 'donna' },
          role: 'member',
          granterRole: 'content-owner',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 403 && err.code === 'unknown_subject',
    );
    // Non-admin attempting to grant to domain:* or fleet -> 403 forbidden
    await assert.rejects(
      () =>
        grants.grant({
          subject: 'domain:sackrider.org',
          scope: { kind: 'agent', id: 'donna' },
          role: 'member',
          granterRole: 'content-owner',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 403 && err.code === 'forbidden',
    );
    await assert.rejects(
      () =>
        grants.grant({
          subject: 'user:stephanie',
          scope: { kind: 'fleet' },
          role: 'viewer',
          granterRole: 'content-owner',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 403 && err.code === 'forbidden',
    );

    assert.equal(principals.version, principalsVersionBefore, 'zero PrincipalStore writes on rejected non-admin grants');
    assert.equal(grants.version, grantsVersionBefore, 'zero GrantStore writes on rejected non-admin grants');

    // Non-admin granting to ALREADY-KNOWN user:stephanie and known group:family succeeds!
    const memberGrant = await grants.grant({
      subject: 'user:stephanie',
      scope: { kind: 'agent', id: 'donna' },
      role: 'member',
      granterRole: 'content-owner',
      by: 'user:dale',
    });
    assert.equal(memberGrant.subject, 'user:stephanie');

    const groupGrant = await grants.grant({
      subject: 'group:family',
      scope: { kind: 'agent', id: 'donna' },
      role: 'Family',
      granterRole: 'content-owner',
      by: 'user:dale',
    });
    assert.equal(groupGrant.subject, 'group:family');

    // Admin pre-grant to an unseen email whose grant fails uniqueness MUST NOT leave an orphan principal!
    await assert.rejects(
      () =>
        grants.grant({
          subject: 'orphan-check@example.com',
          scope: { kind: 'agent', id: 'donna' },
          role: 'content-owner',
          granterRole: 'admin',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'owner_exists',
    );
    assert.equal(principals.findByEmail('orphan-check@example.com'), undefined);

    // Valid admin pre-grant to unseen email auto-provisions canonical principal and binds grant to its user:<slug> ID (D32).
    const preGrant = await grants.grant({
      subject: 'New.Friend@Example.com',
      subjectDisplayName: 'New Friend',
      scope: { kind: 'fleet' },
      role: 'viewer',
      granterRole: 'admin',
      by: 'user:dale',
    });
    const provisioned = principals.findByEmail('new.friend@example.com');
    assert.ok(provisioned);
    assert.equal(preGrant.subject, provisioned.id);
    assert.deepEqual(grants.effectiveFleetRolesFor({ subject: provisioned.id }), ['viewer']);

    // Even admin cannot bind a grant to a nonexistent non-email user:<slug> when PrincipalStore is attached.
    await assert.rejects(
      () =>
        grants.grant({
          subject: 'user:missing-slug',
          scope: { kind: 'fleet' },
          role: 'viewer',
          granterRole: 'admin',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 404 && err.code === 'unknown_subject',
    );

    // Accountable-lead may grant 'member' on a team agent, and is refused non-'member' roles (D11).
    const teamMemberGrant = await grants.grant({
      subject: 'user:stephanie',
      scope: { kind: 'agent', id: 'archie' },
      role: 'member',
      granterRole: 'accountable-lead',
      by: 'user:dale',
    });
    assert.equal(teamMemberGrant.role, 'member');
    await assert.rejects(
      () =>
        grants.grant({
          subject: 'user:stephanie',
          scope: { kind: 'agent', id: 'archie' },
          role: 'Family',
          granterRole: 'accountable-lead',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 403 && err.code === 'forbidden',
    );
  });

  it('implements D15 two-phase content-owner transfer states (pending-revoked read-only, pending-accepted zero access, accept, decline/cancel, expiry sweep)', async () => {
    let clock = Date.parse('2026-11-02T18:00:00.000Z');
    const store = await GrantStore.open(undefined, { now: () => new Date(clock) });

    await store.grant({
      subject: 'user:alice',
      scope: { kind: 'agent', id: 'solo-bot' },
      role: 'content-owner',
      by: 'user:alice',
    });

    // 1. Start transfer -> outgoing is pending-revoked (readOnly: true, not active write owner), incoming is pending-accepted (zero effective access).
    const tx1 = await store.startOwnershipTransfer({
      scope: { kind: 'agent', id: 'solo-bot' },
      fromSubject: 'user:alice',
      toSubject: 'user:bob',
      by: 'user:alice',
      ttlMs: 60_000,
    });
    assert.equal(tx1.outgoing.state, 'pending-revoked');
    assert.equal(tx1.incoming.state, 'pending-accepted');
    assert.equal(store.isActiveContentOwner('user:alice', { kind: 'agent', id: 'solo-bot' }), false);
    assert.equal(store.isActiveContentOwner('user:bob', { kind: 'agent', id: 'solo-bot' }), false);

    const aliceDuringPending = store.effectiveGrantsFor({ subject: 'user:alice' });
    assert.equal(aliceDuringPending.length, 1);
    assert.equal(aliceDuringPending[0].readOnly, true);
    assert.deepEqual(store.effectiveGrantsFor({ subject: 'user:bob' }), []);

    // Decline restores alice's active write ownership
    const declined = await store.resolveOwnershipTransfer({
      transferId: tx1.transferId,
      action: 'decline',
      by: 'user:bob',
    });
    assert.equal(declined.activeOwner.subject, 'user:alice');
    assert.equal(declined.activeOwner.state, 'active');
    assert.equal(store.isActiveContentOwner('user:alice', { kind: 'agent', id: 'solo-bot' }), true);

    // 2. Start transfer and let TTL expire -> outgoing owner regains write ownership and sweep cleans up pending records
    const tx2 = await store.startOwnershipTransfer({
      scope: { kind: 'agent', id: 'solo-bot' },
      fromSubject: 'user:alice',
      toSubject: 'user:bob',
      by: 'user:alice',
      ttlMs: 60_000,
    });
    clock += 61_000;
    assert.equal(store.isActiveContentOwner('user:alice', { kind: 'agent', id: 'solo-bot' }), true);
    await assert.rejects(
      () => store.resolveOwnershipTransfer({ transferId: tx2.transferId, action: 'accept', by: 'user:bob' }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'transfer_expired',
    );
    const swept = await store.sweepExpiredTransfers('system');
    assert.equal(swept.length, 1);
    assert.equal(swept[0].subject, 'user:alice');
    assert.equal(swept[0].state, 'active');

    // 3. Start transfer and accept -> bob becomes sole active content-owner
    const tx3 = await store.startOwnershipTransfer({
      scope: { kind: 'agent', id: 'solo-bot' },
      fromSubject: 'user:alice',
      toSubject: 'user:bob',
      by: 'user:alice',
      ttlMs: 60_000,
    });
    const accepted = await store.resolveOwnershipTransfer({
      transferId: tx3.transferId,
      action: 'accept',
      by: 'user:bob',
    });
    assert.equal(accepted.activeOwner.subject, 'user:bob');
    assert.equal(accepted.activeOwner.state, 'active');
    assert.equal(store.isActiveContentOwner('user:bob', { kind: 'agent', id: 'solo-bot' }), true);
    assert.deepEqual(store.effectiveGrantsFor({ subject: 'user:alice' }), []);
  });

  it('persists versioned grant snapshots and history across restarts on FileDocBackend, S3CliDocBackend, and GcsDocBackend', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grants-persist-'));
    try {
      const pDir = join(dir, 'principals');
      const gDir = join(dir, 'grants');

      // Session 1: populate principals + grants on disk
      const principals1 = await PrincipalStore.open(docBackendFromUri<PrincipalsDoc>(`file://${pDir}`, pDir));
      const grants1 = await GrantStore.open(docBackendFromUri<GrantsDoc>(`file://${gDir}`, gDir), {
        principals: principals1,
      });

      await principals1.create({
        id: 'user:dale',
        displayName: 'Dale Sackrider',
        emails: ['dale@sackrider.org'],
        by: 'bootstrap',
      });
      await grants1.grant({
        id: 'g_admin_dale',
        subject: 'user:dale',
        scope: { kind: 'fleet' },
        role: 'admin',
        by: 'user:dale',
      });
      await grants1.grant({
        id: 'g_domain_sackrider',
        subject: 'domain:sackrider.org',
        scope: { kind: 'fleet' },
        role: 'viewer',
        by: 'user:dale',
      });
      assert.equal(grants1.version, 2);
      assert.equal(existsSync(join(gDir, '1.json')), true);
      assert.equal(existsSync(join(gDir, '2.json')), true);

      // Session 2: cold restart from disk preserves versions, grants, domain materialization, and monotonic version numbers
      const principals2 = await PrincipalStore.open(docBackendFromUri<PrincipalsDoc>(pDir, pDir));
      const grants2 = await GrantStore.open(docBackendFromUri<GrantsDoc>(gDir, gDir), {
        principals: principals2,
      });
      assert.equal(grants2.version, 2);
      assert.deepEqual(grants2.effectiveFleetRolesFor({ subject: 'user:dale' }), ['admin', 'viewer']);

      const signIn = await grants2.materializeOnVerifiedSignIn({
        idp: 'cloudflare-access',
        sub: 'cf-alex',
        email: 'alex@sackrider.org',
        emailVerified: true,
      });
      assert.equal(signIn.ok, true);
      if (!signIn.ok) throw new Error('expected ok');
      assert.equal(signIn.materialized, true);
      assert.deepEqual(signIn.principal?.roles, ['viewer']);

      // Mocked S3CliDocBackend parity for GrantStore
      const s3Objects = new Map<string, string>();
      const fakeAwsCli: AwsCliRunner = async (args) => {
        if (args[0] === 's3api' && args[1] === 'get-object') {
          const key = args[args.indexOf('--key') + 1];
          const outPath = args[args.length - 1];
          const body = s3Objects.get(key);
          if (!body) throw new Error('NoSuchKey');
          writeFileSync(outPath, body, 'utf8');
          return '';
        }
        if (args[0] === 's3api' && args[1] === 'list-objects-v2') {
          const prefix = args[args.indexOf('--prefix') + 1];
          const keys = [...s3Objects.keys()].filter((k) => k.startsWith(prefix));
          return JSON.stringify({ Contents: keys.map((Key) => ({ Key })) });
        }
        if (args[0] === 's3api' && args[1] === 'put-object') {
          const key = args[args.indexOf('--key') + 1];
          const ifNoneMatch = args.includes('--if-none-match');
          if (ifNoneMatch && s3Objects.has(key)) throw new Error('PreconditionFailed');
          const bodyPath = args[args.indexOf('--body') + 1];
          s3Objects.set(key, readFileSync(bodyPath, 'utf8'));
          return '';
        }
        throw new Error(`unexpected aws cli call: ${args.join(' ')}`);
      };

      const s3Backend = new S3CliDocBackend<GrantsDoc>('s3://factory-test-bucket/auth/grants', fakeAwsCli);
      const s3Grants = await GrantStore.open(s3Backend);
      await s3Grants.grant({
        subject: 'user:dale',
        scope: { kind: 'fleet' },
        role: 'admin',
        by: 'user:dale',
      });
      const s3Reopened = await GrantStore.open(s3Backend);
      assert.equal(s3Reopened.version, 1);
      assert.deepEqual(s3Reopened.effectiveFleetRolesFor({ subject: 'user:dale' }), ['admin']);

      // Mocked GcsDocBackend parity for GrantStore
      const gcsObjects = new Map<string, string>();
      const gcsBackend = new GcsDocBackend<GrantsDoc>('gs://factory-test-bucket/auth/grants', {
        getAccessToken: async () => 'fake-token',
        fetch: (async (url: string | URL, init?: RequestInit) => {
          const u = new URL(String(url));
          if (init?.method === 'POST' && u.pathname.includes('/upload/storage/v1/b/')) {
            const name = u.searchParams.get('name')!;
            if (u.searchParams.get('ifGenerationMatch') === '0' && gcsObjects.has(name)) {
              return new Response('Precondition Failed', { status: 412 });
            }
            gcsObjects.set(name, String(init.body ?? ''));
            return new Response('{}', { status: 200 });
          }
          if (u.searchParams.get('alt') === 'media') {
            const match = u.pathname.match(/\/o\/([^/]+)$/);
            const key = decodeURIComponent(match![1]);
            const val = gcsObjects.get(key);
            if (!val) return new Response('Not Found', { status: 404 });
            return new Response(val, { status: 200 });
          }
          const prefix = u.searchParams.get('prefix') ?? '';
          const items = [...gcsObjects.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
          return new Response(JSON.stringify({ items }), { status: 200 });
        }) as typeof fetch,
      });
      const gcsGrants = await GrantStore.open(gcsBackend);
      await gcsGrants.grant({
        subject: 'domain:sackrider.org',
        scope: { kind: 'fleet' },
        role: 'viewer',
        by: 'user:dale',
      });
      const gcsReopened = await GrantStore.open(gcsBackend);
      assert.equal(gcsReopened.version, 1);
      assert.equal(gcsReopened.hasActiveDomainGrant('sackrider.org'), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
