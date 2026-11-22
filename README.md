# pi-durable-a2a

Turn a [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
conversation into an [A2A](https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md)
agent, and optionally publish it through a LiteLLM A2A gateway.

Each accepted message creates a Durable `a2a.task`, which submits to the
conversation and parks until the submission settles. `A2AHandler` implements the
official [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) request
handler interface on top of those tasks: the SDK provides the wire types,
JSON-RPC transport and errors; Durable holds every record. Task records,
message-ID bindings, results, cancellation and recovery all live in the host's
Durable store, so backups need only that store. Stored identifiers, version-1
layouts and the migration policy are in [Stored format](#stored-format).

Status: early. Written in TypeScript; releases are built tarballs attached to
[GitHub releases](https://github.com/ianphil/pi-durable-a2a/releases), not
published to npm. Targets A2A wire version `1.0`, `@a2a-js/sdk` 1.3.0 and Pi
Durable 1.6.0. The design comes from
[Genesis Durable](https://github.com/ianphil/genesis-durable)'s A2A bridge.

## Install

Requires Node 22.19 or newer. Install a release tarball with Pi Durable and Chord;
the host chooses its Durable storage backend:

```sh
npm install --ignore-scripts \
  https://github.com/ianphil/pi-durable-a2a/releases/download/v0.2.0/pi-durable-a2a-0.2.0.tgz \
  @earendil-works/pi-durable@1.6.0 @earendil-works/chord@1.6.0
```

The package ships compiled JavaScript with type declarations.

## Serve a conversation

Start with the [quickstart](docs/quickstart.md) to run
[`examples/agent.ts`](examples/agent.ts) and [`examples/client.ts`](examples/client.ts),
then restart and retrieve a saved task. They use Pi's model runtime, SQLite and
native A2A, with no tools or gateway setup.

**All foreground work in the served conversation must come through A2A.** Do not
submit independent host input or automatic follow-up runs into it. Use separate
conversations for those inputs. Durable 1.6.0 only offers conversation-wide abort
for placed submissions: canceling A2A work can otherwise stop a newer, unrelated
host run. Outcome reporting keeps an answer or failure that won the race, but
that does not make abort submission-scoped.

Install the extension **before opening the Harness**, on every start:

```ts
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { A2AExtension, A2AHandler, createA2AServer } from "pi-durable-a2a";

// Your host supplies models, model, instructions and a listener token.
const registry = createRegistry();
registry.install(A2AExtension);
// Install your host's tools and other extensions in the same registry.
const harness = await Harness.open(await openNodeSqliteStorage("./state/durable.sqlite"), { models, registry }, context);
const conversation = await harness.root(context, { agent: { model, instructions } });
const handler = new A2AHandler({
	harness,
	conversation,
	card: {
		name: "my-agent",
		description: "What this agent does",
		url: "http://127.0.0.1:8766/a2a", // the URL callers reach
		skills: [{ id: "chat", name: "Chat", description: "Talk to the agent", tags: [] }],
	},
});
harness.resume(); // Durable resumes accepted A2A tasks; there is no separate recovery loop
const server = createA2AServer(handler, { token }); // 32+ base64url characters
server.listen(8766, "127.0.0.1");

// Stop accepting HTTP first. Accepted requests, including cancellation cleanup,
// finish before Durable closes; other accepted work resumes on the next open.
server.close();
await handler.close();
await harness.close(context);
```

Pass the Harness that owns the conversation. The handler does not install
extensions, create or close the Harness, choose models, or configure tools. For
remote callers, choose a private-network bind address and reachable card URL;
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

```ts
import { createServer } from "node:http";
import { createA2AHttpHandler } from "pi-durable-a2a";

const a2a = createA2AHttpHandler(handler, { token });
const server = createServer((req, res) => {
	if (req.url === "/other") res.end("Host-owned endpoint");
	else a2a(req, res);
});
server.listen(8766, "127.0.0.1");
```

These are alternatives to the server creation in the first example. The host
chooses which requests to delegate and configures its server timeouts. The
convenience server keeps its 10-second request and 5-second header timeouts.
Neither form closes the Durable Harness; use the same ordered shutdown above.

`A2AHandler` implements the SDK's `A2ARequestHandler`, so hosts using Express can
mount the SDK's `jsonRpcHandler` and `agentCardHandler` with it directly, with
their existing authentication. This package does not require Express.

## Semantics

- **One shared conversation.** Every authorized caller shares one A2A context and
  one Durable conversation. Context IDs do not isolate callers; unrelated context
  IDs and tenants are rejected.
- **One run at a time.** A message that arrives while one is working is refused
  as busy. A follow-up is a new task in the same context. Task continuation,
  steering and references to other tasks are not supported.
- **Message IDs are idempotency keys.** Resending a message ID returns its task;
  reusing it for different text is refused. Blocking retries wait for settlement;
  immediate retries return the current state. Each request applies its own
  history length without changing the stored result.
- **Tasks outlive requests.** A caller that disconnects stops waiting, not the
  work. Send with `returnImmediately: true` to get the current task promptly and
  poll it. Pending tasks show submitted; started and parked tasks show working.
- **Cancellation waits for Durable.** A task is canceled only after its
  submission settles aborted. An answer or failure that wins a late cancellation
  keeps its actual outcome; `CancelTask` rejects it as not cancelable.
- **Restarts keep work.** With persistent Durable storage, task records and
  results survive restart. Reinstall `A2AExtension` and resume the Harness.
- **Shutdown is ordered.** `handler.close()` refuses new requests and stops
  request-side waits, not Durable work. It resolves once accepted requests,
  including cancellation cleanup, have finished. Close the Harness afterwards.
- **Text only.** Plain-text input up to 16 KiB and answers up to 64 KiB (a longer
  answer fails the task; the full text stays in Durable). No streaming, push
  notifications or artifacts.
- **Listing uses Durable cursors.** Newest task IDs come first. Status/timestamp
  filters and exact totals scan records; only returned tasks are translated into
  A2A snapshots. Zero matches return after the count pass; a first page returning
  all matches skips further lookahead. Listing writes no storage commit.
- **Storage policy belongs to the host and Durable.** This library imposes no
  task-count quota or expiration window and does not prune or archive records.
  Message bindings and results remain available while retained in Durable; that
  does not make storage growth bounded.
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
forks start with fresh A2A bindings. A terminal `active` task does not make the
conversation busy.

The task starts at `{ phase: 'submit' }`, then commits submission admission and
parking together at `{ phase: 'answer', submissionId }`, waiting on
`SubmissionSettled.key('answer')`. Submission request IDs are
`a2a.task:<task ID>`; cancellation reacquires the submission by the request ID
stored with it. Result-message IDs are `<task ID>:answer`. Durable IDs are
numeric internally and canonical decimal strings for A2A task and context IDs.
Outcomes are the completed answer string, failure or abort; arbitrary failure
diagnostics stay private.

The handler reads task version `1` only and refuses other versions without
interpreting or rewriting them. Incompatible changes must keep stored names
stable, increment the definition version and use Durable's migration callbacks,
with tests against records of the earlier version. Preserve task IDs, bindings,
outcomes and submission associations, including terminal records. Back up before
upgrading; downgrade support is not promised—restore a compatible backup instead.

## Publish through LiteLLM

`pi-durable-a2a/litellm` registers the agent in LiteLLM's A2A registry and grants a
team discovery access. LiteLLM stores the listener token privately and
authenticates to the listener with it.

```ts
import { liteLLMRegistry } from "pi-durable-a2a/litellm";

const registry = liteLLMRegistry({
	url: gatewayUrl,
	adminKeyFile, // supplied by the operator, outside the agent's reach
	teamId,
	grantLockDirectory: "./state/grant-lock",
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

```ts
import { createA2AServer } from "pi-durable-a2a";
import { liteLLMTaskHandler } from "pi-durable-a2a/litellm";

const server = createA2AServer(handler, { token, extraRoutes: { "/": liteLLMTaskHandler(handler) } });
```

The same `extraRoutes` option works with `createA2AHttpHandler` for a host-owned
Node server. It maps more POST paths to JSON-RPC transports. Authentication and
the 32 KiB body limit apply to each route; `/a2a` always uses the native SDK
transport.

`liteLLMTaskHandler` delegates v0.3 `tasks/get` and `tasks/cancel` to the SDK's
compatibility handler. `tasks/list` is LiteLLM's alias for native `ListTasks`,
not an A2A v0.3 method. Native requests on the extra path go to the SDK's native
handler. This is gateway forwarding compatibility, not a second protocol
implementation or a general gateway framework.

**A listener behind LiteLLM needs this route.** Without it, forwarded task
controls to `POST /` return 404. Registration remains a separate operator step;
attaching the route does not register an agent or read an administrative key.

Remove the compatibility route once native task operations work through the
deployed gateway without it
([BerriAI/litellm#44769](https://github.com/BerriAI/litellm/pull/44769)).

## Development

```sh
npm ci --ignore-scripts
npm run check   # Biome lint and format, then a TypeScript type check
npm test        # Vitest
npm run build   # dist/, as released
```

Source, tests, examples and scripts are strict TypeScript using only erasable
syntax, so Node runs the examples and scripts directly. Tests import the package
by name from its source. GitHub Actions runs the check, tests and build on Node 22
and 24 for pull requests and pushes to `main`. Pushing a `v*` tag that matches the
package version builds the tarball and attaches it to a GitHub release.

The tests use real Durable storage on SQLite and the SDK client, with scripted
faux models gated explicitly rather than timed. They cover restart, concurrent
admission, late cancellation and ordered shutdown. Storage tests make every
further storage operation fail during a model request and during cancellation
cleanup, then reopen the same SQLite store without a clean Harness shutdown.
Model recovery follows the configured retry policy; these tests permit one retry,
not exactly-once model execution. HTTP tests cover native-only serving, mounting
beside host routes, and opt-in LiteLLM get/list/cancel forwarding with
authentication and body limits. LiteLLM registration uses a local stand-in. Tests
use local HTTP listeners and need no model credentials or external network.

### Read-only live SDK smoke

With a reachable, already registered agent and an operator-supplied messaging
key, run from this checkout:

```sh
export A2A_URL='<agent URL>'
export A2A_TOKEN_FILE='<private messaging-key file>'
export A2A_SLOW_PROMPT='<slow read-only request appropriate for this agent>'
npm run smoke
```

The key is sent only to the configured URL's origin (scheme, host and port).
An Agent Card advertising another origin is refused before contacting that
endpoint. HTTP redirects are rejected; supply the canonical agent URL rather
than a redirecting alias.

The SDK client performs discovery and all task operations. The script checks
send/get, message-ID retries and conflicting text, a follow-up that recalls a
random marker, paginated list, start/working/completion, busy rejection and
cancellation followed by a stable canceled read. It emits step names and task
IDs, not credentials or full answers. On failure it attempts to cancel only work
it started and reports any cleanup failure.

Choose a read-only slow request long enough to observe working and cancel a
second run; a task finishing before these checks is not evidence of broken
cancellation. Prompts are not a sandbox or an authorization policy. This script
does not register or deregister agents, change gateway grants, deploy services or
claim crash recovery. Fleet-specific prompts, restart and crash commands, the
real Pi client workflow and evidence belong in the private deployment runbook.

The local test runs this script's checks with an SDK client and a Durable Harness
on explicitly gated scripted models. It does not contact a gateway or need model
credentials. Passing it is not proof of a deployed gateway.

The cancellation-scope diagnostic reproduces the known hazard outside the
A2A-only contract:

```sh
npm run probe
```

It succeeds when A2A cancellation aborts an unrelated host run. It is not a claim
that cancellation is submission-scoped.

## License

MIT. See `LICENSE`.
