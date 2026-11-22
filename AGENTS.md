# Working on pi-durable-a2a

"Build the happy path. Anything beyond the requested behavior is a proposal, not
part of this change." -- Ian Philpot

## Suggestions and rules

- Suggestions are defaults, followed with judgment. Readability, module boundaries
  and test style are guidance, not reasons to add machinery.
- Rules are rare: things where breaking them breaks a contract, or where the user
  has said "never". Enforce real invariants through behavior tests or appropriate
  tooling, not ever more prose. Don't turn suggestions into source-text checks.
- Tests check behavior. The runner runs them, and that's the check. A test doesn't
  need its own validation ceremony.
- Keep changes focused on the requested behavior. Discuss additional features,
  infrastructure and key design decisions before implementing them. Automated
  review findings are suggestions to evaluate, not a mandate to expand a PR until
  the review is clean.

## Code readability

When reviewing a change, ask: Can a reader find the guarantee, see what would
break without it, and follow the normal path without learning an unrelated
mechanism?

- Put the main steps in the order they happen so the happy path reads directly.
- Keep checks, limits and cleanup close to the actions they protect. Don't remove
  safeguards just to make code shorter.
- Use comments to explain a non-obvious constraint or failure mode. If the code
  already says what happens, don't repeat it.
- Extract helpers when their names explain real steps or give tricky details a
  clear home. Don't add layers just to shorten functions or files.
- Keep existing boundaries while they make the code readable; don't add layers
  merely to enforce separation.

## Project and architecture

Read [README.md](README.md) and [docs/](docs/) for supported behavior and public
contracts before changing a feature.

This is a thin Durable extension that maps A2A onto a host conversation, not a
standalone server that happens to call Durable.

Start with what the A2A SDK and Pi Durable already guarantee. Add bridge logic
only when you can name a caller-visible behavior that neither provides alone—for
example, retrying a message after a lost response must return the same Durable
task.

- **The A2A SDK owns protocol handling**, request validation and response semantics.
- **Pi Durable owns execution and state**: persistence, scheduling, cancellation,
  recovery and conversation history. An A2A task is a Durable task; the SDK store
  is a translated view, not another persisted copy.
- **This library owns the mapping**: atomic message-ID bindings, record translation
  and host integration. **The host owns policy and resources**: authentication,
  conversation selection, models, tools, storage and resource limits. Gateways
  such as LiteLLM are optional integrations.

Inspect both libraries' supported APIs before adding logic. Don't rebuild their
facilities or build general-purpose subsystems for them: no second store,
scheduler, recovery loop, retention engine or parallel protocol implementation.
If a necessary capability is missing, document the limitation and discuss it
rather than quietly replacing it or using private scheduler tables.
SDK-specific adaptations should be narrow, justified and regression-tested.

Treat stored names, schemas and request keys as compatibility contracts. Storage
work means documenting versioning/migration and testing crashes—not building
Durable's pruning or archiving. Don't add arbitrary lifetime task quotas as a
retention policy, or describe hiding records as physical pruning. Keep later roadmap work out
of the current change.

## Current cancellation constraint

All foreground work in the served conversation must come through A2A. Independent
host input and automatic follow-up runs use separate conversations until Durable
supports submission-scoped cancellation; conversation-wide abort can stop a
newer, unrelated run. Preserve actual settled outcomes: completed answers and
failures must not become canceled merely because cancellation was requested.
Don't remove this restriction with a scheduler workaround.

## Testing and documentation

- Use local scripted models and real Durable storage. Prefer explicit gates over
  short timing windows. Run `npm ci --ignore-scripts` and `npm test`.
- Keep the README, docs, examples and public contracts aligned.
- This repository is public: fleet addresses, hostnames, credential paths,
  deployment commands and fleet-specific evidence belong in the private fleet
  runbook, not here. Generic docs and parameterised smoke scripts belong here.
- Tests must not perform GitHub writes or require model credentials. Administrative
  gateway credentials and registration are operator concerns, never model-callable
  capabilities. Don't expose private diagnostics in public task responses.

## Working agreements

Create branches for new work. Discuss key decisions before acting. Don't push,
merge, deploy or file upstream issues without user authorization. Use squash
merge when requested. Live fleet testing follows the private runbook, not
temporary handoff notes.
