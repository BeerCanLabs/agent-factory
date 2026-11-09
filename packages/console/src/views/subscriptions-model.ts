/**
 * Pure view-model for Console Subscription Management ("My Subscriptions" BYOM + Admin Factory Subscriptions)
 * (DESIGN_AUTHORITY.md §6.9 M5(1), (2), (4), (4a), (7), (8), TSK-329).
 */
import { ApiError } from '../api/client.js';
import type {
  NotOfferedSubscriptionVendor,
  StoredModel,
  SubscriptionConnectionView,
  SubscriptionScope,
  SubscriptionSpendReport,
} from '../api/types.js';
import {
  canManageCatalogModels,
  canManageFactorySubscriptions,
  canOwnSubscriptions,
  canReadAllSubscriptions,
  effectivePrincipalOf,
  type Whoami,
} from '../auth/access-gate.js';

export type SubscriptionTab = 'personal' | 'factory' | 'fleet';

export interface SubscriptionTabSpec {
  id: SubscriptionTab;
  label: string;
  description: string;
}

export const DEFAULT_NOT_OFFERED_VENDORS: readonly NotOfferedSubscriptionVendor[] = [
  {
    vendor: 'anthropic',
    name: 'Anthropic (Claude Pro / Max)',
    reason:
      "Anthropic's legal and compliance terms limit Claude Pro and Max subscriptions to Anthropic's own products and prohibit OAuth tokens from consumer plans in third-party or custom agent software. Use an Anthropic API key or AWS Bedrock instead.",
    statementUrls: ['https://code.claude.com/docs/en/legal-and-compliance'],
    checkedDate: '2026-11-07',
  },
  {
    vendor: 'google',
    name: 'Google (Gemini / Antigravity)',
    reason:
      "Google's Gemini CLI and Antigravity terms prohibit third-party agent software from using consumer subscription credentials, and Google suspends accounts that do so. Use a Gemini API key or Vertex AI instead.",
    statementUrls: ['https://geminicli.com/docs/resources/tos-privacy', 'https://antigravity.google/terms'],
    checkedDate: '2026-11-07',
  },
];

export function resolveNotOfferedVendors(
  serverList?: readonly NotOfferedSubscriptionVendor[] | null,
): readonly NotOfferedSubscriptionVendor[] {
  return serverList && serverList.length > 0 ? serverList : DEFAULT_NOT_OFFERED_VENDORS;
}

/** Tabs offered to this caller based on their Bouncer privileges in `/api/v1/whoami`. */
export function subscriptionTabsFor(whoami: Whoami | null | undefined): SubscriptionTabSpec[] {
  const tabs: SubscriptionTabSpec[] = [];
  if (canOwnSubscriptions(whoami)) {
    tabs.push({
      id: 'personal',
      label: 'My Subscriptions',
      description: 'Connect your own ChatGPT or Grok subscription ($0 BYOM) for your personal agents.',
    });
  }
  if (canReadAllSubscriptions(whoami) || canManageFactorySubscriptions(whoami)) {
    tabs.push({
      id: 'factory',
      label: 'Factory Subscriptions',
      description: 'Shared factory-wide subscription connections managed by Factory Admins.',
    });
    tabs.push({
      id: 'fleet',
      label: 'All Connections (Audit)',
      description: 'Fleet-wide audit view across both factory-shared and personal BYOM connections.',
    });
  }
  return tabs;
}

export function defaultSubscriptionTabFor(whoami: Whoami | null | undefined): SubscriptionTab {
  const tabs = subscriptionTabsFor(whoami);
  if (tabs.length === 0) return 'personal';
  if (whoami?.onBehalfOf && tabs.some((t) => t.id === 'personal')) {
    return 'personal';
  }
  if (canManageFactorySubscriptions(whoami) && !effectivePrincipalOf(whoami) && tabs.some((t) => t.id === 'factory')) {
    return 'factory';
  }
  return tabs[0].id;
}

export function filterConnectionsForTab(
  connections: readonly SubscriptionConnectionView[],
  tab: SubscriptionTab,
  whoami: Whoami | null | undefined,
): SubscriptionConnectionView[] {
  if (tab === 'fleet') return [...connections];
  if (tab === 'factory') return connections.filter((c) => c.scope === 'factory');
  const caller = effectivePrincipalOf(whoami);
  return connections.filter(
    (c) => c.scope === 'personal' && (!caller || c.ownerPrincipalId === caller),
  );
}

