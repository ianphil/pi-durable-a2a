# Stored A2A contract

A2A state lives in the host's Durable store. Install `A2AExtension` before opening
and resuming that store. Durable owns allocation, persistence, scheduling,
recovery and cancellation; this library only maps its records to A2A.

## Version 1 identifiers

These stored names are compatibility contracts, not implementation filenames:

| Identifier | Meaning |
| --- | --- |
| `a2a.task`, definition version `1` | One accepted A2A message, owned by its conversation as a background task. |
| `a2a.message`, document version `1` | Message-ID binding document family. |
| `a2a.admission`, document version `1` | Conversation's most recently admitted task, used for atomic busy rejection. |
| `a2a.task:<task ID>` | Durable submission request ID for a newly created A2A task. |
| `answer` / `SubmissionSettled` | Key and Durable-provided signal on which the task parks. |
| `<task ID>:answer` | Stable A2A result-message ID reconstructed from a terminal outcome. |

Task IDs, conversation IDs and submission IDs are Durable's numeric IDs. A2A task
and context IDs are their canonical decimal strings on the wire. Use numbers
when calling Durable; don't create a second ID allocator. A task's A2A context
is its conversation ID, not a caller-isolation boundary.

## Task input, checkpoints and outcomes

`a2a.task` input retains:

- `messageId`: the caller's message ID.
- `text`: plain-text parts joined with `\n`, preserving their contents.
- `hash`: lowercase SHA-256 hex digest of that normalized UTF-8 text.
- `acceptedAt`: wall-clock acceptance time in milliseconds.

The initial checkpoint is `{ phase: 'submit' }`. Submission admission and parking
are committed together; the parked/woken checkpoint is
`{ phase: 'answer', submissionId }`, sleeping on `SubmissionSettled.key('answer')`.
No in-memory bridge loop owns the work.

The terminal outcome is Durable's completed answer string, a failed outcome, or
an aborted outcome. The A2A view exposes only the known public failures
`Answer exceeds result limit` and `Execution did not produce an answer`; other
failed/faulted diagnostics become `Execution unavailable`. Full diagnostics stay
in Durable. An answer or failure that wins a late cancellation remains that
outcome, not canceled.

Durable-owned fields such as abort marks, start/end times, retry counts, trace
carriers and stored signals follow Durable's contract. We don't duplicate their
versioning or recovery mechanisms.

## Documents and atomic admission

Both document kinds have conversation scope, `history: 'latest'`, and
`fork: 'initial'`. A fork starts with fresh A2A bindings/admission state rather
than inheriting its parent's task association.

`a2a.message` is a family keyed by the exact message ID. Its admitted value is
`{ taskId, hash }`. The task and binding are created in one Durable commit. The
same ID and text find the same task; a different text hash is rejected. Failed
admission creates neither record.

`a2a.admission` starts empty. Its `active` field, when present, is the numeric ID
of the last admitted task. The next admission reads that task and Durable's
live/inbox documents in the same commit before creating another task. A retained
terminal `active` pointer does not mean the conversation is busy.

Early version-1 records may also have a `count` field. It is obsolete and ignored;
new documents neither initialize nor increment it. Its presence—even at or above
10,000—must not prevent admission. Removing the lifetime cap needs no record
rewrite or storage migration.

## Existing data and future migrations

- Keep each kind's name and meaning stable. Never rename or repurpose a stored
  kind to avoid handling existing data, and don't recycle retired identifiers.
- Read version-1 records from the prototype and core, including obsolete
  admission counters and extra compatible JSON fields. Cancellation reacquires
  the request ID from its committed submission record, so older prototype
  submissions named `a2a:<message ID>` are still targeted correctly.
- New tasks use `a2a.task:<task ID>`, not the former message-ID request keys. This
  prevents accidental adoption of separate-bridge submissions that lack the
  new task's settlement notification. Old separate A2A databases are not imported;
  see the README's [upgrade instructions](../README.md#upgrading-from-the-separate-database-bridge).
- When input/checkpoint or document semantics require an incompatible stored
  change, increment the definition's version and use Durable's `defineTask`
  migration callback or document migration callback. Test the old stored data
  against the new definitions, not just freshly created records.
- Preserve task IDs, message bindings, original outcomes and submission
  association through migrations. Terminal records also need compatible read
  translation; don't assume the scheduler migrates terminal tasks.
- The current task view supports version `1` only and refuses unknown/future
  versions rather than interpreting or rewriting them. Durable handles live-task
  definition/version resolution; document access uses its version checks.
- A future version must document its supported source versions and upgrade
  procedure. Back up the store before an upgrade. Downgrading to older code is
  not promised; restore a compatible backup rather than guessing how to read
  newer records.

## Storage lifecycle and idempotency

There is no A2A task-count quota, expiration window, pruning engine or archive
store. Message-ID bindings and results remain available while retained in the
host's Durable store. Host/Durable storage management is not reimplemented here.
Storage growth and resource limits are operator/host concerns; removing the
artificial lifetime admission cap is not a claim that storage is bounded.

## Recovery evidence

`test/storage.test.js` uses real SQLite storage behind a killable adapter. Once
killed, the adapter rejects further operations (apart from closing the backend).
This induces a failed harness without calling `Harness.close()` first, so it
cannot save the clean-shutdown recovery checkpoints. Request-side cleanup only
starts after storage has been killed. This models abrupt storage loss, not a
power-loss/fsync guarantee or an actual OS-process kill.

The tests interrupt a model request and interrupt cancellation after both abort
marks are committed but before model cleanup settles. They reopen the same store
with definitions installed and check one task, one binding/admission, correct
terminal outcomes, duplicate lookup, listing and another reopen. A commit observer
checks that the A2A task has one terminal publication, not repeated settlement.

Recovery obeys the host's retry policy: the interrupted-model test permits one
retry and observes two model calls. With no retries left, Durable may fail that
run instead. These tests don't promise exactly-once model calls or tool side
effects; tools follow Durable's replay policy. The exclusive-A2A foreground
restriction remains until supported submission-scoped cancellation exists.
