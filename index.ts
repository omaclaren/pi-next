import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
import { buildPayload, generate, looksRemote, selectModel, textOnly, type Failure } from "./core.ts";
import { GhostEditor, type EditorEdit } from "./ghost-editor.ts";
import { seedHistory } from "./prefix-history.ts";
import { modelSettings, pickModel, type ModelSettings } from "./settings.ts";

const FLAG = "next-prompt-model";
interface ShellPause {
  session: string;
  leaf: string | null;
  editor: GhostEditor;
  command?: string;
  excluded?: boolean;
}
interface Activity {
  session: string;
  beforeIds: Set<string>;
  prompt?: string;
  started: boolean;
  loopStarted: boolean;
  completed: boolean;
}

/** Optional timeout/settings injection keeps tests offline and out of real user configuration. */
export function registerNextPrompt(pi: ExtensionAPI, options: { timeoutMs?: number; settings?: ModelSettings } = {}): void {
  const settings = options.settings ?? modelSettings();
  let enabled = false, selection = "", epoch = 0, blocked = 0, modelEpoch = 0, prefixHistory = false;
  let lastError: Failure | undefined;
  // Runtime-only, content-free diagnostics: attempts are local starts, not billed HTTP requests.
  // Offered counts distinct automatic candidates, not repeated restores or explicit recall.
  let attempts = 0, offered = 0, lastOutcome = "not-started";
  let usageEpoch = 0, usageReports = 0, inputTokens = 0, outputTokens = 0;
  let activity: Activity | undefined;
  let pending: AbortController | undefined;
  let shellHeld = false, autoEligible = false;
  let shellPause: ShellPause | undefined;
  let editor: GhostEditor | undefined;
  // One candidate in RAM for the last model exchange; never a suggestion history.
  let recallCandidate: { text: string; session: string; leaf: string | null; editor: GhostEditor; offered: boolean } | undefined;
  let ownFactory: EditorFactory | undefined;
  const localUsers = new Set<string>();

  function cancel(): void {
    epoch++;
    pending?.abort();
    pending = undefined;
    shellHeld = false; autoEligible = false; shellPause = undefined;
    editor?.clearGhost();
  }
  function invalidate(reason: string, keepRecall = false): void {
    if (activity || pending) lastOutcome = reason;
    activity = undefined;
    if (!keepRecall) recallCandidate = undefined;
    cancel();
  }
  function edited(kind: EditorEdit, ctx: ExtensionContext): void {
    if (kind === "shell" && editor && (pending || autoEligible || shellPause)) {
      shellHeld = !!pending;
      shellPause = { session: ctx.sessionManager.getSessionId(), leaf: ctx.sessionManager.getLeafId(), editor };
      autoEligible = true;
      activity = undefined;
      if (pending) lastOutcome = "request-pending:shell";
      return;
    }
    if (kind === "recall-command" && ((pending && shellHeld) || shellPause)) return;
    invalidate("cancelled:editor-input", true);
  }
  function reset(): void { modelEpoch++; invalidate("cancelled:session-or-branch"); editor?.resetPrefixSearch(); localUsers.clear(); blocked = 0; }
  function fail(error: Failure): void {
    lastError = error; lastOutcome = `error:${error}`;
    autoEligible = false; shellPause = undefined;
  }

  function install(ctx: ExtensionContext, rebuild = false): boolean {
    if (ctx.mode !== "tui") return false;
    const existing = ctx.ui.getEditorComponent();
    if (existing !== undefined && existing !== ownFactory) { fail("editor-conflict"); return false; }
    if (!rebuild && ownFactory && existing === ownFactory) return true;
    let main = true;
    ownFactory = (tui, theme, keys) => {
      const isMain = main;
      main = false;
      const instance = new GhostEditor(tui, theme, keys, isMain ? kind => edited(kind, ctx) : undefined,
        isMain && prefixHistory, isMain ? () => restoreAfterShell(ctx) : undefined);
      if (isMain) {
        editor = instance;
        seedHistory(instance, ctx.sessionManager.buildSessionProjection().entries, prefixHistory);
      }
      return instance;
    };
    ctx.ui.setEditorComponent(ownFactory);
    return true;
  }

  /** A local shell result advances the leaf without starting a new model exchange. */
  function sameExchange(leaf: string | null, ctx: ExtensionContext): boolean {
    const current = ctx.sessionManager.getLeafId();
    if (leaf === current) return true;
    if (leaf === null) return false;
    const branch = ctx.sessionManager.getBranch(), anchor = branch.findIndex(entry => entry.id === leaf);
    return anchor >= 0 && branch.at(-1)?.id === current && branch.slice(anchor + 1).every(entry =>
      entry.type === "message" && entry.message.role === "bashExecution");
  }

  function notReady(ctx: ExtensionContext, forCache = false): string | undefined {
    if (!enabled || ctx.mode !== "tui") return "disabled-or-headless";
    if (blocked) return "blocking-ui";
    if (!ctx.isIdle()) return "busy";
    if (ctx.hasPendingMessages()) return "queued-input";
    if (!forCache) {
      if (!editor?.focused) return "editor-unfocused";
      if (editor.getText() !== "" || ctx.ui.getEditorText() !== "") return "editor-not-empty";
      if (editor.isShowingAutocomplete()) return "autocomplete";
    }
    if (ctx.ui.getEditorComponent() !== ownFactory) return "editor-replaced";
    return undefined;
  }

  function completedShell(ctx: ExtensionContext, paused: ShellPause) {
    if (paused.command === undefined || ctx.sessionManager.getLeafId() === paused.leaf || !sameExchange(paused.leaf, ctx)) return;
    const tail = ctx.sessionManager.getBranch().at(-1);
    if (tail?.type === "message" && tail.message.role === "bashExecution" && tail.message.command === paused.command &&
        !!tail.message.excludeFromContext === !!paused.excluded) return tail.message;
  }

  function restoreAfterShell(ctx: ExtensionContext): string | undefined {
    const paused = shellPause, saved = recallCandidate;
    if (!paused || !saved) return;
    try {
      if (paused.session !== ctx.sessionManager.getSessionId() || saved.session !== paused.session ||
          paused.editor !== editor || saved.editor !== editor || ctx.ui.getEditorComponent() !== ownFactory) {
        shellPause = undefined; autoEligible = false; return;
      }
      if (paused.command === undefined || ctx.sessionManager.getLeafId() === paused.leaf) return;
      if (!sameExchange(saved.leaf, ctx) || !sameExchange(paused.leaf, ctx)) {
        shellPause = undefined; autoEligible = false; return;
      }
      const result = completedShell(ctx, paused);
      if (!result) return; // A submitted command, not merely an emptied draft, must have finished.
      if (result.cancelled) { shellPause = undefined; autoEligible = false; return; }
      if (notReady(ctx)) return;
      shellPause = undefined; autoEligible = true;
      if (!saved.offered) { saved.offered = true; offered++; }
      lastOutcome = "restored-after-shell";
      return saved.text;
    } catch { shellPause = undefined; autoEligible = false; }
  }

  // Observe only: never intercept execution, modify the command, or send it to the predictor.
  pi.on("user_bash", (event, ctx) => {
    if (ctx.mode !== "tui" || !shellPause || !editor) return;
    try {
      shellPause = { session: ctx.sessionManager.getSessionId(), leaf: ctx.sessionManager.getLeafId(), editor,
        command: event.command, excluded: event.excludeFromContext };
    } catch { shellPause = undefined; autoEligible = false; }
  });

  pi.registerFlag(FLAG, { description: "Suggestion model: provider/model (overrides saved choice at startup)", type: "string" });
  pi.registerFlag("prefix-history", { description: "Enable local prefix-filtered Up/Down history, independently of suggestions", type: "boolean" });
  pi.registerCommand("next-prompt", {
    description: "Start suggestions; model, on, off, status, recall",
    handler: async (args, ctx) => {
      const command = args.trim() || "on", commandEpoch = ++modelEpoch;
      const modelCommand = command === "model" || command.startsWith("model ");
      // Recall/status must not cancel the shell-held request they are inspecting.
      if (((pending && shellHeld) || shellPause) && (command === "recall" || command === "status")) editor?.clearGhost();
      else invalidate("cancelled:command", true);
      if (modelCommand || (command === "on" && !selection)) {
        if (ctx.mode !== "tui") { ctx.ui.notify("Next-prompt is terminal-only.", "info"); return; }
        if (!ctx.isIdle() || ctx.hasPendingMessages() || blocked) { ctx.ui.notify("Wait for Pi to finish before changing the suggestion model.", "info"); return; }
        const requested = (modelCommand ? command.slice(5).trim() : "") || await pickModel(ctx, selection);
        if (commandEpoch !== modelEpoch || !requested) return;
        if (!ctx.isIdle() || ctx.hasPendingMessages() || blocked) { ctx.ui.notify("Pi is busy. Try choosing the model again when it finishes.", "info"); return; }
        const choice = selectModel(ctx, requested);
        if ("error" in choice) { fail(choice.error); ctx.ui.notify(`Could not select model: ${choice.error}.`, "warning"); return; }
        if (!install(ctx)) { ctx.ui.notify("Another extension is using the custom editor.", "warning"); return; }
        try { settings.save(requested); }
        catch { fail("settings-error"); ctx.ui.notify("Could not save the next-prompt model.", "error"); return; }
        selection = requested; enabled = true; lastError = undefined; recallCandidate = undefined; lastOutcome = "model-selected";
        ctx.ui.notify(`Next-prompt model: ${selection}.`, "info");
        return;
      }
      if (command === "recall") {
        if (ctx.mode !== "tui") { ctx.ui.notify("Next-prompt is terminal-only.", "info"); return; }
        const saved = recallCandidate;
        if (!saved) {
          ctx.ui.notify(pending && shellHeld ? "Suggestion is still being generated. Try recall again shortly." : "No suggestion to recall for this exchange.", "info");
          return;
        }
        if (saved.session !== ctx.sessionManager.getSessionId() || !sameExchange(saved.leaf, ctx) ||
            saved.editor !== editor || ctx.ui.getEditorComponent() !== ownFactory) {
          recallCandidate = undefined;
          ctx.ui.notify("The previous suggestion is no longer current.", "info"); return;
        }
        if (shellPause?.command !== undefined && !completedShell(ctx, shellPause)) {
          ctx.ui.notify("Wait for the shell command to finish before recalling a suggestion.", "info"); return;
        }
        if (notReady(ctx) || !editor?.setGhost(saved.text)) {
          ctx.ui.notify("Recall needs next-prompt on and an idle, empty, focused editor with no completion menu.", "info"); return;
        }
        shellPause = undefined; autoEligible = true;
        lastOutcome = "recalled";
        return; // Render only: no model call, editor text insertion or submission.
      }
      if (command === "off") { enabled = false; recallCandidate = undefined; }
      else if (command === "on") {
        recallCandidate = undefined;
        enabled = false;
        const choice = selectModel(ctx, selection);
        if (ctx.mode !== "tui") { ctx.ui.notify("Next-prompt is terminal-only.", "info"); return; }
        if ("error" in choice) { fail(choice.error); ctx.ui.notify(`Next-prompt stays off: ${choice.error}. Use /next-prompt model to choose one.`, "warning"); return; }
        enabled = install(ctx);
        if (enabled) lastError = undefined;
      } else if (command !== "status") {
        ctx.ui.notify("Usage: /next-prompt [model|on|off|status|recall]", "info"); return;
      }
      const chosen = selectModel(ctx, selection);
      const label = "model" in chosen ? `${chosen.model.provider}/${chosen.model.id}` : "not selected";
      const tokens = usageReports ? `${inputTokens} in / ${outputTokens} out` : "not reported";
      ctx.ui.notify(`Next-prompt: ${enabled ? "on" : "off"}; model: ${label}; last error: ${lastError ?? "none"}; attempts: ${attempts}; offered: ${offered}; last outcome: ${lastOutcome}. Reported tokens: ${tokens} (${usageReports}/${attempts} reports).`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    usageEpoch++; // Late usage from the previous runtime must not enter the new totals.
    reset(); editor = undefined; ownFactory = undefined; lastError = undefined;
    attempts = 0; offered = 0; lastOutcome = "not-started";
    usageReports = 0; inputTokens = 0; outputTokens = 0;
    selection = ""; enabled = false; prefixHistory = false;
    if (ctx.mode !== "tui") return;
    prefixHistory = pi.getFlag("prefix-history") === true;
    if (prefixHistory) install(ctx);
    try {
      const flag = pi.getFlag(FLAG);
      selection = flag !== undefined ? String(flag) : settings.load();
    } catch { fail("settings-error"); return; }
    if (!selection) return;
    const choice = selectModel(ctx, selection);
    if ("error" in choice) { fail(choice.error); return; }
    enabled = install(ctx);
    if (enabled) lastError = undefined;
  });

  pi.on("input", (event, ctx) => {
    recallCandidate = undefined;
    activity = undefined; cancel();
    let skip: string | undefined;
    if (!enabled || ctx.mode !== "tui") skip = "disabled-or-headless";
    else if (event.source !== "interactive" || looksRemote(event.text)) skip = "non-local-input";
    else if (event.streamingBehavior || !ctx.isIdle() || ctx.hasPendingMessages()) skip = "busy-or-queued-input";
    else if (blocked) skip = "blocking-ui";
    else if (!event.text.trim() || event.images?.length || event.text.startsWith("/")) skip = "unsupported-input";
    if (skip) { lastOutcome = `skipped:${skip}`; return; }
    lastOutcome = "input-eligible";
    activity = { session: ctx.sessionManager.getSessionId(),
      beforeIds: new Set(ctx.sessionManager.getBranch().map(e => e.id)),
      started: false, loopStarted: false, completed: false };
  });

  pi.on("before_agent_start", (event, ctx) => {
    recallCandidate = undefined;
    cancel();
    if (event.messageType !== "user" || !activity || activity.started || activity.session !== ctx.sessionManager.getSessionId() || looksRemote(event.prompt)) {
      if (activity) lastOutcome = "skipped:ambiguous-start";
      activity = undefined; return;
    }
    activity.prompt = event.prompt;
    activity.started = true;
    lastOutcome = "run-started";
  });
  pi.on("agent_start", () => {
    recallCandidate = undefined;
    cancel();
    if (!activity?.started || activity.loopStarted) {
      if (activity) lastOutcome = "skipped:multiple-or-unattributed-loops";
      activity = undefined; return;
    }
    activity.loopStarted = true;
    lastOutcome = "loop-started";
  });
  pi.on("agent_before_settle", event => {
    if (!activity) return;
    if (event.outcome !== "completed" || event.continue || event.context.pendingMessages.length) {
      lastOutcome = "skipped:unsuccessful-or-continuing-run";
      activity = undefined; cancel(); return;
    }
    activity.completed = true;
    lastOutcome = "awaiting-settlement";
  });

  pi.on("agent_settled", (event, ctx) => {
    const finished = activity;
    activity = undefined; // Consume once, even when the request or eligibility check fails.
    if (!finished) return; // Preserve the earlier content-free skip/cancellation reason.
    if (!finished.started || !finished.loopStarted || !finished.completed || event.aborted ||
        finished.session !== ctx.sessionManager.getSessionId()) { lastOutcome = "skipped:incomplete-activity"; return; }
    const blocker = notReady(ctx);
    if (blocker) { lastOutcome = `skipped:${blocker}`; return; }
    try {
      const added = ctx.sessionManager.getBranch().filter(e => !finished.beforeIds.has(e.id));
      // Queued custom messages can bypass input/before_agent_start within a running loop.
      if (added.some(e => e.type === "custom_message" || (e.type === "message" && e.message.role === "custom"))) {
        lastOutcome = "skipped:mixed-source-activity"; return;
      }
      const users = added.filter(e => e.type === "message" && e.message.role === "user");
      if (users.length !== 1) { lastOutcome = "skipped:ambiguous-user-count"; return; }
      const user = users[0];
      if (user.type !== "message" || user.message.role !== "user" || textOnly(user.message.content) !== finished.prompt) {
        lastOutcome = "skipped:prompt-mismatch"; return;
      }
      localUsers.add(user.id);
      const payload = buildPayload(ctx.sessionManager.buildSessionProjection().entries, user.id, localUsers);
      if (!payload) { lastOutcome = "skipped:context-or-consent-check"; return; }
      const leaf = ctx.sessionManager.getLeafId(), instance = editor, requestEpoch = ++epoch;
      const controller = new AbortController();
      pending = controller;
      attempts++;
      lastError = undefined;
      lastOutcome = "request-pending";
      const meterEpoch = usageEpoch;
      void generate(ctx, selection, payload, controller, options.timeoutMs, usage => {
        // Usage belongs to the session runtime, not to whether a ghost can still be shown.
        if (usageEpoch !== meterEpoch || !Number.isSafeInteger(inputTokens + usage.input) ||
            !Number.isSafeInteger(outputTokens + usage.output)) return;
        inputTokens += usage.input; outputTokens += usage.output; usageReports++;
      }).then(result => {
        if (epoch !== requestEpoch || controller.signal.aborted) {
          // A timeout aborts its own controller; report it only if this request still owns the epoch.
          if (epoch === requestEpoch && result.error === "timeout") fail("timeout");
          return;
        }
        if (result.error) { fail(result.error); return; }
        const held = shellHeld;
        if (ctx.sessionManager.getSessionId() !== finished.session ||
            (held ? !sameExchange(leaf, ctx) : ctx.sessionManager.getLeafId() !== leaf) ||
            !instance || instance !== editor || notReady(ctx, held)) {
          lastOutcome = "discarded:stale-or-not-ready";
          shellPause = undefined; autoEligible = false; return;
        }
        lastError = undefined;
        lastOutcome = result.outcome ?? "no-result";
        if (result.text) {
          if (held) {
            recallCandidate = { text: result.text, session: finished.session, leaf, editor: instance, offered: false };
            lastOutcome = "cached-for-recall";
            instance.refreshGhost();
          } else if (editor?.setGhost(result.text)) {
            recallCandidate = { text: result.text, session: finished.session, leaf, editor, offered: true };
            autoEligible = true; offered++; lastOutcome = "offered";
          } else lastOutcome = "discarded:editor-not-ready";
        } else { shellPause = undefined; autoEligible = false; }
      }).catch(() => { if (epoch === requestEpoch) fail("request-failed"); })
        .finally(() => { if (pending === controller) { pending = undefined; shellHeld = false; } });
    } catch { fail("context-unavailable"); cancel(); }
  });

  pi.on("ui_prompt_start", () => { blocked++; editor?.resetPrefixSearch(); invalidate("cancelled:blocking-ui"); });
  pi.on("ui_prompt_end", () => { blocked = Math.max(0, blocked - 1); });
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_before_tree", reset);
  pi.on("session_before_compact", () => { editor?.resetPrefixSearch(); invalidate("cancelled:compaction"); });
  pi.on("session_tree", (_event, ctx) => {
    reset();
    if (ownFactory && ctx.ui.getEditorComponent() === ownFactory) install(ctx, true);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    usageEpoch++;
    reset(); enabled = false;
    if (ctx.mode === "tui" && ownFactory && ctx.ui.getEditorComponent() === ownFactory) ctx.ui.setEditorComponent(undefined);
    editor = undefined; ownFactory = undefined;
  });
}

export default function nextPrompt(pi: ExtensionAPI): void { registerNextPrompt(pi); }
