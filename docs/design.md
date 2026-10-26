# Design and limitations

Pi next-prompt is a prediction convenience, not a workflow agent, recap system or source of consent. It uses Pi's existing model registry and public extension/editor APIs.

## Request lifecycle

A fresh, attributable terminal input is followed through `before_agent_start`, `agent_start`, `agent_before_settle` and `agent_settled`. The extension requires one unambiguous local user message, a successful settled run and a successful, non-empty final assistant reply. It consumes each activity once.

Generation is skipped for:

- Startup/resume without a fresh local input, non-TUI modes, recognisable remote prefixes and extension/custom starts.
- Queued/steering inputs, mixed-source activity, automatic multi-loop continuations/retries and compaction.
- Failed, aborted, truncated or empty final replies, image-bearing inputs and slash commands.
- A non-empty, edited, unfocused or replaced editor, autocomplete, blocking UI, pending messages or an active agent.
- Unavailable models, missing OAuth metadata and common explicit permission questions.

The consent heuristic is not a general semantic classifier. The prediction instruction also forbids manufactured consent, unrelated goals and continuations of failed/interrupted work. Natural examples, clarifications and small refinements on the current topic are allowed; a follow-up the user has already hinted at is useful evidence. Abstention is valid.

Each eligible activity makes at most one generation attempt. Requests ask for no tools, 256 output tokens, zero retries, SSE transport and no requested cache retention. A local eight-second timeout abandons the result. Provider-side cancellation/output limits are best-effort, not a monetary cap or proof of zero consumption.

## Context and provenance

The payload comes from the current session projection, including source-entry metadata, edits and omissions. It contains:

1. Up to three ordinary user texts whose terminal origin was observed in this runtime, at most 1,000 characters each.
2. The latest successful final assistant reply for that activity, at most 4,000 characters.
3. A fixed prediction instruction, with conversation data JSON-quoted by field.

Serialized conversation JSON is capped at 8,000 characters, including escaping. Explicit truncation markers preserve the beginning/end; older user messages are dropped before further reducing the current exchange. Tools, thinking, images, custom messages and synthetic compaction/branch summaries are excluded by source type.

Saved ordinary user entries do not retain Pi's public input-source tag. The extension therefore sends only user entries it has attributed since activation. After resume or context changes, the first prediction may have one user message. Normal Up-arrow editor history is seeded separately from ordinary active-branch user messages; compacted/omitted messages are not restored.

Input attribution trusts Pi's declared source. A trusted integration that falsely labels injected input as interactive cannot be identified reliably from that tag alone. Prefix checks provide only extra defence. Live Telegram/intercom delivery has not been validated.

The selected provider receives the quoted texts. They may themselves contain private file contents, tool results or secrets. Context minimisation is not redaction.

## Model and authentication boundary

Version 0.1 accepts only explicit `openai/MODEL_ID` selections of type `chat`. Requests use `ctx.modelRegistry.streamSimple()`; no second provider client, credential reader or CLI bridge is created.

Before generation and immediately before dispatch, Pi must report stored credentials and OAuth use, with no runtime API-key override. Failed selection/authentication means no request: there is no fallback to the main model, an API key or another provider. These checks use Pi's metadata, not an independent account/billing verifier. Trusted provider overrides remain inside Pi's configuration boundary; do not change authentication concurrently with a request.

The lowest supported thinking level is requested. Pi's simple API represents off by omitting reasoning. Main-session effort is never inherited. Choosing a larger model is explicit and does not change the main model.

## Ghost text and explicit recall

Ghost text is held separately from actual editor text/history/submission. It is shown only in an empty, focused editor without autocomplete. Tab/Right inserts; Enter never accepts a ghost. Other input invalidates it before base-editor handling. Rendering uses Pi's cursor/width/truncation helpers, with grapheme-aware handling and no additional editor rows.

There is one last **offered** candidate in memory, not a suggestion history. It is saved only after the editor accepts the fresh ghost. Dismissal, editing and status retain the candidate, but never automatically redisplay it.

`/next-prompt recall` checks the same session, leaf, editor instance and owned factory, plus an idle/empty/focused editor with no completion menu. It is render-only: no insertion, submission, conversation entry or model call. Temporary blockers refuse without overwriting text. New activity, branch/session/context change, compaction, blocking UI, editor replacement and on/off reset expire the candidate. Abstention, rejected/error results and cancelled/stale requests do not recover an older exchange's candidate.

Pi provides one custom-editor slot. The extension refuses a conflicting factory. Embedded editors receive no main ghost/callbacks. Off leaves the inert editor/history until shutdown; shutdown restores the default only while this extension still owns the slot.

## Diagnostics and token accounting

Status is on-demand and content-free:

- **Attempts:** local generation starts, not verified HTTP requests.
- **Offered:** fresh validated results handed to the editor, not proof of a painted terminal frame. Recalls are excluded.
- **Last error/outcome:** generic lifecycle/output categories, not raw provider errors.
- **Reported tokens:** cumulative prediction-only input/output and report coverage.

Input sums Pi's normalized input, cache-read and cache-write counts. Output already includes reasoning. Only non-negative safe integer fields with non-zero combined usage are counted. Missing/malformed/all-zero SDK placeholders remain unreported; totals are not invented from character counts, prices or provider cost estimates. Safe-integer overflow is refused.

Usable usage is captured before output validation and independently of ghost eligibility. Abstentions, rejected output and errors can therefore contribute. Late usage after cancellation/timeout is counted in the same session runtime without reviving text. A separate accounting epoch prevents previous-runtime callbacks entering reset/shutdown totals. No report is available if the provider never returns one.

Counters reset at `session_start`; on/off and same-session branch navigation preserve totals. No shared file, persistence, polling or model calls are added. A partial report fraction means the totals can be incomplete. They do not establish subscription-allowance percentages, monetary charges or account identity.

Status cancels a currently pending prediction/visible ghost, like other editor activity. Inspect after completion/timeout; use explicit recall if the same offered candidate remains current.

## Development checks

The lockfile pins the development SDK to Pi 1.3.0; the same checks have also passed against the installed Pi 1.4.0 SDK. Host packages stay `*` peer dependencies, as Pi's package documentation recommends, and are not bundled runtime dependencies.

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run check
```

`scripts/host.mjs` checks `PI_PACKAGE_DIR`, local dev dependencies, then the managed installation. `scripts/typecheck.mjs` uses real SDK declarations and an existing compiler, removing its temporary configuration in `finally`. `PI_TYPESCRIPT_DIR` can select another installed TypeScript package. No automatic dependency installation or substitute SDK is used by the check scripts.

Tests cover real CustomEditor/TUI helpers, factory loading, registered handlers, output/privacy guards, cancellation, stale results, recall and token accounting. A real AgentSession/ExtensionRunner/in-memory SessionManager integration runs the shipped terminal submit callback with mocked main/prediction streams, synthetic context and forbidden network access.

Offline fixtures do not establish provider entitlement, live terminal paint, general integration compatibility or prediction quality. Live basic Luna behaviour and recall have been user-confirmed. Usage reporting and broader integrations still need manual checks.

For manual testing, use harmless prompts and check regular/fullscreen layouts, Unicode/narrow widths, history/autocomplete, paste/edit-delete, interrupts and normal exit. Verify recalled text is insertion-only, cannot survive a new exchange, and adds no reported tokens/attempts. Confirm usage grows after predictions, including abstentions, when the provider returns metadata. Check your usual extensions before enabling across normal sessions.
