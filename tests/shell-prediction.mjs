import assert from "node:assert/strict";

/** Shell commands pause the same request/candidate; only completed shell detours can restore it. */
export async function checkShellPrediction({ harness, assistant, usageResponse, bashEntry, entry, user, rendered, pause }) {
  let checks = 0;
  const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
  const ok = (value, label) => { assert.ok(value, label); checks++; };
  const type = (editor, text) => { for (const char of text) editor.handleInput(char); };
  const candidate = "CACHED_SHELL_FOLLOWUP";
  const response = () => usageResponse(candidate, { input: 125, cacheRead: 25, output: 10 });
  async function pending(options = {}) {
    const h = harness({ timeoutMs: 2000, ...options });
    await h.start(); await h.begin(); await h.finish();
    eq(h.requests.length, 1); return h;
  }
  function terminal(h, deferBash = false, resultFields = {}) {
    const submitted = [], results = [];
    let command, shell;
    h.editor.onSubmit = text => {
      submitted.push(text);
      if (text.startsWith("!")) {
        const fields = { command: text.replace(/^!!?/, ""), excludeFromContext: text.startsWith("!!") };
        shell = (async () => {
          await h.emit("user_bash", fields);
          const result = bashEntry({ ...fields, ...resultFields });
          if (deferBash) results.push(result); else h.entries().push(result);
        })();
      } else if (text === "/next-prompt-recall") command = h.namedCommand("next-prompt-recall");
      else if (text.startsWith("/next-prompt ")) command = h.command(text.slice(13));
    };
    return { submitted, wait: () => shell, finish: () => h.entries().push(...results.splice(0)),
      issue: async (args, alias = false) => { type(h.editor, alias ? "/next-prompt-recall" : `/next-prompt ${args}`); h.editor.handleInput("\r"); await command; } };
  }
  for (const prefixHistory of [false, true]) for (const timing of ["typing", "running", "finished"]) {
    const h = await pending({ prefixHistory }), t = terminal(h, timing === "running");
    const payload = JSON.stringify(h.requests[0].context);
    type(h.editor, `${timing === "running" ? "!!" : "!"}PRIVATE_SHELL_DRAFT`);
    eq(h.requests[0].options.signal.aborted, false, "shell typing preserves the existing request");
    if (timing !== "typing") { h.editor.handleInput("\r"); await t.wait(); }
    await h.settleResponse(0, response());
    eq(rendered(h.editor).includes(candidate), timing === "finished", "no return while typing/running; return after a completed command");
    if (timing === "typing") {
      eq(h.editor.getText(), "!PRIVATE_SHELL_DRAFT", "background completion never touches the draft");
      h.editor.handleInput("\r"); await t.wait();
    }
    t.finish();
    ok(rendered(h.editor).includes(candidate), "same candidate returns automatically after the shell result is recorded");
    eq(h.editor.getText(), "");
    await h.command("status");
    ok(h.notices.at(-1).text.includes("attempts: 1; offered: 1; last outcome: restored-after-shell"));
    ok(h.notices.at(-1).text.includes("Reported tokens: 150 in / 10 out (1/1 reports)"));
    await t.issue("recall"); ok(rendered(h.editor).includes(candidate)); eq(h.editor.getText(), "");
    eq(h.requests.length, 1); eq(JSON.stringify(h.requests[0].context), payload);
    ok(!payload.includes("PRIVATE_SHELL_DRAFT"), "command text is not sent to the predictor");
    h.editor.handleInput("\r"); ok(!t.submitted.includes(candidate), "Enter still never accepts ghost text");
    await t.issue("recall"); h.editor.handleInput("\t"); eq(h.editor.getText(), candidate);
    eq(t.submitted.filter(text => text.startsWith("!")).length, 1, "only explicit Enter executes the fixture shell command");
    eq(h.requests.length, 1); await h.shutdown();
  }
  // Checking status/recall early, including typing their prefixes, must not cancel or restart the request.
  {
    const h = await pending(), t = terminal(h);
    type(h.editor, "!echo 1"); h.editor.handleInput("\r"); await t.wait();
    await t.issue("status"); eq(h.requests[0].options.signal.aborted, false);
    ok(h.notices.at(-1).text.includes("request-pending:shell"));
    await t.issue("recall", true); ok(h.notices.at(-1).text.includes("still being generated"));
    eq(h.requests.length, 1); eq(h.requests[0].options.signal.aborted, false);
    await h.settleResponse(0, response()); ok(rendered(h.editor).includes(candidate));
    await t.issue("recall"); ok(rendered(h.editor).includes(candidate)); eq(h.requests.length, 1);
    await h.shutdown();
  }
  // Already visible suggestions return too, but a cancelled command does not resurrect one.
  for (const prefixHistory of [false, true]) for (const fields of [{}, { exitCode: 1 }, { cancelled: true }]) {
    const h = await pending({ prefixHistory }); await h.settleResponse(0, response());
    ok(rendered(h.editor).includes(candidate));
    const t = terminal(h, true, fields);
    for (const command of ["!echo first", "!!echo second"]) {
      type(h.editor, command); h.editor.handleInput("\r"); await t.wait();
      ok(!rendered(h.editor).includes(candidate), "hide an existing ghost throughout execution");
      t.finish(); eq(rendered(h.editor).includes(candidate), !fields.cancelled);
      if (fields.cancelled) { await t.issue("recall"); ok(rendered(h.editor).includes(candidate)); }
      for (let i = 0; i < 5; i++) rendered(h.editor);
      eq(h.requests.length, 1); eq(h.editor.getText(), "");
    }
    await h.command("status"); ok(h.notices.at(-1).text.includes("attempts: 1; offered: 1"));
    await h.shutdown();
  }
  // Dismissal is not a pause: later shell commands must not revive a dismissed candidate.
  for (const dismiss of [
    h => h.editor.handleInput("\x1b"),
    h => { type(h.editor, "ordinary"); h.editor.setText(""); },
    h => h.editor.setText(""),
  ]) {
    const h = await pending(); await h.settleResponse(0, response()); dismiss(h);
    const t = terminal(h); type(h.editor, "!echo dismissed"); h.editor.handleInput("\r"); await t.wait();
    ok(!rendered(h.editor).includes(candidate)); await t.issue("recall"); ok(rendered(h.editor).includes(candidate));
    type(h.editor, "!echo visible-again"); h.editor.handleInput("\r"); await t.wait();
    ok(rendered(h.editor).includes(candidate), "explicit recall re-arms the now-visible suggestion for a later shell detour");
    eq(h.requests.length, 1); await h.shutdown();
  }
  // Once cached, editing/Escape still disarm automatic return without losing explicit recall.
  for (const cancel of [
    h => h.editor.handleInput("\x1b"),
    h => h.editor.handleInput("\x03"),
    h => { type(h.editor, "x"); h.editor.handleInput("\x7f"); },
    h => h.editor.setText(""),
  ]) {
    const h = await pending(), t = terminal(h, true);
    type(h.editor, "!echo cached"); h.editor.handleInput("\r"); await t.wait();
    await h.settleResponse(0, response()); ok(!rendered(h.editor).includes(candidate));
    cancel(h); t.finish(); ok(!rendered(h.editor).includes(candidate));
    await t.issue("recall"); ok(rendered(h.editor).includes(candidate)); eq(h.requests.length, 1); await h.shutdown();
  }
  // Readiness can delay a return, but rendering never writes over text or a completion menu.
  for (const [block, unblock] of [
    [h => { h.editor.focused = false; }, h => { h.editor.focused = true; }],
    [h => { h.editor.isShowingAutocomplete = () => true; }, h => { h.editor.isShowingAutocomplete = () => false; }],
    [h => h.queue(true), h => h.queue(false)],
    [h => h.setIdle(false), h => h.setIdle(true)],
    [h => { h.ctx.ui.getEditorText = () => "foreign draft"; }, h => { h.ctx.ui.getEditorText = () => h.editor.getText(); }],
  ]) {
    const h = await pending(), t = terminal(h, true);
    type(h.editor, "!echo blocked"); h.editor.handleInput("\r"); await t.wait();
    await h.settleResponse(0, response()); block(h); t.finish();
    ok(!rendered(h.editor).includes(candidate)); eq(h.editor.getText(), "");
    unblock(h); ok(rendered(h.editor).includes(candidate)); eq(h.requests.length, 1); await h.shutdown();
  }
  for (const change of [
    h => h.entries().push(entry(user("newer turn"))),
    h => h.entries().push(entry(assistant("newer reply"))),
    h => h.entries().push({ type: "context_edit", id: "changed-after-cache" }),
    h => h.session("other-session"),
    h => h.setFactory(() => {}),
    h => h.emit("session_before_switch"),
    h => h.emit("session_before_fork"),
    h => h.emit("session_before_tree"),
    h => h.emit("session_before_compact"),
    h => h.emit("ui_prompt_start", { kind: "custom" }),
  ]) {
    const h = await pending(), t = terminal(h, true);
    type(h.editor, "!echo stale"); h.editor.handleInput("\r"); await t.wait();
    await h.settleResponse(0, response()); await change(h); t.finish();
    ok(!rendered(h.editor).includes(candidate), "cached automatic return retains context/session/ownership guards");
    eq(h.requests.length, 1); await h.shutdown();
  }
  {
    const h = await pending(), t = terminal(h, true);
    type(h.editor, "!echo own-result"); h.editor.handleInput("\r"); await t.wait();
    await h.settleResponse(0, response());
    h.entries().push(bashEntry({ command: "unrelated external command" }));
    ok(!rendered(h.editor).includes(candidate), "unrelated shell results cannot complete the detour");
    t.finish(); ok(rendered(h.editor).includes(candidate)); eq(h.requests.length, 1); await h.shutdown();
  }
  {
    const h = await pending(), t = terminal(h, true);
    type(h.editor, "!echo first"); h.editor.handleInput("\r"); await t.wait();
    await h.settleResponse(0, response()); t.finish(); // No redraw before the next command.
    type(h.editor, "!!echo second"); h.editor.handleInput("\r"); await t.wait();
    ok(!rendered(h.editor).includes(candidate), "do not return between queued shell detours");
    t.finish(); ok(rendered(h.editor).includes(candidate)); eq(h.requests.length, 1); await h.shutdown();
  }
  for (const enterShell of [
    h => type(h.editor, "!"),
    h => h.editor.handleInput("\x1b[200~!!echo pasted\x1b[201~"),
    h => { h.editor.addToHistory("!echo history"); h.editor.handleInput("\x1b[A"); },
    h => h.editor.setText("!echo external-editor"),
    h => h.editor.insertTextAtCursor("!echo inserted"),
    h => h.editor.handleInput("\x1b[33u"),
  ]) {
    const h = await pending(); enterShell(h);
    ok(h.editor.getText().startsWith("!")); eq(h.requests[0].options.signal.aborted, false);
    await h.settleResponse(0, response()); ok(!rendered(h.editor).includes(candidate));
    h.editor.setText(""); await h.command("recall"); ok(rendered(h.editor).includes(candidate)); await h.shutdown();
  }
  {
    const h = await pending(); type(h.editor, "!");
    h.editor.setAutocompleteProvider({ triggerCharacters: ["!"],
      getSuggestions: () => ({ items: [{ value: "!native-one", label: "one" }, { value: "!native-two", label: "two" }], prefix: "!" }),
      applyCompletion: () => ({ lines: ["ordinary completion"], cursorLine: 0, cursorCol: 19 }) });
    h.editor.handleInput("\t"); await pause(); ok(h.editor.isShowingAutocomplete());
    h.editor.handleInput("\r"); eq(h.editor.getText(), "ordinary completion");
    eq(h.requests[0].options.signal.aborted, true, "Enter-completed non-shell text cancels rather than silently preserving a request");
    await h.settleResponse(0, response()); h.editor.setText(""); await h.command("recall");
    ok(!rendered(h.editor).includes(candidate)); await h.shutdown();
  }
  for (const cancel of [
    h => h.editor.handleInput("\x7f"), // Delete the sole !, not a command character.
    h => h.editor.handleInput("\x1b"),
    h => h.editor.handleInput("\x03"),
    h => h.editor.setText("ordinary draft"),
    h => { h.editor.setText("/next-prompt recall"); h.editor.handleInput("\x1b"); },
    h => h.command("off"),
    h => h.command("on"),
    h => h.command("model openai/gpt-6-luna"),
    h => h.emit("input", { source: "interactive", text: "new chat" }),
    h => h.emit("input", { source: "extension", text: "remote chat" }),
    h => h.emit("agent_start"),
    h => h.emit("session_before_switch"),
    h => h.emit("session_before_fork"),
    h => h.emit("session_before_tree"),
    h => h.emit("session_before_compact"),
    h => h.emit("ui_prompt_start", { kind: "custom" }),
  ]) {
    const h = await pending(); type(h.editor, "!"); await cancel(h);
    eq(h.requests[0].options.signal.aborted, true, "ordinary editing/explicit cancellation/context changes still abort");
    await h.settleResponse(0, response()); h.editor.setText(""); await h.command("recall");
    ok(!rendered(h.editor).includes(candidate)); eq(h.requests.length, 1); await h.shutdown();
  }
  for (const change of [
    h => h.entries().push(entry(user("unobserved newer turn"))),
    h => h.entries().push(entry(assistant("unobserved newer reply"))),
    h => h.entries().push({ type: "context_edit", id: "changed-context" }),
    h => h.session("another-session"),
    h => h.setFactory(() => {}),
    h => h.queue(true),
    h => h.setIdle(false),
  ]) {
    const h = await pending(); type(h.editor, "!"); change(h);
    await h.settleResponse(0, response()); h.queue(false); h.setIdle(true); h.editor.setText("");
    await h.command("recall"); ok(!rendered(h.editor).includes(candidate), "cache-only mode does not bypass freshness or ownership guards");
    eq(h.requests.length, 1); await h.shutdown();
  }
  for (const result of [assistant("NO_SUGGESTION"), assistant("invalid\noutput"), assistant("failure", "error")]) {
    const h = await pending(); type(h.editor, "!"); await h.settleResponse(0, result);
    h.editor.setText(""); await h.command("recall"); ok(!rendered(h.editor).includes(candidate));
    ok(h.notices.at(-1).text.includes("No suggestion")); eq(h.requests.length, 1); await h.shutdown();
  }
  {
    const h = await pending(); type(h.editor, "!"); h.editor.focused = false;
    await h.settleResponse(0, response()); ok(!rendered(h.editor).includes(candidate));
    h.editor.focused = true; h.editor.setText(""); await h.command("recall"); ok(rendered(h.editor).includes(candidate)); await h.shutdown();
  }
  {
    const h = await pending({ timeoutMs: 12 }); type(h.editor, "!"); await pause(35);
    eq(h.requests[0].options.signal.aborted, true);
    await h.settleResponse(0, response()); h.editor.setText(""); await h.command("recall");
    ok(!rendered(h.editor).includes(candidate), "late timed-out results never enter the cache"); eq(h.requests.length, 1); await h.shutdown();
  }
  {
    const h = harness(); await h.start(); await h.begin(); type(h.editor, "!"); await h.finish();
    eq(h.requests.length, 0, "shell input never starts a fresh prediction, even if the main reply is still finishing"); await h.shutdown();
  }
  return checks;
}
