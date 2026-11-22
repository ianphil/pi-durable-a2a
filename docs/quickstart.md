# Quickstart: run the example agent and client

Run a small persistent assistant locally, call it through A2A, then restart it
and retrieve the same answer. Pi handles the model, Durable handles state, and
the official A2A SDK handles communication. No tools or gateway registration.

## 1. Prepare

You need Node 22.19 or newer and a model provider already configured in Pi.
Use Pi's `/login` and `/model`, or its `models.json` for a compatible endpoint.
The agent uses Pi's `ModelRuntime`; it does not need a separate model client.
Model requests may be billable. The shell commands below use Bash.

Use a current repository checkout—the examples were added after the initial
`v0.1.0` release:

```sh
git clone https://github.com/ianphil/pi-durable-a2a.git
cd pi-durable-a2a
npm ci --ignore-scripts
```

If you already have the checkout, work from its root. Both terminals below must
use that directory.

## 2. Start the agent

In the first terminal, set your Pi provider and model:

```sh
export PI_PROVIDER='<your configured Pi provider>'
export PI_MODEL='<a model on that provider>'
```

Create a private listener token **once**. This is not your model API key:

```sh
umask 077
mkdir -p examples/.state
if ! test -f examples/.state/listener-token; then
  node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))' > examples/.state/listener-token
fi
export A2A_TOKEN="$(<examples/.state/listener-token)"
node examples/agent.js
```

The agent listens at `http://127.0.0.1:8766/a2a`. Leave it running.
[`agent.js`](../examples/agent.js) installs `A2AExtension`, opens SQLite,
configures one conversation and serves native A2A. Model credentials stay in
Pi's configuration, not in that conversation.

## 3. Call the client

In a second terminal, from the same repository root:

```sh
export A2A_TOKEN="$(<examples/.state/listener-token)"
node examples/client.js
```

[`client.js`](../examples/client.js) checks four things:

1. Send a random marker and receive it in the answer.
2. Retry the same message ID and text; receive the same task, not another run.
3. Ask a follow-up that recalls the marker from the shared conversation.
4. Get the original completed task and check its answer is unchanged.

It prints `Saved task: <id>` and the task JSON. Keep that ID for the next step.

## 4. Restart and retrieve

Press Ctrl-C in the agent terminal. Its shutdown closes HTTP, then the A2A
adapter and Durable harness. Start it again in that same terminal:

```sh
node examples/agent.js
```

In the client terminal, use your saved task ID:

```sh
TASK_ID='<saved task ID>' node examples/client.js
```

This reads the original completed task without a new model request. The saved
answer, history and timestamp should be unchanged. Conversation history and
A2A records live in `examples/.state/agent.sqlite`; keep that store and the same
listener token across restarts. State files are ignored by Git and can contain
private messages.

## If something goes wrong

- **Unknown Pi model:** check both `PI_PROVIDER` and `PI_MODEL` against your Pi
  configuration. Provider ID and model ID are separate values.
- **Unauthorized:** both terminals must use the same listener token.
- **Port already in use:** set `A2A_PORT=8767` in the agent terminal and
  `A2A_URL=http://127.0.0.1:8767` in the client terminal.
- **Client only retrieves an old task:** unset an exported `TASK_ID` to run the
  send/follow-up check again.

Run only one agent process against this store. All foreground input must come
through A2A; do not add independent host submissions or automatic follow-up runs.
Cancellation is conversation-wide in the targeted Durable version. This example
is loopback-only, not a TLS server or production deployment. See the
[full semantics](../README.md#semantics) and [stored format](../README.md#stored-format).
