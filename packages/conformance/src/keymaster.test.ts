// DESIGN_AUTHORITY.md §6.11 — Keymaster K1: OAuth grants and app client secrets are held only by the Keymaster.
// K5.3: a credential supplied to the Keymaster is never displayed, echoed, logged, or ledgered.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGateway, type ControlClient, type Route } from '@beercanlabs/factory-gateway';
import { expectOnlyBaselined, files, read } from './support.js';

const GOOGLE_HOST = /(^|\.)(googleapis\.com|google\.com)$/;

/** Every gateway route object declared anywhere in the landing zones (JSON, or JSON escaped inside an HCL string). */
function landingZoneRoutes(): Array<{ where: string; route: Route }> {
  const out: Array<{ where: string; route: Route }> = [];
  for (const f of files('landing-zones', (p) => /\.(tf|json|ya?ml|env)$/.test(p))) {
    const text = read(f).replace(/\\"/g, '"');
    for (let i = text.indexOf('{"id":'); i >= 0; i = text.indexOf('{"id":', i + 1)) {
      let depth = 0;
      let end = -1;
      let inStr = false;
      for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (inStr) {
          if (c === '\\') j++;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          end = j;
          break;
        }
      }
      if (end < 0) continue;
      try {
        const route = JSON.parse(text.slice(i, end + 1)) as Route;
        if (route && typeof route.id === 'string' && 'kind' in route) out.push({ where: f, route });
      } catch {
        // not a route object
      }
    }
  }
  return out;
}

const hostOf = (u?: string) => {
  try {
    return u ? new URL(u).hostname : '';
  } catch {
    return '';
  }
};

