// DESIGN_AUTHORITY.md §6.17 (CL1 to CL7): the command-line client and the Factory Manager. The behavior is tested in
// packages/cli; these checks hold the shape: what the CLI may reference, where the manager lives, and that it adds no
// interface of its own.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { files, read, repoRoot } from './support.js';

const cliSource = files('packages/cli/src', (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('testing.ts'));
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = (f: string) => stripComments(read(f));
/** The `/api/v1/...` paths a source file names, with each `${...}` placeholder replaced by \u0001. */
const routes = (f: string): string[] => [...code(f).replace(/\$\{[^}]*\}/g, '\u0001').matchAll(/['"`](\/api\/v1\/[^'"`?]*)/g)].map((m) => m[1]);

describe('§6.17 CL1 sign-in is the person\'s own, verified assertion (A2)', () => {
  it('CL1 the CLI source never reads a factory token or sends an identity header of its own', () => {
    assert.ok(cliSource.length > 0, 'no CLI source found');
    for (const f of cliSource) {
      const src = code(f);
      assert.doesNotMatch(src, /FACTORY_TOKEN|FACTORY_TOKENS|cf-access-authenticated-user-email|x-forwarded-email/i, f);
      assert.doesNotMatch(src, /['"`]authorization['"`]\s*:/i, `${f} sets an Authorization header`);
    }
  });

  it('CL1 the assertion is stored in the macOS Keychain, with the secret passed on stdin', () => {
    const src = code('packages/cli/src/credentials.ts');
    assert.match(src, /find-generic-password/);
    assert.match(src, /\['-i'\]/);
  });
});

describe('§6.17 CL2 the manager is house staff, not a platform service (SV1, L2, L5)', () => {
  it('CL2 the CLI is declared platform tooling and is not a service', () => {
    const types = read('packages/contract/src/services/types.ts');
    assert.match(types, /PLATFORM_TOOL_PACKAGES[\s\S]*?\bcli: 'operator-ui'/);
  });

  it('CL2 the manager is a cartridge under agents/staff and no kernel package names it', () => {
    for (const f of ['cartridge.yaml', 'soul.md', 'agent.py', 'session.py']) {
      assert.ok(existsSync(join(repoRoot, 'agents/staff/factory-manager', f)), `agents/staff/factory-manager/${f}`);
    }
    const kernel = files('packages', (f) => /\.(ts|tsx|json)$/.test(f) && !f.startsWith('packages/cli/') && !f.startsWith('packages/conformance/') && !f.endsWith('package-lock.json') && !f.endsWith('.test.ts'));
    const mentions = kernel.filter((f) => /factory-manager/.test(read(f)));
    assert.deepEqual(mentions, [], 'a package outside the CLI names the Factory Manager: its reasoning belongs in the cartridge (Donna Test)');
  });

  it('CL2 the manager holds no model-provider or cloud SDK and calls models only through the factory model API (E5)', () => {
    const src = ['agent.py', 'session.py'].map((f) => read(`agents/staff/factory-manager/${f}`)).join('\n');
    assert.doesNotMatch(src, /^\s*(import|from)\s+(boto3|anthropic|openai|google)\b/m);
    assert.match(src, /FACTORY_MODEL_BASE_URL/);
    assert.match(src, /FACTORY_RUN_TOKEN/);
  });
});

describe('§6.17 CL5 the CLI adds no interface', () => {
  const cp = ['app.ts', 'spend.ts', 'stream.ts'].map((f) => read(`packages/control-plane/src/${f}`)).join('\n');

  it('CL5 every path the CLI names is built from segments the control plane has (a coarse check; tools.test.ts and the e2e test cover the real routes)', () => {
    const missing: string[] = [];
    for (const f of cliSource) {
      for (const m of routes(f)) {
        // Drop `${...}` id segments; what is left is the fixed parts, which must each appear in the control plane.
        const parts = m.split('\u0001').flatMap((p) => p.split('/').filter(Boolean));
        for (const p of parts) if (!cp.includes(p)) missing.push(`${f}: ${m} (${p})`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('CL5 the CLI opens no socket of its own: it uses fetch and the console\'s reply path', () => {
    for (const f of cliSource) {
      const src = code(f);
      assert.doesNotMatch(src, /node:net|node:http|WebSocket|createServer|listen\(/, f);
    }
    assert.match(code('packages/cli/src/client.ts'), /\/conversation/);
    assert.match(code('packages/cli/src/client.ts'), /\/replies\?after=/);
  });
});

describe('§6.17 CL6 the CLI never handles a secret (K5, S1)', () => {
  it('CL6 no CLI source calls the Keymaster, credentials, connections or secret routes', () => {
    for (const f of cliSource) {
      for (const m of routes(f)) {
        assert.doesNotMatch(m, /keymaster|credentials|connections|secrets?\b|keys\b/i, `${f}: ${m}`);
      }
    }
  });
});

describe('§6.17 CL8 setup and preferences are the person\'s own', () => {
  it('CL8 the settings file is private to its owner and holds no credential', () => {
    const src = code('packages/cli/src/config.ts');
    assert.match(src, /mode:\s*0o600/);
    const shape = src.match(/export type CliConfig = \{[^}]*\}/)?.[0] ?? '';
    assert.match(shape, /instance/, 'the settings type was not found');
    assert.doesNotMatch(shape, /token|secret|password|credential/i, 'a credential field in the saved settings');
  });

  it('CL8 nothing the factory or the manager receives is built from the settings', () => {
    for (const f of ['client.ts', 'manager.ts', 'tools.ts', 'protocol.ts']) {
      assert.doesNotMatch(code(`packages/cli/src/${f}`), /from '\.\/(config|theme|splash)\.js'/, f);
    }
  });

  it('CL8 colour honours NO_COLOR and a non-terminal', () => {
    assert.match(code('packages/cli/src/theme.ts'), /NO_COLOR/);
    assert.match(code('packages/cli/src/theme.ts'), /isTTY/);
  });
});
