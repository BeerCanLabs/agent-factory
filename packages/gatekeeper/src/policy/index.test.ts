import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyModelsRemoval,
  effectiveAgentModels,
  PolicyStore,
  validatePolicy,
  type AgentPolicy,
} from './index.js';

describe('validatePolicy: model fields', () => {
  it('permits valid currentModel, primaryModel, and secondaryModel', () => {
    const raw = {
      routes: ['models'],
      models: ['m1', 'm2', 'm3'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    const res = validatePolicy(raw);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.policy.currentModel, 'm1');
      assert.equal(res.policy.primaryModel, 'm1');
      assert.equal(res.policy.secondaryModel, 'm2');
    }
  });

  it('deduplicates models preserving order', () => {
    const raw = {
      routes: ['models'],
      models: ['m1', 'm2', 'm1', 'm3', 'm2'],
    };
    const res = validatePolicy(raw);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.policy.models, ['m1', 'm2', 'm3']);
    }
  });

  it('rejects secondaryModel equal to effective primaryModel', () => {
    const raw = {
      routes: ['models'],
      models: ['m1', 'm2'],
      primaryModel: 'm1',
      secondaryModel: 'm1',
    };
    const res = validatePolicy(raw);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error, 'secondaryModel cannot equal primaryModel');
    }
  });

  it('rejects secondaryModel equal to effective primaryModel when primaryModel is defaulted', () => {
    const raw = {
      routes: ['models'],
      models: ['m1', 'm2'],
      secondaryModel: 'm1',
    };
    const res = validatePolicy(raw);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error, 'secondaryModel cannot equal primaryModel');
    }
  });

  it('rejects secondaryModel not present in models', () => {
    const raw = {
      routes: ['models'],
      models: ['m1', 'm2'],
      primaryModel: 'm1',
      secondaryModel: 'm3',
    };
    const res = validatePolicy(raw);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error, 'secondaryModel must be in models');
    }
  });

  it('rejects currentModel not present in models', () => {
    const raw = {
      routes: ['models'],
      models: ['m1', 'm2'],
      currentModel: 'm3',
    };
    const res = validatePolicy(raw);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error, 'currentModel must be in models');
    }
  });

  it('rejects primaryModel not present in models', () => {
    const raw = {
      routes: ['models'],
      models: ['m1', 'm2'],
      primaryModel: 'm3',
    };
    const res = validatePolicy(raw);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error, 'primaryModel must be in models');
    }
  });

  it('accepts currentModel and primaryModel both null when models is non-empty', () => {
    const raw = {
      routes: ['models'],
      models: ['m1'],
      currentModel: null,
      primaryModel: null,
    };
    const res = validatePolicy(raw);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.policy.currentModel, null);
      assert.equal(res.policy.primaryModel, null);
    }
  });

  it('rejects if currentModel is null but primaryModel is not null', () => {
    const raw = {
      routes: ['models'],
      models: ['m1'],
      currentModel: null,
      primaryModel: 'm1',
    };
    const res = validatePolicy(raw);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error, 'currentModel and primaryModel must both be null when either is null');
    }
  });

  it('rejects if primaryModel is null but currentModel is not null', () => {
    const raw = {
      routes: ['models'],
      models: ['m1'],
      currentModel: 'm1',
      primaryModel: null,
    };
    const res = validatePolicy(raw);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error, 'currentModel and primaryModel must both be null when either is null');
    }
  });

  it('rejects secondaryModel if currentModel and primaryModel are null', () => {
    const raw = {
      routes: ['models'],
      models: ['m1', 'm2'],
      currentModel: null,
      primaryModel: null,
      secondaryModel: 'm2',
    };
    const res = validatePolicy(raw);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error, 'secondaryModel must be undefined when currentModel and primaryModel are null');
    }
  });

  it('rejects null currentModel/primaryModel if models is empty or undefined', () => {
    const raw = {
      routes: ['models'],
      models: [],
      currentModel: null,
      primaryModel: null,
    };
    const res = validatePolicy(raw);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error, 'models must be a non-empty array when models are unset');
    }
  });
});

