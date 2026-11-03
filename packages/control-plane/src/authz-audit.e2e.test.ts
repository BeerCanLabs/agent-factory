// Story #371 ([S7] authz & content lifecycle audit ledgering + secret-scan, Epic #349): R5, R6, S7.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { RunTokens, type AuthProvider } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApiKeyStore, ApprovalStore, FileDocBackend, GrantStore, PrincipalStore, type GrantsDoc, type PrincipalsDoc } from '@beercanlabs/factory-bouncer';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { createFactoryServer, type FactoryState } from './app.js';

const ACTORS: Record<string, string> = { 'tok-s7-admin': 'user:admin', 'tok-s7-alice': 'user:alice' }; // secret-scan:allow (test fixture)
const bearer: AuthProvider = {
  name: 's7-identity-only',
  async verify(authorization) {
    const actor = ACTORS[authorization?.replace(/^Bearer /, '') ?? ''];
    return actor ? { ok: true, principal: { actor, roles: [] } } : { ok: false, reason: 'unknown token' };
  },
};

/** Every credential shape the factory hands out or receives: none may ever reach a ledger row or an error body. */
const SECRET_SHAPES = [/fk_[A-Za-z0-9_-]{12,}/, /eyJ[\w-]+\.[\w-]+\.[\w-]*/, /tok-s7-/, /client_secret/i];

