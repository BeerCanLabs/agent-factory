import type { DeployProvider } from '@beercanlabs/factory-property-manager';

export type IdentityMigrationResult = { agentId: string; outcome: 'updated' | 'skipped' | 'failed'; revoked?: string[]; detail?: string };

/**
 * GAP-249 migration, run once each time the control plane starts: every registered agent's identity is brought to the
 * current grants (its own mind prefix only, no direct model-provider access) by the deploy provider. Deploys of this
 * change therefore re-scope every existing agent role without redeploying the agents, and a role widened by hand is
 * narrowed again at the next start. One agent's failure is reported and does not stop the others; nothing throws.
 */
export async function migrateAgentIdentities(
  agents: Iterable<{ id: string; memoryPrefix?: string }>,
  dp: Pick<DeployProvider, 'reconcileIdentity'> | undefined,
  log: { log: (msg: string) => void; error: (msg: string) => void } = console,
): Promise<IdentityMigrationResult[]> {
  if (!dp?.reconcileIdentity) return [];
  const results: IdentityMigrationResult[] = [];
  for (const a of agents) {
    try {
      const r = await dp.reconcileIdentity(a.id, { memoryPrefix: a.memoryPrefix ?? a.id });
      results.push(r.skipped ? { agentId: a.id, outcome: 'skipped', detail: r.skipped } : { agentId: a.id, outcome: 'updated', revoked: r.revoked });
    } catch (err) {
      results.push({ agentId: a.id, outcome: 'failed', detail: err instanceof Error ? err.message : String(err) });
    }
  }
  const updated = results.filter((r) => r.outcome === 'updated');
  const revoked = updated.filter((r) => r.revoked?.length);
  log.log(
    `[control-plane] agent identity migration (GAP-249): ${updated.length} updated, ${results.length - updated.length} skipped or failed` +
      (revoked.length ? `; direct model access removed from ${revoked.map((r) => `${r.agentId} (${r.revoked!.join(', ')})`).join(', ')}` : ''),
  );
  for (const r of results.filter((x) => x.outcome === 'failed')) log.error(`[control-plane] agent identity migration failed for ${r.agentId}: ${r.detail}`);
  return results;
}
