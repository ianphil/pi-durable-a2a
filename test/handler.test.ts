// A2AHandler through the SDK client: admission, retries, waiting, listing, cancellation, and close.
import { readdir } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { CancelTaskRequest, GetTaskRequest, ListTasksRequest, type Task, TaskState } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, type TaskId } from "@earendil-works/pi-durable";
import { A2ABinding, A2AExtension, A2AHandler, A2ATask } from "pi-durable-a2a";
import { describe, expect, test, vi } from "vitest";
import { context, gate, send, withAgent } from "./support.ts";

const call = () => new ServerCallContext();
const taskId = (task: Task) => Number(task.id) as TaskId<string>;

describe("serving", () => {
	test("serves a Durable conversation through the SDK across restarts", { timeout: 30_000 }, async () => {
		await withAgent(async (fixture) => {
			const { faux } = fixture;
			let agent = fixture.agent;
			expect((await fetch(`${agent.base}/.well-known/agent-card.json`)).status).toBe(401);
			expect((await fetch(`${agent.base}/health`)).status).toBe(200);

			faux.setResponses([fauxAssistantMessage("Persistent hello")]);
			const first = (await agent.client.sendMessage(send("message-one", "Hello"))) as Task;
			expect(first.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
			expect(JSON.stringify(first.status)).toMatch(/Persistent hello/);

			// The same message ID returns the same task; reusing it for other text is refused.
			expect(((await agent.client.sendMessage(send("message-one", "Hello"))) as Task).id).toBe(first.id);
			await expect(agent.client.sendMessage(send("message-one", "Changed"))).rejects.toThrow();
			await expect(
				agent.client.getTask(GetTaskRequest.fromJSON({ id: first.id, tenant: "foreign" })),
			).rejects.toThrow();
			await expect(agent.client.getTask(GetTaskRequest.fromJSON({ id: "missing" }))).rejects.toThrow();

			// A follow-up is another task in the same shared context and conversation.
			faux.setResponses([(transcript) => fauxAssistantMessage(`Seen ${transcript.messages.length} messages`)]);
			const second = (await agent.client.sendMessage(send("message-two", "Second"))) as Task;
			expect(second.contextId).toBe(first.contextId);
			expect(JSON.stringify(second.status)).toMatch(/Seen 3 messages/);
			const page = await agent.client.listTasks(ListTasksRequest.fromJSON({ pageSize: 1 }));
			expect(page.tasks).toHaveLength(1);
			expect(page.nextPageToken).toBeTruthy();

			// One run at a time: a second message while one is working is refused.
			const slow = gate("Slow answer");
			faux.setResponses([slow.response]);
			const working = (await agent.client.sendMessage(
				send("slow", "Slow work", { returnImmediately: true }),
			)) as Task;
			await slow.started;
			await expect(agent.client.sendMessage(send("busy", "Also now"))).rejects.toThrow(/busy/i);
			slow.release();
			await agent.harness.waitForTask(taskId(working), context);

			// Cancellation reports canceled once Durable settles; a finished task cannot be canceled.
			await expect(agent.client.cancelTask(CancelTaskRequest.fromJSON({ id: first.id }))).rejects.toThrow();
			const late = gate("Late answer");
			faux.setResponses([late.response]);
			const started = (await agent.client.sendMessage(
				send("cancel-me", "Slow work", { returnImmediately: true }),
			)) as Task;
			await late.started;
			const canceled = await agent.client.cancelTask(CancelTaskRequest.fromJSON({ id: started.id }));
			expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);

			// A disconnected caller stops waiting, not the work; resending the message ID finds the result.
			const survivor = gate("Survived disconnect");
			faux.setResponses([survivor.response]);
			const controller = new AbortController();
			const waiting = agent.client.sendMessage(send("disconnect", "Continue without caller"), {
				signal: controller.signal,
			});
			await survivor.started;
			controller.abort();
			await expect(waiting).rejects.toThrow();
			survivor.release();
			const lookup = (await agent.client.sendMessage(send("disconnect", "Continue without caller"))) as Task;
			expect(lookup.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
			expect(JSON.stringify(lookup.status)).toMatch(/Survived disconnect/);

			// Work accepted before a restart continues afterwards and stays readable.
			const interrupted = gate("Interrupted");
			faux.setResponses([interrupted.response]);
			const pending = (await agent.client.sendMessage(
				send("restart", "Work across restart", { returnImmediately: true }),
			)) as Task;
			await interrupted.started;
			faux.setResponses([fauxAssistantMessage("Recovered")]);
			agent = await fixture.reopen();
			await agent.harness.waitForTask(taskId(pending), context);
			const recovered = await agent.client.getTask(GetTaskRequest.fromJSON({ id: pending.id }));
			expect(recovered.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
			expect(JSON.stringify(recovered.status)).toMatch(/Recovered/);
			const restored = await agent.client.getTask(GetTaskRequest.fromJSON({ id: first.id }));
			expect(JSON.stringify(restored.status)).toMatch(/Persistent hello/);

			// A failed model request fails the task without exposing the provider's error text.
			faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "PROVIDER_PRIVATE" })]);
			const failed = (await agent.client.sendMessage(send("failure", "Fail please"))) as Task;
			expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED);
			expect(JSON.stringify(failed.status)).not.toMatch(/PROVIDER_PRIVATE/);
		});
	});

	test("stores only Durable tasks and documents", async () => {
		await withAgent(async ({ dir, faux, agent }) => {
			faux.setResponses([fauxAssistantMessage("Stored answer")]);
			const task = (await agent.client.sendMessage(send("__proto__", "Hello"))) as Task;
			const record = await agent.harness.getTask(taskId(task), context);
			expect(record?.kind).toBe("a2a.task");
			expect(record?.state).toMatchObject({ status: "terminal", outcome: { result: "Stored answer" } });
			const binding = await agent.harness.snapshot(A2ABinding, agent.conversation.id, "__proto__", context);
			expect(binding?.taskId).toBe(record?.id);
			expect(task.contextId).toBe(String(agent.conversation.id));

			// Other tasks of the conversation, and IDs that are not canonical task IDs, are not A2A tasks.
			const all = await agent.harness.commit(
				(tx) => tx.scanTasks({ conversationId: agent.conversation.id }, 100),
				context,
			);
			const generation = all.items.find((item) => item.kind === "pi.generation");
			expect(generation).toBeDefined();
			for (const id of [String(generation?.id), "1 OR 1=1", "01"]) {
				await expect(agent.client.getTask(GetTaskRequest.fromJSON({ id }))).rejects.toThrow(/not found/i);
			}
			expect((await readdir(dir)).every((name) => /^durable\.sqlite(?:-wal|-shm)?$/.test(name))).toBe(true);
		});
	});

	test("rolls back task and binding together and serializes concurrent admission", async () => {
		await withAgent(async ({ faux, agent }) => {
			await expect(
				agent.conversation.commit(async (tx) => {
					const binding = await tx.doc(A2ABinding, agent.conversation.id, "rollback", null);
					binding.taskId = await tx.createTask(
						A2ATask,
						{ messageId: "rollback", text: "Not accepted", hash: "hash", acceptedAt: Date.now() },
						{ ownership: { kind: "conversation" }, background: true },
					);
					throw new Error("rollback");
				}, context),
			).rejects.toThrow(/rollback/);
			expect(await agent.harness.snapshot(A2ABinding, agent.conversation.id, "rollback", context)).toBeUndefined();
			const scan = async () =>
				(await agent.harness.commit((tx) => tx.scanTasks({ kind: "a2a.task" }, 100), context)).items;
			expect(await scan()).toHaveLength(0);

			const duplicateGate = gate("Only one run");
			faux.setResponses([duplicateGate.response]);
			const duplicates = (await Promise.all(
				Array.from({ length: 5 }, () =>
					agent.client.sendMessage(send("same-id", "Same text", { returnImmediately: true })),
				),
			)) as Task[];
			expect(new Set(duplicates.map((task) => task.id)).size).toBe(1);
			duplicateGate.release();
			await agent.harness.waitForTask(taskId(duplicates[0]), context);
			expect(await scan()).toHaveLength(1);

			const competingGate = gate("Winner");
			faux.setResponses([competingGate.response]);
			const competing = await Promise.allSettled(
				["one", "two"].map((id) => agent.client.sendMessage(send(id, id, { returnImmediately: true }))),
			);
			const winners = competing.filter((result) => result.status === "fulfilled");
			const losers = competing.filter((result) => result.status === "rejected");
			expect(winners).toHaveLength(1);
			expect(String(losers[0]?.reason)).toMatch(/busy/i);
			competingGate.release();
			await agent.harness.waitForTask(taskId(winners[0].value as Task), context);
			expect(await scan()).toHaveLength(2);
		});
	});

	test("translates working state, history and filtered cursor pagination", async () => {
		await withAgent(async ({ faux, agent }) => {
			const working = gate("Working answer");
			faux.setResponses([working.response]);
			const started = (await agent.client.sendMessage(send("working", "Work", { returnImmediately: true }))) as Task;
			// The model cannot start before submission and parking commit together; no sleeping state can be missed.
			await working.started;
			const read = await agent.client.getTask(GetTaskRequest.fromJSON({ id: started.id }));
			expect(read.status?.state).toBe(TaskState.TASK_STATE_WORKING);
			const record = await agent.harness.getTask(taskId(started), context);
			expect(record?.state).toMatchObject({ status: "sleeping", signals: [{ signal: "pi.submission-settled" }] });
			working.release();
			await agent.harness.waitForTask(taskId(started), context);

			faux.setResponses([fauxAssistantMessage("Second answer")]);
			const second = (await agent.client.sendMessage(send("second", "Second"))) as Task;
			faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "PRIVATE" })]);
			await agent.client.sendMessage(send("failed", "Fail"));
			const ids: string[] = [];
			let pageToken: string | undefined;
			do {
				const page = await agent.client.listTasks(
					ListTasksRequest.fromJSON({ pageSize: 1, pageToken, status: "TASK_STATE_COMPLETED", historyLength: 1 }),
				);
				expect(page.totalSize).toBe(2);
				expect(page.tasks[0].history).toHaveLength(1);
				ids.push(page.tasks[0].id);
				pageToken = page.nextPageToken;
			} while (pageToken);
			expect(ids).toEqual([second.id, started.id]);
			const noHistory = await agent.client.getTask(GetTaskRequest.fromJSON({ id: second.id, historyLength: 0 }));
			expect(noHistory.history).toHaveLength(0);
			const full = await agent.client.getTask(GetTaskRequest.fromJSON({ id: second.id }));
			expect(full.history).toHaveLength(2);
			for (const pageToken of ["invalid", Buffer.from("null").toString("base64url")]) {
				await expect(agent.client.listTasks(ListTasksRequest.fromJSON({ pageToken }))).rejects.toThrow(
					/Invalid page token/,
				);
			}
		});
	});

	test("retries honor blocking and history options without another task", async () => {
		await withAgent(async ({ faux, agent }) => {
			const answer = gate("One answer");
			faux.setResponses([answer.response]);
			const first = (await agent.client.sendMessage(send("retry", "Hello", { returnImmediately: true }))) as Task;
			await answer.started;
			const wait = vi.spyOn(agent.harness, "waitForTask");
			let settled = false;
			const retry = agent.handler.sendMessage(send("retry", "Hello", { historyLength: 1 }), call());
			retry.finally(() => {
				settled = true;
			});
			await vi.waitFor(() => expect(wait).toHaveBeenCalled());
			await nextTurn();
			expect(settled).toBe(false);
			const immediate = (await agent.client.sendMessage(
				send("retry", "Hello", { returnImmediately: true, historyLength: 0 }),
			)) as Task;
			expect(immediate.id).toBe(first.id);
			expect(immediate.status?.state).toBe(TaskState.TASK_STATE_WORKING);
			expect(immediate.history).toHaveLength(0);

			answer.release();
			const completed = await retry;
			expect(completed.id).toBe(first.id);
			expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
			expect(completed.history).toHaveLength(1);
			expect(JSON.stringify(completed.history)).toMatch(/One answer/);
			const full = await agent.client.getTask(GetTaskRequest.fromJSON({ id: first.id }));
			expect(full.history).toHaveLength(2);
			const tasks = await agent.harness.commit((tx) => tx.scanTasks({ kind: "a2a.task" }, 100), context);
			expect(tasks.items).toHaveLength(1);
		});
	});

	test("listing that only scans makes no storage commits", async () => {
		const storage = new MemoryStorage();
		const commit = vi.spyOn(storage, "commit");
		const registry = createRegistry();
		registry.install(A2AExtension);
		const harness = await Harness.open(storage, { models: createModels(), registry }, context);
		const conversation = await harness.root(context);
		const handler = new A2AHandler({
			harness,
			conversation,
			card: { name: "fixture", description: "Listing", url: "http://localhost/a2a", skills: [] },
		});
		try {
			const before = commit.mock.calls.length;
			for (let i = 0; i < 3; i += 1) {
				const page = await handler.listTasks(ListTasksRequest.fromJSON({ pageSize: 1 }), call());
				expect(page).toMatchObject({ tasks: [], totalSize: 0 });
			}
			expect(commit.mock.calls.length).toBe(before);
		} finally {
			await handler.close();
			await harness.close(context);
		}
	});
});

