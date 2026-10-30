import assert from "node:assert/strict";

/** Explicit use of retained history must not expand automatic input attribution. */
export async function checkResumed({ core, harness, assistant, usageResponse, bashEntry, entry, user, rendered, pause }) {
  let checks = 0;
  const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
  const ok = (value, label) => { assert.ok(value, label); checks++; };
  const projected = sourceEntry => ({ sourceEntry, messages: sourceEntry.type === "message" ? [sourceEntry.message] : [] });
  const history = () => [entry(user("first saved prompt")), entry(assistant("first saved reply")),
    entry(user("latest saved prompt")), entry(assistant("latest saved reply"))];
  const data = request => JSON.parse(request.context.messages[0].content[0].text);
  const response = () => usageResponse("RESUMED_CANDIDATE", { input: 100, output: 10 });
  const suggest = async h => { await h.command("suggest"); await pause(); };

  for (const reason of ["startup", "resume", "reload", "fork"]) for (const automatic of [false, true]) {
    let saves = 0;
    const h = harness({ settings: { load: () => "", save() { saves++; } } });
    h.replaceEntries(history());
    await h.emit("session_start", { reason }); if (!automatic) await h.command("off");
    eq(h.requests.length, 0); await h.emit("agent_settled", { aborted: false }); eq(h.requests.length, 0);
    await h.command("recall"); eq(h.requests.length, 0); ok(h.notices.at(-1).text.includes("No suggestion to recall"));
    const before = h.entries().length;
    await suggest(h); eq(h.requests.length, 1); eq(h.entries().length, before);
    eq(data(h.requests[0]), { userMessages: ["first saved prompt", "latest saved prompt"], assistantReply: "latest saved reply" });
    await suggest(h); eq(h.requests.length, 1); eq(h.requests[0].options.signal.aborted, false);
    await h.settleResponse(0, response()); ok(rendered(h.editor).includes("RESUMED_CANDIDATE")); eq(h.editor.getText(), "");
    h.editor.handleInput("\x1b"); await h.command("recall");
    ok(rendered(h.editor).includes("RESUMED_CANDIDATE")); eq(h.requests.length, 1);
    await h.command("status"); ok(h.notices.at(-1).text.includes(`Pi-next: ${automatic ? "on" : "off"};`));
    eq(saves, 0); eq(h.authReads, 0); eq(h.ctx.model.id, "gpt-6.1-sol"); eq(h.ctx.thinkingLevel, "xhigh");
    await h.begin({ text: "new locally observed prompt" }); await h.finish();
    eq(h.requests.length, automatic ? 2 : 1);
    if (!automatic) await suggest(h);
    eq(data(h.requests[1]).userMessages, ["new locally observed prompt"], "resumed user IDs never enter local automatic attribution");
    await h.shutdown();
  }
  // Actual projected text is used; summaries, tools, thinking and shell data are excluded.
  {
    const branch = history(), latestUser = branch.at(-2), latestReply = branch.at(-1);
    latestReply.message.content.unshift({ type: "thinking", thinking: "PRIVATE_THINKING" });
    const tool = entry({ role: "toolResult", content: [{ type: "text", text: "PRIVATE_TOOL" }] });
    branch.splice(branch.length - 1, 0, tool);
    const projection = branch.map(projected);
    projection.find(e => e.sourceEntry.id === latestUser.id).messages = [user("edited saved prompt")];
    projection.find(e => e.sourceEntry.id === latestReply.id).messages = [assistant("edited saved reply")];
    projection.unshift({ sourceEntry: { type: "compaction", id: "summary" }, messages: [user("PRIVATE_SUMMARY")] });
    const shell = bashEntry({ command: "PRIVATE_SHELL_COMMAND", output: "PRIVATE_SHELL_OUTPUT" });
    branch.push(shell); projection.push(projected(shell));
    const resumed = core.buildResumedPayload(projection, branch);
    eq(JSON.parse(resumed.payload), { userMessages: ["first saved prompt", "edited saved prompt"], assistantReply: "edited saved reply" });
    ok(!resumed.payload.includes("PRIVATE_")); eq([...resumed.users], [branch[0].id, latestUser.id]);
  }
  {
    const branch = [];
    for (let i = 0; i < 6; i++) branch.push(entry(user(`saved-${i} ${'\\"'.repeat(2000)}`)), entry(assistant('\\"'.repeat(5000))));
    const resumed = core.buildResumedPayload(branch.map(projected), branch), payload = JSON.parse(resumed.payload);
    ok(resumed.payload.length <= core.MAX_CONTEXT); ok(resumed.users.size <= 3);
    ok(payload.userMessages.length <= 3); ok(payload.userMessages.every(text => text.length <= 1000));
    ok(payload.assistantReply.length <= 4000); ok(payload.userMessages.at(-1).startsWith("saved-5"));
  }
  {
    const branch = [entry({ ...user("PRIVATE_OLD_IMAGE_PROMPT"), content: [
      { type: "text", text: "PRIVATE_OLD_IMAGE_PROMPT" }, { type: "image", data: "PRIVATE_OLD_IMAGE" },
    ] }), entry(assistant("old image reply")), entry(user("Telegram: PRIVATE_OLD_REMOTE")),
    entry(assistant("old remote reply")), ...history()];
    const resumed = core.buildResumedPayload(branch.map(projected), branch);
    eq(JSON.parse(resumed.payload).userMessages, ["first saved prompt", "latest saved prompt"]);
    ok(!resumed.payload.includes("PRIVATE_"));
  }
  const tails = [
    () => [entry(user("unanswered latest user"))],
    ...["pending", "error", "aborted", "length", "toolUse", "deferred"].map(reason => () => [entry(user("latest")), entry(assistant("INCOMPLETE_LATEST", reason))]),
    () => [entry(user("latest")), entry(assistant("Shall I delete those files?"))],
    () => [entry(user("latest")), entry(assistant(""))],
    () => [entry(user("latest")), entry({ ...assistant(""), content: [{ type: "thinking", thinking: "PRIVATE_THINKING_ONLY" }] })],
    () => [entry(user("latest")), entry({ ...assistant("text"), content: [{ type: "toolCall", id: "call", name: "bash", arguments: {} }] })],
    () => [entry(user("latest")), entry({ role: "toolResult", content: [{ type: "text", text: "PRIVATE_LAST_TOOL" }] })],
    () => [{ type: "custom_message", id: "external", content: "PRIVATE_CUSTOM" }],
    () => [entry(user("latest")), { type: "custom_message", id: "mixed", content: "PRIVATE_CUSTOM" }, entry(assistant("reply to mixed sources"))],
    () => [entry(user("latest")), entry({ role: "custom", content: "PRIVATE_CUSTOM" }), entry(assistant("reply to mixed sources"))],
    () => [{ type: "branch_summary", id: "branch-summary", summary: "PRIVATE_BRANCH" }],
    ...["", "!git status", "!!git status", "/skill:whatever", "[Telegram from Oliver] message", "Telegram: message", "[intercom] message"].map(text => () => [entry(user(text)), entry(assistant("latest reply"))]),
    () => [entry({ ...user("image question"), content: [{ type: "text", text: "image question" }, { type: "image", data: "PRIVATE_IMAGE" }] }), entry(assistant("latest reply"))],
  ];
  for (const tail of tails) {
    const branch = [...history(), ...tail()];
    eq(core.buildResumedPayload(branch.map(projected), branch), undefined, "never falls back to an older successful exchange");
    const h = harness(); h.replaceEntries(branch); await h.start(); await suggest(h);
    eq(h.requests.length, 0); ok(h.notices.at(-1).text.includes("No useful suggestion")); await h.shutdown();
  }
  // An omitted latest pair stays omitted, even though raw ancestors are still in the session.
  for (const target of ["user", "assistant"]) for (const omit of [true, false]) {
    const branch = history(), latest = branch[target === "user" ? 2 : 3];
    const projection = branch.map(projected).map(e => e.sourceEntry.id === latest.id
      ? { sourceEntry: e.sourceEntry, messages: omit ? [] : [target === "user" ? user("Telegram: edited remote input") : assistant("edited incomplete reply", "error")] } : e);
    eq(core.buildResumedPayload(projection, branch), undefined);
    const h = harness(); h.replaceEntries(branch); h.project(projection); await h.start(); await suggest(h);
    eq(h.requests.length, 0); await h.shutdown();
  }
  {
    const branch = history(), projection = branch.map(projected).slice(3);
    projection.unshift({ sourceEntry: { type: "compaction", id: "summary" }, messages: [user("PRIVATE_SUMMARY")] });
    eq(core.buildResumedPayload(projection, branch), undefined, "does not recover a compacted-away user from raw history");
  }
  for (const change of [
    h => h.entries().push(entry(user("new unobserved user"))), h => h.session("other-session"),
    h => h.entries().push({ type: "context_edit", id: "context-changed" }),
    h => h.emit("input", { source: "extension", text: "remote input" }),
    h => h.emit("session_before_switch"), h => h.emit("session_before_fork"),
    h => h.emit("session_before_tree"), h => h.emit("session_before_compact"),
  ]) {
    const h = harness(), previous = history(); h.replaceEntries([...previous]); await h.start(); await change(h); await suggest(h);
    eq(h.requests.length, 0);
    h.replaceEntries(previous); h.session("session-a"); await suggest(h); eq(h.requests.length, 0, "expired resume anchors never revive older history"); await h.shutdown();
  }
  {
    const h = harness(); h.replaceEntries(history()); await h.start(); await suggest(h);
    h.entries().push(entry(user("new unobserved input")));
    await h.settleResponse(0, response()); ok(!rendered(h.editor).includes("RESUMED_CANDIDATE"));
    eq(h.requests.length, 1); await h.shutdown();
  }
  return checks;
}
