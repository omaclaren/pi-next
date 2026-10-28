import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sdk, modules, project } from "../scripts/host.mjs";

// Real host classes/helpers, not a replacement editor or SDK facade.
const host = await import(pathToFileURL(join(sdk, "dist/index.js")).href);
const ai = await import(pathToFileURL(join(modules, "@earendil-works/pi-ai/dist/index.js")).href);
const tui = await import(pathToFileURL(join(modules, "@earendil-works/pi-tui/dist/index.js")).href);
const { KeybindingsManager } = await import(pathToFileURL(join(sdk, "dist/core/keybindings.js")).href);
const { createJiti } = createRequire(join(sdk, "package.json"))("jiti");
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, tryNative: false, virtualModules: {
  "@earendil-works/pi-coding-agent": host, "@earendil-works/pi-ai": ai, "@earendil-works/pi-tui": tui,
} });
const { registerNext, registerNextPrompt } = await jiti.import(join(project, "index.ts"));
const { GhostEditor } = await jiti.import(join(project, "ghost-editor.ts"));
const core = await jiti.import(join(project, "core.ts"));
const loader = await import(pathToFileURL(join(sdk, "dist/core/extensions/loader.js")).href);
let checks = 0;
function eq(actual, expected, label) { assert.deepEqual(actual, expected, label); checks++; }
function ok(value, label) { assert.ok(value, label); checks++; }
const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const theme = { borderColor: s => s, selectList: { selectedPrefix: s => s, selectedText: s => s, description: s => s, scrollInfo: s => s, noMatch: s => s } };
const screen = { terminal: { rows: 40, columns: 80 }, requestRender() {} };
const rendered = editor => editor.render(80).join("\n").replace(/\x1b(?:_[^\x07]*\x07|\[[0-9;]*m)/g, "");
const model = { type: "chat", provider: "openai", id: "gpt-6-luna", name: "GPT-6 Luna", api: "openai-responses", baseUrl: "https://example.invalid", reasoning: true,
  thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high" }, input: ["text"], contextWindow: 272000, maxTokens: 128000,
  cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0 } };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text = "Which file is responsible?", stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, api: model.api, provider: model.provider, model: model.id, usage, timestamp: 0 });
const user = text => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const usageResponse = (text, fields = {}, stopReason = "stop") => ({ ...assistant(text, stopReason), usage: { ...usage, ...fields } });
let nextId = 0;
const entry = message => ({ type: "message", id: `entry-${++nextId}`, parentId: null, timestamp: new Date(0).toISOString(), message });
const projected = e => ({ sourceEntry: e, messages: e.type === "message" ? [e.message] : [] });

function harness({ flag = "openai/gpt-6-luna", prefixHistory = false, mode = "tui", timeoutMs = 40, conflict = false,
  settings = { load: () => "", save() {} } } = {}) {
  const handlers = new Map(), commands = new Map(), requests = [], notices = [];
  let factory = conflict ? () => {} : undefined, editor, entries = [], projection, session = "session-a", idle = true, queued = false;
  let selected = model, catalog, available = true, oauth = true, authSource = "stored", authReads = 0;
  const pi = { registerFlag() {}, getFlag: name => name === "prefix-history" ? prefixHistory :
    name === "next-model" ? flag ?? undefined : undefined,
    registerCommand: (name, value) => commands.set(name, value),
    on: (name, fn) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); } };
  const ui = { getEditorText: () => editor?.getText() ?? "", getEditorComponent: () => factory,
    setEditorComponent: value => { factory = value; editor = value ? value(screen, theme, new KeybindingsManager()) : undefined;
      if (editor) { editor.setText(""); editor.focused = true; } }, notify: (text, level) => notices.push({ text, level }),
    custom: async () => undefined };
  const known = () => (catalog ?? (selected ? [selected] : [])).filter(m => m.type === "chat");
  const registry = { getModelOfType: (type, provider, id) => type === "chat" ? known().find(m => m.provider === provider && m.id === id) : undefined,
    getAvailable: () => available ? known() : [], getProviderAuthStatus: () => { authReads++; return { configured: true, source: authSource }; }, isUsingOAuth: () => { authReads++; return oauth; },
    streamSimple: (m, context, options) => { const task = deferred(); requests.push({ model: m, context, options, task }); return { result: () => task.promise }; } };
  const ctx = { mode, hasUI: mode === "tui" || mode === "rpc", ui, modelRegistry: registry, isIdle: () => idle, hasPendingMessages: () => queued,
    model: { ...model, id: "gpt-6.1-sol" }, thinkingLevel: "xhigh",
    sessionManager: { getSessionId: () => session, getLeafId: () => entries.at(-1)?.id ?? null, getBranch: () => entries,
      buildSessionProjection: () => ({ entries: projection ?? entries.map(projected) }) } };
  registerNext(pi, { timeoutMs, settings });
  const emit = async (name, event = {}) => { for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx); };
  const start = () => emit("session_start", { reason: "startup" });
  const begin = async ({ text = "show me the relevant function", source = "interactive", streamingBehavior, messageType = "user", images } = {}) => {
    await emit("input", { text, source, streamingBehavior, images });
    idle = false;
    await emit("before_agent_start", messageType === "user" ? { messageType, prompt: text } : { messageType, message: { role: "custom", customType: "external", content: "hello" } });
    if (messageType === "user") entries.push(entry(user(text)));
    await emit("agent_start");
  };
  const finish = async ({ reply = "The relevant implementation is in editor.ts.", stopReason = "stop", outcome = "completed", aborted = false, continuation = false } = {}) => {
    entries.push(entry(assistant(reply, stopReason)));
    await emit("agent_before_settle", { outcome, continue: continuation, context: { pendingMessages: queued ? [user("queued")] : [] } });
    idle = true;
    await emit("agent_settled", { aborted });
    await pause();
  };
  return { ctx, requests, notices, emit, start, begin, finish, get editor() { return editor; }, get factory() { return factory; },
    entries: () => entries, replaceEntries: x => { entries = x; }, project: x => { projection = x; },
    command: text => commands.get("next").handler(text, ctx),
    namedCommand: (name, args = "") => commands.get(name).handler(args, ctx), queue: x => { queued = x; }, setIdle: x => { idle = x; },
    session: x => { session = x; }, oauth: x => { oauth = x; }, authSource: x => { authSource = x; }, available: x => { available = x; },
    selected: x => { selected = x; }, models: x => { catalog = x; }, get authReads() { return authReads; }, setFactory: x => { factory = x; },
    settleResponse: async (i = 0, response = assistant()) => { requests[i].task.resolve(response); await pause(); }, shutdown: () => emit("session_shutdown", { reason: "quit" }) };
}

