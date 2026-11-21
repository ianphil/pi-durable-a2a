import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { CancelTaskRequest, GetTaskRequest, ListTasksRequest, SendMessageRequest, Task, TaskState } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createA2AServer } from '../src/http.js';
import { A2ABinding, A2AExtension, A2ATask, durableTaskStore, openDurableA2A } from '../src/prototype.js';

const token = 'a'.repeat(40);
const delayed = (text, ms) => async () => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return fauxAssistantMessage(text);
};
function gatedResponse(text) {
  const started = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const released = Promise.withResolvers();
  return { started: started.promise, aborted: aborted.promise, release: released.resolve,
    response: async (_transcript, options) => {
      const onAbort = () => { aborted.resolve(); released.resolve(); };
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      if (options?.signal?.aborted) onAbort();
      started.resolve();
      try {
        await released.promise;
        return fauxAssistantMessage(text);
      } finally { options?.signal?.removeEventListener('abort', onAbort); }
    },
  };
}
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

    const duplicateGate = gatedResponse('Only one run');
    faux.setResponses([duplicateGate.response]);
    let duplicateId;
    try {
      const duplicates = await Promise.all(Array.from({ length: 5 }, () =>
        running.client.sendMessage(send('same-id', 'Same text', { returnImmediately: true }))));
      assert.equal(new Set(duplicates.map((task) => task.id)).size, 1);
      duplicateId = Number(duplicates[0].id);
    } finally { duplicateGate.release(); }
    await running.harness.waitForTask(duplicateId, context);
    assert.equal((await scan()).items.length, 1);

    const competingGate = gatedResponse('Winner');
    faux.setResponses([competingGate.response]);
    let winnerId;
    try {
      const competing = await Promise.allSettled(['one', 'two'].map((id) =>
        running.client.sendMessage(send(id, id, { returnImmediately: true }))));
      assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
      assert.match(competing.find((result) => result.status === 'rejected').reason.message, /busy/i);
      winnerId = Number(competing.find((result) => result.status === 'fulfilled').value.id);
    } finally { competingGate.release(); }
    await running.harness.waitForTask(winnerId, context);
    assert.equal((await scan()).items.length, 2);
  });
});

