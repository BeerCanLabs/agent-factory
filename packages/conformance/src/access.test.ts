// DESIGN_AUTHORITY.md §6.12 — operator access. A2: identity is verified, not asserted.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { accessAuthFromEnv, cloudflareAccessAuth } from '@beercanlabs/factory-auth';
import { files, read } from './support.js';

const src = (dir: string) => files(dir, (p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p));

describe('A2 identity is verified, not asserted', () => {
  it('no platform code reads an unsigned identity header', () => {
    const offenders = [...src('packages/control-plane/src'), ...src('packages/auth/src'), ...src('packages/gatekeeper-egress/src'), 'packages/console/server.ts']
      .filter((f) => /cf-access-authenticated-user-email/i.test(read(f)));
    assert.deepEqual(offenders, []);
  });

  it('the control plane authenticates only through verifiers (no identity from headers in authenticate)', () => {
    const app = read('packages/control-plane/src/app.ts');
    const fn = app.slice(app.indexOf('export async function identify('), app.indexOf('export async function authenticate('));
    assert.ok(fn.length > 0, 'identify() not found in app.ts');
    assert.match(fn, /state\.auth\.verify\(/);
    assert.match(fn, /state\.access\.verify\(/);
    assert.doesNotMatch(fn, /actor:\s*`/, 'identify() builds a principal itself instead of taking it from a verifier');
  });

  it('the console adds no credential of its own', () => {
    const server = read('packages/console/server.ts');
    assert.doesNotMatch(server, /FACTORY_TOKEN/, 'console server reads FACTORY_TOKEN');
    assert.doesNotMatch(server, /\.authorization\s*=|['"]authorization['"]\s*[:\]]/i, 'console server sets an Authorization header');
    const ecs = read('landing-zones/aws/ecs.tf');
    const consoleTask = ecs.match(/resource "aws_ecs_task_definition" "console" \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(consoleTask, 'console task definition not found');
    assert.doesNotMatch(consoleTask, /FACTORY_TOKEN|valueFrom/, 'the console task is given a factory credential');
  });

  it('no admin is built into code; the landing zone leaves Access identity off by default', () => {
    const hardCoded = [...src('packages/auth/src'), ...src('packages/control-plane/src'), 'packages/console/server.ts', ...src('packages/console/src')]
      .filter((f) => /ADMIN_EMAILS[^\n]*(\|\||\?\?)\s*\[?\s*['"][^'"\s]+@/.test(read(f)) || /adminEmails\s*\?\?\s*\[\s*['"]/.test(read(f)));
    assert.deepEqual(hardCoded, []);
    const vars = read('landing-zones/aws/variables.tf');
    for (const v of ['access_team_domain', 'access_aud', 'admin_emails']) {
      const block = vars.match(new RegExp(`variable "${v}" \\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
      assert.match(block, /default\s*=\s*""/, `${v} must default to empty (disabled)`);
    }
  });

  it('Access identity fails closed and refuses unsigned and forged assertions', async () => {
    assert.equal(accessAuthFromEnv({}), undefined);
    const team = 'conformance.cloudflareaccess.com';
    const aud = 'conformance-aud';
    const good = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const bad = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...good.publicKey.export({ format: 'jwk' }), kid: 'k1' };
    const auth = cloudflareAccessAuth({ teamDomain: team, audience: aud, adminEmails: ['admin@example.com'], fetchJwks: async () => ({ keys: [jwk] }) });
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const body = b64({ iss: `https://${team}`, aud: [aud], exp: Math.floor(Date.now() / 1000) + 300, email: 'admin@example.com' });
    const signed = (alg: string, key: typeof good.privateKey) => {
      const input = `${b64({ alg, kid: 'k1' })}.${body}`;
      return `${input}.${rsaSign('sha256', Buffer.from(input), key).toString('base64url')}`;
    };
    assert.equal((await auth.verify(signed('RS256', good.privateKey))).ok, true);
    assert.equal((await auth.verify(signed('RS256', bad.privateKey))).ok, false);
    assert.equal((await auth.verify(`${b64({ alg: 'none', kid: 'k1' })}.${body}.`)).ok, false);
    assert.equal((await auth.verify(signed('HS256', good.privateKey))).ok, false);
  });
});
