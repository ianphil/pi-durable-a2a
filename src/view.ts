// A2A views of stored `a2a.task` records: task snapshots and cursor-paged listing.
import { type Message, Role, type Task, TaskState } from "@a2a-js/sdk";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import type { ConversationId, Cursor, Tx } from "@earendil-works/pi-durable";
import { type A2ATaskRecord, PUBLIC_FAILURES, storedA2ATask } from "./task.ts";

/** The A2A task snapshot of a stored record: the user's message and, once settled, the agent's reply. */
export function taskView(record: A2ATaskRecord): Task {
	const contextId = String(record.conversationId);
	const taskId = String(record.id);
	const user = textMessage(Role.ROLE_USER, record.input.messageId, taskId, contextId, record.input.text);
	const replyText = reply(record);
	const agent =
		replyText === undefined
			? undefined
			: textMessage(Role.ROLE_AGENT, `${taskId}:answer`, taskId, contextId, replyText);
	return {
		id: taskId,
		contextId,
		status: {
			state: stateOf(record),
			message: agent,
			timestamp: new Date(timestampOf(record)).toISOString(),
		},
		artifacts: [],
		history: agent ? [user, agent] : [user],
		metadata: undefined,
	};
}

function reply(record: A2ATaskRecord): string | undefined {
	if (record.state.status !== "terminal") return undefined;
	const outcome = record.state.outcome;
	switch (outcome.status) {
		case "completed":
			return outcome.result;
		case "aborted":
			return "Canceled after execution settled";
		case "failed":
			return PUBLIC_FAILURES.has(outcome.error.message) ? outcome.error.message : "Execution unavailable";
		default:
			return "Execution unavailable";
	}
}

function textMessage(role: Role, messageId: string, taskId: string, contextId: string, text: string): Message {
	return {
		messageId,
		contextId,
		taskId,
		role,
		parts: [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" }],
		metadata: undefined,
		extensions: [],
		referenceTaskIds: [],
	};
}

function stateOf(record: A2ATaskRecord): TaskState {
	if (record.state.status !== "terminal") {
		return record.startedAt === undefined ? TaskState.TASK_STATE_SUBMITTED : TaskState.TASK_STATE_WORKING;
	}
	switch (record.state.outcome.status) {
		case "completed":
			return TaskState.TASK_STATE_COMPLETED;
		case "aborted":
			return TaskState.TASK_STATE_CANCELED;
		default:
			return TaskState.TASK_STATE_FAILED;
	}
}

function timestampOf(record: A2ATaskRecord): number {
	return record.endedAt ?? record.startedAt ?? record.input.acceptedAt;
}

/** Which tasks to list: one page of at most `pageSize`, after an optional page token. */
export type TaskListing = {
	readonly pageSize: number;
	readonly pageToken: string;
	/** `TASK_STATE_UNSPECIFIED` lists every state. */
	readonly status: TaskState;
	/** Milliseconds; lists tasks whose status changed after it. */
	readonly after: number | undefined;
};

/** One page of tasks, newest first, with the exact count of all matches. */
export type TaskPage = { readonly tasks: Task[]; readonly nextPageToken: string; readonly totalSize: number };

type PageToken = { conversationId: ConversationId; status: TaskState; after: number | undefined; cursor: Cursor };

const SCAN_BATCH = 100;

/**
 * List one conversation's A2A tasks through `tx`, counting and paging from the same committed view. Only returned tasks
 * are translated. Durable filters by kind and conversation; state and timestamp filters are applied here.
 */
export async function listTasks(
	tx: Pick<Tx, "scanTasks">,
	conversationId: ConversationId,
	listing: TaskListing,
): Promise<TaskPage> {
	const query = { kind: "a2a.task", conversationId, order: "descending" } as const;
	let cursor = listing.pageToken ? readPageToken(listing, conversationId) : undefined;
	const matches = (record: A2ATaskRecord) =>
		(listing.status === TaskState.TASK_STATE_UNSPECIFIED || stateOf(record) === listing.status) &&
		(listing.after === undefined || timestampOf(record) > listing.after);

	let totalSize = 0;
	let countCursor: Cursor | undefined;
	do {
		const page = await tx.scanTasks(query, SCAN_BATCH, countCursor);
		for (const record of page.items) if (matches(storedA2ATask(record))) totalSize += 1;
		countCursor = page.next;
	} while (countCursor);
	if (totalSize === 0) return { tasks: [], nextPageToken: "", totalSize };

	// Page one record at a time so the next cursor points just past the last returned match.
	const tasks: Task[] = [];
	let next: Cursor | undefined;
	while (true) {
		const page = await tx.scanTasks(query, 1, cursor);
		const record = page.items[0] && storedA2ATask(page.items[0]);
		if (record && matches(record)) {
			if (tasks.length === listing.pageSize) break;
			tasks.push(taskView(record));
			// A first page that holds every counted match has no next page; no lookahead scan is needed.
			if (!listing.pageToken && tasks.length === totalSize) {
				next = undefined;
				break;
			}
			next = page.next;
		}
		cursor = page.next;
		if (!cursor) {
			next = undefined;
			break;
		}
	}
	return { tasks, nextPageToken: next ? writePageToken(listing, conversationId, next) : "", totalSize };
}

function writePageToken(listing: TaskListing, conversationId: ConversationId, cursor: Cursor): string {
	const token: PageToken = { conversationId, status: listing.status, after: listing.after, cursor };
	return Buffer.from(JSON.stringify(token)).toString("base64url");
}

// Wire input: a page token is only valid for the conversation and filters that produced it.
function readPageToken(listing: TaskListing, conversationId: ConversationId): Cursor {
	let token: Partial<PageToken> | null;
	try {
		token = JSON.parse(Buffer.from(listing.pageToken, "base64url").toString());
	} catch {
		throw new RequestMalformedError("Invalid page token");
	}
	if (
		token?.conversationId !== conversationId ||
		token.status !== listing.status ||
		token.after !== listing.after ||
		typeof token.cursor !== "object" ||
		token.cursor === null
	) {
		throw new RequestMalformedError("Invalid page token");
	}
	return token.cursor;
}
