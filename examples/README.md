# A small persistent agent and client

Start with the [quickstart](../docs/quickstart.md): run the agent, call it, restart
it, and retrieve the original task.

- [`agent.js`](agent.js) uses Pi's configured model runtime, one SQLite-backed
  Durable conversation, native A2A on loopback and ordered shutdown. No tools,
  custom model integration or gateway registration.
- [`client.js`](client.js) uses the official A2A SDK to send, retry the same
  message ID, ask a context-preserving follow-up and get the completed task.
  With `TASK_ID`, it retrieves a saved task without creating another model run.

Run from the repository root. State lives in `examples/.state/` and is ignored
by Git. Keep it private and run only one agent process against it. All foreground
input must come through A2A; see the [full semantics](../README.md#semantics).
