// DESIGN_AUTHORITY.md §6.9 (M1–M4): Model selection, execution, catalog, and provider enforcement.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChatRequest,
  toConverse,
  selectModel,
  failbackCandidates,
  checkModel,
  parseModelCatalog,
  findModel,
  type ModelPolicy,
  type ModelCatalog,
} from '@beercanlabs/factory-executive';
import {
  applyModelsRemoval,
  validatePolicy,
  effectiveAgentModels,
} from '@beercanlabs/factory-gatekeeper/policy';

describe('M1: OpenAI-compatible factory model API', () => {
  it('M1 parses standard OpenAI chat completions request with valid roles and messages', () => {
    const parsed = parseChatRequest({
      messages: [
        { role: 'system', content: 'You are Donna.' },
        { role: 'user', content: 'Hello' },
      ],
      model: 'claude-sonnet-4-5',
      temperature: 0.2,
      max_tokens: 256,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: { type: 'object', properties: { location: { type: 'string' } } },
          },
        },
      ],
    });

    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      const req = parsed.req;
      assert.equal(req.messages.length, 2);
      assert.equal(req.messages[0].role, 'system');
      assert.equal(req.messages[0].content, 'You are Donna.');
      assert.equal(req.messages[1].role, 'user');
      assert.equal(req.messages[1].content, 'Hello');
      assert.equal(req.temperature, 0.2);
      assert.equal(req.maxTokens, 256);
      assert.equal(req.tools?.length, 1);
    }
  });

  it('M1 rejects malformed requests: missing messages, unsupported roles, or unsupported content', () => {
    assert.deepEqual(parseChatRequest({}), {
      ok: false,
      error: 'messages_required',
    });

    assert.deepEqual(
      parseChatRequest({
        messages: [{ role: 'unknown_role', content: 'hi' }],
      }),
      {
        ok: false,
        error: 'unsupported_role',
      },
    );

    assert.deepEqual(
      parseChatRequest({
        messages: [{ role: 'user', content: 12345 }],
      }),
      {
        ok: false,
        error: 'unsupported_content',
      },
    );
  });

  it('M1 translates OpenAI format to provider Converse format without leaking run tokens', () => {
    const converse = toConverse({
      messages: [
        { role: 'system', content: 'System instruction' },
        { role: 'user', content: 'User query' },
        { role: 'assistant', content: 'Assistant reply' },
      ],
      maxTokens: 500,
      temperature: 0.5,
    });

    assert.deepEqual(converse.system, [{ text: 'System instruction' }]);
    assert.equal(converse.messages.length, 2);
    assert.equal(converse.messages[0].role, 'user');
    assert.deepEqual(converse.messages[0].content, [{ text: 'User query' }]);
    assert.equal(converse.messages[1].role, 'assistant');
    assert.deepEqual(converse.messages[1].content, [{ text: 'Assistant reply' }]);
    assert.deepEqual(converse.inferenceConfig, { maxTokens: 500, temperature: 0.5 });
  });
});

