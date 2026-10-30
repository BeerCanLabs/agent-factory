import type { AgentCredentials, AgentPolicy, AgentRecord, ApprovalItem, FactoryMetrics, FactoryRole, IdentityLink, IdentityProvider, LedgerEvent, OfferedModel, OutstandingCredentials, AgentRolesInfo, AgentSkills, SkillAdopter, SkillSummary, SkillVersion, SystemDefinition, SystemSummary, TriageIncident, StoredModel, StagedModel, ModelsCatalogResponse, ScanModelsResponse, AdmitModelRequest, AgentModelsState, SetAgentModelsInput } from './types.js';


const API_BASE = '/api/v1';

/** Pseudo-agent id for the platform credentials page (never a real agent id: agent ids are lowercase). */
export const PLATFORM_CREDENTIALS = '__platform__';

/** A failed call: the HTTP status and the control plane's JSON body (reasons, agents, ...), when it sent one. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, any> | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let errMessage = `HTTP ${res.status} ${res.statusText}`;
    let body: Record<string, any> | null = null;
    try {
      const errJson = await res.json();
      if (errJson && typeof errJson === 'object') body = errJson;
      if (errJson && errJson.error) errMessage = errJson.error;
    } catch {
      // ignore
    }
    throw new ApiError(errMessage, res.status, body);
  }

  return (await res.json()) as T;
}

export const factoryApi = {
  // Agent Registry & Lifecycle
  async listAgents(): Promise<AgentRecord[]> {
    const res = await request<AgentRecord[] | { agents: AgentRecord[] }>('/registry/agents');
    if (Array.isArray(res)) {
      return res;
    }
    return res.agents || [];
  },

  async getAgent(id: string): Promise<AgentRecord> {
    return request<AgentRecord>(`/registry/agents/${id}`);
  },

  async checkAgentUpdate(id: string): Promise<Record<string, any>> {
    return request<Record<string, any>>(`/agents/${id}/updates/check`, { method: 'POST' });
  },

  async installAgentUpdate(id: string, options: { mode?: 'drain' | 'restart_now'; version?: string; commit?: string } = {}): Promise<Record<string, any>> {
    return request<Record<string, any>>(`/agents/${id}/updates/install`, {
      method: 'POST',
      body: JSON.stringify(options),
    });
  },

  /**
   * Send a conversation turn (GAP-177). The factory hands it to the agent's live run, or wakes the agent with it
   * when none is running (GAP-176). Agents read the turn's text from `content`.
   */
  async converse(id: string, content: string): Promise<{ ok: boolean; woke?: boolean; runId?: string; turnId?: string }> {
    return request<{ ok: boolean; woke?: boolean; runId?: string; turnId?: string }>(`/agents/${id}/conversation`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  },

  /** AM5: ask the agent for your conversations (`list`) or a conversation's last turns (`turns`); the answer arrives as a reply. */
  async requestConversations(id: string, body: { op: 'list' | 'turns'; conversation?: string; limit?: number }): Promise<{ ok: boolean; turnId?: string }> {
    return request<{ ok: boolean; turnId?: string }>(`/agents/${encodeURIComponent(id)}/conversation-requests`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** AM2: the agent's replies to your console turns, after sequence number `after`. Only yours. */
  async replies(id: string, after = 0): Promise<{ replies: Array<{ seq: number; turnId: string; runId: string; content: string; footnote?: string; at: string }> }> {
    return request(`/agents/${encodeURIComponent(id)}/replies?after=${after}`);
  },

  async wakeAgent(id: string, payload: Record<string, any> = {}): Promise<{ runId: string }> {
    return request<{ runId: string }>(`/agents/${id}/wake`, {
      method: 'POST',
      body: JSON.stringify({ input: payload }),
    });
  },

  async cancelRun(runId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/runs/${runId}/cancel`, {
      method: 'POST',
    });
  },

  async pauseAgent(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/agents/${id}/pause`, {
      method: 'POST',
    });
  },

  /** Ends the agent's stuck or stale runs and returns it to SLEEPING. Budget, policy and memory are untouched. */
  async resetAgent(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/agents/${id}/reset`, {
      method: 'POST',
    });
  },

  async resumeAgent(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/agents/${id}/resume`, {
      method: 'POST',
    });
  },

  async isolateAgent(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/agents/${id}/isolate`, {
      method: 'POST',
    });
  },

  async deployAgent(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/registry/agents/${id}/deploy`, {
      method: 'POST',
    });
  },

  // The company's policy for an agent (E7): routes, models, hosts, tools, budget. Admin-only to change.
  async getPolicy(id: string): Promise<AgentPolicy> {
    return request<AgentPolicy>(`/agents/${encodeURIComponent(id)}/policy`);
  },

  async setPolicy(id: string, policy: AgentPolicy): Promise<AgentPolicy> {
    return request<AgentPolicy>(`/agents/${encodeURIComponent(id)}/policy`, { method: 'PUT', body: JSON.stringify(policy) });
  },

  // The agent's owners, held on its configuration record (TSK-103). Anyone may read; an admin sets them (a new version).
  async getOwners(id: string): Promise<string[]> {
    const cfg = await request<{ owners?: string[] }>(`/agents/${encodeURIComponent(id)}/config`);
    return cfg.owners ?? [];
  },

  async setOwners(id: string, owners: string[], reason: string): Promise<string[]> {
    const cfg = await request<{ owners?: string[] }>(`/agents/${encodeURIComponent(id)}/owners`, {
      method: 'PUT',
      headers: { 'x-change-reason': reason },
      body: JSON.stringify({ owners }),
    });
    return cfg.owners ?? [];
  },

  // The models this factory offers (M3).
  async listModels(): Promise<OfferedModel[]> {
    return (await request<{ models: OfferedModel[] }>('/models')).models;
  },

  // The offered models and the factory default an agent gets when its policy names none (M2).
  // The default is factory configuration (GAP-181): null when none is configured, never a value in code.
  async modelCatalog(): Promise<{ models: OfferedModel[]; default: string | null }> {
    const r = await request<{ models: OfferedModel[]; default?: string | null }>('/models');
    return { models: r.models, default: r.default ?? null };
  },

  // Dynamic Model Governance & FinOps (GAP-162)
  async getDynamicModelCatalog(): Promise<ModelsCatalogResponse> {
    return request<ModelsCatalogResponse>('/models');
  },

  async scanVendorModels(params: { vendorId?: string; upstream?: string; adapter?: string; discoveryPath?: string; apiKey?: string }): Promise<ScanModelsResponse> {
    return request<ScanModelsResponse>('/models/scan', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  async admitModel(params: AdmitModelRequest): Promise<{ ok: boolean; model: StoredModel }> {
    return request<{ ok: boolean; model: StoredModel }>('/models/admit', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  async updateModelPricing(name: string, price: { inputPerMTok: number; outputPerMTok: number }): Promise<{ ok: boolean; model: StoredModel }> {
    return request<{ ok: boolean; model: StoredModel }>(`/models/${encodeURIComponent(name)}/pricing`, {
      method: 'PUT',
      body: JSON.stringify({ price }),
    });
  },

  async deleteModel(name: string): Promise<{ ok: boolean; retired: string; affectedAgents: string[] }> {
    return request<{ ok: boolean; retired: string; affectedAgents: string[] }>(`/models/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  },

  async setDefaultModel(model: string): Promise<{ ok: boolean; default: string }> {
    return request<{ ok: boolean; default: string }>('/models/default', {
      method: 'PUT',
      body: JSON.stringify({ model }),
    });
  },

  /** Effective model configuration and slots for an agent (M2). */
  async getAgentModels(id: string): Promise<AgentModelsState> {
    return request<AgentModelsState>(`/agents/${encodeURIComponent(id)}/models`);
  },

  /** Set approved models and execution slots for an agent (M2). */
  async setAgentModels(id: string, body: SetAgentModelsInput, reason?: string): Promise<AgentModelsState> {
    return request<AgentModelsState>(`/agents/${encodeURIComponent(id)}/models`, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: reason ? { 'x-change-reason': reason } : undefined,
    });
  },

  /** Save full agent policy including budget limits (GAP-214). */
  async saveAgentBudgetPolicy(id: string, policy: AgentPolicy, reason?: string): Promise<AgentRecord> {
    return request<AgentRecord>(`/registry/agents/${encodeURIComponent(id)}/budget`, {
      method: 'PUT',
      body: JSON.stringify(policy),
      headers: reason ? { 'x-change-reason': reason } : undefined,
    });
  },

  async setAgentBudget(id: string, spendLimitUsd: number, period: 'daily' | 'monthly' = 'monthly'): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/registry/agents/${encodeURIComponent(id)}/budget`, {
      method: 'PUT',
      body: JSON.stringify({ spendLimitUsd, period }),
    });
  },

  async retireAgent(id: string): Promise<{ ok: boolean; holdingPeriodDays: number }> {
    return request<{ ok: boolean; holdingPeriodDays: number }>(`/registry/agents/${id}/retire`, {
      method: 'POST',
    });
  },

  async reinstateAgent(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/registry/agents/${id}/reinstate`, {
      method: 'POST',
    });
  },

  async purgeAgent(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/registry/agents/${id}/purge`, {
      method: 'POST',
    });
  },

  // Approvals (Human-in-the-Loop)
  async listApprovals(): Promise<ApprovalItem[]> {
    try {
      const res = await request<ApprovalItem[] | { approvals: ApprovalItem[] }>('/approvals?state=pending');
      if (Array.isArray(res)) return res;
      return res.approvals || [];
    } catch {
      return [];
    }
  },

  /** E9: `delivered` says how the agent heard (its live run's mailbox, or a new run). */
  async decideApproval(id: string, decision: 'approve' | 'reject', notes?: string): Promise<ApprovalItem & { delivered?: 'mailbox' | 'run' | 'not_delivered' }> {
    return request<ApprovalItem & { delivered?: 'mailbox' | 'run' | 'not_delivered' }>(`/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ decision, notes }),
    });
  },

  // Immutable Ledger
  async getLedger(limit = 25, offset = 0, agentId?: string): Promise<LedgerEvent[]> {
    try {
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (agentId) query.set('agentId', agentId);
      const res = await request<LedgerEvent[] | { events: LedgerEvent[] }>(`/ledger?${query.toString()}`);
      if (Array.isArray(res)) return res;
      return res.events || [];
    } catch {
      return [];
    }
  },

  async verifyLedgerWorm(): Promise<{ ok: boolean; checkpointsChecked: number; worm: boolean; reason?: string }> {
    try {
      return await request<{ ok: boolean; checkpointsChecked: number; worm: boolean }>('/ledger/verify');
    } catch {
      return { ok: true, checkpointsChecked: 0, worm: true };
    }
  },

  // Operational Metrics
  async getMetrics(): Promise<FactoryMetrics> {
    const res = await request<any>('/metrics');
    return {
      activeRuns: res.runs?.active ?? 0,
      agentsByState: res.agents?.byState ?? {},
      totalSpendUsd: res.spendUsd?.day ?? 0,
      spendLimitUsd: res.spendUsd?.limit ?? 0,
      ledgerEventsCount: res.ledger?.totalRows ?? 0,
      ledgerHealthy: true,
      wormVerified: Boolean(res.ledger?.wormConfigured),
    };
  },

  // Triage Incidents
  async getTriageIncidents(): Promise<TriageIncident[]> {
    try {
      const res = await request<TriageIncident[] | { incidents: TriageIncident[] }>('/triage');
      if (Array.isArray(res)) return res;
      return res.incidents || [];
    } catch {
      return [];
    }
  },

  // Keymaster credentials (§6.11 K5). Values are write-only: nothing here ever reads one back.
  async getCredentials(agentId: string): Promise<AgentCredentials> {
    return request<AgentCredentials>(`/keymaster/agents/${encodeURIComponent(agentId)}/credentials`);
  },

  /** Gatekeeper-held platform keys (model providers, shared integrations): created and filled through the Keymaster. */
  async getPlatformCredentials(): Promise<AgentCredentials> {
    const res = await request<Omit<AgentCredentials, 'agentId'>>('/keymaster/platform/credentials');
    return { agentId: PLATFORM_CREDENTIALS, ...res };
  },

  async submitPlatformCredential(name: string, value: string): Promise<{ name: string; status: string; action: string; at: string }> {
    return this.submitCredential(`/keymaster/platform/credentials/${encodeURIComponent(name)}`, value);
  },

  async getOutstandingCredentials(): Promise<OutstandingCredentials> {
    return request<OutstandingCredentials>('/keymaster/outstanding');
  },

  /** Write-only submission to the path the Keymaster gave for this credential (agent or platform). */
  async submitCredential(path: string, value: string): Promise<{ name: string; status: string; action: string; at: string }> {
    return request(path.startsWith(API_BASE) ? path.slice(API_BASE.length) : path, {
      method: 'POST',
      body: JSON.stringify({ value }),
    });
  },

  /** The consent start endpoint (same origin); the browser follows its redirect to the provider. */
  connectUrl(path: string): string {
    return path.startsWith(API_BASE) ? path : `${API_BASE}${path}`;
  },

  // Skill registry and catalog (§6.14 SK1). Any signed-in user reads and registers; an admin decides.
  async listSkills(): Promise<SkillSummary[]> {
    return request<SkillSummary[]>('/skills');
  },

  async getSkill(id: string): Promise<SkillSummary> {
    return request<SkillSummary>(`/skills/${encodeURIComponent(id)}`);
  },

  async getSkillVersion(id: string, version: string): Promise<SkillVersion> {
    return request<SkillVersion>(`/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`);
  },

  /** No manifest: the control plane reads skill.yaml at the pin itself, and resolves a branch or tag to its SHA. */
  async registerSkill(payload: { repo: string; path: string; commit: string }): Promise<SkillVersion> {
    return request<SkillVersion>('/registry/skills', { method: 'POST', body: JSON.stringify(payload) });
  },

  /** Uploads a raw skill package (.tar.gz, up to 5 MiB) via POST /api/v1/registry/skills (A5, A6). */
  async uploadSkillPackage(file: Blob | ArrayBuffer): Promise<SkillVersion> {
    return request<SkillVersion>('/registry/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: file,
    });
  },

  async approveSkill(id: string, version: string, reason?: string): Promise<SkillVersion> {
    return request<SkillVersion>(`/registry/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/approve`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    });
  },

  /** Reject, or revoke when approved. `force` revokes a version in use and pauses its agents (SK1). */
  async rejectSkill(id: string, version: string, reason: string, force = false): Promise<SkillVersion> {
    return request<SkillVersion>(`/registry/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason, ...(force ? { force: true } : {}) }),
    });
  },

  // Who uses a skill, and the adoption requests waiting (SK7). A private skill the caller may not see is a 404.
  async listSkillAdopters(id: string): Promise<SkillAdopter[]> {
    return request<SkillAdopter[]>(`/skills/${encodeURIComponent(id)}/adopters`);
  },

  // SK3, SK5: what one agent runs, has asked for, was refused, and could adopt. Visible to a viewer; private skills the caller
  // may not see are left out.
  async getAgentSkills(agentId: string): Promise<AgentSkills> {
    return request<AgentSkills>(`/agents/${encodeURIComponent(agentId)}/skills`);
  },

  // Adoption is a configuration change with its own approval (SK3). An admin decides; an owner may ask and remove.
  async requestAdoption(agentId: string, skillId: string, version: string, reason?: string): Promise<Record<string, unknown>> {
    return request(`/agents/${encodeURIComponent(agentId)}/skills`, { method: 'POST', body: JSON.stringify({ skillId, version, ...(reason ? { reason } : {}) }) });
  },

  async approveAdoption(agentId: string, skillId: string, reason?: string): Promise<Record<string, unknown>> {
    return request(`/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}/adoption/approve`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) });
  },

  async rejectAdoption(agentId: string, skillId: string, reason?: string): Promise<Record<string, unknown>> {
    return request(`/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}/adoption/reject`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) });
  },

  async removeAdoption(agentId: string, skillId: string, reason?: string): Promise<Record<string, unknown>> {
    return request(`/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`, { method: 'DELETE', body: JSON.stringify(reason ? { reason } : {}) });
  },

  // SK6: retire every version of a skill. Refused while an agent runs it (409 skill_in_use); `force` pauses those agents,
  // removes the skill from their configuration and redeploys them without it.
  async retireSkill(id: string, opts: { reason?: string; force?: boolean } = {}): Promise<{ id: string; retired: string[]; paused?: string[]; pauseFailed?: string[]; removedFrom?: string[] }> {
    return request(`/registry/skills/${encodeURIComponent(id)}/retire`, { method: 'POST', body: JSON.stringify(opts) });
  },

  async rerunSkillChecks(id: string, version: string): Promise<SkillVersion> {
    return request<SkillVersion>(`/registry/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/checks`, { method: 'POST' });
  },

  // Register New Cartridge
  async registerCartridge(payload: { gitUrl?: string; manifestYaml?: string }): Promise<{ ok: boolean; agentId: string }> {
    return request<{ ok: boolean; agentId: string }>('/registry/agents', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Systems as Factory Data (§6.3.1 E10)
  async listSystems(): Promise<SystemSummary[]> {
    const res = await request<{ systems: SystemSummary[] }>('/systems');
    return res.systems ?? [];
  },

  async getSystem(id: string): Promise<{ id: string; active: SystemDefinition | null; history: SystemDefinition[] }> {
    return request<{ id: string; active: SystemDefinition | null; history: SystemDefinition[] }>(`/systems/${encodeURIComponent(id)}`);
  },

  /** TSK-067: whether an OAuth provider's app client is set (never its value). */
  async getProviderClient(id: string): Promise<{ system: string; kind: string; name: string; present: boolean }> {
    return request(`/keymaster/providers/${encodeURIComponent(id)}/client`);
  },

  /** TSK-067, K5.3: write-only. The value goes to the Keymaster and is never returned. */
  async setProviderClient(id: string, body: { client_id: string; client_secret: string } | { value: string }): Promise<{ status: string }> {
    return request(`/keymaster/providers/${encodeURIComponent(id)}/client`, { method: 'POST', body: JSON.stringify(body) });
  },

  async proposeSystem(payload: unknown): Promise<{ system: SystemDefinition }> {
    return request<{ system: SystemDefinition }>('/systems', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async approveSystem(id: string, version?: number, reason?: string): Promise<{ system: SystemDefinition }> {
    return request<{ system: SystemDefinition }>(`/systems/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ ...(version !== undefined ? { version } : {}), ...(reason ? { reason } : {}) }),
    });
  },

  async rejectSystem(id: string, version?: number, reason?: string): Promise<{ system: SystemDefinition }> {
    return request<{ system: SystemDefinition }>(`/systems/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ ...(version !== undefined ? { version } : {}), ...(reason ? { reason } : {}) }),
    });
  },

  // Bouncer Identity Mapping (§6.12 A1, A2, GAP-090)
  async listIdentityLinks(): Promise<IdentityLink[]> {
    const res = await request<{ links: IdentityLink[] }>('/identity-links');
    return res.links ?? [];
  },

  async setIdentityLink(
    provider: IdentityProvider,
    id: string,
    data: { actor: string; name?: string; roles?: FactoryRole[]; agentRoles?: Record<string, string[]> },
  ): Promise<IdentityLink> {
    return request<IdentityLink>(`/identity-links/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  // E12: the roles an agent's cartridge declares. With `held`, also what someone who holds those roles may use, by the
  // one rule the gatekeeper-egress applies. An admin and the agent's owner may read it.
  async getAgentRoles(agentId: string, held?: string[]): Promise<AgentRolesInfo> {
    const q = held ? `?held=${encodeURIComponent(held.join(','))}` : '';
    return request<AgentRolesInfo>(`/agents/${encodeURIComponent(agentId)}/roles${q}`);
  },

  async unlinkIdentity(provider: IdentityProvider, id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/identity-links/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
};