/** Whether the caller can rename, set `dailyTokenCap`, discover, or reconnect this connection. */
export function canMutateConnection(
  conn: Pick<SubscriptionConnectionView, 'scope' | 'ownerPrincipalId'>,
  whoami: Whoami | null | undefined,
): boolean {
  if (conn.scope === 'factory') {
    return canManageFactorySubscriptions(whoami);
  }
  const caller = effectivePrincipalOf(whoami);
  return Boolean(caller && conn.ownerPrincipalId === caller && canOwnSubscriptions(whoami));
}

/** Admins can also disconnect a personal connection for incident response (M5(4), TSK-332). */
export function canDisconnectConnection(
  conn: Pick<SubscriptionConnectionView, 'scope' | 'ownerPrincipalId'>,
  whoami: Whoami | null | undefined,
): boolean {
  if (canMutateConnection(conn, whoami)) return true;
  return conn.scope === 'personal' && canManageFactorySubscriptions(whoami);
}

/** Whether the caller can add or retire catalog entries on this connection. */
export function canManageConnectionModels(
  conn: Pick<SubscriptionConnectionView, 'scope' | 'ownerPrincipalId'>,
  whoami: Whoami | null | undefined,
): boolean {
  if (conn.scope === 'factory') {
    return canManageCatalogModels(whoami);
  }
  const caller = effectivePrincipalOf(whoami);
  return Boolean(caller && conn.ownerPrincipalId === caller && canOwnSubscriptions(whoami));
}

/**
 * M5(4a): When discovery returned a real model list (`listAvailable: true`), additions pick from that list;
 * when discovery reported `no_model_list`, `vendor_refused`, failed, or has not run yet, explicit `modelId` entry is allowed.
 */
export function allowsManualModelEntry(
  conn: Pick<SubscriptionConnectionView, 'discovery' | 'discoveredModels'>,
): boolean {
  if (!conn.discovery) return true;
  if (conn.discovery.status === 'failed' || conn.discovery.status === 'needs_reconsent') return true;
  if (conn.discovery.listAvailable === false) return true;
  return !Array.isArray(conn.discoveredModels);
}

export function discoveryStatusBanner(
  conn: Pick<SubscriptionConnectionView, 'discovery' | 'discoveredModels'>,
): { tone: 'info' | 'warning' | 'ok'; text: string } {
  const d = conn.discovery;
  if (!d) {
    return {
      tone: 'info',
      text: 'Model list has not been fetched yet. Click Discover Models, or enter a vendor model ID directly.',
    };
  }
  if (d.status === 'needs_reconsent') {
    return {
      tone: 'warning',
      text: 'Discovery requires re-consent. Reconnect this subscription to refresh credentials and discover models.',
    };
  }
  if (d.status === 'failed') {
    const err = d.message ?? d.reason ?? 'vendor unreachable';
    return {
      tone: 'warning',
      text: `Last model discovery failed (${err}). Existing catalog entries were kept; you can enter a model ID manually.`,
    };
  }
  if (!d.listAvailable || d.status === 'no_model_list' || d.status === 'vendor_refused') {
    const why =
      d.status === 'vendor_refused' || d.reason === 'vendor_refused'
        ? 'the vendor refused model-list discovery for OAuth subscription tokens'
        : 'this vendor does not publish a subscription model list endpoint';
    const tag = d.reason ?? (d.status === 'vendor_refused' ? 'vendor_refused' : 'no_model_list');
    return {
      tone: 'info',
      text: `Model list unavailable (${tag}): ${why}. Existing catalog entries were kept; enter the vendor model ID manually below.`,
    };
  }
  const count = conn.discoveredModels?.length ?? 0;
  let formattedDate = d.discoveredAt;
  try {
    const parsed = new Date(d.discoveredAt);
    if (!Number.isNaN(parsed.getTime())) {
      formattedDate = parsed.toLocaleString();
    }
  } catch {
    // safe fallback
  }
  return {
    tone: 'ok',
    text: `${count} model${count === 1 ? '' : 's'} discovered from vendor (checked ${formattedDate}).`,
  };
}

