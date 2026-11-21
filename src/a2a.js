import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { AgentCard, Message, Role, Task, TaskState, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import {
  AgentEvent, DefaultExecutionEventBusManager, DefaultRequestHandler, ResultManager, ServerCallContext,
} from '@a2a-js/sdk/server';
import { DatabaseTaskStore } from '@a2a-js/sdk/server/database';
import { ContentTypeNotSupportedError, RequestMalformedError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantEntry } from '@earendil-works/pi-durable';

const owner = 'shared-agent';
const callContext = new ServerCallContext();
const terminal = new Set([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED]);
const limits = { inputBytes: 16_384, outputBytes: 65_536, tasks: 10_000, pages: 262_144, freeBytes: 64 * 1024 * 1024 };

// The SDK's task tables are migrated by its own CLI. Run it before opening the store.
function upgradeTaskStore(database) {
  const cli = fileURLToPath(new URL('cli/a2a_db.js', import.meta.resolve('@a2a-js/sdk')));
  execFileSync(process.execPath, [cli, 'upgrade', '--url', `sqlite:${database}`, '--store', 'tasks'], { stdio: 'ignore' });
}

/**
 * Serve one Durable conversation over A2A. The SDK owns protocol, task snapshots and
 * pagination; this bridge maps each accepted message to one Durable submission.
 *
 * @param {object} options
 * @param {import('@earendil-works/pi-durable').Conversation} options.conversation
 * @param {string} options.database SQLite file for A2A tasks and admissions.
 * @param {{ name: string, description: string, version?: string, url: string,
 *   skills: { id: string, name: string, description: string, tags?: string[] }[] }} options.card
 * @param {(event: string, fields: Record<string, string>) => void} [options.log]
 */
export async function openA2A(options) {
  const { conversation } = options;
  upgradeTaskStore(options.database);
  const sqlite = new Database(options.database);
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`CREATE TABLE IF NOT EXISTS a2a_identity (id INTEGER PRIMARY KEY CHECK(id=1), context TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS a2a_admission (task TEXT PRIMARY KEY, message TEXT UNIQUE NOT NULL,
      hash TEXT NOT NULL, text TEXT NOT NULL, cancel INTEGER NOT NULL DEFAULT 0)`);
  sqlite.prepare('INSERT OR IGNORE INTO a2a_identity VALUES (1, ?)').run(randomUUID());
  const contextId = sqlite.prepare('SELECT context FROM a2a_identity').get().context;
  const admission = (task) => sqlite.prepare('SELECT * FROM a2a_admission WHERE task=?').get(task);
  const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
  const store = new DatabaseTaskStore(db, { ownerResolver: () => owner });
  const buses = new DefaultExecutionEventBusManager(() => owner);
  const active = new Map();
  let stopping = false;
  let admitting = false;

  const card = AgentCard.fromJSON({
    name: options.card.name, description: options.card.description, version: options.card.version ?? '0.1.0',
    supportedInterfaces: [{ url: options.card.url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    skills: options.card.skills,
  });

  const publish = async (bus, id, state, text) => {
    const message = Message.fromJSON({ role: 'ROLE_AGENT', messageId: randomUUID(), taskId: id, contextId, parts: [{ text }] });
    const event = AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({ taskId: id, contextId,
      status: { state, timestamp: new Date().toISOString(), message: Message.toJSON(message) } }));
    await new ResultManager(store, callContext).processEvent(event);
    options.log?.('a2a_settled', { taskId: id, contextId, state: String(state) });
    bus.publish(event);
  };

  // A request ID makes Durable return the same submission after a restart or a cancel.
  const submit = (row) => conversation.submit(
    { type: 'input', content: row.text, requestId: `a2a:${row.message}`, whenBusy: 'reject' }, context);

  const run = (row, bus) => {
    const existing = active.get(row.task);
    if (existing) return existing;
    const work = (async () => {
      const task = await store.load(row.task, callContext) ?? Task.fromJSON({ id: row.task, contextId,
        status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() } });
      await new ResultManager(store, callContext).processEvent(AgentEvent.task(task));
      bus.publish(AgentEvent.task(task));
      const submission = await submit(row);
      options.log?.('a2a_submission', { taskId: row.task, contextId, submissionId: String(submission.id) });
      if (row.cancel) await abort(submission);
      const settled = await submission.wait(context);
      if (settled.status === 'done' && settled.type === 'input') {
        const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
        const text = answer?.model?.flatMap((m) => m.role === 'assistant'
          ? m.content.filter((part) => part.type === 'text').map((part) => part.text) : []).join('\n') ?? '';
        if (Buffer.byteLength(text) > limits.outputBytes) await publish(bus, row.task, TaskState.TASK_STATE_FAILED, 'Answer exceeds result limit');
        else await publish(bus, row.task, TaskState.TASK_STATE_COMPLETED, text);
      } else if (admission(row.task).cancel) {
        await publish(bus, row.task, TaskState.TASK_STATE_CANCELED, 'Canceled after execution settled');
      } else {
        await publish(bus, row.task, TaskState.TASK_STATE_FAILED, 'Execution did not produce an answer');
      }
    })().catch(async () => {
      // While stopping, accepted work stays pending in Durable and resumes on the next open.
      if (!stopping) await publish(bus, row.task, TaskState.TASK_STATE_FAILED, 'Execution unavailable');
    }).finally(() => { active.delete(row.task); if (!stopping) bus.finished(); });
    active.set(row.task, work);
    return work;
  };

  const abort = async (submission) => {
    if (await submission.abort(context) === 'already_placed') await conversation.abort(context);
  };

  const executor = {
    async execute(requestContext, bus) {
      const row = admission(requestContext.taskId);
      if (!row) throw new Error('admission_missing');
      await run(row, bus);
    },
    async cancelTask(id) {
      sqlite.prepare('UPDATE a2a_admission SET cancel=1 WHERE task=?').run(id);
      await abort(await submit(admission(id)));
      await active.get(id);
    },
  };

  const validateScope = (tenant, requestedContext) => {
    if (tenant || (requestedContext && requestedContext !== contextId)) throw new RequestMalformedError('Unknown scope');
  };

  class Handler extends DefaultRequestHandler {
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
      return super.cancelTask(params, ctx);
    }
    async sendMessage(params, ctx) {
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
      if (m.messageId.length > 128 || !text.trim() || Buffer.byteLength(text) > limits.inputBytes) throw new RequestMalformedError('Input too large');
      const hash = createHash('sha256').update(text).digest('hex');
      const previous = sqlite.prepare('SELECT * FROM a2a_admission WHERE message=?').get(m.messageId);
      if (previous) {
        if (previous.hash !== hash) throw new RequestMalformedError('Message ID conflict');
        const snapshot = await store.load(previous.task, ctx);
        if (!snapshot) throw new UnsupportedOperationError('Task recovering');
        return snapshot;
      }
      if (stopping || admitting || active.size) throw new UnsupportedOperationError('Agent busy');
      if (sqlite.prepare('SELECT count(*) AS n FROM a2a_admission').get().n >= limits.tasks) throw new UnsupportedOperationError('Task capacity reached');
      const disk = statfsSync(options.database);
      if (disk.bavail * disk.bsize < limits.freeBytes || sqlite.pragma('page_count', { simple: true }) > limits.pages) {
        throw new UnsupportedOperationError('Storage capacity reached');
      }
      admitting = true;
      const id = randomUUID();
      try {
        sqlite.prepare('INSERT INTO a2a_admission(task,message,hash,text) VALUES(?,?,?,?)').run(id, m.messageId, hash, text);
        await store.save(Task.fromJSON({ id, contextId, status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() } }), ctx);
        return await super.sendMessage({ ...params, message: { ...m, taskId: id, contextId } }, ctx);
      } finally { admitting = false; }
    }
  }
  const handler = new Handler(card, store, executor, buses);

  // Recreate live buses before serving: the SDK's no-bus cancel path would otherwise
  // mark a recovered task canceled without stopping its Durable work.
  for (const row of sqlite.prepare('SELECT * FROM a2a_admission').all()) {
    const snapshot = await store.load(row.task, callContext);
    if (!snapshot || !terminal.has(snapshot.status.state)) void run(row, buses.createOrGetByTaskId(row.task, callContext));
  }

  return {
    handler, card, contextId,
    /** Stop admitting work. Close the Durable harness afterwards; pending work resumes on the next open. */
    async close() {
      stopping = true;
      while (admitting) await new Promise((resolve) => setTimeout(resolve, 10));
      await db.destroy();
    },
  };
}
