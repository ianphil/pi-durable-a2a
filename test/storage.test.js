import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CancelTaskRequest, GetTaskRequest, ListTasksRequest, SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineDoc, defineTask, Harness, LiveDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { A2AExtension, openA2A } from 'pi-durable-a2a';
import { A2ABinding, A2ATask } from '../src/a2a.js';

const call = () => new ServerCallContext();
const message = (id, configuration) => SendMessageRequest.fromJSON({
  message: { messageId: id, role: 'ROLE_USER', parts: [{ text: 'Hello' }] }, configuration,
});

// Like the channels killable adapter, block every further storage operation.
// Reject rather than freeze so the failed harness can release test resources.
// No Harness.close() is called before loss; no recovery checkpoints can be saved.
function killable(inner) {
  let dead = false;
  return { kill() { dead = true; }, storage: new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args) => dead && property !== 'close'
        ? Promise.reject(new Error('Injected storage loss')) : value.apply(target, args);
    },
  }) };
}

function modelGate(text, onAbort) {
  const started = Promise.withResolvers();
  const released = Promise.withResolvers();
  return { started: started.promise, release: released.resolve, response: async (_transcript, options) => {
    const abort = () => { if (onAbort) onAbort(); else released.resolve(); };
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    started.resolve();
    try { await released.promise; return fauxAssistantMessage(text); }
    finally { options.signal.removeEventListener('abort', abort); }
  } };
}

async function host(storage, faux, terminals = [], extension = A2AExtension) {
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(extension);
  const harness = await Harness.open(storage, {
    models, registry, settings: { retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 } },
  }, context);
  harness.observeCommits({ advance(publication) {
    for (const change of publication.changes) if (change.type === 'task' && change.value.kind === 'a2a.task'
      && change.value.state.status === 'terminal') terminals.push(change.value);
  }, end() {} });
  const model = faux.getModel();
  const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  const a2a = await openA2A({ harness, conversation, card: {
    name: 'fixture', description: 'Storage recovery', url: 'http://localhost/a2a', skills: [],
  } });
  return { harness, conversation, a2a, async close() { await a2a.close(); await harness.close(context); } };
}

