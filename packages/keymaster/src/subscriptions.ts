/**
 * Keymaster subscription connections (DESIGN_AUTHORITY.md §6.9 M5(4), (5), (6); §6.11 K1 to K4 as amended).
 *
 * A subscription connection is the factory's, not an agent's: a model vendor's OAuth grant for a person's own plan
 * (SuperGrok, ChatGPT Plus/Pro) that an admin signed in, with the subscriber's confirmation. Only the Keymaster holds the
 * grant (K1), at `shared/<provider>/subscription/<connection>`, declared by no agent (K5.1 as amended).
 *
 * - Sign-in is the vendor's device-code flow with the vendor's public client (no secret): the Keymaster starts it and the
 *   admin's console shows the code and the vendor's URL; nothing redirects to the factory (M5(5), K2 as amended).
 *   The flow, hosts and client come from `SUBSCRIPTION_TEMPLATES` (contract code), never from a caller.
 * - A connection is named for its subscriber (first name + the vendor's plan, else the email's local part), unique within
 *   the factory, and one vendor account has at most one connection: signing in to a connected account reconnects it.
 * - Refresh is serialized per grant, the rotated refresh token is persisted BEFORE the new access token is used, and every
 *   access, refresh, id and device token joins the redaction set (S1) the moment it is obtained (M5(6)).
 * - A refused refresh marks the grant needs re-consent (K4), tells the admin who connected it (every admin if that admin no
 *   longer holds the role; the control plane resolves who), and is never retried.
 *
 * No provider SDKs: plain HTTPS posts. Nothing here logs, returns or ledgers a token.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { LedgerStore } from '@beercanlabs/factory-ledger';
import { writableProvider, type SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { SUBSCRIPTION_TEMPLATES, type SubscriptionTemplate } from '@beercanlabs/factory-contract';

export type SubscriptionStatus = 'active' | 'needs_reconsent';

/** What the Keymaster stores at `shared/<provider>/subscription/<connection>`. Tokens never leave it. */
export type SubscriptionRecord = {
  id: string;
  /** The vendor (`xai`, `openai`): the `<provider>` of the secret name. */
  provider: string;
  templateId: string;
  name: string;
  subscriberEmail: string;
  /** What identifies the vendor account (OpenAI: account id and subject; xAI: subject). One connection per key. */
  accountKey: string;
  /** OpenAI's `ChatGPT-Account-ID` (M5(3), vendor-required), read from the signed-in account. */
  accountId?: string;
  tier?: string;
  /** The token endpoint this grant refreshes at (xAI: from OIDC discovery, validated against the host rule). */
  tokenUrl: string;
  scopes: string[];
  refreshToken: string;
  accessToken?: string;
  expiresAt?: string;
  /** The admin who last connected (or reconnected) it: told when the grant needs re-consent (K4). */
  connectedBy: string;
  connectedAt: string;
  reconnectedAt?: string;
  status: SubscriptionStatus;
  statusAt?: string;
};

/** What callers may see about a connection. Never tokens. */
export type SubscriptionView = {
  id: string;
  provider: string;
  templateId: string;
  name: string;
  subscriberEmail: string;
  tier?: string;
  status: SubscriptionStatus;
  statusAt?: string;
  connectedBy: string;
  connectedAt: string;
  reconnectedAt?: string;
  /** Where the connection's secret lives (a name, never a value). */
  secretName: string;
};

export const subscriptionSecretName = (provider: string, connection: string) => `shared/${provider}/subscription/${connection}`;
const indexSecretName = (provider: string) => `shared/${provider}/subscription/_index`;
const CONNECTION_ID = /^c-[a-f0-9]{12}$/;

export const NAME_MAX = 80;

export type SignInView = {
  signInId: string;
  templateId: string;
  /** What the admin shows the subscriber: the vendor's own URL and the code to type there. */
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete?: string;
  expiresAt: string;
  intervalSeconds: number;
  reconnect?: string;
};

export type StartSignInError =
  | { ok: false; error: 'unknown_template' | 'attestation_required' | 'invalid_name' | 'name_taken' | 'unknown_connection' | 'provider_mismatch'; message: string }
  | { ok: false; error: 'sign_in_unavailable' | 'sign_in_rate_limited' | 'discovery_invalid'; message: string };

export type PollOutcome =
  | { ok: true; status: 'pending'; intervalSeconds: number }
  | { ok: true; status: 'connected'; connection: SubscriptionView; reconnect: boolean }
  | {
      ok: false;
      error:
        | 'unknown_sign_in'
        | 'sign_in_expired'
        | 'sign_in_denied'
        | 'sign_in_failed'
        | 'profile_unavailable'
        | 'name_taken'
        | 'account_mismatch'
        | 'sign_in_unavailable';
      message: string;
    };

export type SubscriptionTokenOutcome =
  | { ok: true; accessToken: string; expiresAt: string; accountId?: string }
  | { ok: false; error: 'needs_reconsent'; connection: string; reason: string }
  | { ok: false; error: 'unknown_connection' | 'connection_unavailable'; message: string };

export type NeedsReconsentEvent = { connection: SubscriptionView; reason: string };

export type SubscriptionKeymasterOptions = {
  providers: SecretProvider[];
  ledger?: LedgerStore;
  /** Every token value the Keymaster obtains is added here so the factory redacts it (S1). */
  secretValues?: Set<string>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Refresh this long before expiry. Default 60s. */
  skewMs?: number;
  /** The factory version, for the template's `User-Agent` (M5(3)). */
  version?: string;
  /** Called after a grant is marked needs re-consent (K4). The control plane tells the admin (or every admin). */
  onNeedsReconsent?: (ev: NeedsReconsentEvent) => void | Promise<void>;
  templates?: Record<string, SubscriptionTemplate>;
};

