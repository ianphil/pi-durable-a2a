# A small persistent agent

[`agent.js`](agent.js) is a complete host: one OpenAI provider, one SQLite-backed
Durable conversation, native A2A on loopback, and ordered shutdown. No tools,
gateway registration or deployment machinery.

## Run

From the repository root, with Node 22.19 or newer:

```sh
npm ci --ignore-scripts
export OPENAI_API_KEY='<your API key>'
export MODEL_ID='gpt-4o-mini'
export A2A_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
node examples/agent.js
```

Use a model in the provider's catalog that your account can access. Requests make
real, potentially billable model calls. The provider reads its key from the
environment; no key is put in the conversation. Keep the same listener token if
you want existing callers to reconnect after a restart.

## Send a message

In another terminal, set `A2A_TOKEN` to the same listener token, then:

```sh
curl -sS http://127.0.0.1:8766/a2a \
  -H "Authorization: Bearer $A2A_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'A2A-Version: 1.0' \
  --data-binary @- <<'JSON'
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "hello-1",
      "role": "ROLE_USER",
      "parts": [{ "text": "Remember that my name is Ada. Say hello." }]
    }
  }
}
JSON
```

The response is a task; answer text is in `result.task.status.message`.
For a follow-up, use a new `messageId`, such as `hello-2`, and ask "What is my
name?" All calls share the saved conversation; no new context is allocated.

Press Ctrl-C to stop. Restart the same command: conversation history and A2A
records remain in `examples/.state/agent.sqlite`, and pending work resumes under
Durable's retry policy. The script refreshes model/instructions on startup.
State files are ignored by Git; they can contain private messages.

All foreground work must come through A2A. Do not add independent host input or
automatic follow-up runs to this conversation: cancellation is conversation-wide.
This is a local example, not a TLS server or a production deployment. See the
[main README](../README.md#semantics) for the complete limits.