async function directory(use) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-durable-a2a-storage-'));
  try { await use(join(dir, 'durable.sqlite')); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

async function assertSingleAdmission(running, taskId, submissionId, messageId) {
  const tasks = await running.harness.commit((tx) => tx.scanTasks({ kind: 'a2a.task' }, 100), context);
  assert.equal(tasks.items.length, 1);
  assert.equal(tasks.items[0].id, taskId);
  const binding = await running.harness.snapshot(A2ABinding, running.conversation.id, messageId, context);
  assert.equal(binding.taskId, taskId);
  const submission = await running.harness.commit((tx) => tx.submissionByRequest(running.conversation.id,
    `a2a.task:${taskId}`), context);
  assert.equal(submission.id, submissionId);
  const entries = await running.conversation.entries({}, 100, undefined, context);
  assert.equal(entries.items.filter((entry) => entry.kind === 'pi.user').length, 1);
}

test('storage loss during a model request recovers one task and one admission', { timeout: 10_000 }, async () => {
  await directory(async (path) => {
    const faux = fauxProvider();
    const model = modelGate('Must not commit before loss');
    faux.setResponses([model.response]);
    const terminals = [];
    const crashing = killable(await openNodeSqliteStorage(path));
    let running = await host(crashing.storage, faux, terminals);
    try {
      const pending = await running.a2a.handler.sendMessage(message('crash-model', { returnImmediately: true }), call());
      await model.started;
      const taskId = Number(pending.id);
      const record = await running.harness.getTask(taskId, context);
      assert.equal(record.state.status, 'sleeping');
      assert.equal(record.state.checkpoint.phase, 'answer');
      assert.ok(Number.isSafeInteger(record.input.acceptedAt));
      const submissionId = record.state.checkpoint.submissionId;
      crashing.kill();
      const stoppedRequests = running.a2a.close(); // Only clean up request resources after storage is dead.
      await assert.rejects(running.harness.commit((tx) => tx.scanTasks({ kind: 'a2a.task' }, 1), context));
      const ended = await running.harness.closed;
      assert.equal(ended.kind, 'failed');
      await stoppedRequests;
      assert.equal(terminals.length, 0, 'the lost process persisted no terminal A2A result');

      faux.setResponses([fauxAssistantMessage('Recovered answer')]);
      running = await host(await openNodeSqliteStorage(path), faux, terminals);
      await running.harness.waitForTask(taskId, context);
      const recovered = await running.a2a.handler.getTask(GetTaskRequest.fromJSON({ id: pending.id }), call());
      assert.equal(recovered.status.state, TaskState.TASK_STATE_COMPLETED);
      assert.match(JSON.stringify(recovered.status), /Recovered answer/);
      assert.equal(faux.state.callCount, 2, 'Durable retries the interrupted model attempt');
      assert.equal(terminals.length, 1);
      await assertSingleAdmission(running, taskId, submissionId, 'crash-model');
      const duplicate = await running.a2a.handler.sendMessage(message('crash-model'), call());
      assert.deepEqual(duplicate, recovered);
      const page = await running.a2a.handler.listTasks(ListTasksRequest.fromJSON({}), call());
      assert.equal(page.tasks.length, 1);
      assert.equal(page.tasks[0].id, pending.id);
      await running.close();
      running = await host(await openNodeSqliteStorage(path), faux, terminals);
      assert.deepEqual(await running.a2a.handler.getTask(GetTaskRequest.fromJSON({ id: pending.id }), call()), recovered);
      assert.equal(terminals.length, 1, 'another reopen does not settle the task again');
    } finally { model.release(); await running.close(); }
  });
});

test('storage loss during cancellation resumes cleanup and stays canceled', { timeout: 10_000 }, async () => {
  await directory(async (path) => {
    const faux = fauxProvider();
    const interrupted = Promise.withResolvers();
    const inner = await openNodeSqliteStorage(path);
    const crashing = killable(inner);
    const model = modelGate('Must not become an answer', () => { crashing.kill(); interrupted.resolve(); });
    faux.setResponses([model.response]);
    const terminals = [];
    let running = await host(crashing.storage, faux, terminals);
    let cancel;
    try {
      const pending = await running.a2a.handler.sendMessage(message('crash-cancel', { returnImmediately: true }), call());
      await model.started;
      const taskId = Number(pending.id);
      const record = await running.harness.getTask(taskId, context);
      const submissionId = record.state.checkpoint.submissionId;
      const live = await running.harness.snapshot(LiveDoc, running.conversation.id, context);
      cancel = running.a2a.handler.cancelTask(CancelTaskRequest.fromJSON({ id: pending.id }), call());
      cancel.catch(() => {});
      await interrupted.promise; // Run abort is committed, but model cleanup cannot finish yet.
      assert.equal((await inner.task(taskId, context)).abortRequested, true);
      assert.equal((await inner.task(live.run.taskId, context)).abortRequested, true);
      const stoppedRequests = running.a2a.close();
      await assert.rejects(running.harness.commit((tx) => tx.scanTasks({ kind: 'a2a.task' }, 1), context));
      model.release();
      assert.equal((await running.harness.closed).kind, 'failed');
      await assert.rejects(cancel);
      await stoppedRequests;
      assert.equal(terminals.length, 0);

      running = await host(await openNodeSqliteStorage(path), faux, terminals);
      await running.harness.waitForTask(taskId, context);
      const canceled = await running.a2a.handler.getTask(GetTaskRequest.fromJSON({ id: pending.id }), call());
      assert.equal(canceled.status.state, TaskState.TASK_STATE_CANCELED);
      assert.equal(faux.state.callCount, 1, 'an abort-marked run does not request another model answer');
      assert.equal(terminals.length, 1);
      await assertSingleAdmission(running, taskId, submissionId, 'crash-cancel');
      const duplicate = await running.a2a.handler.sendMessage(message('crash-cancel'), call());
      assert.deepEqual(duplicate, canceled);
      const page = await running.a2a.handler.listTasks(ListTasksRequest.fromJSON({ status: 'TASK_STATE_CANCELED' }), call());
      assert.equal(page.tasks.length, 1);
      await running.close();
      running = await host(await openNodeSqliteStorage(path), faux, terminals);
      assert.deepEqual(await running.a2a.handler.cancelTask(CancelTaskRequest.fromJSON({ id: pending.id }), call()), canceled);
      assert.equal(terminals.length, 1);
    } finally {
      model.release();
      if (cancel) await Promise.allSettled([cancel]);
      await running.close();
    }
  });
});

const LegacyAdmission = defineDoc({ kind: 'a2a.admission', version: 1, scope: 'conversation',
  history: 'latest', fork: 'initial', initial: () => ({}), checkpointWhen: () => true });

test('an old lifetime counter does not block admission after reopen', async () => {
  await directory(async (path) => {
    const faux = fauxProvider();
    let running = await host(await openNodeSqliteStorage(path), faux);
    try {
      await running.conversation.commit(async (tx) => { (await tx.doc(LegacyAdmission, running.conversation.id)).count = 10_000; }, context);
      await running.close();
      running = await host(await openNodeSqliteStorage(path), faux);
      const persisted = await running.harness.snapshot(LegacyAdmission, running.conversation.id, context);
      assert.equal(persisted?.count, 10_000, 'the old counter must be stored, not supplied by the fixture default');
      faux.setResponses([fauxAssistantMessage('Accepted beyond the old cap')]);
      const task = await running.a2a.handler.sendMessage(message('beyond-cap'), call());
      assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED);
      assert.match(JSON.stringify(task.status), /Accepted beyond the old cap/);
      const admission = await running.harness.snapshot(LegacyAdmission, running.conversation.id, context);
      assert.equal(admission.active, Number(task.id));
    } finally { await running.close(); }
  });
});

