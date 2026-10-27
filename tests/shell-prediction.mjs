import assert from "node:assert/strict";

/** Delayed provider results stay request-bound and recall-only during local shell input. */
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
  function terminal(h, deferBash = false) {
    const submitted = [], results = [];
    let command;
    h.editor.onSubmit = text => {
      submitted.push(text);
      if (text.startsWith("!")) {
        const result = bashEntry({ command: text.replace(/^!!?/, ""), excludeFromContext: text.startsWith("!!") });
        if (deferBash) results.push(result); else h.entries().push(result);
      } else if (text.startsWith("/next-prompt ")) command = h.command(text.slice(13));
    };
    return { submitted, finish: () => h.entries().push(...results.splice(0)),
      issue: async args => { type(h.editor, `/next-prompt ${args}`); h.editor.handleInput("\r"); await command; } };
  }
  for (const prefixHistory of [false, true]) for (const timing of ["typing", "running", "finished"]) {
    const h = await pending({ prefixHistory }), t = terminal(h, timing === "running");
    const payload = JSON.stringify(h.requests[0].context);
    type(h.editor, `${timing === "running" ? "!!" : "!"}PRIVATE_SHELL_DRAFT`);
    eq(h.requests[0].options.signal.aborted, false, "shell typing preserves the existing request");
    if (timing !== "typing") h.editor.handleInput("\r");
    await h.settleResponse(0, response());
    ok(!rendered(h.editor).includes(candidate), "never show a deferred result automatically, even in an empty editor");
    if (timing === "typing") {
      eq(h.editor.getText(), "!PRIVATE_SHELL_DRAFT", "background completion never touches the draft");
      h.editor.handleInput("\r");
    }
    t.finish();
    await h.command("status");
    ok(h.notices.at(-1).text.includes("attempts: 1; offered: 0; last outcome: cached-for-recall"));
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
    type(h.editor, "!echo 1"); h.editor.handleInput("\r");
    await t.issue("status"); eq(h.requests[0].options.signal.aborted, false);
    ok(h.notices.at(-1).text.includes("request-pending:recall-only"));
    await t.issue("recall"); ok(h.notices.at(-1).text.includes("still being generated"));
    eq(h.requests.length, 1); eq(h.requests[0].options.signal.aborted, false);
    await h.settleResponse(0, response()); ok(!rendered(h.editor).includes(candidate));
    await t.issue("recall"); ok(rendered(h.editor).includes(candidate)); eq(h.requests.length, 1);
    await h.shutdown();
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
