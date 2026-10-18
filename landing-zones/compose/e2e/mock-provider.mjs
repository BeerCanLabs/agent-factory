// Stand-in for a model provider in the Compose proof. Deterministic by model so quality differs.
import http from 'node:http';

const KEY = 'sk-e2e-provider-key';

/**
 * OpenAI Chat Completions, as the gatekeeper-egress calls it for the factory model API (GAP-174). With the
 * read_document tool declared and no tool result yet, it asks for the document; given the result, test-big
 * summarizes it faithfully and test-small does not.
 */
function chatCompletion(body) {
  const { model, messages = [], tools = [] } = body;
  const result = [...messages].reverse().find((m) => m.role === 'tool');
  const wantsDocument = tools.some((t) => t?.function?.name === 'read_document');
  const message =
    !result && wantsDocument
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_doc', type: 'function', function: { name: 'read_document', arguments: '{}' } }] }
      : { role: 'assistant', content: model === 'test-big' ? `Summary: ${result?.content ?? ''}`.slice(0, 200) : 'Tokens are counted.' };
  return {
    model,
    choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1000, completion_tokens: 100 },
  };
}

http
  .createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const openAi = req.url?.endsWith('/chat/completions');
      const key = openAi ? req.headers.authorization?.replace(/^Bearer /, '') : req.headers['x-api-key'];
      if (key !== KEY) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"error":"bad key"}');
      }
      const body = JSON.parse(b || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (openAi) return res.end(JSON.stringify(chatCompletion(body)));
      const text = body.model === 'test-big' ? 'The gatekeeper-egress meters every token.' : 'Tokens are counted.';
      res.end(JSON.stringify({ model: body.model, content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 100 } }));
    });
  })
  .listen(8080, () => console.log('[mock-provider] :8080'));
