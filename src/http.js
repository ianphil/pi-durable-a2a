import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { AgentCard } from '@a2a-js/sdk';
import { JsonRpcTransportHandler, ServerCallContext } from '@a2a-js/sdk/server';
import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server';

const maxBodyBytes = 32_768;

// Deployed LiteLLM forwards task controls to the registered base URL with v0.3 method
// names. Remove once native get/list/cancel pass through the gateway:
// https://github.com/BerriAI/litellm/pull/44769
function gatewayTaskTransport(handler) {
  const native = new JsonRpcTransportHandler(handler);
  const legacy = new LegacyJsonRpcTransportHandler(handler);
  return async (text, call) => {
    let body;
    try { body = JSON.parse(text); } catch { return native.handle(text, call); }
    if (body?.method === 'tasks/list') return native.handle({ ...body, method: 'ListTasks' }, call);
    if (body?.method === 'tasks/get' || body?.method === 'tasks/cancel') return legacy.handle(body, call);
    return native.handle(text, call);
  };
}

/**
 * HTTP listener for an `openA2A` bridge: bearer-authenticated Agent Card, JSON-RPC at
 * `/a2a`, the gateway task adapter at `/`, and unauthenticated health checks.
 * The caller chooses where it listens and closes the bridge afterwards.
 *
 * @param {Awaited<ReturnType<typeof import('./a2a.js').openA2A>>} bridge
 * @param {{ token: string }} options Listener bearer token, 32 or more base64url characters.
 */
export function createA2AServer(bridge, { token }) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('listener_token_invalid');
  const expected = Buffer.from(`Bearer ${token}`);
  const native = new JsonRpcTransportHandler(bridge.handler);
  const gateway = gatewayTaskTransport(bridge.handler);
  const server = createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && req.url === '/health') return json(200, { status: 'ok' });
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) { req.resume(); return json(401, { error: 'Unauthorized' }); }
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') return json(200, AgentCard.toJSON(bridge.card));
    if (req.method !== 'POST' || !['/a2a', '/'].includes(req.url ?? '')) { req.resume(); return json(404, { error: 'Not found' }); }
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
      const result = req.url === '/' ? await gateway(text, call) : await native.handle(text, call);
      if (Symbol.asyncIterator in result) return json(400, { error: 'Streaming unsupported' });
      if (!res.destroyed) json(200, result);
    } catch {
      if (!res.destroyed) json(500, { error: 'Request failed' });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  return server;
}