export function attestationCopyForScope(scope: SubscriptionScope): string {
  if (scope === 'personal') {
    return 'I attest that this is my own personal vendor subscription and that connecting it to my personal agents complies with the vendor terms shown above.';
  }
  return 'I confirm that the subscriber has authorized connecting this subscription for shared factory use under the vendor terms shown above.';
}

export function validateConnectInput(input: {
  templateId: string;
  subscriberAttested: boolean;
  name?: string;
}): { ok: true; templateId: string; subscriberAttested: true; name?: string } | { ok: false; error: string } {
  const templateId = input.templateId.trim();
  if (!templateId) {
    return { ok: false, error: 'Choose a subscription vendor template.' };
  }
  if (!input.subscriberAttested) {
    return { ok: false, error: 'You must check the subscriber attestation box before starting sign-in.' };
  }
  const trimmedName = input.name?.trim();
  if (trimmedName !== undefined && trimmedName.length > 80) {
    return { ok: false, error: 'Connection display name must be 80 characters or fewer.' };
  }
  return {
    ok: true,
    templateId,
    subscriberAttested: true,
    ...(trimmedName ? { name: trimmedName } : {}),
  };
}

export function validateDailyTokenCapInput(
  raw: string,
): { ok: true; dailyTokenCap: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim().replace(/,/g, '');
  if (!trimmed || trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'off') {
    return { ok: true, dailyTokenCap: null };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: 'Daily token cap must be a positive whole number of tokens (or leave blank for no cap).' };
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n <= 0) {
    return { ok: false, error: 'Daily token cap must be greater than 0 (or leave blank to clear).' };
  }
  return { ok: true, dailyTokenCap: n };
}

