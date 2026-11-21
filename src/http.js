import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { AgentCard } from '@a2a-js/sdk';
import { JsonRpcTransportHandler, ServerCallContext } from '@a2a-js/sdk/server';

const maxBodyBytes = 32_768;

/**
 * Node HTTP callback a host can mount in its server. Serves native JSON-RPC at
 * `/a2a`, the authenticated Agent Card and unauthenticated `/health`.
 * Additional POST paths use SDK-style `(text, call) => result` transports, behind
 * the same authentication and body limits. `/a2a` always uses the native SDK.
 *
 * @param {Awaited<ReturnType<typeof import('./a2a.js').openA2A>>} bridge
 * @param {{ token: string, extraRoutes?: Record<string, (text: string,
 *   call: ServerCallContext) => Promise<object>> }} options
 *   Listener token: 32 or more base64url characters.
 * @returns {import('node:http').RequestListener}
 */
export function createA2AHttpHandler(bridge, { token, extraRoutes = {} }) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('listener_token_invalid');
  const expected = Buffer.from(`Bearer ${token}`);
  const native = new JsonRpcTransportHandler(bridge.handler);
  const routes = new Map(Object.entries(extraRoutes));
  routes.set('/a2a', (text, call) => native.handle(text, call));
  return async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && req.url === '/health') return json(200, { status: 'ok' });
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) { req.resume(); return json(401, { error: 'Unauthorized' }); }
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') return json(200, AgentCard.toJSON(bridge.card));
    const transport = routes.get(req.url ?? '');
    if (req.method !== 'POST' || !transport) { req.resume(); return json(404, { error: 'Not found' }); }
    if (!/^application\/(?:a2a\+)?json(?:;|$)/i.test(req.headers['content-type'] ?? '')) { req.resume(); return json(415, { error: 'Content type' }); }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBodyBytes) return json(413, { error: 'Request too large' });
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const version = req.headers['a2a-version'];
      const call = new ServerCallContext({ requestedVersion: typeof version === 'string' ? version : '' });
      const result = await transport(text, call);
      if (Symbol.asyncIterator in result) return json(400, { error: 'Streaming unsupported' });
      if (!res.destroyed) json(200, result);
    } catch {
      if (!res.destroyed) json(500, { error: 'Request failed' });
    }
  };
}

/** Convenience server; hosts can instead mount `createA2AHttpHandler` themselves. */
export function createA2AServer(bridge, options) {
  const server = createServer(createA2AHttpHandler(bridge, options));
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  return server;
}
