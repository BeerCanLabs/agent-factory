import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelStore } from './models.js';

describe('ModelStore', () => {
  it('bootstraps from seed when storage file does not exist', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'modelstore-test-'));
    const file = join(tmp, 'catalog.json');
    try {
      const seed = {
        'claude-haiku-4-5': {
          provider: 'bedrockConverse',
          id: 'us.anthropic.claude-haiku-4-5',
          price: { inputPerMTok: 0.8, outputPerMTok: 4.0 },
        },
      };

      const store = new ModelStore(file, seed);
      const offered = store.listOffered();
      assert.equal(offered.length, 1);
      assert.equal(offered[0].name, 'claude-haiku-4-5');
      assert.equal(offered[0].provider, 'bedrockConverse');
      assert.deepEqual(offered[0].price, { inputPerMTok: 0.8, outputPerMTok: 4.0 });

      // Re-load from same file without seed
      const reloaded = new ModelStore(file);
      assert.equal(reloaded.listOffered().length, 1);
      assert.equal(reloaded.getOffered('claude-haiku-4-5')?.provider, 'bedrockConverse');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('stages discovered models, admits, updates pricing and retires', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'modelstore-test-'));
    const file = join(tmp, 'catalog.json');
    try {
      const store = new ModelStore(file);
      assert.equal(store.listOffered().length, 0);

      // Stage discovered
      store.stageDiscovered([
        {
          vendorId: 'openai',
          rawId: 'gpt-4o-2024-08-06',
          displayName: 'GPT-4o',
          discoveredAt: new Date().toISOString(),
          suggestedFriendlyName: 'gpt-4o',
          suggestedPrice: { inputPerMTok: 2.5, outputPerMTok: 10.0 },
        },
      ]);
      assert.equal(store.listStaged().length, 1);

      // Admit
      const admitted = store.admit({
        name: 'gpt-4o',
        provider: 'openAiCompatible',
        id: 'gpt-4o-2024-08-06',
        vendorId: 'openai',
        price: { inputPerMTok: 2.5, outputPerMTok: 10.0 },
        actor: 'dale@example.com',
      });
      assert.equal(admitted.name, 'gpt-4o');
      assert.equal(store.listOffered().length, 1);
      assert.equal(store.listStaged().length, 0); // Removed from staged on admit

      // Update pricing
      store.updatePricing('gpt-4o', { inputPerMTok: 2.0, outputPerMTok: 8.0 }, 'accountant@example.com');
      const updated = store.getOffered('gpt-4o');
      assert.deepEqual(updated?.price, { inputPerMTok: 2.0, outputPerMTok: 8.0 });
      assert.equal(updated?.updatedBy, 'accountant@example.com');

      // Convert to egress catalog
      const egressCatalog = store.toEgressCatalog();
      assert.deepEqual(egressCatalog['gpt-4o'], {
        provider: 'openAiCompatible',
        id: 'gpt-4o-2024-08-06',
        price: { inputPerMTok: 2.0, outputPerMTok: 8.0 },
      });

      // Retire
      const retired = store.retire('gpt-4o');
      assert.equal(retired, true);
      assert.equal(store.listOffered().length, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('disambiguates friendly-name collisions using raw id', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'modelstore-test-'));
    const file = join(tmp, 'catalog.json');
    try {
      const store = new ModelStore(file);
      // Admit first gpt-4o
      const m1 = store.admit({
        name: 'gpt-4o',
        provider: 'openai',
        id: 'gpt-4o',
      });
      assert.equal(m1.name, 'gpt-4o');

      // Admit second model with same friendly name but different id (e.g. gpt-4o-2024-08-06)
      const m2 = store.admit({
        name: 'gpt-4o',
        provider: 'openai',
        id: 'gpt-4o-2024-08-06',
        endpoint: 'https://custom.endpoint.com',
      });
      // Should disambiguate using raw id
      assert.equal(m2.name, 'gpt-4o-2024-08-06');
      assert.equal(m2.endpoint, 'https://custom.endpoint.com');

      assert.equal(store.listOffered().length, 2);
      assert.ok(store.getOffered('gpt-4o'));
      assert.ok(store.getOffered('gpt-4o-2024-08-06'));

      const egress = store.toEgressCatalog();
      assert.equal(egress['gpt-4o-2024-08-06'].endpoint, 'https://custom.endpoint.com');

      // Reject if both friendly name and raw id are already in use
      assert.throws(
        () =>
          store.admit({
            name: 'gpt-4o',
            provider: 'other-provider',
            id: 'gpt-4o-2024-08-06',
          }),
        /collides with existing model/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
