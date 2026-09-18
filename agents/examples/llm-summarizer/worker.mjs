#!/usr/bin/env node
// Reference LLM cartridge: plain fetch, no SDK, no provider key. The shim (or local runtime)
// sets ANTHROPIC_BASE_URL to the gateway and ANTHROPIC_API_KEY to this run's token.
const { FACTORY_URL, FACTORY_RUN_ID, FACTORY_RUN_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, FACTORY_MODEL } = process.env;
const run = `${FACTORY_URL.replace(/\/$/, '')}/api/v1/runs/${FACTORY_RUN_ID}`;
const auth = { Authorization: `Bearer ${FACTORY_RUN_TOKEN}`, 'Content-Type': 'application/json' };

const { input } = await (await fetch(`${run}/input`, { headers: auth })).json();
const res = await fetch(`${ANTHROPIC_BASE_URL.replace(/\/$/, '')}/v1/messages`, {
  method: 'POST',
  headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
  body: JSON.stringify({
    model: FACTORY_MODEL || 'claude-haiku-4-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: `Summarize in one sentence: ${input?.text ?? JSON.stringify(input)}` }],
  }),
});
const body = await res.json();
const report = res.ok
  ? { status: 'succeeded', output: body.content?.map((c) => c.text ?? '').join('').trim() }
  : { status: 'failed', error: `llm ${res.status}: ${body.error ?? 'error'}` };
await fetch(`${run}/result`, { method: 'POST', headers: auth, body: JSON.stringify(report) });
