#!/usr/bin/env node
// Reference LLM cartridge and the factory's validation agent (GAP-174): plain fetch, no SDK, no provider key.
// It calls the factory model API (FACTORY_MODEL_BASE_URL, OpenAI Chat Completions, §6.9 M1) with the model the
// factory assigned (FACTORY_MODEL, M2) and reads its document through a tool, so one run proves a model call and a
// tool round trip end to end.
const { FACTORY_URL, FACTORY_RUN_ID, FACTORY_RUN_TOKEN, FACTORY_MODEL_BASE_URL, FACTORY_MODEL } = process.env;
const run = `${FACTORY_URL.replace(/\/$/, '')}/api/v1/runs/${FACTORY_RUN_ID}`;
const auth = { Authorization: `Bearer ${FACTORY_RUN_TOKEN}`, 'Content-Type': 'application/json' };

const { input } = await (await fetch(`${run}/input`, { headers: auth })).json();
const document = typeof input?.text === 'string' ? input.text : JSON.stringify(input ?? {});

const tools = [
  {
    type: 'function',
    function: { name: 'read_document', description: 'Returns the document to summarize.', parameters: { type: 'object', properties: {} } },
  },
];
const messages = [
  {
    role: 'system',
    content:
      'You summarize documents. Always call read_document to get the document; never invent its content. ' +
      'Reply with one sentence, and copy any reference code in the document exactly.',
  },
  { role: 'user', content: 'Summarize the document.' },
];

async function complete() {
  const res = await fetch(`${FACTORY_MODEL_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ model: FACTORY_MODEL, max_tokens: 300, messages, tools }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`llm ${res.status}: ${body.error ?? 'error'}`);
  return body.choices?.[0]?.message ?? {};
}

let report;
try {
  let summary;
  for (let turn = 0; turn < 3 && summary === undefined; turn++) {
    const message = await complete();
    if (message.tool_calls?.length) {
      messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        const known = call.function?.name === 'read_document';
        messages.push({ role: 'tool', tool_call_id: call.id, content: known ? document : `unknown tool ${call.function?.name}` });
      }
    } else {
      summary = String(message.content ?? '').trim();
    }
  }
  report = summary ? { status: 'succeeded', output: summary } : { status: 'failed', error: 'no summary after 3 model turns' };
} catch (err) {
  report = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
}
await fetch(`${run}/result`, { method: 'POST', headers: auth, body: JSON.stringify(report) });
