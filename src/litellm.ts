// Optional LiteLLM integration: task forwarding to the listener, and registration in LiteLLM's A2A registry.
import { mkdir, readFile, rmdir } from "node:fs/promises";
import { LegacyJsonRpcTransportHandler } from "@a2a-js/sdk/compat/v0_3/server";
import { type A2ARequestHandler, JsonRpcTransportHandler } from "@a2a-js/sdk/server";
import type { A2ATransport } from "./http.ts";

/**
 * Transport for LiteLLM's task forwarding to POST `/`, mounted with
 * `extraRoutes: { "/": liteLLMTaskHandler(handler) }`. Remove once native task operations pass through the deployed
 * gateway: https://github.com/BerriAI/litellm/pull/44769
 */
export function liteLLMTaskHandler(handler: A2ARequestHandler): A2ATransport {
	const native = new JsonRpcTransportHandler(handler);
	const legacy = new LegacyJsonRpcTransportHandler(handler);
	return async (body, context) => {
		let request: { method?: unknown };
		try {
			request = JSON.parse(body);
		} catch {
			return native.handle(body, context);
		}
		// tasks/list is LiteLLM's alias for native ListTasks, not an A2A v0.3 method; the SDK handles the v0.3 ones.
		if (request?.method === "tasks/list") return native.handle({ ...request, method: "ListTasks" }, context);
		if (request?.method === "tasks/get" || request?.method === "tasks/cancel") return legacy.handle(request, context);
		return native.handle(body, context);
	};
}

/** The gateway, the operator's administrative key, and the team granted discovery. */
export type LiteLLMConfig = {
	readonly url: string;
	/** File holding LiteLLM's administrative key; outside the agent's reach. */
	readonly adminKeyFile: string;
	readonly teamId: string;
	/** Directory created as a lock while a team's grants are rewritten. */
	readonly grantLockDirectory: string;
};

/** The agent to register: its listener's base URL, which LiteLLM forwards to, and the listener token. */
export type LiteLLMAgent = {
	readonly name: string;
	readonly description: string;
	readonly version?: string;
	readonly listener: string;
	readonly token: string;
	readonly skills: readonly { id: string; name: string; description: string; tags: string[] }[];
};

/** A registration this agent owns, as persisted by the operator. */
export type LiteLLMRegistration = { readonly id: string; readonly name: string };

/** Registration and grant operations against one LiteLLM gateway. */
export type LiteLLMRegistry = {
	/**
	 * Create or adopt the registration, persist ownership, then grant discovery. A grant failure leaves the registration
	 * owned for a retry, never a second create.
	 */
	publish(
		agent: LiteLLMAgent,
		saved: LiteLLMRegistration | undefined,
		persist: (registration: LiteLLMRegistration) => void | Promise<void>,
	): Promise<LiteLLMRegistration>;
	/** Remove this agent's own registration and grant; refuses records it does not own. */
	withdraw(agent: LiteLLMAgent, saved: LiteLLMRegistration | undefined): Promise<void>;
};

// Gateway responses, as far as this module reads them.
type AgentRow = {
	agent_id: string;
	agent_name: string;
	agent_card_params?: { url?: string };
	static_headers?: { Authorization?: string };
};
type TeamInfo = {
	team_info?: { team_id?: string; object_permission?: Record<string, unknown> & { agents?: unknown } };
};

/**
 * Publish an agent in the LiteLLM A2A registry and grant a team discovery access. Uses LiteLLM's administrative key:
 * run it from operator code, never from a model-callable tool. Registrars updating one team's grants must run one at a
 * time.
 */