describe('effectiveAgentModels', () => {
  it('returns defaultModel when policy.models is undefined', () => {
    const res = effectiveAgentModels({ routes: [] }, 'claude-haiku-4-5');
    assert.deepEqual(res, {
      approvedModels: ['claude-haiku-4-5'],
      usesDefault: true,
      currentModel: 'claude-haiku-4-5',
      primaryModel: 'claude-haiku-4-5',
      secondaryModel: undefined,
    });
  });

  it('returns empty when policy.models is empty array', () => {
    const res = effectiveAgentModels({ routes: [], models: [] }, 'claude-haiku-4-5');
    assert.deepEqual(res, {
      approvedModels: [],
      usesDefault: false,
      currentModel: null,
      primaryModel: null,
      secondaryModel: undefined,
    });
  });

  it('defaults primaryModel to models[0] and currentModel to primaryModel on legacy policy', () => {
    const res = effectiveAgentModels({ routes: [], models: ['m1', 'm2'] }, 'claude-haiku-4-5');
    assert.deepEqual(res, {
      approvedModels: ['m1', 'm2'],
      usesDefault: false,
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: undefined,
    });
  });

  it('returns explicit slots when set', () => {
    const res = effectiveAgentModels({
      routes: [],
      models: ['m1', 'm2', 'm3'],
      currentModel: 'm3',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    });
    assert.deepEqual(res, {
      approvedModels: ['m1', 'm2', 'm3'],
      usesDefault: false,
      currentModel: 'm3',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    });
  });
});

