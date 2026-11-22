// The Durable side of A2A: the stored task, its message-ID binding, and admission of a message as a task.
import type { Context } from "@earendil-works/chord/context";
import {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	defineDoc,
	defineDocFamily,
	defineExtension,
	defineTask,
	InboxDoc,
	LiveDoc,
	type SettledSubmissionRecord,
	type SubmissionId,
	SubmissionSettled,
	type TaskId,
	type TaskOutcome,
	type TaskRecord,
	type TaskRuntime,
} from "@earendil-works/pi-durable";

/** Stored input of an `a2a.task`, version 1. */
export type A2ATaskInput = {
	readonly messageId: string;
	readonly text: string;
	/** SHA-256 of `text`, hex; a resent message ID must carry the same text. */
	readonly hash: string;
	readonly acceptedAt: number;
};

/** Stored checkpoint of an `a2a.task`, version 1. */
export type A2ATaskCheckpoint =
	| { readonly phase: "submit" }
	| { readonly phase: "answer"; readonly submissionId: SubmissionId };

/** An `a2a.task` record, with the input, checkpoint, and answer types of version 1. */
export type A2ATaskRecord = TaskRecord<A2ATaskInput, A2ATaskCheckpoint, string>;

/** Answers longer than this fail the task; the full text stays in Durable. */
const OUTPUT_BYTES = 65_536;

/** Failure messages a public task snapshot may show; any other diagnostic stays private. */
export const PUBLIC_FAILURES = new Set(["Answer exceeds result limit", "Execution did not produce an answer"]);

/** Binds one message ID to the task it created, per conversation. */
export const A2ABinding = defineDocFamily<{ taskId?: TaskId<string>; hash?: string }, null>({
	kind: "a2a.message",
	version: 1,
	family: true,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => true,
});

/** The last admitted task of a conversation; a new message is refused while it is not terminal. */
const AdmissionDoc = defineDoc<{ active?: TaskId<string> }>({
	kind: "a2a.admission",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => true,
});

type Runtime = TaskRuntime<A2ATaskInput, A2ATaskCheckpoint, string, object>;

/** Submits one A2A message to its conversation and settles with the submission's actual outcome. */
export const A2ATask = defineTask<A2ATaskInput, A2ATaskCheckpoint, string>({
	name: "a2a.task",
	version: 1,
	initial: () => ({ phase: "submit" }),
	phases: {
		async submit(task, runtime, context) {
			const conversation = await handleOf(runtime, context);
			await runtime.commit(async (tx) => {
				const submissionId = await conversation.submit(tx, {
					type: "input",
					content: task.input.text,
					requestId: `a2a.task:${task.id}`,
					whenBusy: "reject",
					notify: { taskId: task.id, key: "answer" },
				});
				return {
					status: "sleeping",
					signals: [SubmissionSettled.key("answer")],
					checkpoint: { phase: "answer", submissionId },
				};
			}, context);
		},
		async answer(_task, runtime, context) {
			const signal = await runtime.readSignal(SubmissionSettled, "answer", context);
			const settled = signal && "value" in signal ? signal.value : undefined;
			const outcome = await submissionOutcome(settled, runtime, context);
			await runtime.commit(() => ({ status: "terminal", outcome }), context);
		},
	},
	async abort(task, runtime, context) {
		const checkpoint = task.state.checkpoint;
		// Before the submit phase committed there is no input to cancel; never create one just to abort it.
		if (checkpoint.phase === "submit") {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			return;
		}
		const conversation = await handleOf(runtime, context);
		// Reacquire the submission by the request ID it was committed with, not by one derived again.
		let requestId: string | undefined;
		await runtime.commit(async (tx) => {
			requestId = (await tx.submission(checkpoint.submissionId))?.requestId;
		}, context);
		if (requestId === undefined) throw new Error("Submission unavailable");
		const submission = await conversation.submit({ type: "input", content: task.input.text, requestId }, context);
		// Durable only aborts placed input conversation-wide; this is why the served conversation is A2A-only.
		if ((await submission.abort(context)) === "already_placed") await conversation.abort(context);
		// An answer or failure that settled first is kept; cancellation intent does not replace it.
		const outcome = await submissionOutcome(await submission.wait(context), runtime, context);
		await runtime.commit(() => ({ status: "terminal", outcome }), context);
	},
});

