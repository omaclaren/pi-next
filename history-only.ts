import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PrefixHistoryEditor, seedHistory } from "./prefix-history.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** Alternative entry point: history navigation only, with no predictor or model settings. */
export default function historyOnly(pi: ExtensionAPI): void {
  let ownFactory: EditorFactory | undefined, editor: PrefixHistoryEditor | undefined;
  function install(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const current = ctx.ui.getEditorComponent();
    if (current !== undefined && current !== ownFactory) {
      ctx.ui.notify("Prefix history needs the custom-editor slot. With next-prompt, use --prefix-history instead of loading history-only.ts.", "warning");
      return;
    }
    let main = true;
    ownFactory = (tui, theme, keys) => {
      const isMain = main;
      main = false;
      const instance = new PrefixHistoryEditor(tui, theme, keys, isMain);
      if (isMain) { editor = instance; seedHistory(instance, ctx.sessionManager.buildSessionProjection().entries); }
      return instance;
    };
    ctx.ui.setEditorComponent(ownFactory);
  }
  const reset = () => editor?.resetPrefixSearch();
  pi.on("session_start", (_event, ctx) => { reset(); install(ctx); });
  pi.on("session_tree", (_event, ctx) => {
    reset();
    if (ownFactory && ctx.ui.getEditorComponent() === ownFactory) install(ctx);
  });
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_before_tree", reset);
  pi.on("session_before_compact", reset);
  pi.on("ui_prompt_start", reset);
  pi.on("session_shutdown", (_event, ctx) => {
    reset();
    if (ctx.mode === "tui" && ownFactory && ctx.ui.getEditorComponent() === ownFactory) ctx.ui.setEditorComponent(undefined);
    editor = undefined; ownFactory = undefined;
  });
}
