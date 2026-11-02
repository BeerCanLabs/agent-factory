import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloudflareAccessAuth,
  verifyOidcIdentity,
} from '@beercanlabs/factory-auth';
import {
  DuplicatePrincipalEmailError,
  DuplicatePrincipalIdError,
  FileDocBackend,
  GcsDocBackend,
  PRINCIPAL_ID,
  PrincipalStore,
  PrincipalStoreUnavailableError,
  S3CliDocBackend,
  SERVICE_PRINCIPAL_ID,
  docBackendFromUri,
  normalizeEmail,
  snapshotSha256,
  type AwsCliRunner,
  type PrincipalsDoc,
  type VersionedSnapshot,
} from './principals.js';

const TEAM = 'team.example.cloudflareaccess.com';
const ACCESS_ISS = `https://${TEAM}`;
const ACCESS_AUD = 'factory-access-aud';
const OIDC_MS_ISS = 'https://login.microsoftonline.com/consumers/v2.0';
const OIDC_GOOGLE_ISS = 'https://accounts.google.com';
const OIDC_AUD = 'factory-oidc-aud';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);

function mintJwt(claims: Record<string, unknown>, iss: string, aud: string | string[]) {
  const header = { alg: 'RS256', kid: 'k1', typ: 'JWT' };
  const body = { iss, aud, iat: nowSec(), nbf: nowSec(), exp: nowSec() + 300, ...claims };
  const input = `${b64(header)}.${b64(body)}`;
  return `${input}.${rsaSign('sha256', Buffer.from(input), rsa.privateKey).toString('base64url')}`;
}

