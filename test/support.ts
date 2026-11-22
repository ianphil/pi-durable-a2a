// Shared fixtures for the tests: a gated faux model, an A2A agent over HTTP on SQLite, and request builders.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SendMessageRequest } from "@a2a-js/sdk";
import { type Client, ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxProviderHandle,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, createRegistry, Harness, type Registry, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { A2AExtension, A2AHandler, createA2AServer } from "pi-durable-a2a";

export const context = BACKGROUND_CONTEXT;
export const token = "a".repeat(40);

/** A model response held until released; an abort of its request releases it too. */
export type Gate = {
	readonly started: Promise<void>;
	readonly aborted: Promise<void>;
	readonly release: () => void;
	readonly response: FauxResponseFactory;
};

/** A model response that answers `text` once released, and reports when it starts and when its request aborts. */
export function gate(text: string): Gate {
	const started = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	return {
		started: started.promise,
		aborted: aborted.promise,
		release: () => released.resolve(),
		response: async (_transcript, options) => {
			const onAbort = () => {
				aborted.resolve();
				released.resolve();
			};
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			if (options?.signal?.aborted) onAbort();
			started.resolve();
			try {
				await released.promise;
				return fauxAssistantMessage(text);
			} finally {
				options?.signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

/** A plain-text user message request. */
export function send(
	messageId: string,
	text: string,
	configuration?: { returnImmediately?: boolean; historyLength?: number },
): SendMessageRequest {
	return SendMessageRequest.fromJSON({ message: { messageId, role: "ROLE_USER", parts: [{ text }] }, configuration });
}

/** An agent host: Durable on `storage`, the A2A handler, and a faux model. */
export type Host = {
	readonly harness: Harness;
	readonly conversation: Conversation;
	readonly handler: A2AHandler;
	readonly registry: Registry;
	close(): Promise<void>;
};

/** Open a host the way an application does: install the extension, open Durable, serve the root conversation. */
export async function openHost(
	storage: Storage,
	faux: FauxProviderHandle,
	options: { maxRetries?: number } = {},
): Promise<Host> {
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(A2AExtension);
	const harness = await Harness.open(
		storage,
		{ models, registry, settings: { retry: { maxRetries: options.maxRetries ?? 0, baseDelayMs: 1 } } },
		context,
	);
	const model = faux.getModel();
	const conversation = await harness.root(context, {
		agent: { model: { provider: model.provider, modelId: model.id } },
	});
	harness.resume();
	const handler = new A2AHandler({
		harness,
		conversation,
		card: { name: "fixture", description: "Test agent", url: "http://localhost/a2a", skills: [] },
	});
	return {
		harness,
		conversation,
		handler,
		registry,
		async close() {
			await handler.close();
			await harness.close(context);
		},
	};
}

/** A host served over HTTP on a fixed port, with an SDK client. */
export type Agent = Host & { readonly base: string; readonly client: Client };

/** A served agent on persistent SQLite in `dir`, reopened on the same port by `reopen()`. */
export type AgentFixture = {
	readonly dir: string;
	readonly faux: FauxProviderHandle;
	readonly agent: Agent;
	reopen(): Promise<Agent>;
};

/** Run `use` against a served agent on SQLite in a fresh directory, then close it and remove the directory. */
export async function withAgent(use: (fixture: AgentFixture) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-durable-a2a-"));
	const faux = fauxProvider();
	const port = await freePort();
	let agent = await serve(dir, faux, port);
	try {
		await use({
			dir,
			faux,
			get agent() {
				return agent;
			},
			async reopen() {
				await agent.close();
				agent = await serve(dir, faux, port);
				return agent;
			},
		});
	} finally {
		await agent.close();
		await rm(dir, { recursive: true, force: true });
	}
}

async function serve(dir: string, faux: FauxProviderHandle, port: number): Promise<Agent> {
	const host = await openHost(await openNodeSqliteStorage(join(dir, "durable.sqlite")), faux);
	const server = createA2AServer(host.handler, { token });
	await listen(server, port);
	const base = `http://127.0.0.1:${port}`;
	host.handler.card.supportedInterfaces[0].url = `${base}/a2a`;
	const fetchImpl: typeof fetch = (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set("authorization", `Bearer ${token}`);
		return fetch(input, { ...init, headers });
	};
	const client = await new ClientFactory({
		transports: [new JsonRpcTransportFactory({ fetchImpl })],
		cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
	}).createFromUrl(base);
	return {
		...host,
		base,
		client,
		async close() {
			server.close();
			server.closeAllConnections();
			await host.close();
		},
	};
}

/** Listen on `port`, or on a free one when it is 0. */
export async function listen(server: Server, port = 0): Promise<number> {
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
	const probe = createServer();
	const port = await listen(probe);
	await new Promise((resolve) => probe.close(resolve));
	return port;
}
