import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
import { buildPayload, generate, looksRemote, ordinary, selectModel, textOnly, type Failure } from "./core.ts";
import { GhostEditor } from "./ghost-editor.ts";

const FLAG = "next-prompt-model";
interface Activity {
  session: string;
  beforeIds: Set<string>;
  prompt?: string;
  started: boolean;
  loopStarted: boolean;
  completed: boolean;
}

/** Optional short timeout is a test seam, not a user configuration surface. */
export function registerNextPrompt(pi: ExtensionAPI, options: { timeoutMs?: number } = {}): void {
  let enabled = false, selection = "", epoch = 0, blocked = 0;
  let lastError: Failure | undefined;
  // Runtime-only, content-free diagnostics. Attempts count local generation starts, not billed HTTP requests.
  let attempts = 0, offered = 0, lastOutcome = "not-started";
  let usageEpoch = 0, usageReports = 0, inputTokens = 0, outputTokens = 0;
  let activity: Activity | undefined;
  let pending: AbortController | undefined;
  let editor: GhostEditor | undefined;
  // One offered candidate in RAM, retained across dismissal only; never a suggestion history.
  let recallCandidate: { text: string; session: string; leaf: string | null; editor: GhostEditor } | undefined;
  let ownFactory: EditorFactory | undefined;
  const localUsers = new Set<string>();

  function cancel(): void {
    epoch++;
    pending?.abort();
    pending = undefined;
    editor?.clearGhost();
  }
  function invalidate(reason: string, keepRecall = false): void {
    if (activity || pending) lastOutcome = reason;
    activity = undefined;
    if (!keepRecall) recallCandidate = undefined;
    cancel();
  }
  function edited(): void { invalidate("cancelled:editor-input", true); }
  function reset(): void { invalidate("cancelled:session-or-branch"); localUsers.clear(); blocked = 0; }
  function fail(error: Failure): void { lastError = error; lastOutcome = `error:${error}`; }

  function install(ctx: ExtensionContext, rebuild = false): boolean {
    if (ctx.mode !== "tui") return false;
    const existing = ctx.ui.getEditorComponent();
    if (existing !== undefined && existing !== ownFactory) { fail("editor-conflict"); return false; }
    if (!rebuild && ownFactory && existing === ownFactory) return true;
    let main = true;
    ownFactory = (tui, theme, keys) => {
      const isMain = main;
      main = false;
      const instance = new GhostEditor(tui, theme, keys, isMain ? edited : undefined);
      if (isMain) {
        editor = instance;
        for (const item of ordinary(ctx.sessionManager.buildSessionProjection().entries)) {
          if (item.message.role !== "user") continue;
          const text = textOnly(item.message.content).trim();
          if (text) instance.addToHistory(text);
        }
      }
      return instance;
    };
    ctx.ui.setEditorComponent(ownFactory);
    return true;
  }

  function notReady(ctx: ExtensionContext): string | undefined {
    if (!enabled || ctx.mode !== "tui") return "disabled-or-headless";
    if (blocked) return "blocking-ui";
    if (!ctx.isIdle()) return "busy";
    if (ctx.hasPendingMessages()) return "queued-input";
    if (!editor?.focused) return "editor-unfocused";
    if (editor.getText() !== "" || ctx.ui.getEditorText() !== "") return "editor-not-empty";
    if (editor.isShowingAutocomplete()) return "autocomplete";
    if (ctx.ui.getEditorComponent() !== ownFactory) return "editor-replaced";
    return undefined;
  }

  pi.registerFlag(FLAG, { description: "Opt-in next-prompt chat model: openai/MODEL_ID (stored OAuth required)", type: "string" });
  pi.registerCommand("next-prompt", {
    description: "Next-prompt suggestions: on, off, status, recall (session-local)",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      // Commands cancel pending generation/visible ghosts; recall may reuse an offered candidate.
      invalidate("cancelled:command", true);
      if (command === "recall") {
        if (ctx.mode !== "tui") { ctx.ui.notify("Next-prompt is terminal-only.", "info"); return; }
        const saved = recallCandidate;
        if (!saved) { ctx.ui.notify("No suggestion to recall for this exchange.", "info"); return; }
        if (saved.session !== ctx.sessionManager.getSessionId() || saved.leaf !== ctx.sessionManager.getLeafId() ||
            saved.editor !== editor || ctx.ui.getEditorComponent() !== ownFactory) {
          recallCandidate = undefined;
          ctx.ui.notify("The previous suggestion is no longer current.", "info"); return;
        }
        if (notReady(ctx) || !editor?.setGhost(saved.text)) {
          ctx.ui.notify("Recall needs next-prompt on and an idle, empty, focused editor with no completion menu.", "info"); return;
        }
        lastOutcome = "recalled";
        return; // Render only: no model call, editor text insertion or submission.
      }
      if (command === "off") { enabled = false; recallCandidate = undefined; }
      else if (command === "on") {
        recallCandidate = undefined;
        enabled = false;
        const choice = selectModel(ctx, selection);
        if (ctx.mode !== "tui") { ctx.ui.notify("Next-prompt is terminal-only.", "info"); return; }
        if ("error" in choice) { fail(choice.error); ctx.ui.notify(`Next-prompt stays off: ${choice.error}. Supply --${FLAG} openai/MODEL_ID at launch.`, "warning"); return; }
        enabled = install(ctx);
        if (enabled) lastError = undefined;
      } else if (command !== "status") {
        ctx.ui.notify("Usage: /next-prompt [on|off|status|recall]", "info"); return;
      }
      const label = /^openai\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(selection) ? selection : "not selected";
      const tokens = usageReports ? `${inputTokens} in / ${outputTokens} out` : "not reported";
      ctx.ui.notify(`Next-prompt: ${enabled ? "on" : "off"}; model: ${label}; last error: ${lastError ?? "none"}; attempts: ${attempts}; offered: ${offered}; last outcome: ${lastOutcome}. Reported tokens: ${tokens} (${usageReports}/${attempts} reports).`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    usageEpoch++; // Late usage from the previous runtime must not enter the new totals.
    reset(); editor = undefined; ownFactory = undefined; lastError = undefined;
    attempts = 0; offered = 0; lastOutcome = "not-started";
    usageReports = 0; inputTokens = 0; outputTokens = 0;
    selection = String(pi.getFlag(FLAG) ?? "");
    enabled = false;
    if (!selection || ctx.mode !== "tui") return;
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
        if (ctx.sessionManager.getSessionId() !== finished.session || ctx.sessionManager.getLeafId() !== leaf ||
            instance !== editor || notReady(ctx)) { lastOutcome = "discarded:stale-or-not-ready"; return; }
        lastError = undefined;
        lastOutcome = result.outcome ?? "no-result";
        if (result.text) {
          if (editor?.setGhost(result.text)) {
            recallCandidate = { text: result.text, session: finished.session, leaf, editor };
            offered++; lastOutcome = "offered";
          } else lastOutcome = "discarded:editor-not-ready";
        }
      }).catch(() => { if (epoch === requestEpoch) fail("request-failed"); })
        .finally(() => { if (pending === controller) pending = undefined; });
    } catch { fail("context-unavailable"); cancel(); }
  });

  pi.on("ui_prompt_start", () => { blocked++; invalidate("cancelled:blocking-ui"); });
  pi.on("ui_prompt_end", () => { blocked = Math.max(0, blocked - 1); });
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_before_tree", reset);
  pi.on("session_before_compact", () => invalidate("cancelled:compaction"));
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
