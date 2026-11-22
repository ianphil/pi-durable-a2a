# A small persistent agent and client

[`agent.js`](agent.js) uses Pi's configured model runtime, one SQLite-backed
Durable conversation, native A2A on loopback, and ordered shutdown. No tools,
custom model integration, gateway registration or deployment machinery.
[`client.js`](client.js) calls it with the official A2A SDK.

## Run the agent

From the repository root, with Node 22.19 or newer:

```sh
npm ci --ignore-scripts
export PI_PROVIDER='<your configured Pi provider>'
export PI_MODEL='<a model on that provider>'
export A2A_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
node examples/agent.js
```

Configure/authenticate the provider in Pi first, using `/login` or Pi's
`models.json` for a compatible endpoint. `ModelRuntime` uses that configuration
and credentials, just as Pi does. Requests make real, potentially billable model
calls. Keys are not put in the conversation. The script refreshes its model and
instructions on each start.

The default port is 8766; set `A2A_PORT` to use another. Keep the same listener
token so existing callers can reconnect after a restart.

## Call it

In another terminal, set `A2A_TOKEN` to the same listener token:

```sh
node examples/client.js
```

The client sends a random marker, retries the same message ID, asks a follow-up
that recalls the marker, and gets the original completed task. It checks the
responses and prints the saved task ID and answer. All calls share one
conversation; no new context is allocated for the follow-up.

For another port, set `A2A_URL` to the agent's base URL. Use the canonical URL:
the client confines credentials to that origin and refuses redirects.

## Restart and retrieve

Press Ctrl-C in the agent terminal, then run it again. In the client terminal,
use the ID printed by the first run:

```sh
TASK_ID='<saved task ID>' node examples/client.js
```

This gets the saved task without creating another model request. History and A2A
records remain in `examples/.state/agent.sqlite`; pending work resumes under
Durable's retry policy. State files are ignored by Git and can contain private
messages. Run only one agent process against this store at a time.

All foreground work must come through A2A. Do not add independent host input or
automatic follow-up runs to this conversation: cancellation is conversation-wide.
This is a local example, not a TLS server or a production deployment. See the
[main README](../README.md#semantics) for the complete limits.
