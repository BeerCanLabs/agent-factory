/** The fields of a run the triage rule reads. Structural, so the package does not import the Landlord's `Run`. */
export type TriageRun = {
  runId: string;
  agentId: string;
  state: string;
  error?: string;
  missing?: readonly string[];
  updatedAt?: string;
  startedAt?: string;
  createdAt?: string;
};

export type Incident = {
  id: string;
  timestamp: string;
  agentId: string;
  severity: 'CRITICAL' | 'ERROR';
  category: 'SECRET_MISSING' | 'TIMEOUT' | 'CRASH_LOOP';
  message: string;
};

/**
 * Incidents derived from runs: every run that failed or carries an error, in the order given. The category and
 * severity are decided by the error text (GAP-108 records how blunt that is); this step moves the rule and changes
 * nothing about it.
 */
export function incidentsFromRuns(runs: Iterable<TriageRun>, now: () => string = () => new Date().toISOString()): Incident[] {
  const incidents: Incident[] = [];
  for (const r of runs) {
    if (!(r.state === 'FAILED' || r.error)) continue;
    incidents.push({
      id: `inc-${r.runId.slice(0, 8)}`,
      timestamp: r.updatedAt || r.startedAt || r.createdAt || now(),
      agentId: r.agentId,
      severity: r.error?.includes('OOM') ? 'CRITICAL' : 'ERROR',
      category: r.missing ? 'SECRET_MISSING' : r.error?.includes('timeout') ? 'TIMEOUT' : 'CRASH_LOOP',
      message: r.error || 'Run terminated with failure state',
    });
  }
  return incidents;
}