test('persisted version-1 names, binding layout and submission keys remain stable', async () => {
  await directory(async (path) => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage('Answer')]);
    const storage = await openNodeSqliteStorage(path);
    const running = await host(storage, faux);
    try {
      const task = await running.a2a.handler.sendMessage(SendMessageRequest.fromJSON({ message: {
        messageId: 'contract', role: 'ROLE_USER', parts: [{ text: 'Hi' }, { text: 'there' }],
      } }), call());
      const record = await storage.task(Number(task.id), context);
      assert.equal(record.kind, 'a2a.task');
      assert.equal(record.version, 1);
      assert.equal(record.input.messageId, 'contract');
      assert.equal(record.input.text, 'Hi\nthere');
      assert.equal(record.input.hash, createHash('sha256').update('Hi\nthere').digest('hex'));
      assert.equal(task.contextId, String(running.conversation.id));
      assert.equal(record.state.outcome.result, 'Answer');
      const submission = await storage.submissionByRequest(running.conversation.id, `a2a.task:${task.id}`, context);
      assert.equal(submission.notify.taskId, record.id);
      assert.equal(submission.notify.key, 'answer');
      const docs = await storage.scanDocuments({ scope: { kind: 'conversation', conversationId: running.conversation.id },
        at: 'current' }, 100, undefined, context);
      for (const kind of ['a2a.message', 'a2a.admission']) {
        const doc = docs.items.find((item) => item.kind === kind);
        assert.ok(doc);
        assert.equal(doc.history, 'latest');
        assert.equal(doc.fork, 'initial');
        const stored = await storage.document(doc.id, 'current', context);
        assert.equal(stored.version, 1);
        if (kind === 'a2a.message') {
          assert.equal(doc.key, 'contract');
          assert.equal(stored.value.taskId, record.id);
          assert.equal(stored.value.hash, record.input.hash);
        } else {
          assert.equal(stored.value.active, record.id);
          assert.equal(Object.hasOwn(stored.value, 'count'), false);
        }
      }
    } finally { await running.close(); }
  });
});

