/**
 * The Treasurer's AWS adapter (DESIGN_AUTHORITY §6.15 Treasurer): implements `CloudCostSource` (Cost Explorer) and
 * `ComputeSource` (ECS) for the AWS landing zone.
 *
 * Every call is made with the Treasurer's own read-only role (`FACTORY_TREASURER_ROLE_ARN`), assumed from the control
 * plane's task role; the control-plane role may assume that one role and holds no billing permission itself, so
 * CloudTrail attributes every billing read to the Treasurer. Agents never reach this: they read the Treasurer's report
 * through `/api/v1/spend/*`.
 */
import { CostExplorerClient, GetCostAndUsageCommand, type GetCostAndUsageCommandInput, type ResultByTime } from '@aws-sdk/client-cost-explorer';
import {
  DescribeServicesCommand,
  type DescribeServicesCommandOutput,
  DescribeTasksCommand,
  type DescribeTasksCommandOutput,
  ECSClient,
  ListServicesCommand,
  type ListServicesCommandOutput,
  ListTasksCommand,
  type ListTasksCommandOutput,
  type Service,
  type Task,
} from '@aws-sdk/client-ecs';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
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

type Creds = { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date };
type CredProvider = () => Promise<Creds>;

/** Short-lived credentials for the Treasurer role, refreshed five minutes before they expire. */
export function treasurerCredentials(roleArn: string, opts: { region?: string; sts?: Pick<STSClient, 'send'> } = {}): CredProvider {
  const sts = opts.sts ?? new STSClient({ region: opts.region });
  let cached: Creds | undefined;
  let inflight: Promise<Creds> | undefined;
  return async () => {
    if (cached?.expiration && cached.expiration.getTime() - Date.now() > 5 * 60_000) return cached;
    inflight ??= (async () => {
      try {
        const out = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: 'factory-treasurer', DurationSeconds: 3600 }));
        const c = out.Credentials;
        if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('AssumeRole returned no credentials');
        cached = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
        return cached;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };
}

const num = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Cost Explorer. Its API lives in us-east-1 for every account. Two calls per window (each costs $0.01). */
export class AwsCostSource implements CloudCostSource {
  readonly provider = 'aws';
  constructor(private readonly ce: Pick<CostExplorerClient, 'send'>) {}

  static fromRole(roleArn: string): AwsCostSource {
    return new AwsCostSource(new CostExplorerClient({ region: 'us-east-1', credentials: treasurerCredentials(roleArn, { region: process.env.AWS_REGION }) }));
  }

  private async all(input: GetCostAndUsageCommandInput): Promise<ResultByTime[]> {
    const out: ResultByTime[] = [];
    let token: string | undefined;
    do {
      const page = await this.ce.send(new GetCostAndUsageCommand({ ...input, NextPageToken: token }));
      out.push(...(page.ResultsByTime ?? []));
      token = page.NextPageToken;
    } while (token);
    return out;
  }

  async costs(window: { start: string; end: string }): Promise<CloudCostSnapshot> {
    const TimePeriod = { Start: window.start, End: window.end };
    const [byRecord, byUsage] = await Promise.all([
      this.all({
        TimePeriod,
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'RECORD_TYPE' }, { Type: 'DIMENSION', Key: 'SERVICE' }],
      }),
      this.all({
        TimePeriod,
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost', 'UsageQuantity'],
        Filter: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Usage'] } },
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }, { Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
      }),
    ]);
    const lines: CostLine[] = [];
    for (const r of byRecord) {
      for (const g of r.Groups ?? []) {
        const [recordType = 'Usage', service = 'Unknown'] = g.Keys ?? [];
        lines.push({ recordType, service, usd: num(g.Metrics?.UnblendedCost?.Amount) });
      }
    }
    const usage: UsageLine[] = [];
    for (const r of byUsage) {
      for (const g of r.Groups ?? []) {
        const [service = 'Unknown', usageType = 'Unknown'] = g.Keys ?? [];
        usage.push({ service, usageType, usd: num(g.Metrics?.UnblendedCost?.Amount), quantity: num(g.Metrics?.UsageQuantity?.Amount) });
      }
    }
    return { provider: this.provider, start: window.start, end: window.end, lines, usage };
  }
}

const groupName = (g: string | undefined) => (g ?? '').replace(/^service:|^family:/, '');
const isSpot = (s: Pick<Service, 'capacityProviderStrategy'>) => (s.capacityProviderStrategy ?? []).some((c) => c.capacityProvider === 'FARGATE_SPOT');

/** ECS: the cluster's services and running tasks, with their allocation. Read-only. */
export class AwsComputeSource implements ComputeSource {
  readonly provider = 'aws';
  constructor(private readonly ecs: Pick<ECSClient, 'send'>, readonly cluster: string) {}

  static fromRole(roleArn: string, cluster: string): AwsComputeSource {
    return new AwsComputeSource(new ECSClient({ credentials: treasurerCredentials(roleArn, { region: process.env.AWS_REGION }) }), cluster);
  }

  async inventory(): Promise<ComputeInventory> {
    const cluster = this.cluster;
    const serviceArns: string[] = [];
    let token: string | undefined;
    do {
      const page: ListServicesCommandOutput = await this.ecs.send(new ListServicesCommand({ cluster, nextToken: token, maxResults: 100 }));
      serviceArns.push(...(page.serviceArns ?? []));
      token = page.nextToken;
    } while (token);
    const described: Service[] = [];
    for (let i = 0; i < serviceArns.length; i += 10) {
      const res: DescribeServicesCommandOutput = await this.ecs.send(new DescribeServicesCommand({ cluster, services: serviceArns.slice(i, i + 10) }));
      described.push(...(res.services ?? []));
    }

    const taskArns: string[] = [];
    token = undefined;
    do {
      const page: ListTasksCommandOutput = await this.ecs.send(new ListTasksCommand({ cluster, nextToken: token, maxResults: 100 }));
      taskArns.push(...(page.taskArns ?? []));
      token = page.nextToken;
    } while (token);
    const tasks: Task[] = [];
    for (let i = 0; i < taskArns.length; i += 100) {
      const res: DescribeTasksCommandOutput = await this.ecs.send(new DescribeTasksCommand({ cluster, tasks: taskArns.slice(i, i + 100) }));
      tasks.push(...(res.tasks ?? []));
    }

    const sizeByService = new Map<string, { vcpu: number; memoryGb: number }>();
    const outTasks: ComputeTask[] = tasks.map((t) => {
      const vcpu = num(t.cpu) / 1024;
      const memoryGb = num(t.memory) / 1024;
      const group = groupName(t.group);
      if (t.group?.startsWith('service:')) sizeByService.set(group, { vcpu, memoryGb });
      return {
        group,
        status: t.lastStatus ?? 'UNKNOWN',
        vcpu,
        memoryGb,
        spot: t.capacityProviderName === 'FARGATE_SPOT',
        startedAt: (t.startedAt ?? t.createdAt)?.toISOString(),
      };
    });
    const services: ComputeService[] = described.map((s) => {
      const name = s.serviceName ?? 'unknown';
      const size = sizeByService.get(name) ?? { vcpu: 0, memoryGb: 0 };
      return {
        name,
        ...size,
        spot: isSpot(s),
        desired: s.desiredCount ?? 0,
        running: s.runningCount ?? 0,
        pending: s.pendingCount ?? 0,
        deployments: (s.deployments ?? []).length,
        rollout: (s.deployments ?? []).map((d) => d.rolloutState ?? 'UNKNOWN'),
      };
    });
    return { provider: this.provider, cluster, services, tasks: outTasks };
  }
}
