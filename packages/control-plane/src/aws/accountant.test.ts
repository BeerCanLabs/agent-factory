import { strict as assert } from 'node:assert';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { AwsCostSource } from './accountant.js';
import { DataExportReadError, DataExportReader, dataExportLocationFromEnv, keysForMonth, type DataExportClient } from './data-export.js';

const WINDOW = { start: '2026-11-01', end: '2026-12-01' };
const fixture = readFileSync(fileURLToPath(new URL('../../../../packages/budget/src/fixtures/aws-data-export-cur2.csv', import.meta.url)), 'utf8');
const gz = gzipSync(Buffer.from(fixture));

type Stored = { body: Buffer; size?: number };

function fakeS3(objects: Record<string, Stored>, opts: { pages?: boolean; failGet?: Error } = {}): DataExportClient & { calls: string[] } {
  const calls: string[] = [];
  const keys = Object.keys(objects);
  return {
    calls,
    async send(cmd) {
      calls.push(cmd.constructor.name);
      if (cmd instanceof ListObjectsV2Command) {
        const prefix = cmd.input.Prefix ?? '';
        const matched = keys.filter((k) => k.startsWith(prefix));
        if (opts.pages && !cmd.input.ContinuationToken && matched.length > 1) {
          return {
            Contents: [{ Key: matched[0], Size: objects[matched[0]].size ?? objects[matched[0]].body.length }],
            IsTruncated: true,
            NextContinuationToken: 'page-2',
          };
        }
        const rest = opts.pages && cmd.input.ContinuationToken ? matched.slice(1) : matched;
        return { Contents: rest.map((Key) => ({ Key, Size: objects[Key].size ?? objects[Key].body.length })), IsTruncated: false };
      }
      if (cmd instanceof GetObjectCommand) {
        if (opts.failGet) throw opts.failGet;
        const stored = objects[cmd.input.Key ?? ''];
        if (!stored) throw new Error('NoSuchKey');
        return { Body: { transformToByteArray: async () => new Uint8Array(stored.body) }, ContentLength: stored.body.length };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  };
}

function emptyCe() {
  const calls: string[] = [];
  return {
    calls,
    async send(cmd: { constructor: { name: string } }) {
      calls.push(cmd.constructor.name);
      return { ResultsByTime: [] };
    },
  };
}

const location = { bucket: 'factory-data-exports', prefix: 'exports/' };

describe('Data Export location', () => {
  it('requires an s3 uri with a prefix and ignores an unset variable', () => {
    assert.deepEqual(dataExportLocationFromEnv({}), { ok: false });
    assert.deepEqual(dataExportLocationFromEnv({ FACTORY_AWS_DATA_EXPORT_URI: 's3://factory-data-exports/exports' }), {
      ok: true,
      location,
    });
    const bad = dataExportLocationFromEnv({ FACTORY_AWS_DATA_EXPORT_URI: 's3://bucket' });
    assert.equal(bad.ok, false);
    assert.match(bad.ok ? '' : (bad.error ?? ''), /s3:\/\/bucket\/prefix/);
    assert.equal(dataExportLocationFromEnv({ FACTORY_AWS_DATA_EXPORT_URI: 's3://bucket/../exports' }).ok, false);
    assert.equal(JSON.stringify(bad).includes('566332862296'), false);
  });

  it('keeps a billing-period file and drops parquet, manifests, and other months', () => {
    const keys = [
      'exports/cur/data/BILLING_PERIOD=2026-11/part.csv.gz',
      'exports/cur/data/BILLING_PERIOD=2026-10/old.csv.gz',
      'exports/cur/data/BILLING_PERIOD=2026-11/file.parquet',
      'exports/cur/2026-11-Manifest.json',
    ];
    assert.deepEqual(keysForMonth(keys, '2026-11'), ['exports/cur/data/BILLING_PERIOD=2026-11/part.csv.gz']);
  });
});

describe('Accountant reads a fixture export and falls back to Cost Explorer', () => {
  it('ingests a gzipped CUR 2.0 object and does not call Cost Explorer', async () => {
    const s3 = fakeS3({
      'exports/cur/data/BILLING_PERIOD=2026-11/part-0001.csv.gz': { body: gz },
      'exports/cur/data/BILLING_PERIOD=2026-10/old.csv.gz': { body: gzipSync(Buffer.from('not,read')) },
      'exports/cur/2026-11-Manifest.json': { body: Buffer.from('{}') },
    }, { pages: true });
    const ce = emptyCe();
    const source = new AwsCostSource(ce, new DataExportReader(s3, location));
    const snap = await source.costs(WINDOW);
    assert.equal(ce.calls.length, 0);
    assert.ok(s3.calls.includes('ListObjectsV2Command'));
    assert.equal(s3.calls.filter((c) => c === 'GetObjectCommand').length, 1);
    assert.equal(snap.allocation?.source, 'aws-data-export');
    assert.equal(snap.allocation?.costCenter, 'beercanlabs');
    assert.equal(snap.allocation?.totalUsd, 6.5);
    assert.equal(snap.allocation?.untaggedUsd, 4.5);
    assert.ok(snap.allocation?.backfill.every((p) => p.applied === false));
    assert.equal(JSON.stringify(snap).includes('secretAccessKey'), false);
    assert.equal(JSON.stringify(snap).includes('AKIA'), false);
  });

  it('rejects a gzip payload whose inflated size exceeds the cap, and does not call it invalid gzip', async () => {
    const inflated = Buffer.alloc(32 * 1024 * 1024 + 64);
    const body = gzipSync(inflated);
    assert.ok(body.length < 32 * 1024 * 1024, 'the compressed bomb stays under the download cap');
    const s3 = fakeS3({ 'exports/part.csv.gz': { body } });
    await assert.rejects(
      () => new DataExportReader(s3, location).load(WINDOW),
      (err: unknown) => {
        assert.ok(err instanceof DataExportReadError);
        assert.match(err.message, /33554432 bytes uncompressed/);
        assert.doesNotMatch(err.message, /not gzip/);
        return true;
      },
    );
  });

  it('uses Cost Explorer when the prefix has no data file for the month', async () => {
    const s3 = fakeS3({ 'exports/cur/data/BILLING_PERIOD=2026-11/file.parquet': { body: Buffer.from('PAR1') } });
    const ce = emptyCe();
    const snap = await new AwsCostSource(ce, new DataExportReader(s3, location)).costs(WINDOW);
    assert.equal(ce.calls.length, 2);
    assert.equal(snap.allocation, undefined);
    assert.equal(snap.exportNote, undefined);
  });

  it('uses Cost Explorer when the object is not a cost export, and drops credential text from the log', async () => {
    const s3 = fakeS3(
      { 'exports/part.csv': { body: Buffer.from('name,amount\nwidgets,1\n') } },
    );
    const ce = emptyCe();
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      const snap = await new AwsCostSource(ce, new DataExportReader(s3, location)).costs(WINDOW);
      assert.equal(snap.exportNote, 'The Data Export could not be read. Totals are Cost Explorer.');
      assert.ok(ce.calls.length >= 2);
    } finally {
      console.error = orig;
    }
    const leaking = fakeS3({}, { failGet: new Error('SignatureDoesNotMatch AKIAEXAMPLESECRET') });
    leaking.send = async (cmd) => {
      if (cmd instanceof ListObjectsV2Command) return { Contents: [{ Key: 'exports/part.csv', Size: 4 }], IsTruncated: false };
      throw new Error('SignatureDoesNotMatch AKIAEXAMPLESECRET');
    };
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      await new AwsCostSource(emptyCe(), new DataExportReader(leaking, location)).costs(WINDOW);
    } finally {
      console.error = orig;
    }
    assert.match(errors.join('\n'), /using Cost Explorer/);
    assert.equal(errors.join('\n').includes('AKIA'), false);
  });
});

