import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { PrefixHistoryEditor } from "./prefix-history.ts";
import { CURSOR_MARKER, matchesKey, renderFakeCursor, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/** Render-only ghost state; it never changes getText(), history or onSubmit. */
export class GhostEditor extends PrefixHistoryEditor {
  private ghost: string | undefined;
  private edited: (() => void) | undefined;

  constructor(tui: TUI, theme: EditorTheme, keys: KeybindingsManager, edited?: () => void, prefixHistory = false) {
    super(tui, theme, keys, prefixHistory);
    this.edited = edited;
  }

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

  private invalidateInput(): void {
    this.clearGhost();
    this.edited?.();
  }

  override setText(text: string): void {
    this.invalidateInput();
    super.setText(text);
  }

  override insertTextAtCursor(text: string): void {
    this.invalidateInput();
    super.insertTextAtCursor(text);
  }

  override handleInput(data: string): void {
    const suggestion = this.getText() === "" && !this.isShowingAutocomplete() && this.focused ? this.ghost : undefined;
    if (suggestion && (matchesKey(data, "right") || matchesKey(data, "tab"))) {
      this.invalidateInput();
      super.insertTextAtCursor(suggestion); // Insertion only; never invoke onSubmit.
      return;
    }
    if (suggestion && matchesKey(data, "escape")) {
      this.invalidateInput();
      return;
    }
    // Navigation is conservative too: it may open history, a selector or a dialog.
    this.invalidateInput();
    super.handleInput(data);
  }

  override render(width: number): string[] {
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
