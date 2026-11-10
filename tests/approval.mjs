import assert from "node:assert/strict";

/** Approval questions are prediction context, not a veto or a default answer. */
export async function checkApproval({ core, harness, assistant, entry, user, rendered, pause }) {
  let checks = 0;
  const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
  const ok = (value, label) => { assert.ok(value, label); checks++; };
  const projected = sourceEntry => ({ sourceEntry, messages: [sourceEntry.message] });
  const prompt = "Let's decide the next step.";
  const researchReply = `## Next

The cheapest informative step is to run the existing probe on the first group. Two-state-rad likely needs a different idea, and I'd keep it as a held-out case. Two questions for you:
- Should I change the 1b reference point or keep the special point as a documented case?
- Should the two sampled maps move to non-uniform times?

Everything is in \`notes/2026-11-05-iir-baseline.md\`, with outputs and checks in \`experiments/iir-baseline/\`.`;
  const cases = [
    [researchReply, "Yes, run the existing probe on the first group and keep two-state-rad held out."],
    [researchReply, "No, leave the baseline unchanged for now."],
    [researchReply, "Run the first-group probe, but show me the results before changing either map."],
    [researchReply, "Keep the special point documented and try non-uniform times for the two maps."],
    ["Shall I delete the generated scratch files?", "Yes, delete those generated scratch files."],
    ["May I push the commit to origin?", "No, leave the commit local for now."],
    ["Can I publish version 0.3.1?", "Yes, publish version 0.3.1."],
    ["Do you want me to send the draft to the named recipient?", "Show me the final draft before sending it."],
    ["Would you like me to run the existing probe?", "Yes, run the existing probe."],
    ["Please confirm: delete the temporary directory?", "No, keep the temporary directory."],
    ["Can I have your approval to send this draft?", "Yes, send that draft."],
  ];
  ok(core.SYSTEM_PROMPT.includes("the user might agree, decline, add a condition, or choose among the offered options"));
  ok(core.SYSTEM_PROMPT.includes("without defaulting to agreement or refusal"));
  ok(core.SYSTEM_PROMPT.includes("Name the action or option when a bare yes or no would be ambiguous"));
  ok(core.SYSTEM_PROMPT.includes("If no specific useful continuation is supported, return exactly NO_SUGGESTION"));
  ok(!/manufacture consent|If the assistant is asking for permission/.test(core.SYSTEM_PROMPT));

  async function request(h, route, reply) {
    if (route === "resumed") h.replaceEntries([entry(user(prompt)), entry(assistant(reply))]);
    await h.start();
    if (route !== "automatic") await h.command("off");
    if (route !== "resumed") { await h.begin({ text: prompt }); await h.finish({ reply }); }
    if (route !== "automatic") {
      eq(h.requests.length, 0, "manual/resumed approval context never enables automatic prediction");
      await h.command("suggest"); await pause();
    }
    eq(h.requests.length, 1, `${route}: approval context reaches the model`);
  }

  for (const [reply, candidate] of cases) {
    const branch = [entry(user(prompt)), entry(assistant(reply))], projection = branch.map(projected);
    const expected = { userMessages: [prompt], assistantReply: reply };
    eq(JSON.parse(core.buildPayload(projection, branch[0].id, new Set([branch[0].id]))), expected);
    eq(JSON.parse(core.buildResumedPayload(projection, branch).payload), expected);
    eq(core.normaliseSuggestion(assistant(candidate)), candidate);
    for (const route of ["automatic", "manual", "resumed"]) {
      let saves = 0;
      const h = harness({ timeoutMs: 2000, settings: { load: () => "", save() { saves++; } } });
      await request(h, route, reply);
      const submitted = [], before = h.entries().length;
      h.editor.onSubmit = text => submitted.push(text);
      eq(h.requests[0].context.systemPrompt, core.SYSTEM_PROMPT);
      eq(JSON.parse(h.requests[0].context.messages[0].content[0].text), expected);
      eq(h.requests[0].context.tools, []); eq(h.requests[0].options.toolChoice, "none");
      await h.settleResponse(0, assistant(candidate));
      ok(rendered(h.editor).includes(candidate.slice(0, 24)));
      eq(h.editor.getText(), ""); eq(submitted, []); eq(h.entries().length, before);
      h.editor.handleInput("\r");
      eq(h.editor.getText(), ""); ok(!submitted.includes(candidate), "Enter never accepts an approval ghost");
      await h.command("recall"); eq(h.requests.length, 1, "recall does not request a different answer");
      h.editor.handleInput(route === "manual" ? "\x1b[C" : "\t");
      eq(h.editor.getText(), candidate); ok(!submitted.includes(candidate), "insertion is not submission");
      eq(h.entries().length, before); eq(h.authReads, 0); eq(saves, 0);
      eq(h.ctx.model.id, "gpt-6.1-sol"); eq(h.ctx.thinkingLevel, "xhigh");
      await h.shutdown();
    }
  }
  // Removing the question veto does not force a candidate when the model abstains.
  for (const route of ["automatic", "manual", "resumed"]) {
    const h = harness({ timeoutMs: 2000 }); await request(h, route, researchReply);
    await h.settleResponse(0, assistant("NO_SUGGESTION"));
    eq(core.inspectSuggestion(assistant("NO_SUGGESTION")).outcome, "abstained");
    await h.command("recall"); eq(h.requests.length, 1);
    ok(h.notices.at(-1).text.includes("No suggestion to recall"));
    eq(h.editor.getText(), ""); await h.shutdown();
  }
  return checks;
}
