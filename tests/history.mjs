import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function checkHistory({ harness, jiti, host, tui, project, sdk, KeybindingsManager, screen, theme, rendered, entry, user, assistant, projected }) {
  const { PrefixHistory, PrefixHistoryEditor, seedHistory } = await jiti.import(join(project, "prefix-history.ts"));
  const { GhostEditor } = await jiti.import(join(project, "ghost-editor.ts"));
  const { default: historyOnly } = await jiti.import(join(project, "history-only.ts"));
  let checks = 0;
  const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
  const ok = (value, label) => { assert.ok(value, label); checks++; };
  const up = "\x1b[A", down = "\x1b[B";
  const make = (Class = PrefixHistoryEditor, keys = new KeybindingsManager()) => {
    const e = Class === GhostEditor ? new Class(screen, theme, keys, undefined, true) : new Class(screen, theme, keys);
    e.focused = true; e.render(80);
    for (const text of ["!muxy browser open --split", "a normal prompt", "!git status", "!muxy list", "!!printf hidden"]) e.addToHistory(text);
    return e;
  };
  {
    const h = new PrefixHistory();
    for (const value of ["!muxy browser open --split", "plain", "!git status", "!muxy list", "!muxy list"]) h.add(value);
    eq(h.navigate("up", "!"), "!muxy list");
    eq(h.navigate("up", h.current), "!git status", "prefix stays fixed, not the last recalled command");
    eq(h.navigate("up", h.current), "!muxy browser open --split");
    eq(h.navigate("up", h.current), undefined, "oldest match does not wrap");
    eq(h.navigate("down", h.current), "!git status");
    eq(h.navigate("down", h.current), "!muxy list");
    eq(h.navigate("down", h.current), "!"); eq(h.active, false);
    eq(h.navigate("up", "!missing"), undefined); eq(h.current, "!missing");
    eq(h.navigate("down", h.current), "!missing");
    for (const prefix of ["", " ", "a\nb", "a\tb"]) eq(h.navigate("up", prefix), undefined);
    h.add("!multiline\ncommand"); h.add("!escape\x1b[31m"); h.add("!bidi\u202e"); h.add("!safe");
    eq(h.navigate("up", "!"), "!safe"); eq(h.navigate("up", h.current), "!muxy list", "unsafe/multiline candidates skipped");
    h.add("!first"); eq(h.active, false, "new submissions end a search");
    for (let i = 0; i < 110; i++) h.add(`!item${i}`);
    const seen = [];
    for (let value; (value = h.navigate("up", "!item")) !== undefined;) seen.push(value);
    eq(seen.length, 100); eq(seen[0], "!item109"); eq(seen.at(-1), "!item10");
    h.reset(); h.add("!漢字 🙂"); eq(h.navigate("up", "!漢"), "!漢字 🙂");
    h.reset(); eq(h.navigate("up", "!ITEM"), undefined, "case-sensitive shell-style matching");
  }
  for (const Class of [PrefixHistoryEditor, GhostEditor]) {
    const e = make(Class), submits = [];
    e.onSubmit = text => submits.push(text);
    e.setText("!"); e.handleInput(up); eq(e.getText(), "!!printf hidden");
    e.handleInput(up); eq(e.getText(), "!muxy list");
    e.handleInput(up); eq(e.getText(), "!git status");
    e.handleInput(up); eq(e.getText(), "!muxy browser open --split");
    e.handleInput(up); eq(e.getText(), "!muxy browser open --split");
    for (let i = 0; i < 4; i++) e.handleInput(down);
    eq(e.getText(), "!"); eq(e.getCursor(), { line: 0, col: 1 }); eq(submits, []);
    e.setText("!muxy"); e.handleInput(up); eq(e.getText(), "!muxy list");
    e.handleInput(up); eq(e.getText(), "!muxy browser open --split");
    e.handleInput(down); e.handleInput(down); eq(e.getText(), "!muxy");
    e.setText("!absent"); e.handleInput(up); eq(e.getText(), "!absent");
    e.handleInput(down); eq(e.getText(), "!absent");
    e.setText("!muxy"); e.handleInput(up); e.handleInput("X"); e.handleInput(up);
    eq(e.getText(), "!muxy listX", "editing ends the old search instead of restoring its draft");
    e.setText("!muxy"); e.handleInput(up); e.setText("!git"); e.handleInput(up); eq(e.getText(), "!git status");
    e.setText("!muxy"); e.handleInput(up); e.insertTextAtCursor("X"); e.handleInput(down); eq(e.getText(), "!muxy listX");
    e.setText("!muxy"); e.handleInput(up); e.handleInput("\x1b"); e.handleInput(down); eq(e.getText(), "!muxy list");
    e.setText("!"); e.handleInput(up); e.handleInput("\r"); eq(submits, ["!!printf hidden"], "only explicit Enter submits");
    e.setText(""); e.handleInput(up); eq(e.getText(), "!!printf hidden");
    e.handleInput(up); eq(e.getText(), "!muxy list");
    e.handleInput(up); eq(e.getText(), "!git status", "empty-buffer history stays unfiltered");
    e.handleInput(up); eq(e.getText(), "a normal prompt");
    for (let i = 0; i < 4; i++) e.handleInput(down);
    eq(e.getText(), "");
    e.setText("a normal"); e.handleInput(up); eq(e.getText(), "a normal prompt"); e.handleInput(down); eq(e.getText(), "a normal");
    e.setText("!muxy\nsecond line"); e.handleInput(up); eq(e.getText(), "!muxy\nsecond line"); eq(e.getCursor().line, 0);
    e.setText("!" + "x".repeat(150)); e.render(20); const before = e.getCursor().col; e.handleInput(up);
    eq(e.getText(), "!" + "x".repeat(150)); ok(e.getCursor().col < before, "wrapped draft keeps vertical cursor movement");
    e.setText("!muxy"); e.render(80); e.handleInput(up); e.handleInput("\x1b[D"); e.handleInput(down);
    eq(e.getText(), "!muxy list", "moving the cursor ends search");
    e.setText("!"); e.handleInput("\x1b[200~"); e.handleInput(up); eq(e.getText(), "!", "paste fragments must reach Pi, not history");
    e.handleInput("\x1b[201~");
  }
  {
    const e = make(), seen = [];
    e.onExtensionShortcut = data => { seen.push(data); return data === up; };
    e.setText("!muxy"); e.handleInput(up); eq(e.getText(), "!muxy"); eq(seen, [up], "extension shortcut runs once and wins");
    e.onExtensionShortcut = data => { seen.push(data); return false; };
    e.handleInput(up); eq(e.getText(), "!muxy list"); eq(seen, [up, up]);
    e.setText("!muxy"); e.handleInput(up);
    e.handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 80, height: 4 });
    e.handleInput(down); eq(e.getText(), "!muxy list", "mouse interaction ends the search");
    let escaped = 0; e.onEscape = () => escaped++;
    e.handleInput("\x1b"); eq(escaped, 1, "app escape binding preserved");
    const rebound = new KeybindingsManager({ "app.thinking.toggle": "up" });
    const other = make(PrefixHistoryEditor, rebound); let toggles = 0;
    other.onAction("app.thinking.toggle", () => toggles++);
    other.setText("!muxy"); other.handleInput(up); eq(toggles, 1); eq(other.getText(), "!muxy", "app remapping wins");
    const explicit = new KeybindingsManager({ "tui.editor.historyPrevious": "up", "tui.editor.historyNext": "down" });
    const old = tui.getKeybindings();
    try {
      tui.setKeybindings(explicit);
      const direct = make(PrefixHistoryEditor, explicit);
      direct.setText("!muxy"); direct.handleInput(up); eq(direct.getText(), "!!printf hidden", "dedicated history actions remain unfiltered");
      direct.handleInput(up); eq(direct.getText(), "!muxy list");
      direct.handleInput(down); direct.handleInput(down); eq(direct.getText(), "!muxy");
    } finally { tui.setKeybindings(old); }
  }
  {
    const e = make();
    e.setAutocompleteProvider({ triggerCharacters: ["!"], getSuggestions: () => ({ items: [{ value: "!native-one", label: "one" }, { value: "!native-two", label: "two" }], prefix: "!" }),
      applyCompletion: (_lines, _line, _col, item) => ({ lines: [item.value], cursorLine: 0, cursorCol: item.value.length }) });
    e.setText("!"); e.handleInput("\t"); await new Promise(resolve => setImmediate(resolve));
    ok(e.isShowingAutocomplete()); e.handleInput(up); eq(e.getText(), "!", "autocomplete owns arrow navigation");
    e.handleInput("\t"); ok(e.getText().startsWith("!native-"));
  }
  {
    const e = make(GhostEditor); e.setText(""); ok(e.setGhost("ghost text"));
    e.handleInput(up); eq(e.getText(), "!!printf hidden"); ok(!rendered(e).includes("ghost text"));
    e.setText(""); ok(e.setGhost("insert only")); e.handleInput("\t"); eq(e.getText(), "insert only");
    const submits = []; e.onSubmit = value => submits.push(value);
    e.setText(""); e.setGhost("NEVER_SUBMIT"); e.handleInput("\r"); ok(!submits.includes("NEVER_SUBMIT"));
    e.setText(""); e.setGhost("DISMISSED"); e.handleInput("\x1b"); e.handleInput("x"); e.handleInput("\x7f");
    ok(!rendered(e).includes("DISMISSED"));
  }
  {
    const bash = (command, excluded = false) => entry({ role: "bashExecution", command, output: "PRIVATE_OUTPUT", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: excluded, timestamp: 0 });
    const entries = [projected(entry(user("ordinary prompt"))), projected(bash("muxy browser open --split")), projected(bash("printf hidden", true)),
      projected(entry(assistant("PRIVATE_ASSISTANT"))), projected(entry({ role: "toolResult", content: [{ type: "text", text: "PRIVATE_TOOL" }] })),
      { sourceEntry: { type: "compaction" }, messages: [user("PRIVATE_SUMMARY")] },
      { sourceEntry: { type: "custom_message" }, messages: [user("PRIVATE_CUSTOM")] },
      { ...projected(entry(user("PRIVATE_REMOVED"))), messages: [] }];
    const e = new PrefixHistoryEditor(screen, theme, new KeybindingsManager()); e.focused = true; seedHistory(e, entries);
    e.setText("!"); e.handleInput(up); eq(e.getText(), "!!printf hidden"); e.handleInput(up); eq(e.getText(), "!muxy browser open --split");
    e.setText("PRIVATE_"); e.handleInput(up); eq(e.getText(), "PRIVATE_", "no tools, summaries, custom, removed or assistant text in history");
    const legacy = new PrefixHistoryEditor(screen, theme, new KeybindingsManager()); legacy.focused = true; seedHistory(legacy, entries, false);
    legacy.setText("!"); legacy.handleInput(up); eq(legacy.getText(), "!", "normal next-prompt seeding remains prompt-only");
    for (const flag of ["", null, "openai/invalid"]) {
      const h = harness({ prefixHistory: true, flag }); h.replaceEntries(entries.flatMap(item => item.sourceEntry.type === "message" ? [item.sourceEntry] : []));
      h.project(entries); await h.start(); ok(h.editor); h.editor.setText("!muxy"); h.editor.handleInput(up); eq(h.editor.getText(), "!muxy browser open --split");
      await h.command("status"); eq(h.requests.length, 0); ok(h.notices.at(-1).text.includes("Next-prompt: off")); await h.shutdown();
    }
    const h = harness({ prefixHistory: true }); h.project(entries); await h.start(); const factory = h.factory;
    await h.command("off"); h.editor.setText("!muxy"); h.editor.handleInput(up); eq(h.editor.getText(), "!muxy browser open --split"); eq(h.factory, factory);
    h.editor.setText("!muxy"); h.editor.handleInput(up);
    h.project([projected(bash("git status"))]); await h.emit("session_tree");
    h.editor.setText("!muxy"); h.editor.handleInput(up); eq(h.editor.getText(), "!muxy", "tree changes rebuild from the new projection");
    h.editor.setText("!git"); h.editor.handleInput(up); eq(h.editor.getText(), "!git status"); eq(h.requests.length, 0); await h.shutdown();
    for (const mode of ["rpc", "print", "json"]) { const h = harness({ prefixHistory: true, mode }); await h.start(); eq(h.editor, undefined); await h.shutdown(); }
    const conflict = harness({ prefixHistory: true, conflict: true }); const original = conflict.factory;
    await conflict.start(); eq(conflict.factory, original); await conflict.shutdown(); eq(conflict.factory, original);
  }
  // Alternative entry point: no model API, settings, auth, tools or history files.
  {
    const handlers = new Map(), notices = [];
    const pi = { on: (name, handler) => handlers.set(name, handler) };
    historyOnly(pi);
    let factory, editor, entries = [projected(entry(user("session prompt")))], mode = "tui";
    const forbidden = new Proxy({}, { get() { throw new Error("Model access forbidden in history-only mode"); } });
    const ctx = { get mode() { return mode; }, modelRegistry: forbidden,
      sessionManager: { buildSessionProjection: () => ({ entries }) },
      ui: { getEditorComponent: () => factory, notify: text => notices.push(text),
        setEditorComponent: value => { factory = value; editor = value?.(screen, theme, new KeybindingsManager()); if (editor) editor.focused = true; } } };
    const emit = async name => handlers.get(name)?.({}, ctx);
    await emit("session_start"); ok(editor instanceof host.CustomEditor);
    editor.addToHistory("!muxy browser open --split"); editor.setText("!muxy"); editor.handleInput(up); eq(editor.getText(), "!muxy browser open --split");
    editor.handleInput(down); eq(editor.getText(), "!muxy");
    entries = []; await emit("session_tree"); editor.setText("!muxy"); editor.handleInput(up); eq(editor.getText(), "!muxy");
    const embedded = factory(screen, theme, new KeybindingsManager()); embedded.focused = true; embedded.addToHistory("!embedded"); embedded.setText("!");
    embedded.handleInput(up); eq(embedded.getText(), "!", "embedded editors do not enable prefix history");
    const replaced = () => {}; factory = replaced; await emit("session_tree"); eq(factory, replaced);
    await emit("session_shutdown"); eq(factory, replaced, "shutdown does not restore over another editor");
    for (mode of ["rpc", "print", "json"]) { factory = undefined; editor = undefined; await emit("session_start"); eq(editor, undefined); }
    mode = "tui"; factory = replaced; await emit("session_start"); eq(factory, replaced); ok(notices.at(-1).includes("--prefix-history"));
    factory = undefined; await emit("session_start"); await emit("session_shutdown"); eq(factory, undefined);
  }
  // Load the real extension through Pi's loader; only the public history entry point is registered.
  const { loadExtensions } = await import(pathToFileURL(join(sdk, "dist/core/extensions/loader.js")).href);
  const loaded = await loadExtensions([join(project, "history-only.ts")], project);
  eq(loaded.errors, []); eq(loaded.extensions.length, 1); eq(loaded.extensions[0].commands.size, 0); eq(loaded.extensions[0].tools.size, 0);
  return checks;
}
