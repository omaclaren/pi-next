# pi-next-prompt

A small [Pi](https://pi.dev/) extension that suggests your next prompt as dim text in the editor. I made it mainly for my own use.

## Install

```bash
pi install git:github.com/omaclaren/pi-next-prompt
```

Start a new Pi process, then run:

```text
/next-prompt
```

If no model is selected, this opens a searchable picker of Pi's available chat models. It saves your choice in `next-prompt.json` in Pi's agent directory (normally `~/.pi/agent/`), ready for later sessions. Pi handles authentication and requests. The suggestion model is separate from your main model and thinking settings; a small, fast model usually makes sense here. Installing alone doesn't enable suggestions.

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
/next-prompt model
/next-prompt recall
/next-prompt status
/next-prompt off
/next-prompt on
```

`model` changes the suggestion model. `recall` brings back the last suggestion for the same exchange without another model call. `status` shows attempts and reported token usage for the current session. `on` does the same as bare `/next-prompt`; `off` disables suggestions for the current session.

Each prediction makes an extra model request using a few recent messages and the latest reply. It doesn't generate periodically while idle. The extension uses Pi's custom-editor slot, so it can conflict with other custom-editor extensions.

To remove it:

```bash
pi remove git:github.com/omaclaren/pi-next-prompt
```

## Prefix history (optional)

To try local prefix-filtered Up/Down history alongside next-prompt, start Pi with `--prefix-history`. It works even when suggestions are off or no suggestion model is selected.

For history navigation **without next-prompt**, load the alternative entry point from this checkout:

```bash
pi --extension ./history-only.ts
```

Load one entry point, not both. With a nonempty single-line prefix such as `!` or `!muxy`, **Up/Down** walks matching entries, newest first. Down past the newest match restores your draft; no match leaves it alone. Editing or moving the cursor ends that search. Empty-buffer recall, multiline editing and autocomplete menus keep Pi's normal behaviour. On a wrapped draft, move to its beginning to start a prefix search.

History stays in memory (up to 100 entries), seeded from ordinary messages and `!`/`!!` commands retained in the active session context. New submissions enter through Pi's normal editor history. There is no cross-session collection, new history file or model request, and recalling an entry never submits it.

## Development

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run check
```

Tested with Pi 1.3.0 and 1.4.0. Tests use mocked model calls.

## Licence

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for the Pi and SuPi editor references.
