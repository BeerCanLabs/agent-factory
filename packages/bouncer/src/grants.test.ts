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
  snapshotSha256,
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

  it('F1: prevents duplicate slot-occupying unique-role records for the same subject across grant(), update(), expired transfers, and reload()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grants-f1-'));
    try {
      let clock = Date.parse('2026-11-02T20:00:00.000Z');
      const now = () => new Date((clock += 1000));
      const backend = new FileDocBackend<GrantsDoc>(dir);
      const store = await GrantStore.open(backend, { now });

      // 1. Explicit distinct grant IDs for the same subject on unique slots reject with 409 (never inserting a 2nd record).
      const ownerAgent = await store.grant({
        id: 'g_owner_agent_1',
        subject: 'user:alice',
        scope: { kind: 'agent', id: 'solo-agent' },
        role: 'content-owner',
        by: 'user:dale',
      });
      await assert.rejects(
        () =>
          store.grant({
            id: 'g_owner_agent_2',
            subject: 'user:alice',
            scope: { kind: 'agent', id: 'solo-agent' },
            role: 'content-owner',
            by: 'user:dale',
          }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'owner_exists',
      );
      // Calling grant() with undefined id or matching id updates/returns the single record in place.
      const ownerAgentSame = await store.grant({
        subject: 'user:alice',
        scope: { kind: 'agent', id: 'solo-agent' },
        role: 'content-owner',
        expiresAt: '2026-12-01T00:00:00.000Z',
        by: 'user:dale',
      });
      assert.equal(ownerAgentSame.id, ownerAgent.id);
      assert.equal(
        store.list({ scopeKind: 'agent', scopeId: 'solo-agent' }).filter((g) => g.role === 'content-owner').length,
        1,
      );

      await store.grant({
        id: 'g_owner_skill_1',
        subject: 'user:alice',
        scope: { kind: 'skill', id: 'solo-skill' },
        role: 'content-owner',
        by: 'user:dale',
      });
      await assert.rejects(
        () =>
          store.grant({
            id: 'g_owner_skill_2',
            subject: 'user:alice',
            scope: { kind: 'skill', id: 'solo-skill' },
            role: 'content-owner',
            by: 'user:dale',
          }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'owner_exists',
      );

      await store.grant({
        id: 'g_lead_1',
        subject: 'user:alice',
        scope: { kind: 'agent', id: 'team-agent' },
        role: 'accountable-lead',
        by: 'user:dale',
      });
      await assert.rejects(
        () =>
          store.grant({
            id: 'g_lead_2',
            subject: 'user:alice',
            scope: { kind: 'agent', id: 'team-agent' },
            role: 'accountable-lead',
            by: 'user:dale',
          }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'lead_exists',
      );

      await store.grant({
        id: 'g_budget_1',
        subject: 'user:alice',
        scope: { kind: 'fleet' },
        role: 'budget-owner',
        by: 'user:dale',
      });
      await assert.rejects(
        () =>
          store.grant({
            id: 'g_budget_2',
            subject: 'user:alice',
            scope: { kind: 'fleet' },
            role: 'budget-owner',
            by: 'user:dale',
          }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'budget_owner_exists',
      );

      // 2. Promoting another grant of user:alice via update() onto a unique slot already occupied by user:alice rejects with 409.
      const aliceMember = await store.grant({
        subject: 'user:alice',
        scope: { kind: 'agent', id: 'solo-agent' },
        role: 'member',
        by: 'user:dale',
      });
      await assert.rejects(
        () => store.update(aliceMember.id, { role: 'content-owner', by: 'user:dale' }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'owner_exists',
      );
      const aliceTeamMember = await store.grant({
        subject: 'user:alice',
        scope: { kind: 'agent', id: 'team-agent' },
        role: 'member',
        by: 'user:dale',
      });
      await assert.rejects(
        () => store.update(aliceTeamMember.id, { role: 'accountable-lead', by: 'user:dale' }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'lead_exists',
      );
      const aliceFleetViewer = await store.grant({
        subject: 'user:alice',
        scope: { kind: 'fleet' },
        role: 'viewer',
        by: 'user:dale',
      });
      await assert.rejects(
        () => store.update(aliceFleetViewer.id, { role: 'budget-owner', by: 'user:dale' }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'budget_owner_exists',
      );

      // 3. During an UNEXPIRED pending-revoked transfer, grant() and update() for user:alice reject with 409 owner_exists (preserving D15 read-only).
      await store.startOwnershipTransfer({
        scope: { kind: 'agent', id: 'solo-agent' },
        fromSubject: 'user:alice',
        toSubject: 'user:bob',
        by: 'user:alice',
        ttlMs: 60_000,
      });
      await assert.rejects(
        () =>
          store.grant({
            subject: 'user:alice',
            scope: { kind: 'agent', id: 'solo-agent' },
            role: 'content-owner',
            by: 'user:dale',
          }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'owner_exists',
      );
      await assert.rejects(
        () => store.update(aliceMember.id, { role: 'content-owner', by: 'user:dale' }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'owner_exists',
      );

      // 4. After transfer TTL expires (before sweepExpiredTransfers), grant() for user:alice restores existing grant in place & cleans up pending-accepted.
      clock += 120_000;
      await assert.rejects(
        () => store.update(aliceMember.id, { role: 'content-owner', by: 'user:dale' }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'owner_exists',
      );
      const restoredInPlace = await store.grant({
        subject: 'user:alice',
        scope: { kind: 'agent', id: 'solo-agent' },
        role: 'content-owner',
        by: 'user:dale',
      });
      assert.equal(restoredInPlace.id, ownerAgent.id);
      assert.equal(restoredInPlace.state, 'active');
      assert.equal(restoredInPlace.transferId, undefined);
      assert.equal(restoredInPlace.pendingExpiresAt, undefined);
      const soloAgentGrants = store.list({ scopeKind: 'agent', scopeId: 'solo-agent' });
      assert.equal(soloAgentGrants.filter((g) => g.role === 'content-owner').length, 1);
      assert.equal(soloAgentGrants.some((g) => g.state !== 'active'), false);

      // Reload succeeds cleanly with zero duplicate unique-slot records.
      await store.reload();
      assert.equal(store.healthy, true);

      // 5. Tampering disk snapshot to contain two content-owner records for the SAME subject fails closed (503) on reload().
      const vPath = join(dir, `${store.version}.json`);
      const snap = JSON.parse(readFileSync(vPath, 'utf8')) as VersionedSnapshot<GrantsDoc>;
      const dup = structuredClone(snap.data.grants.find((g) => g.id === ownerAgent.id)!);
      dup.id = 'g_tampered_dup_owner';
      snap.data.grants.push(dup);
      snap.sha256 = snapshotSha256(snap.data);
      writeFileSync(vPath, JSON.stringify(snap, null, 2));
      writeFileSync(join(dir, 'current.json'), JSON.stringify({ version: snap.version, sha256: snap.sha256 }, null, 2));

      await assert.rejects(
        () => store.reload(),
        (err: unknown) => err instanceof GrantStoreUnavailableError && err.status === 503,
      );
      assert.equal(store.healthy, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F2: serializes reload() and loadEffectiveGrantsFor(..., { refresh: true }) on enqueue so concurrent writes never race, regress version, or resurrect revoked grants', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grants-f2-'));
    try {
      const fileBackend = new FileDocBackend<GrantsDoc>(dir);
      let loadGate: (() => void) | undefined;
      let notifyLoadEntered: (() => void) | undefined;
      let failNextWrite = false;

      const gatedBackend: VersionedDocBackend<GrantsDoc> = {
        description: fileBackend.description,
        loadLatest: () => fileBackend.loadLatest(),
        loadState: async () => {
          const state = await fileBackend.loadState!();
          if (loadGate) {
            const release = loadGate;
            loadGate = undefined;
            notifyLoadEntered?.();
            await new Promise<void>((resolve) => {
              const orig = release;
              void orig;
              gateResolver = resolve;
            });
          }
          return state;
        },
        write: async (snap) => {
          if (failNextWrite) {
            failNextWrite = false;
            throw new Error('simulated transient S3 write error');
          }
          await fileBackend.write(snap);
        },
      };

      let gateResolver: (() => void) | undefined;
      const store = await GrantStore.open(gatedBackend);
      await store.grant({
        id: 'g_admin_dale',
        subject: 'user:dale',
        scope: { kind: 'fleet' },
        role: 'admin',
        by: 'user:dale',
      });
      const bobGrant = await store.grant({
        id: 'g_viewer_bob',
        subject: 'user:bob',
        scope: { kind: 'fleet' },
        role: 'viewer',
        by: 'user:dale',
      });
      assert.equal(store.version, 2);

      // 1. Start an in-flight loadEffectiveGrantsFor(..., { refresh: true }) paused mid-load on snapshot v2, then queue revoke(bob) + grant(carol).
      const entered = new Promise<void>((resolve) => {
        notifyLoadEntered = resolve;
      });
      loadGate = () => {};
      const refreshPromise = store.loadEffectiveGrantsFor({ subject: 'user:bob' }, { refresh: true });
      await entered;

      const revokePromise = store.revoke(bobGrant.id, { by: 'user:dale' });
      const carolPromise = store.grant({
        id: 'g_viewer_carol',
        subject: 'user:carol',
        scope: { kind: 'fleet' },
        role: 'viewer',
        by: 'user:dale',
      });

      // Release the paused reload -> refresh finishes v2, then revoke commits v3, then grant(carol) commits v4 cleanly!
      gateResolver!();
      const [refreshedBeforeRevoke] = await Promise.all([refreshPromise, revokePromise, carolPromise]);
      assert.equal(refreshedBeforeRevoke.length, 1);
      assert.equal(store.version, 4);
      assert.deepEqual(store.effectiveGrantsFor({ subject: 'user:bob' }), [], 'revoked grant must never be resurrected');
      assert.equal(store.effectiveGrantsFor({ subject: 'user:carol' }).length, 1);

      // 2. Queue a revoke(carol) FIRST and call reload() + loadEffectiveGrantsFor(..., { refresh: true }) concurrently -> refresh sees post-revoke state ([]).
      const [, , refreshedAfterRevoke] = await Promise.all([
        store.revoke('g_viewer_carol', { by: 'user:dale' }),
        store.reload(),
        store.loadEffectiveGrantsFor({ subject: 'user:carol' }, { refresh: true }),
      ]);
      assert.deepEqual(refreshedAfterRevoke, []);
      assert.equal(store.version, 5);

      // 3. Transient write failure marks store unhealthy (503); explicit reload() runs sequentially and safely re-syncs durable state + version.
      failNextWrite = true;
      await assert.rejects(
        () =>
          store.grant({
            subject: 'user:dave',
            scope: { kind: 'fleet' },
            role: 'viewer',
            by: 'user:dale',
          }),
        (err: unknown) => err instanceof GrantStoreUnavailableError && err.status === 503,
      );
      assert.equal(store.healthy, false);

      await store.reload();
      assert.equal(store.healthy, true);
      assert.equal(store.version, 5);
      const daveAfterRecovery = await store.grant({
        subject: 'user:dave',
        scope: { kind: 'fleet' },
        role: 'viewer',
        by: 'user:dale',
      });
      assert.equal(daveAfterRecovery.subject, 'user:dave');
      assert.equal(store.version, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F3: canonicalizes user:<email> subjects via PrincipalStore across effectiveGrantsFor and all subject-accepting methods while preserving unmaterialized domain evaluation', async () => {
    let clock = Date.parse('2026-11-02T21:00:00.000Z');
    const now = () => new Date((clock += 1000));
    const principals = await PrincipalStore.open(undefined, { now });
    const grants = await GrantStore.open(undefined, { now, principals });

    const dale = await principals.create({
      id: 'user:dale',
      displayName: 'Dale Sackrider',
      emails: ['dale@sackrider.org', 'dale.alias@gmail.com'],
      by: 'bootstrap',
    });
    assert.equal(dale.id, 'user:dale');

    const bob = await principals.create({
      id: 'user:bob',
      displayName: 'Bob Sackrider',
      emails: ['bob@sackrider.org'],
      by: 'user:dale',
    });
    assert.equal(bob.id, 'user:bob');

    // Grant via email -> stored under canonical slug user:dale
    await grants.grant({
      subject: 'user:dale@sackrider.org',
      scope: { kind: 'fleet' },
      role: 'admin',
      by: 'user:dale',
    });
    await grants.grant({
      subject: 'dale@sackrider.org',
      scope: { kind: 'agent', id: 'switch-bot' },
      role: 'content-owner',
      by: 'user:dale',
    });
    await grants.grant({
      subject: 'domain:sackrider.org',
      scope: { kind: 'fleet' },
      role: 'viewer',
      by: 'user:dale',
    });

    // S1 identity verifier shape: Principal.actor === 'user:dale@sackrider.org' or 'user:dale.alias@gmail.com'
    assert.deepEqual(
      grants.effectiveFleetRolesFor({ subject: 'user:dale@sackrider.org' }).sort(),
      ['admin', 'viewer'],
    );
    assert.deepEqual(
      grants.effectiveFleetRolesFor({ subject: 'user:dale.alias@gmail.com', emails: ['dale.alias@gmail.com'] }).sort(),
      ['admin', 'viewer'],
      'secondary non-domain email still inherits both direct user:dale grants and linked @sackrider.org domain grant',
    );
    assert.equal(grants.isActiveContentOwner('user:dale@sackrider.org', { kind: 'agent', id: 'switch-bot' }), true);
    assert.equal(grants.list({ subject: 'user:dale@sackrider.org' }).length, 2);
    assert.equal(grants.list({ subject: 'dale@sackrider.org' }).length, 2);

    // assertCanRemovePrincipal canonicalizes user:<email> -> protects sole human admin
    assert.throws(
      () => grants.assertCanRemovePrincipal('user:dale@sackrider.org'),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'last_admin',
    );

    // Unmaterialized S1 verifier caller 'user:newcomer@sackrider.org' with emails omitted still resolves domain:sackrider.org with zero PrincipalStore writes (D6 / AC1).
    const principalsBeforeEval = principals.list().length;
    assert.deepEqual(grants.effectiveFleetRolesFor({ subject: 'user:newcomer@sackrider.org' }), ['viewer']);
    assert.deepEqual(grants.effectiveFleetRolesFor({ subject: 'user:stranger@other.org' }), []);
    assert.equal(principals.list().length, principalsBeforeEval);

    // startOwnershipTransfer canonicalizes both fromSubject and toSubject when passed as user:<email>
    const tx = await grants.startOwnershipTransfer({
      scope: { kind: 'agent', id: 'switch-bot' },
      fromSubject: 'user:dale@sackrider.org',
      toSubject: 'user:bob@sackrider.org',
      by: 'user:dale',
    });
    assert.equal(tx.outgoing.subject, 'user:dale');
    assert.equal(tx.incoming.subject, 'user:bob');
    await grants.resolveOwnershipTransfer({ transferId: tx.transferId, action: 'accept', by: 'user:bob' });
    assert.equal(grants.isActiveContentOwner('user:bob@sackrider.org', { kind: 'agent', id: 'switch-bot' }), true);

    // Add second human admin so we can exercise downgrade, revokeMatching, and revokeAllForSubject via user:<email>
    await grants.grant({
      subject: 'user:bob@sackrider.org',
      scope: { kind: 'fleet' },
      role: 'admin',
      by: 'user:dale',
    });
    const downgraded = await grants.downgrade('user:dale@sackrider.org', 'operator', { by: 'user:bob' });
    assert.equal(downgraded.subject, 'user:dale');
    assert.equal(downgraded.role, 'operator');

    await grants.grant({
      subject: 'user:dale@sackrider.org',
      scope: { kind: 'agent', id: 'switch-bot' },
      role: 'member',
      by: 'user:bob',
    });
    const revokedMatch = await grants.revokeMatching(
      { subject: 'user:dale@sackrider.org', scope: { kind: 'agent', id: 'switch-bot' }, role: 'member' },
      { by: 'user:bob' },
    );
    assert.equal(revokedMatch.subject, 'user:dale');

    const revokedAll = await grants.revokeAllForSubject('user:dale.alias@gmail.com', { by: 'user:bob' });
    assert.equal(revokedAll.length, 1);
    assert.equal(revokedAll[0].subject, 'user:dale');
    assert.equal(grants.list({ subject: 'user:dale' }).length, 0);
  });

  it('F4: preserves two-phase transfer invariants across single-grant revocations, update(), raw state inputs, and reload()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grants-f4-'));
    try {
      let clock = Date.parse('2026-11-02T22:00:00.000Z');
      const now = () => new Date((clock += 1000));
      const backend = new FileDocBackend<GrantsDoc>(dir);
      const store = await GrantStore.open(backend, { now });

      await store.grant({
        subject: 'user:alice',
        scope: { kind: 'agent', id: 'alpha' },
        role: 'content-owner',
        by: 'user:alice',
      });

      // 1. Revoking pending-accepted via revoke(), revokeMatching(), and revokeAllForSubject() restores paired pending-revoked to active!
      const tx1 = await store.startOwnershipTransfer({
        scope: { kind: 'agent', id: 'alpha' },
        fromSubject: 'user:alice',
        toSubject: 'user:bob',
        by: 'user:dale',
        onBehalfOf: 'user:alice',
      });
      await store.revoke(tx1.incoming.id, { by: 'user:dale' });
      const restored1 = store.get(tx1.outgoing.id)!;
      assert.equal(restored1.state, 'active');
      assert.equal(restored1.transferId, undefined);
      assert.equal(restored1.pendingExpiresAt, undefined);
      assert.equal(restored1.onBehalfOf, undefined);
      assert.equal(store.isActiveContentOwner('user:alice', { kind: 'agent', id: 'alpha' }), true);

      const tx2 = await store.startOwnershipTransfer({
        scope: { kind: 'agent', id: 'alpha' },
        fromSubject: 'user:alice',
        toSubject: 'user:bob',
        by: 'user:alice',
      });
      await store.revokeMatching(
        { subject: 'user:bob', scope: { kind: 'agent', id: 'alpha' }, role: 'content-owner' },
        { by: 'user:dale' },
      );
      assert.equal(store.get(tx2.outgoing.id)?.state, 'active');
      assert.equal(store.isActiveContentOwner('user:alice', { kind: 'agent', id: 'alpha' }), true);

      const tx3 = await store.startOwnershipTransfer({
        scope: { kind: 'agent', id: 'alpha' },
        fromSubject: 'user:alice',
        toSubject: 'user:bob',
        by: 'user:alice',
      });
      await store.revokeAllForSubject('user:bob', { by: 'user:dale' });
      assert.equal(store.get(tx3.outgoing.id)?.state, 'active');
      assert.equal(store.isActiveContentOwner('user:alice', { kind: 'agent', id: 'alpha' }), true);

      // 2. Revoking pending-revoked also deletes paired pending-accepted so zero orphan pending-accepted remains!
      const tx4 = await store.startOwnershipTransfer({
        scope: { kind: 'agent', id: 'alpha' },
        fromSubject: 'user:alice',
        toSubject: 'user:bob',
        by: 'user:alice',
      });
      await store.revoke(tx4.outgoing.id, { by: 'user:dale' });
      assert.equal(store.get(tx4.outgoing.id), undefined);
      assert.equal(store.get(tx4.incoming.id), undefined);
      assert.deepEqual(store.list({ scopeKind: 'agent', scopeId: 'alpha' }), []);

      // 3. update(outgoing.id, { state: 'active' }) clears transferId/pendingExpiresAt and removes paired pending-accepted.
      const freshOwner = await store.grant({
        subject: 'user:alice',
        scope: { kind: 'skill', id: 'skill-one' },
        role: 'content-owner',
        by: 'user:alice',
      });
      const tx5 = await store.startOwnershipTransfer({
        scope: { kind: 'skill', id: 'skill-one' },
        fromSubject: 'user:alice',
        toSubject: 'user:bob',
        by: 'user:alice',
      });
      const updatedActive = await store.update(freshOwner.id, { state: 'active', by: 'user:dale' });
      assert.equal(updatedActive.state, 'active');
      assert.equal(updatedActive.transferId, undefined);
      assert.equal(updatedActive.pendingExpiresAt, undefined);
      assert.equal(store.get(tx5.incoming.id), undefined);

      // Cannot transition an active grant into pending-revoked/pending-accepted via update().
      await assert.rejects(
        () => store.update(freshOwner.id, { state: 'pending-revoked', by: 'user:dale' }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 400 && err.code === 'invalid_grant',
      );

      // 4. grant() rejects non-active states on fleet scope, non-user subjects, non-content-owner roles, missing transferId/pendingExpiresAt, and rejects active grants with transferId/pendingExpiresAt.
      const futureIso = '2026-11-10T00:00:00.000Z';
      for (const badInput of [
        {
          subject: 'user:carol',
          scope: { kind: 'fleet' as const },
          role: 'viewer',
          state: 'pending-revoked' as const,
          transferId: 'tx_bad_1',
          pendingExpiresAt: futureIso,
          by: 'user:dale',
        },
        {
          subject: 'group:eng',
          scope: { kind: 'agent' as const, id: 'beta' },
          role: 'member',
          state: 'pending-accepted' as const,
          transferId: 'tx_bad_2',
          pendingExpiresAt: futureIso,
          by: 'user:dale',
        },
        {
          subject: 'user:carol',
          scope: { kind: 'agent' as const, id: 'beta' },
          role: 'member',
          state: 'pending-revoked' as const,
          transferId: 'tx_bad_3',
          pendingExpiresAt: futureIso,
          by: 'user:dale',
        },
        {
          subject: 'user:carol',
          scope: { kind: 'agent' as const, id: 'beta' },
          role: 'content-owner',
          state: 'pending-revoked' as const,
          pendingExpiresAt: futureIso,
          by: 'user:dale',
        },
        {
          subject: 'user:carol',
          scope: { kind: 'agent' as const, id: 'beta' },
          role: 'content-owner',
          state: 'pending-revoked' as const,
          transferId: 'tx_bad_5',
          by: 'user:dale',
        },
        {
          subject: 'user:carol',
          scope: { kind: 'agent' as const, id: 'beta' },
          role: 'content-owner',
          state: 'active' as const,
          transferId: 'tx_bad_6',
          by: 'user:dale',
        },
        {
          subject: 'user:carol',
          scope: { kind: 'agent' as const, id: 'beta' },
          role: 'content-owner',
          state: 'active' as const,
          pendingExpiresAt: futureIso,
          by: 'user:dale',
        },
      ]) {
        await assert.rejects(
          () => store.grant(badInput),
          (err: unknown) => err instanceof GrantStoreError && err.status === 400,
        );
      }

      // 5. Tampering disk snapshot with invalid transfer state fields fails closed (503) on reload().
      await store.reload();
      const vPath = join(dir, `${store.version}.json`);
      const snap = JSON.parse(readFileSync(vPath, 'utf8')) as VersionedSnapshot<GrantsDoc>;
      snap.data.grants[0].state = 'pending-revoked';
      // Missing transferId and pendingExpiresAt
      snap.sha256 = snapshotSha256(snap.data);
      writeFileSync(vPath, JSON.stringify(snap, null, 2));
      writeFileSync(join(dir, 'current.json'), JSON.stringify({ version: snap.version, sha256: snap.sha256 }, null, 2));

      await assert.rejects(
        () => store.reload(),
        (err: unknown) => err instanceof GrantStoreUnavailableError && err.status === 503,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F5: validates onBehalfOf as a human user principal across all mutations/reload and clears stale onBehalfOf on subsequent non-impersonated mutations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grants-f5-'));
    try {
      let clock = Date.parse('2026-11-02T23:00:00.000Z');
      const now = () => new Date((clock += 1000));
      const principals = await PrincipalStore.open(undefined, { now });
      await principals.create({
        id: 'user:alice',
        displayName: 'Alice',
        emails: ['alice@sackrider.org'],
        by: 'bootstrap',
      });
      await principals.create({
        id: 'user:bob',
        displayName: 'Bob',
        emails: ['bob@sackrider.org'],
        by: 'bootstrap',
      });
      await principals.create({
        id: 'user:dale',
        displayName: 'Dale',
        emails: ['dale@sackrider.org'],
        by: 'bootstrap',
      });

      const backend = new FileDocBackend<GrantsDoc>(dir);
      const store = await GrantStore.open(backend, { now, principals });

      // 1. Valid onBehalfOf (including user:<email> canonicalized to user:<slug>) is recorded; subsequent non-impersonated grant() in-place update clears it.
      const g1 = await store.grant({
        subject: 'user:alice',
        scope: { kind: 'agent', id: 'gamma' },
        role: 'content-owner',
        by: 'user:dale',
        onBehalfOf: 'user:alice@sackrider.org',
      });
      assert.equal(g1.onBehalfOf, 'user:alice');

      const g1Cleared = await store.grant({
        subject: 'user:alice',
        scope: { kind: 'agent', id: 'gamma' },
        role: 'content-owner',
        by: 'user:dale',
      });
      assert.equal(g1Cleared.id, g1.id);
      assert.equal(g1Cleared.onBehalfOf, undefined);
      assert.equal('onBehalfOf' in g1Cleared, false);

      // 2. update() records valid onBehalfOf and clears it on next non-impersonated update().
      const g1WithObo = await store.update(g1.id, {
        expiresAt: '2026-12-15T00:00:00.000Z',
        by: 'user:dale',
        onBehalfOf: 'user:alice',
      });
      assert.equal(g1WithObo.onBehalfOf, 'user:alice');

      const g1UpdateCleared = await store.update(g1.id, {
        expiresAt: null,
        by: 'user:dale',
      });
      assert.equal(g1UpdateCleared.onBehalfOf, undefined);
      assert.equal('onBehalfOf' in g1UpdateCleared, false);

      // 3. startOwnershipTransfer, resolveOwnershipTransfer, and sweepExpiredTransfers never leak stale onBehalfOf!
      const tx1 = await store.startOwnershipTransfer({
        scope: { kind: 'agent', id: 'gamma' },
        fromSubject: 'user:alice',
        toSubject: 'user:bob',
        by: 'user:dale',
        onBehalfOf: 'user:alice',
        ttlMs: 60_000,
      });
      assert.equal(tx1.outgoing.onBehalfOf, 'user:alice');
      assert.equal(tx1.incoming.onBehalfOf, 'user:alice');

      // Cancel without onBehalfOf -> clears stale onBehalfOf on restored outgoing grant
      const cancelled = await store.resolveOwnershipTransfer({
        transferId: tx1.transferId,
        action: 'cancel',
        by: 'user:alice',
      });
      assert.equal(cancelled.activeOwner.onBehalfOf, undefined);
      assert.equal('onBehalfOf' in cancelled.activeOwner, false);

      // Start transfer with onBehalfOf, let expire, and sweep -> clears stale onBehalfOf
      await store.startOwnershipTransfer({
        scope: { kind: 'agent', id: 'gamma' },
        fromSubject: 'user:alice',
        toSubject: 'user:bob',
        by: 'user:dale',
        onBehalfOf: 'user:alice',
        ttlMs: 10_000,
      });
      clock += 20_000;
      const swept = await store.sweepExpiredTransfers('system');
      assert.equal(swept.length, 1);
      assert.equal(swept[0].onBehalfOf, undefined);
      assert.equal('onBehalfOf' in swept[0], false);

      // Start transfer without onBehalfOf after setting onBehalfOf on owner -> clears stale onBehalfOf on outgoing
      await store.update(g1.id, { expiresAt: null, by: 'user:dale', onBehalfOf: 'user:alice' });
      const tx3 = await store.startOwnershipTransfer({
        scope: { kind: 'agent', id: 'gamma' },
        fromSubject: 'user:alice',
        toSubject: 'user:bob',
        by: 'user:alice',
      });
      assert.equal(tx3.outgoing.onBehalfOf, undefined);
      const accepted = await store.resolveOwnershipTransfer({
        transferId: tx3.transferId,
        action: 'accept',
        by: 'user:bob',
      });
      assert.equal(accepted.activeOwner.onBehalfOf, undefined);

      // 4. Invalid onBehalfOf values reject with 400 invalid_grant across all mutation methods.
      for (const badObo of ['service:bot', 'group:eng', 'domain:sackrider.org', 'not-a-user']) {
        await assert.rejects(
          () =>
            store.grant({
              subject: 'user:alice',
              scope: { kind: 'fleet' },
              role: 'viewer',
              by: 'user:dale',
              onBehalfOf: badObo,
            }),
          (err: unknown) => err instanceof GrantStoreError && err.status === 400 && err.code === 'invalid_grant',
        );
        await assert.rejects(
          () => store.update(accepted.activeOwner.id, { expiresAt: null, by: 'user:dale', onBehalfOf: badObo }),
          (err: unknown) => err instanceof GrantStoreError && err.status === 400 && err.code === 'invalid_grant',
        );
        await assert.rejects(
          () => store.revoke(accepted.activeOwner.id, { by: 'user:dale', onBehalfOf: badObo }),
          (err: unknown) => err instanceof GrantStoreError && err.status === 400 && err.code === 'invalid_grant',
        );
        await assert.rejects(
          () =>
            store.revokeMatching(
              { subject: 'user:bob', scope: { kind: 'agent', id: 'gamma' }, role: 'content-owner' },
              { by: 'user:dale', onBehalfOf: badObo },
            ),
          (err: unknown) => err instanceof GrantStoreError && err.status === 400 && err.code === 'invalid_grant',
        );
        await assert.rejects(
          () => store.revokeAllForSubject('user:bob', { by: 'user:dale', onBehalfOf: badObo }),
          (err: unknown) => err instanceof GrantStoreError && err.status === 400 && err.code === 'invalid_grant',
        );
        await assert.rejects(
          () =>
            store.startOwnershipTransfer({
              scope: { kind: 'agent', id: 'gamma' },
              fromSubject: 'user:bob',
              toSubject: 'user:alice',
              by: 'user:dale',
              onBehalfOf: badObo,
            }),
          (err: unknown) => err instanceof GrantStoreError && err.status === 400 && err.code === 'invalid_grant',
        );
      }

      const tx4 = await store.startOwnershipTransfer({
        scope: { kind: 'agent', id: 'gamma' },
        fromSubject: 'user:bob',
        toSubject: 'user:alice',
        by: 'user:bob',
      });
      await assert.rejects(
        () =>
          store.resolveOwnershipTransfer({
            transferId: tx4.transferId,
            action: 'accept',
            by: 'user:dale',
            onBehalfOf: 'service:bot',
          }),
        (err: unknown) => err instanceof GrantStoreError && err.status === 400 && err.code === 'invalid_grant',
      );
      await store.resolveOwnershipTransfer({ transferId: tx4.transferId, action: 'cancel', by: 'user:bob' });

      // 5. Tampering disk snapshot with non-user onBehalfOf fails closed (503) on reload().
      const vPath = join(dir, `${store.version}.json`);
      const snap = JSON.parse(readFileSync(vPath, 'utf8')) as VersionedSnapshot<GrantsDoc>;
      snap.data.grants[0].onBehalfOf = 'service:rogue-impersonator';
      snap.sha256 = snapshotSha256(snap.data);
      writeFileSync(vPath, JSON.stringify(snap, null, 2));
      writeFileSync(join(dir, 'current.json'), JSON.stringify({ version: snap.version, sha256: snap.sha256 }, null, 2));

      await assert.rejects(
        () => store.reload(),
        (err: unknown) => err instanceof GrantStoreUnavailableError && err.status === 503,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces live agentKindLookup on grant(), update(), and startOwnershipTransfer(), plus initialSubmission unknown-principal boundary (S2b, D11, D13, D30)', async () => {
    const principals = PrincipalStore.inMemory();
    await principals.create({ id: 'user:ops', displayName: 'Ops', emails: ['ops@sackrider.org'], by: 'system' });
    await principals.create({ id: 'user:sarah', displayName: 'Sarah', emails: ['sarah@sackrider.org'], by: 'system' });
    await principals.create({ id: 'user:dale', displayName: 'Dale', emails: ['dale@sackrider.org'], by: 'system' });

    const kinds = new Map<string, 'personal' | 'team'>([
      ['donna', 'personal'],
      ['archie', 'team'],
    ]);
    const store = GrantStore.inMemory({
      principals,
      agentKindLookup: (id) => kinds.get(id),
    });

    // Non-admin initialSubmission succeeds for known accountable-lead on team agent, but rejects unknown principal with 403 (D13)
    await assert.rejects(
      () =>
        store.grant({
          subject: 'user:unknown@sackrider.org',
          scope: { kind: 'agent', id: 'archie' },
          role: 'accountable-lead',
          by: 'user:ops',
          granterIsAdmin: false,
          initialSubmission: true,
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 403 && err.code === 'unknown_subject',
    );
    assert.equal(store.list().length, 0);

    await store.grant({
      subject: 'user:sarah',
      scope: { kind: 'agent', id: 'archie' },
      role: 'accountable-lead',
      by: 'user:ops',
      granterIsAdmin: false,
      initialSubmission: true,
    });

    // Live agentKindLookup rejects content-owner on team agent even without explicit input.agentKind
    await assert.rejects(
      () =>
        store.grant({
          subject: 'user:dale',
          scope: { kind: 'agent', id: 'archie' },
          role: 'content-owner',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'agent_kind_conflict',
    );

    // Live agentKindLookup rejects accountable-lead on personal agent even before any content-owner grant exists
    await assert.rejects(
      () =>
        store.grant({
          subject: 'user:sarah',
          scope: { kind: 'agent', id: 'donna' },
          role: 'accountable-lead',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'agent_kind_conflict',
    );

    // update() also enforces live agentKindLookup
    const teamMember = await store.grant({
      subject: 'user:dale',
      scope: { kind: 'agent', id: 'archie' },
      role: 'member',
      by: 'user:dale',
    });
    await assert.rejects(
      () => store.update(teamMember.id, { role: 'content-owner', by: 'user:dale' }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'agent_kind_conflict',
    );

    const personalMember = await store.grant({
      subject: 'user:sarah',
      scope: { kind: 'agent', id: 'donna' },
      role: 'member',
      by: 'user:dale',
    });
    await assert.rejects(
      () => store.update(personalMember.id, { role: 'accountable-lead', by: 'user:dale' }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'agent_kind_conflict',
    );

    // startOwnershipTransfer() rejects team agent via live agentKindLookup even if another team agent has no lead grant yet
    kinds.set('triage-team', 'team');
    await assert.rejects(
      () =>
        store.startOwnershipTransfer({
          scope: { kind: 'agent', id: 'triage-team' },
          fromSubject: 'user:dale',
          toSubject: 'user:sarah',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'agent_kind_conflict',
    );

    // F4: explicit input.agentKind contradicting registered agentKindLookup rejects 409 agent_kind_conflict
    await assert.rejects(
      () =>
        store.grant({
          subject: 'user:dale',
          scope: { kind: 'agent', id: 'archie' },
          role: 'member',
          agentKind: 'personal',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'agent_kind_conflict',
    );
    await assert.rejects(
      () =>
        store.grant({
          subject: 'user:sarah',
          scope: { kind: 'agent', id: 'donna' },
          role: 'member',
          agentKind: 'team',
          by: 'user:dale',
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'agent_kind_conflict',
    );

    // F1: activeContentOwnerOf tracks active owner, returns undefined during pending-revoked, updates on accept & replaceExisting
    assert.equal(store.activeContentOwnerOf({ kind: 'agent', id: 'donna' }), undefined);
    await store.grant({
      subject: 'user:dale',
      scope: { kind: 'agent', id: 'donna' },
      role: 'content-owner',
      by: 'user:dale',
      initialSubmission: true,
    });
    assert.equal(store.activeContentOwnerOf({ kind: 'agent', id: 'donna' }), 'user:dale');

    const tx = await store.startOwnershipTransfer({
      scope: { kind: 'agent', id: 'donna' },
      fromSubject: 'user:dale',
      toSubject: 'user:sarah',
      by: 'user:dale',
    });
    assert.equal(store.activeContentOwnerOf({ kind: 'agent', id: 'donna' }), undefined);
    await store.resolveOwnershipTransfer({ transferId: tx.transferId, action: 'accept', by: 'user:sarah' });
    assert.equal(store.activeContentOwnerOf({ kind: 'agent', id: 'donna' }), 'user:sarah');

    const replaced = await store.grant({
      subject: 'user:dale',
      scope: { kind: 'agent', id: 'donna' },
      role: 'content-owner',
      by: 'user:dale',
      granterIsAdmin: true,
      replaceExisting: true,
    });
    assert.equal(store.activeContentOwnerOf({ kind: 'agent', id: 'donna' }), 'user:dale');
    await store.revoke(replaced.id, { by: 'user:dale' });
    assert.equal(store.activeContentOwnerOf({ kind: 'agent', id: 'donna' }), undefined);
  });
});
