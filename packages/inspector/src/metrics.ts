import type { Meter } from '@opentelemetry/api';

export type FactoryMetrics = {
  runs: ReturnType<Meter['createCounter']>;
  runSeconds: ReturnType<Meter['createHistogram']>;
  health: ReturnType<Meter['createCounter']>;
};

/**
 * The factory's run instruments. The Inspector does not read the Landlord's runs: `activeRunStates` is asked for the
 * state of every non-terminal run each time the gauge is observed.
 */
export function factoryMetrics(meter: Meter, activeRunStates: () => Iterable<string>): FactoryMetrics {
  meter
    .createObservableGauge('factory.runs.active', { description: 'Non-terminal runs by state' })
    .addCallback((obs) => {
      const counts = new Map<string, number>();
      for (const st of activeRunStates()) counts.set(st, (counts.get(st) ?? 0) + 1);
      for (const [st, n] of counts) obs.observe(n, { state: st });
    });
  return {
    runs: meter.createCounter('factory.runs.finished', { description: 'Runs reaching a terminal or blocked state' }),
    runSeconds: meter.createHistogram('factory.run.duration', { unit: 's', description: 'Wall-clock from start to terminal state' }),
    health: meter.createCounter('factory.health.events', { description: 'Health interventions (unhealthy halts, crash-loop pauses)' }),
  };
}
