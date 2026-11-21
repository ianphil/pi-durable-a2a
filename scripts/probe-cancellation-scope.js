// Issue #1 diagnostic, not a conformance test: confirm the known cancellation
// handoff race using real Durable tasks. Uses no HTTP, credentials or network.
import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTask } from '@earendil-works/pi-durable';
import { A2ATask } from '../src/a2a.js';

function gate(text) {
  const started = Promise.withResolvers();
  const released = Promise.withResolvers();
  return { started: started.promise, release: released.resolve, response: async (_transcript, options) => {
    const onAbort = () => released.resolve();
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    started.resolve();
    try { await released.promise; return fauxAssistantMessage(text); }
    finally { options.signal.removeEventListener('abort', onAbort); }
  } };
}
const first = gate('A2A answer');
const next = gate('Independent host answer');
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([first.response, next.response]);
let conversation;
let hostSubmission;
const probeTask = defineTask({ ...A2ATask.definition, async abort(task, runtime, ctx) {
  const handle = await runtime.conversation(runtime.conversationId, ctx);
  const wrapped = { ...handle, async submit(draft, submitCtx) {
    const submission = await handle.submit(draft, submitCtx);
    return { id: submission.id, wait: submission.wait.bind(submission), async abort(abortCtx) {
      const result = await submission.abort(abortCtx);
      assert.equal(result, 'already_placed');
      // Pause only this invocation. Legitimate model/host work advances between
      // the submission check and the unchanged conversation-wide abort call.
      first.release();
      assert.equal((await submission.wait(abortCtx)).status, 'done');
      await conversation.waitForIdle(context);
      hostSubmission = await conversation.submit({ type: 'input', content: 'Independent host input' }, context);
      await next.started;
      return result;
    } };
  } };
  const boundRuntime = new Proxy(runtime, { get(target, key, receiver) {
    return key === 'conversation' ? async () => wrapped : Reflect.get(target, key, receiver);
  } });
  await A2ATask.definition.abort(task, boundRuntime, ctx);
} });
const registry = createRegistry();
registry.install(defineExtension({ name: 'a2a-scope-probe', tasks: [probeTask] }));
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const timeout = setTimeout(() => { console.error('Scope probe timed out'); process.exit(1); }, 10_000);
try {
  const model = faux.getModel();
  conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  const id = await conversation.commit((tx) => tx.createTask(A2ATask, {
    messageId: 'scope-probe', text: 'A2A input', hash: 'diagnostic', acceptedAt: Date.now(),
  }, { ownership: { kind: 'conversation' }, background: true }), context);
  harness.resume();
  await first.started;
  await harness.abortTask(id, context);
  const task = await harness.waitForTask(id, context);
  const host = await hostSubmission.wait(context);
  // Exit successfully only when the current, documented limitation reproduces.
  // This is not the desired behavior: the independent host input should finish.
  assert.equal(task.state.outcome.status, 'completed');
  assert.equal(task.state.outcome.result, 'A2A answer');
  assert.equal(host.status, 'unanswered');
  assert.equal(host.reason, 'aborted');
  console.log(JSON.stringify({ a2aSubmissionBeforeHandoff: 'done',
    hostSubmission: { status: host.status, reason: host.reason },
    a2aTask: task.state.outcome.status,
    outcomeReporting: 'The completed A2A answer is preserved despite late cancel intent.',
    conclusion: 'Confirmed: A2A cancellation aborts an unrelated host run after a handoff.' }, null, 2));
} finally {
  clearTimeout(timeout);
  first.release();
  next.release();
  await harness.close(context);
}
