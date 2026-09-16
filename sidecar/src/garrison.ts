/** Optional overlay sink. Factory must boot and record without this. */

export type GarrisonConfig = {
  enabled: boolean;
  url: string;
  agentId: string;
  agentName: string;
  role: string;
  model: string;
  provider: string;
};

export function garrisonFromEnv(env: NodeJS.ProcessEnv): GarrisonConfig {
  const sinks = (env.TELEMETRY_SINKS ?? '').split(',').map((s) => s.trim().toLowerCase());
  const url = env.GARRISON_URL ?? env.FACTORY_TELEMETRY_URL ?? '';
  return {
    enabled: sinks.includes('garrison') && Boolean(url),
    url,
    agentId: env.AGENT_ID ?? 'agent',
    agentName: env.AGENT_NAME ?? env.AGENT_ID ?? 'agent',
    role: env.AGENT_ROLE ?? 'agent',
    model: env.AGENT_MODEL ?? 'unknown',
    provider: env.AGENT_PROVIDER ?? 'local',
  };
}

export async function pushHeartbeat(
  cfg: GarrisonConfig,
  state: string,
  metrics: { tokensPerMinute: number; memoryUsageMb: number },
): Promise<void> {
  if (!cfg.enabled) return;
  try {
    const res = await fetch(`${cfg.url}/api/v1/agents/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: cfg.agentId,
        name: cfg.agentName,
        role: cfg.role,
        model: cfg.model,
        provider: cfg.provider,
        state,
        metrics: { ...metrics, cpuPercent: 0 },
        timestamp: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.error(`[factory-sidecar] garrison heartbeat ${res.status}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[factory-sidecar] garrison sink failed: ${message}`);
  }
}