/** Install before opening the Harness, on every start, so Durable can run and resume A2A tasks. */
export const A2AExtension = defineExtension({ name: "a2a", tasks: [A2ATask] });

async function handleOf(runtime: Runtime, context: Context) {
	const conversation = await runtime.conversation(runtime.conversationId, context);
	if (!conversation) throw new Error("Conversation unavailable");
	return conversation;
}

async function submissionOutcome(
	settled: SettledSubmissionRecord | undefined,
	runtime: Runtime,
	context: Context,
): Promise<TaskOutcome<string>> {
	if (settled?.status === "done" && settled.type === "input") {
		const answer = await runtime.entry(AssistantEntry, settled.answer, context);
		const text = (answer?.model ?? [])
			.flatMap((message) => (message.role === "assistant" ? message.content : []))
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n");
		return Buffer.byteLength(text) > OUTPUT_BYTES
			? { status: "failed", error: { message: "Answer exceeds result limit" } }
			: { status: "completed", result: text };
	}
	return settled?.status === "unanswered" && settled.reason === "aborted"
		? { status: "aborted" }
		: { status: "failed", error: { message: "Execution did not produce an answer" } };
}

/** Admission result: the message's task, new or bound earlier, or why there is none. */
export type Admission =
	| { readonly kind: "admitted"; readonly taskId: TaskId<string> }
	| { readonly kind: "busy" }
	| { readonly kind: "conflict" };

/**
 * Bind `messageId` to a new task in one commit, or return the task it is already bound to. Refuses other text under a
 * bound message ID, and a new message while the conversation is working.
 */
export function admitMessage(conversation: Conversation, input: A2ATaskInput, context: Context): Promise<Admission> {
	return conversation.commit(async (tx): Promise<Admission> => {
		const binding = await tx.doc(A2ABinding, conversation.id, input.messageId, null);
		if (binding.taskId !== undefined) {
			return binding.hash === input.hash ? { kind: "admitted", taskId: binding.taskId } : { kind: "conflict" };
		}
		const last = await tx.doc(AdmissionDoc, conversation.id);
		const active = last.active === undefined ? undefined : await tx.task(last.active);
		if (active) storedA2ATask(active);
		const live = await tx.doc(LiveDoc, conversation.id);
		const inbox = await tx.doc(InboxDoc, conversation.id);
		if ((active && active.state.status !== "terminal") || live.run || inbox.items.length > 0) {
			return { kind: "busy" };
		}
		// A background task: a conversation abort or idle wait must not include the task that is waiting on its input.
		const taskId = await tx.createTask(A2ATask, input, { ownership: { kind: "conversation" }, background: true });
		binding.taskId = taskId;
		binding.hash = input.hash;
		last.active = taskId;
		return { kind: "admitted", taskId };
	}, context);
}

/**
 * Narrow a stored `a2a.task` record to version 1. Refuses other versions without interpreting them: a newer layout is
 * not this code's to read.
 */
export function storedA2ATask(record: TaskRecord<unknown, unknown, unknown>): A2ATaskRecord {
	if (record.version !== 1) throw new UnsupportedTaskVersion();
	// The kind and version identify the stored layout; Durable stores input and checkpoint as plain JSON.
	return record as A2ATaskRecord;
}

/** The record as an A2A task of this conversation, or `undefined` when it is none. */
export function a2aTaskOf(
	record: TaskRecord<unknown, unknown, unknown> | undefined,
	conversationId: ConversationId,
): A2ATaskRecord | undefined {
	return record?.kind === "a2a.task" && record.conversationId === conversationId ? storedA2ATask(record) : undefined;
}

/** The Durable task ID an A2A task ID names, or `undefined` for anything but a canonical positive integer. */
export function durableTaskId(id: string): TaskId<string> | undefined {
	const value = Number(id);
	// Task IDs are canonical decimal strings of Durable's numeric IDs.
	return Number.isSafeInteger(value) && value > 0 && String(value) === id ? (value as TaskId<string>) : undefined;
}

/** A stored `a2a.task` of a version this code does not read. */
export class UnsupportedTaskVersion extends Error {
	constructor() {
		super("Unsupported stored A2A task version");
		this.name = "UnsupportedTaskVersion";
	}
}
