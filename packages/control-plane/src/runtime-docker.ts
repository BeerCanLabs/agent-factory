import http from 'node:http';
import type { AgentRecord } from './catalog.js';
import type { Runtime, TaskStatus } from './runtime.js';

export type DockerApi = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

/** Docker Engine API (v1.45, Docker 26+ for volume subpaths) over a unix socket or tcp://host:port. */
export function dockerApi(host: string): DockerApi {
  const target = host.startsWith('unix://')
    ? { socketPath: host.slice('unix://'.length) }
    : (() => {
        const u = new URL(host.replace(/^tcp:/, 'http:'));
        return { hostname: u.hostname, port: Number(u.port || 2375) };
      })();
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        { ...target, method, path: `/v1.45${path}`, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': String(data.length) } : {}) } },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            let parsed: unknown = text;
            try {
              parsed = text ? JSON.parse(text) : {};
            } catch {
              /* plain text error */
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
}

export type DockerRuntimeOptions = {
  api: DockerApi;
  /** agentId -> image. Agents not listed cannot be started. */
  images: Record<string, string>;
  /** The internal-only network agents join; its only exits are the control plane and the gateway. */
  network: string;
  /** Named volume holding every agent's mind; each run mounts only its own subpath. */
  mindVolume?: string;
  /** Create the agent's subpath inside the mind volume before mounting it (Docker requires it to exist). */
  ensureMindPath?: (prefix: string) => void;
  memoryMb?: number;
  /** uid:gid agents run as; must own their mind subpath. */
  user?: string;
};

/**
 * Compose-host runtime: one container per run on an internal network, started and stopped through
 * the Docker API. Containers are hardened here (no privileges, read-only root, dropped capabilities)
 * because the API itself cannot be restricted by request body.
 */
export function dockerRuntime(opts: DockerRuntimeOptions): Runtime {
  const running = new Map<string, string>();
  const api = opts.api;

  async function remove(id: string) {
    await api('DELETE', `/containers/${id}?force=true`).catch(() => undefined);
  }

  return {
    running: (id) => running.has(id),
    async start(agent, secrets, ctx) {
      const image = opts.images[agent.id];
      if (!image) throw new Error(`no image mapped for ${agent.id} (FACTORY_DOCKER_IMAGES)`);
      const prefix = agent.memoryPrefix ?? agent.id;
      if (opts.mindVolume) opts.ensureMindPath?.(prefix);
      const env = {
        ...secrets,
        ...ctx.runEnv,
        AGENT_ID: agent.id,
        MEMORY_DIR: '/tmp/mind',
        MEMORY_PREFIX: prefix,
        ...(opts.mindVolume ? { MEMORY_STORE_DIR: '/store' } : {}),
      };
      const create = await api('POST', `/containers/create?name=factory-run-${ctx.runId}`, {
        Image: image,
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        Labels: { 'factory.run': ctx.runId, 'factory.agent': agent.id },
        User: opts.user ?? '1000:1000',
        HostConfig: {
          NetworkMode: opts.network,
          Privileged: false,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          Tmpfs: { '/tmp': 'rw,size=256m' },
          Memory: (opts.memoryMb ?? 512) * 1024 * 1024,
          PidsLimit: 256,
          Mounts: opts.mindVolume
            ? [{ Type: 'volume', Source: opts.mindVolume, Target: `/store/${prefix}`, VolumeOptions: { Subpath: prefix } }]
            : [],
        },
      });
      if (create.status !== 201) throw new Error(`container create ${create.status}: ${JSON.stringify(create.body)}`);
      const id = String(create.body.Id);
      const start = await api('POST', `/containers/${id}/start`);
      if (start.status !== 204 && start.status !== 304) {
        await remove(id);
        throw new Error(`container start ${start.status}: ${JSON.stringify(start.body)}`);
      }
      running.set(agent.id, id);
      return { handle: `docker:${id}` };
    },
    async stop(agent, handle) {
      const id = handle?.startsWith('docker:') ? handle.slice(7) : running.get(agent.id);
      if (!id) return null;
      await api('POST', `/containers/${id}/stop?t=10`).catch(() => undefined);
      await remove(id);
      running.delete(agent.id);
      return 0;
    },
    async status(handle): Promise<TaskStatus> {
      const id = handle.startsWith('docker:') ? handle.slice(7) : handle;
      const res = await api('GET', `/containers/${id}/json`);
      if (res.status === 404) return { state: 'stopped', exitCode: null, reason: 'container gone' };
      if (res.status !== 200) return { state: 'unknown' };
      const st = res.body.State as { Running?: boolean; ExitCode?: number; OOMKilled?: boolean };
      if (st.Running) return { state: 'running' };
      for (const [a, c] of running) if (c === id) running.delete(a);
      await remove(id);
      return { state: 'stopped', exitCode: st.ExitCode ?? null, reason: st.OOMKilled ? 'OOMKilled' : undefined };
    },
    async deliver() {},
  };
}

export function parseImageMap(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

