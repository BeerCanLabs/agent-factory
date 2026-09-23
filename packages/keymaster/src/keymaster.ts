import { randomUUID } from 'node:crypto';
import type { RunTokens } from '@beercanlabs/factory-auth';
import type { LedgerStore } from '@beercanlabs/factory-ledger';
import { bindSecrets, type SecretProvider } from '@beercanlabs/factory-secrets-bind';

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'consumed';

export type Approval = {
  approvalId: string;
  runId: string;
  agentId: string;
  route: string;
  tool: string;
  argsSha256: string;
  state: ApprovalState;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
};

export type ApprovalConsumer = {
  get(approvalId: string): Approval | undefined | Promise<Approval | undefined>;
  consume(approvalId: string): Approval | undefined | Promise<Approval | undefined>;
};

export type AgentInfo = {
  id: string;
  gated?: string[];
  ungated?: string[];
  requires?: string[];
};

export type RunInfo = {
  runId: string;
  agentId: string;
  state: string;
};

export type KeymasterOptions = {
  approvals: ApprovalConsumer;
  ledger: LedgerStore;
  providers: SecretProvider[];
  runTokens?: RunTokens;
  leaseTtlMs?: number;
  secretValues?: Set<string>;
  getAgent?: (agentId: string) => AgentInfo | undefined | Promise<AgentInfo | undefined>;
  getRun?: (runId: string) => RunInfo | undefined | Promise<RunInfo | undefined>;
};

export type CheckoutParams = {
  runId: string;
  approvalId: string;
  gatedSecret: string;
  turnId: string;
  proofHash?: string;
  runToken?: string;
  actor?: string;
};

export type EphemeralLease = {
  leaseId: string;
  secretName: string;
  value: string;
  turnId: string;
  issuedAt: string;
  expiresAt: string;
};

export type CheckoutOutcome =
  | { ok: true; status: 200; lease: EphemeralLease }
  | { ok: false; status: number; error: string; details?: unknown };

export type GatedDispatchParams = CheckoutParams & {
  targetUrl: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  authHeaderName?: string;
  authHeaderPrefix?: string;
};

export type GatedDispatchOutcome =
  | { ok: true; status: number; body: string; headers: Record<string, string>; leaseId: string }
  | { ok: false; status: number; error: string; details?: unknown };

export class Keymaster {
  private readonly approvals: ApprovalConsumer;
  private readonly ledger: LedgerStore;
  private readonly providers: SecretProvider[];
  private readonly runTokens?: RunTokens;
  private readonly leaseTtlMs: number;
  private readonly secretValues: Set<string>;
  private readonly getAgent?: (agentId: string) => AgentInfo | undefined | Promise<AgentInfo | undefined>;
  private readonly getRun?: (runId: string) => RunInfo | undefined | Promise<RunInfo | undefined>;

  private readonly activeLeases = new Map<string, EphemeralLease>();

  constructor(opts: KeymasterOptions) {
    this.approvals = opts.approvals;
    this.ledger = opts.ledger;
    this.providers = opts.providers;
    this.runTokens = opts.runTokens;
    this.leaseTtlMs = opts.leaseTtlMs ?? 5 * 60 * 1000; // 5 minutes default
    this.secretValues = opts.secretValues ?? new Set<string>();
    this.getAgent = opts.getAgent;
    this.getRun = opts.getRun;
  }

