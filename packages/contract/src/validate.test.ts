import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCartridge } from './validate.js';

const repoAgents = fileURLToPath(new URL('../../../agents', import.meta.url));

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cartridge-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const valid = {
  'soul.md': '# Soul\n\nEcho fixture.\n',
  'surface.yaml': 'triggers:\n  - type: http\n    path: /wake\n',
  'secrets.manifest.yaml': 'requires:\n  - API_KEY\n',
  'artifact.yaml': 'kind: oci\nref: oci://example/echo:latest\n',
  'bench.yaml': 'cases:\n  - id: smoke\n    input: {q: 1}\n    expect: {contains: ["1"]}\n',
};

describe('validateCartridge', () => {
  it('accepts a complete cartridge', () => {
    const dir = fixture(valid);
    try {
      const result = validateCartridge(dir);
      assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('rejects a missing surface.yaml', () => {
    const { 'surface.yaml': _, ...rest } = valid;
    const dir = fixture(rest);
    try {
      const result = validateCartridge(dir);
      assert.equal(result.ok, false);
      assert.ok(result.issues.some((i) => i.message.includes('missing')));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('rejects plaintext secret values', () => {
    const dir = fixture({
      ...valid,
      'secrets.manifest.yaml': 'requires:\n  - API_KEY\nvalue: sk-live-super-secret\n',
    });
    try {
      const result = validateCartridge(dir);
      assert.equal(result.ok, false);
      assert.ok(result.issues.some((i) => /plaintext secret/i.test(i.message) || /unrecognized key/i.test(i.message)));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('accepts a discord surface trigger', () => {
    const dir = fixture({
      ...valid,
      'surface.yaml': 'triggers:\n  - type: discord\n',
    });
    try {
      const result = validateCartridge(dir);
      assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('rejects .env in the cartridge', () => {
    const dir = fixture({ ...valid, '.env': 'API_KEY=abc\n' });
    try {
      const result = validateCartridge(dir);
      assert.equal(result.ok, false);
      assert.ok(result.issues.some((i) => i.message.includes('env files are forbidden')));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('bench suite', () => {
  it('is optional by default', () => {
    const { 'bench.yaml': _, ...rest } = valid;
    const dir = fixture(rest);
    try {
      const result = validateCartridge(dir);
      assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('rejects duplicate case ids and unknown expectation keys when provided', () => {
    const dir = fixture({ ...valid, 'bench.yaml': 'cases:\n  - id: a\n  - id: a\n    expect: {judge: llm}\n' });
    try {
      const result = validateCartridge(dir);
      assert.equal(result.ok, false);
      assert.ok(result.issues.some((i) => /unique/.test(i.message)));
      assert.ok(result.issues.some((i) => /judge|unrecognized/i.test(i.message)));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('unified cartridge.yaml', () => {
  const unifiedValid = {
    'soul.md': '# Soul\n\nUnified cartridge persona.\n',
    'cartridge.yaml': `schemaVersion: "1.0"
id: test-agent
name: "Test Agent"
role: "Automation"
triggers:
  - type: http
    path: /wake
  - type: cron
    schedule: "0 9 * * 1-5"
secrets:
  requires:
    - API_KEY
    - name: SLACK_TOKEN
      description: "Slack OAuth Bot Token"
persistence:
  prefix: "test-agent-state"
compute:
  kind: oci
  ref: "ghcr.io/org/test-agent:latest"
`,
  };

  it('accepts a valid unified cartridge without bench.yaml', () => {
    const dir = fixture(unifiedValid);
    try {
      const result = validateCartridge(dir);
      assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('accepts a valid unified cartridge with bench.yaml', () => {
    const dir = fixture({
      ...unifiedValid,
      'bench.yaml': 'cases:\n  - id: smoke\n    input: { test: true }\n    expect: { status: DONE }\n',
    });
    try {
      const result = validateCartridge(dir);
      assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('rejects plaintext secrets in cartridge.yaml', () => {
    const dir = fixture({
      ...unifiedValid,
      'cartridge.yaml': `${unifiedValid['cartridge.yaml']}token: "secret-token-value"\n`,
    });
    try {
      const result = validateCartridge(dir);
      assert.equal(result.ok, false);
      assert.ok(result.issues.some((i) => /plaintext secret|unrecognized key/i.test(i.message)));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('rejects missing soul or prompt in unified cartridge', () => {
    const dir = fixture({ 'cartridge.yaml': unifiedValid['cartridge.yaml'] });
    try {
      const result = validateCartridge(dir);
      assert.equal(result.ok, false);
      assert.ok(result.issues.some((i) => /missing soul\.md/i.test(i.message)));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('rejects when referenced prompt file does not exist', () => {
    const dir = fixture({
      'cartridge.yaml': `${unifiedValid['cartridge.yaml']}prompt: "./nonexistent.md"\n`,
    });
    try {
      const result = validateCartridge(dir);
      assert.equal(result.ok, false);
      assert.ok(result.issues.some((i) => /does not exist/i.test(i.message)));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('repo example cartridges', () => {
  const ids = ['librarian', 'factory-mechanic', 'compliance-officer', 'examples/echo-agent'];

  for (const id of ids) {
    it(`validates agents/${id}`, () => {
      const result = validateCartridge(join(repoAgents, id));
      assert.equal(result.ok, true, `${id}: ${JSON.stringify(result.issues, null, 2)}`);
    });
  }
});

