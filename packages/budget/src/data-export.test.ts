import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarizeCloud } from './cloud.js';
import { beerCanLabsFallback, rowsFromDataExport, snapshotFromRows } from './data-export.js';

const WINDOW = { start: '2026-11-01', end: '2026-12-01' };
const fixture = readFileSync(fileURLToPath(new URL('./fixtures/aws-data-export-cur2.csv', import.meta.url)), 'utf8');

describe('AWS data export ingest (issue #457)', () => {
  const snap = snapshotFromRows(rowsFromDataExport(fixture), WINDOW);
  const allocation = snap.allocation!;

  it('parses the redacted CUR 2.0 fixture into service, tag, and project breakdowns', () => {
    assert.equal(allocation.costCenter, 'beercanlabs');
    assert.equal(allocation.source, 'aws-data-export');
    assert.equal(allocation.centerCoverage, 1);
    assert.equal(allocation.totalUsd, 6.5);
    assert.equal(allocation.taggedUsd, 2);
    assert.equal(allocation.untaggedUsd, 4.5);
    assert.equal(allocation.taggedFraction, 0.3077);
    assert.deepEqual(allocation.bySubCenter, [
      { subCenter: 'untagged', usd: 4.5 },
      { subCenter: 'agent-factory', usd: 2 },
    ]);
    assert.deepEqual(allocation.byProject, [{ project: 'agent-factory', usd: 2 }]);
    const ecs = allocation.byService.find((s) => s.service === 'Amazon Elastic Container Service');
    assert.deepEqual(ecs, { service: 'Amazon Elastic Container Service', usd: 2, taggedUsd: 2, untaggedUsd: 0 });
    assert.deepEqual(allocation.byTag['cost-center'], [
      { value: 'beercanlabs', usd: 2 },
      { value: 'household', usd: 0.4 },
      { value: 'Cloud & AI', usd: 0.1 },
    ]);
    assert.ok(allocation.byTag.project.some((t) => t.value === 'home' && t.usd === 0.4));
    assert.ok(allocation.byTag.env.some((t) => t.value === 'prod'));
    assert.ok(allocation.byTag.owner.some((t) => t.value === 'dale'));
  });

  it('keeps the gross in line with summarizeCloud and leaves the credit off the center split', () => {
    const summary = summarizeCloud(snap);
    assert.equal(summary.grossUsd, allocation.totalUsd);
    assert.equal(summary.creditsUsd, -0.5);
    assert.equal(snap.lines.some((l) => l.recordType === 'Credit' && l.usd === -0.5), true);
    assert.equal(snap.usage.some((u) => u.usd === 99), false, 'the prior month stays out of the window');
  });

  it('maps untagged and foreign tags to BeerCanLabs / untagged and queues a backfill that is not applied', () => {
    const names = new Set([
      ...allocation.bySubCenter.map((s) => s.subCenter),
      ...allocation.byProject.map((p) => p.project),
    ]);
    assert.equal(names.has('household'), false);
    assert.equal(names.has('home'), false);
    assert.equal(names.has('cloud-and-ai'), false);
    assert.equal(names.has('Cloud & AI'), false);
    assert.equal(allocation.backfill.length, 3);
    assert.ok(allocation.backfill.every((p) => p.status === 'proposed' && p.applied === false && p.queuedFor === 'dale'));
    assert.ok(allocation.backfill.every((p) => p.proposedTags['cost-center'] === 'beercanlabs'));
    const household = allocation.backfill.find((p) => p.reason === 'foreign-cost-center');
    assert.equal(household?.observedCostCenter, 'household');
    assert.equal(household?.resourceId, 'arn:aws:s3:::example-mind');
    assert.equal(household?.usd, 0.4);
    const missing = allocation.backfill.find((p) => p.reason === 'missing-cost-center');
    assert.equal(missing?.resourceId, null);
    assert.equal(missing?.usd, 4);
    const invalid = allocation.backfill.find((p) => p.reason === 'invalid-tag');
    assert.equal(invalid?.observedCostCenter, 'Cloud & AI');
    assert.equal(JSON.stringify(allocation).includes('secretAccessKey'), false);
    assert.equal(JSON.stringify(allocation).includes('AKIA'), false);
  });

  it('collapses repeated untagged lines for one resource into one proposal', () => {
    const csv = [
      'line_item_usage_start_date,line_item_unblended_cost,product_product_name,line_item_resource_id',
      '2026-11-01,1.00,Amazon S3,arn:aws:s3:::example-mind',
      '2026-11-02,0.25,Amazon S3,arn:aws:s3:::example-mind',
    ].join('\n');
    const again = snapshotFromRows(rowsFromDataExport(csv), WINDOW).allocation!;
    assert.equal(again.backfill.length, 1);
    assert.equal(again.backfill[0].usd, 1.25);
    assert.equal(again.untaggedUsd, 1.25);
  });

  it('reads legacy CUR slash headers and a brace-form tag map', () => {
    const csv = [
      'lineItem/UsageStartDate,lineItem/LineItemType,lineItem/ProductCode,product/ProductName,lineItem/UsageType,lineItem/ResourceId,lineItem/UsageAmount,lineItem/UnblendedCost,resourceTags/user:cost-center,resourceTags/user:project,resourceTags/user:env,resourceTags/user:owner',
      '2026-11-08,Usage,AmazonECS,Amazon Elastic Container Service,USE1-Fargate,arn:aws:ecs:us-east-1:000000000000:service/factory/gate,1,3.00,beercanlabs,gatekeeper,prod,dale',
      '2026-11-09,Usage,AmazonECS,Amazon Elastic Container Service,USE1-Fargate,arn:aws:ecs:us-east-1:000000000000:service/factory/odd,1,1.00,beer-can-labs,gatekeeper,prod,dale',
    ].join('\n');
    const legacy = snapshotFromRows(rowsFromDataExport(csv), WINDOW).allocation!;
    assert.equal(legacy.taggedUsd, 3);
    assert.equal(legacy.bySubCenter.find((s) => s.subCenter === 'gatekeeper')?.usd, 3);
    assert.equal(legacy.untaggedUsd, 1);
    assert.equal(legacy.backfill[0].reason, 'foreign-cost-center');
    assert.equal(legacy.backfill[0].observedCostCenter, 'beer-can-labs');
    const brace = rowsFromDataExport(
      [
        'line_item_unblended_cost,product_product_name,resource_tags',
        '2.5,Amazon S3,"{user:cost-center=beercanlabs, user:project=agent-factory}"',
      ].join('\n'),
    );
    assert.equal(brace[0].tags['cost-center'], 'beercanlabs');
    assert.equal(brace[0].tags.project, 'agent-factory');
  });

  it('refuses a header that is not a cost export', () => {
    assert.throws(() => rowsFromDataExport('name,amount\nwidgets,1\n'), /unrecognized AWS data export/);
  });

  it('maps a tag-less Cost Explorer summary onto BeerCanLabs / untagged and proposes nothing', () => {
    const summary = summarizeCloud({
      provider: 'aws',
      start: '2026-11-01',
      end: '2026-11-09',
      lines: [
        { recordType: 'Usage', service: 'Amazon Elastic Container Service', usd: 40 },
        { recordType: 'Usage', service: 'Amazon Bedrock', usd: 10 },
        { recordType: 'Credit', service: 'Amazon Elastic Container Service', usd: -5 },
      ],
      usage: [],
    });
    const fallback = beerCanLabsFallback(summary);
    assert.equal(fallback.source, 'cost-explorer-fallback');
    assert.equal(fallback.costCenter, 'beercanlabs');
    assert.equal(fallback.totalUsd, 50);
    assert.equal(fallback.taggedUsd, 0);
    assert.equal(fallback.untaggedUsd, 50);
    assert.deepEqual(fallback.bySubCenter, [{ subCenter: 'untagged', usd: 50 }]);
    assert.equal(fallback.byProject.length, 0);
    assert.equal(fallback.backfill.length, 0);
    assert.equal(fallback.byService.some((s) => s.service === 'model inference' && s.untaggedUsd === 10), true);
    assert.equal(JSON.stringify(fallback).includes('household'), false);
    assert.match(fallback.notes[0], /Cost Explorer/);
    const failed = beerCanLabsFallback(summary, 'The Data Export could not be read. Totals are Cost Explorer.');
    assert.match(failed.notes[0], /could not be read/);
  });
});
