import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

  it('wires gcpSecretManagerProvider into providersFromEnv', async () => {
    const { providersFromEnv } = await import('./index.js');
    const providers = providersFromEnv({ FACTORY_SECRETS_GCP_PROJECT: 'proj-123' });
    assert.ok(providers.some((p) => p.name === 'gcp-sm'));
  });
});

