import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CancelTaskRequest, GetTaskRequest, ListTasksRequest, SendMessageRequest, Task, TaskState } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createA2AServer } from '../src/http.js';
import { A2ABinding, A2AExtension, A2ATask, openDurableA2A } from '../src/prototype.js';

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

// Only the fixture changes: the host installs the extension and supplies its harness.
async function agent(dir, faux, models, port) {
  const registry = createRegistry();
  registry.install(A2AExtension);
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'durable.sqlite')), {
    models, registry, settings: { retry: { maxRetries: 0 } },
  }, context);
  const model = faux.getModel();
  const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  harness.resume();
  const base = `http://127.0.0.1:${port}`;
  const bridge = await openDurableA2A({ harness, conversation, card: {
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
    base, client, harness, conversation, bridge,
    async close() {
      server.close();
      server.closeAllConnections();
      await bridge.close();
      await harness.close(context);
    },
  };
}

// Keep the original contract body byte-for-byte, not a weaker selection of its assertions.
test('prototype uses the unchanged SDK contract body', async () => {
  const body = (source) => {
    const start = source.indexOf('\n  const dir = await mkdtemp');
    return source.slice(start, source.indexOf('\n});', start));
  };
  assert.equal(body(await readFile(new URL('./prototype.test.js', import.meta.url), 'utf8')),
    body(await readFile(new URL('./a2a.test.js', import.meta.url), 'utf8')));
});

test('Durable-native prototype passes the SDK contract across restarts', { timeout: 30_000 }, async () => {
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

async function fixture(use) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-durable-a2a-prototype-'));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const port = await freePort();
  let running = await agent(dir, faux, models, port);
  try {
    await use({ dir, faux, running, async reopen() {
      await running.close();
      running = await agent(dir, faux, models, port);
      return running;
    } });
  } finally {
    await running.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('prototype stores only Durable tasks and documents; SDK save is read-only', async () => {
  await fixture(async ({ dir, faux, running }) => {
    faux.setResponses([fauxAssistantMessage('Stored answer')]);
    const task = await running.client.sendMessage(send('__proto__', 'Hello'));
    const record = await running.harness.getTask(Number(task.id), context);
    assert.equal(record.kind, 'a2a.task');
    assert.equal(record.version, 1);
    assert.equal(record.state.outcome.result, 'Stored answer');
    const binding = await running.harness.snapshot(A2ABinding, running.conversation.id, '__proto__', context);
    assert.equal(binding.taskId, record.id);
    assert.equal(binding.hash, record.input.hash);
    assert.equal(task.contextId, String(running.conversation.id));
    await running.bridge.store.save(Task.fromJSON({ id: task.id, contextId: task.contextId,
      status: { state: 'TASK_STATE_FAILED', message: { role: 'ROLE_AGENT', messageId: 'forged', parts: [{ text: 'forged' }] } } }));
    assert.deepEqual(await running.harness.getTask(record.id, context), record);
    const read = await running.client.getTask(GetTaskRequest.fromJSON({ id: task.id }));
    assert.deepEqual(read, task);
    const all = await running.harness.commit((tx) => tx.scanTasks({ conversationId: running.conversation.id }, 100), context);
    const generation = all.items.find((item) => item.kind === 'pi.generation');
    assert.ok(generation);
    assert.equal(await running.bridge.store.load(String(generation.id)), undefined);
    assert.equal(await running.bridge.store.load('1 OR 1=1'), undefined);
    assert.ok((await readdir(dir)).every((name) => /^durable\.sqlite(?:-wal|-shm)?$/.test(name)));
  });
});

test('prototype rolls back task and binding together and serializes concurrent admission', async () => {
  await fixture(async ({ faux, running }) => {
    await assert.rejects(running.conversation.commit(async (tx) => {
      const binding = await tx.doc(A2ABinding, running.conversation.id, 'rollback', null);
      binding.taskId = await tx.createTask(A2ATask, { messageId: 'rollback', text: 'Not accepted', hash: 'hash', acceptedAt: Date.now() },
        { ownership: { kind: 'conversation' }, background: true });
      binding.hash = 'hash';
      throw new Error('rollback');
    }, context), /rollback/);
    assert.equal(await running.harness.snapshot(A2ABinding, running.conversation.id, 'rollback', context), undefined);
    const scan = () => running.harness.commit((tx) => tx.scanTasks({ kind: 'a2a.task' }, 100), context);
    assert.equal((await scan()).items.length, 0);

    faux.setResponses([delayed('Only one run', 150)]);
    const duplicates = await Promise.all(Array.from({ length: 5 }, () =>
      running.client.sendMessage(send('same-id', 'Same text', { returnImmediately: true }))));
    assert.equal(new Set(duplicates.map((task) => task.id)).size, 1);
    await running.harness.waitForTask(Number(duplicates[0].id), context);
    assert.equal((await scan()).items.length, 1);

    faux.setResponses([delayed('Winner', 150)]);
    const competing = await Promise.allSettled(['one', 'two'].map((id) =>
      running.client.sendMessage(send(id, id, { returnImmediately: true }))));
    assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
    assert.match(competing.find((result) => result.status === 'rejected').reason.message, /busy/i);
    const winner = competing.find((result) => result.status === 'fulfilled').value;
    await running.harness.waitForTask(Number(winner.id), context);
    assert.equal((await scan()).items.length, 2);
  });
});

test('prototype translates working state, history and filtered cursor pagination', { timeout: 5000 }, async () => {
  await fixture(async ({ faux, running }) => {
    faux.setResponses([delayed('Working answer', 150)]);
    const started = await running.client.sendMessage(send('working', 'Work', { returnImmediately: true }));
    // Wait until the Durable submit phase has committed its park, not an arbitrary timer.
    const watch = await running.harness.watchTaskGraph(context);
    await new Promise((resolve) => {
      const parked = (value) => Object.values(value.tasks).some((task) => String(task.id) === started.id && task.state.status === 'sleeping');
      if (parked(watch.value)) resolve();
      else watch.start((call) => { if (parked(call.value)) resolve(); });
    });
    await watch.stop();
    const working = await running.client.getTask(GetTaskRequest.fromJSON({ id: started.id }));
    assert.equal(working.status.state, TaskState.TASK_STATE_WORKING);
    const record = await running.harness.getTask(Number(started.id), context);
    assert.equal(record.state.status, 'sleeping');
    assert.equal(record.state.signals[0].signal, 'pi.submission-settled');
    await running.harness.waitForTask(Number(started.id), context);

    faux.setResponses([fauxAssistantMessage('Second answer')]);
    const second = await running.client.sendMessage(send('second', 'Second'));
    faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'PRIVATE' })]);
    await running.client.sendMessage(send('failed', 'Fail'));
    const ids = [];
    let pageToken;
    do {
      const page = await running.client.listTasks(ListTasksRequest.fromJSON({ pageSize: 1, pageToken,
        status: 'TASK_STATE_COMPLETED', historyLength: 1 }));
      assert.equal(page.totalSize, 2);
      assert.equal(page.tasks[0].history.length, 1);
      ids.push(page.tasks[0].id);
      pageToken = page.nextPageToken;
    } while (pageToken);
    assert.deepEqual(ids, [second.id, started.id]);
    const noHistory = await running.client.getTask(GetTaskRequest.fromJSON({ id: second.id, historyLength: 0 }));
    assert.equal(noHistory.history.length, 0);
    const full = await running.client.getTask(GetTaskRequest.fromJSON({ id: second.id }));
    assert.equal(full.history.length, 2);
    await assert.rejects(running.client.listTasks(ListTasksRequest.fromJSON({ pageToken: 'invalid' })));
  });
});

