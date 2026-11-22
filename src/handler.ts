// The A2A request handler of one Durable conversation: each accepted message is a Durable task.
import { createHash } from "node:crypto";
import {
	AgentCard,
	type CancelTaskRequest,
	type DeleteTaskPushNotificationConfigRequest,
	type GetExtendedAgentCardRequest,
	type GetTaskPushNotificationConfigRequest,
	type GetTaskRequest,
	type ListTaskPushNotificationConfigsRequest,
	type ListTaskPushNotificationConfigsResponse,
	type ListTasksRequest,
	type ListTasksResponse,
	Role,
	type SendMessageRequest,
	type StreamResponse,
	type SubscribeToTaskRequest,
	type Task,
	type TaskPushNotificationConfig,
	TaskState,
} from "@a2a-js/sdk";
import {
	ContentTypeNotSupportedError,
	PushNotificationNotSupportedError,
	RequestMalformedError,
	TaskNotCancelableError,
	TaskNotFoundError,
	UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import type { A2ARequestHandler, ServerCallContext } from "@a2a-js/sdk/server";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import type { Conversation, Harness, TaskId } from "@earendil-works/pi-durable";
import { type A2ATaskRecord, a2aTaskOf, admitMessage, durableTaskId, UnsupportedTaskVersion } from "./task.ts";
import { listTasks, taskView } from "./view.ts";

/** What the Agent Card says about the agent; the handler adds its protocol and security details. */
export type A2ACard = {
	readonly name: string;
	readonly description: string;
	readonly version?: string;
	/** The JSON-RPC URL callers reach. */
	readonly url: string;
	readonly skills: readonly { id: string; name: string; description: string; tags: string[] }[];
};

/** The conversation to serve, through the Harness that owns it, and its Agent Card. */
export type A2AHandlerOptions = {
	readonly harness: Harness;
	readonly conversation: Conversation;
	readonly card: A2ACard;
};

const INPUT_BYTES = 16_384;
const MESSAGE_ID_LENGTH = 128;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const TEXT_MODES = ["text/plain", "text/*", "*/*"];

/**
 * Serves one Durable conversation as an A2A agent. Install `A2AExtension` before opening the Harness. All foreground
 * work in the conversation must come through this handler: cancellation aborts conversation-wide.
 */
export class A2AHandler implements A2ARequestHandler {
	readonly card: AgentCard;
	/** The A2A context ID: the served conversation's ID. */
	readonly contextId: string;
	readonly #harness: Harness;
	readonly #conversation: Conversation;
	readonly #requests = new Set<Promise<unknown>>();
	/** Aborted by `close()`: callers stop waiting, Durable work does not. */
	readonly #stopWaiting = new AbortController();
	readonly #waiting: Context;
	#closing: Promise<void> | undefined;

	constructor(options: A2AHandlerOptions) {
		this.#harness = options.harness;
		this.#conversation = options.conversation;
		this.contextId = String(options.conversation.id);
		this.#waiting = withAbortSignal(this.#stopWaiting.signal, BACKGROUND_CONTEXT);
		this.card = agentCard(options.card);
	}

	async getAgentCard(): Promise<AgentCard> {
		return this.card;
	}

	async getAuthenticatedExtendedAgentCard(_params: GetExtendedAgentCardRequest): Promise<AgentCard> {
		throw new UnsupportedOperationError("Extended agent card unsupported");
	}

	/** Admit a message as a task, or find the task its message ID already created; then wait for it unless asked not to. */
	sendMessage(params: SendMessageRequest, _context: ServerCallContext): Promise<Task> {
		return this.#track(async () => {
			this.#checkScope(params.tenant);
			const { messageId, text } = this.#acceptedMessage(params);
			const hash = createHash("sha256").update(text).digest("hex");
			const admitted = await admitMessage(
				this.#conversation,
				{ messageId, text, hash, acceptedAt: Date.now() },
				BACKGROUND_CONTEXT,
			);
			if (admitted.kind === "busy") throw new UnsupportedOperationError("Agent busy");
			if (admitted.kind === "conflict") throw new RequestMalformedError("Message ID conflict");
			let record = await this.#record(admitted.taskId);
			if (params.configuration?.returnImmediately !== true && record.state.status !== "terminal") {
				await this.#waitFor(admitted.taskId);
				record = await this.#record(admitted.taskId);
			}
			return withHistory(taskView(record), params.configuration?.historyLength);
		});
	}

	sendMessageStream(_params: SendMessageRequest): AsyncGenerator<StreamResponse, void, undefined> {
		return unsupportedStream();
	}

	getTask(params: GetTaskRequest, _context: ServerCallContext): Promise<Task> {
		return this.#track(async () => {
			this.#checkScope(params.tenant);
			return withHistory(taskView(await this.#record(this.#taskId(params.id))), params.historyLength);
		});
	}

	listTasks(params: ListTasksRequest, _context: ServerCallContext): Promise<ListTasksResponse> {
		return this.#track(async () => {
			this.#checkScope(params.tenant, params.contextId);
			const pageSize = params.pageSize || DEFAULT_PAGE_SIZE;
			if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
				throw new RequestMalformedError("Invalid page size");
			}
			if (!Object.values(TaskState).includes(params.status)) throw new RequestMalformedError("Invalid status");
			const after = params.statusTimestampAfter ? Date.parse(params.statusTimestampAfter) : undefined;
			if (Number.isNaN(after)) throw new RequestMalformedError("Invalid status timestamp");
			const page = await this.#harness.commit(
				(tx) =>
					listTasks(tx, this.#conversation.id, {
						pageSize,
						pageToken: params.pageToken,
						status: params.status,
						after,
					}),
				BACKGROUND_CONTEXT,
			);
			return { ...page, pageSize, tasks: page.tasks.map((task) => withHistory(task, params.historyLength)) };
		});
	}

	/** Cancel a task's Durable work. Reports canceled only once the work settled aborted; an answer that won is kept. */
	cancelTask(params: CancelTaskRequest, _context: ServerCallContext): Promise<Task> {
		return this.#track(async () => {
			this.#checkScope(params.tenant);
			const id = this.#taskId(params.id);
			const record = await this.#record(id);
			if (record.state.status !== "terminal") {
				// Not under `close()`'s abort: an accepted cancellation finishes, and close joins it.
				await this.#harness.abortTask(id, BACKGROUND_CONTEXT);
				await this.#harness.waitForTask(id, BACKGROUND_CONTEXT);
			}
			const settled = await this.#record(id);
			if (settled.state.status !== "terminal" || settled.state.outcome.status !== "aborted") {
				throw new TaskNotCancelableError();
			}
			return taskView(settled);
		});
	}

	async createTaskPushNotificationConfig(_params: TaskPushNotificationConfig): Promise<TaskPushNotificationConfig> {
		throw new PushNotificationNotSupportedError();
	}

	async getTaskPushNotificationConfig(
		_params: GetTaskPushNotificationConfigRequest,
	): Promise<TaskPushNotificationConfig> {
		throw new PushNotificationNotSupportedError();
	}

	async listTaskPushNotificationConfigs(
		_params: ListTaskPushNotificationConfigsRequest,
	): Promise<ListTaskPushNotificationConfigsResponse> {
		throw new PushNotificationNotSupportedError();
	}

	async deleteTaskPushNotificationConfig(_params: DeleteTaskPushNotificationConfigRequest): Promise<void> {
		throw new PushNotificationNotSupportedError();
	}

	resubscribe(_params: SubscribeToTaskRequest): AsyncGenerator<StreamResponse, void, undefined> {
		return unsupportedStream();
	}

	/**
	 * Refuse new requests, stop request-side waits, and resolve once accepted requests have finished. Durable work keeps
	 * running; close the Harness afterwards.
	 */
	close(): Promise<void> {
		if (!this.#closing) {
			this.#stopWaiting.abort();
			this.#closing = Promise.allSettled([...this.#requests]).then(() => undefined);
		}
		return this.#closing;
	}

	/** Run one request, refused once closing; `close()` waits for it, so the Harness outlives every Durable call. */
	#track<T>(request: () => Promise<T>): Promise<T> {
		if (this.#closing) return Promise.reject(stopping());
		const running = request().catch((error: unknown) => {
			throw error instanceof UnsupportedTaskVersion ? new UnsupportedOperationError(error.message) : error;
		});
		this.#requests.add(running);
		return running.finally(() => this.#requests.delete(running));
	}

	async #waitFor(id: TaskId<string>): Promise<void> {
		try {
			await this.#harness.waitForTask(id, this.#waiting);
		} catch (error) {
			if (this.#closing) throw stopping();
			throw error;
		}
	}

	async #record(id: TaskId<string>): Promise<A2ATaskRecord> {
		const record = a2aTaskOf(await this.#harness.getTask(id, BACKGROUND_CONTEXT), this.#conversation.id);
		if (!record) throw new TaskNotFoundError();
		return record;
	}

	#taskId(id: string): TaskId<string> {
		const taskId = durableTaskId(id);
		if (taskId === undefined) throw new TaskNotFoundError();
		return taskId;
	}

	// Wire input: one shared context, no tenants.
	#checkScope(tenant: string, contextId?: string): void {
		if (tenant || (contextId && contextId !== this.contextId)) throw new RequestMalformedError("Unknown scope");
	}

	// Wire input: a new plain-text user message in this context, not a continuation of another task.
	#acceptedMessage(params: SendMessageRequest): { messageId: string; text: string } {
		const modes = params.configuration?.acceptedOutputModes;
		if (modes?.length && !modes.some((mode) => TEXT_MODES.includes(mode))) throw new ContentTypeNotSupportedError();
		const message = params.message;
		if (
			!message ||
			message.role !== Role.ROLE_USER ||
			!message.messageId ||
			message.parts.length === 0 ||
			(message.contextId && message.contextId !== this.contextId)
		) {
			throw new RequestMalformedError("Invalid message/context");
		}
		if (
			message.parts.some(
				(part) => part.content?.$case !== "text" || (part.mediaType && part.mediaType !== "text/plain"),
			)
		) {
			throw new ContentTypeNotSupportedError();
		}
		if (message.taskId || message.referenceTaskIds.length > 0 || params.configuration?.taskPushNotificationConfig) {
			throw new UnsupportedOperationError();
		}
		const text = message.parts.map((part) => (part.content?.$case === "text" ? part.content.value : "")).join("\n");
		if (message.messageId.length > MESSAGE_ID_LENGTH || !text.trim() || Buffer.byteLength(text) > INPUT_BYTES) {
			throw new RequestMalformedError("Input too large");
		}
		return { messageId: message.messageId, text };
	}
}

function agentCard(card: A2ACard): AgentCard {
	return AgentCard.fromJSON({
		name: card.name,
		description: card.description,
		version: card.version ?? "0.1.0",
		supportedInterfaces: [{ url: card.url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
		capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain"],
		securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
		securityRequirements: [{ schemes: { bearer: { list: [] } } }],
		skills: card.skills,
	});
}

/** Apply a request's `historyLength`: absent keeps all, zero or less none, otherwise the newest messages. */
function withHistory(task: Task, historyLength: number | undefined): Task {
	if (historyLength === undefined) return task;
	return { ...task, history: historyLength <= 0 ? [] : task.history.slice(-historyLength) };
}

// biome-ignore lint/correctness/useYield: the interface requires a stream; this one's first `next()` rejects.
async function* unsupportedStream(): AsyncGenerator<StreamResponse, void, undefined> {
	throw new UnsupportedOperationError("Streaming unsupported");
}

function stopping(): UnsupportedOperationError {
	return new UnsupportedOperationError("Agent stopping");
}
