# pi-durable-a2a

Turn a [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
conversation into an [A2A](https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md)
agent, and optionally publish it through a LiteLLM A2A gateway.

The official [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) handles the
protocol. Each accepted message creates a Durable `a2a.task`, which submits to the
conversation and parks until the submission settles. The SDK task store is a
read-only translation of Durable records, not a second copy. Task records,
message-ID bindings, results, cancellation and recovery all live in the host's
Durable store. Backups need only that store.

Status: early. Targets A2A wire version `1.0`, `@a2a-js/sdk` 1.3.0 and Pi Durable
1.6.0. The design comes from [Genesis Durable](https://github.com/ianphil/genesis-durable)'s
A2A bridge.

## Install

Requires Node 22.19 or newer. No build step or install scripts are needed. This
package has no separate SQLite dependency or A2A database migration command.
The host chooses its Durable storage backend.

```sh
npm install --ignore-scripts github:ianphil/pi-durable-a2a @earendil-works/pi-durable@1.6.0 @earendil-works/chord@1.6.0
```

## Serve a conversation

**All foreground work in the served conversation must come through A2A.** Do not
submit independent host input or automatic follow-up runs into it. Use separate
conversations for those inputs. Durable 1.6.0 only offers conversation-wide abort
for placed submissions: canceling A2A work can otherwise stop a newer, unrelated
host run. Outcome reporting preserves an answer or failure that won the race,
but that does not make abort submission-scoped. See the
[cancellation findings](docs/durable-task-prototype.md#cancellation-decision-still-open).

Install the extension **before opening/resuming the harness**, on every restart:

```js
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { A2AExtension, openA2A, createA2AServer } from 'pi-durable-a2a';

// Your host supplies models, model, instructions and a listener token.
const registry = createRegistry();
registry.install(A2AExtension);
// Install your host's tools and other extensions in the same registry.
const harness = await Harness.open(
  await openNodeSqliteStorage('./state/durable.sqlite'),
  { models, registry },
  context,
);
const conversation = await harness.root(context, { agent: { model, instructions } });
const a2a = await openA2A({
  harness,
  conversation,
  card: {
    name: 'my-agent',
    description: 'What this agent does',
    url: 'http://127.0.0.1:8766/a2a', // the URL callers reach
    skills: [{ id: 'chat', name: 'Chat', description: 'Talk to the agent', tags: [] }],
  },
});
harness.resume(); // Durable resumes accepted A2A tasks; no bridge recovery loop
const server = createA2AServer(a2a, { token }); // 32+ base64url characters
server.listen(8766, '127.0.0.1');

// Stop accepting HTTP first. Finish accepted cancellation cleanup before closing
// Durable; other accepted work remains pending and resumes on the next open.
server.close();
await a2a.close();
await harness.close(context);
```

Pass the harness that owns the conversation. The bridge does not install
extensions, create or close the harness, choose models, or configure tools.
For remote callers, choose a private-network bind address and reachable card URL;
the example binds only to loopback.

The listener serves:

| Route | Purpose |
| --- | --- |
| `GET /health` | Unauthenticated liveness |
| `GET /.well-known/agent-card.json` | Agent Card, bearer token required |
| `POST /a2a` | Native JSON-RPC (`SendMessage`, `GetTask`, `ListTasks`, `CancelTask`) |
| `POST /` | LiteLLM's task forwarding, which uses v0.3 method names (see below) |

## Semantics

- **One shared conversation.** Every authorized caller shares one A2A context and
  one Durable conversation. Context IDs do not isolate callers; unrelated context
  IDs and tenants are rejected.
- **One run at a time.** A message that arrives while one is working is refused
  as busy. A follow-up is a new task in the same context. Task continuation,
  steering and references to other tasks are not supported.
- **Message IDs are idempotency keys.** Resending a message ID reuses its task;
  reusing it for different text is refused. Blocking retries wait for settlement;
  immediate retries return the current state. Each request honors its history
  length option without changing the stored result.
- **Tasks outlive requests.** A caller that disconnects stops waiting, not the
  work. Send with `returnImmediately: true` to get the current task promptly and
  poll it. Pending tasks show submitted; started and parked tasks show working.
- **Cancellation waits for Durable.** A task is canceled only after its
  submission settles aborted. An answer or failure that wins a late cancellation
  keeps its actual outcome; `CancelTask` rejects it as not cancelable.
- **Restarts keep work.** With persistent Durable storage, task records and
  results survive restart. Reinstall `A2AExtension` and resume the harness.
- **Shutdown is ordered.** `a2a.close()` refuses new task requests and stops
  request-side waits, not Durable work. It joins accepted requests, cancellation
  cleanup, SDK event drains and executor readers. Close the harness afterwards.
- **Text only.** Plain-text input up to 16 KiB and answers up to 64 KiB (a longer
  answer fails the task; the full text stays in Durable). No streaming, push
  notifications or artifacts.
- **Listing uses Durable cursors.** Newest task IDs come first. Status/timestamp
  filters and exact totals currently scan records; only returned tasks are
  translated into SDK snapshots. Zero matches return immediately after the count
  pass; a first page returning all matches skips further lookahead. Scan-only
  listing does not write a storage commit.
- **Capacity is currently a lifetime cap.** Each served conversation accepts at
  most 10,000 tasks. Retention/pruning and its idempotency window are not yet
  implemented; see [#3](https://github.com/ianphil/pi-durable-a2a/issues/3).
- **No exactly-once side effects.** Durable may repeat interrupted tool calls
  according to each tool's replay policy. Tools with external effects need their
  own reconciliation.

The bearer token authenticates the listener, not individual callers. HTTP is
unencrypted: use it only on a private network such as a tailnet.

## Upgrading from the separate-database bridge

`openA2A` now requires `{ harness, conversation, card }` and a host-installed
`A2AExtension`. The old `database` option is rejected. There is no automatic
migration of old A2A task IDs, contexts or admissions from `a2a.sqlite`; an
existing Durable conversation's transcript is not replaced. New submissions use
Durable-task-ID request keys, not the former message-ID keys, so an old submission
without the new task's notification cannot be accidentally adopted. Cancellation
uses the request ID in the task's committed submission record.

Stop the old listener and settle pending work before upgrading. Archive its A2A
store if you need its task history. New admissions and all new task state use
only Durable. The task/document naming and retention contracts are still being
finalized; this is an early API, not a compatibility-preserving release.

## Publish through LiteLLM

`pi-durable-a2a/litellm` registers the agent in LiteLLM's A2A registry and grants a
team discovery access. LiteLLM stores the listener token privately and
authenticates to the listener with it.

```js
import { liteLLMRegistry } from 'pi-durable-a2a/litellm';

const registry = liteLLMRegistry({
  url: gatewayUrl,
  adminKeyFile, // supplied by the operator, outside the agent's reach
  teamId,
  grantLockDirectory: './state/grant-lock',
});
await registry.publish(
  { name, description, skills, listener: listenerUrl, token },
  saved, // the registration persisted by an earlier run, if any
  (registration) => save(registration), // persist before the grant
);
await registry.withdraw(agent, saved);
```

This uses LiteLLM's **administrative** key. Run it as an operator step, never from
a model-callable tool or with the key inside the agent's reach.

- `publish` creates the registration, or adopts an existing one only when its
  name, URL and token all match. It persists ownership before granting, so a
  failed grant is retried without creating a duplicate.
- Grants are read, modified and written, preserving other permissions. LiteLLM
  offers no atomic append: registrars updating the same team must run one at a
  time. The lock directory coordinates only callers that share it.
- `withdraw` removes only records this agent owns.

### LiteLLM task forwarding

LiteLLM 1.106.6 forwards `GetTask`, `ListTasks` and `CancelTask` to the registered
base URL as v0.3 `tasks/get`, `tasks/list` and `tasks/cancel`, without the version
header. `POST /` translates those through the SDK's compatibility handler. Remove
it once native task operations pass through the deployed gateway
([BerriAI/litellm#44769](https://github.com/BerriAI/litellm/pull/44769)). This route
is unchanged here; making it opt-in belongs to #6.

## Development

```sh
npm ci --ignore-scripts
npm test
```

The tests use one extension-enabled Durable harness fixture on SQLite and the
official SDK client, including restart, concurrent admission, late cancellation
and ordered shutdown. LiteLLM registration uses a local stand-in. They need no
model credentials or network access.

The local cancellation-scope diagnostic remains available:

```sh
node scripts/probe-cancellation-scope.js
```

It reproduces the known unrelated-host-run hazard outside the exclusive-A2A
contract. It is not a passing claim that cancellation is submission-scoped.

## License

MIT. See `LICENSE`.
