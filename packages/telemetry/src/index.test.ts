import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AggregationTemporality, InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { initTelemetry } from './index.js';

describe('telemetry', () => {
  it('is a no-op without an OTLP endpoint', () => {
    assert.equal(initTelemetry('svc', '0', { env: {} }).enabled, false);
  });

  it('exports named instruments through the configured reader', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const t = initTelemetry('factory-test', '1', { reader, env: {} });
    t.meter.createCounter('factory.runs').add(2, { state: 'DONE' });
    await reader.forceFlush();
    const names = exporter.getMetrics().flatMap((rm) => rm.scopeMetrics.flatMap((s) => s.metrics.map((m) => m.descriptor.name)));
    assert.ok(names.includes('factory.runs'));
    await t.shutdown();
  });
});
