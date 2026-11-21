import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { CancelTaskRequest, GetTaskRequest, ListTasksRequest, SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';

const terminal = new Set([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_REJECTED]);

/** Read-only live checks against an SDK client; no registration or deployment. */
export async function runGatewaySmoke(client, {
  slowPrompt, pollMs = 250, timeoutMs = 300_000,
  report = (event) => console.log(JSON.stringify(event)),
}) {
  assert.ok(slowPrompt, 'Provide a slow, read-only request appropriate for the agent');
  const prefix = `smoke-${randomUUID()}`;
  const marker = `${prefix}-marker`;
  const pending = new Set();
  let contextId;
  const send = async (suffix, text, returnImmediately = false) => {
    const task = await client.sendMessage(SendMessageRequest.fromJSON({
      message: { messageId: `${prefix}-${suffix}`, contextId, role: 'ROLE_USER', parts: [{ text }] },
      configuration: { returnImmediately },
    }));
    assert.ok('id' in task, 'Expected a task, not a message');
    if (!terminal.has(task.status?.state)) pending.add(task.id);
    return task;
  };
  const get = (id) => client.getTask(GetTaskRequest.fromJSON({ id }));
  const waitFor = async (id, state) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = await get(id);
      if (task.status?.state === state) return task;
      assert.ok(!terminal.has(task.status?.state), `Task ${id} ended before ${TaskState[state]}`);
      await delay(pollMs);
    }
    throw new Error(`Timed out waiting for task ${id} to reach ${TaskState[state]}`);
  };
  const slow = `Read-only integration check: do not change GitHub or any files, and do not read credentials. ${slowPrompt}`;
  try {
    const firstPrompt = `Read-only check. Do not use tools or write anything. Remember ${marker} and reply with only that marker.`;
    const first = await send('first', firstPrompt);
    contextId = first.contextId;
    assert.equal(first.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.ok(JSON.stringify(first.status).includes(marker), 'First answer must contain the marker');
    assert.equal((await get(first.id)).id, first.id);
    await report({ check: 'send/get', taskId: first.id, messageId: `${prefix}-first`, contextId });

    const duplicate = await send('first', firstPrompt);
    assert.equal(duplicate.id, first.id);
    await assert.rejects(send('first', `${firstPrompt} Changed text.`));
    await report({ check: 'idempotency/conflicting-text', taskId: first.id });

    const followUp = await send('follow-up', 'Read-only follow-up. Do not use tools or write anything. What marker did I ask you to remember? Reply with only that marker.');
    assert.equal(followUp.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(followUp.contextId, contextId);
    assert.notEqual(followUp.id, first.id);
    assert.ok(JSON.stringify(followUp.status).includes(marker), 'Follow-up must recall the earlier marker');
    await report({ check: 'follow-up', taskId: followUp.id });

    const wanted = new Set([first.id, followUp.id]);
    const cursors = new Set();
    let pageToken;
    let pages = 0;
    do {
      const page = await client.listTasks(ListTasksRequest.fromJSON({ contextId, pageSize: 1, pageToken }));
      assert.equal(page.tasks.length, 1, 'One task per page');
      for (const task of page.tasks) wanted.delete(task.id);
      pages++;
      pageToken = page.nextPageToken;
      if (pageToken) {
        assert.ok(!cursors.has(pageToken), 'Pagination must advance');
        cursors.add(pageToken);
      }
    } while (wanted.size && pageToken);
    assert.equal(wanted.size, 0, 'Listing must contain both newly created tasks');
    assert.ok(pages >= 2, 'Pagination must cross a page boundary');
    await report({ check: 'paginated-list', pages });

    const started = await send('poll', slow, true);
    await report({ check: 'started', taskId: started.id, messageId: `${prefix}-poll`, contextId });
    await waitFor(started.id, TaskState.TASK_STATE_WORKING);
    await assert.rejects(send('busy', 'Read-only: reply with OK.', true), /busy/i);
    await report({ check: 'working/busy', taskId: started.id });
    await waitFor(started.id, TaskState.TASK_STATE_COMPLETED);
    pending.delete(started.id);
    await report({ check: 'polled-completed', taskId: started.id });

    const canceling = await send('cancel', slow, true);
    await waitFor(canceling.id, TaskState.TASK_STATE_WORKING);
    const canceled = await client.cancelTask(CancelTaskRequest.fromJSON({ id: canceling.id }));
    assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
    assert.equal((await get(canceling.id)).status?.state, TaskState.TASK_STATE_CANCELED);
    pending.delete(canceling.id);
    await report({ check: 'canceled/stable-get', taskId: canceling.id });
    return { firstTaskId: first.id, contextId, messageId: `${prefix}-first`, firstPrompt };
  } finally {
    for (const id of pending) {
      try {
        if (!terminal.has((await get(id)).status?.state)) await client.cancelTask(CancelTaskRequest.fromJSON({ id }));
      } catch (error) {
        await report({ check: 'cleanup-failed', taskId: id, error: error.message });
      }
    }
  }
}

async function main() {
  const { A2A_URL: url, A2A_TOKEN_FILE: tokenFile, A2A_SLOW_PROMPT: slowPrompt } = process.env;
  assert.ok(url && tokenFile && slowPrompt, 'Set A2A_URL, A2A_TOKEN_FILE and A2A_SLOW_PROMPT');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const fetchImpl = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  const client = await new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  }).createFromUrl(url);
  await runGatewaySmoke(client, { slowPrompt });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
