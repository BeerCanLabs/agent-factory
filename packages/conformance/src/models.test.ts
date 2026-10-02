// DESIGN_AUTHORITY.md §6.9 M3: Model offering as factory data.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { files, read } from './support.js';

describe('M3 model offering as factory data', () => {
  it('no landing zone declares variable "model_catalog"', () => {
    const offenders: string[] = [];
    for (const f of files('landing-zones', (p) => p.endsWith('.tf'))) {
      const text = read(f);
      if (/variable\s+"model_catalog"/i.test(text)) {
        offenders.push(`${f}: contains variable "model_catalog"`);
      }
    }
    assert.deepEqual(offenders, [], 'landing zones must not declare variable "model_catalog"');
  });

  it('no landing zone sets FACTORY_MODEL_CATALOG in ECS task definitions', () => {
    const offenders: string[] = [];
    for (const f of files('landing-zones', (p) => p.endsWith('.tf'))) {
      const text = read(f);
      if (/\bFACTORY_MODEL_CATALOG\b/.test(text)) {
        offenders.push(`${f}: sets FACTORY_MODEL_CATALOG`);
      }
    }
    assert.deepEqual(offenders, [], 'landing zones must not set FACTORY_MODEL_CATALOG');
  });

  it('landing zones provide only cloud permissions (Bedrock IAM)', () => {
    const iam = read('landing-zones/aws/iam.tf');
    assert.ok(/bedrock:InvokeModel/i.test(iam), 'AWS landing zone retains cloud permissions for Bedrock');
  });

  it('baseline model offerings are defined in control plane factory data', () => {
    const modelsSrc = read('packages/control-plane/src/models.ts');
    assert.ok(modelsSrc.includes('BASELINE_MODELS'), 'control plane defines BASELINE_MODELS');
    assert.ok(modelsSrc.includes("'claude-sonnet-4-5'"), 'baseline models must include claude-sonnet-4-5');
    assert.ok(modelsSrc.includes("'claude-haiku-4-5'"), 'baseline models must include claude-haiku-4-5');
    assert.ok(modelsSrc.includes('isDefault: true'), 'baseline models must include a default model');
  });

  it('gatekeeper-egress dynamically resolves model catalog from control plane', () => {
    const egressSrc = read('packages/gatekeeper-egress/src/gatekeeper-egress.ts');
    assert.ok(egressSrc.includes('ensureModels'), 'gatekeeper-egress must dynamically ensure models');
    assert.ok(egressSrc.includes('control.models'), 'gatekeeper-egress must query control.models');
  });
});
