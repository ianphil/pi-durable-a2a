// LiteLLM registration against a local stand-in for its registry and team endpoints.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LiteLLMAgent,
	type LiteLLMRegistration,
	type LiteLLMRegistry,
	liteLLMRegistry,
} from "pi-durable-a2a/litellm";
import { expect, test } from "vitest";
import { listen } from "./support.ts";

type Row = Record<string, unknown> & { agent_id: string };
type Route = (req: IncomingMessage, res: ServerResponse, body: string) => void;

const agent: LiteLLMAgent = {
	name: "test-agent",
	description: "Test agent",
	listener: "http://agent.example:8766/",
	token: "private-listener-token",
	skills: [{ id: "chat", name: "Chat", description: "Talk", tags: [] }],
};

const owned: Row = {
	agent_id: "owned-id",
	agent_name: agent.name,
	agent_card_params: { url: "http://agent.example:8766" },
	static_headers: { Authorization: `Bearer ${agent.token}` },
};

/** Run `use` with a registry for a gateway answering by `route`, behind the stand-in admin key. */
async function withGateway(route: Route, use: (registry: LiteLLMRegistry, url: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "pi-durable-a2a-litellm-"));
	await writeFile(join(dir, "admin-key"), "private-sentinel");
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		res.setHeader("content-type", "application/json");
		route(req, res, body);
	});
	const url = `http://127.0.0.1:${await listen(server)}`;
	try {
		const registry = liteLLMRegistry({
			url,
			adminKeyFile: join(dir, "admin-key"),
			teamId: "fleet",
			grantLockDirectory: join(dir, "grant-lock"),
		});
		await use(registry, url);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		await rm(dir, { recursive: true, force: true });
	}
}

/** A stand-in for LiteLLM's registry and team grants, shaped like the deployed gateway's responses. */
function gateway(rows: Row[], agents: string[]) {
	const state = {
		rows,
		permissions: { agents, vector_stores: ["preserve-me"] } as Record<string, unknown>,
		creates: 0,
		outage: false,
		failGrant: false,
	};
	const route: Route = (req, res, body) => {
		if (state.outage || req.headers.authorization !== "Bearer private-sentinel") {
			res.writeHead(503);
			res.end();
		} else if (req.url === "/v1/agents" && req.method === "GET") res.end(JSON.stringify(state.rows));
		else if (req.url === "/v1/agents" && req.method === "POST") {
			state.creates++;
			const row = { ...JSON.parse(body), agent_id: "owned-id" };
			state.rows.push(row);
			res.end(JSON.stringify(row));
		} else if (req.url?.startsWith("/team/info")) {
			res.end(JSON.stringify({ team_info: { team_id: "fleet", object_permission: state.permissions } }));
		} else if (req.url === "/team/update") {
			if (state.failGrant) {
				res.writeHead(503);
				res.end();
				return;
			}
			state.permissions = JSON.parse(body).object_permission;
			res.end("{}");
		} else if (req.method === "DELETE") {
			state.rows = state.rows.filter((row) => !req.url?.endsWith(row.agent_id));
			res.end("{}");
		} else {
			res.writeHead(404);
			res.end("{}");
		}
	};
	return { state, route };
}

test("publishes once, recovers ownership, keeps other grants and withdraws only its own record", async () => {
	const { state, route } = gateway([], ["unrelated"]);
	await withGateway(route, async (registry) => {
		let saved: LiteLLMRegistration | undefined;
		const persist = (registration: LiteLLMRegistration) => {
			saved = registration;
		};
		// Creation succeeds and the grant fails: ownership is kept, and the retry does not create again.
		state.failGrant = true;
		await expect(registry.publish(agent, undefined, persist)).rejects.toThrow();
		expect(saved?.id).toBe("owned-id");
		state.failGrant = false;
		await registry.publish(agent, saved, persist);
		expect(state.creates).toBe(1);
		expect(state.rows[0].agent_card_params).toMatchObject({ url: "http://agent.example:8766" });
		expect(state.permissions).toEqual({ agents: ["unrelated", "owned-id"], vector_stores: ["preserve-me"] });

		// Lost local ownership: the exact name, URL and token adopt the existing record.
		await registry.publish(agent, undefined, persist);
		expect(state.creates).toBe(1);
		await expect(registry.publish({ ...agent, token: "different" }, saved, () => {})).rejects.toThrow(
			/gateway_name_conflict/,
		);
		state.outage = true;
		await expect(registry.publish(agent, saved, () => {})).rejects.toThrow();
		state.outage = false;

		state.rows.push({ agent_id: "other-id", agent_name: "other-agent" });
		await registry.withdraw(agent, saved);
		expect(state.rows.map((row) => row.agent_id)).toEqual(["other-id"]);
		expect(state.permissions.agents).toEqual(["unrelated"]);
	});
});

test("registration refuses redirects instead of sending the listener token elsewhere", async () => {
	const received: string[] = [];
	await withGateway(
		(req, res) => {
			received.push(req.url ?? "");
			res.end("[]");
		},
		async (_, destination) => {
			await withGateway(
				(req, res) => {
					if (req.method === "GET" && req.url === "/v1/agents") {
						res.end("[]");
						return;
					}
					res.writeHead(307, { location: `${destination}/v1/agents` });
					res.end();
				},
				async (registry) => {
					await expect(registry.publish(agent, undefined, () => {})).rejects.toThrow();
				},
			);
		},
	);
	expect(received).toEqual([]);
});

test("a failed grant removal leaves withdrawal retryable without saved ownership", async () => {
	const { state, route } = gateway([owned], ["unrelated", "owned-id"]);
	state.failGrant = true;
	await withGateway(route, async (registry) => {
		await expect(registry.withdraw(agent, undefined)).rejects.toThrow();
		expect(state.rows).toEqual([owned]);
		state.failGrant = false;
		await registry.withdraw(agent, undefined);
		expect(state.rows).toEqual([]);
		expect(state.permissions.agents).toEqual(["unrelated"]);
	});
});
