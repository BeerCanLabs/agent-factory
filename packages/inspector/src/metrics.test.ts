import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { factoryMetrics } from './metrics.js';

type Row = { name: string; unit: string; description: string; points: Array<{ attributes: Record<string, unknown>; value: unknown }> };

async function collect(fn: (m: ReturnType<typeof factoryMetrics>) => void, active: string[]): Promise<Row[]> {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  const provider = new MeterProvider({ readers: [reader] });
  const m = factoryMetrics(provider.getMeter('test'), () => active);
  fn(m);
  await reader.forceFlush();
  const rows = exporter.getMetrics().flatMap((rm) =>
    rm.scopeMetrics.flatMap((sm) =>
      sm.metrics.map((x) => ({
        name: x.descriptor.name,
        unit: x.descriptor.unit,
        description: x.descriptor.description,
        points: x.dataPoints.map((p) => ({ attributes: p.attributes as Record<string, unknown>, value: p.value })),
      })),
    ),
  );
  await provider.shutdown();
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

describe('§6.5 run metrics: names, units, descriptions and attributes are the contract with the adopter\'s APM', () => {
  it('registers the four instruments with their names, units and descriptions', async () => {
    const rows = await collect((m) => {
      m.runs.add(1, { agent: 'a', state: 'SUCCEEDED', trigger: 'api' });
      m.runSeconds.record(2.5, { agent: 'a', state: 'SUCCEEDED' });
      m.health.add(1, { agent: 'a', kind: 'unhealthy' });
    }, ['WORKING']);
    assert.deepEqual(
      rows.map(({ name, unit, description }) => ({ name, unit, description })),
      [
        { name: 'factory.health.events', unit: '', description: 'Health interventions (unhealthy halts, crash-loop pauses)' },
        { name: 'factory.run.duration', unit: 's', description: 'Wall-clock from start to terminal state' },
        { name: 'factory.runs.active', unit: '', description: 'Non-terminal runs by state' },
        { name: 'factory.runs.finished', unit: '', description: 'Runs reaching a terminal or blocked state' },
      ],
    );
  });

  it('keeps the attributes callers record, and the active gauge counts the reader\'s states', async () => {
    const rows = await collect((m) => {
      m.runs.add(1, { agent: 'a', state: 'FAILED', trigger: 'cron' });
      m.health.add(2, { agent: 'a', kind: 'crash_loop' });
    }, ['WORKING', 'WORKING', 'STARTING']);
    const by = Object.fromEntries(rows.map((r) => [r.name, r.points]));
    assert.deepEqual(by['factory.runs.finished'], [{ attributes: { agent: 'a', state: 'FAILED', trigger: 'cron' }, value: 1 }]);
    assert.deepEqual(by['factory.health.events'], [{ attributes: { agent: 'a', kind: 'crash_loop' }, value: 2 }]);
    const active = Object.fromEntries((by['factory.runs.active'] as Array<{ attributes: { state: string }; value: number }>).map((p) => [p.attributes.state, p.value]));
    assert.deepEqual(active, { WORKING: 2, STARTING: 1 });
  });

  it('the duration histogram records seconds with its attributes', async () => {
    const rows = await collect((m) => m.runSeconds.record(2.5, { agent: 'a', state: 'SUCCEEDED' }), []);
    const h = rows.find((r) => r.name === 'factory.run.duration')!;
    assert.deepEqual(h.points[0].attributes, { agent: 'a', state: 'SUCCEEDED' });
    assert.equal((h.points[0].value as { sum: number; count: number }).sum, 2.5);
    assert.equal((h.points[0].value as { count: number }).count, 1);
  });
});
