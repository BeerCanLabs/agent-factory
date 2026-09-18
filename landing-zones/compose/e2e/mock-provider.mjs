// Stand-in for a model provider in the Compose proof. Deterministic by model so quality differs.
import http from 'node:http';
http
  .createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.headers['x-api-key'] !== 'sk-e2e-provider-key') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"error":"bad key"}');
      }
      const { model } = JSON.parse(b || '{}');
      const text = model === 'test-big' ? 'The gateway meters every token.' : 'Tokens are counted.';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model, content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 100 } }));
    });
  })
  .listen(8080, () => console.log('[mock-provider] :8080'));