describe('S7: authz lifecycle is ledgered on a valid chain with zero credential leakage (#371)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let ledger: MemoryLedger;
  let port = 0;
  const bodies: string[] = [];

  const call = async (method: string, path: string, token?: string, body?: unknown, actAs?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (actAs) headers['x-factory-act-as'] = actAs;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (res.status >= 400) bodies.push(text);
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 's7-audit-'));
    ledger = new MemoryLedger();
    const principals = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(join(dir, 'principals.json')));
    const grants = await GrantStore.open(new FileDocBackend<GrantsDoc>(join(dir, 'grants.json')), { principals });
    await principals.create({ id: 'user:admin', displayName: 'Admin', emails: ['admin@example.com'], by: 'user:admin' });
    await principals.create({ id: 'user:alice', displayName: 'Alice', emails: ['alice@example.com'], by: 'user:admin' });
    await grants.grant({ subject: 'user:admin', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });
    const state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: bearer,
      principals,
      grants,
      keys: await ApiKeyStore.open(),
      version: 'test',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('s7-audit-run-token-key-0123456789abcdef'), // secret-scan:allow (test fixture)
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      secretValues: new Set(),
    } as unknown as FactoryState;
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('S7 AC1: principal, email, grant, key, act-as and denied-route actions are ledgered with actor/subject/scope; authz/check adds no rows; chain verifies; no credential leaks', async () => {
    const admin = 'tok-s7-admin'; // secret-scan:allow (test fixture)
    const alice = 'tok-s7-alice'; // secret-scan:allow (test fixture)
    assert.equal((await call('POST', '/api/v1/principals', admin, { id: 'user:bob', displayName: 'Bob', emails: ['bob@example.com'] })).status, 201);
    assert.ok([200, 201].includes((await call('POST', '/api/v1/principals/user:bob/emails', admin, { email: 'bob@alt.example.com' })).status));
    const g = await call('POST', '/api/v1/grants', admin, { subject: 'user:alice', scope: { kind: 'fleet' }, role: 'viewer' });
    assert.ok([200, 201].includes(g.status), JSON.stringify(g.body));
    const grantId = (g.body.grant ?? g.body).id as string;
    assert.ok([200, 204].includes((await call('DELETE', `/api/v1/grants/${grantId}`, admin)).status));

    const issued = await call('POST', '/api/v1/keys', admin, { deviceFamily: 'cli' });
    assert.ok([200, 201].includes(issued.status), JSON.stringify(issued.body));
    const keyId = issued.body.key.id as string;
    const secret = issued.body.secret as string;
    assert.match(secret, /^fk_/);
    const rotated = await call('POST', `/api/v1/keys/${keyId}/rotate`, admin);
    assert.equal(rotated.status, 200);
    assert.ok([200, 204].includes((await call('DELETE', `/api/v1/keys/${keyId}`, admin)).status));
    // A revoked key is refused, and the refusal carries no part of it.
    assert.equal((await call('GET', '/api/v1/whoami', rotated.body.secret)).status, 401);

    // Act-as by a non-admin, and a route the caller holds no privilege for.
    assert.equal((await call('GET', '/api/v1/agents', alice, undefined, 'user:admin')).status, 403);
    assert.equal((await call('POST', '/api/v1/principals', alice, { id: 'user:mallory', displayName: 'M', emails: ['m@example.com'] })).status, 403);

    const rowsBefore = ledger.query().length;
    for (const p of ['grants.manage', 'ledger.read', 'agents.read']) await call('GET', `/api/v1/authz/check?privilege=${p}`, alice);
    assert.equal(ledger.query().length, rowsBefore, 'authz/check preflight writes nothing');

    const rows = ledger.query();
    const has = (prefix: string, pred: (e: (typeof rows)[number]) => boolean = () => true) => assert.ok(rows.some((e) => String(e.action ?? '').startsWith(prefix) && pred(e)), `ledger has ${prefix}`);
    has('PRINCIPAL_CREATED', (e) => e.actor === 'user:admin');
    has('PRINCIPAL_EMAIL_ADDED');
    has('GRANT_CREATED', (e) => e.actor === 'user:admin' && Boolean(e.scope));
    has('GRANT_REVOKED');
    has('KEY_ISSUED', (e) => e.actor === 'user:admin');
    has('KEY_ROTATED');
    has('KEY_REVOKED');
    has('AUTHZ_DENIED:act_as_requires_admin', (e) => e.actor === 'user:alice' && e.privilege === 'grants.manage');
    has('AUTHZ_DENIED', (e) => e.actor === 'user:alice' && e.privilege === 'grants.manage' && Boolean(e.scope));

    const verified = await call('GET', '/api/v1/ledger/verify', admin);
    assert.equal(verified.status, 200);
    assert.equal(verified.body.ok ?? verified.body.valid, true, JSON.stringify(verified.body));
    const listed = await call('GET', '/api/v1/ledger?limit=1000', admin);
    assert.equal(listed.status, 200);

    // Secret scan: the full ledger (as stored and as served) and every error body.
    const haystacks = [JSON.stringify(rows), JSON.stringify(listed.body), ...bodies];
    for (const h of haystacks) {
      for (const shape of SECRET_SHAPES) assert.doesNotMatch(h, shape, `credential shape ${shape} leaked`);
      for (const s of [secret, rotated.body.secret]) assert.ok(!h.includes(s), 'an issued key leaked');
    }
  });

  it('S7: every lifecycle action the plan names is ledgered somewhere in the control plane (transfers, submissions, gates, budget, holds, break-glass, recovery, owner conversion)', () => {
    const src = readdirSync(new URL('.', import.meta.url))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))
      .join('\n');
    for (const action of [
      'PRINCIPAL_CREATED', 'PRINCIPAL_EMAIL_ADDED', 'PRINCIPAL_EMAIL_REMOVED', 'GRANT_CREATED', 'GRANT_REVOKED',
      'KEY_ISSUED', 'KEY_ROTATED', 'KEY_REVOKED', 'OWNERSHIP_TRANSFER_' /* verbs asserted in transfers.e2e */,
      'BREAK_GLASS_USED', 'LOCKOUT_RECOVERED', 'CONTENT_SUBMITTED', 'GATE_PASSED', 'GATE_FAILED', 'CONTENT_ADMITTED',
      'BUDGET_ALLOCATED', 'HOLD_CLEARED', 'OWNER_CONVERTED', 'AUTHZ_DENIED',
    ]) assert.ok(src.includes(action), `${action} is never ledgered`);
  });
});
