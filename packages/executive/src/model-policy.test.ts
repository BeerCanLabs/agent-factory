import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkModel, offeredModels, selectModel, type ModelPolicy } from './model-policy.js';

const DEFAULT = 'claude-haiku-4-5';
const policy = (over: Partial<ModelPolicy> = {}): ModelPolicy => ({ defaultModel: DEFAULT, training: false, ...over });

describe('checkModel: the allow-list', () => {
  it('allows a model the policy lists', () => {
    assert.deepEqual(checkModel(policy({ allowedModels: ['claude-sonnet-4-6', DEFAULT] }), 'claude-sonnet-4-6'), { allowed: true });
  });

  it('refuses a model the policy does not list, naming it', () => {
    assert.deepEqual(checkModel(policy({ allowedModels: ['claude-sonnet-4-6'] }), 'claude-sonnet-4-5'), {
      allowed: false,
      status: 403,
      code: 'model_not_allowed',
      detail: { model: 'claude-sonnet-4-5' },
    });
  });

  it('grants exactly the factory default when the policy names no models (M2), never every model', () => {
    assert.deepEqual(checkModel(policy(), DEFAULT), { allowed: true });
    assert.equal(checkModel(policy(), 'claude-sonnet-4-6').allowed, false);
  });

  it('uses the default the factory is configured with, not a built-in one', () => {
    const p = policy({ defaultModel: 'claude-sonnet-4-6' });
    assert.deepEqual(checkModel(p, 'claude-sonnet-4-6'), { allowed: true });
    assert.equal(checkModel(p, DEFAULT).allowed, false);
  });

  it('treats an explicit empty list as granting nothing, not as "names none"', () => {
    assert.equal(checkModel(policy({ allowedModels: [] }), DEFAULT).allowed, false);
  });
});

describe('checkModel: training', () => {
  it('does not apply the allow-list to an agent in training', () => {
    assert.deepEqual(checkModel(policy({ allowedModels: ['claude-sonnet-4-6'], training: true }), 'anything-at-all'), { allowed: true });
    assert.deepEqual(checkModel(policy({ training: true }), 'anything-at-all'), { allowed: true });
  });

  it('still applies a pin to an agent in training', () => {
    const r = checkModel(policy({ training: true, pinnedModel: 'claude-sonnet-4-6' }), 'claude-haiku-4-5');
    assert.deepEqual(r, { allowed: false, status: 403, code: 'model_pinned', detail: { model: 'claude-haiku-4-5', pinned: 'claude-sonnet-4-6' } });
  });
});

describe('checkModel: a pinned run', () => {
  const pinned = policy({ allowedModels: ['claude-sonnet-4-6', DEFAULT], pinnedModel: 'claude-sonnet-4-6' });

  it('allows the pinned model', () => {
    assert.deepEqual(checkModel(pinned, 'claude-sonnet-4-6'), { allowed: true });
  });

  it('refuses another allowed model as pinned, naming both', () => {
    assert.deepEqual(checkModel(pinned, DEFAULT), { allowed: false, status: 403, code: 'model_pinned', detail: { model: DEFAULT, pinned: 'claude-sonnet-4-6' } });
  });

  it('reports a model that is both unlisted and not the pinned one as not allowed (the list is checked first)', () => {
    const r = checkModel(pinned, 'something-else');
    assert.equal(r.allowed === false && r.code, 'model_not_allowed');
  });

  it('treats an empty pin as no pin', () => {
    assert.deepEqual(checkModel(policy({ allowedModels: [DEFAULT], pinnedModel: '' }), DEFAULT), { allowed: true });
  });
});

describe('offeredModels', () => {
  const catalog = ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-6'];

  it('lists the offered models the policy allows, in the catalog order', () => {
    assert.deepEqual(offeredModels(policy({ allowedModels: ['claude-sonnet-4-6', 'claude-haiku-4-5'] }), catalog), ['claude-haiku-4-5', 'claude-sonnet-4-6']);
  });

  it('lists only the default for a policy that names no models', () => {
    assert.deepEqual(offeredModels(policy(), catalog), [DEFAULT]);
  });

  it('lists every offered model for an agent in training', () => {
    assert.deepEqual(offeredModels(policy({ allowedModels: [], training: true }), catalog), catalog);
  });

  it('lists only the pinned model for a pinned run', () => {
    assert.deepEqual(offeredModels(policy({ allowedModels: catalog, pinnedModel: 'claude-sonnet-4-5' }), catalog), ['claude-sonnet-4-5']);
  });

  it('lists nothing from an empty catalog, and accepts any iterable', () => {
    assert.deepEqual(offeredModels(policy(), []), []);
    assert.deepEqual(offeredModels(policy({ allowedModels: [DEFAULT] }), new Set(catalog)), [DEFAULT]);
  });
});

describe('selectModel: agents never choose (M2, GAP-181)', () => {
  const base: ModelPolicy = { allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'], defaultModel: 'claude-opus-5-5', training: false };

  it('serves the policy first model whatever the agent asks for, and reports a differing request', () => {
    assert.deepEqual(selectModel(base, 'claude-sonnet-5-5'), { ok: true, model: 'claude-haiku-5-5', requested: 'claude-sonnet-5-5' });
    assert.deepEqual(selectModel(base, 'claude-haiku-5-5'), { ok: true, model: 'claude-haiku-5-5' });
    assert.deepEqual(selectModel(base), { ok: true, model: 'claude-haiku-5-5' });
  });

  it('a run pin wins; training honors the request; a policy with no models gets the configured default', () => {
    assert.deepEqual(selectModel({ ...base, pinnedModel: 'test-big' }, 'claude-haiku-5-5'), { ok: true, model: 'test-big', requested: 'claude-haiku-5-5' });
    assert.deepEqual(selectModel({ ...base, training: true }, 'claude-sonnet-5-5'), { ok: true, model: 'claude-sonnet-5-5' });
    assert.deepEqual(selectModel({ defaultModel: 'claude-opus-5-5', training: false }, 'x'), { ok: true, model: 'claude-opus-5-5', requested: 'x' });
  });

  it('with no models and no default configured, refuses with no_default_model', () => {
    assert.deepEqual(selectModel({ training: false }, 'claude-haiku-5-5'), { ok: false, status: 503, code: 'no_default_model' });
    assert.deepEqual(checkModel({ training: false }, 'claude-haiku-5-5'), { allowed: false, status: 403, code: 'model_not_allowed', detail: { model: 'claude-haiku-5-5' } });
  });
});
