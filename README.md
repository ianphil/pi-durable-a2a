# pi-durable-a2a

Serve a [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
conversation as an [A2A](https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md)
agent, and optionally publish it through a LiteLLM A2A gateway.

The official [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) owns protocol handling,
task snapshots and pagination. This package maps each accepted A2A message to one Durable
submission and keeps that association across restarts. Durable owns execution, recovery and
conversation state. The design comes from [Genesis Durable](https://github.com/ianphil/genesis-durable)'s
A2A bridge.

Status: early. Targets A2A wire version `1.0`, `@a2a-js/sdk` 1.3.0 and Pi Durable 1.6.0.

## Install

Requires Node 22.19 or newer. No build step or install scripts are needed:
`better-sqlite3` ships prebuilt binaries.

```sh
npm install --ignore-scripts github:ianphil/pi-durable-a2a @earendil-works/pi-durable@1.6.0 @earendil-works/chord@1.6.0
```

## Serve a conversation

```js
import { openA2A, createA2AServer } from 'pi-durable-a2a';

// Your Durable setup: harness, registry, tools and instructions.
const conversation = await harness.root(context, { agent: { model, instructions } });
harness.resume();

const a2a = await openA2A({
  conversation,
  database: './state/a2a.sqlite', // A2A tasks and admissions; migrated on open
  card: {
    name: 'my-agent',
    description: 'What this agent does',
    url: 'http://100.82.9.79:8766/a2a', // the URL callers reach
    skills: [{ id: 'chat', name: 'Chat', description: 'Talk to the agent', tags: [] }],
  },
});
const server = createA2AServer(a2a, { token }); // 32+ base64url characters
server.listen(8766, '100.82.9.79');

// Shutdown: stop serving, then close the harness. Accepted work resumes on the next open.
server.close();
await a2a.close();
await harness.close(context);
```

The listener serves:

| Route | Purpose |
| --- | --- |
| `GET /health` | Unauthenticated liveness |
| `GET /.well-known/agent-card.json` | Agent Card, bearer token required |
| `POST /a2a` | Native JSON-RPC (`SendMessage`, `GetTask`, `ListTasks`, `CancelTask`) |
| `POST /` | LiteLLM's task forwarding, which uses v0.3 method names (see below) |

## Semantics

- **One shared conversation.** Every authorized caller shares one A2A context and one Durable
  conversation. Context IDs do not isolate callers; unrelated context IDs are rejected.
- **One run at a time.** A message that arrives while one is working is refused as busy.
  A follow-up is a new task in the same context. Task continuation, steering and references
  to other tasks are not supported.
- **Message IDs are idempotency keys.** Resending a message ID returns its existing task;
  reusing it for different text is refused.
- **Tasks outlive requests.** A caller that disconnects stops waiting, not the work. Send with
  `returnImmediately: true` to get a working task and poll it.
- **Cancellation waits for Durable.** A task is reported canceled only after its run has settled.
  A finished task cannot be canceled.
- **Restarts keep work.** Task records and results persist in SQLite, and work accepted before
  a shutdown continues on the next open.
- **Text only.** Plain-text input up to 16 KiB and answers up to 64 KiB (a longer answer fails
  the task; the full text stays in Durable). No streaming, push notifications or artifacts.
- **No exactly-once side effects.** Durable may repeat interrupted tool calls according to each
  tool's replay policy. Tools with external effects need their own reconciliation.

The bearer token authenticates the listener, not individual callers. HTTP is unencrypted: use it
only on a private network such as a tailnet.

## Publish through LiteLLM

`pi-durable-a2a/litellm` registers the agent in LiteLLM's A2A registry and grants a team
discovery access. LiteLLM stores the listener token privately and authenticates to the
listener with it.

```js
import { liteLLMRegistry } from 'pi-durable-a2a/litellm';

const registry = liteLLMRegistry({
  url: 'http://bigbertha:4000',
  adminKeyFile: '/path/to/admin-key',
  teamId: '...',
  grantLockDirectory: './state/grant-lock',
});
await registry.publish(
  { name, description, skills, listener: 'http://100.82.9.79:8766', token },
  saved, // the registration persisted by an earlier run, if any
  (registration) => save(registration), // persist before the grant
);
await registry.withdraw(agent, saved);
```

This uses LiteLLM's **administrative** key. Run it as an operator step, never from a
model-callable tool or with the key inside the agent's reach.

- `publish` creates the registration, or adopts an existing one only when its name, URL and
  token all match. It persists ownership before granting, so a failed grant is retried
  without creating a duplicate.
- Grants are read, modified and written, preserving other permissions. LiteLLM offers no
  atomic append: registrars updating the same team must run one at a time. The lock directory
  coordinates only callers that share it.
- `withdraw` removes only records this agent owns.

### LiteLLM task forwarding

LiteLLM 1.106.6 forwards `GetTask`, `ListTasks` and `CancelTask` to the registered base URL as
v0.3 `tasks/get`, `tasks/list` and `tasks/cancel`, without the version header. `POST /`
translates those through the SDK's compatibility handler. Remove it once native task
operations pass through the deployed gateway
([BerriAI/litellm#44769](https://github.com/BerriAI/litellm/pull/44769)).

## Development

```sh
npm ci --ignore-scripts
npm test
```

The tests run a real Durable harness on SQLite with a scripted model against the official SDK
client, including a restart, and LiteLLM registration against a local stand-in. They need no
model credentials or network access.

## License

MIT. See `LICENSE`.
