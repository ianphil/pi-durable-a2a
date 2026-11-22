import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { A2AExtension, createA2AHttpHandler, createA2AServer, openA2A } from 'pi-durable-a2a';
import { liteLLMTaskHandler } from 'pi-durable-a2a/litellm';
import { AgentCard, GetTaskRequest } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { createSmokeFetch, runGatewaySmoke } from '../scripts/gateway-smoke.js';

const token = 'a'.repeat(40);

async function listener(use, { mounted = false, compatibility = false } = {}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(A2AExtension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const model = faux.getModel();
  const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  const a2a = await openA2A({ harness, conversation, card: {
    name: 'fixture', description: 'HTTP integration', url: 'http://localhost/a2a', skills: [],
  } });
  const options = { token, ...(compatibility ? { extraRoutes: { '/': liteLLMTaskHandler(a2a.handler) } } : {}) };
  let server;
  if (mounted) {
    const handler = createA2AHttpHandler(a2a, options);
    server = createServer((req, res) => {
      if (req.url === '/host') { res.end('Host-owned endpoint'); return; }
      return handler(req, res);
    });
  } else server = createA2AServer(a2a, options);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    a2a.card.supportedInterfaces[0].url = `${base}/a2a`;
    const rpc = (path, method, params, { version = '1.0', headers = {} } = {}) => fetch(`${base}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        ...(version ? { 'a2a-version': version } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const send = async (messageId, text, configuration) => {
      const response = await rpc('/a2a', 'SendMessage', {
        message: { messageId, role: 'ROLE_USER', parts: [{ text }] }, configuration,
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ifError(body.error);
      return body.result.task;
    };
    await use({ base, faux, a2a, rpc, send, server });
  } finally {
    server.close();
    server.closeAllConnections();
    await a2a.close();
    await harness.close(context);
  }
}

async function protections({ base, rpc, faux }, path) {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/.well-known/agent-card.json`)).status, 401);
  const card = await fetch(`${base}/.well-known/agent-card.json`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(card.status, 200);
  assert.equal((await card.json()).name, 'fixture');
  const params = { message: { messageId: 'unauthorized', role: 'ROLE_USER', parts: [{ text: 'Hello' }] } };
  assert.equal((await rpc(path, 'SendMessage', params, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal(faux.state.callCount, 0);
  assert.equal((await rpc(path, 'GetTask', { id: 'missing' }, { headers: { 'content-type': 'text/plain' } })).status, 415);
  const oversized = await fetch(`${base}${path}`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: ' '.repeat(32_769) });
  assert.equal(oversized.status, 413);
}

test('convenience server is native-only and retains HTTP protections', async () => {
  await listener(async (running) => {
    await protections(running, '/a2a');
    assert.equal(running.server.requestTimeout, 10_000);
    assert.equal(running.server.headersTimeout, 5_000);
    assert.equal((await running.rpc('/', 'tasks/get', { id: 'missing' }, { version: null })).status, 404);
    const wrongMethod = await running.rpc('/a2a', 'tasks/get', { id: 'missing' }, { version: null });
    assert.equal((await wrongMethod.json()).error.code, -32601);
    running.faux.setResponses([fauxAssistantMessage('Native answer')]);
    const task = await running.send('native', 'Hello');
    const fetched = await running.rpc('/a2a', 'GetTask', { id: task.id });
    assert.equal((await fetched.json()).result.id, task.id);
  });
});

test('Node HTTP handler mounts beside a host-owned endpoint', async () => {
  await listener(async (running) => {
    assert.equal(await (await fetch(`${running.base}/host`)).text(), 'Host-owned endpoint');
    await protections(running, '/a2a');
    running.faux.setResponses([fauxAssistantMessage('Mounted answer')]);
    const task = await running.send('mounted', 'Hello');
    assert.match(JSON.stringify(task.status), /Mounted answer/);
    assert.equal((await running.rpc('/', 'GetTask', { id: task.id })).status, 404);
  }, { mounted: true });
});

test('LiteLLM forwarding is opt-in and uses SDK task compatibility', { timeout: 5000 }, async (t) => {
  for (const mounted of [false, true]) await t.test(mounted ? 'mounted handler' : 'convenience server', async () => {
    await listener(async (running) => {
      await protections(running, '/');
      running.faux.setResponses([fauxAssistantMessage('First answer')]);
      const first = await running.send('first', 'Hello');
      running.faux.setResponses([fauxAssistantMessage('Second answer')]);
      const second = await running.send('second', 'Follow up');
      const get = await running.rpc('/', 'tasks/get', { id: first.id }, { version: null });
      const legacy = (await get.json()).result;
      assert.equal(legacy.id, first.id);
      assert.equal(legacy.status.state, 'completed');
      assert.match(JSON.stringify(legacy.status), /First answer/);
      const page = (await (await running.rpc('/', 'tasks/list', { pageSize: 1 }, { version: null })).json()).result;
      assert.equal(page.tasks[0].id, second.id);
      assert.ok(page.nextPageToken);
      const next = (await (await running.rpc('/', 'tasks/list', { pageSize: 1, pageToken: page.nextPageToken },
        { version: null })).json()).result;
      assert.equal(next.tasks[0].id, first.id);
      const nativeAlias = await running.rpc('/a2a', 'tasks/get', { id: first.id }, { version: null });
      assert.equal((await nativeAlias.json()).error.code, -32601, 'opt-in compatibility does not change the native path');

      const started = Promise.withResolvers();
      const release = Promise.withResolvers();
      running.faux.setResponses([async (_transcript, options) => {
        const abort = () => release.resolve();
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
        started.resolve();
        try { await release.promise; return fauxAssistantMessage('Must not become an answer'); }
        finally { options.signal.removeEventListener('abort', abort); }
      }]);
      try {
        const pending = await running.send('cancel', 'Slow work', { returnImmediately: true });
        await started.promise;
        const canceled = (await (await running.rpc('/', 'tasks/cancel', { id: pending.id }, { version: null })).json()).result;
        assert.equal(canceled.id, pending.id);
        assert.equal(canceled.status.state, 'canceled');
        const after = (await (await running.rpc('/', 'tasks/get', { id: pending.id }, { version: null })).json()).result;
        assert.equal(after.status.state, 'canceled');
      } finally { release.resolve(); }
    }, { mounted, compatibility: true });
  });
});

test('parameterised smoke exercises the SDK against real Durable execution', { timeout: 5000 }, async () => {
  await listener(async ({ base, a2a, faux }) => {
    const fetchImpl = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    };
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })] })
      .createFromAgentCard({ ...a2a.card,
        supportedInterfaces: a2a.card.supportedInterfaces.map((entry) => ({ ...entry, url: `${base}/a2a` })),
      });
    const complete = Promise.withResolvers();
    const cancel = Promise.withResolvers();
    const echoMarker = (transcript) => fauxAssistantMessage(JSON.stringify(transcript.messages).match(/smoke-[0-9a-f-]+-marker/)[0]);
    faux.setResponses([echoMarker, echoMarker,
      async () => { await complete.promise; return fauxAssistantMessage('Read-only report'); },
      async (_transcript, options) => {
        const abort = () => cancel.resolve();
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
        try { await cancel.promise; return fauxAssistantMessage('Must not become an answer'); }
        finally { options.signal.removeEventListener('abort', abort); }
      },
    ]);
    const checks = [];
    try {
      const result = await runGatewaySmoke(client, { slowPrompt: 'Read a large collection of issues.', pollMs: 10,
        report: (event) => {
          checks.push(event.check);
          if (event.check === 'working/busy') complete.resolve();
        },
      });
      assert.ok(result.firstTaskId);
      assert.deepEqual(checks, ['send/get', 'idempotency/conflicting-text', 'follow-up', 'paginated-list',
        'started', 'working/busy', 'polled-completed', 'canceled/stable-get']);
    } finally { complete.resolve(); cancel.resolve(); }
  });
});