test('prototype translates working state, history and filtered cursor pagination', { timeout: 5000 }, async () => {
  await fixture(async ({ faux, running }) => {
    const gate = gatedResponse('Working answer');
    faux.setResponses([gate.response]);
    let started;
    try {
      started = await running.client.sendMessage(send('working', 'Work', { returnImmediately: true }));
      // The model cannot start before the submission and park commit together.
      // Keep it gated across all HTTP/record reads; no sleeping state can be missed.
      await gate.started;
      const working = await running.client.getTask(GetTaskRequest.fromJSON({ id: started.id }));
      assert.equal(working.status.state, TaskState.TASK_STATE_WORKING);
      const record = await running.harness.getTask(Number(started.id), context);
      assert.equal(record.state.status, 'sleeping');
      assert.equal(record.state.signals[0].signal, 'pi.submission-settled');
    } finally { gate.release(); }
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

test('prototype cancels recovered work without an SDK bus and preserves the result', { timeout: 5000 }, async () => {
  await fixture(async ({ faux, running, reopen }) => {
    const original = gatedResponse('Interrupted');
    const recovered = gatedResponse('Must not complete');
    faux.setResponses([original.response]);
    try {
      const pending = await running.client.sendMessage(send('restart-cancel', 'Work', { returnImmediately: true }));
      await original.started;
      faux.setResponses([recovered.response]);
      running = await reopen(); // Close aborts the first model gate, never releases an answer.
      await original.aborted;
      await recovered.started;
      const duplicate = await running.client.sendMessage(send('restart-cancel', 'Work', { returnImmediately: true }));
      assert.equal(duplicate.id, pending.id);
      assert.equal(duplicate.status.state, TaskState.TASK_STATE_WORKING);
      const canceled = await running.client.cancelTask(CancelTaskRequest.fromJSON({ id: pending.id }));
      await recovered.aborted;
      assert.equal(canceled.status.state, TaskState.TASK_STATE_CANCELED);
      await running.conversation.waitForIdle(context);
      running = await reopen();
      const restored = await running.client.getTask(GetTaskRequest.fromJSON({ id: pending.id }));
      assert.deepEqual(restored, canceled);
      const repeated = await running.client.cancelTask(CancelTaskRequest.fromJSON({ id: pending.id }));
      assert.deepEqual(repeated, canceled);
    } finally { original.release(); recovered.release(); }
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

test('prototype retries honor blocking and history options without another task', { timeout: 5000 }, async () => {
  await fixture(async ({ faux, running }) => {
    const gate = gatedResponse('One answer');
    const waiting = Promise.withResolvers();
    const originalWait = running.harness.waitForTask.bind(running.harness);
    let retry;
    faux.setResponses([gate.response]);
    try {
      const first = await running.client.sendMessage(send('retry', 'Hello', { returnImmediately: true }));
      await gate.started;
      running.harness.waitForTask = (id, ctx) => {
        const result = originalWait(id, ctx);
        waiting.resolve();
        return result;
      };
      let retrySettled = false;
      retry = running.bridge.handler.sendMessage(send('retry', 'Hello', { historyLength: 1 }), new ServerCallContext());
      retry.then(() => { retrySettled = true; }, () => { retrySettled = true; });
      await waiting.promise;
      await nextTurn();
      assert.equal(retrySettled, false);
      const immediate = await running.client.sendMessage(send('retry', 'Hello', { returnImmediately: true, historyLength: 0 }));
      assert.equal(immediate.id, first.id);
      assert.equal(immediate.status.state, TaskState.TASK_STATE_WORKING);
      assert.equal(immediate.history.length, 0);
      gate.release();
      const completed = await retry;
      assert.equal(completed.id, first.id);
      assert.equal(completed.status.state, TaskState.TASK_STATE_COMPLETED);
      assert.equal(completed.history.length, 1);
      assert.match(JSON.stringify(completed.history), /One answer/);
      const noHistory = await running.client.sendMessage(send('retry', 'Hello', { historyLength: 0 }));
      assert.equal(noHistory.history.length, 0);
      const full = await running.client.getTask(GetTaskRequest.fromJSON({ id: first.id }));
      assert.equal(full.history.length, 2);
      const tasks = await running.harness.commit((tx) => tx.scanTasks({ kind: 'a2a.task' }, 100), context);
      assert.equal(tasks.items.length, 1);
    } finally {
      gate.release();
      running.harness.waitForTask = originalWait;
      if (retry) await Promise.allSettled([retry]);
    }
  });
});

test('prototype close joins a send between admission and SDK executor startup', { timeout: 5000 }, async () => {
  await fixture(async ({ faux, running }) => {
    const gate = gatedResponse('Work survives bridge close');
    const entered = Promise.withResolvers();
    const releaseContext = Promise.withResolvers();
    const handler = running.bridge.handler;
    const originalContext = handler._createRequestContext.bind(handler);
    let closing;
    faux.setResponses([gate.response]);
    handler._createRequestContext = async (...args) => {
      entered.resolve();
      await releaseContext.promise;
      return originalContext(...args);
    };
    const response = handler.sendMessage(send('shutdown-gap', 'Hello'), new ServerCallContext());
    const rejected = assert.rejects(response, /stopping/i);
    try {
      await entered.promise;
      await gate.started;
      const binding = await running.harness.snapshot(A2ABinding, running.conversation.id, 'shutdown-gap', context);
      assert.ok(binding.taskId);
      let closed = false;
      closing = running.bridge.close().then(() => { closed = true; });
      await nextTurn();
      assert.equal(closed, false, 'close must join the admitted send even before its bus exists');
      releaseContext.resolve();
      await rejected;
      await closing;
      const record = await running.harness.getTask(binding.taskId, context);
      assert.equal(record.abortRequested, false);
      assert.equal(record.state.status, 'sleeping');
      await assert.rejects(handler.sendMessage(send('after-close', 'Hello'), new ServerCallContext()), /stopping/i);
      gate.release();
      assert.equal((await running.harness.waitForTask(binding.taskId, context)).state.outcome.status, 'completed');
    } finally {
      releaseContext.resolve();
      gate.release();
      handler._createRequestContext = originalContext;
      await rejected;
      if (closing) await closing;
    }
  });
});

test('prototype close cancels duplicate request waits but not Durable work', { timeout: 5000 }, async () => {
  await fixture(async ({ faux, running }) => {
    const gate = gatedResponse('Still runs');
    const waiting = Promise.withResolvers();
    const originalWait = running.harness.waitForTask.bind(running.harness);
    let rejected;
    faux.setResponses([gate.response]);
    try {
      const first = await running.client.sendMessage(send('close-retry', 'Hello', { returnImmediately: true }));
      await gate.started;
      running.harness.waitForTask = (id, ctx) => {
        const result = originalWait(id, ctx);
        waiting.resolve();
        return result;
      };
      const retry = running.bridge.handler.sendMessage(send('close-retry', 'Hello'), new ServerCallContext());
      rejected = assert.rejects(retry);
      await waiting.promise;
      await running.bridge.close();
      await rejected;
      const record = await running.harness.getTask(Number(first.id), context);
      assert.equal(record.abortRequested, false);
      assert.equal(record.state.status, 'sleeping');
      gate.release();
      assert.equal((await originalWait(record.id, context)).state.outcome.status, 'completed');
    } finally {
      gate.release();
      running.harness.waitForTask = originalWait;
      if (rejected) await rejected;
    }
  });
});

test('prototype counts and filters records without translating unreturned answers', async () => {
  const visible = { id: 3, conversationId: 1, startedAt: 3000,
    input: { messageId: 'visible', text: 'Small input', acceptedAt: 3000 },
    state: { status: 'sleeping' } };
  let answerReads = 0;
  const hidden = (id) => ({ id, conversationId: 1, startedAt: 1000, endedAt: 2000,
    get input() { throw new Error('Unreturned history must not be translated'); },
    state: { status: 'terminal', outcome: { status: 'completed',
      get result() { answerReads += 1; throw new Error('Unreturned answer must not be translated'); } } },
  });
  const records = [visible, hidden(2), hidden(1)];
  const harness = { commit: async (change) => change({
    async scanTasks(_query, limit, cursor) {
      const offset = cursor?.offset ?? 0;
      const next = offset + limit;
      return { items: records.slice(offset, next), ...(next < records.length ? { next: { offset: next } } : {}) };
    },
  }) };
  const store = durableTaskStore(harness, { id: 1 });
  const all = await store.list({ pageSize: 1 });
  assert.equal(all.totalSize, 3);
  assert.equal(all.tasks[0].id, '3');
  assert.ok(all.nextPageToken);
  const working = await store.list({ pageSize: 1, status: TaskState.TASK_STATE_WORKING });
  assert.equal(working.totalSize, 1);
  assert.equal(working.tasks[0].id, '3');
  assert.equal(working.nextPageToken, '');
  const recent = await store.list({ pageSize: 1, statusTimestampAfter: new Date(2500).toISOString() });
  assert.equal(recent.totalSize, 1);
  assert.equal(recent.tasks[0].id, '3');
  assert.equal(answerReads, 0);
});
