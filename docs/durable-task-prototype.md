# Issue #1: Durable-native task prototype

## Result

**Go with a translated, read-only SDK store.** On SDK 1.3.0 and Durable 1.6.0,
`TaskStore.save` can store nothing. No SDK snapshot document is needed for the
supported text-only, non-streaming protocol.

The experiment is in `src/prototype.js`, intentionally not exported through the
public package API. The existing SQLite bridge, dependencies and API remain in
place until #2. Run it with:

```sh
node --test test/prototype.test.js
# Or run the old bridge, registry and prototype tests together:
npm test
```

`test/a2a.test.js` is untouched. The prototype fixture installs `A2AExtension`
before opening the harness and passes the harness to `openDurableA2A` instead of
an A2A database path. Its contract test body is byte-for-byte the same as the
original; a test checks that equality. Thus the behavior passes unchanged,
although the original empty-registry fixture cannot install a real extension
without adaptation.

## Stored layout being evaluated

| Kind | Scope | Version | Contents |
| --- | --- | --- | --- |
| `a2a.task` | Conversation-owned task | 1 | Input: message ID, text, hash, acceptance time. Checkpoint: submit, or answer with submission ID. Outcome: answer text, sanitized failure, or aborted. |
| `a2a.message` | Latest conversation document family, keyed by message ID | 1 | Task ID and content hash. Forks start empty. |
| `a2a.admission` | Latest conversation document | 1 | Most recently admitted task ID and admission count. Forks start empty. |

Admission checks the binding, the last task, and Durable's live/inbox documents
on the commit line. The binding and task are created in one commit; rejected or
rolled-back admission creates neither. Concurrent identical IDs find one task;
competing new IDs cannot both take the slot. The task submits in its own next
commit and parks on Durable's built-in `SubmissionSettled` signal. Submission
creation and the parked checkpoint commit together.

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
reacquires that submission by its request ID, withdraws it if queued, or aborts
and joins the foreground scope if placed, then marks the A2A task aborted.
Recovery is entirely the Durable scheduler's job: install the extension on each
open and resume the harness. There is no A2A recovery scan or execution loop.

## SDK adaptation findings

- `load` creates a fresh A2A task from a Durable record. Task IDs and context IDs
  are decimal strings on the wire, but Durable IDs must be numbers when calling
  the scheduler. A string can appear to work in SQLite reads while bypassing
  the scheduler's numeric-keyed live-task index; conversion matters for waits.
- Pending records show submitted; started, parked and aborting records show
  working; only terminal aborted records show canceled. Result messages and
  history are reconstructed with stable IDs and timestamps. Provider diagnostics
  and unexpected task-fault details are not exposed.
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
- metadata-only list counting/filtering, with inaccessible unreturned answers.

The parked-state checks gate the scripted model on an explicit promise and
release it in cleanup, rather than relying on a short response-delay window.

Before promoting this in #2, review the background-observer ownership choice and
SDK overrides. Listing is deliberately simple: it scans to count matching tasks
and reads one record at a time for filtered cursor pagination. It orders by task
creation, not the SDK database store's last-status-update order. Larger-page
batching and whether exact totals are worth the scan are follow-up decisions,
not reasons to duplicate storage.

Names and versions above describe the experiment, not a finalized public
storage contract. #3 finalizes and documents that contract and adds killable
storage/crash tests. Authentication, identity-based conversation selection,
optional gateway routes, consumer deployment and release changes remain in
#4–#9. This experiment uses local scripted models only; no fleet access or
GitHub writes are involved.
