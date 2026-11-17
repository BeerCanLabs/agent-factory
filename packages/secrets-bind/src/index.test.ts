import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awsSecretsManagerProvider, bindSecrets, envProvider, fileProvider, httpProvider, type SecretsManagerSend } from './index.js';

// K6: a stand-in for SecretsManagerClient that records each command's class name and input and answers from `answer`.
type Recorded = { name: string; input: Record<string, any> };
function fakeSecrets(answer: (call: Recorded) => unknown) {
  const calls: Recorded[] = [];
  const client: SecretsManagerSend = {
    async send(command) {
      const c = command as { constructor: { name: string }; input: Record<string, any> };
      const call = { name: c.constructor.name, input: c.input };
      calls.push(call);
      return answer(call);
    },
  };
  return { client, calls };
}
const notFound = () => Object.assign(new Error("Secrets Manager can't find the specified secret."), { name: 'ResourceNotFoundException' });

describe('bindSecrets', () => {
  it('binds names from env without storing values in the factory', async () => {
    const result = await bindSecrets(['API_KEY'], [envProvider({ API_KEY: 'from-env' })]);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.env.API_KEY, 'from-env');
  });

  it('rejects boot when a required name is unbound', async () => {
    const result = await bindSecrets(['API_KEY', 'OTHER'], [envProvider({ OTHER: 'x' })]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.missing, ['API_KEY']);
  });

  it('reads a gitignored env file as a BYO source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-'));
    const file = join(dir, '.factory-secrets');
    writeFileSync(file, 'ECHO_WEBHOOK_SECRET=whsec\n');
    try {
      const result = await bindSecrets(['ECHO_WEBHOOK_SECRET'], [fileProvider(file)]);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.env.ECHO_WEBHOOK_SECRET, 'whsec');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('uses an HTTP vault/SM proxy (BYO, not a factory vault)', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/API_KEY')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ value: 'vaulted' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    try {
      const result = await bindSecrets(['API_KEY'], [httpProvider(`http://127.0.0.1:${addr.port}`)]);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.env.API_KEY, 'vaulted');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('K6: reads AWS Secrets Manager under the task-definition prefix; a missing secret is undefined', async () => {
    const { client, calls } = fakeSecrets((c) => {
      if (c.input.SecretId === 'factory/prod/ECHO_WEBHOOK_SECRET') return { SecretString: 'from-sm' };
      throw notFound();
    });
    const provider = awsSecretsManagerProvider('factory/prod/', client);
    const ok = await bindSecrets(['ECHO_WEBHOOK_SECRET'], [provider]);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.env.ECHO_WEBHOOK_SECRET, 'from-sm');
    const missing = await bindSecrets(['NOPE'], [provider]);
    assert.equal(missing.ok, false);
    assert.deepEqual(
      calls.map((c) => [c.name, c.input.SecretId]),
      [
        ['GetSecretValueCommand', 'factory/prod/ECHO_WEBHOOK_SECRET'],
        ['GetSecretValueCommand', 'factory/prod/NOPE'],
      ],
    );
  });

  it('K6: treats a stored value of exactly None as missing', async () => {
    const { client } = fakeSecrets(() => ({ SecretString: 'None' }));
    assert.equal(await awsSecretsManagerProvider('factory/prod/', client).get('X'), undefined);
  });

  it('reads GCP Secret Manager and handles missing secrets cleanly', async () => {
    const asked: string[] = [];
    const provider = (await import('./index.js')).gcpSecretManagerProvider('my-project', async (args) => {
      const secret = args[args.indexOf('--secret') + 1];
      const project = args[args.indexOf('--project') + 1];
      asked.push(`${project}/${secret}`);
      if (secret === 'MY_GCP_SECRET') return 'supersecret-gcp\n';
      throw new Error('NOT_FOUND');
    });
    const ok = await bindSecrets(['MY_GCP_SECRET'], [provider]);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.env.MY_GCP_SECRET, 'supersecret-gcp');
    const missing = await bindSecrets(['UNSET_SECRET'], [provider]);
    assert.equal(missing.ok, false);
    assert.deepEqual(asked, ['my-project/MY_GCP_SECRET', 'my-project/UNSET_SECRET']);
  });

  it('K6: lists AWS secrets with one ListSecrets call per page, never reading a value (GAP-056)', async () => {
    const { client, calls } = fakeSecrets((c) => {
      if (!c.input.NextToken) {
        return {
          SecretList: [
            { Name: 'factory/prod/NOTION_API_KEY', SecretVersionsToStages: { v1: ['AWSCURRENT'] } },
            { Name: 'factory/prod/OLD_KEY', SecretVersionsToStages: { v0: ['AWSPREVIOUS'] } },
            { Name: 'factory/staging/OTHER', SecretVersionsToStages: { v1: ['AWSCURRENT'] } },
          ],
          NextToken: 'page-2',
        };
      }
      return {
        SecretList: [
          { Name: 'factory/prod/connections/donna/google', SecretVersionsToStages: { v2: ['AWSCURRENT', 'AWSPENDING'] } },
          { Name: 'factory/prod/GONE', SecretVersionsToStages: {} },
        ],
      };
    });
    assert.deepEqual([...(await awsSecretsManagerProvider('factory/prod/', client).present!())].sort(), [
      'NOTION_API_KEY',
      'connections/donna/google',
    ]);
    assert.deepEqual(calls.map((c) => c.name), ['ListSecretsCommand', 'ListSecretsCommand']);
    assert.deepEqual(calls[0].input.Filters, [{ Key: 'name', Values: ['factory/prod/'] }]);
    assert.equal(calls[1].input.NextToken, 'page-2');
    assert.ok(!calls.some((c) => c.name === 'GetSecretValueCommand'), 'metadata only');
  });

  it('K6: writes AWS secrets with PutSecretValue, creating the secret when it does not exist yet', async () => {
    const value = '{"refreshToken":"rt-secret"}';
    const existing = new Set<string>();
    const { client, calls } = fakeSecrets((c) => {
      if (c.name === 'PutSecretValueCommand' && !existing.has(c.input.SecretId)) throw notFound();
      if (c.name === 'CreateSecretCommand') existing.add(c.input.Name);
      return {};
    });
    const provider = awsSecretsManagerProvider('factory/prod/', client);
    await provider.put!('connections/donna/google', value);
    assert.deepEqual(calls.map((c) => c.name), ['PutSecretValueCommand', 'CreateSecretCommand']);
    assert.equal(calls[1].input.Name, 'factory/prod/connections/donna/google');
    for (const c of calls) {
      assert.equal(c.input.SecretString, value);
      assert.equal(JSON.stringify({ ...c.input, SecretString: undefined }).includes('rt-secret'), false, 'secret value only in SecretString');
    }
    calls.length = 0;
    await provider.put!('connections/donna/google', '{"refreshToken":"rt-2"}');
    assert.deepEqual(calls.map((c) => c.name), ['PutSecretValueCommand']);
  });

  it('K6: surfaces AWS and GCP write errors other than not-found; http backend says writes are not implemented', async () => {
    const provider = awsSecretsManagerProvider('p/', fakeSecrets(() => {
      throw new Error('AccessDeniedException');
    }).client);
    await assert.rejects(provider.put!('x', 'v'), /AccessDenied/);
    const { gcpSecretManagerProvider, writableProvider, SecretWriteNotImplementedError } = await import('./index.js');
    const gcpProvider = gcpSecretManagerProvider('p', async () => {
      throw new Error('PERMISSION_DENIED');
    });
    await assert.rejects(gcpProvider.put!('x', 'v'), /PERMISSION_DENIED/);
    await assert.rejects(httpProvider('http://127.0.0.1:1').put!('x', 'v'), SecretWriteNotImplementedError);
    assert.equal(writableProvider([envProvider({})]), undefined);
    assert.equal(writableProvider([envProvider({}), provider])?.name, 'aws-sm');
    assert.equal(writableProvider([envProvider({}), gcpProvider])?.name, 'gcp-sm');
  });

  it('K6: a hung AWS call returns within the bound: get is undefined, has is false, put rejects, and the request is aborted', async () => {
    let signal: AbortSignal | undefined;
    // Never settles and ignores its abort signal, as a stuck SDK step would.
    const hung: SecretsManagerSend = {
      send(_command, options) {
        signal = options?.abortSignal;
        return new Promise(() => {});
      },
    };
    const provider = awsSecretsManagerProvider('factory/prod/', hung, { timeoutMs: 20 });
    assert.equal(await provider.get('X'), undefined);
    assert.equal(signal?.aborted, true, 'the request was aborted when the bound passed');
    assert.equal(await provider.has!('X'), false);
    await assert.rejects(provider.put!('X', 'v'), /timed out after 20 ms/);
  });

  it('supports GCP Secret Manager REST API (get, put, has, present) with prefix and slash encoding', async () => {
    const { gcpSecretManagerProvider } = await import('./index.js');
    const store = new Map<string, string>();
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const method = init?.method ?? 'GET';
      const path = url.pathname;
      const accessMatch = path.match(/\/projects\/proj-1\/secrets\/([^/]+)\/versions\/latest:access$/);
      if (method === 'GET' && accessMatch) {
        const id = decodeURIComponent(accessMatch[1]);
        const val = store.get(id);
        if (val === undefined) return new Response('{}', { status: 404 });
        return new Response(JSON.stringify({ payload: { data: Buffer.from(val, 'utf8').toString('base64') } }), { status: 200 });
      }
      const addVerMatch = path.match(/\/projects\/proj-1\/secrets\/([^/:]+):addVersion$/);
      if (method === 'POST' && addVerMatch) {
        const id = decodeURIComponent(addVerMatch[1]);
        if (!store.has(id)) return new Response('{}', { status: 404 });
        const body = JSON.parse(String(init?.body ?? '{}')) as { payload: { data: string } };
        store.set(id, Buffer.from(body.payload.data, 'base64').toString('utf8'));
        return new Response('{}', { status: 200 });
      }
      if (method === 'POST' && path.endsWith('/projects/proj-1/secrets')) {
        const id = url.searchParams.get('secretId')!;
        store.set(id, '');
        return new Response('{}', { status: 200 });
      }
      const versMatch = path.match(/\/projects\/proj-1\/secrets\/([^/]+)\/versions$/);
      if (method === 'GET' && versMatch) {
        const id = decodeURIComponent(versMatch[1]);
        const val = store.get(id);
        if (!val) return new Response(JSON.stringify({ versions: [] }), { status: 200 });
        return new Response(JSON.stringify({ versions: [{ state: 'ENABLED' }] }), { status: 200 });
      }
      if (method === 'GET' && path.endsWith('/projects/proj-1/secrets')) {
        const secrets = [...store.keys()].map((id) => ({ name: `projects/123/secrets/${id}` }));
        return new Response(JSON.stringify({ secrets }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const gcp = gcpSecretManagerProvider('proj-1', undefined, {
      prefix: 'factory-prod-',
      fetch: fetchMock,
      getAccessToken: async () => 'tok-123',
    });

    assert.equal(await gcp.has!('connections/donna/google'), false);
    await gcp.put!('connections/donna/google', '{"refreshToken":"r1"}');
    await gcp.put!('NOTION_API_KEY', 'secret-notion');
    assert.equal(store.has('factory-prod-connections---donna---google'), true);
    assert.equal(store.has('factory-prod-NOTION_API_KEY'), true);
    assert.equal(await gcp.has!('connections/donna/google'), true);
    assert.equal(await gcp.get('connections/donna/google'), '{"refreshToken":"r1"}');
    assert.equal(await gcp.get('NOTION_API_KEY'), 'secret-notion');
    assert.deepEqual([...(await gcp.present!())].sort(), ['NOTION_API_KEY', 'connections/donna/google']);
  });

  it('wires gcpSecretManagerProvider into providersFromEnv', async () => {
    const { providersFromEnv } = await import('./index.js');
    const providers = providersFromEnv({ FACTORY_SECRETS_GCP_PROJECT: 'proj-123', FACTORY_SECRETS_GCP_PREFIX: 'factory-prod-' });
    assert.ok(providers.some((p) => p.name === 'gcp-sm'));
  });

  it('K6: secretPresent answers without the value; AWS reads metadata only (DescribeSecret), never the value', async () => {
    const { secretPresent } = await import('./index.js');
    const { client, calls } = fakeSecrets((c) => {
      const id = c.input.SecretId;
      if (id === 'factory/prod/HAVE') return { VersionIdsToStages: { v1: ['AWSCURRENT'] } };
      if (id === 'factory/prod/EMPTY') return { VersionIdsToStages: {} }; // entry exists, no value was ever set
      if (id === 'factory/prod/DELETED') return { DeletedDate: new Date(), VersionIdsToStages: { v1: ['AWSCURRENT'] } }; // scheduled for deletion
      throw notFound();
    });
    const aws = awsSecretsManagerProvider('factory/prod/', client);
    assert.equal(await secretPresent('HAVE', [aws]), true);
    assert.equal(await secretPresent('EMPTY', [aws]), false);
    assert.equal(await secretPresent('DELETED', [aws]), false);
    assert.equal(await secretPresent('NOPE', [aws]), false);
    assert.ok(calls.length > 0);
    for (const c of calls) assert.equal(c.name, 'DescribeSecretCommand');
    assert.equal(await secretPresent('A', [envProvider({ A: '' })]), false);
    assert.equal(await secretPresent('A', [envProvider({}), envProvider({ A: 'example-value' })]), true);
    const throwing = { name: 'broken', async get(): Promise<string | undefined> { throw new Error('down'); } };
    assert.equal(await secretPresent('A', [throwing, envProvider({ A: 'example-value' })]), true);
  });
});