// Pure context and output checks.
{
  const u1 = entry(user("older user")), u2 = entry(user("latest user")), a = entry(assistant("final answer"));
  const summary = { sourceEntry: { type: "compaction", id: "summary", summary: "PRIVATE_SUMMARY" }, messages: [user("PRIVATE_SUMMARY")] };
  const custom = { sourceEntry: { type: "custom_message", id: "custom" }, messages: [user("PRIVATE_CUSTOM")] };
  const tool = entry({ role: "toolResult", content: [{ type: "text", text: "PRIVATE_TOOL" }] });
  a.message.content.unshift({ type: "thinking", thinking: "PRIVATE_THINKING" });
  u2.message.content.push({ type: "image", data: "PRIVATE_IMAGE" });
  const payload = core.buildPayload([projected(u1), summary, custom, projected(tool), projected(u2), projected(a)], u2.id, new Set([u1.id, u2.id]));
  eq(JSON.parse(payload), { userMessages: ["older user", "latest user"], assistantReply: "final answer" });
  ok(!payload.includes("PRIVATE_"));
  const edited = { sourceEntry: u2, messages: [user("edited current user")] };
  eq(JSON.parse(core.buildPayload([projected(u1), edited, projected(a)], u2.id, new Set([u1.id, u2.id]))).userMessages.at(-1), "edited current user");
  eq(core.buildPayload([projected(u1), { sourceEntry: u2, messages: [] }, projected(a)], u2.id, new Set([u1.id, u2.id])), undefined);
  const fail = entry(assistant("partial error", "error"));
  eq(core.buildPayload([projected(u2), projected(a), projected(fail)], u2.id, new Set([u2.id])), undefined, "no older successful fallback");
  const bigUsers = Array.from({ length: 5 }, () => entry(user('\\"'.repeat(4000))));
  const bigA = entry(assistant('\\"'.repeat(8000)));
  const bounded = core.buildPayload([...bigUsers.map(projected), projected(bigA)], bigUsers.at(-1).id, new Set(bigUsers.map(e => e.id)));
  ok(bounded.length <= 8000); ok(JSON.parse(bounded).userMessages.length <= 3);
  ok(JSON.parse(bounded).userMessages.every(s => s.length <= 1000)); ok(JSON.parse(bounded).assistantReply.length <= 4000); ok(bounded.includes("truncated"));
  eq(JSON.parse(core.buildPayload([projected(u1), projected(u2), projected(a)], u2.id, new Set([u2.id]))).userMessages, ["latest user"], "unknown historical origins excluded");
  for (const text of ["", "NO_SUGGESTION", "no_suggestion", "hello\nworld", "hello\n", "\x1b[31mhello", "a\tb", "\x7f", "\u202eabc", "x".repeat(201), '"quoted"', "Suggestion: do this"]) eq(core.normaliseSuggestion(assistant(text)), undefined);
  for (const reason of ["error", "aborted", "length", "toolUse"]) eq(core.normaliseSuggestion(assistant("ordinary text", reason)), undefined);
  eq(core.normaliseSuggestion(assistant("  can you explain this?  ")), "can you explain this?");
  eq(core.requestOptions(model).reasoning, undefined);
  eq(core.requestOptions({ ...model, thinkingLevelMap: { off: null, minimal: null, low: "low" } }).reasoning, "low");
}

