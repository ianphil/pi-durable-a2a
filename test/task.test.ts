// The Durable task: stored format, crash recovery, cancellation outcomes, and stored versions.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CancelTaskRequest,
	GetTaskRequest,
	ListTasksRequest,
	SendMessageRequest,
	type Task,
	TaskState,
} from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	Harness,
	LiveDoc,
	MemoryStorage,
	type Storage,
	type TaskId,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { A2ABinding, A2AExtension, A2ATask, type A2ATaskCheckpoint, type A2ATaskInput } from "pi-durable-a2a";
import { describe, expect, test } from "vitest";
import { context, gate, type Host, openHost, send, withAgent } from "./support.ts";

const call = () => new ServerCallContext();
const taskId = (task: Task) => Number(task.id) as TaskId<string>;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

// The admission document by its stored name, as a reader of the stored format sees it.
const StoredAdmission = defineDoc<{ active?: TaskId<string> }>({
	kind: "a2a.admission",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => true,
});

async function withStore(use: (path: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-durable-a2a-storage-"));
	try {
		await use(join(dir, "durable.sqlite"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Storage that fails every operation after `kill()`, as when the process loses its store; no clean close happens. */
function killable(inner: Storage): { storage: Storage; kill(): void } {
	let dead = false;
	const storage = new Proxy(inner, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) =>
				dead && property !== "close"
					? Promise.reject(new Error("Injected storage loss"))
					: value.apply(target, args);
		},
	});
	return {
		storage,
		kill() {
			dead = true;
		},
	};
}

/** Terminal `a2a.task` records as they commit, across hosts. */
function observeTerminals(host: Host, terminals: unknown[]): Host {
	host.harness.observeCommits({
		advance(publication) {
			for (const change of publication.changes) {
				if (
					change.type === "task" &&
					change.value.kind === "a2a.task" &&
					change.value.state.status === "terminal"
				) {
					terminals.push(change.value);
				}
			}
		},
		end() {},
	});
	return host;
}

/** Exactly one task, binding, submission and user entry for the message. */
async function expectSingleAdmission(host: Host, id: TaskId<string>, messageId: string) {
	const tasks = await host.harness.commit((tx) => tx.scanTasks({ kind: "a2a.task" }, 100), context);
	expect(tasks.items.map((task) => task.id)).toEqual([id]);
	expect((await host.harness.snapshot(A2ABinding, host.conversation.id, messageId, context))?.taskId).toBe(id);
	const submission = await host.harness.commit(
		(tx) => tx.submissionByRequest(host.conversation.id, `a2a.task:${id}`),
		context,
	);
	expect(submission).toBeDefined();
	const entries = await host.conversation.entries({}, 100, undefined, context);
	expect(entries.items.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
}

describe("stored format", () => {
	test("version-1 names, layouts and submission keys", async () => {
		await withStore(async (path) => {
			const faux = fauxProvider();
			faux.setResponses([fauxAssistantMessage("Answer")]);
			const storage = await openNodeSqliteStorage(path);
			const host = await openHost(storage, faux);
			try {
				const request = SendMessageRequest.fromJSON({
					message: { messageId: "contract", role: "ROLE_USER", parts: [{ text: "Hi" }, { text: "there" }] },
				});
				const task = await host.handler.sendMessage(request, call());
				expect(task.contextId).toBe(String(host.conversation.id));
				const record = await storage.task(taskId(task), context);
				expect(record).toMatchObject({
					kind: "a2a.task",
					version: 1,
					input: { messageId: "contract", text: "Hi\nthere", hash: hash("Hi\nthere") },
					state: { status: "terminal", outcome: { status: "completed", result: "Answer" } },
				});
				const submission = await storage.submissionByRequest(host.conversation.id, `a2a.task:${task.id}`, context);
				expect(submission?.notify).toEqual({ taskId: record?.id, key: "answer" });
				const docs = await storage.scanDocuments(
					{ scope: { kind: "conversation", conversationId: host.conversation.id }, at: "current" },
					100,
					undefined,
					context,
				);
				const binding = docs.items.find((item) => item.kind === "a2a.message");
				const admission = docs.items.find((item) => item.kind === "a2a.admission");
				for (const doc of [binding, admission]) expect(doc).toMatchObject({ history: "latest", fork: "initial" });
				expect(binding?.key).toBe("contract");
				expect(await storage.document(binding!.id, "current", context)).toMatchObject({
					version: 1,
					value: { taskId: record?.id, hash: hash("Hi\nthere") },
				});
				expect(await storage.document(admission!.id, "current", context)).toMatchObject({
					version: 1,
					value: { active: record?.id },
				});
			} finally {
				await host.close();
			}
		});
	});

	test("reads and admission refuse other task versions without rewriting them", async () => {
		await withStore(async (path) => {
			const faux = fauxProvider();
			const future = defineTask<A2ATaskInput, A2ATaskCheckpoint, string>({ ...A2ATask.definition, version: 2 });
			const host = await openHost(await openNodeSqliteStorage(path), faux);
			try {
				const id = await host.conversation.commit(async (tx) => {
					const binding = await tx.doc(A2ABinding, host.conversation.id, "future", null);
					const admission = await tx.doc(StoredAdmission, host.conversation.id);
					const created = await tx.createTask(
						future,
						{ messageId: "future", text: "Hello", hash: hash("Hello"), acceptedAt: Date.now() },
						{ ownership: { kind: "conversation" }, background: true },
					);
					binding.taskId = created;
					binding.hash = hash("Hello");
					admission.active = created;
					return created;
				}, context);
				const before = await host.harness.getTask(id, context);
				const refusals = [
					host.handler.getTask(GetTaskRequest.fromJSON({ id: String(id) }), call()),
					host.handler.listTasks(ListTasksRequest.fromJSON({}), call()),
					// Filters that would exclude the task still check its version before reading its state.
					host.handler.listTasks(ListTasksRequest.fromJSON({ status: "TASK_STATE_COMPLETED" }), call()),
					host.handler.listTasks(
						ListTasksRequest.fromJSON({ statusTimestampAfter: "9999-01-01T00:00:00.000Z" }),
						call(),
					),
					host.handler.sendMessage(send("future", "Hello"), call()),
					host.handler.sendMessage(send("new-message", "Hello"), call()),
				];
				for (const refusal of refusals) await expect(refusal).rejects.toThrow(/Unsupported stored/);
				expect(
					await host.harness.snapshot(A2ABinding, host.conversation.id, "new-message", context),
				).toBeUndefined();
				expect(await host.harness.getTask(id, context)).toEqual(before);
			} finally {
				await host.close();
			}
		});
	});

	test("admission refuses a terminal task of another version without replacing it", async () => {
		await withStore(async (path) => {
			const faux = fauxProvider();
			const future = defineTask<A2ATaskInput, A2ATaskCheckpoint, string>({
				...A2ATask.definition,
				version: 2,
				phases: {
					...A2ATask.definition.phases,
					submit: (_task, runtime, ctx) =>
						runtime.commit(
							() => ({ status: "terminal", outcome: { status: "completed", result: "Future" } }),
							ctx,
						),
				},
			});
			let host = await openHost(await openNodeSqliteStorage(path), faux);
			host.registry.install(defineExtension({ name: "a2a", tasks: [future] }));
			try {
				const id = await host.conversation.commit(async (tx) => {
					const admission = await tx.doc(StoredAdmission, host.conversation.id);
					const created = await tx.createTask(
						future,
						{ messageId: "completed-future", text: "Hello", hash: hash("Hello"), acceptedAt: Date.now() },
						{ ownership: { kind: "conversation" }, background: true },
					);
					admission.active = created;
					return created;
				}, context);
				await host.harness.waitForTask(id, context);
				await host.close();
				host = await openHost(await openNodeSqliteStorage(path), faux); // Version-1 definitions only.
				const before = await host.harness.getTask(id, context);
				expect(before).toMatchObject({ version: 2, state: { status: "terminal" } });
				await expect(host.handler.sendMessage(send("after-future", "Hello"), call())).rejects.toThrow(
					/Unsupported stored/,
				);
				expect((await host.harness.snapshot(StoredAdmission, host.conversation.id, context))?.active).toBe(id);
				expect(await host.harness.getTask(id, context)).toEqual(before);
			} finally {
				await host.close();
			}
		});
	});
});

describe("recovery", () => {
	test("storage loss during a model request recovers one task and one admission", async () => {
		await withStore(async (path) => {
			const faux = fauxProvider();
			const model = gate("Must not commit before loss");
			faux.setResponses([model.response]);
			const terminals: unknown[] = [];
			const crashing = killable(await openNodeSqliteStorage(path));
			let host = observeTerminals(await openHost(crashing.storage, faux, { maxRetries: 1 }), terminals);
			try {
				const pending = await host.handler.sendMessage(
					send("crash-model", "Hello", { returnImmediately: true }),
					call(),
				);
				await model.started;
				const id = taskId(pending);
				const record = await host.harness.getTask(id, context);
				expect(record?.state).toMatchObject({ status: "sleeping", checkpoint: { phase: "answer" } });
				crashing.kill();
				const stopped = host.handler.close(); // Release request resources only after the store is gone.
				await expect(host.harness.commit((tx) => tx.scanTasks({ kind: "a2a.task" }, 1), context)).rejects.toThrow();
				expect((await host.harness.closed).kind).toBe("failed");
				await stopped;
				expect(terminals).toHaveLength(0);

				faux.setResponses([fauxAssistantMessage("Recovered answer")]);
				host = observeTerminals(
					await openHost(await openNodeSqliteStorage(path), faux, { maxRetries: 1 }),
					terminals,
				);
				await host.harness.waitForTask(id, context);
				const recovered = await host.handler.getTask(GetTaskRequest.fromJSON({ id: pending.id }), call());
				expect(recovered.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
				expect(JSON.stringify(recovered.status)).toMatch(/Recovered answer/);
				expect(faux.state.callCount).toBe(2); // Durable retries the interrupted model attempt.
				expect(terminals).toHaveLength(1);
				await expectSingleAdmission(host, id, "crash-model");
				expect(await host.handler.sendMessage(send("crash-model", "Hello"), call())).toEqual(recovered);

				await host.close();
				host = observeTerminals(await openHost(await openNodeSqliteStorage(path), faux), terminals);
				expect(await host.handler.getTask(GetTaskRequest.fromJSON({ id: pending.id }), call())).toEqual(recovered);
				expect(terminals).toHaveLength(1); // Another reopen does not settle the task again.
			} finally {
				model.release();
				await host.close();
			}
		});
	});

	test("storage loss during cancellation resumes cleanup and stays canceled", async () => {
		await withStore(async (path) => {
			const faux = fauxProvider();
			const inner = await openNodeSqliteStorage(path);
			const crashing = killable(inner);
			const interrupted = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			const started = Promise.withResolvers<void>();
			// The store is lost exactly when the run's abort reaches the model request.
			faux.setResponses([
				async (_transcript, options) => {
					options?.signal?.addEventListener("abort", () => {
						crashing.kill();
						interrupted.resolve();
					});
					started.resolve();
					await released.promise;
					return fauxAssistantMessage("Must not become an answer");
				},
			]);
			const terminals: unknown[] = [];
			let host = observeTerminals(await openHost(crashing.storage, faux, { maxRetries: 1 }), terminals);
			let cancel: Promise<Task> | undefined;
			try {
				const pending = await host.handler.sendMessage(
					send("crash-cancel", "Hello", { returnImmediately: true }),
					call(),
				);
				await started.promise;
				const id = taskId(pending);
				const live = await host.harness.snapshot(LiveDoc, host.conversation.id, context);
				cancel = host.handler.cancelTask(CancelTaskRequest.fromJSON({ id: pending.id }), call());
				cancel.catch(() => {});
				await interrupted.promise; // The abort mark is committed; cleanup cannot finish.
				expect((await inner.task(id, context))?.abortRequested).toBe(true);
				expect((await inner.task(live!.run!.taskId, context))?.abortRequested).toBe(true);
				const stopped = host.handler.close();
				released.resolve();
				expect((await host.harness.closed).kind).toBe("failed");
				await expect(cancel).rejects.toThrow();
				await stopped;
				expect(terminals).toHaveLength(0);

				host = observeTerminals(await openHost(await openNodeSqliteStorage(path), faux), terminals);
				await host.harness.waitForTask(id, context);
				const canceled = await host.handler.getTask(GetTaskRequest.fromJSON({ id: pending.id }), call());
				expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
				expect(faux.state.callCount).toBe(1); // An abort-marked run requests no other answer.
				expect(terminals).toHaveLength(1);
				await expectSingleAdmission(host, id, "crash-cancel");
				expect(await host.handler.sendMessage(send("crash-cancel", "Hello"), call())).toEqual(canceled);
				await host.close();
				host = observeTerminals(await openHost(await openNodeSqliteStorage(path), faux), terminals);
				expect(await host.handler.cancelTask(CancelTaskRequest.fromJSON({ id: pending.id }), call())).toEqual(
					canceled,
				);
				expect(terminals).toHaveLength(1);
			} finally {
				released.resolve();
				if (cancel) await Promise.allSettled([cancel]);
				await host.close();
			}
		});
	});
});

describe("cancellation", () => {
	test("aborting before the submit phase creates no input", async () => {
		const registry = createRegistry();
		registry.install(A2AExtension);
		const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
		try {
			const conversation = await harness.root(context);
			const id = await conversation.commit(
				(tx) =>
					tx.createTask(
						A2ATask,
						{ messageId: "not-submitted", text: "Never run", hash: "hash", acceptedAt: Date.now() },
						{ ownership: { kind: "conversation" }, background: true },
					),
				context,
			);
			// The Harness is not resumed: the abort is marked before any invocation.
			expect((await harness.getTask(id, context))?.state.status).toBe("pending");
			await harness.abortTask(id, context);
			expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("aborted");
			const entries = await conversation.entries({}, 100, undefined, context);
			expect(entries.items.every((entry) => entry.kind !== "pi.user")).toBe(true);
			expect((await harness.inspect(context)).submissions).toHaveLength(0);
		} finally {
			await harness.close(context);
		}
	});

	const lateCases = [
		{
			name: "completed answer",
			response: fauxAssistantMessage("Already answered"),
			state: TaskState.TASK_STATE_COMPLETED,
			text: /Already answered/,
		},
		{
			name: "oversized answer",
			response: fauxAssistantMessage("x".repeat(65_537)),
			state: TaskState.TASK_STATE_FAILED,
			text: /Answer exceeds result limit/,
		},
		{
			name: "execution failure",
			response: fauxAssistantMessage("", { stopReason: "error", errorMessage: "PROVIDER_PRIVATE" }),
			state: TaskState.TASK_STATE_FAILED,
			text: /Execution did not produce an answer/,
		},
	];
	test.each(lateCases)("late cancellation keeps the settled outcome: $name", async (example) => {
		await withAgent(async (fixture) => {
			const answering = Promise.withResolvers<void>();
			// Hold the answer phase after the input settled; cancellation then signals it and runs the real abort.
			const held = defineTask<A2ATaskInput, A2ATaskCheckpoint, string>({
				...A2ATask.definition,
				phases: {
					...A2ATask.definition.phases,
					async answer(_task, runtime) {
						await new Promise<void>((resolve) => {
							if (runtime.signal.aborted) resolve();
							else runtime.signal.addEventListener("abort", () => resolve(), { once: true });
							answering.resolve();
						});
					},
				},
			});
			const agent = fixture.agent;
			agent.registry.install(defineExtension({ name: "a2a", tasks: [held] }));
			fixture.faux.setResponses([example.response]);
			const started = (await agent.client.sendMessage(
				send("late-cancel", "Hello", { returnImmediately: true }),
			)) as Task;
			await answering.promise;
			await expect(agent.client.cancelTask(CancelTaskRequest.fromJSON({ id: started.id }))).rejects.toThrow(
				/cancel/i,
			);
			const actual = await agent.client.getTask(GetTaskRequest.fromJSON({ id: started.id }));
			expect(actual.status?.state).toBe(example.state);
			expect(JSON.stringify(actual.status)).toMatch(example.text);
			expect(JSON.stringify(actual)).not.toMatch(/PROVIDER_PRIVATE/);
			const record = await agent.harness.getTask(taskId(started), context);
			expect(record?.abortRequested).toBe(true);
			expect(record?.state.outcome?.status).not.toBe("aborted");
			await expect(agent.client.cancelTask(CancelTaskRequest.fromJSON({ id: started.id }))).rejects.toThrow(
				/cancel/i,
			);
			expect(await agent.client.sendMessage(send("late-cancel", "Hello"))).toEqual(actual);
			const reopened = await fixture.reopen();
			expect(await reopened.client.getTask(GetTaskRequest.fromJSON({ id: started.id }))).toEqual(actual);
		});
	});
});

test.each(["failed", "faulted"] as const)("public snapshots hide a %s task's private diagnostic", async (status) => {
	await withAgent(async ({ agent }) => {
		const diagnostic = "PROVIDER_PRIVATE: internal execution detail";
		// A stored diagnostic that neither public failure path produces.
		const failing = defineTask<A2ATaskInput, A2ATaskCheckpoint, string>({
			...A2ATask.definition,
			phases: {
				...A2ATask.definition.phases,
				submit: (_task, runtime, ctx) =>
					runtime.commit(
						() => ({
							status: "terminal",
							outcome: { status, error: { message: diagnostic } },
						}),
						ctx,
					),
			},
		});
		agent.registry.install(defineExtension({ name: "a2a", tasks: [failing] }));
		const sent = (await agent.client.sendMessage(send("diagnostic", "Hello"))) as Task;
		const loaded = await agent.client.getTask(GetTaskRequest.fromJSON({ id: sent.id }));
		const listed = await agent.client.listTasks(ListTasksRequest.fromJSON({}));
		for (const snapshot of [sent, loaded, listed.tasks[0]]) {
			expect(snapshot.status?.state).toBe(TaskState.TASK_STATE_FAILED);
			expect(JSON.stringify(snapshot.status)).toMatch(/Execution unavailable/);
			expect(JSON.stringify(snapshot)).not.toMatch(/PROVIDER_PRIVATE|internal execution detail/);
		}
		const stored = (await agent.harness.getTask(taskId(sent), context)) as TaskRecord<unknown, unknown, string>;
		expect(stored.state.outcome).toMatchObject({ error: { message: diagnostic } });
	});
});