type SignInSession = {
  id: string;
  template: SubscriptionTemplate;
  actor: string;
  name?: string;
  reconnectId?: string;
  expiresAtMs: number;
  intervalMs: number;
  nextPollAtMs: number;
  tokenUrl: string;
  /** xAI */
  deviceCode?: string;
  /** OpenAI */
  deviceAuthId?: string;
  userCode: string;
  done?: boolean;
};

type Tokens = { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number };

const FETCH_TIMEOUT_MS = 15_000;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** Refusals that mean the refresh token itself is dead: revoked, reused or expired. Never retried (M5(6)). */
const REFUSED_CODES = new Set(['invalid_grant', 'refresh_token_reused', 'refresh_token_expired', 'refresh_token_invalidated', 'invalid_token']);

const VENDOR_PLAN_LABEL: Record<string, string> = { xai: 'Grok', openai: 'ChatGPT' };
const OPENAI_TIERS: Record<string, string> = { go: 'ChatGPT Go', plus: 'ChatGPT Plus', pro: 'ChatGPT Pro' };

/** M5(5): an xAI endpoint must be https on the template's host or a subdomain of it (as Hermes validates OIDC discovery). */
export function endpointMeetsHostRule(url: string, rule: NonNullable<SubscriptionTemplate['signIn']['hostRule']>): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== `${rule.scheme}:`) return false;
  const host = u.hostname.toLowerCase();
  return host === rule.host || (rule.allowSubdomains && host.endsWith(`.${rule.host}`));
}