// Actual CustomEditor key, history and rendering behaviour.
{
  let edited = 0, submits = [];
  const e = new GhostEditor(screen, theme, new KeybindingsManager(), () => edited++); e.focused = true; e.onSubmit = x => submits.push(x);
  ok(e instanceof host.CustomEditor); ok(e.setGhost("can you explain this?")); eq(e.getText(), "");
  e.handleInput("\t"); eq(e.getText(), "can you explain this?"); eq(submits, []);
  e.setText(""); e.setGhost("right accepted"); e.handleInput("\x1b[C"); eq(e.getText(), "right accepted"); eq(submits, []);
  e.setText(""); e.setGhost("NEVER_SEND_GHOST"); e.handleInput("\r"); ok(!submits.includes("NEVER_SEND_GHOST")); eq(e.getText(), "");
  e.setGhost("DISMISSED"); e.handleInput("\x1b"); eq(e.getText(), ""); ok(!rendered(e).includes("DISMISSED"));
  e.setGhost("NO_RESURRECTION"); e.handleInput("x"); e.handleInput("\x7f"); eq(e.getText(), ""); ok(!rendered(e).includes("NO_RESURRECTION"));
  e.setGhost("PASTE_CANCEL"); e.handleInput("\x1b[200~pasted\x1b[201~"); eq(e.getText(), "pasted");
  e.setText(""); e.addToHistory("history prompt"); e.handleInput("\x1b[A"); eq(e.getText(), "history prompt");
  e.setText(""); e.setGhost("wide 漢字 🙂 next prompt");
  for (const width of [1, 2, 5, 10, 20, 80]) ok(e.render(width).every(line => tui.visibleWidth(line) <= width), `width ${width}`);
  e.clearGhost(); e.onCtrlD = () => { edited += 100; }; const before = edited; e.handleInput("\x04"); ok(edited >= before + 100, "exit reaches the real base editor");
}

// A batched paste + Enter re-enters handleInput; cancellation must happen before onSubmit, not after it.
{
  const events = [], e = new GhostEditor(screen, theme, new KeybindingsManager(), kind => events.push(kind));
  e.focused = true; e.onSubmit = text => events.push(`submitted:${text}`);
  e.handleInput("\x1b[200~ordinary prompt\x1b[201~\r");
  eq(events, ["edit", "submitted:ordinary prompt"]);
}

