// Read-only live checks of a deployed agent through the SDK client: no registration, deployment or credentials in
// output. Run with A2A_URL, A2A_TOKEN_FILE and A2A_SLOW_PROMPT set: `npm run smoke`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
	CancelTaskRequest,
	GetTaskRequest,
	ListTasksRequest,
	SendMessageRequest,
	type Task,
	TaskState,
} from "@a2a-js/sdk";
import { type Client, ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";

/** One passed check, or a cleanup that failed; never credentials or full answers. */
export type SmokeEvent = { readonly check: string } & Readonly<Record<string, unknown>>;

/** What the smoke asks of the agent and how it reports. */
export type SmokeOptions = {
	/** A read-only request slow enough to observe working and cancel a second run. */
	readonly slowPrompt: string;
	readonly pollMs?: number;
	readonly timeoutMs?: number;
	readonly report?: (event: SmokeEvent) => void | Promise<void>;
};

const TERMINAL: ReadonlySet<TaskState | undefined> = new Set([
	TaskState.TASK_STATE_COMPLETED,
	TaskState.TASK_STATE_CANCELED,
	TaskState.TASK_STATE_FAILED,
	TaskState.TASK_STATE_REJECTED,
]);

/** Run the checks in order; on failure, cancel only work this run started. */
export async function runGatewaySmoke(client: Client, options: SmokeOptions) {
	const {
		slowPrompt,
		pollMs = 250,
		timeoutMs = 300_000,
		report = (event) => console.log(JSON.stringify(event)),
	} = options;
	const prefix = `smoke-${randomUUID()}`;
	const marker = `${prefix}-marker`;
	const pending = new Set<string>();
	let contextId: string | undefined;
	const send = async (suffix: string, text: string, returnImmediately = false): Promise<Task> => {
		const result = await client.sendMessage(
			SendMessageRequest.fromJSON({
				message: { messageId: `${prefix}-${suffix}`, contextId, role: "ROLE_USER", parts: [{ text }] },
				configuration: { returnImmediately },
			}),
		);
		assert.ok("id" in result, "Expected a task, not a message");
		if (!TERMINAL.has(result.status?.state)) pending.add(result.id);
		return result;
	};
	const get = (id: string) => client.getTask(GetTaskRequest.fromJSON({ id }));
	const waitFor = async (id: string, state: TaskState) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const task = await get(id);
			if (task.status?.state === state) return task;
			assert.ok(!TERMINAL.has(task.status?.state), `Task ${id} ended before ${TaskState[state]}`);
			await delay(pollMs);
		}
		throw new Error(`Timed out waiting for task ${id} to reach ${TaskState[state]}`);
	};
	const slow = `Read-only integration check: do not change GitHub or any files, and do not read credentials. ${slowPrompt}`;
	try {
		const firstPrompt = `Read-only check. Do not use tools or write anything. Remember ${marker} and reply with only that marker.`;
		const first = await send("first", firstPrompt);
		contextId = first.contextId;
		assert.equal(first.status?.state, TaskState.TASK_STATE_COMPLETED);
		assert.ok(JSON.stringify(first.status).includes(marker), "First answer must contain the marker");
		assert.equal((await get(first.id)).id, first.id);
		await report({ check: "send/get", taskId: first.id, messageId: `${prefix}-first`, contextId });

		assert.equal((await send("first", firstPrompt)).id, first.id);
		await assert.rejects(send("first", `${firstPrompt} Changed text.`));
		await report({ check: "idempotency/conflicting-text", taskId: first.id });

		const followUp = await send(
			"follow-up",
			"Read-only follow-up. Do not use tools or write anything. What marker did I ask you to remember? Reply with only that marker.",
		);
		assert.equal(followUp.status?.state, TaskState.TASK_STATE_COMPLETED);
		assert.equal(followUp.contextId, contextId);
		assert.notEqual(followUp.id, first.id);
		assert.ok(JSON.stringify(followUp.status).includes(marker), "Follow-up must recall the earlier marker");
		await report({ check: "follow-up", taskId: followUp.id });

		const wanted = new Set([first.id, followUp.id]);
		const cursors = new Set<string>();
		let pageToken: string | undefined;
		let pages = 0;
		do {
			const page = await client.listTasks(ListTasksRequest.fromJSON({ contextId, pageSize: 1, pageToken }));
			assert.equal(page.tasks.length, 1, "One task per page");
			for (const task of page.tasks) wanted.delete(task.id);
			pages++;
			pageToken = page.nextPageToken;
			if (pageToken) {
				assert.ok(!cursors.has(pageToken), "Pagination must advance");
				cursors.add(pageToken);
			}
		} while (wanted.size > 0 && pageToken);
		assert.equal(wanted.size, 0, "Listing must contain both newly created tasks");
		assert.ok(pages >= 2, "Pagination must cross a page boundary");
		await report({ check: "paginated-list", pages });

		const started = await send("poll", slow, true);
		await report({ check: "started", taskId: started.id, messageId: `${prefix}-poll`, contextId });
		await waitFor(started.id, TaskState.TASK_STATE_WORKING);
		await assert.rejects(send("busy", "Read-only: reply with OK.", true), /busy/i);
		await report({ check: "working/busy", taskId: started.id });
		await waitFor(started.id, TaskState.TASK_STATE_COMPLETED);
		pending.delete(started.id);
		await report({ check: "polled-completed", taskId: started.id });

		const canceling = await send("cancel", slow, true);
		await waitFor(canceling.id, TaskState.TASK_STATE_WORKING);
		const canceled = await client.cancelTask(CancelTaskRequest.fromJSON({ id: canceling.id }));
		assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
		assert.equal((await get(canceling.id)).status?.state, TaskState.TASK_STATE_CANCELED);
		pending.delete(canceling.id);
		await report({ check: "canceled/stable-get", taskId: canceling.id });
		return { firstTaskId: first.id, contextId, messageId: `${prefix}-first`, firstPrompt };
	} finally {
		for (const id of pending) {
			try {
				if (!TERMINAL.has((await get(id)).status?.state))
					await client.cancelTask(CancelTaskRequest.fromJSON({ id }));
			} catch (error) {
				await report({ check: "cleanup-failed", taskId: id, error: (error as Error).message });
			}
		}
	}
}

/** A fetch that sends the key only to the configured origin, including SDK card endpoints, and never follows redirects. */
export function createSmokeFetch(url: string, token: string): typeof fetch {
	const origin = new URL(url).origin;
	return async (input, init) => {
		const target = input instanceof Request ? input.url : input;
		if (new URL(target).origin !== origin) throw new Error("Smoke requests must stay on the configured A2A origin");
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		headers.set("Authorization", `Bearer ${token}`);
		// Redirects happen inside fetch, past the origin check above: do not follow them.
		const response = await fetch(input, { ...init, headers, redirect: "manual" });
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			throw new Error("Smoke redirects are unsupported; use the canonical A2A URL");
		}
		return response;
	};
}

async function main() {
	const { A2A_URL: url, A2A_TOKEN_FILE: tokenFile, A2A_SLOW_PROMPT: slowPrompt } = process.env;
	if (!url || !tokenFile || !slowPrompt) throw new Error("Set A2A_URL, A2A_TOKEN_FILE and A2A_SLOW_PROMPT");
	const token = (await readFile(tokenFile, "utf8")).trim();
	const fetchImpl = createSmokeFetch(url, token);
	const client = await new ClientFactory({
		transports: [new JsonRpcTransportFactory({ fetchImpl })],
		cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
	}).createFromUrl(url);
	await runGatewaySmoke(client, { slowPrompt });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error: Error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