describe('M2: Model policy, failback selection, and retirement transitions', () => {
  it('M2 two-tier authority: agents never choose models; selectModel serves currentModel (or primaryModel/defaultModel)', () => {
    const policy: ModelPolicy = {
      allowedModels: ['model-primary', 'model-secondary'],
      currentModel: 'model-primary',
      primaryModel: 'model-primary',
      secondaryModel: 'model-secondary',
    };

    // In normal execution, agent requesting another model is ignored: currentModel is served
    const selNormal = selectModel(policy, 'model-secondary');
    assert.equal(selNormal.ok, true);
    if (selNormal.ok) {
      assert.equal(selNormal.model, 'model-primary');
      assert.equal(selNormal.requested, 'model-secondary');
    }

    // In training mode, requested model is honored
    const selTraining = selectModel({ ...policy, training: true }, 'model-secondary');
    assert.equal(selTraining.ok, true);
    if (selTraining.ok) {
      assert.equal(selTraining.model, 'model-secondary');
    }

    // Pinned model wins
    const selPinned = selectModel({ ...policy, pinnedModel: 'model-secondary' }, 'model-primary');
    assert.equal(selPinned.ok, true);
    if (selPinned.ok) {
      assert.equal(selPinned.model, 'model-secondary');
    }

    // Pinned model not in allowedModels fails
    const selBadPin = selectModel({ ...policy, pinnedModel: 'unapproved-pin' });
    assert.equal(selBadPin.ok, false);
    if (!selBadPin.ok) {
      assert.equal(selBadPin.status, 403);
      assert.equal(selBadPin.code, 'model_not_allowed');
    }

    // Legacy policy: primaryModel and currentModel undefined defaults to allowedModels[0]
    const legacyPolicy: ModelPolicy = {
      allowedModels: ['model-alpha', 'model-beta'],
    };
    const selLegacy = selectModel(legacyPolicy);
    assert.equal(selLegacy.ok, true);
    if (selLegacy.ok) {
      assert.equal(selLegacy.model, 'model-alpha');
    }

    // Empty allowedModels grants none
    const emptyPolicy: ModelPolicy = {
      allowedModels: [],
      defaultModel: 'model-fallback',
    };
    const selEmpty = selectModel(emptyPolicy);
    assert.equal(selEmpty.ok, false);
    if (!selEmpty.ok) {
      assert.equal(selEmpty.status, 403);
      assert.equal(selEmpty.code, 'model_not_allowed');
    }

    // currentModel and primaryModel set to null (unselected state) returns 403
    const unselectedPolicy: ModelPolicy = {
      allowedModels: ['model-alpha'],
      currentModel: null,
      primaryModel: null,
    };
    const selUnselected = selectModel(unselectedPolicy);
    assert.equal(selUnselected.ok, false);
    if (!selUnselected.ok) {
      assert.equal(selUnselected.status, 403);
      assert.equal(selUnselected.code, 'model_not_allowed');
    }
  });

  it('M2 failbackCandidates enforces unique([current, primary, secondary]) with zero loops', () => {
    // Standard 2-model policy
    const policy2: ModelPolicy = {
      allowedModels: ['m1', 'm2'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    assert.deepEqual(failbackCandidates(policy2), ['m1', 'm2']);

    // 3 distinct models with current at m3
    const policy3: ModelPolicy = {
      allowedModels: ['m1', 'm2', 'm3'],
      currentModel: 'm3',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    assert.deepEqual(failbackCandidates(policy3), ['m3', 'm1', 'm2']);

    // Starting at secondary: [m2, m1] (stops after primary, zero loops)
    const policyAtSecondary: ModelPolicy = {
      allowedModels: ['m1', 'm2'],
      currentModel: 'm2',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    assert.deepEqual(failbackCandidates(policyAtSecondary), ['m2', 'm1']);

    // Unset secondary: [m1]
    const policyNoSecondary: ModelPolicy = {
      allowedModels: ['m1', 'm2'],
      currentModel: 'm1',
      primaryModel: 'm1',
    };
    assert.deepEqual(failbackCandidates(policyNoSecondary), ['m1']);

    // Pinned model yields only the pinned model
    const policyPinned: ModelPolicy = {
      allowedModels: ['m1', 'm2'],
      pinnedModel: 'm1',
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    assert.deepEqual(failbackCandidates(policyPinned), ['m1']);
  });

  it('M2 applyModelsRemoval enforces all 5 retirement/unapproval transitions', () => {
    // Case 1: currentModel !== primaryModel retired -> current becomes primary, primary and secondary unchanged
    const p1 = applyModelsRemoval(
      {
        models: ['m1', 'm2', 'm3'],
        currentModel: 'm3',
        primaryModel: 'm1',
        secondaryModel: 'm2',
      },
      ['m3'],
    );
    assert.deepEqual(p1.models, ['m1', 'm2']);
    assert.equal(p1.currentModel, 'm1');
    assert.equal(p1.primaryModel, 'm1');
    assert.equal(p1.secondaryModel, 'm2');

    // Case 2: primaryModel !== currentModel retired -> primary becomes current (clearing secondary if secondary === current)
    const p2a = applyModelsRemoval(
      {
        models: ['m1', 'm2', 'm3'],
        currentModel: 'm3',
        primaryModel: 'm1',
        secondaryModel: 'm2',
      },
      ['m1'],
    );
    assert.deepEqual(p2a.models, ['m2', 'm3']);
    assert.equal(p2a.currentModel, 'm3');
    assert.equal(p2a.primaryModel, 'm3');
    assert.equal(p2a.secondaryModel, 'm2');

    // Case 2 with secondary === current: secondary is cleared
    const p2b = applyModelsRemoval(
      {
        models: ['m1', 'm2'],
        currentModel: 'm2',
        primaryModel: 'm1',
        secondaryModel: 'm2',
      },
      ['m1'],
    );
    assert.deepEqual(p2b.models, ['m2']);
    assert.equal(p2b.currentModel, 'm2');
    assert.equal(p2b.primaryModel, 'm2');
    assert.equal(p2b.secondaryModel, undefined);

    // Case 3a: currentModel === primaryModel retired with secondary set -> promotes secondary to both, unsets secondary
    const p3a = applyModelsRemoval(
      {
        models: ['m1', 'm2'],
        currentModel: 'm1',
        primaryModel: 'm1',
        secondaryModel: 'm2',
      },
      ['m1'],
    );
    assert.deepEqual(p3a.models, ['m2']);
    assert.equal(p3a.currentModel, 'm2');
    assert.equal(p3a.primaryModel, 'm2');
    assert.equal(p3a.secondaryModel, undefined);

    // Case 3b: currentModel === primaryModel retired with secondary unset -> leaves both null
    const p3b = applyModelsRemoval(
      {
        models: ['m1', 'm2'],
        currentModel: 'm1',
        primaryModel: 'm1',
      },
      ['m1'],
    );
    assert.deepEqual(p3b.models, ['m2']);
    assert.equal(p3b.currentModel, null);
    assert.equal(p3b.primaryModel, null);
    assert.equal(p3b.secondaryModel, undefined);

    // Case 3c: All models retired -> deletes models entirely (reverts to factory default)
    const p3c = applyModelsRemoval(
      {
        models: ['m1'],
        currentModel: 'm1',
        primaryModel: 'm1',
      },
      ['m1'],
    );
    assert.equal(p3c.models, undefined);
    assert.equal(p3c.currentModel, undefined);
    assert.equal(p3c.primaryModel, undefined);
    assert.equal(p3c.secondaryModel, undefined);

    // Case 4: secondaryModel retired -> secondary becomes unset, current and primary unchanged
    const p4 = applyModelsRemoval(
      {
        models: ['m1', 'm2'],
        currentModel: 'm1',
        primaryModel: 'm1',
        secondaryModel: 'm2',
      },
      ['m2'],
    );
    assert.deepEqual(p4.models, ['m1']);
    assert.equal(p4.currentModel, 'm1');
    assert.equal(p4.primaryModel, 'm1');
    assert.equal(p4.secondaryModel, undefined);
  });

  it('M2 policy validation rejects invalid model slot combinations', () => {
    // Valid configuration passes
    const valid = validatePolicy({
      models: ['m1', 'm2'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    });
    assert.equal(valid.ok, true);

    // Rejects secondaryModel equal to primaryModel
    const dup = validatePolicy({
      models: ['m1', 'm2'],
      primaryModel: 'm1',
      secondaryModel: 'm1',
    });
    assert.equal(dup.ok, false);

    // Rejects secondaryModel not in models
    const badSec = validatePolicy({
      models: ['m1'],
      secondaryModel: 'm2',
    });
    assert.equal(badSec.ok, false);

    // Rejects currentModel not in models
    const badCur = validatePolicy({
      models: ['m1'],
      currentModel: 'm2',
    });
    assert.equal(badCur.ok, false);

    // Accepts current and primary both null
    const bothNull = validatePolicy({
      models: ['m1'],
      currentModel: null,
      primaryModel: null,
    });
    assert.equal(bothNull.ok, true);

    // Rejects one null and the other non-null
    const oneNull = validatePolicy({
      models: ['m1'],
      currentModel: null,
      primaryModel: 'm1',
    });
    assert.equal(oneNull.ok, false);

    // Rejects secondary set when current/primary are null
    const secWithNull = validatePolicy({
      models: ['m1', 'm2'],
      currentModel: null,
      primaryModel: null,
      secondaryModel: 'm2',
    });
    assert.equal(secWithNull.ok, false);
  });
});

describe('M3: Model catalog operations and neutral naming', () => {
  const catalogJson = JSON.stringify({
    'claude-sonnet-4-5': {
      provider: 'bedrock-converse',
      id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      region: 'us-east-1',
      price: { inputPerMTok: 3, outputPerMTok: 15 },
    },
    'gpt-4o': {
      provider: 'openai',
      id: 'gpt-4o-2024-08-06',
      price: { inputPerMTok: 2.5, outputPerMTok: 10 },
    },
    'unpriced-model': {
      provider: 'vertex',
      id: 'gemini-2.0-flash',
    },
  });

  it('M3 maps catalog neutral names to provider adapters, provider IDs, and prices', () => {
    const catalog = parseModelCatalog(catalogJson);

    const sonnet = findModel(catalog, 'claude-sonnet-4-5');
    assert.ok(sonnet);
    assert.equal(sonnet.provider, 'bedrock-converse');
    assert.equal(sonnet.id, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    assert.equal(sonnet.region, 'us-east-1');
    assert.deepEqual(sonnet.price, { inputPerMTok: 3, outputPerMTok: 15 });

    const gpt = findModel(catalog, 'gpt-4o');
    assert.ok(gpt);
    assert.equal(gpt.provider, 'openai');
    assert.equal(gpt.id, 'gpt-4o-2024-08-06');
    assert.deepEqual(gpt.price, { inputPerMTok: 2.5, outputPerMTok: 10 });
  });

  it('M3 unoffered models fail closed (findModel returns undefined)', () => {
    const catalog = parseModelCatalog(catalogJson);
    const unoffered = findModel(catalog, 'non-existent-model');
    assert.equal(unoffered, undefined);
  });

  it('M3 unpriced models require pricing in catalog or explicit price table', () => {
    const catalog = parseModelCatalog(catalogJson);
    const unpriced = findModel(catalog, 'unpriced-model');
    assert.ok(unpriced);
    assert.equal(unpriced.price, undefined);
  });
});

describe('M4: Provider-native LLM route enforcement', () => {
  it('M4 checkModel enforces model allowlist on native routes', () => {
    const policy: ModelPolicy = {
      allowedModels: ['claude-sonnet-4-5'],
      defaultModel: 'claude-haiku-4-5',
    };

    // Allowed model in policy.models
    const check1 = checkModel(policy, 'claude-sonnet-4-5');
    assert.equal(check1.allowed, true);

    // Unallowed model outside policy.models
    const check2 = checkModel(policy, 'gpt-4o');
    assert.equal(check2.allowed, false);
    assert.equal(check2.code, 'model_not_allowed');

    // Policy with empty allowedModels grants none
    const emptyPolicy: ModelPolicy = {
      allowedModels: [],
      defaultModel: 'claude-haiku-4-5',
    };
    assert.equal(checkModel(emptyPolicy, 'claude-haiku-4-5').allowed, false);

    // Policy omitting allowedModels grants defaultModel
    const defaultPolicy: ModelPolicy = {
      defaultModel: 'claude-haiku-4-5',
    };
    assert.equal(checkModel(defaultPolicy, 'claude-haiku-4-5').allowed, true);
    assert.equal(checkModel(defaultPolicy, 'claude-sonnet-4-5').allowed, false);

    // Pinned model: only pinned model is allowed
    const pinnedPolicy: ModelPolicy = {
      allowedModels: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
      pinnedModel: 'claude-haiku-4-5',
    };
    assert.equal(checkModel(pinnedPolicy, 'claude-haiku-4-5').allowed, true);
    assert.equal(checkModel(pinnedPolicy, 'claude-sonnet-4-5').allowed, false);
    assert.equal(checkModel(pinnedPolicy, 'claude-sonnet-4-5').code, 'model_pinned');
  });

  it('M4 checkModel in training mode allows any model in the catalog', () => {
    const trainingPolicy: ModelPolicy = {
      allowedModels: ['claude-sonnet-4-5'],
      training: true,
    };
    assert.equal(checkModel(trainingPolicy, 'gpt-4o').allowed, true);
  });
});