describe("cancellation", () => {
	test("cancels recovered work and keeps the canceled result", async () => {
		await withAgent(async (fixture) => {
			const original = gate("Interrupted");
			const recovered = gate("Must not complete");
			fixture.faux.setResponses([original.response]);
			const pending = (await fixture.agent.client.sendMessage(
				send("restart-cancel", "Work", { returnImmediately: true }),
			)) as Task;
			await original.started;
			fixture.faux.setResponses([recovered.response]);
			const agent = await fixture.reopen(); // Closing aborts the first model request; it never answers.
			await original.aborted;
			await recovered.started;
			const duplicate = (await agent.client.sendMessage(
				send("restart-cancel", "Work", { returnImmediately: true }),
			)) as Task;
			expect(duplicate.id).toBe(pending.id);
			expect(duplicate.status?.state).toBe(TaskState.TASK_STATE_WORKING);
			const canceled = await agent.client.cancelTask(CancelTaskRequest.fromJSON({ id: pending.id }));
			await recovered.aborted;
			expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
			await agent.conversation.waitForIdle(context);
			const reopened = await fixture.reopen();
			expect(await reopened.client.getTask(GetTaskRequest.fromJSON({ id: pending.id }))).toEqual(canceled);
			expect(await reopened.client.cancelTask(CancelTaskRequest.fromJSON({ id: pending.id }))).toEqual(canceled);
		});
	});
});