test('example client sends, retries, follows up and retrieves without another model call', { timeout: 10_000 }, async () => {
  await listener(async ({ base, faux }) => {
    const echoMarker = (transcript) => fauxAssistantMessage(JSON.stringify(transcript.messages).match(/example-[0-9a-f-]+/)[0]);
    faux.setResponses([echoMarker, echoMarker]);
    const run = promisify(execFile);
    const file = fileURLToPath(new URL('../examples/client.js', import.meta.url));
    const env = { ...process.env, A2A_URL: base, A2A_TOKEN: token, TASK_ID: '' };
    const first = await run(process.execPath, [file], { env, timeout: 5000 });
    assert.match(first.stdout, /Same-ID retry returned the original task/);
    assert.match(first.stdout, /Follow-up recalled the marker/);
    const id = first.stdout.match(/Saved task: (\d+)/)[1];
    const retrieved = await run(process.execPath, [file], { env: { ...env, TASK_ID: id }, timeout: 5000 });
    assert.equal(JSON.parse(retrieved.stdout).id, id);
    assert.equal(faux.state.callCount, 2, 'retry and get do not invoke the model');
  });
});

test('smoke fetch preserves headers and replaces authorization on its configured origin', async () => {
  await listener(async ({ base, server }) => {
    const fetchImpl = createSmokeFetch(base, token);
    let customHeader;
    server.on('request', (req) => { customHeader = req.headers['x-smoke']; });
    const headers = { 'content-type': 'application/json', 'a2a-version': '1.0', 'x-smoke': 'kept',
      authorization: 'Bearer stale' };
    const request = { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: '1' } }) };
    for (const value of [headers, new Headers(headers), Object.entries(headers)]) {
      const response = await fetchImpl(new URL(`${base}/a2a`), { ...request, headers: value });
      assert.equal(response.status, 200, 'authentication and content type must survive');
      assert.ok((await response.json()).error, 'unknown task is handled by the SDK');
      assert.equal(customHeader, 'kept');
    }
    const response = await fetchImpl(new Request(`${base}/a2a`, { ...request, headers }));
    assert.equal(response.status, 200, 'Request headers are inherited when init has none');
    await response.json();
    assert.equal(customHeader, 'kept');
  });
});

