import { metrics, type Meter } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader, type MetricReader } from '@opentelemetry/sdk-metrics';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export type Telemetry = { meter: Meter; shutdown(): Promise<void>; enabled: boolean };

/**
 * Health and throughput go to the adopter's APM over OTLP, never into the ledger.
 * Without OTEL_EXPORTER_OTLP_ENDPOINT (or an explicit reader) this returns the no-op meter.
 */
export function initTelemetry(service: string, version: string, opts: { reader?: MetricReader; env?: NodeJS.ProcessEnv } = {}): Telemetry {
  const env = opts.env ?? process.env;
  const endpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!opts.reader && !endpoint) {
    return { meter: metrics.getMeter(service, version), shutdown: async () => {}, enabled: false };
  }
  const reader =
    opts.reader ??
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL || 15_000),
    });
  const provider = new MeterProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME || service, [ATTR_SERVICE_VERSION]: version }),
    readers: [reader],
  });
  return { meter: provider.getMeter(service, version), shutdown: () => provider.shutdown(), enabled: true };
}
