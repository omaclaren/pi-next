import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Real Pi lifecycle and terminal submit handler, with synthetic context and no network/auth store. */
export async function checkSession({ host, ai, sdk, modules, project, KeybindingsManager, screen, theme, model, assistant, rendered }) {
  const { Agent } = await import(pathToFileURL(join(modules, "@earendil-works/pi-agent-core/dist/index.js")).href);
  const { InteractiveMode } = await import(pathToFileURL(join(sdk, "dist/modes/interactive/interactive-mode.js")).href);
  const { loadExtensions } = await import(pathToFileURL(join(sdk, "dist/core/extensions/loader.js")).href);
  const cwd = mkdtempSync(join(tmpdir(), "pi-next-prompt-session-"));
  const fetchBefore = globalThis.fetch, agentDirBefore = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  globalThis.fetch = () => { throw new Error("Network is forbidden in this offline test"); };
  let session;
  let checks = 0;
  try {
    const loaded = await loadExtensions([join(project, "index.ts")], cwd);
    assert.deepEqual(loaded.errors, []); checks++;
    loaded.runtime.flagValues.set("next-prompt-model", "openai/gpt-6-luna");
    const requests = [], errors = [], notices = [];
    let editor, factory, submitted, prediction = "show me an example", mainCalls = 0;
    const ui = {
      getEditorText: () => editor?.getExpandedText() ?? "", getEditorComponent: () => factory,
      setEditorComponent: value => {
        factory = value;
        editor = value ? value(screen, theme, new KeybindingsManager()) : undefined;
        if (editor) { editor.setText(""); editor.focused = true; }
      },
      notify: text => notices.push(text),
      custom: factory => new Promise(resolve => {
        const picker = factory(screen, { fg: (_color, text) => text }, new KeybindingsManager(), resolve);
        picker.focused = true; picker.render(60);
        for (const character of "gemini") picker.handleInput(character);
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
        return { result: async () => ({ ...response, usage: { ...response.usage,
          input: 100, cacheRead: 40, cacheWrite: 10, output: 20, reasoning: 5, totalTokens: 170 } }) };
      },
    };
    const resources = {
      getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "Offline fixture", getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      getResourceMetadata: () => new Map(),
    };
    const agent = new Agent({ initialState: { model, thinkingLevel: "off", tools: [], messages: [], systemPrompt: "Offline fixture" },
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
      sessionManager: host.SessionManager.inMemory(cwd),
      settingsManager: host.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoader: resources, initialActiveToolNames: [], baseToolsOverride: {},
    });
    await session.bindExtensions({ mode: "tui", uiContext: ui, onError: error => errors.push(error) });
    assert.ok(editor); checks++;
    // Run the shipped terminal submit callback, rather than inventing the input/start/settle order.
    const terminal = { defaultEditor: editor, editor, session,
      flushPendingBashComponents() {}, onInputCallback: text => { submitted = session.prompt(text); } };
    InteractiveMode.prototype.setupEditorSubmitHandler.call(terminal);
    editor.setText("Explain closures briefly. I may ask for an example next.");
    editor.handleInput("\r");
    await submitted;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, []); checks++;
    assert.equal(requests.length, 1, "real Pi session should attempt one prediction"); checks++;
    assert.ok(rendered(editor).includes("show me an example"), "prediction should render after real terminal submission"); checks++;
    assert.equal(editor.getText(), ""); checks++;
    await session.prompt("/next-prompt status");
    assert.ok(notices.at(-1).includes("attempts: 1; offered: 1; last outcome: offered")); checks++;
    assert.ok(notices.at(-1).includes("Reported tokens: 150 in / 20 out (1/1 reports)"), "meter excludes main-agent usage and counts cache input once"); checks++;
    // Submit recall as a real terminal slash command: it must bypass new input/run activity.
    const branchLength = session.sessionManager.getBranch().length;
    editor.handleInput("\x1b");
    assert.ok(!rendered(editor).includes("show me an example")); checks++;
    editor.setText("/next-prompt recall"); editor.handleInput("\r");
    await submitted; await new Promise(resolve => setImmediate(resolve));
    assert.ok(rendered(editor).includes("show me an example")); checks++;
    assert.equal(editor.getText(), ""); checks++;
    assert.equal(session.sessionManager.getBranch().length, branchLength, "recall appends no conversation entry"); checks++;
    assert.equal(requests.length, 1, "recall makes no prediction request"); checks++;
    assert.equal(mainCalls, 1, "recall makes no main-agent request"); checks++;
    editor.handleInput("\r");
    assert.equal(editor.getText(), "", "Enter does not accept a recalled ghost"); checks++;
    assert.equal(mainCalls, 1); checks++;
    editor.setText("/next-prompt recall"); editor.handleInput("\r");
    await submitted; await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1); checks++;
    editor.handleInput("\t");
    assert.equal(editor.getText(), "show me an example", "recall is still insertion-only"); checks++;
    assert.equal(mainCalls, 1); checks++;
    await session.prompt("/next-prompt status");
    assert.ok(notices.at(-1).includes("Reported tokens: 150 in / 20 out (1/1 reports)"), "recall leaves token totals unchanged"); checks++;
    for (const [output, expected] of [["NO_SUGGESTION", "abstained"], ["show me another example\n", "rejected:control-character"]]) {
      prediction = output;
      editor.setText("Explain that in three sentences.");
      editor.handleInput("\r");
      await submitted;
      await new Promise(resolve => setImmediate(resolve));
      await session.prompt("/next-prompt status");
      assert.ok(notices.at(-1).includes(`last outcome: ${expected}`)); checks++;
      const count = requests.length, calls = mainCalls;
      editor.setText("/next-prompt recall"); editor.handleInput("\r");
      await submitted; await new Promise(resolve => setImmediate(resolve));
      assert.ok(!rendered(editor).includes("show me an example"), "old exchange cannot be recalled after abstention/rejection"); checks++;
      assert.equal(requests.length, count); checks++;
      assert.equal(mainCalls, calls); checks++;
    }
    assert.equal(requests.length, 3); checks++;
    await session.prompt("/next-prompt status");
    assert.ok(notices.at(-1).includes("attempts: 3; offered: 1")); checks++;
    assert.ok(notices.at(-1).includes("Reported tokens: 450 in / 60 out (3/3 reports)"), "abstention/rejection still contribute reported usage"); checks++;
    assert.deepEqual(errors, []); checks++;
    const beforePickerEntries = session.sessionManager.getBranch().length;
    editor.setText("/next-prompt model"); editor.handleInput("\r"); await submitted;
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, "agent", "next-prompt.json"), "utf8")), { model: "google/gemini-fixture" }); checks++;
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
    await session.prompt("/next-prompt status");
    assert.ok(notices.at(-1).includes("Reported tokens: 600 in / 80 out (4/4 reports)"), "changing models retains the session's prediction usage"); checks++;
    assert.deepEqual(errors, []); checks++;
    return checks;
  } finally {
    session?.dispose();
    globalThis.fetch = fetchBefore;
    if (agentDirBefore === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = agentDirBefore;
    rmSync(cwd, { recursive: true, force: true });
  }
}
