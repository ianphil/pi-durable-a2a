# pi-durable-a2a

Turn a [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
conversation into an [A2A](https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md)
agent, and optionally publish it through a LiteLLM A2A gateway.

The official [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) handles the
protocol. Each accepted message creates a Durable `a2a.task`, which submits to the
conversation and parks until the submission settles. The SDK task store is a
read-only translation of Durable records, not a second copy. Task records,
message-ID bindings, results, cancellation and recovery all live in the host's
Durable store. Backups need only that store. Stored identifiers, version-1 layouts
and the migration policy are documented in [Stored format](#stored-format).

Status: early. [v0.1.0](https://github.com/ianphil/pi-durable-a2a/releases/tag/v0.1.0)
is a GitHub-only source release; this package is not published to npm. Targets
A2A wire version `1.0`, `@a2a-js/sdk` 1.3.0 and Pi Durable 1.6.0. The design comes
from [Genesis Durable](https://github.com/ianphil/genesis-durable)'s A2A bridge.

## Install

Requires Node 22.19 or newer. No build step or install scripts are needed. This
package has no separate SQLite dependency or A2A database migration command.
The host chooses its Durable storage backend.

```sh
npm install --ignore-scripts github:ianphil/pi-durable-a2a#v0.1.0 @earendil-works/pi-durable@1.6.0 @earendil-works/chord@1.6.0
```

## Serve a conversation

Start with the [quickstart](docs/quickstart.md) to run
[`examples/agent.js`](examples/agent.js) and [`examples/client.js`](examples/client.js),
then restart and retrieve a saved task. They use Pi's model runtime, SQLite and
native A2A, with no tools or gateway setup.

**All foreground work in the served conversation must come through A2A.** Do not
submit independent host input or automatic follow-up runs into it. Use separate
conversations for those inputs. Durable 1.6.0 only offers conversation-wide abort
for placed submissions: canceling A2A work can otherwise stop a newer, unrelated
host run. Outcome reporting preserves an answer or failure that won the race,
but that does not make abort submission-scoped.

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

`POST /` is not served by default. It can be added explicitly for LiteLLM task
forwarding through the optional module below.

### Mount in a host's Node server

Use the same callback as the convenience server, without another HTTP framework:

```js
import { createServer } from 'node:http';
import { createA2AHttpHandler } from 'pi-durable-a2a';

const a2aHttp = createA2AHttpHandler(a2a, { token });
const server = createServer((req, res) => {
  if (req.url === '/other') { res.end('Host-owned endpoint'); return; }
  return a2aHttp(req, res);
});
server.listen(8766, '127.0.0.1');
```

These are alternatives to the server creation in the first example. The host
chooses which requests to delegate and configures its server timeouts. The
convenience server keeps its 10-second request and 5-second header timeouts.
Neither form closes the Durable harness; use the same ordered shutdown above.

Express hosts can already mount the SDK's `jsonRpcHandler` and `agentCardHandler`
against `a2a.handler`, with their existing authentication/user builder. This
package does not duplicate those adapters or require Express.

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
- **Storage policy belongs to the host and Durable.** This library imposes no
  task-count quota or expiration window and does not prune/archive records.
  Message bindings and results remain available while retained in Durable.
  Removing the former lifetime cap is not a claim that storage growth is bounded.
- **No exactly-once side effects.** Durable may repeat interrupted tool calls
  according to each tool's replay policy. Tools with external effects need their
  own reconciliation.

The bearer token authenticates the listener, not individual callers. HTTP is
unencrypted: use it only on a private network such as a tailnet.

## Stored format

These version-1 names and values are compatibility contracts in Durable:

| Name | Stored value |
| --- | --- |
| `a2a.task` | Background task input: `{ messageId, text, hash, acceptedAt }` |
| `a2a.message` | Conversation document family keyed by exact message ID: `{ taskId, hash }` |
| `a2a.admission` | Conversation document: `{ active }`, the last admitted task ID |

Text parts are joined with `\n`; `hash` is their UTF-8 SHA-256 digest and
`acceptedAt` is wall-clock milliseconds. The task and message binding are created
atomically. Both document kinds use `history: 'latest'` and `fork: 'initial'`;
forks start with fresh A2A bindings. An obsolete admission `count` is ignored,
and a terminal `active` pointer does not mean the conversation is busy.

The task starts at `{ phase: 'submit' }`, then commits submission admission and
parking together at `{ phase: 'answer', submissionId }`, waiting on
`SubmissionSettled.key('answer')`. New submission request IDs are
`a2a.task:<task ID>`; cancellation uses the committed submission's actual request
ID, including older `a2a:<message ID>` requests. Result-message IDs are
`<task ID>:answer`. Durable IDs are numeric internally and canonical decimal
strings for A2A task/context IDs. Outcomes are the completed answer string,
failure or abort; arbitrary failure diagnostics stay private.

The current view supports task version `1` only and refuses unknown/future
versions without interpreting or rewriting them. Incompatible changes must keep
stored names stable, increment the definition version and use Durable's migration
callbacks, with tests against old records. Preserve task IDs, bindings, outcomes
and submission associations, including terminal records. Back up before upgrading;
downgrade support is not promised—restore a compatible backup instead.

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
only Durable. Version-1 identifiers and upgrade policy are in [Stored format](#stored-format).
This is an early API; the former separate-database API is not preserved.

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
- `withdraw` removes only records this agent owns. It revokes the grant before
  deleting the registration, so a failed withdrawal can be retried.
- Gateway redirects are refused: supply the canonical gateway URL.

### LiteLLM task forwarding

LiteLLM 1.106.6 forwards task controls to the registered base URL without the
version header. Add the compatibility transport explicitly when needed:

```js
import { createA2AServer } from 'pi-durable-a2a';
import { liteLLMTaskHandler } from 'pi-durable-a2a/litellm';

const server = createA2AServer(a2a, {
  token,
  extraRoutes: { '/': liteLLMTaskHandler(a2a.handler) },
});
```

The same `extraRoutes` option works with `createA2AHttpHandler` for a host-owned
Node server. It maps additional POST paths to SDK-style `(text, call) => result`
transports. Authentication and the 32 KiB body limit still apply to each route;
`/a2a` always uses the native SDK transport.

The optional module delegates v0.3 `tasks/get` and `tasks/cancel` to the SDK's
compatibility handler. `tasks/list` is LiteLLM's alias for native `ListTasks`, not
an A2A v0.3 method. Native requests on the extra path keep the existing fallback
to the SDK's native handler. This is gateway forwarding compatibility, not a
second protocol implementation or a general gateway framework.

**Upgrading an existing LiteLLM listener requires enabling this route.** Without
it, forwarded task controls to `POST /` return 404. Registration remains a
separate operator step; attaching the route does not register an agent or read
an administrative key.

Remove the compatibility route once native task operations work through the
deployed gateway without it
([BerriAI/litellm#44769](https://github.com/BerriAI/litellm/pull/44769)).

## Development

```sh
npm ci --ignore-scripts
npm test
```

GitHub Actions runs these commands on Node 22 and 24 for pull requests and
pushes to `main`. CI does not publish packages or deploy services.

The tests use one extension-enabled Durable harness fixture on SQLite and the
official SDK client, including restart, concurrent admission, late cancellation
and ordered shutdown. Storage tests kill further backend access during a model
request and cancellation cleanup, then reopen the same SQLite store without a
prior clean harness shutdown. Model recovery follows the configured retry policy;
these tests permit one retry, not exactly-once model execution. HTTP tests cover
native-only serving, mounting beside host routes, and explicitly enabled LiteLLM
get/list/cancel forwarding, including authentication and body limits. LiteLLM
registration uses a local stand-in. Tests use local HTTP listeners but need no
model credentials or external network access.

### Read-only live SDK smoke

With a reachable, already registered agent and an operator-supplied messaging
key, run from this checkout:

```sh
export A2A_URL='<agent URL>'
export A2A_TOKEN_FILE='<private messaging-key file>'
export A2A_SLOW_PROMPT='<slow read-only request appropriate for this agent>'
node scripts/gateway-smoke.js
```

The key is sent only to the configured URL's origin (scheme, host and port).
An Agent Card advertising another origin is refused before contacting that
endpoint. HTTP redirects are rejected; supply the canonical agent URL rather
than a redirecting alias.

The official SDK performs discovery and all task operations. The script checks
send/get, message-ID retries and conflicting text, a follow-up that recalls a
random marker, paginated list, start/working/completion, busy rejection and
cancellation followed by a stable canceled read. It emits step names and task
IDs, not credentials or full answers. On failure it attempts to cancel only work
it started and reports any cleanup failure.

Choose a read-only slow request long enough to observe working and cancel a
second run; a task finishing before these checks is not evidence of broken
cancellation. Prompts are not a sandbox or an authorization policy. This script
does not register/deregister agents, change gateway grants, deploy services or
claim crash recovery. Fleet-specific prompts, restart/crash commands, the real
Pi client workflow and evidence belong in the private deployment runbook.

The local test exercises this script's flow with a real SDK client and Durable
harness using explicitly gated scripted models. It does not contact a gateway
or need model credentials. Passing it is not proof of a deployed gateway.

The local cancellation-scope diagnostic remains available:

```sh
node scripts/probe-cancellation-scope.js
```

It reproduces the known unrelated-host-run hazard outside the exclusive-A2A
contract. It is not a passing claim that cancellation is submission-scoped.

## License

MIT. See `LICENSE`.
