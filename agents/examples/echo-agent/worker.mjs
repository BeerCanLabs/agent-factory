#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.MEMORY_DIR || '/tmp/echo-mind';
const { FACTORY_URL, FACTORY_RUN_ID, FACTORY_RUN_TOKEN } = process.env;

mkdirSync(dir, { recursive: true });
appendFileSync(join(dir, 'wake.log'), `${new Date().toISOString()} wake ${process.env.AGENT_ID} run ${FACTORY_RUN_ID ?? '-'}\n`);
console.log(`[echo-agent] woke; mind at ${dir}`);

if (FACTORY_URL && FACTORY_RUN_ID && FACTORY_RUN_TOKEN) {
  const base = `${FACTORY_URL.replace(/\/$/, '')}/api/v1/runs/${FACTORY_RUN_ID}`;
  const auth = { Authorization: `Bearer ${FACTORY_RUN_TOKEN}` };
  const { input } = await (await fetch(`${base}/input`, { headers: auth })).json();
  const res = await fetch(`${base}/result`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'succeeded', output: { echo: input } }),
  });
  console.log(`[echo-agent] reported result: ${res.status}`);
}
