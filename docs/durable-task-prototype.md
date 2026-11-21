# Durable-native task design: #1 findings and core follow-up

## Result

**Storage feasibility: go with a translated, read-only SDK store.** On SDK 1.3.0
and Durable 1.6.0, `TaskStore.save` can store nothing. No SDK snapshot document is
needed for the supported text-only, non-streaming protocol.

**Cancellation design: still open.** The shared-conversation contract passes,
but cancellation can stop an unrelated host run after a handoff. The extension
does not support arbitrary host activity in the served conversation; see
[the cancellation decision](#cancellation-decision-still-open) below.

**Current restriction:** all foreground work in the served conversation must
come through A2A. No independent host submissions or automatic follow-up runs
may share it. Separate host conversations are unaffected. This restriction
avoids the unrelated-run hazard; it is not a claim of general scoped cancellation.

#1 proved this with an unexported experiment alongside the old SQLite bridge.
#2 promotes that design to `src/a2a.js`: the public API exports `A2AExtension` and
`openA2A({ harness, conversation, card })`. The second database, startup migration
command, native SQLite dependency and bridge-owned recovery loop are removed.

```sh
node --test test/a2a.test.js
npm test
```

The #1 experiment checked that its contract body was byte-for-byte the same as
the original, with a fixture that installed `A2AExtension` before opening Durable.
#2 consolidates this into one extension-enabled `test/a2a.test.js`, preserving
those assertions and the regressions. The duplicate fixture/body and brittle
source-text comparison are gone.

## Stored layout being evaluated

| Kind | Scope | Version | Contents |
| --- | --- | --- | --- |
| `a2a.task` | Conversation-owned task | 1 | Input: message ID, text, hash, acceptance time. Checkpoint: submit, or answer with submission ID. Outcome: answer text, sanitized failure, or aborted. |
| `a2a.message` | Latest conversation document family, keyed by message ID | 1 | Task ID and content hash. Forks start empty. |
| `a2a.admission` | Latest conversation document | 1 | Most recently admitted task ID. Older admission counts are ignored. Forks start empty. |

Admission checks the binding, the last task, and Durable's live/inbox documents
on the commit line. The binding and task are created in one commit; rejected or
rolled-back admission creates neither. Concurrent identical IDs find one task;
competing new IDs cannot both take the slot. The task submits in its own next
commit and parks on Durable's built-in `SubmissionSettled` signal. Submission
creation and the parked checkpoint commit together. New submissions use the
request ID `a2a.task:<Durable task ID>`, independent of the caller's message ID.
This prevents adoption of old bridge submissions keyed as `a2a:<message ID>`
which lack the observer's settlement notification.

The A2A task is a **background observer**, not the owner of the foreground
`pi.generation` task. This is necessary with the current conversation APIs: its
abort handler calls and awaits `conversation.abort()`, whose ordinary scope
would otherwise include the observer itself and deadlock. Background here does
not mean a second A2A request may run: the stored admission slot still excludes
it until the A2A task is terminal. Once submitted, a host's ordinary conversation
abort stops the foreground work; its settled signal lets the observer finish
canceled. An ordinary conversation abort before the submit phase does not reach
the background observer: the host must abort the A2A task explicitly or use
`conversation.abort(context, { background: true })` to include pending observers.
Do not use a background-inclusive conversation abort from the observer's own
abort handler.

Cancellation before submission creates no input. Once submitted, the handler
reads the request ID from its committed submission record and reacquires that
exact submission, withdraws it if queued, or aborts
and joins the foreground scope if placed. It then maps the actual settled
submission through the same outcome logic as the normal answer phase. If an
answer or failure won before cancellation, that outcome is preserved instead of
being overwritten with canceled. A `CancelTask` request that loses this race is
rejected as not cancelable; task reads report the actual completion/failure.
Recovery is entirely the Durable scheduler's job: install the extension on each
open and resume the harness. There is no A2A recovery scan or execution loop.

## SDK adaptation findings

- `load` creates a fresh A2A task from a Durable record. Task IDs and context IDs
  are decimal strings on the wire, but Durable IDs must be numbers when calling
  the scheduler. A string can appear to work in SQLite reads while bypassing
  the scheduler's numeric-keyed live-task index; conversion matters for waits.
- Pending records show submitted; started, parked and aborting records show
  working; only terminal aborted records show canceled. Result messages and
  history are reconstructed with stable IDs and timestamps. Only the two known
  public failure messages are exposed; arbitrary failed/faulted diagnostics map
  to `Execution unavailable`. Durable retains their private details.
- `ResultManager` can perform its transient load/merge/save operations against
  the view. The executor publishes only snapshots derived from committed tasks;
  it waits for Durable, rather than owning execution. Duplicate sends reuse that
  task without resubmitting: blocking retries wait for settlement, immediate
  retries return the current view, and both honor SDK history-length semantics.
- The SDK's default cancellation implementation skips the executor when there
  is no event bus. After reopening this would only attempt to save a canceled
  snapshot, leaving the run untouched. The prototype handler explicitly invokes
  Durable cancellation and awaits its terminal record, whether a bus exists or
  not.
- The SDK interprets an injected task ID as continuation and refuses a terminal
  task. A new Durable task may finish before SDK request-context creation, so the
  prototype uses the SDK's ordinary new-message validation, then binds its
  `RequestContext` to the already admitted task. Shutdown tracks sends from entry
  through response, including the gap between admission and executor startup,
  then joins SDK event drains before the host closes Durable. Late contexts and
  executors check the stopping flag. A bridge-local abort signal cancels only
  request-side waits, including blocking duplicate retries; accepted Durable work
  is not aborted. These are SDK integration points, not persistent state.
- `list` uses Durable's descending task-ID scan and opaque cursor. SDK status and
  timestamp filters use record metadata, without building messages or reading
  result text. Unfiltered counts use page lengths directly; only tasks in the
  returned page become SDK snapshots. The token binds its cursor to the
  conversation and filters; history-length behavior remains the SDK's. No
  in-memory task collection or copied task table is needed.

## Evidence and remaining work

The original contract covers completion, duplicate/conflicting message IDs,
shared conversation history, busy rejection, pagination, cancellation,
disconnection, clean restart recovery, legacy task forwarding and private
provider errors. Additional prototype tests cover:

- Durable-only files, stored bindings/outcomes, and a forged SDK save that cannot
  change the result;
- admission rollback and concurrent duplicate/competing sends;
- working state while actually parked, filtered cursor continuation, total size,
  and non-mutating history truncation;
- cancellation after reopening without a bus, repeated cancellation and stable
  canceled results after another reopen;
- cancellation while still pending, before any submission or user entry exists;
- blocking and immediate duplicate retries with independent history options;
- closing between admission and executor startup, and closing while a duplicate
  is waiting, without aborting Durable work;
- metadata-only list counting/filtering, with inaccessible unreturned answers;
- late cancellation after submission settlement preserves successful answers,
  output-limit failures and sanitized execution failures, including after reopen.

The parked-state and recovery-cancellation checks gate scripted models on
explicit promises, rather than relying on short response-delay windows. Gates
also respond to the model's abort signal, so shutdown/cancellation can stop them
without releasing an answer. Recovery checks wait for the original model to be
aborted and the resumed model to start before canceling; cleanup releases both.

The core retains the background-observer ownership choice and pinned-SDK
integration points proved in #1. Listing is deliberately simple: it scans to count matching tasks
and reads one record at a time for filtered cursor pagination. It orders by task
creation, not the SDK database store's last-status-update order. Larger-page
batching and whether exact totals are worth the scan are follow-up decisions,
not reasons to duplicate storage. SDK 1.3.0 declares `totalSize` as a required
numeric field; check the wire specification and SDK behavior before omitting it.
The scan-only `harness.commit()` does not write a storage commit in Durable
1.6.0: its zero-write transaction returns without calling storage. It still
occupies the serialized commit line.

#3 removes the artificial lifetime admission count and 10,000-task cap. The
`active` task pointer remains for atomic busy rejection; old `count` fields are
ignored without rewriting records. This library does not implement general
retention, pruning or archiving for Durable. Storage growth and resource policy
belong to the host and Durable, not a second A2A lifecycle subsystem.
#2 removed the source-text comparison and duplicate contract body in favor of
one extension-enabled fixture.

## Cancellation decision still open

The review's cancellation-scope concern reproduces with real Durable tasks:

```sh
node scripts/probe-cancellation-scope.js
```

This is a diagnostic, **not** a conformance test. It exits successfully when the
known race reproduces and prints the observed failure. It pauses only the A2A
abort invocation after `Submission.abort()` returns `already_placed`, lets that
submission finish normally, then lets the host submit a new foreground run.
Resuming the abort handler's conversation-wide `conversation.abort()` call
cancels the new host run. The A2A submission was already done; the independent
host input ends `unanswered` with reason `aborted`. No scheduler internals are
modified.

The original probe also exposed a second bug: the observer discarded the settled
submission and reported canceled even though its answer completed. That is now
fixed: the observer reports completed with the original answer, while the probe
still demonstrates the unrelated-host-run hazard. Fixing outcome reporting does
not make the conversation-wide abort safe.

Durable 1.6.0's public APIs explain the gap:

- `Submission.abort()` / `Harness.abortSubmission()` withdraw queued input, but
  return `already_placed` rather than stopping the run for placed input.
- A task's conversation handle exposes conversation-wide `abort()`, with no
  submission/run selector or transaction overload.
- `TaskRuntime.abortOwned()` only stops tasks the caller owns. The observer does
  not own the conversation's generation, so it cannot use this for its run.
- `Harness.abortTask()` can target a task, but is not a general task-runtime
  capability. Moreover, `LiveDoc.run.taskId` is handed from one generation to the
  next during tool rounds: capturing one generation ID is not a durable logical
  run cancellation mechanism.

Rechecking submission status before calling `conversation.abort()` leaves
another asynchronous race. Setting another task's abort mark via internal
`tx.setTask()` would duplicate scheduler responsibilities and is not an
acceptable public API foundation for this library.

**Recommended upstream capability:** obtain a Durable submission-scoped
abort operation usable from task code. It should atomically withdraw queued
input or mark the currently owning run while that submission is still unsettled,
then join its cleanup. If the submission has settled, it must not touch a newer
run. Durable must retain ownership of cancellation and recovery.

For now, the extension requires exclusive A2A foreground use as stated above.
This covers a host that uses separate conversations for its other input, but does
not meet the eventual goal of turning any host conversation into an A2A agent.
Remove the restriction only after safe scoped cancellation exists and is tested
against run handoffs and crash recovery. No ownership redesign or scheduler
workaround has been implemented in this PR.

A [feature-request draft](submission-scoped-abort-request-draft.md) records the
reproduction and required semantics. It has not been filed upstream; the user
decides where and when to submit it.

#2 completes listener shutdown coordination: `close()` blocks new task requests,
stops only request-side waits, joins accepted sends/reads/cancellations and SDK
drains/executor readers, then returns so the host can close Durable. It is
idempotent. A deterministic regression pauses cancellation at its first task
read and again at its final read after cleanup: close must wait at both points.
A storage-instrumented regression also verifies that scan-only listing produces
no storage commits. If the batched count finds zero matches, listing returns an
empty page immediately instead of making a second per-record scan. A first page
also stops once it has returned all counted matches, avoiding lookahead through
older nonmatching tasks. Broader sparse-cursor batching is not part of this fix.

Upgrade regressions seed legacy bridge submissions without notifications, reopen
the same conversation, and reuse their message IDs with new text: the new task
must get a distinct, notified submission, execute normally and cancel its own
work. Another regression reopens an older prototype checkpoint and confirms
abort uses its actual stored request ID rather than creating replacement input.

#3 records these names and version-1 layouts as the [stored contract](storage-contract.md),
including future migration policy and refusal of unknown task versions. Its
killable-storage tests interrupt a model attempt and cancellation cleanup without
saving clean-harness-shutdown checkpoints, then verify one task/admission and
stable terminal outcomes across reopen. Model retries remain Durable policy,
not an exactly-once promise.

#4/#5's custom caller-policy hooks are deferred: the core exposes a host-supplied,
persistent conversation, without another identity/context routing framework.
#6 extracts the existing Node callback as `createA2AHttpHandler`, while retaining
`createA2AServer` as a convenience. Native A2A uses the SDK; Express hosts can
already use the SDK's mounting adapters directly. LiteLLM's existing compatibility
transport is now `liteLLMTaskHandler` in the optional module, explicitly attached
as an extra POST route. Its route uses the same listener authentication/body
limits; core no longer serves a compatibility root by default. HTTP regressions
cover native-only serving, host-server mounting and opted-in task forwarding.
No general router or gateway framework is introduced.

Consumer deployment and release changes remain in #7–#9. Tests use local scripted
models only; no fleet access or GitHub writes are involved.
