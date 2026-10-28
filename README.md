# pi-next

A small [Pi](https://pi.dev/) extension that suggests your next prompt as dim text in the editor. I made it mainly for my own use.

## Install

```bash
pi install git:github.com/omaclaren/pi-next
```

Start a new Pi process, then run:

```text
/next
```

Choose a model for suggestions from the picker. Your choice is saved for later sessions, separately from your main Pi model.

## Use

After Pi finishes a reply, a suggestion may appear when the editor is empty.

- **Tab / Right Arrow:** insert it for editing, without sending.
- **Escape:** dismiss it.
- **Enter:** behaves normally and doesn't accept the suggestion.

Typing also dismisses the suggestion. Use `/next-recall` to bring it back before starting a new conversation turn.

Local `!`/`!!` commands hide the suggestion while they run. The same suggestion can reappear afterward when the editor is empty.

| Command | What it does |
| --- | --- |
| `/next` or `/next on` | Turn suggestions on, choosing a model if needed. |
| `/next-model` or `/next model` | Choose the suggestion model. Both accept an optional `provider/model` argument. |
| `/next-recall` or `/next recall` | Bring back the last suggestion for the current exchange. |
| `/next status` | Show the selected model and reported token usage. |
| `/next off` | Turn suggestions off for this session. |

To override the saved model at startup, use `pi --next-model provider/model`.

Each prediction makes an extra model request using a few recent messages and the latest reply. The extension can conflict with others that replace Pi's editor.

## Prefix history (optional)

Start Pi with:

```bash
pi --prefix-history
```

Type a prefix such as `!git`, then use **Up/Down** to browse matching prompts or shell commands from the current session. Down past the newest match restores your draft. Edit the recalled text or press Enter to submit it.

Browsing history makes no model requests and works even when suggestions are off.

## Remove

```bash
pi remove git:github.com/omaclaren/pi-next
```

## Licence

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for the Pi and SuPi editor references.
