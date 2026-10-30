import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Real Pi lifecycle and terminal submit handler, with synthetic context and no network/auth store. */
export async function checkSession({ host, ai, sdk, modules, project, KeybindingsManager, screen, theme, model, assistant, rendered, prefixHistory = false, historyOnly = false, shellDuringPrediction = false, manualSuggestion = false }) {
  const { Agent } = await import(pathToFileURL(join(modules, "@earendil-works/pi-agent-core/dist/index.js")).href);
  const { InteractiveMode } = await import(pathToFileURL(join(sdk, "dist/modes/interactive/interactive-mode.js")).href);
  const { loadExtensions } = await import(pathToFileURL(join(sdk, "dist/core/extensions/loader.js")).href);
  const cwd = mkdtempSync(join(tmpdir(), "pi-next-session-"));
  const fetchBefore = globalThis.fetch, agentDirBefore = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  globalThis.fetch = () => { throw new Error("Network is forbidden in this offline test"); };
  let session, releasePrediction, releaseShell, shellWork;
  const shellGate = shellDuringPrediction === "running" ? new Promise(resolve => { releaseShell = resolve; }) : undefined;
  const resumed = manualSuggestion === "resumed" || manualSuggestion === "resumed-pending";
  const waiting = manualSuggestion === "pending" || manualSuggestion === "resumed-pending";
  const predictionGate = shellDuringPrediction || waiting ? new Promise(resolve => { releasePrediction = resolve; }) : undefined;
  let checks = 0;
  try {
    const loaded = await loadExtensions([join(project, historyOnly ? "history-only.ts" : "index.ts")], cwd);
    assert.deepEqual(loaded.errors, []); checks++;
    if (prefixHistory) loaded.runtime.flagValues.set("prefix-history", true);
    const requests = [], errors = [], notices = [];
    let editor, factory, submitted, prediction = "show me an example", mainCalls = 0, pickerSearch = "luna", pickerCalls = 0;
    const ui = {
      getEditorText: () => editor?.getExpandedText() ?? "", getEditorComponent: () => factory,
      setEditorComponent: value => {
        factory = value;
        editor = value ? value(screen, theme, new KeybindingsManager()) : undefined;
        if (editor) { editor.setText(""); editor.focused = true; }
      },
      notify: text => notices.push(text),
      custom: factory => new Promise(resolve => {
        pickerCalls++;
        const picker = factory(screen, { fg: (_color, text) => text }, new KeybindingsManager(), resolve);
        picker.focused = true; picker.render(60);
        for (const character of pickerSearch) picker.handleInput(character);
        picker.handleInput("\r");
      }),
    };
    const google = { ...model, provider: "google", id: "gemini-fixture", api: "google-generative-ai", name: "Gemini fixture" };
    const catalog = [model, google];
    const runtime = {
      getModels: () => catalog, getAvailableSnapshot: () => catalog,
      getModel: (provider, id) => catalog.find(m => m.provider === provider && m.id === id),
      getModelOfType: (type, provider, id) => type === "chat" ? catalog.find(m => m.provider === provider && m.id === id) : undefined,
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      isUsingOAuth: () => true, hasConfiguredAuth: () => true,
      streamSimple: (_model, context, options) => {
        requests.push({ model: _model, context, options });
        const response = assistant(prediction);
        return { result: async () => {
          if (predictionGate) await predictionGate;
          return { ...response, usage: { ...response.usage,
            input: 100, cacheRead: 40, cacheWrite: 10, output: 20, reasoning: 5, totalTokens: 170 } };
        } };
      },
    };
    const resources = {
      getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "Offline fixture", getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      getResourceMetadata: () => new Map(),
    };
    let sessionManager = host.SessionManager.inMemory(cwd);
    if (resumed) {
      const saved = host.SessionManager.create(cwd, join(cwd, "sessions"));
      saved.appendMessage({ role: "user", content: "Explain closures. I may ask for an example next.", timestamp: 0 });
      saved.appendMessage(assistant("Saved explanation of closures."));
      const file = saved.getSessionFile();
      assert.ok(file && existsSync(file)); checks++;
      sessionManager = host.SessionManager.open(file, join(cwd, "sessions"));
      assert.equal(sessionManager.getSessionId(), saved.getSessionId()); checks++;
      assert.equal(sessionManager.buildSessionContext().messages.length, 2); checks++;
    }
    const agent = new Agent({ initialState: { model, thinkingLevel: "off", tools: [], messages: sessionManager.buildSessionContext().messages, systemPrompt: "Offline fixture" },
      convertToLlm: messages => messages,
      streamFn: async () => {
        mainCalls++;
        const result = assistant("A closure retains access to variables from its enclosing scope.");
        result.usage = { ...result.usage, input: 50000, output: 5000, totalTokens: 55000 };
        const stream = ai.createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: result });
          stream.push({ type: "done", reason: "stop", message: result });
          stream.end(result);
        });
        return stream;
      },
    });
    session = new host.AgentSession({ agent, cwd, modelRuntime: runtime,
      sessionManager,
      settingsManager: host.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoader: resources, initialActiveToolNames: [], baseToolsOverride: {},
    });
    await session.bindExtensions({ mode: "tui", uiContext: ui, onError: error => errors.push(error) });
    if (historyOnly) {
      assert.ok(editor instanceof host.CustomEditor); checks++;
      const commands = [];
      const terminal = { defaultEditor: editor, editor, session,
        handleBashCommand: async command => commands.push(command), updateEditorBorderColor() {} };
      InteractiveMode.prototype.setupEditorSubmitHandler.call(terminal);
      editor.setText("!printf history-only"); editor.handleInput("\r"); await new Promise(resolve => setImmediate(resolve));
      editor.setText("!p"); editor.handleInput("\x1b[A");
      assert.equal(editor.getText(), "!printf history-only"); checks++;
      editor.handleInput("\x1b[B"); assert.equal(editor.getText(), "!p"); checks++;
      assert.deepEqual(commands, ["printf history-only"], "only the explicit submission reaches the fixture shell handler"); checks++;
      assert.equal(requests.length, 0); checks++; assert.equal(mainCalls, 0); checks++;
      assert.equal(pickerCalls, 0); checks++;
      assert.equal(existsSync(join(cwd, "agent", "pi-next.json")), false, "history-only never creates model settings"); checks++;
      assert.deepEqual(errors, []); checks++;
      return checks;
    }
    const { CombinedAutocompleteProvider } = await import(pathToFileURL(join(modules, "@earendil-works/pi-tui/dist/index.js")).href);
    const autocomplete = new CombinedAutocompleteProvider(session.extensionRunner.getRegisteredCommands().map(command => ({
      name: command.invocationName, description: command.description,
    })), cwd);
    let recalledCommand, modelCommand;
    for (const [prefix, expected] of [["/next-r", "/next-recall"], ["/next-m", "/next-model"]]) {
      const suggestions = await autocomplete.getSuggestions([prefix], 0, prefix.length, { signal: new AbortController().signal });
      const item = suggestions?.items.find(item => item.value === expected.slice(1));
      assert.ok(item, "recall and model commands appear in Pi's native slash-command autocomplete"); checks++;
      const completed = autocomplete.applyCompletion([prefix], 0, prefix.length, item, suggestions.prefix).lines[0];
      assert.equal(completed.trim(), expected); checks++;
      if (expected === "/next-recall") recalledCommand = completed;
      else modelCommand = completed;
    }
    assert.equal(prefixHistory ? editor instanceof host.CustomEditor : editor, prefixHistory ? true : undefined, "prefix history can run before selecting a model"); checks++;
    await session.prompt("/next status");
    assert.equal(pickerCalls, 0, "status does not start first-use setup"); checks++;
    const beforeSetupEntries = session.sessionManager.getBranch().length;
    await session.prompt("/next");
    assert.ok(editor); checks++;
    assert.equal(pickerCalls, 1); checks++;
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, "agent", "pi-next.json"), "utf8")), { model: "openai/gpt-6-luna" }); checks++;
    assert.equal(requests.length, 0, "first-use setup makes no prediction request"); checks++;
    assert.equal(mainCalls, 0); checks++;
    assert.equal(session.sessionManager.getBranch().length, beforeSetupEntries, "first-use setup adds no conversation entry"); checks++;
    // The pi-next observer must pass through to this fixture executor unchanged.
    const shellHandlers = loaded.extensions[0].handlers.get("user_bash") ?? [];
    shellHandlers.push(async () => {
      if (shellGate) await shellGate;
      return { result: { output: "fixture shell output", exitCode: 0, cancelled: false, truncated: false } };
    });
    loaded.extensions[0].handlers.set("user_bash", shellHandlers);
    // Run both shipped terminal submit and bash-result paths. No process is run.
    const terminal = { defaultEditor: editor, editor, session, sessionManager: session.sessionManager, ui: screen,
      chatContainer: { addChild() {} }, pendingMessagesContainer: { addChild() {} },
      flushPendingBashComponents() {}, onInputCallback: text => { submitted = session.prompt(text); },
      handleBashCommand(command, excluded) { shellWork = InteractiveMode.prototype.handleBashCommand.call(terminal, command, excluded); return shellWork; },
      showError: error => errors.push(error), updateEditorBorderColor() {} };
    InteractiveMode.prototype.setupEditorSubmitHandler.call(terminal);
    if (manualSuggestion) {
      const saved = readFileSync(join(cwd, "agent", "pi-next.json"), "utf8");
      const issue = async args => {
        for (const char of `/next ${args}`) editor.handleInput(char);
        editor.handleInput("\r"); await submitted;
        await new Promise(resolve => setImmediate(resolve));
      };
      await session.prompt("/next off");
      if (!resumed) {
        editor.setText("Explain closures briefly. I may ask for an example next.");
        editor.handleInput("\r"); await submitted;
        await new Promise(resolve => setImmediate(resolve));
      }
      const initialMainCalls = resumed ? 0 : 1;
      assert.equal(requests.length, 0); checks++;
      assert.equal(mainCalls, initialMainCalls); checks++;
      const entriesBeforeSuggest = session.sessionManager.getBranch().length;
      const historyBefore = resumed ? readFileSync(sessionManager.getSessionFile(), "utf8") : undefined;
      prediction = waiting ? "show me a manual example" : "NO_SUGGESTION";
      await issue("suggest");
      assert.equal(requests.length, 1); checks++;
      assert.equal(session.sessionManager.getBranch().length, entriesBeforeSuggest); checks++;
      if (resumed) {
        assert.deepEqual(JSON.parse(requests[0].context.messages[0].content[0].text), {
          userMessages: ["Explain closures. I may ask for an example next."], assistantReply: "Saved explanation of closures.",
        }); checks++;
      }
      if (waiting) {
        await issue("suggest");
        assert.ok(notices.at(-1).includes("already being generated")); checks++;
        assert.equal(requests.length, 1); checks++;
        assert.equal(requests[0].options.signal.aborted, false); checks++;
        await issue("status");
        assert.equal(requests[0].options.signal.aborted, false); checks++;
        await issue("recall");
        assert.ok(notices.at(-1).includes("still being generated")); checks++;
        releasePrediction(); await new Promise(resolve => setImmediate(resolve));
      } else {
        assert.ok(notices.at(-1).includes("No useful suggestion")); checks++;
        assert.ok(!rendered(editor).includes("show me a manual example")); checks++;
        prediction = "show me a manual example";
        editor.handleInput("\x1b[200~/next suggest\x1b[201~\r");
        await submitted; await new Promise(resolve => setImmediate(resolve));
        assert.equal(requests.length, 2); checks++;
      }
      const count = requests.length;
      assert.ok(rendered(editor).includes("show me a manual example")); checks++;
      assert.equal(editor.getText(), ""); checks++;
      assert.equal(mainCalls, initialMainCalls); checks++;
      assert.equal(session.sessionManager.getBranch().length, entriesBeforeSuggest); checks++;
      if (resumed) { assert.equal(readFileSync(sessionManager.getSessionFile(), "utf8"), historyBefore); checks++; }
      await session.prompt("/next status");
      assert.ok(notices.at(-1).includes("Pi-next: off;")); checks++;
      assert.ok(notices.at(-1).includes(`Reported tokens: ${150 * count} in / ${20 * count} out (${count}/${count} reports)`)); checks++;
      editor.handleInput("\x1b"); await issue("recall");
      assert.ok(rendered(editor).includes("show me a manual example")); checks++;
      for (const command of ["!echo manual-one", "!!echo manual-two"]) {
        editor.setText(command); editor.handleInput("\r"); await new Promise(resolve => setImmediate(resolve));
        assert.ok(rendered(editor).includes("show me a manual example"), "manual ghost returns after the real bash-result path while automatic mode stays off"); checks++;
        assert.equal(requests.length, count); checks++;
      }
      editor.handleInput("\r");
      assert.equal(mainCalls, initialMainCalls, "Enter never sends the manual ghost"); checks++;
      await issue("recall"); editor.handleInput("\x1b[C");
      assert.equal(editor.getText(), "show me a manual example"); checks++;
      assert.equal(mainCalls, initialMainCalls); checks++;
      editor.setText("Another ordinary question."); editor.handleInput("\r"); await submitted;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(mainCalls, initialMainCalls + 1); checks++;
      assert.equal(requests.length, count, "manual requests leave automatic predictions off"); checks++;
      assert.equal(readFileSync(join(cwd, "agent", "pi-next.json"), "utf8"), saved); checks++;
      assert.equal(agent.state.model, model); checks++;
      assert.equal(agent.state.thinkingLevel, "off"); checks++;
      assert.deepEqual(errors, []); checks++;
      return checks;
    }
    editor.setText("Explain closures briefly. I may ask for an example next.");
    editor.handleInput("\r");
    await submitted;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, []); checks++;
    assert.equal(requests.length, 1, "real Pi session should attempt one prediction"); checks++;
    if (shellDuringPrediction) {
      const payload = JSON.stringify(requests[0].context);
      for (const char of "!echo PRIVATE_PENDING_COMMAND") editor.handleInput(char);
      assert.equal(requests[0].options.signal.aborted, false); checks++;
      if (shellDuringPrediction === "typing") {
        releasePrediction(); await new Promise(resolve => setImmediate(resolve));
        assert.ok(!rendered(editor).includes("show me an example")); checks++;
        assert.equal(editor.getText(), "!echo PRIVATE_PENDING_COMMAND"); checks++;
      }
      editor.handleInput("\r"); await new Promise(resolve => setImmediate(resolve));
      if (shellGate) {
        const leafBeforeResult = session.sessionManager.getLeafId();
        releasePrediction(); await new Promise(resolve => setImmediate(resolve));
        assert.ok(!rendered(editor).includes("show me an example"), "an empty editor is not proof that bash finished"); checks++;
        assert.equal(session.sessionManager.getLeafId(), leafBeforeResult); checks++;
        await session.prompt("/next recall");
        assert.ok(notices.at(-1).includes("Wait for the shell command to finish")); checks++;
        assert.ok(!rendered(editor).includes("show me an example")); checks++;
        releaseShell(); await shellWork;
      } else if (shellDuringPrediction !== "typing") {
        editor.setText("/next recall"); editor.handleInput("\r"); await submitted;
        assert.ok(notices.at(-1).includes("still being generated")); checks++;
        assert.equal(requests[0].options.signal.aborted, false); checks++;
        releasePrediction(); await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(session.sessionManager.getBranch().at(-1).message.role, "bashExecution"); checks++;
      assert.equal(session.sessionManager.getBranch().at(-1).message.output, "fixture shell output", "observer leaves execution to the fixture handler"); checks++;
      const entriesAfterBash = session.sessionManager.getBranch().length;
      assert.ok(rendered(editor).includes("show me an example"), "same pending result returns automatically after the actual bash result path"); checks++;
      assert.equal(editor.getText(), ""); checks++;
      editor.handleInput("\r"); await new Promise(resolve => setImmediate(resolve));
      assert.equal(mainCalls, 1, "Enter never submits the automatically restored ghost"); checks++;
      assert.equal(requests.length, 1); checks++;
      editor.setText("/next recall"); editor.handleInput("\r"); await submitted;
      assert.ok(rendered(editor).includes("show me an example")); checks++;
      assert.equal(editor.getText(), ""); checks++;
      assert.equal(requests.length, 1); checks++; assert.equal(mainCalls, 1); checks++;
      assert.equal(session.sessionManager.getBranch().length, entriesAfterBash); checks++;
      assert.equal(JSON.stringify(requests[0].context), payload); checks++;
      assert.ok(!payload.includes("PRIVATE_PENDING_COMMAND")); checks++;
      await session.prompt("/next status");
      assert.ok(notices.at(-1).includes("attempts: 1; offered: 1; last outcome: recalled")); checks++;
      assert.ok(notices.at(-1).includes("Reported tokens: 150 in / 20 out (1/1 reports)")); checks++;
      assert.deepEqual(errors, []); checks++;
      return checks;
    }
    assert.ok(rendered(editor).includes("show me an example"), "prediction should render after real terminal submission"); checks++;
    assert.equal(editor.getText(), ""); checks++;
    await session.prompt("/next status");
    assert.ok(notices.at(-1).includes("attempts: 1; offered: 1; last outcome: offered")); checks++;
    assert.ok(notices.at(-1).includes("Reported tokens: 150 in / 20 out (1/1 reports)"), "meter excludes main-agent usage and counts cache input once"); checks++;
    // Reproduce the live regression: shell submission advances the real session leaf, not the model exchange.
    const replyLeaf = session.sessionManager.getLeafId();
    for (const command of ["!echo 1", "!!echo 2"]) {
      await session.prompt("/next recall");
      editor.setText(command); editor.handleInput("\r"); await new Promise(resolve => setImmediate(resolve));
      assert.notEqual(session.sessionManager.getLeafId(), replyLeaf); checks++;
      assert.ok(rendered(editor).includes("show me an example"), "completed shell command restores the same ghost"); checks++;
      const afterBashEntries = session.sessionManager.getBranch().length;
      editor.setText("/next recall"); editor.handleInput("\r"); await submitted;
      assert.ok(rendered(editor).includes("show me an example"), "explicit recall survives a real bash leaf change"); checks++;
      assert.equal(editor.getText(), ""); checks++;
      assert.equal(session.sessionManager.getBranch().length, afterBashEntries); checks++;
      assert.equal(requests.length, 1); checks++; assert.equal(mainCalls, 1); checks++;
      await session.prompt("/next status");
      assert.ok(notices.at(-1).includes("Reported tokens: 150 in / 20 out (1/1 reports)")); checks++;
    }
    // Submit the native-autocompleted alias through the real terminal path, without new input/run activity.
    const branchLength = session.sessionManager.getBranch().length;
    editor.handleInput("\x1b");
    assert.ok(!rendered(editor).includes("show me an example")); checks++;
    editor.setText(recalledCommand); editor.handleInput("\r");
    await submitted; await new Promise(resolve => setImmediate(resolve));
    assert.ok(rendered(editor).includes("show me an example")); checks++;
    assert.equal(editor.getText(), ""); checks++;
    assert.equal(session.sessionManager.getBranch().length, branchLength, "recall appends no conversation entry"); checks++;
    assert.equal(requests.length, 1, "recall makes no prediction request"); checks++;
    assert.equal(mainCalls, 1, "recall makes no main-agent request"); checks++;
    editor.handleInput("\r");
    assert.equal(editor.getText(), "", "Enter does not accept a recalled ghost"); checks++;
    assert.equal(mainCalls, 1); checks++;
    editor.setText("/next recall"); editor.handleInput("\r");
    await submitted; await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1); checks++;
    editor.handleInput("\t");
    assert.equal(editor.getText(), "show me an example", "recall is still insertion-only"); checks++;
    assert.equal(mainCalls, 1); checks++;
    await session.prompt("/next status");
    assert.ok(notices.at(-1).includes("Reported tokens: 150 in / 20 out (1/1 reports)"), "recall leaves token totals unchanged"); checks++;
    for (const [output, expected] of [["NO_SUGGESTION", "abstained"], ["show me another example\n", "rejected:control-character"]]) {
      prediction = output;
      editor.setText("Explain that in three sentences.");
      editor.handleInput("\r");
      await submitted;
      await new Promise(resolve => setImmediate(resolve));
      await session.prompt("/next status");
      assert.ok(notices.at(-1).includes(`last outcome: ${expected}`)); checks++;
      const count = requests.length, calls = mainCalls;
      editor.setText("/next recall"); editor.handleInput("\r");
      await submitted; await new Promise(resolve => setImmediate(resolve));
      assert.ok(!rendered(editor).includes("show me an example"), "old exchange cannot be recalled after abstention/rejection"); checks++;
      assert.equal(requests.length, count); checks++;
      assert.equal(mainCalls, calls); checks++;
    }
    assert.equal(requests.length, 3); checks++;
    await session.prompt("/next status");
    assert.ok(notices.at(-1).includes("attempts: 3; offered: 1")); checks++;
    assert.ok(notices.at(-1).includes("Reported tokens: 450 in / 60 out (3/3 reports)"), "abstention/rejection still contribute reported usage"); checks++;
    assert.deepEqual(errors, []); checks++;
    const beforePickerEntries = session.sessionManager.getBranch().length;
    pickerSearch = "gemini";
    editor.setText(prefixHistory ? "/next model" : modelCommand); editor.handleInput("\r"); await submitted;
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, "agent", "pi-next.json"), "utf8")), { model: "google/gemini-fixture" }); checks++;
    assert.equal(requests.length, 3); checks++;
    assert.equal(mainCalls, 3); checks++;
    assert.equal(session.sessionManager.getBranch().length, beforePickerEntries, "model picker adds no conversation entry"); checks++;
    assert.equal(agent.state.model, model, "choosing a suggestion model leaves the main model unchanged"); checks++;
    assert.equal(agent.state.thinkingLevel, "off"); checks++;
    prediction = "show me a concrete example";
    editor.setText("Explain that more briefly."); editor.handleInput("\r"); await submitted;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 4); checks++;
    assert.equal(requests.at(-1).model, google); checks++;
    await session.prompt("/next status");
    assert.ok(notices.at(-1).includes("Reported tokens: 600 in / 80 out (4/4 reports)"), "changing models retains the session's prediction usage"); checks++;
    await session.prompt("/next off");
    editor.setText("/next"); editor.handleInput("\r"); await submitted;
    assert.ok(notices.at(-1).startsWith("Pi-next: on; model: google/gemini-fixture;")); checks++;
    assert.equal(pickerCalls, 2, "bare command reuses the existing selection without another picker"); checks++;
    assert.equal(requests.length, 4); checks++;
    assert.equal(mainCalls, 4); checks++;
    if (prefixHistory) {
      await session.prompt("/next off");
      const commands = [];
      terminal.handleBashCommand = async (command, excluded) => { commands.push({ command, excluded }); };
      terminal.updateEditorBorderColor = () => {};
      for (const text of ["!muxy browser open --split", "!git status", "!!printf private-history"]) {
        editor.setText(text); editor.handleInput("\r"); await new Promise(resolve => setImmediate(resolve));
      }
      assert.deepEqual(commands, [{ command: "muxy browser open --split", excluded: false }, { command: "git status", excluded: false }, { command: "printf private-history", excluded: true }]); checks++;
      editor.setText("!");
      for (const expected of ["!!printf private-history", "!git status", "!muxy browser open --split"]) {
        editor.handleInput("\x1b[A"); assert.equal(editor.getText(), expected); checks++;
      }
      for (let i = 0; i < 3; i++) editor.handleInput("\x1b[B");
      assert.equal(editor.getText(), "!"); checks++;
      editor.setText("!muxy"); editor.handleInput("\x1b[A");
      assert.equal(editor.getText(), "!muxy browser open --split"); checks++;
      assert.equal(commands.length, 3, "history recall does not execute shell commands"); checks++;
      assert.equal(requests.length, 4, "history recall does not request predictions"); checks++;
      assert.equal(mainCalls, 4, "history recall does not request the main model"); checks++;
    }
    assert.deepEqual(errors, []); checks++;
    return checks;
  } finally {
    releasePrediction?.(); releaseShell?.();
    await shellWork?.catch(() => {});
    session?.dispose();
    globalThis.fetch = fetchBefore;
    if (agentDirBefore === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = agentDirBefore;
    rmSync(cwd, { recursive: true, force: true });
  }
}
