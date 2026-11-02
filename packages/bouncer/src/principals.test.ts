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
  PrincipalStore,
  PrincipalStoreUnavailableError,
  S3CliDocBackend,
  docBackendFromUri,
  normalizeEmail,
  type AwsCliRunner,
  type PrincipalsDoc,
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

    // Removing secondary email succeeds and releases it; removing the last email is refused
    const afterRemove = await store.removeEmail('user:alex', 'ALEX.WORK@EXAMPLE.COM', 'user:admin');
    assert.deepEqual(afterRemove.emails, ['alex@gmail.com']);
    assert.equal(store.findByEmail('alex.work@example.com'), undefined);
    await assert.rejects(() => store.removeEmail('user:alex', 'alex@gmail.com', 'user:admin'), /last email/i);

    // Invalid emails and invalid principal IDs are rejected
    for (const badEmail of ['', 'plain', '@domain.com', 'a@b', 'a..b@example.com', '.a@example.com']) {
      assert.throws(() => normalizeEmail(badEmail));
    }
    await assert.rejects(
      () => store.create({ id: 'cloudflare:bad@example.com', displayName: 'Bad', emails: ['ok@example.com'], by: 'user:admin' }),
      /invalid principal id/,
    );
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

      // Write failure leaves in-memory state untouched (no uncommitted grant/email in memory)
      const failingStore = await PrincipalStore.open({
        description: 'failing://',
        loadLatest: () => backend.loadLatest(),
        write: async () => {
          throw new Error('disk full');
        },
      });
      await assert.rejects(() => failingStore.addEmail('user:dale', 'uncommitted@example.com', 'user:dale'), /disk full/);
      assert.equal(failingStore.findByEmail('uncommitted@example.com'), undefined);

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
});
