#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { benchSchema } from '@beercanlabs/factory-contract';
import { httpClient, matrix, recommend, runBench, summarize } from './index.js';

const { values } = parseArgs({
  options: {
    cartridge: { type: 'string' },
    agent: { type: 'string' },
    models: { type: 'string' },
    url: { type: 'string', default: process.env.FACTORY_URL },
    token: { type: 'string', default: process.env.FACTORY_TOKEN },
    'runs-per-month': { type: 'string', default: '10000' },
    'min-pass': { type: 'string', default: '0.9' },
    json: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
});

function fail(msg: string): never {
  console.error(`factory-bench: ${msg}`);
  console.error('usage: factory-bench --cartridge <dir> --models a,b [--agent id] [--url URL --token T] [--runs-per-month N] [--min-pass 0.9] [--json out.json] [--apply]');
  process.exit(2);
}

if (!values.cartridge || !values.models) fail('--cartridge and --models are required');
if (!values.url || !values.token) fail('--url/--token (or FACTORY_URL/FACTORY_TOKEN) are required');
const dir = resolve(values.cartridge);
const parsed = benchSchema.safeParse(parseYaml(readFileSync(join(dir, 'bench.yaml'), 'utf8')));
if (!parsed.success) fail(`invalid bench.yaml: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
const agentId = values.agent ?? basename(dir);
const models = values.models.split(',').map((m) => m.trim()).filter(Boolean);
const client = httpClient(values.url, values.token);

const results = await runBench(client, agentId, parsed.data, models, {
  onCase: (r) => console.error(`${r.pass ? 'pass' : 'FAIL'}  ${r.model}  ${r.caseId}  $${r.costUsd.toFixed(6)}  ${r.seconds.toFixed(1)}s${r.reason ? `  ${r.reason}` : ''}`),
});
const summaries = summarize(results);
const runsPerMonth = Number(values['runs-per-month']);
console.log(`\n${matrix(summaries, runsPerMonth)}\n`);

const rec = recommend(summaries, { minPassRate: Number(values['min-pass']) });
if (!rec) {
  console.log(`No model reached a ${(Number(values['min-pass']) * 100).toFixed(0)}% pass rate. No policy recommended.`);
} else {
  console.log(`Recommended: ${rec.model}. Policy patch for ${agentId}:\n${JSON.stringify(rec.policyPatch, null, 2)}`);
  if (values.apply) {
    const current = await client.getPolicy(agentId);
    const status = await client.putPolicy(agentId, { ...current, ...rec.policyPatch });
    console.log(status === 200 ? `Applied to ${agentId}.` : `Apply failed: HTTP ${status} (needs the admin role).`);
  }
}
if (values.json) writeFileSync(values.json, JSON.stringify({ agentId, models, runsPerMonth, results, summaries, recommendation: rec }, null, 2));
process.exit(rec ? 0 : 1);
