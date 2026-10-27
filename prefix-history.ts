import { CustomEditor, type KeybindingsManager, type ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

const MAX_HISTORY = 100;
const singleLine = (text: string) => !/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(text);

/** A bounded, memory-only index. The prefix and match order stay fixed during a search. */
export class PrefixHistory {
  private entries: string[] = [];
  private search: { draft: string; matches: string[]; index: number } | undefined;

  add(text: string): void {
    const value = text.trim();
    if (!value) return;
    this.entries = [value, ...this.entries.filter(item => item !== value)].slice(0, MAX_HISTORY);
    this.reset();
  }

  reset(): void { this.search = undefined; }
  get active(): boolean { return this.search !== undefined; }
  get current(): string | undefined {
    return this.search && (this.search.index < 0 ? this.search.draft : this.search.matches[this.search.index]);
  }

  navigate(direction: "up" | "down", draft: string): string | undefined {
    if (!this.search) {
      if (direction === "down" || !draft.trim() || !singleLine(draft)) return;
      this.search = { draft, matches: this.entries.filter(item => singleLine(item) && item.startsWith(draft)), index: -1 };
    }
    const search = this.search;
    if (direction === "up") {
      if (search.index + 1 >= search.matches.length) return;
      return search.matches[++search.index];
    }
    if (search.index > 0) return search.matches[--search.index];
    this.reset();
    return search.draft;
  }
}

/** Pi's normal editor plus prefix navigation; no model access or history files. */
export class PrefixHistoryEditor extends CustomEditor {
  private readonly prefixes = new PrefixHistory();
  private readonly prefixKeys: KeybindingsManager;
  private readonly prefixEnabled: boolean;
  private replacing = false;
  private nativeDraft: string | undefined;
  private pasting = false;
  private jumping = false;
  private lineWidth = Infinity;

  constructor(tui: TUI, theme: EditorTheme, keys: KeybindingsManager, enabled = true) {
    super(tui, theme, keys, { embedWorkingStatus: true });
    this.prefixKeys = keys;
    this.prefixEnabled = enabled;
  }

  resetPrefixSearch(): void { this.prefixes.reset(); this.nativeDraft = undefined; }

  override addToHistory(text: string): void {
    super.addToHistory(text);
    if (this.prefixEnabled) this.prefixes.add(text);
  }

  override setText(text: string): void {
    if (!this.replacing) this.resetPrefixSearch();
    super.setText(text);
  }

  override insertTextAtCursor(text: string): void {
    this.resetPrefixSearch();
    super.insertTextAtCursor(text);
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    this.resetPrefixSearch();
    return super.handleMouse(event);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
    this.lineWidth = Math.max(1, width - 2 * padding - (padding ? 0 : 1));
    return lines;
  }

  override handleInput(data: string): void {
    if (!this.prefixEnabled) { super.handleInput(data); return; }
    const keys = this.prefixKeys;
    const up = keys.matches(data, "tui.editor.cursorUp"), down = keys.matches(data, "tui.editor.cursorDown");
    const text = this.getText(), cursor = this.getCursor();
    const wasPasting = this.pasting, wasJumping = this.jumping;
    if (data.includes("\x1b[200~")) this.pasting = true;
    if (data.includes("\x1b[201~")) this.pasting = false;
    this.jumping = (keys.matches(data, "tui.editor.jumpForward") || keys.matches(data, "tui.editor.jumpBackward")) && !wasJumping;
    // Never steal an explicit history binding, app action, or other remapped editor action.
    const directionAction = up ? "tui.editor.cursorUp" : "tui.editor.cursorDown";
    const selectAction = up ? "tui.select.up" : "tui.select.down";
    const competing = (up || down) && Object.keys(keys.getEffectiveConfig()).some(action =>
      action !== directionAction && action !== selectAction && keys.matches(data, action as Parameters<KeybindingsManager["matches"]>[1]));
    if (this.prefixes.active && this.prefixes.current !== text) this.resetPrefixSearch();
    const atBoundary = cursor.line === 0 && (cursor.col === 0 || cursor.col === text.length);
    const canStart = up && (cursor.col === 0 || visibleWidth(text) < this.lineWidth);
    if ((up || down) && !competing && !wasPasting && !this.pasting && !wasJumping && !this.jumping &&
        this.focused && !this.isShowingAutocomplete() && this.nativeDraft === undefined &&
        text.trim() && singleLine(text) && this.getExpandedText() === text && atBoundary &&
        (this.prefixes.active || canStart)) {
      // Preserve the priority of shortcuts registered by other extensions.
      if (this.onExtensionShortcut?.(data)) { this.resetPrefixSearch(); return; }
      const value = this.prefixes.navigate(up ? "up" : "down", text);
      if (value !== undefined && value !== text) {
        this.replacing = true;
        try { this.setText(value); } finally { this.replacing = false; }
      }
      return; // No matches / oldest match: leave the draft alone, not unfiltered recall.
    }
    this.prefixes.reset();
    const previous = keys.matches(data, "tui.editor.historyPrevious"), next = keys.matches(data, "tui.editor.historyNext");
    if (this.nativeDraft === undefined && (previous || (up && cursor.line === 0 && cursor.col === 0))) this.nativeDraft = text;
    if (!up && !down && !previous && !next) this.nativeDraft = undefined;
    super.handleInput(data);
    if ((down || next) && this.getText() === this.nativeDraft) this.nativeDraft = undefined;
  }
}

/** Seed only ordinary, retained messages in the active projection; never tools or summaries. */
export function seedHistory(editor: CustomEditor, entries: readonly ProjectedSessionEntry[], includeBash = true): void {
  for (const entry of entries) {
    if (entry.sourceEntry.type !== "message") continue;
    for (const message of entry.messages) {
      if (message.role === "user") {
        const content = message.content;
        const text = typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text).join("\n");
        if (text.trim()) editor.addToHistory(text.trim());
      } else if (includeBash && message.role === "bashExecution" && message.command.trim()) {
        editor.addToHistory(`${message.excludeFromContext ? "!!" : "!"}${message.command}`);
      }
    }
  }
}
