import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { liteLLMRegistry } from '../src/litellm.js';

// A stand-in for LiteLLM's registry and team endpoints, shaped like the deployed gateway's responses.
test('publishes once, recovers ownership, preserves other grants and withdraws only its own record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-durable-a2a-litellm-'));
  await writeFile(join(dir, 'admin-key'), 'private-sentinel');
  let records = [];
  let creates = 0;
  let outage = false;
  let failGrant = false;
  let permissions = { agents: ['unrelated'], vector_stores: ['preserve-me'] };
  const server = createServer(async (req, res) => {
    if (outage || req.headers.authorization !== 'Bearer private-sentinel') { res.writeHead(503); return res.end(); }
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/agents' && req.method === 'GET') return res.end(JSON.stringify(records));
    if (req.url === '/v1/agents' && req.method === 'POST') {
      creates++;
      const record = { ...JSON.parse(body), agent_id: 'owned-id' };
      records.push(record);
      return res.end(JSON.stringify(record));
    }
    if (req.url?.startsWith('/team/info')) return res.end(JSON.stringify({ team_info: { team_id: 'fleet', object_permission: permissions } }));
    if (req.url === '/team/update') {
      if (failGrant) { res.writeHead(503); return res.end(); }
      permissions = JSON.parse(body).object_permission;
      return res.end('{}');
    }
    if (req.method === 'DELETE') { records = records.filter((row) => !req.url.endsWith(row.agent_id)); return res.end('{}'); }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const registry = liteLLMRegistry({
    url: `http://127.0.0.1:${server.address().port}`, adminKeyFile: join(dir, 'admin-key'),
    teamId: 'fleet', grantLockDirectory: join(dir, 'grant-lock'),
  });
  const agent = {
    name: 'test-agent', description: 'Test agent', listener: 'http://100.82.9.79:8766/', token: 'private-listener-token',
    skills: [{ id: 'chat', name: 'Chat', description: 'Talk', tags: [] }],
  };
  let saved;
  try {
    // Creation succeeds but the grant fails: ownership is kept, and the retry does not create again.
    failGrant = true;
    await assert.rejects(registry.publish(agent, undefined, (value) => { saved = value; }));
    assert.equal(saved?.id, 'owned-id');
    failGrant = false;
    await registry.publish(agent, saved, (value) => { saved = value; });
    assert.equal(creates, 1);
    assert.equal(records[0].agent_card_params.url, 'http://100.82.9.79:8766');
    assert.deepEqual(permissions, { agents: ['unrelated', 'owned-id'], vector_stores: ['preserve-me'] });

    // Lost local ownership: the exact name, URL and token adopt the existing record.
    await registry.publish(agent, undefined, (value) => { saved = value; });
    assert.equal(creates, 1);
    await assert.rejects(registry.publish({ ...agent, token: 'different' }, saved, () => {}), /gateway_name_conflict/);
    outage = true;
    await assert.rejects(registry.publish(agent, saved, () => {}));
    outage = false;

    records.push({ agent_id: 'other-id', agent_name: 'other-agent' });
    await registry.withdraw(agent, saved);
    assert.deepEqual(records.map((row) => row.agent_id), ['other-id']);
    assert.deepEqual(permissions.agents, ['unrelated']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
