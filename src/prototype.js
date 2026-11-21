// Issue #1 experiment. Not exported as the public API; the SQLite bridge remains unchanged.
import { createHash } from 'node:crypto';
import { AgentCard, Message, Role, Task, TaskState } from '@a2a-js/sdk';
import { AgentEvent, DefaultExecutionEventBusManager, DefaultRequestHandler, RequestContext } from '@a2a-js/sdk/server';
import { ContentTypeNotSupportedError, RequestMalformedError, TaskNotCancelableError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context';
import { AssistantEntry, defineDoc, defineDocFamily, defineExtension, defineTask, InboxDoc, LiveDoc, SubmissionSettled } from '@earendil-works/pi-durable';

const inputBytes = 16_384;
const outputBytes = 65_536;
const terminal = new Set([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED]);
const conversationScope = { scope: 'conversation', history: 'latest', fork: 'initial' };

export const A2ABinding = defineDocFamily({
  kind: 'a2a.message', version: 1, family: true, ...conversationScope,
  initial: () => ({}), checkpointWhen: () => true,
});
const Admission = defineDoc({
  kind: 'a2a.admission', version: 1, ...conversationScope,
  initial: () => ({ count: 0 }), checkpointWhen: () => true,
});

export const A2ATask = defineTask({
  name: 'a2a.task', version: 1,
  initial: () => ({ phase: 'submit' }),
  phases: {
    async submit(task, runtime, ctx) {
      const conversation = await runtime.conversation(runtime.conversationId, ctx);
      await runtime.commit(async (tx) => {
        const submissionId = await conversation.submit(tx, {
          type: 'input', content: task.input.text, requestId: `a2a:${task.input.messageId}`,
          whenBusy: 'reject', notify: { taskId: task.id, key: 'answer' },
        });
        return { status: 'sleeping', signals: [SubmissionSettled.key('answer')],
          checkpoint: { phase: 'answer', submissionId } };
      }, ctx);
    },
    async answer(_task, runtime, ctx) {
      const signal = await runtime.readSignal(SubmissionSettled, 'answer', ctx);
      const settled = signal?.value;
      let outcome;
      if (settled?.status === 'done' && settled.type === 'input') {
        const answer = await runtime.entry(AssistantEntry, settled.answer, ctx);
        const text = answer?.model?.flatMap((m) => m.role === 'assistant'
          ? m.content.filter((part) => part.type === 'text').map((part) => part.text) : []).join('\n') ?? '';
        outcome = Buffer.byteLength(text) > outputBytes
          ? { status: 'failed', error: { message: 'Answer exceeds result limit' } }
          : { status: 'completed', result: text };
      } else if (settled?.reason === 'aborted') {
        outcome = { status: 'aborted' };
      } else {
        outcome = { status: 'failed', error: { message: 'Execution did not produce an answer' } };
      }
      await runtime.commit(() => ({ status: 'terminal', outcome }), ctx);
    },
  },
  async abort(task, runtime, ctx) {
    const conversation = await runtime.conversation(runtime.conversationId, ctx);
    // Reacquire by request ID only when submit committed. Never create input just to cancel it.
    if (task.state.checkpoint.submissionId) {
      const submission = await conversation.submit({
        type: 'input', content: task.input.text, requestId: `a2a:${task.input.messageId}`,
      }, ctx);
      if (await submission.abort(ctx) === 'already_placed') await conversation.abort(ctx);
      await submission.wait(ctx);
    }
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx);
  },
});

export const A2AExtension = defineExtension({ name: 'a2a', tasks: [A2ATask] });

function recordState(record) {
  if (record.state.status !== 'terminal') return record.startedAt === undefined
    ? TaskState.TASK_STATE_SUBMITTED : TaskState.TASK_STATE_WORKING;
  switch (record.state.outcome.status) {
    case 'completed': return TaskState.TASK_STATE_COMPLETED;
    case 'aborted': return TaskState.TASK_STATE_CANCELED;
    default: return TaskState.TASK_STATE_FAILED;
  }
}
const recordTimestamp = (record) => record.endedAt ?? record.startedAt ?? record.input.acceptedAt;

export function taskView(record) {
  const contextId = String(record.conversationId);
  const state = recordState(record);
  let text;
  if (record.state.status === 'terminal') {
    const outcome = record.state.outcome;
    if (outcome.status === 'completed') text = outcome.result;
    else if (outcome.status === 'aborted') text = 'Canceled after execution settled';
    else text = outcome.status === 'failed' ? outcome.error.message : 'Execution unavailable';
  }
  const user = { role: 'ROLE_USER', messageId: record.input.messageId, taskId: record.id,
    contextId, parts: [{ text: record.input.text }] };
  const message = text === undefined ? undefined : Message.fromJSON({ role: 'ROLE_AGENT',
    messageId: `${record.id}:answer`, taskId: record.id, contextId, parts: [{ text }] });
  return Task.fromJSON({ id: record.id, contextId,
    status: { state, timestamp: new Date(recordTimestamp(record)).toISOString(),
      ...(message ? { message: Message.toJSON(message) } : {}) },
    history: [user, ...(message ? [Message.toJSON(message)] : [])],
  });
}

