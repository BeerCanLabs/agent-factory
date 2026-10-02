import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateModelProposal,
  validateModelDefinition,
  type ModelProposal,
  type ModelDefinition,
} from './model.js';

describe('model schemas (§6.9 M3)', () => {
  it('validates a correct model proposal', () => {
    const proposal: ModelProposal = {
      name: 'claude-sonnet-4-5',
      provider: 'bedrock-converse',
      id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      region: 'us-east-1',
      price: {
        inputPerMTok: 3,
        outputPerMTok: 15,
      },
      description: 'Claude 3.7 Sonnet via Bedrock',
      isDefault: false,
    };
    const res = validateModelProposal(proposal);
    assert.equal(res.ok, true);
  });

  it('rejects invalid model names or negative prices', () => {
    const badName = {
      name: 'Claude Sonnet!',
      provider: 'bedrock-converse',
      id: 'sonnet',
      price: { inputPerMTok: 3, outputPerMTok: 15 },
    };
    const res1 = validateModelProposal(badName);
    assert.equal(res1.ok, false);
    assert.match(res1.error, /model name must be lowercase kebab-case/);

    const negPrice = {
      name: 'claude-sonnet-4-5',
      provider: 'bedrock-converse',
      id: 'sonnet',
      price: { inputPerMTok: -1, outputPerMTok: 15 },
    };
    const res2 = validateModelProposal(negPrice);
    assert.equal(res2.ok, false);
    assert.match(res2.error, /inputPerMTok must be >= 0/);
  });

  it('validates a complete model definition', () => {
    const def: ModelDefinition = {
      name: 'claude-haiku-4-5',
      provider: 'bedrock-converse',
      id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      region: 'us-east-1',
      price: {
        inputPerMTok: 1,
        outputPerMTok: 5,
      },
      isDefault: true,
      version: 1,
      status: 'approved',
      proposedBy: 'admin@beercanlabs.com',
      proposedAt: '2026-10-02T10:00:00.000Z',
      decidedBy: 'dale@beercanlabs.com',
      decidedAt: '2026-10-02T10:05:00.000Z',
      hash: 'abc123def456',
    };
    const res = validateModelDefinition(def);
    assert.equal(res.ok, true);
  });

  it('rejects incomplete model definition', () => {
    const incomplete = {
      name: 'claude-haiku-4-5',
      provider: 'bedrock-converse',
      id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      price: { inputPerMTok: 1, outputPerMTok: 5 },
      status: 'approved',
      // missing version, proposedBy, proposedAt, hash
    };
    const res = validateModelDefinition(incomplete);
    assert.equal(res.ok, false);
    assert.match(res.error, /version|proposedBy|proposedAt|hash/);
  });
});
