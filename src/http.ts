// Node HTTP serving of an A2A handler: bearer authentication, bounded bodies, and JSON-RPC transports by path.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { AgentCard } from "@a2a-js/sdk";
import { JsonRpcTransportHandler, ServerCallContext } from "@a2a-js/sdk/server";
import type { A2AHandler } from "./handler.ts";

/** A JSON-RPC transport for one POST path: the request body in, the JSON-RPC response out. */
export type A2ATransport = (
	body: string,
	context: ServerCallContext,
) => Promise<object | AsyncGenerator<unknown, void, undefined>>;

/** Listener settings. */
export type A2AHttpOptions = {
	/** Bearer token callers present: 32 to 256 base64url characters. */
	readonly token: string;
	/** More POST paths and their transports, behind the same authentication and body limit. */
	readonly extraRoutes?: Readonly<Record<string, A2ATransport>>;
};

const MAX_BODY_BYTES = 32_768;

/**
 * Node HTTP callback a host can mount in its own server. Serves native JSON-RPC at `/a2a`, the authenticated Agent
 * Card, and unauthenticated `/health`. `/a2a` always uses the SDK's native transport.
 */
export function createA2AHttpHandler(handler: A2AHandler, options: A2AHttpOptions): RequestListener {
	if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.token)) throw new Error("listener_token_invalid");
	const expected = Buffer.from(`Bearer ${options.token}`);
	const native = new JsonRpcTransportHandler(handler);
	const routes = new Map(Object.entries(options.extraRoutes ?? {}));
	routes.set("/a2a", (body, context) => native.handle(body, context));
	return async (req, res) => {
		if (req.method === "GET" && req.url === "/health") return json(res, 200, { status: "ok" });
		const supplied = Buffer.from(req.headers.authorization ?? "");
		if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
			return refuse(req, res, 401, "Unauthorized");
		}
		if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
			return json(res, 200, AgentCard.toJSON(handler.card));
		}
		const transport = routes.get(req.url ?? "");
		if (req.method !== "POST" || !transport) return refuse(req, res, 404, "Not found");
		if (!/^application\/(?:a2a\+)?json(?:;|$)/i.test(req.headers["content-type"] ?? "")) {
			return refuse(req, res, 415, "Content type");
		}
		try {
			const body = await readBody(req);
			if (body === undefined) return json(res, 413, { error: "Request too large" });
			const version = req.headers["a2a-version"];
			const context = new ServerCallContext({ requestedVersion: typeof version === "string" ? version : "" });
			const result = await transport(body, context);
			if (Symbol.asyncIterator in result) return json(res, 400, { error: "Streaming unsupported" });
			if (!res.destroyed) json(res, 200, result);
		} catch {
			if (!res.destroyed) json(res, 500, { error: "Request failed" });
		}
	};
}

/** Convenience server with request and header timeouts; hosts can mount `createA2AHttpHandler` themselves instead. */
export function createA2AServer(handler: A2AHandler, options: A2AHttpOptions): Server {
	const server = createServer(createA2AHttpHandler(handler, options));
	server.requestTimeout = 10_000;
	server.headersTimeout = 5_000;
	return server;
}

/** The body as text, or `undefined` once it exceeds the limit. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of req) {
		bytes += chunk.length;
		if (bytes > MAX_BODY_BYTES) return undefined;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function refuse(req: IncomingMessage, res: ServerResponse, status: number, error: string): void {
	// Drain the unread body so the connection can be reused.
	req.resume();
	json(res, status, { error });
}

function json(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(value));
}
