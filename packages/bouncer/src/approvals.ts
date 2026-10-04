import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'consumed';

/**
 * E9: the reviewable copy of a held request: exactly what the gatekeeper-egress will send on release, minus the
 * credential it injects then. `body` is UTF-8 text, or base64 when `bodyEncoding` says so.
 */
export type HeldRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  /** How the console renders it (e.g. `linkedin-post`); absent: the raw request. */
  preview?: string;
};

export type Approval = {
  approvalId: string;
  runId: string;
  agentId: string;
  route: string;
  tool: string;
  argsSha256: string;
  state: ApprovalState;
  requestedAt: string;
  /** `held`: a request in a person's name (E9), bound to the agent rather than the run. Absent: an MCP tool call. */
  kind?: 'held';
  request?: HeldRequest;
  decidedBy?: string;
  decidedAt?: string;
  /** The approver's notes, delivered to the agent with the decision (e.g. what to change). */
  notes?: string;
};

/** Human-in-the-loop holds for tool calls marked requireApproval and held requests (E9). One approval releases one call. */
export class ApprovalStore {
  private readonly items = new Map<string, Approval>();

  constructor(private readonly dir?: string) {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const a = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Approval;
      this.items.set(a.approvalId, a);
    }
  }

  /** Idempotent: the same run/route/tool/args returns the open (pending or approved) request. */
  request(k: Pick<Approval, 'runId' | 'agentId' | 'route' | 'tool' | 'argsSha256'>): { approval: Approval; created: boolean } {
    for (const a of this.items.values()) {
      if (a.kind !== 'held' && a.runId === k.runId && a.route === k.route && a.tool === k.tool && a.argsSha256 === k.argsSha256) {
        if (a.state === 'pending' || a.state === 'approved') return { approval: { ...a }, created: false };
      }
    }
    const a: Approval = { ...k, approvalId: randomUUID(), state: 'pending', requestedAt: new Date().toISOString() };
    this.save(a);
    return { approval: { ...a }, created: true };
  }

  /**
   * E9: the hold for this agent's identical request (same route and hash). An open one (pending or approved) is
   * returned as is; a rejected one is returned so the identical request is refused, not asked again; otherwise (none,
   * or the last one was used) a new pending hold is created.
   */
  hold(k: Pick<Approval, 'runId' | 'agentId' | 'route' | 'tool' | 'argsSha256'> & { request: HeldRequest }): { approval: Approval; created: boolean } {
    let rejected: Approval | undefined;
    for (const a of this.items.values()) {
      if (a.kind !== 'held' || a.agentId !== k.agentId || a.route !== k.route || a.argsSha256 !== k.argsSha256) continue;
      if (a.state === 'pending' || a.state === 'approved') return { approval: { ...a }, created: false };
      if (a.state === 'rejected' && (!rejected || a.requestedAt > rejected.requestedAt)) rejected = a;
    }
    if (rejected) return { approval: { ...rejected }, created: false };
    const a: Approval = { ...k, kind: 'held', approvalId: randomUUID(), state: 'pending', requestedAt: new Date().toISOString() };
    this.save(a);
    return { approval: { ...a }, created: true };
  }

  get(id: string): Approval | undefined {
    const a = this.items.get(id);
    return a ? { ...a } : undefined;
  }

  list(filter: { state?: ApprovalState; runId?: string } = {}): Approval[] {
    return [...this.items.values()].filter((a) => (!filter.state || a.state === filter.state) && (!filter.runId || a.runId === filter.runId));
  }

  decide(id: string, decision: 'approved' | 'rejected', actor: string, notes?: string): Approval | undefined {
    const a = this.items.get(id);
    if (!a || a.state !== 'pending') return undefined;
    const next = { ...a, state: decision, decidedBy: actor, decidedAt: new Date().toISOString(), ...(notes ? { notes } : {}) };
    this.save(next);
    return { ...next };
  }

  consume(id: string): Approval | undefined {
    const a = this.items.get(id);
    if (!a || a.state !== 'approved') return undefined;
    const next = { ...a, state: 'consumed' as const };
    this.save(next);
    return { ...next };
  }

  private save(a: Approval) {
    this.items.set(a.approvalId, a);
    if (!this.dir) return;
    const path = join(this.dir, `${a.approvalId}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(a));
    renameSync(tmp, path);
  }
}