describe('applyModelsRemoval (§6.9 M2 transitions)', () => {
  it('returns unchanged clone if policy has no models', () => {
    const p: AgentPolicy = { routes: ['test'] };
    const res = applyModelsRemoval(p, ['m1']);
    assert.deepEqual(res, p);
  });

  it('removes models and deletes model slots if no models remain (reverts to default)', () => {
    const p: AgentPolicy = {
      routes: ['models'],
      models: ['m1'],
      currentModel: 'm1',
      primaryModel: 'm1',
    };
    const res = applyModelsRemoval(p, ['m1']);
    assert.equal(res.models, undefined);
    assert.equal(res.currentModel, undefined);
    assert.equal(res.primaryModel, undefined);
    assert.equal(res.secondaryModel, undefined);
  });

  it('resolves legacy policy before removing: if current === primary removed with secondary present', () => {
    const p: AgentPolicy = {
      routes: ['models'],
      models: ['m1', 'm2', 'm3'],
      secondaryModel: 'm2',
    };
    // Prior effective: current = m1, primary = m1. Removing m1 promotes m2 to both current and primary, clearing secondary
    const res = applyModelsRemoval(p, ['m1']);
    assert.deepEqual(res.models, ['m2', 'm3']);
    assert.equal(res.currentModel, 'm2');
    assert.equal(res.primaryModel, 'm2');
    assert.equal(res.secondaryModel, undefined);
  });

  it('Case A: current === primary retired, secondary unset -> leaves current and primary null', () => {
    const p: AgentPolicy = {
      routes: ['models'],
      models: ['m1', 'm2'],
      currentModel: 'm1',
      primaryModel: 'm1',
    };
    const res = applyModelsRemoval(p, ['m1']);
    assert.deepEqual(res.models, ['m2']);
    assert.equal(res.currentModel, null);
    assert.equal(res.primaryModel, null);
    assert.equal(res.secondaryModel, undefined);
  });

  it('Case A: current === primary retired, secondary set -> promotes secondary to current and primary, unsets secondary', () => {
    const p: AgentPolicy = {
      routes: ['models'],
      models: ['m1', 'm2', 'm3'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    const res = applyModelsRemoval(p, ['m1']);
    assert.deepEqual(res.models, ['m2', 'm3']);
    assert.equal(res.currentModel, 'm2');
    assert.equal(res.primaryModel, 'm2');
    assert.equal(res.secondaryModel, undefined);
  });

  it('Case B: current !== primary retired -> current becomes primary, primary and secondary unchanged', () => {
    const p: AgentPolicy = {
      routes: ['models'],
      models: ['m1', 'm2', 'm3'],
      currentModel: 'm2',
      primaryModel: 'm1',
      secondaryModel: 'm3',
    };
    const res = applyModelsRemoval(p, ['m2']);
    assert.deepEqual(res.models, ['m1', 'm3']);
    assert.equal(res.currentModel, 'm1');
    assert.equal(res.primaryModel, 'm1');
    assert.equal(res.secondaryModel, 'm3');
  });

  it('Case C: primary !== current, primary retired -> primary becomes current (secondary unchanged if !== current)', () => {
    const p: AgentPolicy = {
      routes: ['models'],
      models: ['m1', 'm2', 'm3'],
      currentModel: 'm2',
      primaryModel: 'm1',
      secondaryModel: 'm3',
    };
    const res = applyModelsRemoval(p, ['m1']);
    assert.deepEqual(res.models, ['m2', 'm3']);
    assert.equal(res.currentModel, 'm2');
    assert.equal(res.primaryModel, 'm2');
    assert.equal(res.secondaryModel, 'm3');
  });

  it('Case C: primary !== current, primary retired -> primary becomes current, clearing secondary if secondary === current', () => {
    const p: AgentPolicy = {
      routes: ['models'],
      models: ['m1', 'm2'],
      currentModel: 'm2',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    const res = applyModelsRemoval(p, ['m1']);
    assert.deepEqual(res.models, ['m2']);
    assert.equal(res.currentModel, 'm2');
    assert.equal(res.primaryModel, 'm2');
    assert.equal(res.secondaryModel, undefined);
  });

  it('secondary retired -> secondary becomes unset, current and primary unchanged', () => {
    const p: AgentPolicy = {
      routes: ['models'],
      models: ['m1', 'm2', 'm3'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    const res = applyModelsRemoval(p, ['m2']);
    assert.deepEqual(res.models, ['m1', 'm3']);
    assert.equal(res.currentModel, 'm1');
    assert.equal(res.primaryModel, 'm1');
    assert.equal(res.secondaryModel, undefined);
  });
});

describe('PolicyStore ephemeral policies (E1.4)', () => {
  it('an ephemeral policy is served but never written, and forgetEphemeral never drops a stored one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-ephemeral-'));
    try {
      const store = new PolicyStore(dir);
      store.setEphemeral('juror.helper.1', { routes: ['models'], models: ['m'] });
      assert.deepEqual(store.get('juror.helper.1'), { routes: ['models'], models: ['m'] });
      assert.deepEqual(readdirSync(dir), []);
      store.forgetEphemeral('juror.helper.1');
      assert.equal(store.has('juror.helper.1'), false);
      store.set('kept', { routes: [] });
      store.forgetEphemeral('kept');
      assert.equal(store.has('kept'), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GAP-255 policy env', () => {
  const ok = (env: unknown) => validatePolicy({ routes: [], env }).ok;
  it('accepts the SDLC_* settings agentic-sdlc registers', () => {
    assert.ok(ok({ SDLC_FLEET_CONFIG: '{"repos":{}}', SDLC_APPROVALS_URL: 'https://f/api/v1/agents/c/holds', SDLC_APPROVALS_FALLBACK: 'github', SDLC_GLOBAL_STATE_URL: 'https://f/api/v1/fleet/state' }));
  });
  it('is an allow-list: names the factory, runtimes, shim or platform use are refused', () => {
    for (const name of ['FACTORY_URL', 'PATH', 'GITHUB_BASE_URL', 'DISCORD_BASE_URL', 'OPENAI_BASE_URL', 'MEMORY_PREFIX', 'MEMORY_STORE_URI', 'AGENT_ID', 'GIT_SSH_COMMAND', 'BASH_ENV', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'SDLC_', 'lower']) {
      assert.equal(ok({ [name]: 'x' }), false, name);
    }
  });
  it('refuses credential-like names and values, control characters, non-text and oversized env', () => {
    for (const name of ['SDLC_BOT_TOKEN', 'SDLC_DB_PASSWORD', 'SDLC_GH_PAT', 'SDLC_OPENAI_KEY', 'SDLC_DB_PASS', 'SDLC_DSN', 'SDLC_SESSION']) assert.equal(ok({ [name]: 'x' }), false, name);
    const shaped = ['ghp' + '_' + 'A1'.repeat(10), 'eyJ' + 'abcdef.' + 'eyJabcdef.' + 'sig', 'https://u:' + 'pw' + '@db.example', '-----BEGIN ' + 'PRIVATE KEY-----'];
    for (const value of shaped) assert.equal(ok({ SDLC_X: value }), false, value.slice(0, 12));
    for (const value of ['a\u0000b', 'a\nb', 'a\u001bb']) assert.equal(ok({ SDLC_X: value }), false, JSON.stringify(value));
    assert.equal(ok({ SDLC_X: 1 }), false);
    assert.equal(ok([]), false);
    assert.equal(ok({ SDLC_X: 'y'.repeat(6001) }), false);
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`SDLC_V${i}`, 'x']));
    assert.equal(ok(many), false);
  });
  it('counts the size in UTF-8 bytes, not characters', () => {
    assert.ok(ok({ SDLC_X: 'y'.repeat(5990) }));
    assert.equal(ok({ SDLC_X: '\u20ac'.repeat(2000) }), false); // 2,000 characters, 6,000 bytes
    assert.ok(ok({ SDLC_X: '\u20ac'.repeat(1990) }));
  });
});
