// HTTP serving: authentication, body limits, mounting, LiteLLM forwarding, and the smoke and example clients.
import { execFile } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AgentCard, GetTaskRequest } from "@a2a-js/sdk";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { type FauxProviderHandle, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { type A2AHandler, createA2AHttpHandler, createA2AServer } from "pi-durable-a2a";
import { liteLLMTaskHandler } from "pi-durable-a2a/litellm";
import { describe, expect, test } from "vitest";
import { createSmokeFetch, runGatewaySmoke } from "../scripts/gateway-smoke.ts";
import { listen, openHost, token } from "./support.ts";

// Response bodies as the wire carries them; each test reads only the fields it checks.
// biome-ignore lint/suspicious/noExplicitAny: untyped wire JSON
const json = async (response: Response): Promise<any> => response.json();

type Listener = {
	readonly base: string;
	readonly faux: FauxProviderHandle;
	readonly handler: A2AHandler;
	readonly server: Server;
	rpc(
		path: string,
		method: string,
		params: unknown,
		options?: { version?: string | null; headers?: Record<string, string> },
	): Promise<Response>;
	send(messageId: string, text: string, configuration?: { returnImmediately?: boolean }): Promise<{ id: string }>;
};

/** Serve a MemoryStorage agent over HTTP, by the convenience server or mounted in a host's server. */
async function withListener(
	use: (listener: Listener) => Promise<void>,
	options: { mounted?: boolean; compatibility?: boolean } = {},
): Promise<void> {
	const faux = fauxProvider();
	const host = await openHost(new MemoryStorage(), faux);
	const http = {
		token,
		...(options.compatibility ? { extraRoutes: { "/": liteLLMTaskHandler(host.handler) } } : {}),
	};
	let server: Server;
	if (options.mounted) {
		const a2a: RequestListener = createA2AHttpHandler(host.handler, http);
		server = createServer((req, res) => {
			if (req.url === "/host") res.end("Host-owned endpoint");
			else a2a(req, res);
		});
	} else server = createA2AServer(host.handler, http);
	try {
		const base = `http://127.0.0.1:${await listen(server)}`;
		host.handler.card.supportedInterfaces[0].url = `${base}/a2a`;
		const rpc: Listener["rpc"] = (path, method, params, { version = "1.0", headers = {} } = {}) =>
			fetch(`${base}${path}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					...(version ? { "a2a-version": version } : {}),
					...headers,
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			});
		const send: Listener["send"] = async (messageId, text, configuration) => {
			const response = await rpc("/a2a", "SendMessage", {
				message: { messageId, role: "ROLE_USER", parts: [{ text }] },
				configuration,
			});
			expect(response.status).toBe(200);
			const body = await json(response);
			expect(body.error).toBeUndefined();
			return body.result.task;
		};
		await use({ base, faux, handler: host.handler, server, rpc, send });
	} finally {
		server.close();
		server.closeAllConnections();
		await host.close();
	}
}

/** Health is open; the card and every JSON-RPC path need the token, JSON, and a bounded body. */
async function expectProtections({ base, rpc, faux }: Listener, path: string) {
	expect((await fetch(`${base}/health`)).status).toBe(200);
	expect((await fetch(`${base}/.well-known/agent-card.json`)).status).toBe(401);
	const card = await fetch(`${base}/.well-known/agent-card.json`, { headers: { authorization: `Bearer ${token}` } });
	expect(card.status).toBe(200);
	expect((await json(card)).name).toBe("fixture");
	const params = { message: { messageId: "unauthorized", role: "ROLE_USER", parts: [{ text: "Hello" }] } };
	expect((await rpc(path, "SendMessage", params, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
	expect(faux.state.callCount).toBe(0);
	expect((await rpc(path, "GetTask", { id: "missing" }, { headers: { "content-type": "text/plain" } })).status).toBe(
		415,
	);
	const oversized = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: " ".repeat(32_769),
	});
	expect(oversized.status).toBe(413);
}

describe("serving", () => {
	test("the convenience server is native-only and protected", async () => {
		await withListener(async (listener) => {
			await expectProtections(listener, "/a2a");
			expect(listener.server.requestTimeout).toBe(10_000);
			expect(listener.server.headersTimeout).toBe(5_000);
			expect((await listener.rpc("/", "tasks/get", { id: "missing" }, { version: null })).status).toBe(404);
			const wrongMethod = await listener.rpc("/a2a", "tasks/get", { id: "missing" }, { version: null });
			expect((await json(wrongMethod)).error.code).toBe(-32601);
			listener.faux.setResponses([fauxAssistantMessage("Native answer")]);
			const task = await listener.send("native", "Hello");
			const fetched = await listener.rpc("/a2a", "GetTask", { id: task.id });
			expect((await json(fetched)).result.id).toBe(task.id);
		});
	});

	test("the Node handler mounts beside a host-owned endpoint", async () => {
		await withListener(
			async (listener) => {
				expect(await (await fetch(`${listener.base}/host`)).text()).toBe("Host-owned endpoint");
				await expectProtections(listener, "/a2a");
				listener.faux.setResponses([fauxAssistantMessage("Mounted answer")]);
				const task = await listener.send("mounted", "Hello");
				expect(JSON.stringify(task)).toMatch(/Mounted answer/);
				expect((await listener.rpc("/", "GetTask", { id: task.id })).status).toBe(404);
			},
			{ mounted: true },
		);
	});
});

describe.each([false, true])("LiteLLM forwarding (mounted: %s)", (mounted) => {
	test("is opt-in and uses the SDK's task compatibility", async () => {
		await withListener(
			async (listener) => {
				await expectProtections(listener, "/");
				listener.faux.setResponses([fauxAssistantMessage("First answer")]);
				const first = await listener.send("first", "Hello");
				listener.faux.setResponses([fauxAssistantMessage("Second answer")]);
				const second = await listener.send("second", "Follow up");
				// LiteLLM forwards without the version header.
				const forwarded = async (method: string, params: unknown) =>
					(await json(await listener.rpc("/", method, params, { version: null }))).result;
				const legacy = await forwarded("tasks/get", { id: first.id });
				expect(legacy).toMatchObject({ id: first.id, status: { state: "completed" } });
				expect(JSON.stringify(legacy.status)).toMatch(/First answer/);
				const page = await forwarded("tasks/list", { pageSize: 1 });
				expect(page.tasks[0].id).toBe(second.id);
				expect(page.nextPageToken).toBeTruthy();
				const next = await forwarded("tasks/list", { pageSize: 1, pageToken: page.nextPageToken });
				expect(next.tasks[0].id).toBe(first.id);
				// Opting in does not change the native path.
				const nativeAlias = await listener.rpc("/a2a", "tasks/get", { id: first.id }, { version: null });
				expect((await json(nativeAlias)).error.code).toBe(-32601);

				const started = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				listener.faux.setResponses([
					async (_transcript, options) => {
						options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
						started.resolve();
						await release.promise;
						return fauxAssistantMessage("Must not become an answer");
					},
				]);
				const pending = await listener.send("cancel", "Slow work", { returnImmediately: true });
				await started.promise;
				const canceled = await forwarded("tasks/cancel", { id: pending.id });
				expect(canceled).toMatchObject({ id: pending.id, status: { state: "canceled" } });
				const after = await forwarded("tasks/get", { id: pending.id });
				expect(after.status.state).toBe("canceled");
			},
			{ mounted, compatibility: true },
		);
	});
});

describe("clients", () => {
	test("the smoke runs every check against real Durable execution", async () => {
		await withListener(async ({ base, handler, faux }) => {
			const fetchImpl = createSmokeFetch(base, token);
			const client = await new ClientFactory({
				transports: [new JsonRpcTransportFactory({ fetchImpl })],
			}).createFromAgentCard(handler.card);
			const complete = Promise.withResolvers<void>();
			const cancel = Promise.withResolvers<void>();
			const echoMarker = (transcript: { messages: unknown[] }) =>
				fauxAssistantMessage(JSON.stringify(transcript.messages).match(/smoke-[0-9a-f-]+-marker/)?.[0] ?? "");
			faux.setResponses([
				echoMarker,
				echoMarker,
				async () => {
					await complete.promise;
					return fauxAssistantMessage("Read-only report");
				},
				async (_transcript, options) => {
					options?.signal?.addEventListener("abort", () => cancel.resolve(), { once: true });
					await cancel.promise;
					return fauxAssistantMessage("Must not become an answer");
				},
			]);
			const checks: string[] = [];
			try {
				const result = await runGatewaySmoke(client, {
					slowPrompt: "Read a large collection of issues.",
					pollMs: 10,
					report: (event) => {
						checks.push(event.check);
						if (event.check === "working/busy") complete.resolve();
					},
				});
				expect(result.firstTaskId).toBeTruthy();
				expect(checks).toEqual([
					"send/get",
					"idempotency/conflicting-text",
					"follow-up",
					"paginated-list",
					"started",
					"working/busy",
					"polled-completed",
					"canceled/stable-get",
				]);
			} finally {
				complete.resolve();
				cancel.resolve();
			}
		});
	});

	test("the example client sends, retries, follows up and reads back without another model call", async () => {
		await withListener(async ({ base, faux }) => {
			const echoMarker = (transcript: { messages: unknown[] }) =>
				fauxAssistantMessage(JSON.stringify(transcript.messages).match(/example-[0-9a-f-]+/)?.[0] ?? "");
			faux.setResponses([echoMarker, echoMarker]);
			const run = promisify(execFile);
			const file = fileURLToPath(new URL("../examples/client.ts", import.meta.url));
			const env = { ...process.env, A2A_URL: base, A2A_TOKEN: token, TASK_ID: "" };
			const first = await run(process.execPath, [file], { env, timeout: 10_000 });
			expect(first.stdout).toMatch(/Same-ID retry returned the original task/);
			expect(first.stdout).toMatch(/Follow-up recalled the marker/);
			const id = first.stdout.match(/Saved task: (\d+)/)?.[1];
			const retrieved = await run(process.execPath, [file], { env: { ...env, TASK_ID: id }, timeout: 10_000 });
			expect(JSON.parse(retrieved.stdout).id).toBe(id);
			expect(faux.state.callCount).toBe(2); // Retry and read do not call the model.
		});
	}, 20_000);

	test("the smoke fetch keeps headers and replaces authorization on its configured origin", async () => {
		await withListener(async ({ base, server }) => {
			const fetchImpl = createSmokeFetch(base, token);
			let customHeader: string | string[] | undefined;
			server.on("request", (req) => {
				customHeader = req.headers["x-smoke"];
			});
			const headers = {
				"content-type": "application/json",
				"a2a-version": "1.0",
				"x-smoke": "kept",
				authorization: "Bearer stale",
			};
			const request = {
				method: "POST",
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "1" } }),
			};
			for (const value of [headers, new Headers(headers), Object.entries(headers)]) {
				const response = await fetchImpl(new URL(`${base}/a2a`), { ...request, headers: value });
				expect(response.status).toBe(200);
				expect((await json(response)).error).toBeDefined(); // The SDK reports the unknown task.
				expect(customHeader).toBe("kept");
			}
			const response = await fetchImpl(new Request(`${base}/a2a`, { ...request, headers }));
			expect(response.status).toBe(200); // A Request's own headers apply when init has none.
			await json(response);
			expect(customHeader).toBe("kept");
		});
	});

	test.each([false, true])(
		"the smoke refuses a foreign endpoint before contacting it (redirect: %s)",
		async (redirect) => {
			await withListener(async ({ base, handler, server }) => {
				let targetRequests = 0;
				server.on("request", () => {
					targetRequests++;
				});
				let discoveryAuthorization: string | undefined;
				const discovery = createServer((req, res) => {
					discoveryAuthorization = req.headers.authorization;
					if (redirect) {
						res.writeHead(302, { location: `${base}/.well-known/agent-card.json` });
						res.end();
						return;
					}
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify(AgentCard.toJSON(handler.card)));
				});
				try {
					const url = `http://127.0.0.1:${await listen(discovery)}`;
					const fetchImpl = createSmokeFetch(url, token);
					const factory = new ClientFactory({
						transports: [new JsonRpcTransportFactory({ fetchImpl })],
						cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
					});
					if (redirect) await expect(factory.createFromUrl(url)).rejects.toThrow(/redirects.*canonical A2A URL/i);
					else {
						const client = await factory.createFromUrl(url);
						await expect(client.getTask(GetTaskRequest.fromJSON({ id: "1" }))).rejects.toThrow(
							/configured A2A origin/,
						);
					}
					expect(discoveryAuthorization).toBe(`Bearer ${token}`);
					expect(targetRequests).toBe(0);
				} finally {
					discovery.close();
					discovery.closeAllConnections();
				}
			});
		},
	);
});
