// Diagnostic, not a conformance test: reproduces the known cancellation hazard with real Durable tasks. A2A
// cancellation that reaches a placed submission aborts conversation-wide, which can stop a newer, unrelated host run.
// Uses no HTTP, credentials or network. Exits successfully when the limitation reproduces: `npm run probe`.
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	type Conversation,
	type ConversationHandle,
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	MemoryStorage,
	type Submission,
	type SubmissionDraft,
} from "@earendil-works/pi-durable";
import { A2ATask, type A2ATaskCheckpoint, type A2ATaskInput } from "../src/task.ts";

function gate(text: string) {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const response: FauxResponseFactory = async (_transcript, options) => {
		const onAbort = () => released.resolve();
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		if (options?.signal?.aborted) onAbort();
		started.resolve();
		try {
			await released.promise;
			return fauxAssistantMessage(text);
		} finally {
			options?.signal?.removeEventListener("abort", onAbort);
		}
	};
	return { started: started.promise, release: () => released.resolve(), response };
}

const first = gate("A2A answer");
const next = gate("Independent host answer");
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([first.response, next.response]);
let conversation: Conversation;
let hostSubmission: Submission | undefined;

/** `target` with some members replaced; the rest stay bound to `target`, as Durable's handles expect. */
function override<T extends object>(target: T, members: Partial<T>): T {
	return new Proxy(target, {
		get(object, key) {
			if (Object.hasOwn(members, key)) return members[key as keyof T];
			const value = Reflect.get(object, key, object);
			return typeof value === "function" ? value.bind(object) : value;
		},
	});
}

// The real abort handler, with one pause: between the submission check and the conversation-wide abort, the A2A input
// settles and an independent host input starts a new run.
const probeTask = defineTask<A2ATaskInput, A2ATaskCheckpoint, string>({
	...A2ATask.definition,
	async abort(task, runtime, ctx) {
		const handle = await runtime.conversation(runtime.conversationId, ctx);
		assert.ok(handle);
		const submitDraft = (draft: SubmissionDraft, submitContext: typeof context) =>
			handle.submit(draft, submitContext);
		// `submit` is overloaded; the abort handler calls only its (draft, context) form.
		const paused = override(handle, {
			submit: (async (draft: SubmissionDraft, submitContext: typeof context) => {
				const submission = await submitDraft(draft, submitContext);
				return override(submission, {
					async abort(abortContext) {
						const result = await submission.abort(abortContext);
						assert.equal(result, "already_placed");
						first.release();
						assert.equal((await submission.wait(abortContext)).status, "done");
						await conversation.waitForIdle(context);
						hostSubmission = await conversation.submit(
							{ type: "input", content: "Independent host input" },
							context,
						);
						await next.started;
						return result;
					},
				});
			}) as ConversationHandle["submit"],
		});
		await A2ATask.definition.abort(task, override(runtime, { conversation: async () => paused }), ctx);
	},
});

const registry = createRegistry();
registry.install(defineExtension({ name: "a2a-scope-probe", tasks: [probeTask] }));
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const timeout = setTimeout(() => {
	console.error("Scope probe timed out");
	process.exit(1);
}, 10_000);
try {
	const model = faux.getModel();
	conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
	const id = await conversation.commit(
		(tx) =>
			tx.createTask(
				A2ATask,
				{ messageId: "scope-probe", text: "A2A input", hash: "diagnostic", acceptedAt: Date.now() },
				{ ownership: { kind: "conversation" }, background: true },
			),
		context,
	);
	harness.resume();
	await first.started;
	await harness.abortTask(id, context);
	const task = await harness.waitForTask(id, context);
	assert.ok(hostSubmission, "The host input was submitted during the abort");
	const host = await hostSubmission.wait(context);
	// The documented limitation, not the desired behavior: the independent host input should finish.
	assert.equal(task.state.outcome.status, "completed");
	assert.equal(task.state.outcome.result, "A2A answer");
	assert.equal(host.status, "unanswered");
	assert.equal(host.reason, "aborted");
	console.log(
		JSON.stringify(
			{
				a2aSubmissionBeforeHandoff: "done",
				hostSubmission: { status: host.status, reason: host.reason },
				a2aTask: task.state.outcome.status,
				outcomeReporting: "The completed A2A answer is kept despite the late cancellation.",
				conclusion: "Confirmed: A2A cancellation aborts an unrelated host run after a handoff.",
			},
			null,
			2,
		),
	);
} finally {
	clearTimeout(timeout);
	first.release();
	next.release();
	await harness.close(context);
}
