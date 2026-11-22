// Calls the example agent through the A2A SDK: send, retry, follow up, and read back; or, with TASK_ID set, read a
// saved task after a restart. Run: `node examples/client.ts`. See docs/quickstart.md.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GetTaskRequest, SendMessageRequest, Task, TaskState } from "@a2a-js/sdk";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { createSmokeFetch } from "../scripts/gateway-smoke.ts";

const url = process.env.A2A_URL ?? "http://127.0.0.1:8766";
const token = process.env.A2A_TOKEN;
if (!token) throw new Error("Set A2A_TOKEN to the agent listener token");
const fetchImpl = createSmokeFetch(url, token);
const client = await new ClientFactory({
	transports: [new JsonRpcTransportFactory({ fetchImpl })],
	cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
}).createFromUrl(url);

if (process.env.TASK_ID) {
	// After restarting the agent, read the same saved task without new work.
	const saved = await client.getTask(GetTaskRequest.fromJSON({ id: process.env.TASK_ID }));
	assert.equal(saved.status?.state, TaskState.TASK_STATE_COMPLETED);
	console.log(JSON.stringify(Task.toJSON(saved), null, 2));
} else {
	const marker = `example-${randomUUID()}`;
	const request = SendMessageRequest.fromJSON({
		message: {
			messageId: randomUUID(),
			role: "ROLE_USER",
			parts: [{ text: `Remember ${marker}. Reply with only that marker.` }],
		},
	});
	const first = (await client.sendMessage(request)) as Task;
	assert.equal(first.status?.state, TaskState.TASK_STATE_COMPLETED);
	assert.ok(JSON.stringify(first.status).includes(marker), "First answer contains the marker");
	console.log(`Saved task: ${first.id} (use TASK_ID=${first.id} after a restart)`);

	const retry = (await client.sendMessage(request)) as Task;
	assert.equal(retry.id, first.id, "Same message ID and text reuse the task");
	console.log("Same-ID retry returned the original task.");

	const followUp = (await client.sendMessage(
		SendMessageRequest.fromJSON({
			message: {
				messageId: randomUUID(),
				contextId: first.contextId,
				role: "ROLE_USER",
				parts: [{ text: "What marker did I ask you to remember? Reply with only that marker." }],
			},
		}),
	)) as Task;
	assert.equal(followUp.status?.state, TaskState.TASK_STATE_COMPLETED);
	assert.ok(JSON.stringify(followUp.status).includes(marker), "Follow-up recalls the earlier turn");
	console.log("Follow-up recalled the marker.");

	const saved = await client.getTask(GetTaskRequest.fromJSON({ id: first.id }));
	assert.equal(saved.id, first.id);
	assert.deepEqual(saved.status, first.status, "Get keeps the completed answer");
	console.log(JSON.stringify(Task.toJSON(saved), null, 2));
}
