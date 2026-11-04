#!/usr/bin/env node
// S6 (R12, D5): out-of-band lockout recovery with cloud IAM. Works any time, even while the control plane runs and even
// when an admin grant exists but nobody can reach it. Prints ids only; the break-glass plaintext goes straight to the
// secret store over stdin and is never printed.
//
//   node scripts/factory-recover.mjs --account 566332862296 [--email someone@example.com] [--reseed-break-glass]
//        [--secret-id factory/prod/BREAK_GLASS_KEY]
//
// Store locations come from the same env as the control plane: FACTORY_PRINCIPALS_STORE_URI, FACTORY_GRANTS_STORE_URI,
// FACTORY_KEYS_STORE_URI, FACTORY_RECOVERY_OUTBOX_URI (s3://..., gs://... or a local path).
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ApiKeyStore, GrantStore, PrincipalStore, docBackendFromUri } from '../packages/bouncer/dist/index.js';
import { recoverLockout } from '../packages/control-plane/dist/recover.js';

const { values: a } = parseArgs({
  options: {
    account: { type: 'string' },
    email: { type: 'string' },
    'reseed-break-glass': { type: 'boolean', default: false },
    'secret-id': { type: 'string', default: 'factory/prod/BREAK_GLASS_KEY' },
  },
});

function aws(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('aws', args, { maxBuffer: 1 << 20 }, (err, stdout, stderr) => (err ? reject(new Error(`aws ${args[0]} ${args[1]} failed: ${String(stderr).trim().slice(0, 300)}`)) : resolve(stdout)));
    if (input !== undefined) child.stdin.end(input);
  });
}

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must point at the deployment's store`);
  return v;
}

if (!a.account) throw new Error('--account is required (the deployment AWS account id)');
const who = JSON.parse(await aws(['sts', 'get-caller-identity', '--output', 'json']));
if (who.Account !== a.account) {
  console.error(`refusing: caller is in account ${who.Account}, expected ${a.account}`);
  process.exit(2);
}

const principals = await PrincipalStore.open(docBackendFromUri(need('FACTORY_PRINCIPALS_STORE_URI'), ''));
const grants = await GrantStore.open(docBackendFromUri(need('FACTORY_GRANTS_STORE_URI'), ''), { principals });
const keys = await ApiKeyStore.open(docBackendFromUri(need('FACTORY_KEYS_STORE_URI'), ''));
const outbox = docBackendFromUri(need('FACTORY_RECOVERY_OUTBOX_URI'), '');
if (!principals.healthy || !grants.healthy || !keys.healthy) throw new Error('a store could not be read; nothing changed');

const out = await recoverLockout({
  principals,
  grants,
  keys,
  outbox,
  operator: who.Arn,
  email: a.email,
  reseedBreakGlass: a['reseed-break-glass'],
  writeSecret: async (plaintext) => {
    // A 0600 file in a private temp dir, removed at once: /dev/stdin is not readable by the CLI in every container (#421).
    const dir = mkdtempSync(join(tmpdir(), 'factory-recover-'));
    const file = join(dir, 'secret');
    try {
      writeFileSync(file, plaintext, { mode: 0o600 });
      await aws(['secretsmanager', 'put-secret-value', '--secret-id', a['secret-id'], '--secret-string', `file://${file}`, '--query', 'VersionId', '--output', 'text']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
console.log(JSON.stringify({ recovered: true, ...out, secretId: a['reseed-break-glass'] ? a['secret-id'] : undefined }));