describe('K1 the Keymaster owns OAuth grants and app secrets', () => {
  it('the AWS landing zone declares its Google routes', () => {
    const ids = landingZoneRoutes().filter((r) => r.where === 'landing-zones/aws/variables.tf').map((r) => r.route.id);
    for (const id of ['google-calendar', 'google-gmail', 'google-drive', 'google-health', 'google-storage']) assert.ok(ids.includes(id), `missing route ${id}`);
  });

  it('no gateway route to a Google API carries a static credential; API routes use a Keymaster connection', () => {
    const google = landingZoneRoutes().filter((r) => GOOGLE_HOST.test(hostOf(r.route.upstream)));
    assert.ok(google.length > 0);
    const withCredential = google.filter((r) => r.route.credential).map((r) => `${r.where}: ${r.route.id}`);
    assert.deepEqual(withCredential, [], 'Google routes must not inject a static credential (use `connection`)');
    // Every Google API route except the legacy token endpoint must be a connection route.
    const noConnection = google.filter((r) => !r.route.connection && hostOf(r.route.upstream) !== 'oauth2.googleapis.com').map((r) => `${r.where}: ${r.route.id}`);
    assert.deepEqual(noConnection, []);
  });

  it('the gateway refuses a route that mixes a connection with a static credential', () => {
    const control = {} as ControlClient;
    assert.throws(() =>
      createGateway({
        routes: [{ id: 'g', kind: 'http', upstream: 'https://www.googleapis.com', connection: 'google', credential: { secret: 'X', header: 'authorization' } }],
        prices: {},
        runTokens: new RunTokens('conformance-run-token-key-0123456789'),
        control,
        providers: [],
      }),
    );
  });

  it('the kernel contains no Google client secrets, private keys, or tokens', () => {
    const all = files('.', (p) => /\.(ts|js|mjs|json|ya?ml|tf|env|md|py|sh)$/.test(p) && !p.startsWith('packages/conformance/'));
    const offenders: string[] = [];
    for (const f of all) {
      const text = read(f);
      // Google OAuth client secrets and PEM private-key bodies, in any file (tests generate keys at runtime).
      if (/GOCSPX-[A-Za-z0-9_-]{10,}/.test(text) || /-----BEGIN (RSA |EC )?PRIVATE KEY-----\s*(\\n)?[A-Za-z0-9+/]{40,}/.test(text)) offenders.push(f);
      // Real-looking access/refresh tokens outside tests.
      else if (!/\.test\.ts$/.test(f) && (/\bya29\.[A-Za-z0-9_-]{20,}/.test(text) || /["']1\/\/0[A-Za-z0-9_-]{20,}/.test(text))) offenders.push(f);
    }
    assert.deepEqual(offenders, []);
  });

  it('the gateway role cannot read grants in the AWS landing zone', () => {
    const gw = read('landing-zones/aws/iam.tf').match(/resource "aws_iam_role_policy" "gateway" \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(gw, /Sid\s*=\s*"NeverKeymasterGrants"[\s\S]*?Effect\s*=\s*"Deny"[\s\S]*?keymaster_grant_arns/);
  });
});

/** Source with comments removed and string/template literal contents blanked, so only code is inspected. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");
}

/** The text of every call to `callee(` in `code`, with balanced parentheses. */
function calls(code: string, callee: RegExp): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(new RegExp(callee.source + '\\s*\\(', 'g'))) {
    let depth = 0;
    for (let j = m.index! + m[0].length - 1; j < code.length; j++) {
      if (code[j] === '(') depth++;
      else if (code[j] === ')' && --depth === 0) {
        out.push(code.slice(m.index!, j + 1));
        break;
      }
    }
  }
  return out;
}

describe('K5.3 credential values are write-only', () => {
  const file = 'packages/control-plane/src/credentials.ts';
  const code = codeOnly(read(file));
  // Agent and platform submissions share one write-only path; the value exists only inside it.
  const submit = code.match(/async function writeCredential\([\s\S]*?\n\}\n/)?.[0] ?? '';

  it('the submit handler exists and is the only place a value is read', () => {
    assert.ok(submit.includes('submittedValue('), `${file}: writeCredential must read the value via submittedValue`);
    assert.ok(/async function submitCredential\([\s\S]*?await writeCredential\(/.test(code), 'agent submissions go through writeCredential');
    assert.ok(/const plat = path\.match\([\s\S]*?await writeCredential\(/.test(code), 'platform submissions go through writeCredential');
    assert.equal(code.split('submittedValue(').length - 1, 2, 'submittedValue is defined once and called once');
  });

  it('the value goes only to the secret manager and the redaction set', () => {
    const uses = submit.split('\n').filter((l) => /\bvalue\b/.test(l)).map((l) => l.trim());
    const allowed = [/const value = submittedValue\(/, /!value\)/, /\bvalue\.length\b/, /secretValues\.add\(value\)/, /\.put\(name, value\)/];
    const unexpected = uses.filter((u) => !allowed.some((re) => re.test(u)));
    assert.deepEqual(unexpected, [], `${file}: writeCredential may use the value only to validate, store, and redact it`);
    assert.ok(uses.some((u) => /\.put\(name, value\)/.test(u)), 'the value is written to the secret manager');
  });

  it('no response, log line, or ledger row in the credentials API carries the value or the raw body', () => {
    const sinks = [/\bjson/, /\bnoStore/, /console\.\w+/, /ledger\.append/, /res\.(end|write|setHeader|writeHead)/];
    const leaks = sinks.flatMap((re) => calls(code, re)).filter((c) => /\b(value|raw|body)\b/.test(c.replace(/^[^(]*\(/, '')));
    assert.deepEqual(leaks, []);
  });
});

describe('K1/K5 infrastructure never creates secrets (GAP-050)', () => {
  it('no landing zone declares a secret, a secret version, or a generated password', () => {
    // The Keymaster creates and fills credentials (K5). A landing zone may reference secrets by name; it never
    // creates them or holds their values (which would also put the values in infrastructure state).
    const kinds = /^resource\s+"(aws_secretsmanager_secret(?:_version)?|google_secret_manager_secret(?:_version)?|azurerm_key_vault_secret|random_password)"\s+"([^"]+)"/gm;
    const found = files('landing-zones', (p) => p.endsWith('.tf')).flatMap((f) =>
      [...read(f).matchAll(kinds)].map((m) => ({ rule: 'K5', where: f, detail: `${m[1]}.${m[2]}` })),
    );
    expectOnlyBaselined('K5', found);
  });
});
