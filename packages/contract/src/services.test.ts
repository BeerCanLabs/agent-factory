import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACTORY_SERVICE_NAMES,
  FACTORY_SERVICES,
  factoryServiceNameSchema,
  hydrationRequestSchema,
  hydrationResultSchema,
  preflightCheckRequestSchema,
  preflightCheckResultSchema,
  budgetCheckRequestSchema,
  budgetCheckResultSchema,
  spendReportSchema,
  heldActionRequestSchema,
  heldActionReleaseSchema,
  progressEventSchema,
  modelInferenceRequestSchema,
} from './index.js';

describe('Factory Services (The Cast)', () => {
  it('defines exactly the 11 canonical services from DESIGN_AUTHORITY.md §6.15', () => {
    assert.equal(FACTORY_SERVICE_NAMES.length, 11);
    const expected = [
      'gatekeeper',
      'keymaster',
      'tinman',
      'secretary',
      'landlord',
      'auditor',
      'treasurer',
      'bouncer',
      'timekeeper',
      'registrar',
      'seer',
    ];
    assert.deepEqual([...FACTORY_SERVICE_NAMES].sort(), expected.sort());
  });

  it('validates service names via schema', () => {
    for (const name of FACTORY_SERVICE_NAMES) {
      assert.equal(factoryServiceNameSchema.parse(name), name);
    }
    assert.throws(() => factoryServiceNameSchema.parse('unregistered_service'));
  });

  it('provides metadata for every service', () => {
    for (const name of FACTORY_SERVICE_NAMES) {
      const meta = FACTORY_SERVICES[name];
      assert.ok(meta, `missing metadata for ${name}`);
      assert.equal(meta.name, name);
      assert.ok(meta.title.length > 0);
      assert.ok(meta.role.length > 0);
      assert.ok(meta.primaryPackage.startsWith('packages/'));
    }
  });
});

describe('Cross-Service Contracts', () => {
  it('validates HydrationContract (Landlord <-> Secretary)', () => {
    const valid = hydrationRequestSchema.parse({
      agentId: 'donna',
      runId: 'run-123',
      memoryStoreUri: 's3://my-mind-bucket/donna',
      localMemoryDir: '/tmp/memory',
      mode: 'pull',
    });
    assert.equal(valid.agentId, 'donna');

    const result = hydrationResultSchema.parse({
      success: true,
      agentId: 'donna',
      runId: 'run-123',
      bytesTransferred: 4096,
    });
    assert.equal(result.success, true);
  });

  it('validates KeymasterContract (Landlord <-> Keymaster)', () => {
    const req = preflightCheckRequestSchema.parse({
      agentId: 'finley',
      declaredSecrets: ['NOTION_API_KEY'],
      declaredConnections: [{ provider: 'google', scopes: ['gmail.readonly'] }],
    });
    assert.equal(req.agentId, 'finley');

    const res = preflightCheckResultSchema.parse({
      satisfied: true,
      missingSecrets: [],
      missingConnections: [],
      needsReconsent: [],
    });
    assert.equal(res.satisfied, true);
  });

  it('validates SpendMeteringContract (Tinman <-> Treasurer)', () => {
    const check = budgetCheckRequestSchema.parse({
      agentId: 'castle',
      estimatedTokens: 1000,
    });
    assert.equal(check.agentId, 'castle');

    const res = budgetCheckResultSchema.parse({
      allowed: true,
      circuitBroken: false,
      remainingDailyBudgetUsd: 25.5,
    });
    assert.equal(res.allowed, true);

    const report = spendReportSchema.parse({
      agentId: 'castle',
      runId: 'run-789',
      model: 'claude-sonnet-4-6',
      provider: 'bedrock',
      inputTokens: 500,
      outputTokens: 250,
      costUsd: 0.0052,
      durationMs: 820,
    });
    assert.equal(report.costUsd, 0.0052);
  });

  it('validates ActionHoldContract (Gatekeeper <-> Bouncer)', () => {
    const hold = heldActionRequestSchema.parse({
      approvalId: 'appr-001',
      agentId: 'castle',
      runId: 'run-555',
      system: 'linkedin',
      method: 'POST',
      path: '/v2/ugcPosts',
      bodySha256: 'a'.repeat(64),
      previewKind: 'linkedin_post',
    });
    assert.equal(hold.system, 'linkedin');

    const release = heldActionReleaseSchema.parse({
      approvalId: 'appr-001',
      decision: 'approved',
      decidedBy: 'dale@beercanlabs.com',
      decidedAt: new Date().toISOString(),
    });
    assert.equal(release.decision, 'approved');
  });

  it('validates ProgressEventContract (Seer Telemetry)', () => {
    const event = progressEventSchema.parse({
      agentId: 'donna',
      runId: 'run-123',
      timestamp: new Date().toISOString(),
      step: 'model_call',
      status: 'running',
      callMeta: {
        route: 'models',
        model: 'claude-haiku-4-5',
        durationMs: 450,
      },
    });
    assert.equal(event.step, 'model_call');
  });

  it('validates ModelInferenceContract (Tinman)', () => {
    const inference = modelInferenceRequestSchema.parse({
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'You are an agent.' },
        { role: 'user', content: 'Hello!' },
      ],
      temperature: 0.7,
      max_tokens: 1024,
    });
    assert.equal(inference.model, 'claude-haiku-4-5');
    assert.equal(inference.messages.length, 2);
  });
});