export function durableTaskStore(harness, conversation) {
  const query = { kind: 'a2a.task', conversationId: conversation.id, order: 'descending' };
  return {
    async save() {}, // ResultManager may merge transient snapshots, but Durable alone owns persistence.
    async load(id) {
      const numericId = Number(id);
      if (!Number.isSafeInteger(numericId) || numericId < 1 || String(numericId) !== String(id)) return undefined;
      const record = await harness.getTask(numericId, context);
      return record?.kind === query.kind && record.conversationId === conversation.id ? taskView(record) : undefined;
    },
    async list(params) {
      let cursor;
      if (params.pageToken) {
        try {
          const token = JSON.parse(Buffer.from(params.pageToken, 'base64url').toString());
          if (token.conversationId !== conversation.id || token.status !== params.status
            || token.after !== params.statusTimestampAfter || !token.cursor || typeof token.cursor !== 'object') throw new Error();
          cursor = token.cursor;
        } catch { throw new RequestMalformedError('Invalid page token'); }
      }
      const after = params.statusTimestampAfter ? Date.parse(params.statusTimestampAfter) : undefined;
      const matches = (record) => (!params.contextId || String(record.conversationId) === params.contextId)
        && (!params.status || recordState(record) === params.status)
        && (after === undefined || recordTimestamp(record) > after);
      const filtered = params.contextId || params.status || after !== undefined;
      return harness.commit(async (tx) => {
        // Count and page from the same committed view. Filters not available in Durable are applied here.
        let totalSize = 0;
        let countCursor;
        do {
          const page = await tx.scanTasks(query, 100, countCursor);
          totalSize += filtered ? page.items.filter(matches).length : page.items.length;
          countCursor = page.next;
        } while (countCursor);
        const tasks = [];
        let next;
        do {
          const page = await tx.scanTasks(query, 1, cursor);
          const record = page.items[0];
          if (record && matches(record)) {
            if (tasks.length === params.pageSize) break;
            tasks.push(taskView(record));
            next = page.next;
          }
          cursor = page.next;
          if (!cursor) { next = undefined; break; }
        } while (cursor);
        const nextPageToken = next ? Buffer.from(JSON.stringify({ conversationId: conversation.id,
          status: params.status, after: params.statusTimestampAfter, cursor: next })).toString('base64url') : '';
        return { tasks, nextPageToken, pageSize: params.pageSize, totalSize };
      }, context);
    },
  };
}