describe('accountant IAM stays a read of the export prefix (#457, GAP-265)', () => {
  const tf = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../landing-zones/aws/${name}`, import.meta.url)), 'utf8');
  const block = (src: string, header: string) => {
    const start = src.indexOf(header);
    assert.ok(start >= 0, header);
    return src.slice(start, src.indexOf('\n}\n', start) + 2);
  };
  const allowActions = (src: string) => [...src.matchAll(/Effect\s*=\s*"Allow"[\s\S]*?Action\s*=\s*\[([^\]]+)\]/g)]
    .flatMap((m) => m[1].split(',').map((a) => a.trim().replace(/"/g, '')).filter(Boolean));

  it('the accountant may read the export and cannot modify billing, payments, or resource lifecycle', () => {
    const iam = tf('iam.tf');
    const policy = block(iam, 'resource "aws_iam_role_policy" "accountant"');
    assert.deepEqual(allowActions(policy).sort(), [
      'ce:GetCostAndUsage',
      'ce:GetCostForecast',
      'ce:GetDimensionValues',
      'ecs:DescribeServices',
      'ecs:DescribeTasks',
      'ecs:ListServices',
      'ecs:ListTasks',
      's3:GetObject',
      's3:ListBucket',
    ].sort());
    assert.equal(allowActions(policy).some((a) => a.includes('*')), false);
    const get = policy.slice(policy.indexOf('Sid      = "DataExportRead"'));
    assert.match(get, /Action\s*=\s*\["s3:GetObject"\]/);
    assert.match(get, /Resource = "\$\{aws_s3_bucket\.data_exports\.arn\}\/exports\/\*"/);
    const list = policy.slice(policy.indexOf('Sid      = "DataExportList"'), policy.indexOf('Sid      = "DataExportRead"'));
    assert.match(list, /Action\s*=\s*\["s3:ListBucket"\]/);
    assert.match(list, /Resource = aws_s3_bucket\.data_exports\.arn/);
    assert.match(list, /"s3:prefix" = \["exports\/", "exports\/\*"\]/);
    const deny = policy.slice(policy.indexOf('Sid    = "NeverModifyBillingPaymentsOrResources"'));
    for (const action of [
      'bcm-data-exports:*',
      'payments:*',
      'invoicing:*',
      's3:PutObject',
      's3:DeleteObject',
      's3:DeleteObjectVersion',
      'ecs:RunTask',
      'ecs:StopTask',
      'ecs:UpdateService',
      'ec2:TerminateInstances',
      'iam:*',
      'sts:AssumeRole',
      'ce:Create*',
      'ce:Update*',
      'ce:Delete*',
    ]) {
      assert.match(deny, new RegExp(action.replace(/[.*]/g, '\\$&')), action);
    }
    assert.doesNotMatch(deny, /"s3:GetObject"/);
    assert.doesNotMatch(deny, /"s3:ListBucket"/);
    assert.doesNotMatch(deny, /"ce:GetCostAndUsage"/);
    const paas = block(iam, 'resource "aws_iam_role_policy" "control_plane_paas"');
    assert.equal(paas.includes('data_exports'), false);
    assert.equal(paas.includes('bcm-data-exports'), false);
    assert.equal(iam.includes('566332862296'), false);
  });

  it('the delivery bucket lets Data Exports put objects and nothing else, and the control plane is pointed at the prefix', () => {
    const storage = tf('storage.tf');
    const policy = block(storage, 'resource "aws_s3_bucket_policy" "data_exports"');
    assert.deepEqual(allowActions(policy), ['s3:PutObject']);
    assert.match(policy, /bcm-data-exports\.amazonaws\.com/);
    assert.doesNotMatch(policy, /billingreports\.amazonaws\.com/);
    assert.match(policy, /"aws:SourceAccount" = var\.account_id/);
    assert.match(policy, /arn:aws:bcm-data-exports:us-east-1:\$\{var\.account_id\}:export\/\*/);
    assert.match(policy, /\$\{aws_s3_bucket\.data_exports\.arn\}\/\*/);
    assert.match(storage, /sse_algorithm = "AES256"/);
    assert.match(storage, /object_ownership = "BucketOwnerEnforced"/);
    assert.equal(storage.includes('566332862296'), false);
    const ecs = tf('ecs.tf');
    assert.match(ecs, /\{ name = "FACTORY_AWS_DATA_EXPORT_URI", value = "s3:\/\/\$\{aws_s3_bucket\.data_exports\.bucket\}\/exports" \}/);
    assert.match(tf('outputs.tf'), /output "data_export_uri"/);
  });
});
