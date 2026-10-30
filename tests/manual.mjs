import assert from "node:assert/strict";

/** Manual requests share prediction policy/lifecycle, without enabling automatic mode. */
export async function checkManual({ harness, assistant, usageResponse, bashEntry, entry, user, rendered, pause }) {
  let checks = 0;
  const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
  const ok = (value, label) => { assert.ok(value, label); checks++; };
  const type = (editor, text) => { for (const char of text) editor.handleInput(char); };
  const candidate = "MANUAL_CANDIDATE";
  const response = text => usageResponse(text ?? candidate, { input: 100, cacheRead: 25, output: 10 });
  const contextOf = request => JSON.stringify({ ...request.context,
    messages: request.context.messages.map(message => ({ ...message, timestamp: 0 })) });
  async function off(options = {}) {
    const h = harness({ timeoutMs: 2000, ...options });
    await h.start(); await h.command("off"); await h.begin(); await h.finish();
    eq(h.requests.length, 0); return h;
  }
  async function suggest(h) { await h.command("suggest"); await pause(); }
  function terminal(h) {
    let command;
    h.editor.onSubmit = text => { if (text.startsWith("/next ")) command = h.command(text.slice(6)); };
    return async args => { type(h.editor, `/next ${args}`); h.editor.handleInput("\r"); await command; };
  }

  // Explicit retry after automatic abstention; same small payload, separate fresh request.
  {
    let saves = 0;
    const h = harness({ settings: { load: () => "", save() { saves++; } } });
    await h.start(); await h.begin(); await h.finish(); await h.settleResponse(0, assistant("NO_SUGGESTION"));
    const payload = contextOf(h.requests[0]);
    await suggest(h); eq(h.requests.length, 2);
    eq(contextOf(h.requests[1]), payload);
    await h.settleResponse(1, response()); ok(rendered(h.editor).includes(candidate));
    eq(h.editor.getText(), ""); eq(h.ctx.model.id, "gpt-6.1-sol"); eq(h.ctx.thinkingLevel, "xhigh"); eq(h.authReads, 0); eq(saves, 0);
    await h.command("status"); ok(h.notices.at(-1).text.includes("on; model: openai/gpt-6-luna"));
    await suggest(h); eq(h.requests.length, 3, "suggest requests fresh text rather than recalling");
    ok(!rendered(h.editor).includes(candidate));
    await h.settleResponse(2, response("FRESH_MANUAL_CANDIDATE")); ok(rendered(h.editor).includes("FRESH_MANUAL_CANDIDATE"));
    h.editor.handleInput("\x1b"); await h.command("recall"); eq(h.requests.length, 3);
    ok(rendered(h.editor).includes("FRESH_MANUAL_CANDIDATE")); await h.shutdown();
  }
  // Off still observes a local exchange; one-off ghost/recall never turn automatic mode on.
  for (const prefixHistory of [false, true]) {
    let saves = 0;
    const h = await off({ prefixHistory, settings: { load: () => "", save() { saves++; } } });
    const entries = h.entries().length;
    await suggest(h); eq(h.requests.length, 1); eq(h.entries().length, entries);
    await h.settleResponse(0, response()); ok(rendered(h.editor).includes(candidate));
    h.editor.handleInput("\x1b"); await h.command("recall"); ok(rendered(h.editor).includes(candidate));
    eq(h.requests.length, 1); eq(h.editor.getText(), "");
    let submitted = [];
    h.editor.onSubmit = text => submitted.push(text);
    h.editor.handleInput("\r"); ok(!submitted.includes(candidate), "Enter never accepts a manual ghost");
    await h.command("recall"); h.editor.handleInput("\t"); eq(h.editor.getText(), candidate);
    eq(submitted.includes(candidate), false); h.editor.setText("");
    await h.command("status"); ok(h.notices.at(-1).text.includes("Pi-next: off;"));
    ok(h.notices.at(-1).text.includes("Reported tokens: 125 in / 10 out (1/1 reports)"));
    eq(saves, 0); eq(h.authReads, 0);
    await h.begin({ text: "another local exchange" }); await h.finish();
    eq(h.requests.length, 1, "manual generation does not enable later automatic requests"); await h.shutdown();
  }
  // Automatic dismissal during a run must not prevent a later explicit request for its completed exchange.
  for (const dismiss of [
    h => { h.editor.handleInput("x"); h.editor.handleInput("\x7f"); },
    h => h.command("off"),
    async h => { await h.emit("ui_prompt_start", { kind: "custom" }); await h.emit("ui_prompt_end", { kind: "custom" }); },
  ]) {
    const h = harness(); await h.start(); await h.begin(); await dismiss(h); await h.finish();
    eq(h.requests.length, 0); await suggest(h); eq(h.requests.length, 1);
    await h.settleResponse(0, response()); ok(rendered(h.editor).includes(candidate)); await h.shutdown();
  }
  // Both automatic and manual in-flight requests are shared, including real editor typing.
  for (const automatic of [false, true]) for (const prefixHistory of [false, true]) {
    const h = automatic ? harness({ timeoutMs: 2000, prefixHistory }) : await off({ prefixHistory });
    if (automatic) { await h.start(); await h.begin(); await h.finish(); }
    else await suggest(h);
    const issue = terminal(h), payload = contextOf(h.requests[0]);
    await issue("suggest"); await issue("suggest");
    eq(h.requests.length, 1); eq(h.requests[0].options.signal.aborted, false);
    ok(h.notices.at(-1).text.includes("already being generated"));
    await issue("status"); eq(h.requests[0].options.signal.aborted, false);
    await issue("recall"); ok(h.notices.at(-1).text.includes("still being generated"));
    await h.settleResponse(0, response()); ok(rendered(h.editor).includes(candidate));
    eq(contextOf(h.requests[0]), payload); ok(!payload.includes("/next suggest"));
    await h.command("status"); ok(h.notices.at(-1).text.includes(`Pi-next: ${automatic ? "on" : "off"};`));
    ok(h.notices.at(-1).text.includes("attempts: 1; offered: 1")); await h.shutdown();
  }
  {
    const h = await off(); await suggest(h); await suggest(h);
    await h.settleResponse(0, assistant("NO_SUGGESTION"));
    eq(h.requests.length, 1); ok(h.notices.at(-1).text.includes("No useful suggestion")); await h.shutdown();
  }
  {
    const h = await off(); h.available(false); await suggest(h);
    eq(h.requests.length, 0); ok(h.notices.at(-1).text.includes("unavailable-model")); eq(h.authReads, 0); await h.shutdown();
  }
  for (const mode of ["rpc", "print", "json"]) {
    const h = harness({ mode }); await h.start(); await h.begin(); await h.finish(); await suggest(h);
    eq(h.requests.length, 0); eq(h.editor, undefined); ok(h.notices.at(-1).text.includes("terminal-only")); await h.shutdown();
  }
  for (const flag of ["", "bad", "openai/does-not-exist"]) {
    const h = harness({ flag }); await h.start(); await h.begin(); await h.finish(); await suggest(h);
    eq(h.requests.length, 0); eq(h.editor, undefined); ok(h.notices.at(-1).text.includes("/next model")); await h.shutdown();
  }
  {
    const h = harness(); h.replaceEntries([entry(user("historical prompt")), entry(assistant("historical reply"))]);
    await h.start(); eq(h.requests.length, 0, "resume does not start an automatic prediction");
    await suggest(h); eq(h.requests.length, 1);
    eq(JSON.parse(h.requests[0].context.messages[0].content[0].text), { userMessages: ["historical prompt"], assistantReply: "historical reply" });
    await h.shutdown();
  }
  // Readiness never permits overwriting drafts, taking another editor or interrupting work.
  for (const block of [
    h => { h.editor.setText("PRIVATE_DRAFT"); return () => h.editor.setText(""); },
    h => { h.ctx.ui.getEditorText = () => "FOREIGN_DRAFT"; return () => { h.ctx.ui.getEditorText = () => h.editor.getText(); }; },
    h => { h.editor.focused = false; return () => { h.editor.focused = true; }; },
    h => { h.editor.isShowingAutocomplete = () => true; return () => { h.editor.isShowingAutocomplete = () => false; }; },
    h => { h.setIdle(false); return () => h.setIdle(true); },
    h => { h.queue(true); return () => h.queue(false); },
    h => { const original = h.factory; h.setFactory(() => {}); return () => h.setFactory(original); },
    async h => { await h.emit("ui_prompt_start", { kind: "custom" }); return () => h.emit("ui_prompt_end", { kind: "custom" }); },
  ]) {
    const h = await off(), unblock = await block(h), text = h.editor.getText(), factory = h.factory;
    await suggest(h); eq(h.requests.length, 0); eq(h.editor.getText(), text); eq(h.factory, factory);
    await unblock(); await suggest(h); eq(h.requests.length, 1); await h.shutdown();
  }
  for (const finish of [{ reply: "Shall I delete those files?" }, { reply: "" }, { stopReason: "length" },
    { outcome: "error", stopReason: "error" }, { aborted: true }, { continuation: true }]) {
    const h = harness(); await h.start(); await h.command("off"); await h.begin(); await h.finish(finish); await suggest(h);
    eq(h.requests.length, 0); ok(/No useful suggestion|No current local exchange/.test(h.notices.at(-1).text)); await h.shutdown();
  }
  for (const input of [{ source: "extension" }, { source: "rpc" }, { text: "[Telegram from Oliver] hello" },
    { text: "Telegram: hello" }, { text: "/skill:whatever" }, { images: [{ type: "image", data: "PRIVATE_IMAGE" }] }]) {
    const h = harness(); await h.start(); await h.command("off"); await h.begin(input); await h.finish(); await suggest(h);
    eq(h.requests.length, 0); await h.shutdown();
  }
  {
    const h = await off(); h.project(h.entries().map(e => ({ sourceEntry: e, messages: [] })));
    await suggest(h); eq(h.requests.length, 0); ok(h.notices.at(-1).text.includes("No useful suggestion")); await h.shutdown();
  }
  {
    const h = harness(); await h.start(); await h.command("off");
    for (const text of ["first local", "second local", "third local", "fourth local"]) { await h.begin({ text }); await h.finish(); }
    await suggest(h); eq(h.requests.length, 1);
    eq(JSON.parse(h.requests[0].context.messages[0].content[0].text).userMessages, ["second local", "third local", "fourth local"]);
    await h.shutdown();
  }
  {
    const h = harness(); await h.start(); await h.command("off"); await h.begin();
    h.entries().push({ type: "custom_message", id: "mixed-source", customType: "external", content: "PRIVATE_CUSTOM" });
    await h.finish(); await suggest(h); eq(h.requests.length, 0); await h.shutdown();
  }
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "session_tree"]) {
    const h = await off(); await h.emit(event); await suggest(h); eq(h.requests.length, 0); await h.shutdown();
  }
  for (const broken of ["getBranch", "buildSessionProjection"]) {
    const h = await off();
    if (broken === "getBranch") h.entries().push(bashEntry());
    h.ctx.sessionManager[broken] = () => { throw new Error("PRIVATE_CONTEXT_ERROR"); };
    await suggest(h); eq(h.requests.length, 0); ok(h.notices.at(-1).text.includes("Could not read the current exchange"));
    ok(!JSON.stringify(h.notices).includes("PRIVATE_CONTEXT_ERROR")); await h.shutdown();
  }
  // Shell-only additions remain eligible, but no shell command or output enters the payload.
  for (const pending of [false, true]) {
    const h = await off(); await suggest(h);
    const payload = contextOf(h.requests[0]);
    if (!pending) await h.settleResponse(0, response());
    h.editor.setText("!!PRIVATE_SHELL_COMMAND");
    await h.emit("user_bash", { command: "PRIVATE_SHELL_COMMAND", excludeFromContext: true });
    h.editor.setText("/next suggest"); // Replaces the held draft without ordinary editing.
    h.editor.onSubmit = () => {}; h.editor.handleInput("\r");
    await suggest(h); eq(h.requests.length, 1); ok(h.notices.at(-1).text.includes("Wait for the shell"));
    h.entries().push(bashEntry({ command: "PRIVATE_SHELL_COMMAND", excludeFromContext: true }));
    if (pending) await h.settleResponse(0, response());
    ok(rendered(h.editor).includes(candidate), "manual-off candidates restore after a completed shell detour");
    await suggest(h); eq(h.requests.length, 2);
    eq(contextOf(h.requests[1]), payload); ok(!payload.includes("PRIVATE_SHELL"));
    await h.settleResponse(1, response()); await h.command("status");
    ok(h.notices.at(-1).text.includes("Pi-next: off;")); await h.shutdown();
  }
  // No old-exchange fallback or resurrection after a detected branch/context change.
  for (const change of [
    h => h.entries().push(entry(user("unobserved user"))),
    h => h.entries().push(entry(assistant("unobserved reply"))),
    h => h.entries().push({ type: "context_edit", id: "context-changed" }),
    h => h.entries().push({ type: "label", id: "metadata-changed" }),
    h => h.session("other-session"),
  ]) {
    const h = await off(), previous = [...h.entries()]; change(h); await suggest(h); eq(h.requests.length, 0);
    h.replaceEntries(previous); h.session("session-a"); await suggest(h); eq(h.requests.length, 0); await h.shutdown();
  }
  for (const cancel of [
    h => h.editor.handleInput("\x1b"), h => h.editor.handleInput("\x03"),
    h => { h.editor.handleInput("x"); h.editor.handleInput("\x7f"); },
    h => h.command("off"), h => h.command("on"),
    h => h.emit("input", { source: "extension", text: "new remote input" }),
    h => h.emit("session_before_switch"), h => h.emit("session_before_fork"),
    h => h.emit("session_before_tree"), h => h.emit("session_before_compact"),
    h => h.emit("ui_prompt_start", { kind: "custom" }), h => h.shutdown(),
  ]) {
    const h = await off(); await suggest(h); await cancel(h);
    eq(h.requests[0].options.signal.aborted, true);
    await h.settleResponse(0, response()); ok(!h.editor || !rendered(h.editor).includes(candidate)); await h.shutdown();
  }
  for (const result of [assistant("NO_SUGGESTION"), assistant("invalid\noutput"), assistant("PRIVATE_FAILURE", "error")]) {
    const h = await off(); await suggest(h); await h.settleResponse(0, result);
    ok(/No useful suggestion|Could not generate/.test(h.notices.at(-1).text));
    ok(!JSON.stringify(h.notices).includes("PRIVATE_FAILURE")); eq(h.requests.length, 1);
    await h.command("recall"); ok(!rendered(h.editor).includes(candidate)); await h.shutdown();
  }
  {
    const h = await off(); await suggest(h); h.requests[0].task.reject(new Error("PRIVATE_PROVIDER_BODY")); await pause();
    ok(h.notices.at(-1).text.includes("Could not generate")); ok(!JSON.stringify(h.notices).includes("PRIVATE_PROVIDER_BODY"));
    await suggest(h); eq(h.requests.length, 2, "failure releases the request for an explicit retry"); await h.shutdown();
  }
  {
    const h = await off({ timeoutMs: 8 }); await suggest(h); await pause(25);
    ok(h.notices.at(-1).text.includes("timed out")); eq(h.requests[0].options.signal.aborted, true); eq(h.requests.length, 1);
    await h.settleResponse(0, response()); ok(!rendered(h.editor).includes(candidate));
    await h.command("status"); ok(h.notices.at(-1).text.includes("Reported tokens: 125 in / 10 out (1/1 reports)"));
    await suggest(h); eq(h.requests.length, 2); await h.shutdown();
  }
  return checks;
}
