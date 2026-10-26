# Pi next-prompt

Short, optional next-message suggestions for the [Pi](https://pi.dev/) terminal editor. A separately selected model predicts what you might naturally type next; the suggestion appears as dim ghost text.

**Public preview · terminal only · OpenAI chat with stored ChatGPT OAuth.** Off until you explicitly select a suggestion model. Your main model and thinking level stay unchanged.

## Try it

Requires Node **22.19+**, Pi **1.3.0 or 1.4.0**, and a working Pi `openai` login through **Sign in with ChatGPT**. Review the source before loading it: Pi extensions run inside your Pi process.

Start a new disposable terminal session:

```bash
env -u OPENAI_API_KEY pi \
  --no-extensions --no-mcp --no-tools --no-skills --no-prompt-templates \
  --no-session --no-approve --tui-mode regular \
  -e git:github.com/omaclaren/pi-next-prompt@v0.1.0 \
  --next-prompt-model openai/gpt-6-luna
```

This downloads the extension for one invocation without registering it in settings. The conversation is in memory, and other extensions/tools are excluded for this trial. It keeps your normal main-model selection. Use a fresh process, not a second process against an active session file.

For a simple test, ask:

> Explain closures briefly, without an example. I may ask for a small example next.

Leave the editor empty after the reply. A suggestion may appear within eight seconds; the model can also abstain.

### Controls

| Action | Behaviour |
|---|---|
| **Tab / Right Arrow** | Insert the visible suggestion for editing, without submitting |
| **Enter** | Ordinary editor behaviour; never accepts or sends ghost text |
| **Escape** | Dismiss |
| **Type, paste or navigate** | Clear the ghost and cancel pending generation |
| **`/next-prompt recall`** | Restore the last offered ghost for this exchange, without another call |

Editing then deleting back to empty does **not** automatically restore a suggestion. Recall requires the same exchange and an idle, empty, focused editor with no completion menu. New work or changed context expires it. Autocomplete takes precedence over ghost acceptance.

## Model choice

```text
--next-prompt-model openai/MODEL_ID
```

**v0.1 is not provider-agnostic:** it accepts only available `openai` **chat** models that work with Pi's stored ChatGPT OAuth. API-key authentication, `openai-codex`, other providers and classifier models are not supported. The extension does not change your login or fall back to another model/authentication route.

Suggested choices:

- **`openai/gpt-6-luna`** — economical starting point; visible suggestions and controls have been user-tested.
- **`openai/gpt-6.1-terra`** — explicit quality-oriented alternative; not yet compared in this extension.
- Other compatible OpenAI chat models can be selected explicitly.

The extension requests the selected model's lowest supported thinking level, rather than inheriting your main session's effort. Luna and Terra support off. Luna's separate Decisions API classifier is **not** used.

## Install for regular use

After trying it and checking compatibility with your usual extensions:

```bash
pi install git:github.com/omaclaren/pi-next-prompt@v0.1.0
```

Launch a fresh Pi process when convenient, then opt in with:

```bash
pi --next-prompt-model openai/gpt-6-luna
```

Installation alone leaves suggestions **off**. Keep only one loaded copy. This extension uses Pi's custom-editor slot and refuses to overwrite a competing editor; custom-editor composition is not supported.

Commands:

```text
/next-prompt on
/next-prompt off
/next-prompt status
/next-prompt recall
```

`on` requires a valid model selected at launch. Commands never generate predictions. `off` cancels pending requests and clears the ghost/recall candidate, while retaining an inert editor subclass and its input history until shutdown.

To remove the package:

```bash
pi remove git:github.com/omaclaren/pi-next-prompt@v0.1.0
```

Start a fresh process at your chosen time to unload it; no automatic restart is required.

## Usage and privacy

- At most one prediction request per eligible completed local terminal exchange. Idle sessions make no requests.
- Up to three recently observed local user messages and the latest final assistant reply are sent, with firm size limits. No tools, repository inspection or full-history scan.
- Slash commands, queued/background/recognisable remote inputs, failed or interrupted work and common permission questions are skipped. Consent detection is heuristic; review suggestions before sending.
- No extra provider client, persistent suggestion history, prompt logs, telemetry or background service.
- The selected provider receives the bounded conversation text. This is minimisation, **not secret redaction**.

`/next-prompt status` includes cumulative prediction-only usage, for example:

```text
Reported tokens: 4500 in / 90 out (3/4 reports).
```

This means three of four local generation attempts returned usable usage data. Cached input is included; reasoning is already included in output. Abstentions and rejected suggestions still contribute when usage is reported. Recall/status add no calls or tokens.

Missing reports are **unknown**, not free. Cancelled/timed-out requests can still consume usage. Totals are in memory only, reset at session start, and are not shared across processes or converted into subscription-allowance percentages.

See [design and limitations](docs/design.md) for context/provenance, authentication checks, cancellation and editor ownership.

## Preview status

Tested with **Pi 1.3.0 and 1.4.0**. Visible Luna suggestions, basic controls and recall have been user-tested. **401 offline checks** cover real Pi editor/helpers and the session lifecycle with mocked provider calls. Token accounting is offline-tested; broad live compatibility, rendering across terminals, and prediction quality/latency remain under evaluation.

This is a GitHub preview, not an npm release. `private: true` prevents accidental npm publication.

## Development

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run check
```

Tests use synthetic context and mocked provider/auth metadata, not live credentials or session histories. The real-session integration test forbids network access. SDK/compiler discovery can be overridden with `PI_PACKAGE_DIR` and `PI_TYPESCRIPT_DIR`; see [development notes](docs/design.md#development-checks).

## Licence and references

[MIT](LICENSE). Editor integration references Pi's modal-editor example and [SuPi prompt suggestions](https://github.com/mrclrchtr/supi/tree/f765891af4e8fb2aeea6f1b656d0957f104ece37/packages/supi-prompt-suggestions). Their notices are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