test('reads refuse future task versions without rewriting stored records', { timeout: 10_000 }, async () => {
  await directory(async (path) => {
    const faux = fauxProvider();
    const running = await host(await openNodeSqliteStorage(path), faux);
    try {
      const future = defineTask({ ...A2ATask.definition, version: 2 });
      const hash = createHash('sha256').update('Hello').digest('hex');
      const id = await running.conversation.commit(async (tx) => {
        const binding = await tx.doc(A2ABinding, running.conversation.id, 'future', null);
        const admission = await tx.doc(LegacyAdmission, running.conversation.id);
        const taskId = await tx.createTask(future,
          { messageId: 'future', text: 'Hello', hash, acceptedAt: Date.now() },
          { ownership: { kind: 'conversation' }, background: true });
        binding.taskId = taskId;
        binding.hash = hash;
        admission.active = taskId;
        return taskId;
      }, context);
      const before = await running.harness.getTask(id, context);
      await assert.rejects(running.a2a.handler.getTask(GetTaskRequest.fromJSON({ id: String(id) }), call()), /Unsupported stored/);
      await assert.rejects(running.a2a.handler.listTasks(ListTasksRequest.fromJSON({}), call()), /Unsupported stored/);
      // This pending future-version task would be excluded by each filter. Its
      // version must still be checked before reading state or timestamp fields.
      for (const filter of [
        { status: 'TASK_STATE_COMPLETED' },
        { statusTimestampAfter: '9999-01-01T00:00:00.000Z' },
      ]) await assert.rejects(running.a2a.handler.listTasks(ListTasksRequest.fromJSON(filter), call()), /Unsupported stored/);
      await assert.rejects(running.a2a.handler.sendMessage(message('future'), call()), /Unsupported stored/);
      await assert.rejects(running.a2a.handler.sendMessage(message('new-message'), call()), /Unsupported stored/);
      assert.equal(await running.harness.snapshot(A2ABinding, running.conversation.id, 'new-message', context), undefined);
      assert.deepEqual(await running.harness.getTask(id, context), before);
    } finally { await running.close(); }
  });
});

test('admission refuses a terminal future-version active task without replacing it', { timeout: 10_000 }, async () => {
  await directory(async (path) => {
    const faux = fauxProvider();
    const future = defineTask({ ...A2ATask.definition, version: 2, phases: { ...A2ATask.definition.phases,
      submit: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal',
        outcome: { status: 'completed', result: 'Future result' } }), ctx),
    } });
    const futureExtension = { ...A2AExtension, tasks: [future] };
    let running = await host(await openNodeSqliteStorage(path), faux, [], futureExtension);
    try {
      const hash = createHash('sha256').update('Hello').digest('hex');
      const id = await running.conversation.commit(async (tx) => {
        const binding = await tx.doc(A2ABinding, running.conversation.id, 'completed-future', null);
        const admission = await tx.doc(LegacyAdmission, running.conversation.id);
        const taskId = await tx.createTask(future, { messageId: 'completed-future', text: 'Hello', hash, acceptedAt: Date.now() },
          { ownership: { kind: 'conversation' }, background: true });
        binding.taskId = taskId;
        binding.hash = hash;
        admission.active = taskId;
        return taskId;
      }, context);
      await running.harness.waitForTask(id, context);
      await running.close();
      running = await host(await openNodeSqliteStorage(path), faux); // Older, version-1 definitions.
      const before = await running.harness.getTask(id, context);
      assert.equal(before.version, 2);
      assert.equal(before.state.status, 'terminal');
      await assert.rejects(running.a2a.handler.sendMessage(message('after-future'), call()), /Unsupported stored/);
      const admission = await running.harness.snapshot(LegacyAdmission, running.conversation.id, context);
      assert.equal(admission.active, id);
      assert.equal(await running.harness.snapshot(A2ABinding, running.conversation.id, 'after-future', context), undefined);
      assert.deepEqual(await running.harness.getTask(id, context), before);
    } finally { await running.close(); }
  });
});
