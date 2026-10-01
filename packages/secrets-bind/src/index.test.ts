import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awsSecretsManagerProvider, bindSecrets, envProvider, fileProvider, httpProvider } from './index.js';

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

  it('reads AWS Secrets Manager under the task-definition prefix', async () => {
    const asked: string[] = [];
    const provider = awsSecretsManagerProvider('factory/prod/', async (args) => {
      const id = args[args.indexOf('--secret-id') + 1];
      asked.push(id);
      if (id === 'factory/prod/ECHO_WEBHOOK_SECRET') return 'from-sm\n';
      throw new Error('ResourceNotFoundException');
    });
    const ok = await bindSecrets(['ECHO_WEBHOOK_SECRET'], [provider]);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.env.ECHO_WEBHOOK_SECRET, 'from-sm');
    const missing = await bindSecrets(['NOPE'], [provider]);
    assert.equal(missing.ok, false);
    assert.deepEqual(asked, ['factory/prod/ECHO_WEBHOOK_SECRET', 'factory/prod/NOPE']);
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

  it('lists which AWS secrets exist in one metadata call, never reading a value (GAP-056)', async () => {
    const calls: string[][] = [];
    const provider = awsSecretsManagerProvider('factory/prod/', async (args) => {
      calls.push(args);
      return JSON.stringify(['factory/prod/NOTION_API_KEY', 'factory/prod/connections/donna/google', 'factory/staging/OTHER']);
    });
    assert.deepEqual([...(await provider.present!())].sort(), ['NOTION_API_KEY', 'connections/donna/google']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'list-secrets');
    assert.deepEqual(calls[0].slice(2, 4), ['--filters', 'Key=name,Values=factory/prod/']);
    assert.ok(!calls[0].some((a) => /get-secret-value|SecretString/.test(a)), 'metadata only');
  });

  it('writes AWS secrets over stdin, creating the secret when it does not exist yet', async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const existing = new Set<string>();
    const provider = awsSecretsManagerProvider('factory/prod/', async (args, input) => {
      calls.push({ args, input });
      const id = args[args.indexOf(args.includes('--name') ? '--name' : '--secret-id') + 1];
      if (args[1] === 'put-secret-value' && !existing.has(id)) throw new Error('An error occurred (ResourceNotFoundException) when calling the PutSecretValue operation');
      if (args[1] === 'create-secret') existing.add(id);
      return '{}';
    });
    await provider.put!('connections/donna/google', '{"refreshToken":"rt-secret"}');
    assert.deepEqual(calls.map((c) => c.args[1]), ['put-secret-value', 'create-secret']);
    assert.equal(calls[1].args[calls[1].args.indexOf('--name') + 1], 'factory/prod/connections/donna/google');
    for (const c of calls) {
      assert.equal(c.input, '{"refreshToken":"rt-secret"}');
      assert.equal(c.args.join(' ').includes('rt-secret'), false, 'secret value never in argv');
    }
    calls.length = 0;
    await provider.put!('connections/donna/google', '{"refreshToken":"rt-2"}');
    assert.deepEqual(calls.map((c) => c.args[1]), ['put-secret-value']);
  });

  it('the real CLI spawn lets `aws` read the value from file:///dev/stdin (regression: ENXIO on Linux)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-aws-'));
    const out = join(dir, 'written');
    // A stand-in `aws` that opens its --secret-string file:// path exactly as the real CLI does.
    writeFileSync(join(dir, 'aws'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --secret-string ] && cat "${2#file://}" > "$FAKE_AWS_OUT"; shift; done\n', { mode: 0o755 });
    const saved = { PATH: process.env.PATH, FAKE_AWS_OUT: process.env.FAKE_AWS_OUT, AWS_REGION: process.env.AWS_REGION };
    process.env.PATH = `${dir}:${process.env.PATH}`;
    process.env.FAKE_AWS_OUT = out;
    delete process.env.AWS_REGION;
    try {
      await awsSecretsManagerProvider('factory/prod/').put!('connections/donna/google', '{"refreshToken":"rt-live"}');
      assert.equal(readFileSync(out, 'utf8'), '{"refreshToken":"rt-live"}');
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces AWS write errors other than not-found; other backends say writes are not implemented', async () => {
    const provider = awsSecretsManagerProvider('p/', async () => {
      throw new Error('AccessDeniedException');
    });
    await assert.rejects(provider.put!('x', 'v'), /AccessDenied/);
    const { gcpSecretManagerProvider, writableProvider, SecretWriteNotImplementedError } = await import('./index.js');
    await assert.rejects(gcpSecretManagerProvider('p', async () => '').put!('x', 'v'), SecretWriteNotImplementedError);
    await assert.rejects(httpProvider('http://127.0.0.1:1').put!('x', 'v'), SecretWriteNotImplementedError);
    assert.equal(writableProvider([envProvider({})]), undefined);
    assert.equal(writableProvider([envProvider({}), provider])?.name, 'aws-sm');
  });

  it('wires gcpSecretManagerProvider into providersFromEnv', async () => {
    const { providersFromEnv } = await import('./index.js');
    const providers = providersFromEnv({ FACTORY_SECRETS_GCP_PROJECT: 'proj-123' });
    assert.ok(providers.some((p) => p.name === 'gcp-sm'));
  });

  it('secretPresent answers without the value; AWS reads metadata only (DescribeSecret), never the value', async () => {
    const { secretPresent } = await import('./index.js');
    const calls: string[][] = [];
    const aws = awsSecretsManagerProvider('factory/prod/', async (args) => {
      calls.push(args);
      const id = args[args.indexOf('--secret-id') + 1];
      if (id === 'factory/prod/HAVE') return '[true, true]\n';
      if (id === 'factory/prod/EMPTY') return '[true, false]\n'; // entry exists, no value was ever set
      if (id === 'factory/prod/DELETED') return '[false, true]\n'; // scheduled for deletion
      throw new Error('ResourceNotFoundException');
    });
    assert.equal(await secretPresent('HAVE', [aws]), true);
    assert.equal(await secretPresent('EMPTY', [aws]), false);
    assert.equal(await secretPresent('DELETED', [aws]), false);
    assert.equal(await secretPresent('NOPE', [aws]), false);
    for (const c of calls) {
      assert.equal(c[1], 'describe-secret');
      assert.equal(c.includes('get-secret-value'), false);
    }
    assert.equal(await secretPresent('A', [envProvider({ A: '' })]), false);
    assert.equal(await secretPresent('A', [envProvider({}), envProvider({ A: 'example-value' })]), true);
    const throwing = { name: 'broken', async get(): Promise<string | undefined> { throw new Error('down'); } };
    assert.equal(await secretPresent('A', [throwing, envProvider({ A: 'example-value' })]), true);
  });
});