// Registered lifecycle handlers with a mocked provider and real ghost editor.
{
  const h = harness(); await h.start(); eq(h.requests.length, 0); await h.begin(); await h.finish();
  eq(h.requests.length, 1); eq(h.requests[0].model.id, "gpt-6-luna"); eq(h.requests[0].options.maxRetries, 0); eq(h.requests[0].options.maxTokens, 256);
  eq(h.requests[0].options.reasoning, undefined); eq(h.requests[0].context.tools, []); eq(h.ctx.thinkingLevel, "xhigh"); eq(h.ctx.model.id, "gpt-6.1-sol");
  eq(h.requests[0].context.systemPrompt, core.SYSTEM_PROMPT, "generation dispatches the current prediction policy");
  await h.settleResponse(); eq(h.editor.getText(), ""); ok(rendered(h.editor).includes("Which file"));
  await h.emit("agent_settled", { aborted: false }); eq(h.requests.length, 1, "one request per activity");
  const embedded = h.factory(screen, theme, new KeybindingsManager()); embedded.focused = true;
  ok(!rendered(embedded).includes("Which file"));
  h.editor.handleInput("\t"); eq(h.editor.getText(), "Which file is responsible?"); await h.shutdown();
}
for (const mode of ["rpc", "print", "json"]) {
  const h = harness({ mode }); await h.start(); await h.begin(); await h.finish(); eq(h.requests.length, 0); eq(h.editor, undefined); await h.shutdown();
}
for (const flag of ["", "bad", "openai/does-not-exist", "google/model"]) {
  const h = harness({ flag }); await h.start(); await h.begin(); await h.finish(); eq(h.requests.length, 0); eq(h.editor, undefined); await h.command("on"); eq(h.requests.length, 0); await h.shutdown();
}
for (const source of ["extension", "rpc"]) {
  const h = harness(); await h.start(); await h.begin({ source }); await h.finish(); eq(h.requests.length, 0); await h.shutdown();
}
for (const text of ["[Telegram from Oliver] yes", "Telegram: do this", "<telegram>yes", "/skill:whatever"]) {
  const h = harness(); await h.start(); await h.begin({ text }); await h.finish(); eq(h.requests.length, 0); await h.shutdown();
}
for (const finish of [{ aborted: true }, { outcome: "error", stopReason: "error" }, { reply: "" }, { stopReason: "length" }, { continuation: true }]) {
  const h = harness(); await h.start(); await h.begin(); await h.finish(finish); eq(h.requests.length, 0); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin({ messageType: "custom" }); await h.finish(); eq(h.requests.length, 0, "custom starts have no prompt"); await h.shutdown();
}
for (const invalidate of [
  async h => h.editor.handleInput("x"),
  async h => { h.editor.handleInput("x"); h.editor.handleInput("\x7f"); },
  async h => h.editor.handleInput("\x1b[200~paste\x1b[201~"),
  async h => h.editor.setText(""),
  async h => h.emit("input", { source: "extension", text: "Telegram: new input" }),
  async h => h.emit("before_agent_start", { messageType: "custom", message: { role: "custom", content: "background" } }),
  async h => h.command("off"),
  async h => h.emit("session_before_tree"),
  async h => h.emit("session_before_switch"),
  async h => h.emit("ui_prompt_start", { kind: "custom" }),
  async h => h.shutdown(),
]) {
  const h = harness(); await h.start(); await h.begin(); await h.finish(); eq(h.requests.length, 1);
  await invalidate(h); ok(h.requests[0].options.signal.aborted);
  await h.settleResponse(0, assistant("STALE_GHOST")); ok(!h.editor || !rendered(h.editor).includes("STALE_GHOST")); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin(); h.editor.handleInput("x"); h.editor.handleInput("\x7f"); await h.finish(); eq(h.requests.length, 0, "edit-delete during run suppresses generation"); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin(); h.queue(true); await h.finish(); eq(h.requests.length, 0); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin(); await h.emit("input", { source: "interactive", text: "queued", streamingBehavior: "steer" }); h.entries().push(entry(user("queued"))); await h.finish(); eq(h.requests.length, 0); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin(); await h.emit("agent_start"); await h.finish(); eq(h.requests.length, 0, "automatic continuation skipped"); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin(); await h.finish(); await h.settleResponse();
  await h.begin({ source: "extension", text: "next non-local turn" }); await h.finish(); eq(h.requests.length, 1, "no sticky terminal provenance"); await h.shutdown();
}
for (const change of [h => h.available(false), h => h.selected(undefined)]) {
  const h = harness(); await h.start(); change(h); await h.begin(); await h.finish(); eq(h.requests.length, 0); await h.shutdown();
}
{
  const h = harness({ conflict: true }); const original = h.factory; await h.start(); await h.begin(); await h.finish(); eq(h.requests.length, 0); eq(h.factory, original); await h.shutdown(); eq(h.factory, original);
}
{
  const h = harness({ timeoutMs: 8 }); await h.start(); await h.begin(); await h.finish();
  await pause(25); ok(h.requests[0].options.signal.aborted); await h.command("status"); ok(h.notices.at(-1).text.includes("timeout"));
  h.requests[0].task.reject(new Error("PRIVATE_PROVIDER_BODY")); await pause(); eq(h.requests.length, 1); ok(!JSON.stringify(h.notices).includes("PRIVATE_"));
  await h.begin(); await h.finish(); eq(h.requests.length, 2, "non-cooperating timeout releases local pending state"); await h.shutdown();
}
{
  const h = harness(); h.oauth(false); h.authSource("runtime"); await h.start(); await h.begin(); await h.finish();
  eq(h.requests.length, 1); eq(h.authReads, 0, "authentication is delegated to Pi");
  eq(h.requests[0].options.transformHeaders, undefined); eq(h.requests[0].options.transport, undefined);
  await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin(); await h.finish();
  h.entries().push({ type: "label", id: "changed-leaf" }); await h.settleResponse(0, assistant("STALE_LEAF")); ok(!rendered(h.editor).includes("STALE_LEAF")); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin(); await h.finish(); h.requests[0].task.reject(new Error("PRIVATE_TOKEN_MARKER")); await pause();
  await h.command("status"); ok(!JSON.stringify(h.notices).includes("PRIVATE_")); eq(h.requests.length, 1); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin();
  h.entries().push({ type: "custom_message", id: "queued-custom", customType: "background", content: "non-local input", display: true });
  await h.finish(); eq(h.requests.length, 0, "queued custom delivery cannot inherit terminal provenance"); await h.shutdown();
}
// Factory-only load through Pi's actual loader: no session-start handlers or providers run.
{
  const result = await loader.loadExtensions([join(project, "index.ts")], project);
  eq(result.errors, []); eq(result.extensions.length, 1);
  const extension = result.extensions[0];
  eq([...extension.commands.keys()].sort(), ["next", "next-model", "next-recall"]);
  eq([...extension.flags.keys()].sort(), ["next-model", "prefix-history"]);
  eq(registerNext, registerNextPrompt);
  ok(extension.handlers.has("agent_settled")); ok(!extension.tools.size);
}
{
  const h = harness(); await h.start();
  for (const text of ["first", "second", "third", "fourth"]) {
    await h.begin({ text }); await h.finish(); await h.settleResponse(h.requests.length - 1, assistant("NO_SUGGESTION"));
  }
  eq(JSON.parse(h.requests.at(-1).context.messages[0].content[0].text).userMessages, ["second", "third", "fourth"]);
  await h.shutdown();
}
{
  const h = harness(); h.replaceEntries([entry(user("historical user")), entry(assistant("historical reply"))]);
  await h.start(); eq(h.requests.length, 0); h.editor.handleInput("\x1b[A"); eq(h.editor.getText(), "historical user");
  h.editor.setText(""); await h.begin({ text: "fresh local user" }); await h.finish();
  eq(JSON.parse(h.requests[0].context.messages[0].content[0].text).userMessages, ["fresh local user"]);
  await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin();
  h.project(h.entries().map(e => ({ sourceEntry: e, messages: [] })));
  await h.finish(); eq(h.requests.length, 0, "omitted current user cannot fall back to older context"); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin({ images: [{ type: "image", data: "fixture" }] });
  await h.finish(); eq(h.requests.length, 0, "image-bearing submissions conservatively skipped"); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin(); await h.finish({ reply: "Shall I delete those files?" });
  eq(h.requests.length, 0, "obvious approval question abstains before requesting"); await h.shutdown();
}
{
  const h = harness(); await h.start(); const original = h.factory;
  h.editor.addToHistory("keep my input history"); await h.command("off");
  eq(h.factory, original, "off retains inert editor to preserve history");
  await h.begin(); await h.finish(); eq(h.requests.length, 0);
  await h.command("on"); eq(h.factory, original);
  h.editor.handleInput("\x1b[A"); eq(h.editor.getText(), "keep my input history"); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin(); await h.finish();
  const replacement = () => {}; h.setFactory(replacement);
  await h.settleResponse(0, assistant("NO_EDITOR_TAKEOVER"));
  ok(!rendered(h.editor).includes("NO_EDITOR_TAKEOVER"));
  await h.shutdown(); eq(h.factory, replacement, "shutdown never clears another editor factory");
}
{
  const e = new GhostEditor(screen, theme, new KeybindingsManager()); e.focused = true;
  e.setGhost("DO_NOT_ACCEPT"); e.isShowingAutocomplete = () => true;
  eq(e.setGhost("DO_NOT_REPLACE"), false); e.handleInput("\t"); eq(e.getText(), "", "autocomplete takes precedence over the ghost");
}
// Explicit recall restores only the last offered candidate, never regenerates or submits it.
async function withOffer(options) {
  const h = harness(options); await h.start(); await h.begin(); await h.finish();
  await h.settleResponse(0, assistant("RECALL_CANDIDATE")); return h;
}
// The autocomplete-friendly alias shares recall's cache, readiness checks and no-request behaviour.
for (const prefixHistory of [false, true]) {
  const h = await withOffer({ prefixHistory }); h.editor.handleInput("\x1b");
  await h.namedCommand("next-recall");
  ok(rendered(h.editor).includes("RECALL_CANDIDATE")); eq(h.editor.getText(), ""); eq(h.requests.length, 1);
  h.editor.setText("keep my draft"); await h.namedCommand("next-recall");
  eq(h.editor.getText(), "keep my draft"); ok(h.notices.at(-1).text.includes("idle, empty"));
  h.editor.setText(""); h.queue(true); await h.namedCommand("next-recall");
  ok(!rendered(h.editor).includes("RECALL_CANDIDATE")); eq(h.requests.length, 1);
  h.queue(false); await h.namedCommand("next-recall"); ok(rendered(h.editor).includes("RECALL_CANDIDATE"));
  await h.command("status"); ok(h.notices.at(-1).text.includes("attempts: 1; offered: 1; last outcome: recalled"));
  await h.shutdown();
}
for (const mode of ["tui", "rpc", "print"]) {
  const h = harness({ mode }); await h.start(); await h.namedCommand("next-recall");
  eq(h.requests.length, 0); ok(h.notices.at(-1).text.includes(mode === "tui" ? "No suggestion" : "terminal-only"));
  await h.shutdown();
}
for (const dismiss of [
  h => h.editor.handleInput("\x1b"),
  h => { h.editor.handleInput("x"); h.editor.handleInput("\x7f"); },
  h => { h.editor.handleInput("\x1b[200~paste\x1b[201~"); h.editor.setText(""); },
  h => h.editor.setText(""),
  h => h.editor.handleInput("\r"),
]) {
  const h = await withOffer(); let submits = [];
  h.editor.onSubmit = value => submits.push(value);
  dismiss(h);
  ok(!rendered(h.editor).includes("RECALL_CANDIDATE"), "dismissal does not auto-restore");
  eq(h.editor.getText(), "");
  await h.command("recall");
  ok(rendered(h.editor).includes("RECALL_CANDIDATE")); eq(h.editor.getText(), "");
  eq(h.requests.length, 1, "recall makes no model call"); ok(!submits.includes("RECALL_CANDIDATE"));
  await h.command("status");
  ok(h.notices.at(-1).text.includes("attempts: 1; offered: 1; last outcome: recalled"));
  ok(!h.notices.at(-1).text.includes("RECALL_CANDIDATE"), "recall text is not logged in status");
  await h.command("recall"); h.editor.handleInput("\t");
  eq(h.editor.getText(), "RECALL_CANDIDATE", "recalled ghost accepts by insertion only");
  ok(!submits.includes("RECALL_CANDIDATE")); eq(h.requests.length, 1); await h.shutdown();
}
{
  const h = await withOffer(); const submits = []; h.editor.onSubmit = value => submits.push(value);
  h.editor.handleInput("\x1b"); await h.command("recall"); h.editor.handleInput("\r");
  eq(h.editor.getText(), ""); ok(!submits.includes("RECALL_CANDIDATE"), "Enter never accepts a recalled ghost");
  await h.command("recall"); h.editor.handleInput("\x1b[C");
  eq(h.editor.getText(), "RECALL_CANDIDATE"); ok(!submits.includes("RECALL_CANDIDATE"));
  eq(h.requests.length, 1); await h.shutdown();
}
{
  const h = await withOffer(); await h.begin({ text: "a second exchange" }); await h.finish();
  await h.settleResponse(1, assistant("LATEST_CANDIDATE")); h.editor.handleInput("\x1b"); await h.command("recall");
  ok(rendered(h.editor).includes("LATEST_CANDIDATE")); ok(!rendered(h.editor).includes("RECALL_CANDIDATE"));
  eq(h.requests.length, 2); await h.shutdown();
}
// Shell commands move the session leaf without creating another model exchange.
const bashEntry = (fields = {}) => entry({ role: "bashExecution", command: "echo 1", output: "PRIVATE_SHELL_OUTPUT",
  exitCode: 0, cancelled: false, truncated: false, timestamp: 0, ...fields });