function decodeJwt(token: string | undefined): Record<string, unknown> {
  if (!token) return {};
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    const j = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export type Profile = { email: string; firstName?: string; accountKey: string; accountId?: string; tier?: string };

/**
 * The signed-in account from the vendor's own tokens. The JWT payload is read WITHOUT verifying its signature: the tokens
 * came straight from the vendor's token endpoint over TLS and this only labels the connection (and tells accounts apart);
 * it never decides whether a token is valid.
 */
export function profileFromTokens(template: SubscriptionTemplate, tokens: Pick<Tokens, 'id_token' | 'access_token'>): Profile | undefined {
  const idc = decodeJwt(tokens.id_token);
  const atc = decodeJwt(tokens.access_token);
  const claim = (k: string) => idc[k] ?? atc[k];
  const sub = str(claim('sub'));
  const openaiAuth = { ...obj(atc['https://api.openai.com/auth']), ...obj(idc['https://api.openai.com/auth']) };
  const openaiProfile = { ...obj(atc['https://api.openai.com/profile']), ...obj(idc['https://api.openai.com/profile']) };
  const email = (str(claim('email')) ?? str(openaiProfile.email))?.toLowerCase();
  if (!sub || !email || !email.includes('@')) return undefined;
  const given = str(claim('given_name'));
  const full = str(claim('name'));
  const firstName = given ?? full?.split(/\s+/)[0];
  if (template.vendor === 'openai') {
    const accountId = str(openaiAuth.chatgpt_account_id);
    if (!accountId) return undefined; // vendor-required header (ChatGPT-Account-ID) and part of the account identity
    const plan = str(openaiAuth.chatgpt_plan_type);
    const tier = plan ? (OPENAI_TIERS[plan.toLowerCase()] ?? plan) : undefined;
    return { email, firstName, accountKey: `${accountId}:${sub}`, accountId, ...(tier ? { tier } : {}) };
  }
  // xAI: no tier claim is documented; the tier stays unset (shown as unknown) until xAI documents one.
  return { email, firstName, accountKey: sub };
}

/** M5(4): `<first name>'s <Plan> Subscription`, else the email's local part in the first name's place. */
export function defaultConnectionName(vendor: string, p: Pick<Profile, 'email' | 'firstName'>): string {
  const who = p.firstName ?? p.email.split('@')[0];
  return `${who}'s ${VENDOR_PLAN_LABEL[vendor] ?? vendor} Subscription`;
}

export function cleanConnectionName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return name && name.length <= NAME_MAX ? name : undefined;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class SubscriptionKeymaster {
  private readonly providers: SecretProvider[];
  private readonly ledger?: LedgerStore;
  private readonly secretValues: Set<string>;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly skewMs: number;
  private readonly version: string;
  private readonly onNeedsReconsent?: SubscriptionKeymasterOptions['onNeedsReconsent'];
  private readonly templates: Record<string, SubscriptionTemplate>;
  private readonly cache = new Map<string, { accessToken: string; expiresAtMs: number; accountId?: string }>();
  private readonly invalidated = new Set<string>();
  private readonly inflight = new Map<string, Promise<SubscriptionTokenOutcome>>();
  private readonly signIns = new Map<string, SignInSession>();
  /** A rotated grant whose write failed: persisted first on the next call, so a single-use refresh token is never lost. */
  private readonly unsaved = new Map<string, SubscriptionRecord>();
  /** A refused refresh whose needs-re-consent mark could not be written: the dead refresh token is never retried (M5(6)). */
  private readonly marks = new Map<string, { refreshToken: string; at: string }>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: SubscriptionKeymasterOptions) {
    this.providers = opts.providers;
    this.ledger = opts.ledger;
    this.secretValues = opts.secretValues ?? new Set();
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.skewMs = opts.skewMs ?? 60_000;
    this.version = opts.version ?? '0';
    this.onNeedsReconsent = opts.onNeedsReconsent;
    this.templates = opts.templates ?? SUBSCRIPTION_TEMPLATES;
  }

  // ---- storage -------------------------------------------------------------------------------

  /** Serializes every change to stored connections (names, accounts and the per-vendor index stay consistent). */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async read(name: string): Promise<string | undefined> {
    for (const p of this.providers) {
      const v = await p.get(name);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  private async write(name: string, value: string): Promise<void> {
    const w = writableProvider(this.providers);
    if (!w) throw new Error('no writable secrets backend is configured for the Keymaster');
    await w.put(name, value);
  }

  /** S1: add every token to the redaction set the moment it is obtained. */
  private remember(...values: Array<string | undefined>) {
    for (const v of values) if (v && v.length >= 8) this.secretValues.add(v);
  }

  private rememberRecord(r: SubscriptionRecord) {
    this.remember(r.refreshToken, r.accessToken);
  }

  private async index(provider: string): Promise<string[]> {
    const raw = await this.read(indexSecretName(provider));
    if (!raw) return [];
    try {
      const j = JSON.parse(raw) as { ids?: unknown };
      return Array.isArray(j.ids) ? j.ids.filter((i): i is string => typeof i === 'string' && CONNECTION_ID.test(i)) : [];
    } catch {
      return [];
    }
  }

  private async writeIndex(provider: string, ids: string[]) {
    await this.write(indexSecretName(provider), JSON.stringify({ ids: [...new Set(ids)] }));
  }

  private async load(provider: string, id: string): Promise<SubscriptionRecord | undefined> {
    const pending = this.unsaved.get(id);
    if (pending) return this.withMark(pending);
    const raw = await this.read(subscriptionSecretName(provider, id));
    if (!raw) return undefined;
    try {
      const r = JSON.parse(raw) as SubscriptionRecord & { retired?: boolean };
      if (!r || r.retired || typeof r.refreshToken !== 'string' || r.id !== id) return undefined;
      this.rememberRecord(r);
      return this.withMark(r);
    } catch {
      return undefined;
    }
  }

  /** An in-memory needs-re-consent mark (the write failed) applies while the stored grant still has the refused refresh token. */
  private withMark(r: SubscriptionRecord): SubscriptionRecord {
    const m = this.marks.get(r.id);
    if (!m) return r;
    if (m.refreshToken !== r.refreshToken) {
      this.marks.delete(r.id); // reconnected: a new grant
      return r;
    }
    return r.status === 'needs_reconsent' ? r : { ...r, status: 'needs_reconsent', statusAt: m.at, accessToken: undefined, expiresAt: undefined };
  }

  private async save(r: SubscriptionRecord) {
    this.rememberRecord(r);
    await this.write(subscriptionSecretName(r.provider, r.id), JSON.stringify(r));
  }

  private async allRecords(): Promise<SubscriptionRecord[]> {
    const out: SubscriptionRecord[] = [];
    for (const t of Object.values(this.templates)) {
      for (const id of await this.index(t.vendor)) {
        const r = await this.load(t.vendor, id);
        if (r) out.push(r);
      }
    }
    return out;
  }

  static view(r: SubscriptionRecord): SubscriptionView {
    return {
      id: r.id,
      provider: r.provider,
      templateId: r.templateId,
      name: r.name,
      subscriberEmail: r.subscriberEmail,
      ...(r.tier ? { tier: r.tier } : {}),
      status: r.status,
      ...(r.statusAt ? { statusAt: r.statusAt } : {}),
      connectedBy: r.connectedBy,
      connectedAt: r.connectedAt,
      ...(r.reconnectedAt ? { reconnectedAt: r.reconnectedAt } : {}),
      secretName: subscriptionSecretName(r.provider, r.id),
    };
  }

  async list(): Promise<SubscriptionView[]> {
    return (await this.allRecords()).map(SubscriptionKeymaster.view).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<SubscriptionView | undefined> {
    const r = await this.find(id);
    return r ? SubscriptionKeymaster.view(r) : undefined;
  }

  private async find(id: string): Promise<SubscriptionRecord | undefined> {
    if (!CONNECTION_ID.test(id)) return undefined;
    for (const t of Object.values(this.templates)) {
      if ((await this.index(t.vendor)).includes(id)) return this.load(t.vendor, id);
    }
    return undefined;
  }

  private ledgerRow(row: Record<string, unknown>) {
    this.ledger?.append({ timestamp: new Date(this.now()).toISOString(), agentId: 'factory', type: 'action', ...row } as never);
  }

  // ---- transport -----------------------------------------------------------------------------

  private userAgent(t: SubscriptionTemplate): string {
    const h = t.headers.find((x) => x.name.toLowerCase() === 'user-agent' && x.role === 'factory-identity');
    return (h?.value ?? 'BeerCanLabs-AgentFactory/{version}').replace('{version}', this.version);
  }

  private async post(
    t: SubscriptionTemplate,
    url: string,
    body: { form?: Record<string, string>; json?: Record<string, string> },
  ): Promise<{ status: number; body: Record<string, unknown> } | undefined> {
    try {
      const res = await this.fetchFn(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'user-agent': this.userAgent(t),
          'content-type': body.json ? 'application/json' : 'application/x-www-form-urlencoded',
        },
        body: body.json ? JSON.stringify(body.json) : new URLSearchParams(body.form ?? {}).toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const parsed = await res.json().catch(() => ({}));
      const parsedBody = obj(parsed);
      // Anything the vendor sends back can be a credential: remember it before any other use (S1).
      this.rememberAll(parsedBody);
      return { status: res.status, body: parsedBody };
    } catch {
      return undefined;
    }
  }

  private rememberAll(b: Record<string, unknown>) {
    for (const k of ['access_token', 'refresh_token', 'id_token', 'device_code', 'device_auth_id', 'authorization_code', 'code_verifier']) {
      const v = b[k];
      if (typeof v === 'string') this.remember(v);
    }
  }

  /** The vendor's error code, from `{error: "code"}` or `{error: {code|type: "code"}}`. */
  private static errorCode(b: Record<string, unknown>): string | undefined {
    if (typeof b.error === 'string') return b.error;
    const e = obj(b.error);
    return str(e.code) ?? str(e.type);
  }

  // ---- sign-in (M5(4), (5)) ------------------------------------------------------------------

  /**
   * Starts the vendor's device-code flow for a template. `subscriberAttested` is the admin's attestation that the subscriber
   * agreed to their plan being used by the factory (M5(4)); without it nothing starts. `reconnect` names the connection the
   * sign-in must be for (its account must match); omitted, a sign-in to a connected account reconnects it anyway.
   */
  async startSignIn(p: { templateId: string; actor: string; subscriberAttested: boolean; name?: string; reconnect?: string }): Promise<{ ok: true; signIn: SignInView } | StartSignInError> {
    const template = this.templates[p.templateId];
    if (!template) return { ok: false, error: 'unknown_template', message: `no subscription template "${p.templateId}"` };
    if (p.subscriberAttested !== true) {
      return { ok: false, error: 'attestation_required', message: 'the connecting admin must attest that the subscriber agreed to their plan being used by the factory (M5(4))' };
    }
    let name: string | undefined;
    if (p.name !== undefined) {
      name = cleanConnectionName(p.name);
      if (!name) return { ok: false, error: 'invalid_name', message: `a connection name is 1 to ${NAME_MAX} characters` };
      const taken = (await this.allRecords()).find((r) => sameName(r.name, name!) && r.id !== p.reconnect);
      if (taken) return { ok: false, error: 'name_taken', message: `a connection is already named "${taken.name}"` };
    }
    if (p.reconnect !== undefined) {
      const existing = await this.find(p.reconnect);
      if (!existing) return { ok: false, error: 'unknown_connection', message: `no connection "${p.reconnect}"` };
      if (existing.templateId !== template.id) return { ok: false, error: 'provider_mismatch', message: `connection ${existing.id} is a ${existing.provider} connection` };
    }

    const session: SignInSession = {
      id: randomUUID(),
      template,
      actor: p.actor,
      name,
      reconnectId: p.reconnect,
      expiresAtMs: 0,
      intervalMs: 5000,
      nextPollAtMs: 0,
      tokenUrl: template.tokenUrl,
      userCode: '',
    };
    let view: Omit<SignInView, 'signInId' | 'templateId' | 'reconnect'>;
    if (template.vendor === 'xai') {
      const started = await this.startXai(template, session);
      if (!started.ok) return started;
      view = started.view;
    } else {
      const started = await this.startOpenAi(template, session);
      if (!started.ok) return started;
      view = started.view;
    }
    session.nextPollAtMs = this.now() + session.intervalMs;
    this.signIns.set(session.id, session);
    this.sweepSignIns();
    return { ok: true, signIn: { signInId: session.id, templateId: template.id, ...view, ...(p.reconnect ? { reconnect: p.reconnect } : {}) } };
  }

  private sweepSignIns() {
    for (const [id, s] of this.signIns) if (s.done || s.expiresAtMs + 60_000 < this.now()) this.signIns.delete(id);
  }

  private async startXai(t: SubscriptionTemplate, s: SignInSession): Promise<{ ok: true; view: Omit<SignInView, 'signInId' | 'templateId' | 'reconnect'> } | StartSignInError> {
    const rule = t.signIn.hostRule;
    if (!rule || !t.signIn.discoveryUrl) return { ok: false, error: 'sign_in_unavailable', message: `template ${t.id} has no discovery rule` };
    // OIDC discovery: the token endpoint comes from here, and must be https on x.ai or a subdomain (M5(5)).
    let disco: Record<string, unknown>;
    try {
      const res = await this.fetchFn(t.signIn.discoveryUrl, { redirect: 'error', headers: { accept: 'application/json', 'user-agent': this.userAgent(t) }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return { ok: false, error: 'sign_in_unavailable', message: `OIDC discovery returned ${res.status}` };
      disco = obj(await res.json().catch(() => ({})));
    } catch {
      return { ok: false, error: 'sign_in_unavailable', message: 'OIDC discovery failed' };
    }
    const tokenEndpoint = str(disco.token_endpoint);
    if (!tokenEndpoint || !endpointMeetsHostRule(tokenEndpoint, rule)) {
      return { ok: false, error: 'discovery_invalid', message: 'OIDC discovery named no https x.ai token endpoint' };
    }
    s.tokenUrl = tokenEndpoint;
    const r = await this.post(t, t.signIn.deviceCodeUrl, { form: { client_id: t.client.id, scope: t.scopes.join(' ') } });
    if (!r) return { ok: false, error: 'sign_in_unavailable', message: 'the device-code request failed' };
    if (r.status === 429) return { ok: false, error: 'sign_in_rate_limited', message: 'the vendor is rate-limiting sign-in; try again later' };
    const b = r.body;
    const deviceCode = str(b.device_code);
    const userCode = str(b.user_code);
    const verification = str(b.verification_uri);
    const complete = str(b.verification_uri_complete);
    if (r.status !== 200 || !deviceCode || !userCode || !verification) return { ok: false, error: 'sign_in_unavailable', message: `the device-code response was incomplete (${r.status})` };
    // The URL the admin is told to open must also be https on the vendor's origin.
    if (!endpointMeetsHostRule(verification, rule) || (complete && !endpointMeetsHostRule(complete, rule))) {
      return { ok: false, error: 'discovery_invalid', message: 'the device-code response named a verification URL outside x.ai' };
    }
    const expiresIn = typeof b.expires_in === 'number' ? b.expires_in : 600;
    const interval = Math.max(1, typeof b.interval === 'number' ? b.interval : 5);
    s.deviceCode = deviceCode;
    s.userCode = userCode;
    s.expiresAtMs = this.now() + expiresIn * 1000;
    s.intervalMs = interval * 1000;
    return { ok: true, view: { userCode, verificationUrl: verification, ...(complete ? { verificationUrlComplete: complete } : {}), expiresAt: new Date(s.expiresAtMs).toISOString(), intervalSeconds: interval } };
  }

  private async startOpenAi(t: SubscriptionTemplate, s: SignInSession): Promise<{ ok: true; view: Omit<SignInView, 'signInId' | 'templateId' | 'reconnect'> } | StartSignInError> {
    // Not RFC 8628 (M5(5)): `client_id` only; the user visits the template's verification URL and types the user code.
    const r = await this.post(t, t.signIn.deviceCodeUrl, { json: { client_id: t.client.id } });
    if (!r) return { ok: false, error: 'sign_in_unavailable', message: 'the user-code request failed' };
    if (r.status === 429) return { ok: false, error: 'sign_in_rate_limited', message: 'the vendor is rate-limiting sign-in; try again later' };
    const b = r.body;
    const deviceAuthId = str(b.device_auth_id);
    const userCode = str(b.user_code) ?? str(b.usercode);
    if (r.status !== 200 || !deviceAuthId || !userCode) return { ok: false, error: 'sign_in_unavailable', message: `the user-code response was incomplete (${r.status})` };
    const interval = Math.max(3, Number.parseInt(String(b.interval ?? '5'), 10) || 5);
    s.deviceAuthId = deviceAuthId;
    s.userCode = userCode;
    s.expiresAtMs = this.now() + 15 * 60 * 1000;
    s.intervalMs = interval * 1000;
    return { ok: true, view: { userCode, verificationUrl: t.signIn.verificationUrl, expiresAt: new Date(s.expiresAtMs).toISOString(), intervalSeconds: interval } };
  }

  /**
   * One poll step of a sign-in, on behalf of the admin who started it. Polls the vendor no faster than the vendor's interval
   * (a call inside the interval just reports pending). When the subscriber has signed in, stores the grant and returns the
   * connection. Only the admin who started the sign-in may poll it.
   */
  async pollSignIn(signInId: string, actor: string): Promise<PollOutcome> {
    const s = this.signIns.get(signInId);
    if (!s || s.actor !== actor || s.done) return { ok: false, error: 'unknown_sign_in', message: 'no such sign-in' };
    if (this.now() >= s.expiresAtMs) {
      this.signIns.delete(signInId);
      return { ok: false, error: 'sign_in_expired', message: 'the sign-in code expired; start again' };
    }
    if (this.now() < s.nextPollAtMs) return { ok: true, status: 'pending', intervalSeconds: Math.ceil(s.intervalMs / 1000) };
    s.nextPollAtMs = this.now() + s.intervalMs;

    const t = s.template;
    let tokens: Tokens;
    if (t.vendor === 'xai') {
      const r = await this.post(t, s.tokenUrl, { form: { grant_type: DEVICE_GRANT, client_id: t.client.id, device_code: s.deviceCode! } });
      if (!r) return { ok: false, error: 'sign_in_unavailable', message: 'the token endpoint is unreachable; the sign-in is still open' };
      const code = SubscriptionKeymaster.errorCode(r.body);
      if (r.status !== 200) {
        if (code === 'authorization_pending') return { ok: true, status: 'pending', intervalSeconds: Math.ceil(s.intervalMs / 1000) };
        if (code === 'slow_down') {
          s.intervalMs += 5000;
          s.nextPollAtMs = this.now() + s.intervalMs;
          return { ok: true, status: 'pending', intervalSeconds: Math.ceil(s.intervalMs / 1000) };
        }
        this.signIns.delete(signInId);
        if (code === 'access_denied') return { ok: false, error: 'sign_in_denied', message: 'the subscriber declined the sign-in' };
        if (code === 'expired_token') return { ok: false, error: 'sign_in_expired', message: 'the sign-in code expired; start again' };
        return { ok: false, error: 'sign_in_failed', message: `the vendor refused the sign-in (${code ?? `http_${r.status}`})` };
      }
      if (typeof r.body.access_token !== 'string') {
        this.signIns.delete(signInId);
        return { ok: false, error: 'sign_in_failed', message: 'the token response had no access token' };
      }
      tokens = r.body as unknown as Tokens;
    } else {
      const poll = await this.post(t, new URL('/api/accounts/deviceauth/token', t.signIn.deviceCodeUrl).toString(), { json: { device_auth_id: s.deviceAuthId!, user_code: s.userCode } });
      if (!poll) return { ok: false, error: 'sign_in_unavailable', message: 'the sign-in endpoint is unreachable; the sign-in is still open' };
      // 403 and 404 mean the subscriber has not finished yet (vendor behaviour, as Hermes treats it).
      if (poll.status === 403 || poll.status === 404) return { ok: true, status: 'pending', intervalSeconds: Math.ceil(s.intervalMs / 1000) };
      if (poll.status !== 200) {
        this.signIns.delete(signInId);
        return { ok: false, error: 'sign_in_failed', message: `the vendor's sign-in poll returned ${poll.status}` };
      }
      const authorizationCode = str(poll.body.authorization_code);
      const verifier = str(poll.body.code_verifier);
      if (!authorizationCode || !verifier) {
        this.signIns.delete(signInId);
        return { ok: false, error: 'sign_in_failed', message: 'the sign-in response had no authorization code' };
      }
      const redirect = `${new URL(t.signIn.deviceCodeUrl).origin}/deviceauth/callback`;
      const ex = await this.post(t, t.tokenUrl, { form: { grant_type: 'authorization_code', code: authorizationCode, redirect_uri: redirect, client_id: t.client.id, code_verifier: verifier } });
      if (!ex) return { ok: false, error: 'sign_in_unavailable', message: 'the token endpoint is unreachable; try polling again' };
      if (ex.status !== 200 || typeof ex.body.access_token !== 'string') {
        this.signIns.delete(signInId);
        return { ok: false, error: 'sign_in_failed', message: `the token exchange failed (${SubscriptionKeymaster.errorCode(ex.body) ?? `http_${ex.status}`})` };
      }
      tokens = ex.body as unknown as Tokens;
    }
    s.done = true;
    this.signIns.delete(signInId);
    return this.completeSignIn(s, tokens);
  }

  private async completeSignIn(s: SignInSession, tokens: Tokens): Promise<PollOutcome> {
    const t = s.template;
    // The grant is useless without a refresh token: both permitted vendors issue one (offline_access).
    if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
      return { ok: false, error: 'sign_in_failed', message: 'the vendor issued no refresh token' };
    }
    const profile = profileFromTokens(t, tokens);
    if (!profile) return { ok: false, error: 'profile_unavailable', message: 'the sign-in did not identify the account (email and account id are required)' };
    return this.locked(async () => {
      const records = await this.allRecords();
      const sameAccount = records.find((r) => r.provider === t.vendor && r.accountKey === profile.accountKey);
      if (s.reconnectId && (!sameAccount || sameAccount.id !== s.reconnectId)) {
        return { ok: false as const, error: 'account_mismatch' as const, message: 'the account that signed in is not the one this connection was made for' };
      }
      const at = new Date(this.now()).toISOString();
      const expiresAt = new Date(this.now() + (typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600) * 1000).toISOString();
      const grant = { refreshToken: tokens.refresh_token!, accessToken: tokens.access_token, expiresAt };
      if (sameAccount) {
        // One vendor account, one connection: replace the grant (reconnect); the name and the catalog entries stay.
        const next: SubscriptionRecord = {
          ...sameAccount,
          ...grant,
          tokenUrl: s.tokenUrl,
          subscriberEmail: profile.email,
          ...(profile.accountId ? { accountId: profile.accountId } : {}),
          ...(profile.tier ? { tier: profile.tier } : {}),
          connectedBy: s.actor,
          reconnectedAt: at,
          status: 'active',
          statusAt: at,
        };
        await this.save(next);
        this.unsaved.delete(next.id);
        this.marks.delete(next.id);
        this.invalidated.delete(next.id);
        this.cache.delete(next.id);
        this.cacheToken(next);
        this.ledgerRow({ action: 'SUBSCRIPTION_CONNECTED', actor: s.actor, provider: next.provider, connection: next.id, connectionName: next.name, subscriber: next.subscriberEmail, tier: next.tier ?? 'unknown', attested: true, reconnect: true });
        return { ok: true as const, status: 'connected' as const, connection: SubscriptionKeymaster.view(next), reconnect: true };
      }
      const name = s.name ?? defaultConnectionName(t.vendor, profile);
      const clash = records.find((r) => sameName(r.name, name));
      if (clash) {
        return { ok: false as const, error: 'name_taken' as const, message: `a connection is already named "${clash.name}"; sign in again with a name` };
      }
      const id = `c-${randomBytes(6).toString('hex')}`;
      const rec: SubscriptionRecord = {
        id,
        provider: t.vendor,
        templateId: t.id,
        name,
        subscriberEmail: profile.email,
        accountKey: profile.accountKey,
        ...(profile.accountId ? { accountId: profile.accountId } : {}),
        ...(profile.tier ? { tier: profile.tier } : {}),
        tokenUrl: s.tokenUrl,
        scopes: t.scopes,
        ...grant,
        connectedBy: s.actor,
        connectedAt: at,
        status: 'active',
      };
      // Write the grant before the index: an index entry never points at nothing.
      await this.save(rec);
      await this.writeIndex(t.vendor, [...(await this.index(t.vendor)), id]);
      this.invalidated.delete(id);
      this.cacheToken(rec);
      this.ledgerRow({ action: 'SUBSCRIPTION_CONNECTED', actor: s.actor, provider: rec.provider, connection: rec.id, connectionName: rec.name, subscriber: rec.subscriberEmail, tier: rec.tier ?? 'unknown', attested: true, reconnect: false });
      return { ok: true as const, status: 'connected' as const, connection: SubscriptionKeymaster.view(rec), reconnect: false };
    });
  }

  private cacheToken(r: SubscriptionRecord) {
    if (r.accessToken && r.expiresAt) this.cache.set(r.id, { accessToken: r.accessToken, expiresAtMs: Date.parse(r.expiresAt), ...(r.accountId ? { accountId: r.accountId } : {}) });
  }

  // ---- rename and disconnect (M5(4)) ---------------------------------------------------------

  async rename(id: string, rawName: unknown, actor: string): Promise<{ ok: true; connection: SubscriptionView } | { ok: false; error: 'unknown_connection' | 'invalid_name' | 'name_taken'; message: string }> {
    const name = cleanConnectionName(rawName);
    if (!name) return { ok: false, error: 'invalid_name', message: `a connection name is 1 to ${NAME_MAX} characters` };
    return this.locked(async () => {
      const rec = await this.find(id);
      if (!rec) return { ok: false as const, error: 'unknown_connection' as const, message: `no connection "${id}"` };
      const clash = (await this.allRecords()).find((r) => r.id !== id && sameName(r.name, name));
      if (clash) return { ok: false as const, error: 'name_taken' as const, message: `a connection is already named "${clash.name}"` };
      const next = { ...rec, name };
      await this.save(next);
      this.ledgerRow({ action: 'SUBSCRIPTION_RENAMED', actor, provider: rec.provider, connection: id, connectionName: name, previousName: rec.name, subscriber: rec.subscriberEmail, tier: rec.tier ?? 'unknown' });
      return { ok: true as const, connection: SubscriptionKeymaster.view(next) };
    });
  }

  /**
   * Disconnects a connection: its grant is overwritten with a tombstone (the secrets backend has no delete), the cached token
   * is dropped, and `retireEntries` (TSK-328's catalog hook) retires the connection's catalog entries, returning how many.
   * The vendor-side grant is not revoked by the factory: the subscriber can revoke it in their vendor account.
   */
  async disconnect(id: string, actor: string, retireEntries?: (connection: SubscriptionView) => number | Promise<number>): Promise<{ ok: true; connection: SubscriptionView; entriesRetired: number } | { ok: false; error: 'unknown_connection'; message: string }> {
    return this.locked(async () => {
      const rec = await this.find(id);
      if (!rec) return { ok: false as const, error: 'unknown_connection' as const, message: `no connection "${id}"` };
      const view = SubscriptionKeymaster.view(rec);
      const entriesRetired = retireEntries ? await retireEntries(view) : 0;
      await this.write(subscriptionSecretName(rec.provider, id), JSON.stringify({ id, provider: rec.provider, retired: true, retiredAt: new Date(this.now()).toISOString() }));
      await this.writeIndex(rec.provider, (await this.index(rec.provider)).filter((i) => i !== id));
      this.cache.delete(id);
      this.invalidated.delete(id);
      this.unsaved.delete(id);
      this.marks.delete(id);
      this.ledgerRow({ action: 'SUBSCRIPTION_DISCONNECTED', actor, provider: rec.provider, connection: id, connectionName: rec.name, subscriber: rec.subscriberEmail, tier: rec.tier ?? 'unknown', entriesRetired });
      return { ok: true as const, connection: view, entriesRetired };
    });
  }

  // ---- access tokens (M5(6), K3) -------------------------------------------------------------

  /**
   * A current access token for a connection, refreshing as needed (the gatekeeper-egress, where the Executive's adapters run,
   * calls this per request and sends the token only to the template's inference host). Refresh is serialized per grant:
   * concurrent callers share one refresh. Passing `{ invalidate: true }` drops both the in-memory cache and any stored
   * unexpired access token so a single refresh runs (for example after a vendor 401).
   */
  async accessToken(id: string, opts?: { invalidate?: boolean }): Promise<SubscriptionTokenOutcome> {
    if (opts?.invalidate) {
      this.invalidate(id);
    } else {
      const hit = this.cache.get(id);
      if (hit && hit.expiresAtMs - this.skewMs > this.now() && !this.unsaved.has(id) && !this.marks.has(id) && !this.invalidated.has(id)) {
        return { ok: true, accessToken: hit.accessToken, expiresAt: new Date(hit.expiresAtMs).toISOString(), ...(hit.accountId ? { accountId: hit.accountId } : {}) };
      }
    }
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.refresh(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  /** Drop a cached or stored unexpired access token (for example the vendor rejected it) so the next call refreshes once. */
  invalidate(id: string): void {
    this.cache.delete(id);
    if (!this.inflight.has(id)) this.invalidated.add(id);
  }

  private async refresh(id: string): Promise<SubscriptionTokenOutcome> {
    const rec = await this.find(id);
    if (!rec) {
      this.invalidated.delete(id);
      return { ok: false, error: 'unknown_connection', message: `no connection "${id}"` };
    }
    if (rec.status === 'needs_reconsent') {
      this.invalidated.delete(id);
      return { ok: false, error: 'needs_reconsent', connection: id, reason: 'grant_marked' };
    }
    const t = this.templates[rec.templateId];
    if (!t) {
      this.invalidated.delete(id);
      return { ok: false, error: 'unknown_connection', message: `connection ${id} names a template that no longer exists` };
    }

    // A rotated grant whose write failed earlier: persist it before anything else. The refresh token in storage is dead.
    const pending = this.unsaved.get(id);
    if (pending) {
      try {
        await this.locked(() => this.save(pending));
        this.unsaved.delete(id);
      } catch {
        return { ok: false, error: 'connection_unavailable', message: 'the rotated refresh token could not be persisted yet' };
      }
      if (!this.invalidated.has(id)) {
        this.cacheToken(pending);
        const c = this.cache.get(id);
        if (c && c.expiresAtMs - this.skewMs > this.now()) return { ok: true, accessToken: c.accessToken, expiresAt: new Date(c.expiresAtMs).toISOString(), ...(c.accountId ? { accountId: c.accountId } : {}) };
      }
    }
    const current = pending ?? rec;

    // A stored access token (from sign-in) survives a restart unless invalidated (e.g. vendor 401).
    if (!this.invalidated.has(id) && current.accessToken && current.expiresAt && Date.parse(current.expiresAt) - this.skewMs > this.now()) {
      this.cacheToken(current);
      return { ok: true, accessToken: current.accessToken, expiresAt: current.expiresAt, ...(current.accountId ? { accountId: current.accountId } : {}) };
    }

    // The token endpoint is re-validated each time: a stored endpoint outside the vendor's origin never receives a refresh token.
    if (t.signIn.hostRule && !endpointMeetsHostRule(current.tokenUrl, t.signIn.hostRule)) {
      return { ok: false, error: 'connection_unavailable', message: 'the stored token endpoint is outside the vendor origin' };
    }
    if (!t.signIn.hostRule && current.tokenUrl !== t.tokenUrl) {
      return { ok: false, error: 'connection_unavailable', message: 'the stored token endpoint is not the template\'s' };
    }

    // One attempt, never retried (M5(6)).
    const r = await this.post(t, current.tokenUrl, { form: { grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: t.client.id } });
    if (!r) return { ok: false, error: 'connection_unavailable', message: 'token endpoint unreachable' };
    const code = SubscriptionKeymaster.errorCode(r.body);
    if (r.status !== 200 || typeof r.body.access_token !== 'string') {
      // 429 and 5xx are not a refused refresh (the refresh token is still good); a revoked, reused or expired one is.
      if (r.status < 500 && r.status !== 429 && code && REFUSED_CODES.has(code)) {
        await this.markNeedsReconsent(id, current.refreshToken, code);
        return { ok: false, error: 'needs_reconsent', connection: id, reason: code };
      }
      return { ok: false, error: 'connection_unavailable', message: `token refresh failed: ${code ?? `http_${r.status}`}` };
    }
    const body = r.body as unknown as Tokens;
    const expiresAtMs = this.now() + (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000;
    const rotated = typeof body.refresh_token === 'string' && body.refresh_token && body.refresh_token !== current.refreshToken;
    if (rotated) {
      // M5(6): the rotated refresh token is persisted BEFORE the new access token is used, because both vendors rotate
      // single-use refresh tokens. If the write fails the access token is withheld and the rotated grant is kept in memory.
      const claimedId = profileFromTokens(t, body)?.accountId;
      const fresh = { refreshToken: body.refresh_token!, accessToken: body.access_token, expiresAt: new Date(expiresAtMs).toISOString(), ...(claimedId ? { accountId: claimedId } : {}) };
      let committed: SubscriptionRecord | undefined;
      const flow = { state: 'ok' as 'ok' | 'gone' | 'marked' | 'superseded' };
      try {
        await this.locked(async () => {
          const stored = await this.find(id);
          if (!stored) return void (flow.state = 'gone');
          if (stored.refreshToken !== current.refreshToken) return void (flow.state = 'superseded'); // reconnected meanwhile: that grant wins
          if (stored.status !== 'active') return void (flow.state = 'marked');
          // Merge into what is stored NOW: a rename (or other change) made while the vendor answered must survive.
          committed = { ...stored, ...fresh };
          try {
            await this.save(committed);
          } catch (err) {
            this.unsaved.set(id, committed);
            throw err;
          }
          this.invalidated.delete(id);
          this.cacheToken(committed);
        });
      } catch {
        return { ok: false, error: 'connection_unavailable', message: 'the rotated refresh token could not be persisted' };
      }
      if (flow.state === 'superseded') return this.refresh(id);
      if (flow.state === 'gone') return { ok: false, error: 'unknown_connection', message: `no connection "${id}"` };
      if (flow.state === 'marked') return { ok: false, error: 'needs_reconsent', connection: id, reason: 'grant_marked' };
      this.ledgerRow({ action: 'SUBSCRIPTION_REFRESH_TOKEN_ROTATED', actor: 'factory:keymaster', provider: committed!.provider, connection: id });
      return { ok: true, accessToken: committed!.accessToken!, expiresAt: committed!.expiresAt!, ...(committed!.accountId ? { accountId: committed!.accountId } : {}) };
    }
    // No rotation: update the stored access token best-effort and cache it only if the grant is still the live, active one.
    let committedNonRotated: SubscriptionRecord | undefined;
    const flow = { state: 'ok' as 'ok' | 'gone' | 'marked' | 'superseded' };
    await this.locked(async () => {
      const stored = await this.find(id);
      if (!stored) return void (flow.state = 'gone');
      if (stored.refreshToken !== current.refreshToken) return void (flow.state = 'superseded');
      if (stored.status !== 'active') return void (flow.state = 'marked');
      committedNonRotated = { ...stored, accessToken: body.access_token, expiresAt: new Date(expiresAtMs).toISOString() };
      await this.save(committedNonRotated).catch(() => undefined);
      this.invalidated.delete(id);
      this.cacheToken(committedNonRotated);
    });
    if (flow.state === 'superseded') return this.refresh(id);
    if (flow.state === 'gone') return { ok: false, error: 'unknown_connection', message: `no connection "${id}"` };
    if (flow.state === 'marked') return { ok: false, error: 'needs_reconsent', connection: id, reason: 'grant_marked' };
    return { ok: true, accessToken: committedNonRotated!.accessToken!, expiresAt: committedNonRotated!.expiresAt!, ...(committedNonRotated!.accountId ? { accountId: committedNonRotated!.accountId } : {}) };
  }

  private async markNeedsReconsent(id: string, usedRefreshToken: string, reason: string) {
    this.cache.delete(id);
    this.invalidated.delete(id);
    let view: SubscriptionView | undefined;
    await this.locked(async () => {
      const rec = await this.find(id);
      // A reconnect that landed while we refreshed has a different refresh token: leave it alone.
      if (!rec || rec.refreshToken !== usedRefreshToken || rec.status === 'needs_reconsent') return;
      const at = new Date(this.now()).toISOString();
      const marked: SubscriptionRecord = { ...rec, status: 'needs_reconsent', statusAt: at, accessToken: undefined, expiresAt: undefined };
      try {
        await this.save(marked);
        this.marks.delete(id);
      } catch (err) {
        // Keep the mark in memory so the dead refresh token is never retried and the connection reads as needing re-consent.
        this.marks.set(id, { refreshToken: usedRefreshToken, at });
        console.error(`[keymaster] could not mark subscription ${id} needs_reconsent: ${err instanceof Error ? err.message : String(err)}`);
      }
      view = SubscriptionKeymaster.view(marked);
      this.ledgerRow({ action: 'SUBSCRIPTION_NEEDS_RECONSENT', actor: 'factory:keymaster', provider: rec.provider, connection: id, connectionName: rec.name, subscriber: rec.subscriberEmail, tier: rec.tier ?? 'unknown' });
    });
    if (view && this.onNeedsReconsent) {
      try {
        await this.onNeedsReconsent({ connection: view, reason });
      } catch (err) {
        console.error(`[keymaster] notifying admins about ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
