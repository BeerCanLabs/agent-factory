import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { authorize } from '@beercanlabs/factory-bouncer';
import type { FactoryState } from './app.js';
import type { Inspector } from '@beercanlabs/factory-inspector';

/**
 * WebSocket event stream at /api/v1/events (viewer). Pushes metadata-only ledger rows and run state
 * changes as they happen, optionally filtered by ?agent=. Auth: `Authorization: Bearer <token>`, or
 * for browsers the subprotocol pair `bearer, <token>`.
 */
export function attachEventStream(server: http.Server, state: FactoryState, events: Pick<Inspector, 'subscribe'>): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://factory.local');
    if (url.pathname !== '/api/v1/events') {
      socket.destroy();
      return;
    }
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim());
    const fromProtocol = protocols[0] === 'bearer' && protocols[1] ? `Bearer ${protocols[1]}` : undefined;
    const result = await state.auth.verify(req.headers.authorization ?? fromProtocol);
    if (!result.ok || !authorize({ principal: result.principal, privilege: 'events.subscribe' }).allowed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const agent = url.searchParams.get('agent');
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const off = events.subscribe((e) => {
        if (agent && e.agentId !== agent) return;
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
      });
      ws.on('close', off);
      ws.send(JSON.stringify({ kind: 'hello', actor: result.principal.actor, agent }));
    });
  });
  return wss;
}