export function liteLLMRegistry(config: LiteLLMConfig): LiteLLMRegistry {
	const url = new URL(config.url);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
		throw new Error("gateway_configuration");
	}

	const request = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
		const key = (await readFile(config.adminKeyFile, "utf8")).trim();
		const response = await fetch(new URL(path, url), {
			method,
			body: body === undefined ? undefined : JSON.stringify(body),
			// Registration sends the listener token in the body; a redirect could deliver it elsewhere.
			redirect: "error",
			signal: AbortSignal.timeout(20_000),
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		});
		if (response.status === 404 && method === "DELETE") return null;
		if (!response.ok) throw new Error("gateway_unavailable");
		return response.status === 204 ? null : response.json();
	};

	const list = async (): Promise<AgentRow[]> => {
		const rows = await request("/v1/agents");
		if (!Array.isArray(rows)) throw new Error("gateway_registry_invalid");
		return rows;
	};

	const readGrants = async () => {
		const info = (await request(`/team/info?team_id=${encodeURIComponent(config.teamId)}`)) as TeamInfo;
		if (info.team_info?.team_id !== config.teamId) throw new Error("gateway_team_invalid");
		const permissions = info.team_info.object_permission ?? {};
		const agents = permissions.agents ?? [];
		if (!Array.isArray(agents) || agents.some((agent) => typeof agent !== "string")) {
			throw new Error("gateway_team_invalid");
		}
		return { permissions, agents: agents as string[] };
	};

	// LiteLLM replaces the whole grant list, so read, modify, write and verify under a lock.
	const setGrant = async (id: string, granted: boolean) => {
		try {
			await mkdir(config.grantLockDirectory, { mode: 0o700 });
		} catch {
			throw new Error("gateway_grant_locked");
		}
		try {
			const { permissions, agents: existing } = await readGrants();
			if (existing.includes(id) === granted) return;
			const agents = granted ? [...existing, id] : existing.filter((agent) => agent !== id);
			const { object_permission_id: _id, ...other } = permissions;
			await request("/team/update", "POST", { team_id: config.teamId, object_permission: { ...other, agents } });
			const saved = (await readGrants()).agents;
			if (!agents.every((agent) => saved.includes(agent)) || (!granted && saved.includes(id))) {
				throw new Error("gateway_grant_failed");
			}
		} finally {
			await rmdir(config.grantLockDirectory);
		}
	};

	// Ours only if the name, upstream URL and private listener token all match.
	const base = (agent: LiteLLMAgent) => agent.listener.replace(/\/$/, "");
	const owns = (row: AgentRow, agent: LiteLLMAgent) =>
		row.agent_name === agent.name &&
		row.agent_card_params?.url === base(agent) &&
		row.static_headers?.Authorization === `Bearer ${agent.token}`;

	return {
		async publish(agent, saved, persist) {
			const listener = new URL(agent.listener);
			if (
				!["http:", "https:"].includes(listener.protocol) ||
				listener.username ||
				listener.password ||
				["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(listener.hostname)
			) {
				throw new Error("gateway_listener_invalid");
			}
			const rows = await list();
			const sameName = rows.filter((row) => row.agent_name === agent.name);
			let registration: LiteLLMRegistration;
			if (sameName.length > 0) {
				if (sameName.length !== 1 || !owns(sameName[0], agent) || (saved && saved.id !== sameName[0].agent_id)) {
					throw new Error("gateway_name_conflict");
				}
				registration = { id: sameName[0].agent_id, name: agent.name };
			} else {
				if (saved && rows.some((row) => row.agent_id === saved.id)) throw new Error("gateway_ownership_conflict");
				const created = (await request("/v1/agents", "POST", {
					agent_name: agent.name,
					// LiteLLM's registry DTO, not the native Agent Card the listener serves.
					agent_card_params: {
						name: agent.name,
						description: agent.description,
						version: agent.version ?? "0.1.0",
						url: base(agent),
						protocolVersion: "1.0",
						preferredTransport: "JSONRPC",
						capabilities: { streaming: false, pushNotifications: false },
						skills: agent.skills,
						defaultInputModes: ["text/plain"],
						defaultOutputModes: ["text/plain"],
						securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
						security: [{ bearer: [] }],
					},
					static_headers: { Authorization: `Bearer ${agent.token}` },
				})) as { agent_id?: unknown } | null;
				if (typeof created?.agent_id !== "string") throw new Error("gateway_registration_uncertain");
				registration = { id: created.agent_id, name: agent.name };
			}
			await persist(registration);
			await setGrant(registration.id, true);
			return registration;
		},

		async withdraw(agent, saved) {
			const rows = await list();
			const candidates = rows.filter((row) => row.agent_name === agent.name || row.agent_id === saved?.id);
			if (candidates.some((row) => !owns(row, agent))) throw new Error("gateway_ownership_conflict");
			for (const row of candidates) {
				// Revoke first: once the row is gone, a retry without `saved` can no longer find this grant.
				await setGrant(row.agent_id, false);
				await request(`/v1/agents/${encodeURIComponent(row.agent_id)}`, "DELETE");
			}
			if (candidates.length === 0 && saved) await setGrant(saved.id, false);
		},
	};
}