for (const prefixHistory of [false, true]) {
  const h = await withOffer({ prefixHistory });
  for (const fields of [{}, { excludeFromContext: true }, { exitCode: 1 }, { cancelled: true }]) {
    h.editor.setText("!echo 1"); h.editor.setText(""); h.entries().push(bashEntry(fields));
    ok(!rendered(h.editor).includes("RECALL_CANDIDATE"), "clearing a shell draft without submission does not restore a ghost");
    await h.command("recall");
    ok(rendered(h.editor).includes("RECALL_CANDIDATE"), "explicit recall survives shell-only additions after the same model reply");
    eq(h.editor.getText(), ""); eq(h.requests.length, 1, "shell recall makes no prediction request");
    await h.command("status"); ok(h.notices.at(-1).text.includes("attempts: 1; offered: 1; last outcome: recalled"));
    ok(!JSON.stringify(h.requests).includes("PRIVATE_SHELL_OUTPUT"), "shell output never enters the prediction payload");
  }
  await h.shutdown();
}
for (const extra of [user("a newer chat message"), assistant("a newer model reply"),
  { role: "toolResult", content: [{ type: "text", text: "tool output" }] }]) {
  const h = await withOffer(); h.editor.setText(""); h.entries().push(bashEntry(), entry(extra), bashEntry());
  await h.command("recall"); ok(!rendered(h.editor).includes("RECALL_CANDIDATE"), "never skip intervening conversation/tool entries");
  eq(h.requests.length, 1); await h.shutdown();
}
for (const type of ["context_edit", "compaction", "custom_message", "model_change"]) {
  const h = await withOffer(); h.editor.setText("");
  h.entries().push(bashEntry(), { type, id: `intervening-${type}` }, bashEntry());
  await h.command("recall"); ok(!rendered(h.editor).includes("RECALL_CANDIDATE"), "context/metadata changes still expire recall");
  eq(h.requests.length, 1); await h.shutdown();
}
{
  const h = await withOffer(); h.editor.setText(""); h.replaceEntries([bashEntry()]);
  await h.command("recall"); ok(!rendered(h.editor).includes("RECALL_CANDIDATE"), "the original reply anchor must remain on the branch");
  eq(h.requests.length, 1); await h.shutdown();
}
for (const invalidate of [
  h => h.emit("input", { source: "extension", text: "new nonlocal input" }),
  h => h.emit("input", { source: "interactive", text: "next local input" }),
  h => h.emit("before_agent_start", { messageType: "custom", message: { role: "custom", content: "background" } }),
  h => h.emit("agent_start"),
  h => h.emit("session_before_switch"),
  h => h.emit("session_before_fork"),
  h => h.emit("session_before_tree"),
  h => h.emit("session_tree"),
  h => h.emit("session_before_compact"),
  async h => { await h.emit("ui_prompt_start", { kind: "custom" }); await h.emit("ui_prompt_end", { kind: "custom" }); },
  async h => { await h.command("off"); await h.command("on"); },
]) {
  const h = await withOffer(); await invalidate(h); await h.command("recall");
  ok(!rendered(h.editor).includes("RECALL_CANDIDATE"), "new activity/reset expires recall");
  eq(h.requests.length, 1); await h.shutdown();
}
for (const change of [
  h => h.entries().push({ type: "label", id: "changed-leaf" }),
  h => h.session("different-session"),
  h => h.setFactory(() => {}),
]) {
  const h = await withOffer(); const entries = [...h.entries()], factory = h.factory;
  change(h); await h.command("recall");
  ok(!rendered(h.editor).includes("RECALL_CANDIDATE"));
  h.replaceEntries(entries); h.session("session-a"); h.setFactory(factory);
  await h.command("recall"); ok(!rendered(h.editor).includes("RECALL_CANDIDATE"), "expired candidate cannot revive on return");
  eq(h.requests.length, 1); await h.shutdown();
}
for (const block of [
  h => { h.editor.setText("keep my draft"); return () => h.editor.setText(""); },
  h => { h.editor.focused = false; return () => { h.editor.focused = true; }; },
  h => { h.editor.isShowingAutocomplete = () => true; return () => { h.editor.isShowingAutocomplete = () => false; }; },
  h => { h.setIdle(false); return () => h.setIdle(true); },
  h => { h.queue(true); return () => h.queue(false); },
]) {
  const h = await withOffer(); const unblock = block(h), text = h.editor.getText();
  await h.command("recall"); eq(h.editor.getText(), text, "recall never overwrites typed text");
  ok(!rendered(h.editor).includes("RECALL_CANDIDATE"));
  unblock(); await h.command("recall"); ok(rendered(h.editor).includes("RECALL_CANDIDATE"));
  eq(h.requests.length, 1); await h.shutdown();
}
for (const response of [assistant("NO_SUGGESTION"), assistant("invalid\noutput"), assistant("failure", "error")]) {
  const h = await withOffer(); await h.begin({ text: "a new exchange" }); await h.finish(); await h.settleResponse(1, response);
  await h.command("recall"); ok(!rendered(h.editor).includes("RECALL_CANDIDATE"), "no fallback to an older exchange");
  eq(h.requests.length, 2); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.command("recall");
  eq(h.requests.length, 0); eq(h.editor.getText(), ""); ok(h.notices.at(-1).text.includes("No suggestion to recall"));
  await h.begin(); await h.finish(); h.editor.handleInput("x"); h.editor.handleInput("\x7f");
  await h.settleResponse(0, assistant("STALE_RESPONSE")); await h.command("recall");
  ok(!rendered(h.editor).includes("STALE_RESPONSE"), "cancelled result never enters recall cache");
  eq(h.requests.length, 1); await h.shutdown();
}
{
  const h = await withOffer(); await h.shutdown(); await h.command("recall");
  eq(h.editor, undefined); eq(h.requests.length, 1, "shutdown drops recall and never reinstalls an editor");
}
// Reported-token accounting is metadata-only, includes cached input, and never double-counts reasoning.
{
  const fields = { input: 1000, cacheRead: 200, cacheWrite: 50, output: 30, reasoning: 10, totalTokens: 999999 };
  eq(core.reportedTokens(usageResponse("fixture", fields)), { input: 1250, output: 30 });
  eq(core.reportedTokens(assistant()), undefined, "all-zero SDK placeholder is not evidence of free inference");
  eq(core.reportedTokens({ ...assistant(), usage: undefined }), undefined);
  for (const invalid of [undefined, null, "12", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    eq(core.reportedTokens(usageResponse("fixture", { ...fields, input: invalid })), undefined);
  }
  eq(core.reportedTokens(usageResponse("fixture", { input: Number.MAX_SAFE_INTEGER, cacheRead: 1 })), undefined);
}
{
  const h = harness(); await h.start(); await h.command("status");
  ok(h.notices.at(-1).text.includes("Reported tokens: not reported (0/0 reports)"));
  for (const [text, stop] of [["VALID_GHOST", "stop"], ["NO_SUGGESTION", "stop"], ["invalid\noutput", "stop"], ["PRIVATE_FAILURE", "error"]]) {
    await h.begin(); await h.finish();
    await h.settleResponse(h.requests.length - 1, usageResponse(text, { input: 1000, cacheRead: 200, cacheWrite: 50, output: 30, reasoning: 10 }, stop));
  }
  await h.command("status");
  ok(h.notices.at(-1).text.includes("Reported tokens: 5000 in / 120 out (4/4 reports)"));
  ok(!h.notices.at(-1).text.includes("PRIVATE_FAILURE"));
  await h.command("off"); await h.command("on"); await h.command("status");
  ok(h.notices.at(-1).text.includes("Reported tokens: 5000 in / 120 out (4/4 reports)"), "on/off does not erase accumulated usage");
  eq(h.requests.length, 4); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin(); await h.finish();
  await h.settleResponse(0, usageResponse("RECALL_USAGE", { input: 100, output: 10 }));
  h.editor.handleInput("\x1b"); await h.command("recall"); await h.command("status");
  ok(h.notices.at(-1).text.includes("Reported tokens: 100 in / 10 out (1/1 reports)"));
  await h.command("recall"); await h.command("status");
  ok(h.notices.at(-1).text.includes("Reported tokens: 100 in / 10 out (1/1 reports)"));
  eq(h.requests.length, 1, "recall/status add neither calls nor reported tokens"); await h.shutdown();
}
for (const cancel of [
  h => { h.editor.handleInput("x"); h.editor.handleInput("\x7f"); },
  h => h.command("off"),
  h => h.emit("session_before_tree"),
  h => h.entries().push({ type: "label", id: "usage-stale-leaf" }),
]) {
  const h = harness(); await h.start(); await h.begin(); await h.finish(); await cancel(h);
  await h.settleResponse(0, usageResponse("STALE_BUT_SPENT", { input: 321, output: 12 })); await h.command("status");
  ok(h.notices.at(-1).text.includes("Reported tokens: 321 in / 12 out (1/1 reports)"), "stale/cancelled display does not erase returned usage");
  ok(!rendered(h.editor).includes("STALE_BUT_SPENT")); eq(h.requests.length, 1); await h.shutdown();
}
{
  const h = harness({ timeoutMs: 8 }); await h.start(); await h.begin(); await h.finish(); await pause(25);
  await h.command("status");
  ok(h.notices.at(-1).text.includes("Reported tokens: not reported (0/1 reports)"));
  await h.settleResponse(0, usageResponse("LATE_USAGE_NOT_GHOST", { input: 456, output: 13 })); await h.command("status");
  ok(h.notices.at(-1).text.includes("Reported tokens: 456 in / 13 out (1/1 reports)"));
  ok(h.notices.at(-1).text.includes("last error: timeout")); ok(!rendered(h.editor).includes("LATE_USAGE_NOT_GHOST")); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin(); await h.finish();
  await h.shutdown(); await h.start();
  await h.settleResponse(0, usageResponse("OLD_RUNTIME", { input: 9999, output: 999 })); await h.command("status");
  ok(h.notices.at(-1).text.includes("Reported tokens: not reported (0/0 reports)"), "late usage cannot pollute restarted totals");
  ok(!rendered(h.editor).includes("OLD_RUNTIME")); await h.shutdown();
}
{
  const h = harness(); await h.start();
  for (const fields of [{ input: 100, output: 10 }, { input: -1, output: 10 }, {}]) {
    await h.begin(); await h.finish(); await h.settleResponse(h.requests.length - 1, usageResponse("NO_SUGGESTION", fields));
  }
  await h.command("status");
  ok(h.notices.at(-1).text.includes("Reported tokens: 100 in / 10 out (1/3 reports)"), "missing/invalid reports do not become invented zero usage");
  await h.shutdown();
}
{
  const h = harness(); await h.start();
  for (const input of [Number.MAX_SAFE_INTEGER, 1]) {
    await h.begin(); await h.finish(); await h.settleResponse(h.requests.length - 1, usageResponse("NO_SUGGESTION", { input }));
  }
  await h.command("status");
  ok(h.notices.at(-1).text.includes(`Reported tokens: ${Number.MAX_SAFE_INTEGER} in / 0 out (1/2 reports)`), "totals cannot silently overflow");
  await h.shutdown();
}
// Content-free diagnostics: a silent skip, abstention and invalid output must be distinguishable.
for (const [response, expected, offered] of [
  [assistant("show me an example"), "offered", 1],
  [assistant("NO_SUGGESTION"), "abstained", 0],
  [assistant("show me an example\n"), "rejected:control-character", 0],
  [assistant(""), "rejected:empty-output", 0],
  [assistant('"show me an example"'), "rejected:quoted-or-labelled", 0],
  [assistant("x".repeat(201)), "rejected:too-long", 0],
  [assistant("partial", "length"), "rejected:incomplete-response", 0],
]) {
  const h = harness(); await h.start(); await h.begin({ text: "PRIVATE_USER_FIXTURE" }); await h.finish();
  await h.settleResponse(0, response); await h.command("status");
  const status = h.notices.at(-1).text;
  ok(status.includes(`attempts: 1; offered: ${offered}; last outcome: ${expected}`));
  ok(!status.includes("PRIVATE_USER_FIXTURE"));
  await h.command("status"); eq(h.notices.at(-1).text, status, "status preserves completed diagnostics");
  await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.command("status");
  ok(h.notices.at(-1).text.includes("attempts: 0; offered: 0; last outcome: not-started"));
  ok(!h.notices.at(-1).text.includes("proof of subscription billing"), "status omits prototype disclaimer text");
  await h.begin(); h.editor.focused = false; await h.finish(); await h.command("status");
  ok(h.notices.at(-1).text.includes("attempts: 0; offered: 0; last outcome: skipped:editor-unfocused"));
  await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin(); h.editor.setText(""); await h.finish(); await h.command("status");
  ok(h.notices.at(-1).text.includes("attempts: 0; offered: 0; last outcome: cancelled:editor-input"));
  await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin(); await h.emit("ui_prompt_start", { kind: "custom" });
  await h.emit("ui_prompt_end", { kind: "custom" }); await h.finish(); await h.command("status");
  eq(h.requests.length, 0, "a blocking UI also invalidates a run before prediction starts");
  ok(h.notices.at(-1).text.includes("last outcome: cancelled:blocking-ui")); await h.shutdown();
}
{
  const h = harness(); await h.start(); await h.begin(); await h.finish();
  h.requests[0].task.reject(new Error("PRIVATE_PROVIDER_FIXTURE")); await pause(); await h.command("status");
  ok(h.notices.at(-1).text.includes("attempts: 1; offered: 0; last outcome: error:request-failed"));
  ok(!h.notices.at(-1).text.includes("PRIVATE_PROVIDER_FIXTURE")); await h.shutdown();
}
const { checkShellPrediction } = await import("./shell-prediction.mjs");
checks += await checkShellPrediction({ harness, assistant, usageResponse, bashEntry, entry, user, rendered, pause });
const { checkHistory } = await import("./history.mjs");
checks += await checkHistory({ harness, jiti, host, tui, model, project, sdk, modules, KeybindingsManager, screen, theme, rendered, entry, user, assistant, projected });
const { checkSettings } = await import("./settings.mjs");
checks += await checkSettings({ harness, jiti, host, tui, model, project, pause, KeybindingsManager });
const { checkSession } = await import("./session.mjs");
checks += await checkSession({ host, ai, sdk, modules, project, KeybindingsManager, screen, theme, model, assistant, rendered });
checks += await checkSession({ host, ai, sdk, modules, project, KeybindingsManager, screen, theme, model, assistant, rendered, prefixHistory: true });
checks += await checkSession({ host, ai, sdk, modules, project, KeybindingsManager, screen, theme, model, assistant, rendered, historyOnly: true });
for (const timing of [true, "typing", "running"]) {
  checks += await checkSession({ host, ai, sdk, modules, project, KeybindingsManager, screen, theme, model, assistant, rendered, prefixHistory: true, shellDuringPrediction: timing });
}
console.log(`Passed ${checks} offline checks with real Pi ${JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")).version} editor/helpers and session lifecycle; provider calls mocked.`);
