import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CancelTaskRequest, GetTaskRequest, ListTasksRequest, SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createA2AServer, openA2A } from '../src/index.js';

const token = 'a'.repeat(40);
const delayed = (text, ms) => async () => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return fauxAssistantMessage(text);
};
const send = (messageId, text, configuration) => SendMessageRequest.fromJSON({
  message: { messageId, role: 'ROLE_USER', parts: [{ text }] }, configuration,
});

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// A real Durable harness on SQLite and the official SDK client, reopened like a restarted host.
async function agent(dir, faux, models, port) {
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'durable.sqlite')), {
    models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } },
  }, context);
  const model = faux.getModel();
  const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  harness.resume();
  const base = `http://127.0.0.1:${port}`;
  const bridge = await openA2A({ conversation, database: join(dir, 'a2a.sqlite'), card: {
    name: 'fixture', description: 'Test agent', url: `${base}/a2a`,
    skills: [{ id: 'chat', name: 'Chat', description: 'Talk to the test agent', tags: [] }],
  } });
  const server = createA2AServer(bridge, { token });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const fetchImpl = (input, init) => fetch(input, { ...init,
    headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${token}` } });
  const client = await new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl })], cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  }).createFromUrl(base);
  return {
    base, client,
    async close() {
      server.close();
      server.closeAllConnections();
      await bridge.close();
      await harness.close(context);
    },
  };
}

test('serves a Durable conversation through the official A2A SDK across restarts', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-durable-a2a-'));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let running;
  const port = await freePort();
  try {
    running = await agent(dir, faux, models, port);
    assert.equal((await fetch(`${running.base}/.well-known/agent-card.json`)).status, 401);
    assert.equal((await fetch(`${running.base}/health`)).status, 200);

    faux.setResponses([fauxAssistantMessage('Persistent hello')]);
    const first = await running.client.sendMessage(send('message-one', 'Hello'));
    assert.equal(first.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.match(JSON.stringify(first.status), /Persistent hello/);

    // The same message ID returns the same task; reusing it for other text is refused.
    const duplicate = await running.client.sendMessage(send('message-one', 'Hello'));
    assert.equal(duplicate.id, first.id);
    await assert.rejects(running.client.sendMessage(send('message-one', 'Changed')));
    await assert.rejects(running.client.getTask(GetTaskRequest.fromJSON({ id: first.id, tenant: 'foreign' })));
    await assert.rejects(running.client.getTask(GetTaskRequest.fromJSON({ id: 'missing' })));

    // A follow-up is another task in the same shared context and conversation.
    faux.setResponses([(transcript) => fauxAssistantMessage(`Seen ${transcript.messages.length} messages`)]);
    const second = await running.client.sendMessage(send('message-two', 'Second'));
    assert.equal(second.contextId, first.contextId);
    assert.match(JSON.stringify(second.status), /Seen 3 messages/);
    const page = await running.client.listTasks(ListTasksRequest.fromJSON({ pageSize: 1 }));
    assert.equal(page.tasks.length, 1);
    assert.ok(page.nextPageToken);

    // One run at a time: a second request while one is working is refused.
    faux.setResponses([delayed('Slow answer', 300)]);
    const slow = await running.client.sendMessage(send('slow', 'Slow work', { returnImmediately: true }));
    await assert.rejects(running.client.sendMessage(send('busy', 'Also now')), /busy/i);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const finished = await running.client.getTask(GetTaskRequest.fromJSON({ id: slow.id }));
    assert.equal(finished.status?.state, TaskState.TASK_STATE_COMPLETED);

    // Cancellation reports canceled only after Durable settles; a finished task cannot be canceled.
    await assert.rejects(running.client.cancelTask(CancelTaskRequest.fromJSON({ id: first.id })));
    faux.setResponses([delayed('Late answer', 300)]);
    const started = await running.client.sendMessage(send('cancel-me', 'Slow work', { returnImmediately: true }));
    const canceled = await running.client.cancelTask(CancelTaskRequest.fromJSON({ id: started.id }));
    assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);

    // A disconnected caller stops waiting, not the work; resending the message ID finds the result.
    faux.setResponses([delayed('Survived disconnect', 200)]);
    const controller = new AbortController();
    const waiting = running.client.sendMessage(send('disconnect', 'Continue without caller'), { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await assert.rejects(waiting);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const lookup = await running.client.sendMessage(send('disconnect', 'Continue without caller'));
    assert.equal(lookup.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.match(JSON.stringify(lookup.status), /Survived disconnect/);

    // Work accepted before a restart continues afterwards and stays visible to task reads.
    faux.setResponses([delayed('Interrupted', 500)]);
    const pending = await running.client.sendMessage(send('restart', 'Work across restart', { returnImmediately: true }));
    await running.close();
    faux.setResponses([delayed('Recovered', 100)]);
    running = await agent(dir, faux, models, port);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const recovered = await running.client.getTask(GetTaskRequest.fromJSON({ id: pending.id }));
    assert.equal(recovered.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.match(JSON.stringify(recovered.status), /Recovered/);
    const restored = await running.client.getTask(GetTaskRequest.fromJSON({ id: first.id }));
    assert.match(JSON.stringify(restored.status), /Persistent hello/);

    // LiteLLM sends v0.3 task controls to the registered base URL.
    const legacy = await fetch(`${running.base}/`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: first.id } }),
    });
    assert.equal((await legacy.json()).result.id, first.id);

    // A failed model request fails the task without exposing the provider's error text.
    faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'PROVIDER_PRIVATE' })]);
    const failed = await running.client.sendMessage(send('failure', 'Fail please'));
    assert.equal(failed.status?.state, TaskState.TASK_STATE_FAILED);
    assert.doesNotMatch(JSON.stringify(failed.status), /PROVIDER_PRIVATE/);
  } finally {
    await running?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