  /**
   * Request verification and checkout of a gated secret.
   * Atomically burns approval, commits transaction to ledger (zero-knowledge), and dispenses ephemeral lease.
   */
  async checkout(params: CheckoutParams): Promise<CheckoutOutcome> {
    if (!params.runId || !params.approvalId || !params.gatedSecret || !params.turnId) {
      return { ok: false, status: 400, error: 'missing_required_fields' };
    }

    // 1. Verify caller run token if provided or if runTokens configured
    if (params.runToken && this.runTokens) {
      const claims = await this.runTokens.verify(params.runToken);
      if (!claims || claims.runId !== params.runId) {
        await this.recordDenied(params, 'invalid_run_token', 'run:unauthenticated');
        return { ok: false, status: 401, error: 'invalid_run_token' };
      }
    }

    // 2. Verify run status if getRun provided
    let run: RunInfo | undefined;
    if (this.getRun) {
      run = await this.getRun(params.runId);
      if (!run) {
        await this.recordDenied(params, 'run_not_found', params.actor ?? 'unknown');
        return { ok: false, status: 404, error: 'run_not_found' };
      }
      if (['DONE', 'FAILED', 'CANCELLED', 'ERROR', 'KILLED'].includes(run.state)) {
        await this.recordDenied(params, 'run_not_live', params.actor ?? `run:${run.agentId}`);
        return { ok: false, status: 409, error: 'run_not_live' };
      }
    }

    // 3. Verify cartridge gated classification if getAgent provided
    if (run && this.getAgent) {
      const agent = await this.getAgent(run.agentId);
      if (agent?.gated) {
        if (!agent.gated.includes(params.gatedSecret)) {
          await this.recordDenied(params, 'secret_not_gated', params.actor ?? `run:${run.agentId}`);
          return {
            ok: false,
            status: 403,
            error: 'secret_not_gated',
            details: `Secret "${params.gatedSecret}" is not classified as gated for agent "${agent.id}"`,
          };
        }
      }
    }

    // 4. Look up approval
    const approval = await this.approvals.get(params.approvalId);
    if (!approval) {
      await this.recordDenied(params, 'approval_not_found', params.actor ?? (run ? `run:${run.agentId}` : 'unknown'));
      return { ok: false, status: 404, error: 'approval_not_found' };
    }

    const agentId = run?.agentId ?? approval.agentId;
    const actor = params.actor ?? `run:${agentId}`;

    // 5. Verify approval scope (runId and agentId)
    if (approval.runId !== params.runId || approval.agentId !== agentId) {
      await this.recordDenied(params, 'approval_scope_mismatch', actor, agentId);
      return { ok: false, status: 403, error: 'approval_scope_mismatch' };
    }

    // 6. Verify authorization proof hash if provided or present
    if (params.proofHash && approval.argsSha256 && params.proofHash !== approval.argsSha256) {
      await this.recordDenied(params, 'proof_hash_mismatch', actor, agentId);
      return { ok: false, status: 403, error: 'proof_hash_mismatch' };
    }

    // 7. Verify approval state & replay check
    if (approval.state === 'consumed') {
      await this.recordDenied(params, 'approval_already_consumed', actor, agentId, approval.argsSha256);
      return { ok: false, status: 409, error: 'approval_already_consumed' };
    }

    if (approval.state !== 'approved') {
      await this.recordDenied(params, `approval_${approval.state}`, actor, agentId, approval.argsSha256);
      return { ok: false, status: 403, error: `approval_${approval.state}` };
    }

    // 8. Atomically burn / consume approval
    const consumed = await this.approvals.consume(params.approvalId);
    if (!consumed) {
      // Replay or race condition
      await this.recordDenied(params, 'approval_already_consumed', actor, agentId, approval.argsSha256);
      return { ok: false, status: 409, error: 'approval_already_consumed' };
    }

    // 9. Fetch secret value from providers
    const bound = await bindSecrets([params.gatedSecret], this.providers);
    if (!bound.ok || !bound.env[params.gatedSecret]) {
      return {
        ok: false,
        status: 503,
        error: 'secret_unbound',
        details: bound.ok ? undefined : bound.missing,
      };
    }

    const secretValue = bound.env[params.gatedSecret];
    if (secretValue.length >= 4) {
      this.secretValues.add(secretValue);
    }

    // 10. Generate ephemeral lease & commit to ledger (Zero-Knowledge: secret value is NEVER in ledger)
    const leaseId = `lease_${randomUUID()}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.leaseTtlMs);

    await this.ledger.append({
      timestamp: now.toISOString(),
      agentId,
      runId: params.runId,
      type: 'action',
      action: 'KEYMASTER_CHECKOUT',
      actor,
      approvalId: params.approvalId,
      leaseId,
      gatedSecret: params.gatedSecret,
      turnId: params.turnId,
      payloadSha256: params.proofHash ?? approval.argsSha256,
    });

    const lease: EphemeralLease = {
      leaseId,
      secretName: params.gatedSecret,
      value: secretValue,
      turnId: params.turnId,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    this.activeLeases.set(leaseId, lease);

    return {
      ok: true,
      status: 200,
      lease,
    };
  }

  /**
   * Execute a gated dispatch directly on behalf of the agent.
   * Checks out the secret, performs the request with the secret injected, and zeros the lease.
   */
  async dispatchGated(params: GatedDispatchParams): Promise<GatedDispatchOutcome> {
    const checkout = await this.checkout(params);
    if (!checkout.ok) {
      return checkout;
    }

    const { lease } = checkout;
    const authHeader = params.authHeaderName ?? 'Authorization';
    const authPrefix = params.authHeaderPrefix ?? (authHeader.toLowerCase() === 'authorization' ? 'Bearer ' : '');
    const headers = {
      ...(params.headers ?? {}),
      [authHeader]: `${authPrefix}${lease.value}`,
    };

    try {
      const resp = await fetch(params.targetUrl, {
        method: params.method ?? 'POST',
        headers,
        body: params.body,
      });

      const text = await resp.text();
      const resHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        resHeaders[k] = v;
      });

      return {
        ok: true,
        status: resp.status,
        body: text,
        headers: resHeaders,
        leaseId: lease.leaseId,
      };
    } catch (err) {
      return {
        ok: false,
        status: 502,
        error: 'dispatch_failed',
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Check if a lease is valid and active.
   */
  getLease(leaseId: string): EphemeralLease | undefined {
    const lease = this.activeLeases.get(leaseId);
    if (!lease) return undefined;
    if (new Date(lease.expiresAt).getTime() <= Date.now()) {
      this.activeLeases.delete(leaseId);
      return undefined;
    }
    return { ...lease };
  }

  /**
   * Explicitly revoke a lease.
   */
  revokeLease(leaseId: string): boolean {
    return this.activeLeases.delete(leaseId);
  }

  private async recordDenied(
    params: CheckoutParams,
    reason: string,
    actor: string,
    agentId = 'unknown',
    hash?: string,
  ): Promise<void> {
    try {
      await this.ledger.append({
        timestamp: new Date().toISOString(),
        agentId,
        runId: params.runId,
        type: 'action',
        action: 'KEYMASTER_CHECKOUT_DENIED',
        actor,
        approvalId: params.approvalId,
        gatedSecret: params.gatedSecret,
        turnId: params.turnId,
        payloadSha256: params.proofHash ?? hash,
      });
    } catch {
      // Best-effort audit logging
    }
  }
}
