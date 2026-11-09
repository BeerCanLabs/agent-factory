import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../api/client.js';
import type { SubscriptionConnectionView, SubscriptionSpendReport } from '../api/types.js';
import type { Whoami } from '../auth/access-gate.js';
import {
  allowsManualModelEntry,
  attestationCopyForScope,
  canDisconnectConnection,
  canManageConnectionModels,
  canMutateConnection,
  connectionSpendSummary,
  DEFAULT_NOT_OFFERED_VENDORS,
  defaultSubscriptionTabFor,
  discoveryStatusBanner,
  filterConnectionsForTab,
  formatSubscriptionApiError,
  resolveNotOfferedVendors,
  subscriptionTabsFor,
  suggestSubscriptionCatalogName,
  validateConnectInput,
  validateDailyTokenCapInput,
  validateSubscriptionModelForm,
} from './subscriptions-model.js';

const ownerWhoami: Whoami = {
  actor: 'user:alice',
  principal: 'user:alice',
  roles: ['viewer'],
  privileges: { fleet: ['subscriptions.own', 'models.read'] },
};

const adminWhoami: Whoami = {
  actor: 'user:admin',
  principal: 'user:admin',
  roles: ['admin'],
  privileges: {
    fleet: ['subscriptions.own', 'subscriptions.read', 'subscriptions.manage', 'models.manage', 'models.read'],
  },
};

