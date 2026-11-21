# Draft: submission-scoped cancellation from Durable task code

**Status: prepared, not filed upstream.** The user decides the target repository,
wording and submission timing. This is a capability request, not a finalized API.

## Problem

An extension task can submit input to an existing Durable conversation and park
on `SubmissionSettled`. It needs to cancel the logical run answering that input,
without stopping a newer, independent run in the same conversation.

In Durable 1.6.0:

- `Submission.abort()` / `Harness.abortSubmission()` withdraw queued input but
  return `already_placed` for running input.
- Task code can then call its conversation handle's `abort()`, but that operation
  targets the current ordinary conversation scope, not the particular submission.
- `TaskRuntime.abortOwned()` cannot stop the conversation-owned generation: it
  is not owned by the extension's observer task.
- `Harness.abortTask()` is available to hosts, not as a general task-runtime
  capability. A generation task ID also changes as the logical run hands off
  across model/tool turns, so capturing one generation is insufficient.

Calling `Submission.abort()` followed by `conversation.abort()` has a race:

1. The first call sees the extension's input placed and returns `already_placed`.
2. That input finishes normally.
3. The host starts a new run with another input.
4. The extension's conversation-wide abort cancels the new run.

Another status read before abort only moves the race window. Writing scheduler
abort marks through internal transaction APIs is not a sound extension contract.

## Reproduction

The public pi-durable-a2a prototype in [PR #11](https://github.com/ianphil/pi-durable-a2a/pull/11)
includes a local, deterministic probe:

```sh
npm ci --ignore-scripts
node scripts/probe-cancellation-scope.js
```

It uses the real Durable harness and in-memory storage with scripted models. It
pauses only the extension's abort invocation after `already_placed`, lets its
submission settle, admits a new independent host input, then resumes the original
conversation-wide abort call. No scheduler implementation is modified.

Observed result:

```json
{
  "a2aSubmissionBeforeHandoff": "done",
  "hostSubmission": { "status": "unanswered", "reason": "aborted" },
  "a2aTask": "completed"
}
```

The completed A2A task is intentional: pi-durable-a2a now preserves the actual
settled outcome when cancellation loses. The remaining defect is that an
unrelated host input is aborted.

## Requested semantics

Provide a public submission-scoped cancellation operation usable through task
code's submission/conversation handles, including an abort invocation:

- **Queued:** withdraw the selected input using Durable's admission rules.
- **Placed and unsettled:** atomically locate and mark the logical run owning
  that submission, with Durable handling its tool/subagent cleanup and cascades.
- **Settled:** report the existing settlement; never touch a newer run.
- **Joining:** allow the caller to await that run's cancellation/settlement without
  waiting for unrelated work admitted afterwards.
- **Durability:** persist cancellation intent before acknowledging it. A restart
  during cleanup resumes the selected cancellation, not a conversation-wide one.
- **Idempotency:** repeated cancellation is safe. An already completed answer or
  failure is not rewritten as canceled.
- **Wait cancellation:** canceling a caller's wait stops the wait, not the stored
  cancellation or the run's cleanup.
- **Multiple inputs:** define what happens when several submissions share one
  steered run. Canceling an owning run may affect its other inputs, but must not
  affect a later independent run.

This might extend an existing submission operation or introduce a new one; the
maintainers should choose the API shape. A plain task-ID abort capability alone
would still need a safe logical-run handoff strategy.

## Suggested upstream acceptance tests

1. Cancel queued input without starting it.
2. Cancel a running input and await model/tool cleanup.
3. Cancel while generation hands off across a tool round.
4. Complete the original input and start another run at the cancellation boundary;
   the new run must remain untouched.
5. Retry a cancellation after the selected input is already settled.
6. Crash after cancellation is recorded and reopen; cleanup continues for only
   the selected run and preserves the true outcome.
7. Interrupt only the caller's wait and verify cancellation still completes.

## Temporary consumer restriction

The prototype currently requires all foreground activity in its served
conversation to come through A2A. Hosts must keep other input and automatic
follow-up runs in separate conversations. A supported scoped operation would
let us remove that restriction without moving cancellation state outside Durable.
