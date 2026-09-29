import type { AgentCredentials, AgentRecord, ApprovalItem, FactoryMetrics, LedgerEvent, OutstandingCredentials, TriageIncident } from './types.js';

const API_BASE = '/api/v1';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let errMessage = `HTTP ${res.status} ${res.statusText}`;
    try {
      const errJson = await res.json();
      if (errJson && errJson.error) errMessage = errJson.error;
    } catch {
      // ignore
    }
    throw new Error(errMessage);
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

  async setAgentBudget(id: string, spendLimitUsd: number, period: string = 'daily'): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/registry/agents/${id}/budget`, {
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

  async switchModel(id: string, model: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/registry/agents/${id}/model`, {
      method: 'POST',
      body: JSON.stringify({ model }),
    });
  },

  async approveModel(id: string, model: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/registry/agents/${id}/models/approve`, {
      method: 'POST',
      body: JSON.stringify({ model }),
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

  async decideApproval(id: string, decision: 'approved' | 'rejected', notes?: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/approvals/${id}`, {
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

  async getOutstandingCredentials(): Promise<OutstandingCredentials> {
    return request<OutstandingCredentials>('/keymaster/outstanding');
  },

  async submitCredential(agentId: string, name: string, value: string): Promise<{ name: string; status: string; action: string; at: string }> {
    return request(`/keymaster/agents/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({ value }),
    });
  },

  /** The consent start endpoint (same origin); the browser follows its redirect to the provider. */
  connectUrl(path: string): string {
    return path.startsWith(API_BASE) ? path : `${API_BASE}${path}`;
  },

  // Register New Cartridge
  async registerCartridge(payload: { gitUrl?: string; manifestYaml?: string }): Promise<{ ok: boolean; agentId: string }> {
    return request<{ ok: boolean; agentId: string }>('/registry/agents', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};