test('prototype cancels recovered work without an SDK bus and preserves the result', async () => {
  await fixture(async ({ faux, running, reopen }) => {
    faux.setResponses([delayed('Interrupted', 200)]);
    const pending = await running.client.sendMessage(send('restart-cancel', 'Work', { returnImmediately: true }));
    faux.setResponses([delayed('Must not complete', 300)]);
    running = await reopen();
    const duplicate = await running.client.sendMessage(send('restart-cancel', 'Work', { returnImmediately: true }));
    assert.equal(duplicate.id, pending.id);
    const canceled = await running.client.cancelTask(CancelTaskRequest.fromJSON({ id: pending.id }));
    assert.equal(canceled.status.state, TaskState.TASK_STATE_CANCELED);
    await running.conversation.waitForIdle(context);
    running = await reopen();
    const restored = await running.client.getTask(GetTaskRequest.fromJSON({ id: pending.id }));
    assert.deepEqual(restored, canceled);
    const repeated = await running.client.cancelTask(CancelTaskRequest.fromJSON({ id: pending.id }));
    assert.deepEqual(repeated, canceled);
  });
});

test('prototype cancellation before the submit phase does not create input', async () => {
  const registry = createRegistry();
  registry.install(A2AExtension);
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
  try {
    const conversation = await harness.root(context);
    const id = await conversation.commit(async (tx) => {
      const binding = await tx.doc(A2ABinding, conversation.id, 'not-submitted', null);
      const taskId = await tx.createTask(A2ATask, {
        messageId: 'not-submitted', text: 'Never run', hash: 'hash', acceptedAt: Date.now(),
      }, { ownership: { kind: 'conversation' }, background: true });
      binding.taskId = taskId;
      binding.hash = 'hash';
      return taskId;
    }, context);
    // Still paused: abort is durably marked before any task invocation.
    assert.equal((await harness.getTask(id, context)).state.status, 'pending');
    await harness.abortTask(id, context);
    const settled = await harness.waitForTask(id, context);
    assert.equal(settled.state.outcome.status, 'aborted');
    const tasks = await harness.commit((tx) => tx.scanTasks({}, 100), context);
    assert.equal(tasks.items.length, 1);
    const entries = await conversation.entries({}, 100, undefined, context);
    assert.ok(entries.items.every((entry) => entry.kind !== 'pi.user'));
    assert.equal((await harness.inspect(context)).submissions.length, 0);
  } finally { await harness.close(context); }
});