describe("close", () => {
	test("stops a blocking send's wait, not its Durable work, and refuses later requests", async () => {
		await withAgent(async ({ faux, agent }) => {
			const answer = gate("Work survives close");
			faux.setResponses([answer.response]);
			const wait = vi.spyOn(agent.harness, "waitForTask");
			const sent = agent.handler.sendMessage(send("close-send", "Hello"), call());
			const refused = expect(sent).rejects.toThrow(/stopping/i);
			await answer.started;
			await vi.waitFor(() => expect(wait).toHaveBeenCalled());
			await agent.handler.close();
			await refused;
			const binding = await agent.harness.snapshot(A2ABinding, agent.conversation.id, "close-send", context);
			const id = binding?.taskId as TaskId<string>;
			expect(await agent.harness.getTask(id, context)).toMatchObject({
				abortRequested: false,
				state: { status: "sleeping" },
			});
			await expect(agent.handler.sendMessage(send("after-close", "Hello"), call())).rejects.toThrow(/stopping/i);
			answer.release();
			expect((await agent.harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
		});
	});

	test("joins accepted reads before resolving", async () => {
		for (const operation of ["getTask", "listTasks"] as const) {
			await withAgent(async ({ faux, agent }) => {
				faux.setResponses([fauxAssistantMessage("Stored")]);
				const task = (await agent.client.sendMessage(send("stored", "Hello"))) as Task;
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const original = agent.harness.commit.bind(agent.harness);
				const getTask = agent.harness.getTask.bind(agent.harness);
				const hold = async <T>(read: Promise<T>) => {
					const result = await read;
					entered.resolve();
					await release.promise;
					return result;
				};
				if (operation === "getTask")
					vi.spyOn(agent.harness, "getTask").mockImplementation((id, ctx) => hold(getTask(id, ctx)));
				else vi.spyOn(agent.harness, "commit").mockImplementation((change, ctx) => hold(original(change, ctx)));
				const read =
					operation === "getTask"
						? agent.handler.getTask(GetTaskRequest.fromJSON({ id: task.id }), call())
						: agent.handler.listTasks(ListTasksRequest.fromJSON({}), call());
				await entered.promise;
				let closed = false;
				const closing = agent.handler.close().then(() => {
					closed = true;
				});
				expect(agent.handler.close()).toBe(agent.handler.close());
				await nextTurn();
				expect(closed).toBe(false);
				release.resolve();
				await read;
				await closing;
				vi.restoreAllMocks();
			});
		}
	});

	test("joins a cancellation through its final read, under a usable Harness", async () => {
		await withAgent(async ({ faux, agent }) => {
			const answer = gate("Must be canceled");
			faux.setResponses([answer.response]);
			const started = (await agent.client.sendMessage(
				send("close-cancel", "Hello", { returnImmediately: true }),
			)) as Task;
			await answer.started;
			const reads = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			const getTask = agent.harness.getTask.bind(agent.harness);
			let count = 0;
			vi.spyOn(agent.harness, "getTask").mockImplementation(async (id, ctx) => {
				const record = await getTask(id, ctx);
				const index = count++;
				if (index < 2) {
					reads[index].resolve();
					await releases[index].promise;
				}
				return record;
			});
			const cancel = agent.handler.cancelTask(CancelTaskRequest.fromJSON({ id: started.id }), call());
			await reads[0].promise;
			let closed = false;
			const closing = agent.handler.close().then(() => {
				closed = true;
			});
			await nextTurn();
			expect(closed).toBe(false);
			await expect(agent.handler.cancelTask(CancelTaskRequest.fromJSON({ id: started.id }), call())).rejects.toThrow(
				/stopping/i,
			);
			releases[0].resolve();
			await reads[1].promise;
			await answer.aborted;
			await nextTurn();
			expect(closed).toBe(false);
			releases[1].resolve();
			expect((await cancel).status?.state).toBe(TaskState.TASK_STATE_CANCELED);
			await closing;
			expect((await getTask(taskId(started), context))?.state.outcome?.status).toBe("aborted");
			await expect(agent.handler.getTask(GetTaskRequest.fromJSON({ id: started.id }), call())).rejects.toThrow(
				/stopping/i,
			);
			vi.restoreAllMocks();
		});
	});
});
