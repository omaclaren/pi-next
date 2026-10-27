import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { PrefixHistoryEditor } from "./prefix-history.ts";
import { CURSOR_MARKER, matchesKey, renderFakeCursor, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

export type EditorEdit = "edit" | "shell" | "recall-command";

/** Render-only ghost state; it never changes getText(), history or onSubmit. */
export class GhostEditor extends PrefixHistoryEditor {
  private ghost: string | undefined;
  private edited: ((kind: EditorEdit) => void) | undefined;
  private readonly ghostKeys: KeybindingsManager;
  private inputDepth = 0;
  private notifiedDuringInput = false;
  private readonly restore: (() => string | undefined) | undefined;

  constructor(tui: TUI, theme: EditorTheme, keys: KeybindingsManager, edited?: (kind: EditorEdit) => void, prefixHistory = false, restore?: () => string | undefined) {
    super(tui, theme, keys, prefixHistory);
    this.edited = edited;
    this.ghostKeys = keys;
    this.restore = restore;
  }

  refreshGhost(): void { this.tui.requestRender(); }

  setGhost(text: string): boolean {
    if (this.getText() !== "" || this.isShowingAutocomplete() || !this.focused) return false;
    this.ghost = text;
    this.tui.requestRender();
    return true;
  }

  clearGhost(): void {
    if (this.ghost === undefined) return;
    this.ghost = undefined;
    this.tui.requestRender();
  }

  private editKind(text: string): EditorEdit {
    const value = text.trimStart();
    if (value.startsWith("!")) return "shell";
    if (value && ["/next-prompt recall", "/next-prompt status", "/next-prompt-recall"].some(command =>
      command.startsWith(value) || command === value.trimEnd())) return "recall-command";
    return "edit";
  }

  private invalidateInput(kind: EditorEdit = "edit", immediate = false): void {
    this.clearGhost();
    if (!this.inputDepth || immediate) this.edited?.(kind);
    if (this.inputDepth && immediate) this.notifiedDuringInput = true;
  }

  override setText(text: string): void {
    this.clearGhost();
    super.setText(text);
    this.invalidateInput(this.editKind(this.getText()));
  }

  override insertTextAtCursor(text: string): void {
    this.clearGhost();
    super.insertTextAtCursor(text);
    this.invalidateInput(this.editKind(this.getText()));
  }

  override handleInput(data: string): void {
    const suggestion = this.getText() === "" && !this.isShowingAutocomplete() && this.focused ? this.ghost : undefined;
    if (suggestion && (matchesKey(data, "right") || matchesKey(data, "tab"))) {
      this.invalidateInput("edit", true);
      super.insertTextAtCursor(suggestion); // Insertion only; never invoke onSubmit.
      return;
    }
    if (suggestion && matchesKey(data, "escape")) {
      this.invalidateInput("edit", true);
      return;
    }
    const keys = this.ghostKeys;
    if (keys.matches(data, "app.interrupt") || keys.matches(data, "tui.select.cancel") || keys.matches(data, "app.clear")) {
      this.invalidateInput("edit", true);
      super.handleInput(data);
      return;
    }
    if (keys.matches(data, "tui.input.submit") || keys.matches(data, "app.message.followUp")) {
      // Notify before onSubmit can start a new model exchange. Submission clears the text internally.
      const before = this.getText();
      this.invalidateInput(this.editKind(before), true);
      super.handleInput(data);
      // Enter can complete a non-slash autocomplete item without submitting it.
      const after = this.getText();
      if (after && after !== before) this.invalidateInput(this.editKind(after));
      return;
    }
    this.clearGhost();
    if (!this.inputDepth) this.notifiedDuringInput = false;
    this.inputDepth++;
    try { super.handleInput(data); }
    finally { this.inputDepth--; }
    if (!this.inputDepth && this.notifiedDuringInput) { this.notifiedDuringInput = false; return; }
    // Inspect the actual edited text, including paste/history/autocomplete and encoded printable keys.
    this.invalidateInput(this.editKind(this.getText()));
  }

  override render(width: number): string[] {
    // Pi redraws after recording a local shell result. Reconcile only local ghost state:
    // no polling, model calls, text insertion or recursive render requests.
    if (!this.ghost && this.focused && this.getText() === "" && !this.isShowingAutocomplete()) {
      this.ghost = this.restore?.();
    }
    const lines = super.render(width);
    if (!this.ghost || !this.focused || this.getText() !== "" || this.isShowingAutocomplete()) return lines;
    const row = lines.findIndex(line => line.includes(CURSOR_MARKER));
    if (row < 0) return lines;
    const prefix = lines[row].slice(0, lines[row].indexOf(CURSOR_MARKER));
    const room = Math.max(0, width - visibleWidth(prefix));
    const first = new Intl.Segmenter().segment(this.ghost)[Symbol.iterator]().next().value?.segment ?? "";
    const styled = `\x1b[2m${renderFakeCursor(first)}${this.ghost.slice(first.length)}\x1b[22m`;
    lines[row] = prefix + CURSOR_MARKER + truncateToWidth(styled, room, "…");
    return lines;
  }
}