test('smoke refuses foreign card endpoints and redirects before contacting their target', async (t) => {
  await listener(async ({ base, a2a, server }) => {
    let targetRequests = 0;
    server.on('request', () => { targetRequests++; });
    for (const redirect of [false, true]) await t.test(redirect ? 'redirect' : 'advertised endpoint', async () => {
      let discoveryAuthorization;
      const discovery = createServer((req, res) => {
        discoveryAuthorization = req.headers.authorization;
        if (redirect) { res.writeHead(302, { location: `${base}/.well-known/agent-card.json` }); res.end(); return; }
        const card = { ...a2a.card, supportedInterfaces: a2a.card.supportedInterfaces.map((entry) => ({ ...entry, url: `${base}/a2a` })) };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(AgentCard.toJSON(card)));
      });
      try {
        await new Promise((resolve) => discovery.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${discovery.address().port}`;
        const fetchImpl = createSmokeFetch(url, token);
        const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })],
          cardResolver: new DefaultAgentCardResolver({ fetchImpl }) });
        if (redirect) await assert.rejects(factory.createFromUrl(url), /redirects.*canonical A2A URL/i);
        else {
          const client = await factory.createFromUrl(url);
          await assert.rejects(client.getTask(GetTaskRequest.fromJSON({ id: '1' })), /configured A2A origin/);
        }
        assert.equal(discoveryAuthorization, `Bearer ${token}`);
        assert.equal(targetRequests, 0, 'no foreign request, credential-bearing or otherwise');
      } finally { discovery.close(); discovery.closeAllConnections(); }
    });
  });
});
