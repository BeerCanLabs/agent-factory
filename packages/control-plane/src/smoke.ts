import {
  createRun,
  finishRun,
  SYSTEM,
  isTerminal,
  type BuildSkill,
  type Run,
} from '@beercanlabs/factory-property-manager';
import type { AgentRecord } from '@beercanlabs/factory-registrar';
import type { SkillSmoke } from '@beercanlabs/factory-contract';
import { skillRegistry } from './skills.js';
import type { FactoryState } from './app.js';

function isNoop(runtime: unknown): boolean {
  return Boolean(runtime && typeof runtime === 'object' && 'started' in runtime && Array.isArray((runtime as any).started));
}

async function waitForRun(state: FactoryState, runId: string, timeoutMs = 30000): Promise<Run> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cur = state.runs.get(runId);
    if (!cur) throw new Error(`smoke run ${runId} disappeared from run store`);
    if (isTerminal(cur.state)) return cur;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`smoke run ${runId} timed out after ${timeoutMs}ms`);
}

export type SmokeOutcome = { ok: true } | { ok: false; error: string; runId?: string };

export async function runActivationSmoke(
  state: FactoryState,
  agent: AgentRecord,
  skills: BuildSkill[],
  commit: string,
  actor: string,
): Promise<SmokeOutcome> {
  // 1. Hello-World smoke turn
  const hwOutcome = await createRun(state, agent.id, {
    actor: SYSTEM.smoke,
    trigger: 'smoke',
    input: {
      factoryKind: 'smoke',
      smoke: 'hello-world',
    },
    factoryKind: 'smoke',
  });

  if (hwOutcome.status !== 200 && hwOutcome.status !== 202) {
    const err = `hello-world smoke run creation rejected: status ${hwOutcome.status}`;
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: agent.id,
      type: 'action',
      action: 'AGENT_SMOKE_FAILED',
      actor,
      commit,
      error: err,
    });
    return { ok: false, error: err };
  }

  const hwRun = hwOutcome.body as Run;

  // Handle execution based on runtime / smokeHandler
  if (state.smokeHandler) {
    const handlerRes = await state.smokeHandler({
      run: hwRun,
      agent,
      smokeType: 'hello-world',
    });
    const cur = state.runs.get(hwRun.runId);
    if (cur && !isTerminal(cur.state)) {
      if (handlerRes.ok) {
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: agent.id,
          runId: hwRun.runId,
          type: 'llm',
          model: agent.model ?? 'default-model',
          costUsd: 0.001,
          inputTokens: 10,
          outputTokens: 5,
          actor: `run:${agent.id}`,
        });
        await finishRun(state, hwRun.runId, 'DONE', {
          actor: `run:${agent.id}`,
          result: handlerRes.result ?? { reply: 'hello world from activation smoke', status: 'ok' },
        });
      } else {
        await finishRun(state, hwRun.runId, 'FAILED', {
          actor: SYSTEM.runtime,
          error: handlerRes.error ?? 'simulated smoke failure',
        });
      }
    }
  } else if (isNoop(state.runtime)) {
    // Default mock execution under noopRuntime
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: agent.id,
      runId: hwRun.runId,
      type: 'llm',
      model: agent.model ?? 'default-model',
      costUsd: 0.001,
      inputTokens: 10,
      outputTokens: 5,
      actor: `run:${agent.id}`,
    });
    await finishRun(state, hwRun.runId, 'DONE', {
      actor: `run:${agent.id}`,
      result: { reply: 'hello world from activation smoke', status: 'ok' },
    });
  }

  let finishedHwRun: Run;
  try {
    finishedHwRun = await waitForRun(state, hwRun.runId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: agent.id,
      runId: hwRun.runId,
      type: 'action',
      action: 'AGENT_SMOKE_FAILED',
      actor,
      commit,
      error: msg,
    });
    return { ok: false, error: msg, runId: hwRun.runId };
  }

  if (finishedHwRun.state !== 'DONE') {
    const err = `hello-world smoke run finished with state ${finishedHwRun.state}: ${finishedHwRun.error ?? 'unspecified error'}`;
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: agent.id,
      runId: hwRun.runId,
      type: 'action',
      action: 'AGENT_SMOKE_FAILED',
      actor,
      commit,
      error: err,
    });
    return { ok: false, error: err, runId: hwRun.runId };
  }

  const hwResult = finishedHwRun.result;
  const hasReply = hwResult && typeof hwResult === 'object' && ('reply' in hwResult || 'output' in hwResult);
  if (!hasReply && typeof hwResult !== 'string') {
    const err = 'hello-world smoke run produced empty or invalid result';
    state.runs.update(hwRun.runId, { state: 'FAILED', error: err });
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: agent.id,
      runId: hwRun.runId,
      type: 'action',
      action: 'AGENT_SMOKE_FAILED',
      actor,
      commit,
    });
    return { ok: false, error: err, runId: hwRun.runId };
  }

  const hasLlm = state.ledger.query().some((e) => e.runId === hwRun.runId && e.type === 'llm');
  if (!hasLlm) {
    const err = 'hello-world smoke run did not record a metered llm entry on the ledger';
    state.runs.update(hwRun.runId, { state: 'FAILED', error: err });
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: agent.id,
      runId: hwRun.runId,
      type: 'action',
      action: 'AGENT_SMOKE_FAILED',
      actor,
      commit,
    });
    return { ok: false, error: err, runId: hwRun.runId };
  }

  // 2. Per-adopted-skill smoke turns
  const registry = skillRegistry(state);
  for (const s of skills) {
    const rec = registry.get(s.id, s.version);
    const smokeSpec: SkillSmoke | undefined = rec?.manifest?.smoke;
    if (!smokeSpec) {
      const err = `skill ${s.id}@${s.version} does not declare a smoke check (SK1, L4)`;
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: agent.id,
        type: 'action',
        action: 'AGENT_SMOKE_FAILED',
        actor,
        commit,
        error: err,
      });
      return { ok: false, error: err };
    }

    const routes = rec?.manifest?.requires?.routes ?? [];

    const skillOutcome = await createRun(state, agent.id, {
      actor: SYSTEM.smoke,
      trigger: 'smoke',
      input: {
        factoryKind: 'smoke',
        smoke: 'skill',
        skillId: s.id,
        action: smokeSpec.action,
        input: smokeSpec.input,
        dryRun: smokeSpec.dryRun,
        smokeRoutes: routes,
      },
      factoryKind: 'smoke',
    });

    if (skillOutcome.status !== 200 && skillOutcome.status !== 202) {
      const err = `skill smoke run creation rejected for ${s.id}: status ${skillOutcome.status}`;
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: agent.id,
        type: 'action',
        action: 'AGENT_SMOKE_FAILED',
        actor,
        commit,
        error: err,
      });
      return { ok: false, error: err };
    }

    const skillRun = skillOutcome.body as Run;

    if (state.smokeHandler) {
      const handlerRes = await state.smokeHandler({
        run: skillRun,
        agent,
        smokeType: 'skill',
        skillId: s.id,
        skillVersion: s.version,
        smokeSpec,
        routes,
      });
      const cur = state.runs.get(skillRun.runId);
      if (cur && !isTerminal(cur.state)) {
        if (handlerRes.ok) {
          const routesToEmit = (handlerRes as any).egressRoutes ?? ((handlerRes as any).omitEgress ? [] : routes);
          for (const route of routesToEmit) {
            state.ledger.append({
              timestamp: new Date().toISOString(),
              agentId: agent.id,
              runId: skillRun.runId,
              type: 'action',
              action: `tool:${smokeSpec.action}`,
              route,
              actor: `run:${agent.id}`,
            });
          }
          await finishRun(state, skillRun.runId, 'DONE', {
            actor: `run:${agent.id}`,
            result: handlerRes.result ?? { status: 'ok', toolResult: 'smoke test passed' },
          });
        } else {
          await finishRun(state, skillRun.runId, 'FAILED', {
            actor: SYSTEM.runtime,
            error: handlerRes.error ?? `simulated smoke failure for skill ${s.id}`,
          });
        }
      }
    } else if (isNoop(state.runtime)) {
      for (const route of routes) {
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: agent.id,
          runId: skillRun.runId,
          type: 'action',
          action: `tool:${smokeSpec.action}`,
          route,
          actor: `run:${agent.id}`,
        });
      }
      await finishRun(state, skillRun.runId, 'DONE', {
        actor: `run:${agent.id}`,
        result: { status: 'ok', toolResult: 'smoke test passed' },
      });
    }

    let finishedSkillRun: Run;
    try {
      finishedSkillRun = await waitForRun(state, skillRun.runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: agent.id,
        runId: skillRun.runId,
        type: 'action',
        action: 'AGENT_SMOKE_FAILED',
        actor,
        commit,
        error: msg,
      });
      return { ok: false, error: msg, runId: skillRun.runId };
    }

    if (finishedSkillRun.state !== 'DONE') {
      const err = `skill smoke run for ${s.id} finished with state ${finishedSkillRun.state}: ${finishedSkillRun.error ?? 'unspecified error'}`;
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: agent.id,
        runId: skillRun.runId,
        type: 'action',
        action: 'AGENT_SMOKE_FAILED',
        actor,
        commit,
        error: err,
      });
      return { ok: false, error: err, runId: skillRun.runId };
    }

    // Verify egress route ledger rows
    const actions = state.ledger.query().filter((e) => e.runId === skillRun.runId);
    for (const r of routes) {
      const hasRoute = actions.some((e) => (e as any).route === r);
      if (!hasRoute) {
        const err = `skill smoke run for ${s.id} did not record egress on required route '${r}'`;
        state.runs.update(skillRun.runId, { state: 'FAILED', error: err });
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: agent.id,
          runId: skillRun.runId,
          type: 'action',
          action: 'AGENT_SMOKE_FAILED',
          actor,
          commit,
        });
        return { ok: false, error: err, runId: skillRun.runId };
      }
    }
  }

  return { ok: true };
}