/** Prototype: install A2AExtension in the host registry before opening its harness. */
export async function openDurableA2A({ harness, conversation, card: description }) {
  const contextId = String(conversation.id);
  const store = durableTaskStore(harness, conversation);
  const buses = new DefaultExecutionEventBusManager(() => 'shared-agent');
  const waitingBuses = new Set();
  const drains = new Set();
  const sends = new Set();
  const stopWaiting = new AbortController();
  const waitingContext = withAbortSignal(stopWaiting.signal, context);
  let stopping = false;
  const card = AgentCard.fromJSON({
    name: description.name, description: description.description, version: description.version ?? '0.1.0',
    supportedInterfaces: [{ url: description.url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }], skills: description.skills,
  });
  const executor = {
    async execute(request, bus) {
      waitingBuses.add(bus);
      try {
        if (stopping) return;
        const initial = await store.load(request.taskId);
        if (stopping) return;
        bus.publish(AgentEvent.task(initial));
        await harness.waitForTask(Number(request.taskId), waitingContext);
        if (!stopping) bus.publish(AgentEvent.task(await store.load(request.taskId)));
      } catch (error) {
        if (!stopping) throw error;
      } finally { waitingBuses.delete(bus); }
    },
    async cancelTask(id) {
      await harness.abortTask(Number(id), context);
      await harness.waitForTask(Number(id), context);
    },
  };
  const validateScope = (tenant, requestedContext) => {
    if (tenant || (requestedContext && requestedContext !== contextId)) throw new RequestMalformedError('Unknown scope');
  };
  class Handler extends DefaultRequestHandler {
    async _processEvents(...args) {
      const drain = super._processEvents(...args);
      drains.add(drain);
      try { return await drain; } finally { drains.delete(drain); }
    }
    async *sendMessageStream() { throw new UnsupportedOperationError('Streaming unsupported'); }
    async *resubscribe() { throw new UnsupportedOperationError('Streaming unsupported'); }
    async getTask(params, ctx) { validateScope(params.tenant); return super.getTask(params, ctx); }
    async listTasks(params, ctx) {
      validateScope(params.tenant, params.contextId);
      if ((params.pageSize ?? 0) < 0 || (params.pageSize ?? 0) > 100) throw new RequestMalformedError('Invalid page size');
      return super.listTasks({ ...params, pageSize: params.pageSize || 50 }, ctx);
    }
    async cancelTask(params, ctx) {
      validateScope(params.tenant);
      if (stopping) throw new UnsupportedOperationError('Agent stopping');
      const task = await super.getTask(params, ctx);
      if (task.status.state === TaskState.TASK_STATE_CANCELED) return task;
      if (terminal.has(task.status.state)) throw new TaskNotCancelableError();
      // SDK's no-bus path only changes its snapshot; it does not invoke cancellation.
      await executor.cancelTask(params.id);
      const latest = await super.getTask(params, ctx);
      if (latest.status.state !== TaskState.TASK_STATE_CANCELED) throw new TaskNotCancelableError();
      return latest;
    }
    async _createRequestContext(params, ctx) {
      // This is a newly admitted task, not a continuation. Let the SDK validate its
      // request normally, without its continuation-only terminal-state rejection.
      const validated = await super._createRequestContext({ ...params, message: { ...params.message, taskId: '' } }, ctx);
      const message = { ...validated.userMessage, taskId: params.message.taskId };
      const task = await store.load(message.taskId);
      if (stopping) throw new UnsupportedOperationError('Agent stopping');
      return new RequestContext({ ...validated.request, message }, message.taskId, contextId, ctx, task);
    }
    sendMessage(params, ctx) {
      if (stopping) return Promise.reject(new UnsupportedOperationError('Agent stopping'));
      const send = this._sendMessage(params, ctx);
      sends.add(send);
      return send.finally(() => sends.delete(send));
    }
    async _sendMessage(params, ctx) {
      validateScope(params.tenant);
      const modes = params.configuration?.acceptedOutputModes;
      if (modes?.length && !modes.some((mode) => ['text/plain', 'text/*', '*/*'].includes(mode))) throw new ContentTypeNotSupportedError();
      const m = params.message;
      if (!m || m.role !== Role.ROLE_USER || !m.messageId || !m.parts.length || (m.contextId && m.contextId !== contextId)) {
        throw new RequestMalformedError('Invalid message/context');
      }
      if (m.parts.some((p) => p.content?.$case !== 'text' || (p.mediaType && p.mediaType !== 'text/plain'))) throw new ContentTypeNotSupportedError();
      if (m.taskId || m.referenceTaskIds.length || params.configuration?.taskPushNotificationConfig) throw new UnsupportedOperationError();
      const text = m.parts.map((p) => p.content?.value).join('\n');
      if (m.messageId.length > 128 || !text.trim() || Buffer.byteLength(text) > inputBytes) throw new RequestMalformedError('Input too large');
      const hash = createHash('sha256').update(text).digest('hex');
      const accepted = await conversation.commit(async (tx) => {
        const binding = await tx.doc(A2ABinding, conversation.id, m.messageId, null);
        if (binding.taskId) {
          if (binding.hash !== hash) throw new RequestMalformedError('Message ID conflict');
          return { id: binding.taskId, duplicate: true };
        }
        const admission = await tx.doc(Admission, conversation.id);
        const active = admission.active && await tx.task(admission.active);
        const live = await tx.doc(LiveDoc, conversation.id);
        const inbox = await tx.doc(InboxDoc, conversation.id);
        if (stopping || (active && active.state.status !== 'terminal') || live.run || inbox.items.length) {
          throw new UnsupportedOperationError('Agent busy');
        }
        if (admission.count >= 10_000) throw new UnsupportedOperationError('Task capacity reached');
        // The observer must stay outside ordinary conversation.abort()/idle waits:
        // its abort handler joins that foreground scope, which otherwise includes itself.
        const id = await tx.createTask(A2ATask, { messageId: m.messageId, text, hash, acceptedAt: Date.now() },
          { ownership: { kind: 'conversation' }, background: true });
        binding.taskId = id;
        binding.hash = hash;
        admission.active = id;
        admission.count += 1;
        return { id, duplicate: false };
      }, context);
      if (stopping) throw new UnsupportedOperationError('Agent stopping');
      if (accepted.duplicate) {
        if (params.configuration?.returnImmediately !== true) await harness.waitForTask(accepted.id, waitingContext);
        const task = await store.load(accepted.id);
        this._applyHistoryLengthSemantics(task, params.configuration ?? {});
        return task;
      }
      return super.sendMessage({ ...params, message: { ...m, taskId: accepted.id, contextId } }, ctx);
    }
  }
  return { handler: new Handler(card, store, executor, buses), card, contextId, store,
    async close() {
      stopping = true;
      stopWaiting.abort(); // Cancel only request-side waits, never Durable execution.
      for (const bus of waitingBuses) bus.finished();
      // Entry-to-response tracking covers sends that have admitted work but not
      // registered a bus yet. Late executors see stopping and publish no events.
      await Promise.allSettled([...sends]);
      await Promise.allSettled([...drains]);
    },
  };
}