const CATALOG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export function suggestSubscriptionCatalogName(
  modelId: string,
  conn: Pick<SubscriptionConnectionView, 'name' | 'scope'>,
): string {
  const cleanModel = modelId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = conn.name
    .trim()
    .toLowerCase()
    .replace(/subscription/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (!cleanModel) return '';
  return slug ? `${cleanModel}-${slug}`.slice(0, 120) : `${cleanModel}-${conn.scope}`;
}

export function validateSubscriptionModelForm(input: {
  scope: SubscriptionScope;
  name: string;
  modelId: string;
  inputPrice: string;
  outputPrice: string;
  explicitZeroPrice: boolean;
}):
  | {
      ok: true;
      name: string;
      modelId: string;
      price: { inputPerMTok: number; outputPerMTok: number };
    }
  | { ok: false; error: string } {
  const name = input.name.trim();
  const modelId = input.modelId.trim();
  if (!modelId) {
    return { ok: false, error: 'Select or enter a vendor model ID.' };
  }
  if (!name || !CATALOG_NAME_RE.test(name)) {
    return {
      ok: false,
      error: 'Catalog name must be 1–128 characters using letters, numbers, or . _ : @ / -.',
    };
  }
  if (input.scope === 'personal') {
    return {
      ok: true,
      name,
      modelId,
      price: { inputPerMTok: 0, outputPerMTok: 0 },
    };
  }
  if (input.explicitZeroPrice) {
    return {
      ok: true,
      name,
      modelId,
      price: { inputPerMTok: 0, outputPerMTok: 0 },
    };
  }
  const inRaw = input.inputPrice.trim();
  const outRaw = input.outputPrice.trim();
  if (inRaw === '' || outRaw === '') {
    return {
      ok: false,
      error: 'Factory subscription models require explicit per-1M token rates (or check "$0 / included in plan").',
    };
  }
  const inputPerMTok = Number(inRaw);
  const outputPerMTok = Number(outRaw);
  if (!Number.isFinite(inputPerMTok) || inputPerMTok < 0 || !Number.isFinite(outputPerMTok) || outputPerMTok < 0) {
    return { ok: false, error: 'Token rates must be non-negative numbers.' };
  }
  return {
    ok: true,
    name,
    modelId,
    price: { inputPerMTok, outputPerMTok },
  };
}

export function catalogModelsForConnection(
  conn: SubscriptionConnectionView,
  allCatalogModels: readonly StoredModel[],
): StoredModel[] {
  const fromCatalog = allCatalogModels.filter(
    (m) => (m.credentialMode === 'subscription' || m.subscription) && m.connection === conn.id,
  );
  if (fromCatalog.length > 0) return fromCatalog;
  return conn.catalogModels ? [...conn.catalogModels] : [];
}

export interface ConnectionTokenUsageSummary {
  dayTokens: number;
  dayCalls: number;
  monthTokens: number;
  monthCalls: number;
  byAgent: Array<{
    agentId: string;
    dayTokens: number;
    dayCalls: number;
    monthTokens: number;
    monthCalls: number;
  }>;
}

export function subscriptionSpendTotals(spend?: SubscriptionSpendReport | null): {
  dayTokens: number;
  dayCalls: number;
  monthTokens: number;
  monthCalls: number;
} {
  let dayTokens = 0;
  let dayCalls = 0;
  let monthTokens = 0;
  let monthCalls = 0;
  for (const c of Object.values(spend?.connections ?? {})) {
    dayTokens += c.day?.totalTokens ?? 0;
    dayCalls += c.day?.calls ?? 0;
    monthTokens += c.month?.totalTokens ?? 0;
    monthCalls += c.month?.calls ?? 0;
  }
  return { dayTokens, dayCalls, monthTokens, monthCalls };
}

export function connectionSpendSummary(
  connectionId: string,
  spend?: SubscriptionSpendReport | null,
): ConnectionTokenUsageSummary {
  const entry = spend?.connections?.[connectionId];
  if (!entry) {
    return { dayTokens: 0, dayCalls: 0, monthTokens: 0, monthCalls: 0, byAgent: [] };
  }
  const agentIds = new Set([
    ...Object.keys(entry.day?.byAgent ?? {}),
    ...Object.keys(entry.month?.byAgent ?? {}),
  ]);
  const byAgent = [...agentIds]
    .map((agentId) => {
      const d = entry.day?.byAgent?.[agentId];
      const m = entry.month?.byAgent?.[agentId];
      return {
        agentId,
        dayTokens: d?.totalTokens ?? 0,
        dayCalls: d?.calls ?? 0,
        monthTokens: m?.totalTokens ?? 0,
        monthCalls: m?.calls ?? 0,
      };
    })
    .sort((a, b) => b.monthTokens - a.monthTokens || a.agentId.localeCompare(b.agentId));
  return {
    dayTokens: entry.day?.totalTokens ?? 0,
    dayCalls: entry.day?.calls ?? 0,
    monthTokens: entry.month?.totalTokens ?? 0,
    monthCalls: entry.month?.calls ?? 0,
    byAgent,
  };
}

export function formatSubscriptionApiError(err: unknown): string {
  if (err instanceof ApiError) {
    const code = typeof err.body?.error === 'string' ? err.body.error : err.message;
    const msg = typeof err.body?.message === 'string' ? err.body.message : undefined;
    if (err.status === 409 && code === 'account_already_connected') {
      return (
        msg ||
        'This vendor account is already connected under another owner or scope (409 account_already_connected). Each vendor account may only be connected once across the factory.'
      );
    }
    if (err.status === 409 && code === 'name_taken') {
      return msg || 'That connection display name is already in use across the factory. Choose a unique name and try again.';
    }
    if (err.status === 409 && code === 'model_name_taken') {
      return msg || 'That catalog model name is already in use in the factory catalog. Pick a unique name.';
    }
    if (err.status === 410 || code === 'sign_in_expired') {
      return msg || 'The device sign-in code expired before completion. Start a new connection sign-in.';
    }
    if (code === 'sign_in_denied') {
      return msg || 'The vendor sign-in was denied in the browser.';
    }
    if (code === 'attestation_required') {
      return msg || 'Subscriber attestation is required before connecting a subscription.';
    }
    if (code === 'user_principal_required') {
      return (
        msg ||
        'Personal BYOM subscriptions require signing in as a canonical user principal (or using Admin Act-As for a user:<id>).'
      );
    }
    if (code === 'personal_model_price_immutable') {
      return msg || 'Personal BYOM subscription models have a fixed immutable $0 price.';
    }
    if (msg) return `${msg} (${code})`;
    return `${err.message} (HTTP ${err.status})`;
  }
  return err instanceof Error ? err.message : String(err);
}