const factoryConn: SubscriptionConnectionView = {
  id: 'sub_factory_1',
  templateId: 'openai-subscription',
  vendor: 'openai',
  scope: 'factory',
  name: "Ops's ChatGPT Subscription",
  status: 'active',
  subscriberEmail: 'ops@example.com',
  tier: 'pro',
  subscriberAttested: true,
  connectedBy: 'user:admin',
  connectedAt: '2026-11-08T00:00:00Z',
  discoveredModels: [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex' }],
  discovery: {
    listAvailable: true,
    checkedAt: '2026-11-08T00:01:00Z',
    status: 'ok',
  },
};

const aliceConn: SubscriptionConnectionView = {
  id: 'sub_alice_1',
  templateId: 'xai-subscription',
  vendor: 'xai',
  scope: 'personal',
  ownerPrincipalId: 'user:alice',
  name: "Alice's Grok Subscription",
  status: 'needs_reconsent',
  subscriberEmail: 'alice@example.com',
  tier: 'unknown',
  subscriberAttested: true,
  connectedBy: 'user:alice',
  connectedAt: '2026-11-08T00:00:00Z',
  discovery: {
    listAvailable: false,
    reason: 'no_model_list',
    checkedAt: '2026-11-08T00:02:00Z',
    status: 'ok',
  },
};

const bobConn: SubscriptionConnectionView = {
  ...aliceConn,
  id: 'sub_bob_1',
  ownerPrincipalId: 'user:bob',
  name: "Bob's Grok Subscription",
};

describe('subscriptions-model: tabs, scoping & permissions (TSK-329)', () => {
  it('offers My Subscriptions only to non-admin owners, and Factory + Audit tabs to admins', () => {
    assert.deepEqual(
      subscriptionTabsFor(ownerWhoami).map((t) => t.id),
      ['personal'],
    );
    assert.equal(defaultSubscriptionTabFor(ownerWhoami), 'personal');

    assert.deepEqual(
      subscriptionTabsFor(adminWhoami).map((t) => t.id),
      ['personal', 'factory', 'fleet'],
    );
    assert.equal(defaultSubscriptionTabFor({ ...adminWhoami, onBehalfOf: 'user:alice' }), 'personal');
  });

  it('filters connections per tab and enforces strict per-owner mutation & admin incident disconnect', () => {
    const all = [factoryConn, aliceConn, bobConn];
    assert.deepEqual(
      filterConnectionsForTab(all, 'personal', ownerWhoami).map((c) => c.id),
      ['sub_alice_1'],
    );
    assert.deepEqual(
      filterConnectionsForTab(all, 'factory', adminWhoami).map((c) => c.id),
      ['sub_factory_1'],
    );
    assert.deepEqual(
      filterConnectionsForTab(all, 'fleet', adminWhoami).map((c) => c.id),
      ['sub_factory_1', 'sub_alice_1', 'sub_bob_1'],
    );

    // Owner mutates own personal connection, never factory or Bob's
    assert.equal(canMutateConnection(aliceConn, ownerWhoami), true);
    assert.equal(canManageConnectionModels(aliceConn, ownerWhoami), true);
    assert.equal(canMutateConnection(factoryConn, ownerWhoami), false);
    assert.equal(canMutateConnection(bobConn, ownerWhoami), false);
    assert.equal(canDisconnectConnection(bobConn, ownerWhoami), false);

    // Admin mutates factory connection; cannot mutate Alice's personal connection without Act-As, EXCEPT incident disconnect
    assert.equal(canMutateConnection(factoryConn, adminWhoami), true);
    assert.equal(canManageConnectionModels(factoryConn, adminWhoami), true);
    assert.equal(canMutateConnection(aliceConn, adminWhoami), false);
    assert.equal(canManageConnectionModels(aliceConn, adminWhoami), false);
    assert.equal(canDisconnectConnection(aliceConn, adminWhoami), true);

    // Admin with Act-As user:alice mutates Alice's connection
    const adminAsAlice: Whoami = { ...adminWhoami, onBehalfOf: 'user:alice' };
    assert.equal(canMutateConnection(aliceConn, adminAsAlice), true);
    assert.equal(canManageConnectionModels(aliceConn, adminAsAlice), true);
  });
});

describe('subscriptions-model: attestation, discovery, model admission, caps & errors (TSK-329)', () => {
  it('requires explicit subscriberAttested before connect and differentiates owner vs admin attestation copy', () => {
    assert.match(attestationCopyForScope('personal'), /my own personal vendor subscription/);
    assert.match(attestationCopyForScope('factory'), /shared factory use/);

    assert.equal(validateConnectInput({ templateId: 'xai-subscription', subscriberAttested: false }).ok, false);
    const valid = validateConnectInput({
      templateId: 'xai-subscription',
      subscriberAttested: true,
      name: '  Alice Grok  ',
    });
    assert.deepEqual(valid, {
      ok: true,
      templateId: 'xai-subscription',
      subscriberAttested: true,
      name: 'Alice Grok',
    });
  });

  it('allows manual modelId entry when discovery reports no_model_list / vendor_refused / failed, and locks to discovered list when available', () => {
    assert.equal(allowsManualModelEntry(factoryConn), false);
    assert.equal(allowsManualModelEntry(aliceConn), true);
    assert.equal(
      allowsManualModelEntry({
        ...aliceConn,
        discovery: { listAvailable: false, reason: 'vendor_refused', checkedAt: '2026-11-08T00:00:00Z', status: 'ok' },
      }),
      true,
    );
    assert.equal(
      allowsManualModelEntry({
        ...factoryConn,
        discovery: { listAvailable: true, checkedAt: '2026-11-08T00:00:00Z', status: 'failed', error: '502' },
      }),
      true,
    );

    assert.equal(discoveryStatusBanner(factoryConn).tone, 'ok');
    assert.match(discoveryStatusBanner(aliceConn).text, /no_model_list/);
  });

  it('enforces immutable $0 on personal BYOM models and explicit price (including $0) on factory models', () => {
    assert.equal(
      suggestSubscriptionCatalogName('grok-4.6', aliceConn),
      'grok-4.6-alice-s-grok',
    );

    // Personal BYOM always produces $0
    const personalRes = validateSubscriptionModelForm({
      scope: 'personal',
      name: 'grok-alice',
      modelId: 'grok-4.6',
      inputPrice: '',
      outputPrice: '',
      explicitZeroPrice: false,
    });
    assert.deepEqual(personalRes, {
      ok: true,
      name: 'grok-alice',
      modelId: 'grok-4.6',
      price: { inputPerMTok: 0, outputPerMTok: 0 },
    });

    // Factory unset price is refused
    const factoryUnset = validateSubscriptionModelForm({
      scope: 'factory',
      name: 'codex-shared',
      modelId: 'gpt-5-codex',
      inputPrice: '',
      outputPrice: '',
      explicitZeroPrice: false,
    });
    assert.equal(factoryUnset.ok, false);

    // Factory explicit $0 is accepted
    const factoryZero = validateSubscriptionModelForm({
      scope: 'factory',
      name: 'codex-shared-zero',
      modelId: 'gpt-5-codex',
      inputPrice: '',
      outputPrice: '',
      explicitZeroPrice: true,
    });
    assert.deepEqual(factoryZero, {
      ok: true,
      name: 'codex-shared-zero',
      modelId: 'gpt-5-codex',
      price: { inputPerMTok: 0, outputPerMTok: 0 },
    });

    // Factory non-zero price is accepted
    const factoryPriced = validateSubscriptionModelForm({
      scope: 'factory',
      name: 'codex-shared-priced',
      modelId: 'gpt-5-codex',
      inputPrice: '1.5',
      outputPrice: '6',
      explicitZeroPrice: false,
    });
    assert.deepEqual(factoryPriced, {
      ok: true,
      name: 'codex-shared-priced',
      modelId: 'gpt-5-codex',
      price: { inputPerMTok: 1.5, outputPerMTok: 6 },
    });
  });

  it('validates dailyTokenCap input (blank clears to null; positive integer sets cap)', () => {
    assert.deepEqual(validateDailyTokenCapInput(''), { ok: true, dailyTokenCap: null });
    assert.deepEqual(validateDailyTokenCapInput('none'), { ok: true, dailyTokenCap: null });
    assert.deepEqual(validateDailyTokenCapInput('250,000'), { ok: true, dailyTokenCap: 250000 });
    assert.equal(validateDailyTokenCapInput('0').ok, false);
    assert.equal(validateDailyTokenCapInput('-100').ok, false);
    assert.equal(validateDailyTokenCapInput('12.5').ok, false);
  });

  it('formats 409 account_already_connected, name_taken, and not-offered Anthropic & Google vendors cleanly', () => {
    const conflictErr = new ApiError('account_already_connected', 409, {
      error: 'account_already_connected',
      message: 'Vendor account is already connected under another owner',
    });
    assert.match(formatSubscriptionApiError(conflictErr), /already connected under another owner/);

    const defaultConflict = new ApiError('account_already_connected', 409, { error: 'account_already_connected' });
    assert.match(formatSubscriptionApiError(defaultConflict), /409 account_already_connected/);

    const notOffered = resolveNotOfferedVendors(undefined);
    assert.equal(notOffered.length, DEFAULT_NOT_OFFERED_VENDORS.length);
    assert.deepEqual(
      notOffered.map((v) => v.vendor),
      ['anthropic', 'google'],
    );
    assert.ok(notOffered.every((v) => v.checkedDate === '2026-11-07'));
  });

  it('aggregates per-connection and per-agent token usage from SubscriptionSpendReport', () => {
    const report: SubscriptionSpendReport = {
      day: '2026-11-08',
      month: '2026-11',
      connections: {
        sub_alice_1: {
          connectionName: "Alice's Grok",
          scope: 'personal',
          day: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            calls: 2,
            byModel: {},
            byAgent: {
              'alice-personal': { inputTokens: 100, outputTokens: 50, totalTokens: 150, calls: 2 },
            },
          },
          month: {
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 1500,
            calls: 10,
            byModel: {},
            byAgent: {
              'alice-personal': { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, calls: 10 },
            },
          },
        },
      },
      agents: {},
    };
    const summary = connectionSpendSummary('sub_alice_1', report);
    assert.equal(summary.dayTokens, 150);
    assert.equal(summary.monthTokens, 1500);
    assert.equal(summary.byAgent.length, 1);
    assert.equal(summary.byAgent[0].agentId, 'alice-personal');
    assert.equal(summary.byAgent[0].monthTokens, 1500);
  });
});
