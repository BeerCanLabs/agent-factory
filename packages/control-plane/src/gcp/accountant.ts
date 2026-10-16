/**
 * The Accountant's GCP adapter (DESIGN_AUTHORITY §6.15 Accountant): implements `CloudCostSource`
 * (BigQuery Billing Export) and `ComputeSource` (Cloud Run Services & Jobs) for the GCP landing zone.
 *
 * Uses native fetch against GCP REST APIs (`iamcredentials.googleapis.com`, `bigquery.googleapis.com`,
 * `run.googleapis.com`) and impersonates the dedicated read-only Accountant Service Account
 * (`FACTORY_ACCOUNTANT_SA`) when configured, so Cloud Audit Logs attribute every billing and inventory
 * read to the Accountant.
 */

import type {
  CloudCostSnapshot,
  CloudCostSource,
  ComputeInventory,
  ComputeService,
  ComputeSource,
  ComputeTask,
  CostLine,
  UsageLine,
} from '@beercanlabs/factory-budget';

export type GcpTokenProvider = () => Promise<string>;

async function metadataToken(): Promise<string> {
  if (process.env.FACTORY_GCP_ACCESS_TOKEN) {
    return process.env.FACTORY_GCP_ACCESS_TOKEN;
  }
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } },
  );
  if (!res.ok) {
    throw new Error(`GCP metadata token request failed (${res.status})`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('GCP metadata response missing access_token');
  return data.access_token;
}

/**
 * Short-lived access token for the Accountant Service Account (`FACTORY_ACCOUNTANT_SA`),
 * refreshed five minutes before expiration. Falls back to the default metadata token if no SA is specified.
 */
export function gcpAccountantTokenProvider(
  serviceAccountEmail?: string,
  opts: { fetchImpl?: typeof fetch; baseToken?: GcpTokenProvider } = {},
): GcpTokenProvider {
  const fetchFn = opts.fetchImpl ?? fetch;
  const getBaseToken = opts.baseToken ?? metadataToken;
  if (!serviceAccountEmail) return getBaseToken;

  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  return async () => {
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) {
      return cached.token;
    }
    inflight ??= (async () => {
      try {
        const base = await getBaseToken();
        const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccountEmail)}:generateAccessToken`;
        const res = await fetchFn(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${base}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            scope: [
              'https://www.googleapis.com/auth/cloud-platform.read-only',
              'https://www.googleapis.com/auth/bigquery.readonly',
            ],
            lifetime: '3600s',
          }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`IAM generateAccessToken(${serviceAccountEmail}) failed (${res.status}): ${text.slice(0, 240)}`);
        }
        const data = (await res.json()) as { accessToken?: string; expireTime?: string };
        if (!data.accessToken) throw new Error('IAM generateAccessToken returned no accessToken');
        const expiresAt = data.expireTime ? Date.parse(data.expireTime) : Date.now() + 3600_000;
        cached = { token: data.accessToken, expiresAt };
        return data.accessToken;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function parseCpuVcpu(raw: string | undefined): number {
  if (!raw) return 0;
  if (raw.endsWith('m')) return num(raw.slice(0, -1)) / 1000;
  return num(raw);
}

type BqQueryResponse = {
  jobComplete?: boolean;
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  pageToken?: string;
  rows?: Array<{ f?: Array<{ v?: string | null }> }>;
};

function parseMemoryGb(raw: string | undefined): number {
  if (!raw) return 0;
  if (raw.endsWith('Gi')) return num(raw.slice(0, -2));
  if (raw.endsWith('Mi')) return num(raw.slice(0, -2)) / 1024;
  return num(raw);
}

/**
 * BigQuery Cloud Billing Export cost source for GCP.
 * Queries either an explicit `billingTable` (`project.dataset.gcp_billing_export_v1_XXXXXX`) or discovers
 * the export table inside `billingDataset`. If no export table exists yet (e.g., before the first billing
 * export lands in a fresh project), returns an empty cost snapshot without failing.
 */
export class GcpCostSource implements CloudCostSource {
  readonly provider = 'gcp';
  private discoveredTable?: string;

  constructor(
    private readonly opts: {
      projectId: string;
      billingDataset?: string;
      billingTable?: string;
      tokenProvider?: GcpTokenProvider;
      fetchImpl?: typeof fetch;
    },
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): GcpCostSource | undefined {
    const projectId = env.FACTORY_GCP_PROJECT;
    if (!projectId) return undefined;
    const billingDataset = env.FACTORY_GCP_BILLING_DATASET;
    const billingTable = env.FACTORY_GCP_BILLING_TABLE;
    if (!billingDataset && !billingTable) return undefined;
    return new GcpCostSource({
      projectId,
      billingDataset,
      billingTable,
      tokenProvider: gcpAccountantTokenProvider(env.FACTORY_ACCOUNTANT_SA),
    });
  }

  private async resolveTable(token: string): Promise<string | null> {
    if (this.opts.billingTable) {
      return this.opts.billingTable;
    }
    if (this.discoveredTable) {
      return this.discoveredTable;
    }
    if (!this.opts.billingDataset) return null;

    const fetchFn = this.opts.fetchImpl ?? fetch;
    const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(this.opts.projectId)}/datasets/${encodeURIComponent(this.opts.billingDataset)}/tables`;
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`BigQuery listTables failed (${res.status}): ${text.slice(0, 240)}`);
    }
    const data = (await res.json()) as {
      tables?: Array<{ tableReference?: { projectId?: string; datasetId?: string; tableId?: string } }>;
    };
    const match = (data.tables ?? []).find((t) =>
      t.tableReference?.tableId?.startsWith('gcp_billing_export_'),
    )?.tableReference;
    if (!match?.tableId) return null;
    this.discoveredTable = `${match.projectId ?? this.opts.projectId}.${match.datasetId ?? this.opts.billingDataset}.${match.tableId}`;
    return this.discoveredTable;
  }

  /** jobs.query returns 200 with jobComplete false and no rows while the billing aggregation is still running. */
  private async waitForQuery(token: string, initial: BqQueryResponse): Promise<BqQueryResponse> {
    const fetchFn = this.opts.fetchImpl ?? fetch;
    let data = initial;
    for (let attempt = 0; attempt < 30 && data.jobComplete === false; attempt++) {
      const jobId = data.jobReference?.jobId;
      if (!jobId) throw new Error('BigQuery billing query is not finished and returned no job id');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const projectId = data.jobReference?.projectId ?? this.opts.projectId;
      const params = new URLSearchParams();
      if (data.jobReference?.location) params.set('location', data.jobReference.location);
      if (data.pageToken) params.set('pageToken', data.pageToken);
      const query = params.toString();
      const res = await fetchFn(
        `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/queries/${encodeURIComponent(jobId)}${query ? `?${query}` : ''}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`BigQuery getQueryResults failed (${res.status}): ${text.slice(0, 300)}`);
      }
      data = (await res.json()) as BqQueryResponse;
    }
    if (data.jobComplete === false) {
      throw new Error('BigQuery billing query did not finish');
    }
    return data;
  }

  async costs(window: { start: string; end: string }): Promise<CloudCostSnapshot> {
    const token = await (this.opts.tokenProvider ?? metadataToken)();
    const table = await this.resolveTable(token);
    if (!table || !/^[A-Za-z0-9_.-]+$/.test(table)) {
      return { provider: this.provider, start: window.start, end: window.end, lines: [], usage: [] };
    }

    const fetchFn = this.opts.fetchImpl ?? fetch;
    const query = `
      SELECT
        IFNULL(service.description, 'Unknown') AS service_name,
        IFNULL(sku.description, 'Unknown') AS usage_type,
        SUM(CAST(cost AS FLOAT64)) AS cost_usd,
        SUM(IFNULL((SELECT SUM(CAST(c.amount AS FLOAT64)) FROM UNNEST(credits) c), 0)) AS credits_usd,
        SUM(IFNULL(CAST(usage.amount AS FLOAT64), 0)) AS usage_amount
      FROM \`${table}\`
      WHERE DATE(usage_start_time) >= @start_date AND DATE(usage_start_time) < @end_date
      GROUP BY service_name, usage_type
    `;

    const res = await fetchFn(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(this.opts.projectId)}/queries`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query,
          useLegacySql: false,
          parameterMode: 'NAMED',
          queryParameters: [
            { name: 'start_date', parameterType: { type: 'DATE' }, parameterValue: { value: window.start } },
            { name: 'end_date', parameterType: { type: 'DATE' }, parameterValue: { value: window.end } },
          ],
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`BigQuery billing query failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as BqQueryResponse;
    const finished = await this.waitForQuery(token, data);

    const rows = [...(finished.rows ?? [])];
    let pageToken = finished.pageToken;
    const jobId = finished.jobReference?.jobId;
    const projectId = finished.jobReference?.projectId ?? this.opts.projectId;
    while (pageToken && jobId) {
      const params = new URLSearchParams({ pageToken });
      if (finished.jobReference?.location) params.set('location', finished.jobReference.location);
      const queryParams = params.toString();
      const pageRes = await fetchFn(
        `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/queries/${encodeURIComponent(jobId)}${queryParams ? `?${queryParams}` : ''}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!pageRes.ok) {
        const text = await pageRes.text().catch(() => '');
        throw new Error(`BigQuery getQueryResults page failed (${pageRes.status}): ${text.slice(0, 300)}`);
      }
      const page = (await pageRes.json()) as BqQueryResponse;
      rows.push(...(page.rows ?? []));
      pageToken = page.pageToken;
    }

    const lines: CostLine[] = [];
    const usage: UsageLine[] = [];
    const byServiceCost = new Map<string, number>();
    const byServiceCredit = new Map<string, number>();

    for (const row of rows) {
      const cells = row.f ?? [];
      const service = cells[0]?.v || 'Unknown';
      const usageType = cells[1]?.v || 'Unknown';
      const costUsd = num(cells[2]?.v);
      const creditsUsd = num(cells[3]?.v);
      const quantity = num(cells[4]?.v);

      byServiceCost.set(service, (byServiceCost.get(service) ?? 0) + costUsd);
      if (creditsUsd !== 0) {
        byServiceCredit.set(service, (byServiceCredit.get(service) ?? 0) + creditsUsd);
      }
      usage.push({ service, usageType, usd: costUsd, quantity });
    }

    for (const [service, usd] of byServiceCost) {
      lines.push({ recordType: 'Usage', service, usd });
    }
    for (const [service, usd] of byServiceCredit) {
      lines.push({ recordType: 'Credit', service, usd });
    }

    return { provider: this.provider, start: window.start, end: window.end, lines, usage };
  }
}

/**
 * Cloud Run Services & Jobs compute inventory source for GCP.
 */
export class GcpComputeSource implements ComputeSource {
  readonly provider = 'gcp';
  readonly cluster: string;

  constructor(
    private readonly opts: {
      projectId: string;
      region: string;
      tokenProvider?: GcpTokenProvider;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.cluster = `${opts.projectId}/${opts.region}`;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): GcpComputeSource | undefined {
    const projectId = env.FACTORY_GCP_PROJECT;
    const region = env.FACTORY_GCP_REGION;
    if (!projectId || !region) return undefined;
    return new GcpComputeSource({
      projectId,
      region,
      tokenProvider: gcpAccountantTokenProvider(env.FACTORY_ACCOUNTANT_SA),
    });
  }

  async inventory(): Promise<ComputeInventory> {
    const token = await (this.opts.tokenProvider ?? metadataToken)();
    const fetchFn = this.opts.fetchImpl ?? fetch;
    const parent = `projects/${encodeURIComponent(this.opts.projectId)}/locations/${encodeURIComponent(this.opts.region)}`;

    const [svcRes, jobsRes] = await Promise.all([
      fetchFn(`https://run.googleapis.com/v2/${parent}/services`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      fetchFn(`https://run.googleapis.com/v2/${parent}/jobs`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    ]);

    if (!svcRes.ok) {
      const text = await svcRes.text().catch(() => '');
      throw new Error(`Cloud Run listServices failed (${svcRes.status}): ${text.slice(0, 240)}`);
    }
    if (!jobsRes.ok) {
      const text = await jobsRes.text().catch(() => '');
      throw new Error(`Cloud Run listJobs failed (${jobsRes.status}): ${text.slice(0, 240)}`);
    }

    const svcData = (await svcRes.json()) as {
      services?: Array<{
        name?: string;
        reconciling?: boolean;
        template?: {
          scaling?: { minInstanceCount?: number; maxInstanceCount?: number };
          containers?: Array<{ resources?: { limits?: { cpu?: string; memory?: string } } }>;
        };
      }>;
    };

    const jobsData = (await jobsRes.json()) as {
      jobs?: Array<{
        name?: string;
        latestCreatedExecution?: {
          name?: string;
          createTime?: string;
          completionTime?: string;
        };
        template?: {
          template?: {
            containers?: Array<{ resources?: { limits?: { cpu?: string; memory?: string } } }>;
          };
        };
      }>;
    };

    const services: ComputeService[] = (svcData.services ?? []).map((s) => {
      const shortName = s.name?.split('/').pop() ?? 'unknown';
      const limits = s.template?.containers?.[0]?.resources?.limits;
      const vcpu = parseCpuVcpu(limits?.cpu);
      const memoryGb = parseMemoryGb(limits?.memory);
      const minInstances = s.template?.scaling?.minInstanceCount ?? 0;
      return {
        name: shortName,
        vcpu,
        memoryGb,
        spot: false,
        desired: minInstances,
        running: minInstances,
        pending: 0,
        deployments: 1,
        rollout: [s.reconciling ? 'IN_PROGRESS' : 'COMPLETED'],
      };
    });

    const tasks: ComputeTask[] = [];
    for (const j of jobsData.jobs ?? []) {
      const shortName = j.name?.split('/').pop() ?? 'unknown';
      const limits = j.template?.template?.containers?.[0]?.resources?.limits;
      const vcpu = parseCpuVcpu(limits?.cpu);
      const memoryGb = parseMemoryGb(limits?.memory);
      const latest = j.latestCreatedExecution;
      if (latest && !latest.completionTime) {
        tasks.push({
          group: shortName,
          status: 'RUNNING',
          vcpu,
          memoryGb,
          spot: false,
          startedAt: latest.createTime,
        });
      }
    }

    return {
      provider: this.provider,
      cluster: this.cluster,
      services,
      tasks,
    };
  }
}
