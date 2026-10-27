# pi-next-prompt

A small [Pi](https://pi.dev/) extension that suggests your next prompt as dim text in the editor. I made it mainly for my own use.

## Install

```bash
pi install git:github.com/omaclaren/pi-next-prompt
```

Start a new Pi process, then choose a suggestion model:

```text
/next-prompt model
```

The searchable picker lists Pi's available chat models and saves your choice in `next-prompt.json` in Pi's agent directory (normally `~/.pi/agent/`). Pi handles authentication and requests. The suggestion model is separate from your main model and thinking settings; a small, fast model usually makes sense here. Installing alone doesn't enable suggestions.

You can override the saved choice at startup:

```bash
pi --next-prompt-model openai/gpt-6-luna
```

## Use

After Pi finishes a reply, a suggestion may appear if the editor is empty.

- **Tab / Right Arrow:** insert it for editing, without sending.
- **Escape:** dismiss it.
- **Enter:** behaves normally and doesn't accept the suggestion.
- Typing clears the suggestion. Deleting back to empty doesn't bring it back automatically.

```text
/next-prompt recall
/next-prompt status
/next-prompt off
/next-prompt on
```

`recall` brings back the last suggestion for the same exchange without another model call. `status` shows attempts and reported token usage for the current session. Model choice is saved; `on` and `off` apply to the current session.

Each prediction makes an extra model request using a few recent messages and the latest reply. It doesn't generate periodically while idle. The extension uses Pi's custom-editor slot, so it can conflict with other custom-editor extensions.

To remove it:

```bash
pi remove git:github.com/omaclaren/pi-next-prompt
```

## Development

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run check
```

Tested with Pi 1.3.0 and 1.4.0. Tests use mocked model calls.

## Licence

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for the Pi and SuPi editor references.