describe('PrincipalStore & multi-email canonical principals (S1 #350)', () => {
  it('AC1: resolves multi-email aliases across Access & OIDC IdPs (any case) to one canonical principal with zero roles', async () => {
    let clock = 1_760_000_000_000;
    const store = await PrincipalStore.open(undefined, { now: () => new Date((clock += 1000)) });

    const created = await store.create({
      id: 'user:stephanie',
      displayName: 'Stephanie Sackrider',
      emails: ['StephanieSackrider@Hotmail.com ', ' stephanie.sackrider@gmail.com'],
      by: 'user:dale',
    });
    assert.equal(created.id, 'user:stephanie');
    assert.deepEqual(created.emails, ['stephaniesackrider@hotmail.com', 'stephanie.sackrider@gmail.com']);
    assert.equal(created.version, 1);

    const access = cloudflareAccessAuth({
      teamDomain: TEAM,
      audience: ACCESS_AUD,
      identityOnly: true,
      requireEmailVerified: true,
      adminEmails: ['stephanie.sackrider@gmail.com'],
      fetchJwks: async () => ({ keys: [jwk] }),
    });

    // 1. OIDC sign-in via Hotmail (mixed case, JWT contains admin role claim that must be stripped)
    const msJwt = mintJwt(
      {
        sub: 'ms-oid-001',
        email: 'STEPHANIESACKRIDER@HOTMAIL.COM',
        email_verified: true,
        roles: ['admin', 'operator'],
      },
      OIDC_MS_ISS,
      OIDC_AUD,
    );
    const msServer = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      import('node:http').then(({ default: http }) => {
        const srv = http.createServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (req.url === '/.well-known/openid-configuration') {
            res.end(JSON.stringify({ issuer: OIDC_MS_ISS, jwks_uri: `http://127.0.0.1:${(srv.address() as any).port}/jwks` }));
          } else {
            res.end(JSON.stringify({ keys: [jwk] }));
          }
        });
        srv.listen(0, '127.0.0.1', () => {
          resolve({
            url: `http://127.0.0.1:${(srv.address() as any).port}/jwks`,
            close: () => new Promise<void>((r) => srv.close(() => r())),
          });
        });
      });
    });

    try {
      const oidcVerified = await verifyOidcIdentity(msJwt, {
        issuer: OIDC_MS_ISS,
        audience: OIDC_AUD,
        jwksUrl: msServer.url,
        adminEmails: ['stephaniesackrider@hotmail.com'],
      });
      assert.equal(oidcVerified.ok, true);
      if (!oidcVerified.ok) throw new Error('expected ok');
      assert.deepEqual(oidcVerified.principal.roles, [], 'IdP verifier yields zero roles');

      const signIn1 = await store.recordSignIn({
        idp: 'microsoft',
        sub: oidcVerified.claims.sub,
        email: 'StephanieSackrider@Hotmail.com',
        emailVerified: oidcVerified.claims.emailVerified,
      });
      assert.equal(signIn1.ok, true);
      if (signIn1.ok && signIn1.principal) {
        assert.deepEqual(signIn1.principal, { actor: 'user:stephanie', roles: [] });
        assert.equal(signIn1.record.idpBindings.length, 1);
      }

      // 2. Access sign-in via Gmail (different IdP, different email alias, mixed case)
      const cfToken = mintJwt(
        {
          sub: 'cf-google-999',
          email: 'Stephanie.Sackrider@Gmail.COM',
          email_verified: true,
        },
        ACCESS_ISS,
        [ACCESS_AUD],
      );
      const cfAssertion = await access.verifyAssertion(cfToken);
      assert.equal(cfAssertion.ok, true);
      if (!cfAssertion.ok) throw new Error('expected ok');
      const cfVerify = await access.verify(cfToken);
      assert.deepEqual(cfVerify, {
        ok: true,
        principal: { actor: 'user:stephanie.sackrider@gmail.com', roles: [] },
      });

      const signIn2 = await store.recordSignIn({
        idp: 'google',
        sub: cfAssertion.claims.sub,
        email: cfAssertion.claims.email!,
        emailVerified: cfAssertion.claims.emailVerified,
      });
      assert.equal(signIn2.ok, true);
      if (signIn2.ok && signIn2.principal) {
        assert.deepEqual(signIn2.principal, { actor: 'user:stephanie', roles: [] });
        assert.equal(signIn2.record.idpBindings.length, 2);
        const firstSeen = signIn2.record.idpBindings[1].firstSeenAt;

        // Repeat sign-in updates lastSeenAt while keeping firstSeenAt intact
        const signIn3 = await store.recordSignIn({
          idp: 'google',
          sub: 'cf-google-999',
          email: 'stephanie.sackrider@gmail.com',
          emailVerified: true,
        });
        assert.equal(signIn3.ok, true);
        if (signIn3.ok && signIn3.principal) {
          assert.equal(signIn3.record.idpBindings.length, 2);
          assert.equal(signIn3.record.idpBindings[1].firstSeenAt, firstSeen);
          assert.notEqual(signIn3.record.idpBindings[1].lastSeenAt, firstSeen);
        }
      }

      // Case-insensitive lookup by either email
      assert.equal(store.findByEmail('STEPHANIESACKRIDER@HOTMAIL.COM')?.id, 'user:stephanie');
      assert.equal(store.findByEmail('Stephanie.Sackrider@gmail.com')?.id, 'user:stephanie');
    } finally {
      await msServer.close();
    }
  });

  it('AC2 & D6: refuses unverified email claims before lookup, and writes zero shadow records for unknown callers', async () => {
    let writes = 0;
    const base = new FileDocBackend<PrincipalsDoc>(mkdtempSync(join(tmpdir(), 'principals-d6-')));
    const countingBackend = {
      description: base.description,
      loadLatest: () => base.loadLatest(),
      write: async (snap: Parameters<typeof base.write>[0]) => {
        writes++;
        return base.write(snap);
      },
    };
    const store = await PrincipalStore.open(countingBackend);
    await store.create({
      id: 'user:stephanie',
      displayName: 'Stephanie',
      emails: ['stephanie.sackrider@gmail.com'],
      by: 'user:dale',
    });
    assert.equal(writes, 1);

    // AC2: emailVerified false or missing is refused with zero writes
    for (const emailVerified of [false, undefined] as const) {
      const refused = await store.recordSignIn({
        idp: 'google',
        sub: 'sub-1',
        email: 'stephanie.sackrider@gmail.com',
        emailVerified,
      });
      assert.deepEqual(refused, { ok: false, reason: 'email_not_verified' });
    }
    assert.equal(writes, 1);

    // D6: verified sign-in for unknown email returns principal: undefined and performs zero writes
    const unknown = await store.recordSignIn({
      idp: 'google',
      sub: 'stranger-sub',
      email: 'Stranger.Person@Example.COM',
      emailVerified: true,
    });
    assert.deepEqual(unknown, {
      ok: true,
      principal: undefined,
      normalizedEmail: 'stranger.person@example.com',
    });
    assert.equal(writes, 1);
    assert.equal(store.list().length, 1);
  });

  it('enforces global email uniqueness (409 DuplicatePrincipalEmailError), id uniqueness, and non-empty email rule', async () => {
    const store = PrincipalStore.inMemory();
    const p1 = await store.create({
      displayName: 'Alex One',
      emails: ['Alex@Gmail.com'],
      by: 'user:admin',
    });
    assert.equal(p1.id, 'user:alex');

    // Auto-derived slug disambiguates when local-part already exists
    const p2 = await store.create({
      displayName: 'Alex Two',
      emails: ['alex@hotmail.com'],
      by: 'user:admin',
    });
    assert.equal(p2.id, 'user:alex-hotmail.com');

    // Duplicate principal ID throws 409
    await assert.rejects(
      () => store.create({ id: 'user:alex', displayName: 'Dup', emails: ['unique@example.com'], by: 'user:admin' }),
      (err: unknown) => err instanceof DuplicatePrincipalIdError && err.status === 409,
    );

    // Duplicate email on create throws 409 DuplicatePrincipalEmailError
    await assert.rejects(
      () => store.create({ id: 'user:other', displayName: 'Other', emails: ['ALEX@GMAIL.COM'], by: 'user:admin' }),
      (err: unknown) =>
        err instanceof DuplicatePrincipalEmailError &&
        err.status === 409 &&
        err.email === 'alex@gmail.com' &&
        err.existingPrincipalId === 'user:alex',
    );

    // Adding an email mapped to another principal throws 409 DuplicatePrincipalEmailError
    await assert.rejects(
      () => store.addEmail('user:alex', 'ALEX@HOTMAIL.COM', 'user:admin'),
      (err: unknown) =>
        err instanceof DuplicatePrincipalEmailError &&
        err.status === 409 &&
        err.existingPrincipalId === 'user:alex-hotmail.com',
    );

    // Adding an email already on the same principal is idempotent; adding a new one increments version
    const idem = await store.addEmail('user:alex', 'ALEX@gmail.com', 'user:admin');
    assert.equal(idem.version, 1);
    const added = await store.addEmail('user:alex', 'alex.work@example.com', 'user:admin');
    assert.equal(added.version, 2);
    assert.deepEqual(added.emails, ['alex@gmail.com', 'alex.work@example.com']);

    // Record IdP bindings for both emails, then remove secondary email: bindings for removed email must be pruned (F7)
    await store.recordSignIn({ idp: 'google', sub: 'g-1', email: 'alex@gmail.com', emailVerified: true });
    await store.recordSignIn({ idp: 'entra', sub: 'e-1', email: 'alex.work@example.com', emailVerified: true });
    assert.equal(store.get('user:alex')?.idpBindings.length, 2);

    // Removing secondary email succeeds, prunes its idpBindings, and releases it; removing the last email is refused
    const afterRemove = await store.removeEmail('user:alex', 'ALEX.WORK@EXAMPLE.COM', 'user:admin');
    assert.deepEqual(afterRemove.emails, ['alex@gmail.com']);
    assert.deepEqual(
      afterRemove.idpBindings.map((b) => ({ idp: b.idp, sub: b.sub, email: b.email })),
      [{ idp: 'google', sub: 'g-1', email: 'alex@gmail.com' }],
    );
    assert.equal(store.findByEmail('alex.work@example.com'), undefined);
    await assert.rejects(() => store.removeEmail('user:alex', 'alex@gmail.com', 'user:admin'), /last email/i);

    // Email-shaped canonical principal IDs (user:<email>, user:alice+tag@sub.example.com) and SERVICE_PRINCIPAL_ID (F3)
    const emailShaped = await store.create({
      id: 'user:Dale@Example.com',
      displayName: 'Dale',
      emails: ['dale@example.com'],
      by: 'user:admin',
    });
    assert.equal(emailShaped.id, 'user:dale@example.com');
    assert.equal(PRINCIPAL_ID.test('user:alice+tag@sub.example.com'), true);
    assert.equal(SERVICE_PRINCIPAL_ID.test('service:deploy-check.access'), true);
    assert.equal(SERVICE_PRINCIPAL_ID.test('service:///'), false);

    // Invalid emails and invalid principal IDs are rejected
    for (const badEmail of ['', 'plain', '@domain.com', 'a@b', 'a..b@example.com', '.a@example.com']) {
      assert.throws(() => normalizeEmail(badEmail));
    }
    for (const badId of ['cloudflare:bad@example.com', 'user:@', 'user:///', 'user:foo@bar', 'user:a..b@example.com']) {
      await assert.rejects(
        () => store.create({ id: badId, displayName: 'Bad', emails: [`ok-${Math.random().toString(36).slice(2)}@example.com`], by: 'user:admin' }),
        /invalid principal id/,
      );
    }
  });

  it('R2 & R8: FileDocBackend persists versioned snapshots across restarts and fails closed on corruption or write error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'principals-file-'));
    try {
      const backend = new FileDocBackend<PrincipalsDoc>(dir);
      const store1 = await PrincipalStore.open(backend);
      await store1.create({
        id: 'user:dale',
        displayName: 'Dale Sackrider',
        emails: ['dale@sackrider.org'],
        by: 'user:dale',
      });
      await store1.addEmail('user:dale', 'dale.alt@example.com', 'user:dale');

      assert.equal(existsSync(join(dir, '1.json')), true);
      assert.equal(existsSync(join(dir, '2.json')), true);
      assert.equal(existsSync(join(dir, 'current.json')), true);

      // Survives restart
      const store2 = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(dir));
      assert.deepEqual(store2.get('user:dale')?.emails, ['dale@sackrider.org', 'dale.alt@example.com']);

      // Write failure marks store unhealthy (503 fail-closed, F2/R8) and leaves durable state untouched on reload
      const failingStore = await PrincipalStore.open({
        description: 'failing://',
        loadLatest: () => backend.loadLatest(),
        write: async () => {
          throw new Error('disk full');
        },
      });
      await assert.rejects(() => failingStore.addEmail('user:dale', 'uncommitted@example.com', 'user:dale'), /disk full/);
      assert.equal(failingStore.healthy, false);
      assert.throws(() => failingStore.findByEmail('dale@sackrider.org'), PrincipalStoreUnavailableError);
      await failingStore.reload();
      assert.equal(failingStore.healthy, true);
      assert.equal(failingStore.findByEmail('uncommitted@example.com'), undefined);

      // Orphaned uncommitted <n>.json (crash after writing 3.json before current.json):
      // reload serves current.json (v2) rather than 3.json, and next commit skips 3.json to allocate 4.json (F2)
      const orphanedData: PrincipalsDoc = {
        principals: [
          {
            ...store2.get('user:dale')!,
            emails: ['dale@sackrider.org', 'dale.alt@example.com', 'orphaned@example.com'],
            version: 3,
          },
        ],
      };
      const orphanedSnap: VersionedSnapshot<PrincipalsDoc> = {
        version: 3,
        updatedAt: new Date().toISOString(),
        updatedBy: 'user:dale',
        sha256: snapshotSha256(orphanedData),
        data: orphanedData,
      };
      writeFileSync(join(dir, '3.json'), `${JSON.stringify(orphanedSnap, null, 2)}\n`);
      const recovered = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(dir));
      assert.equal(recovered.findByEmail('orphaned@example.com'), undefined, 'uncommitted 3.json must not be served');
      assert.deepEqual(recovered.get('user:dale')?.emails, ['dale@sackrider.org', 'dale.alt@example.com']);
      await recovered.addEmail('user:dale', 'committed4@example.com', 'user:dale');
      assert.equal(existsSync(join(dir, '4.json')), true, 'next commit skips orphaned 3.json and writes 4.json');
      assert.equal(JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8')).version, 4);

      // Missing current.json when version files exist fails closed (F2/R8)
      const missingCurrentDir = mkdtempSync(join(tmpdir(), 'principals-nocurrent-'));
      try {
        cpSync(join(dir, '1.json'), join(missingCurrentDir, '1.json'));
        await assert.rejects(
          () => PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(missingCurrentDir)),
          /missing current\.json/,
        );
      } finally {
        rmSync(missingCurrentDir, { recursive: true, force: true });
      }

      // Tampering with snapshot data triggers sha256 mismatch -> open/reload throws and marks store unhealthy (R8 fail closed)
      const snap2 = JSON.parse(readFileSync(join(dir, '2.json'), 'utf8'));
      snap2.data.principals[0].emails.push('forged@example.com');
      writeFileSync(join(dir, '2.json'), JSON.stringify(snap2));

      await assert.rejects(() => PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(dir)), /sha256 mismatch/);
      await assert.rejects(() => store2.reload(), /sha256 mismatch/);
      assert.equal(store2.healthy, false);
      assert.throws(() => store2.get('user:dale'), PrincipalStoreUnavailableError);
      assert.throws(() => store2.findByEmail('dale@sackrider.org'), PrincipalStoreUnavailableError);
      assert.throws(() => store2.list(), PrincipalStoreUnavailableError);
      await assert.rejects(
        () => store2.recordSignIn({ idp: 'google', email: 'dale@sackrider.org', emailVerified: true }),
        PrincipalStoreUnavailableError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('R2 & R8: S3CliDocBackend uses aws s3 / s3api subprocesses, retries transient errors, and fails closed', async () => {
    const bucketDir = mkdtempSync(join(tmpdir(), 'principals-s3-sim-'));
    const calls: string[][] = [];
    let transientLoadFailures = 1;

    const fakeAwsCli: AwsCliRunner = async (args) => {
      calls.push(args);
      if (args[0] === 's3' && args[1] === 'sync') {
        if (transientLoadFailures > 0) {
          transientLoadFailures--;
          throw new Error('transient network error');
        }
        const dest = args[3];
        if (existsSync(bucketDir)) cpSync(bucketDir, dest, { recursive: true });
        return '';
      }
      if (args[0] === 's3api' && args[1] === 'put-object') {
        const key = args[args.indexOf('--key') + 1].replace(/^auth\/principals\//, '');
        const bodyPath = args[args.indexOf('--body') + 1];
        const target = join(bucketDir, key);
        if (args.includes('--if-none-match') && existsSync(target)) {
          throw new Error('PreconditionFailed');
        }
        writeFileSync(target, readFileSync(bodyPath));
        return '{}';
      }
      throw new Error(`unexpected aws command: ${args.join(' ')}`);
    };

    try {
      const s3 = new S3CliDocBackend<PrincipalsDoc>('s3://factory-config/auth/principals', fakeAwsCli, {
        maxAttempts: 2,
        retryDelayMs: 1,
      });
      const store = await PrincipalStore.open(s3);
      await store.create({
        id: 'user:stephanie',
        displayName: 'Stephanie',
        emails: ['stephaniesackrider@hotmail.com'],
        by: 'user:dale',
      });

      const reloaded = await PrincipalStore.open(
        docBackendFromUri<PrincipalsDoc>('s3://factory-config/auth/principals', '/unused', fakeAwsCli),
      );
      assert.equal(reloaded.findByEmail('stephaniesackrider@hotmail.com')?.id, 'user:stephanie');
      assert.ok(calls.some((c) => c[0] === 's3' && c[1] === 'sync'));
      assert.ok(calls.some((c) => c[0] === 's3api' && c.includes('--if-none-match')));

      // Persistent S3 failure fails closed on open
      const downCli: AwsCliRunner = async () => {
        throw new Error('AccessDenied');
      };
      const failingS3 = new S3CliDocBackend<PrincipalsDoc>('s3://factory-config/auth/principals', downCli, {
        maxAttempts: 1,
        retryDelayMs: 0,
      });
      await assert.rejects(() => PrincipalStore.open(failingS3), /AccessDenied/);
      assert.throws(() => docBackendFromUri('ftp://bad/path', '/tmp'), /unsupported backend uri/);
    } finally {
      rmSync(bucketDir, { recursive: true, force: true });
    }
  });

  it('R2, R8 & R12: GcsDocBackend supports gs:// and gcs:// via native GCS JSON API with ifGenerationMatch=0, retry, and fail-closed corruption checks', async () => {
    const objects = new Map<string, string>();
    let transientListFailures = 1;
    let transientPointerFailures = 1;
    const seenUrls: string[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      seenUrls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      assert.equal((init?.headers as Record<string, string>)?.Authorization, 'Bearer test-gcs-token');

      // Upload endpoint
      if (url.pathname === '/upload/storage/v1/b/factory-gcp-cfg/o' && init?.method === 'POST') {
        const name = url.searchParams.get('name')!;
        const genMatch = url.searchParams.get('ifGenerationMatch');
        if (genMatch === '0' && objects.has(name)) {
          return new Response('PreconditionFailed', { status: 412 });
        }
        if (name.endsWith('/current.json') && transientPointerFailures > 0) {
          transientPointerFailures--;
          return new Response('Service Unavailable', { status: 503 });
        }
        objects.set(name, String(init?.body ?? ''));
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // List endpoint (paginated into 1 item per page to exercise nextPageToken)
      if (url.pathname === '/storage/v1/b/factory-gcp-cfg/o' && (!init?.method || init.method === 'GET')) {
        if (transientListFailures > 0) {
          transientListFailures--;
          return new Response('Bad Gateway', { status: 502 });
        }
        const prefix = url.searchParams.get('prefix') ?? '';
        const matching = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const idx = Number(url.searchParams.get('pageToken') ?? '0');
        const slice = matching.slice(idx, idx + 1).map((name) => ({ name }));
        const nextPageToken = idx + 1 < matching.length ? String(idx + 1) : undefined;
        return new Response(JSON.stringify({ items: slice, ...(nextPageToken ? { nextPageToken } : {}) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Media download endpoint
      const dlMatch = url.pathname.match(/^\/storage\/v1\/b\/factory-gcp-cfg\/o\/(.+)$/);
      if (dlMatch && url.searchParams.get('alt') === 'media') {
        const key = decodeURIComponent(dlMatch[1]);
        const content = objects.get(key);
        if (content === undefined) return new Response('Not Found', { status: 404 });
        return new Response(content, { status: 200 });
      }

      return new Response('Unexpected route', { status: 500 });
    };

    const gcsOpts = {
      fetch: mockFetch,
      getAccessToken: async () => 'test-gcs-token',
      maxAttempts: 3,
      retryDelayMs: 1,
      apiEndpoint: 'https://storage.example.test',
    };

    const gcsBackend = docBackendFromUri<PrincipalsDoc>('gcs://factory-gcp-cfg/auth/principals', '/unused', { gcs: gcsOpts });
    assert.equal(gcsBackend instanceof GcsDocBackend, true);
    assert.equal(gcsBackend.description, 'gs://factory-gcp-cfg/auth/principals/');

    const store = await PrincipalStore.open(gcsBackend);
    await store.create({
      id: 'user:stephanie',
      displayName: 'Stephanie Sackrider',
      emails: ['stephaniesackrider@hotmail.com', 'stephanie.sackrider@gmail.com'],
      by: 'user:dale',
    });

    assert.ok(seenUrls.some((u) => u.includes('ifGenerationMatch=0') && u.includes('1.json')));
    assert.equal(transientPointerFailures, 0, 'pointer upload retried after transient 503');

    // Reload via gs:// URI exercises pagination + snapshot verification
    const reloaded = await PrincipalStore.open(
      docBackendFromUri<PrincipalsDoc>('gs://factory-gcp-cfg/auth/principals', '/unused', { gcs: gcsOpts }),
    );
    assert.equal(reloaded.findByEmail('stephanie.sackrider@gmail.com')?.id, 'user:stephanie');

    // Conditional write collision (412 PreconditionFailed) throws
    const rawSnap = (await gcsBackend.loadLatest())!;
    await assert.rejects(() => gcsBackend.write(rawSnap), /412: PreconditionFailed/);

    // Corrupting stored GCS object triggers fail-closed error on open (R8)
    const tampered = JSON.parse(objects.get('auth/principals/1.json')!);
    tampered.data.principals[0].emails.push('tampered@example.com');
    objects.set('auth/principals/1.json', JSON.stringify(tampered));
    await assert.rejects(
      () => PrincipalStore.open(new GcsDocBackend<PrincipalsDoc>('gs://factory-gcp-cfg/auth/principals', gcsOpts)),
      /sha256 mismatch/,
    );
  });
});
