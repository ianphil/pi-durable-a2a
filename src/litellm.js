import { mkdir, readFile, rmdir } from 'node:fs/promises';
import { JsonRpcTransportHandler } from '@a2a-js/sdk/server';
import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server';

/**
 * Optional transport for LiteLLM's POST `/` task forwarding. Mount via
 * `extraRoutes: { '/': liteLLMTaskHandler(a2a.handler) }` on the Node HTTP helper.
 * Remove once native task operations pass through the deployed gateway:
 * https://github.com/BerriAI/litellm/pull/44769
 *
 * @param {import('@a2a-js/sdk/server').A2ARequestHandler} handler
 */
export function liteLLMTaskHandler(handler) {
  const native = new JsonRpcTransportHandler(handler);
  const legacy = new LegacyJsonRpcTransportHandler(handler);
  return async (text, call) => {
    let body;
    try { body = JSON.parse(text); } catch { return native.handle(text, call); }
    // tasks/list is LiteLLM's alias for the native list operation, not an A2A
    // v0.3 method. The SDK compatibility handler owns the actual v0.3 methods.
    if (body?.method === 'tasks/list') return native.handle({ ...body, method: 'ListTasks' }, call);
    if (body?.method === 'tasks/get' || body?.method === 'tasks/cancel') return legacy.handle(body, call);
    return native.handle(text, call);
  };
}

/**
 * Publish an agent in the LiteLLM A2A registry and grant a team discovery access.
 * This needs LiteLLM's administrative key: run it from operator code, never from a
 * model-callable tool. Registrars updating one team's grants must run one at a time.
 *
 * @param {{ url: string, adminKeyFile: string, teamId: string, grantLockDirectory: string }} config
 */
export function liteLLMRegistry(config) {
  const url = new URL(config.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('gateway_configuration');

  const request = async (path, method = 'GET', body) => {
    const key = (await readFile(config.adminKeyFile, 'utf8')).trim();
    const response = await fetch(new URL(path, url), {
      // Registration sends the listener token in the body; a redirect could deliver it elsewhere.
      method, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    });
    if (response.status === 404 && method === 'DELETE') return null;
    if (!response.ok) throw new Error('gateway_unavailable');
    return response.status === 204 ? null : response.json();
  };

  const list = async () => {
    const rows = await request('/v1/agents');
    if (!Array.isArray(rows)) throw new Error('gateway_registry_invalid');
    return rows;
  };

  // LiteLLM replaces the whole grant list, so read, modify, write and verify under a lock.
  const grant = async (id, remove) => {
    try { await mkdir(config.grantLockDirectory, { mode: 0o700 }); } catch { throw new Error('gateway_grant_locked'); }
    try {
      const read = async () => {
        const info = await request(`/team/info?team_id=${encodeURIComponent(config.teamId)}`);
        if (info.team_info?.team_id !== config.teamId) throw new Error('gateway_team_invalid');
        return info.team_info.object_permission ?? {};
      };
      const permissions = await read();
      if (permissions.agents !== undefined &&
          (!Array.isArray(permissions.agents) || permissions.agents.some((x) => typeof x !== 'string'))) {
        throw new Error('gateway_team_invalid');
      }
      const existing = permissions.agents ?? [];
      if (existing.includes(id) === !remove) return;
      const agents = remove ? existing.filter((x) => x !== id) : [...existing, id];
      const { object_permission_id: _id, ...other } = permissions;
      await request('/team/update', 'POST', { team_id: config.teamId, object_permission: { ...other, agents } });
      const saved = await read();
      if (!agents.every((x) => saved.agents?.includes(x)) || (remove && saved.agents?.includes(id))) throw new Error('gateway_grant_failed');
    } finally { await rmdir(config.grantLockDirectory); }
  };

  // Ours only if the name, upstream URL and private listener token all match.
  const base = (agent) => agent.listener.replace(/\/$/, '');
  const owns = (row, agent) => row.agent_name === agent.name && row.agent_card_params?.url === base(agent) &&
    row.static_headers?.Authorization === `Bearer ${agent.token}`;

  return {
    /**
     * Create or adopt the registration, persist ownership, then grant discovery.
     * A grant failure leaves the registration owned for a retry, never a second create.
     *
     * @param {{ name: string, description: string, version?: string, listener: string, token: string,
     *   skills: { id: string, name: string, description: string, tags?: string[] }[] }} agent
     *   `listener` is the listener's base URL, which LiteLLM forwards to.
     * @param {{ id: string } | undefined} saved
     * @param {(registration: { id: string, name: string }) => void | Promise<void>} persist
     */
    async publish(agent, saved, persist) {
      const listener = new URL(agent.listener);
      if (!['http:', 'https:'].includes(listener.protocol) || listener.username || listener.password ||
          ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(listener.hostname)) {
        throw new Error('gateway_listener_invalid');
      }
      const rows = await list();
      const sameName = rows.filter((row) => row.agent_name === agent.name);
      let registration;
      if (sameName.length) {
        if (sameName.length !== 1 || !owns(sameName[0], agent) || (saved && saved.id !== sameName[0].agent_id)) {
          throw new Error('gateway_name_conflict');
        }
        registration = { id: sameName[0].agent_id, name: agent.name };
      } else {
        if (saved && rows.some((row) => row.agent_id === saved.id)) throw new Error('gateway_ownership_conflict');
        const result = await request('/v1/agents', 'POST', {
          agent_name: agent.name,
          // LiteLLM's registry DTO, not the native Agent Card the listener serves.
          agent_card_params: {
            name: agent.name, description: agent.description, version: agent.version ?? '0.1.0', url: base(agent),
            protocolVersion: '1.0', preferredTransport: 'JSONRPC', capabilities: { streaming: false, pushNotifications: false },
            skills: agent.skills, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
            securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, security: [{ bearer: [] }],
          },
          static_headers: { Authorization: `Bearer ${agent.token}` },
        });
        if (typeof result?.agent_id !== 'string') throw new Error('gateway_registration_uncertain');
        registration = { id: result.agent_id, name: agent.name };
      }
      await persist(registration);
      await grant(registration.id, false);
      return registration;
    },

    /** Remove this agent's own registration and grant; refuses records it does not own. */
    async withdraw(agent, saved) {
      const rows = await list();
      const candidates = rows.filter((row) => row.agent_name === agent.name || (saved && row.agent_id === saved.id));
      if (candidates.some((row) => !owns(row, agent))) throw new Error('gateway_ownership_conflict');
      for (const row of candidates) {
        // Revoke first: once the row is gone, a retry without `saved` can no longer find this grant.
        await grant(row.agent_id, true);
        await request(`/v1/agents/${encodeURIComponent(row.agent_id)}`, 'DELETE');
      }
      if (!candidates.length && saved) await grant(saved.id, true);
    },
  };
}
