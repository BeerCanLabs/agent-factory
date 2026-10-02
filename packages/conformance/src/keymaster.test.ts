// DESIGN_AUTHORITY.md §6.11 — Keymaster K1: OAuth grants and app client secrets are held only by the Keymaster.
// K5.3: a credential supplied to the Keymaster is never displayed, echoed, logged, or ledgered.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, type ControlClient, type Route } from '@beercanlabs/factory-gatekeeper-egress';
import { expectOnlyBaselined, files, read } from './support.js';

const GOOGLE_HOST = /(^|\.)(googleapis\.com|google\.com)$/;

/** Every gatekeeper-egress route object declared anywhere in the landing zones (JSON, or JSON escaped inside an HCL string). */
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
  it('the factory defines its Google systems with Keymaster connection', () => {
    const systemsSrc = read('packages/control-plane/src/systems.ts');
    for (const id of ['google-calendar', 'google-gmail', 'google-drive', 'google-health', 'google-storage']) {
      assert.ok(systemsSrc.includes(`id: '${id}'`), `missing system ${id}`);
    }
  });

  it('K1/E10 OAuth providers are defined as system definitions and CONNECTION_PROVIDERS is removed (TSK-067)', () => {
    const kmFiles = files('packages/keymaster', (p) => /\.(ts|js)$/.test(p) && !p.includes('.test.'));
    const cpFiles = files('packages/control-plane', (p) => /\.(ts|js)$/.test(p) && !p.includes('.test.'));
    for (const f of [...kmFiles, ...cpFiles]) {
      const src = read(f);
      assert.doesNotMatch(src, /\bCONNECTION_PROVIDERS\b/, `${f} must not reference hardcoded CONNECTION_PROVIDERS`);
    }

    const systemsSrc = read('packages/control-plane/src/systems.ts');
    for (const id of ['google', 'linkedin', 'google-service-account']) {
      assert.match(systemsSrc, new RegExp(`id:\\s*'${id}'[\\s\\S]*?oauth:\\s*\\{`), `${id} must define an oauth block`);
    }
  });

  it('no route or system definition to a Google API carries a static credential; API routes use a Keymaster connection', () => {
    // Landing zone routes should have no Google routes (they are non-model routes per E10)
    const googleLz = landingZoneRoutes().filter((r) => GOOGLE_HOST.test(hostOf(r.route.upstream)));
    assert.equal(googleLz.length, 0, 'landing zones must not declare Google routes (E10)');

    // In systems.ts, Google API systems must not have static credentials and must use connection: 'google'
    const systemsSrc = read('packages/control-plane/src/systems.ts');
    for (const id of ['google-calendar', 'google-gmail', 'google-drive', 'google-health', 'google-storage']) {
      const match = systemsSrc.match(new RegExp(`{\\s*id:\\s*'${id}'[\\s\\S]*?}`));
      assert.ok(match, `system ${id} definition found`);
      assert.doesNotMatch(match[0], /credential:/, `${id} must not carry a static credential`);
      assert.match(match[0], /connection:\s*'google(-service-account)?'/, `${id} must use a Keymaster google connection`);
    }
  });

  it('the gatekeeper-egress refuses a route that mixes a connection with a static credential', () => {
    const control = {} as ControlClient;
    assert.throws(() =>
      createGatekeeperEgress({
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

  it('the gatekeeper-egress role cannot read grants in the AWS landing zone', () => {
    const gw = read('landing-zones/aws/iam.tf').match(/resource "aws_iam_role_policy" "gatekeeper_egress" \{[\s\S]*?\n\}/)?.[0] ?? '';
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

describe('K5.1 Keymaster-named credential entries (GAP-073)', () => {
  it('no agent cartridge declaration names a secret-manager entry or cloud path', () => {
    // K5.1: agents declare logical names (bot_token, token, etc.). Declarations must not start with the agent prefix
    // or name cloud secret-manager entries or paths (e.g. AGENT_X, agents/..., shared/...).
    const yamlFiles = files('agents', (p) => p.endsWith('cartridge.yaml'));
    const violations: Array<{ file: string; issue: string }> = [];
    for (const f of yamlFiles) {
      const content = read(f);
      const idMatch = content.match(/^id:\s*([a-zA-Z0-9_-]+)/m);
      if (!idMatch) continue;
      const agentId = idMatch[1];
      const prefix = `${agentId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;

      // Check requires
      const requiresSection = content.match(/secrets:\s*\n\s*requires:\s*\n([\s\S]*?)(?:\n\w+:|$)/);
      if (requiresSection) {
        const names = [...requiresSection[1].matchAll(/-\s*name:\s*([^\s\n]+)/g)].map((m) => m[1]);
        for (const name of names) {
          if (name.toUpperCase().startsWith(prefix)) {
            violations.push({ file: f, issue: `secret name "${name}" starts with agent prefix ${prefix}` });
          }
          if (name.includes('/') || name.startsWith('agents/') || name.startsWith('shared/')) {
            violations.push({ file: f, issue: `secret name "${name}" names a secret path` });
          }
        }
      }

      // Check trigger secretRefs
      const triggersSection = content.match(/triggers:\s*\n([\s\S]*?)(?:\n\w+:|$)/);
      if (triggersSection) {
        const refs = [...triggersSection[1].matchAll(/secretRef:\s*([^\s\n]+)/g)].map((m) => m[1]);
        for (const ref of refs) {
          if (ref.toUpperCase().startsWith(prefix)) {
            violations.push({ file: f, issue: `trigger secretRef "${ref}" starts with agent prefix ${prefix}` });
          }
          if (ref.includes('/') || ref.startsWith('agents/') || ref.startsWith('shared/')) {
            violations.push({ file: f, issue: `trigger secretRef "${ref}" names a secret path` });
          }
        }
      }
    }
    assert.deepEqual(violations, [], 'all agents in agents/ must declare logical secret names');
  });

  it('Keymaster stores credentials under agents/<agent>/<system>/<name> and shared/<system>/<name>', () => {
    // K5.1: The Keymaster creates and names every entry itself
    const credSrc = read('packages/keymaster/src/credentials.ts');
    assert.ok(credSrc.includes('agents/${normAgent}/${normSystem}/${normName}'));
    assert.ok(credSrc.includes('shared/${normSystem}/${normName}'));
  });
});
