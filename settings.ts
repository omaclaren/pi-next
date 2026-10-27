import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, getSelectListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { isModelRef } from "./core.ts";

export interface ModelSettings { load(): string; save(model: string): void }

/** Only the explicitly chosen model is stored, never credentials or conversation text. */
export function modelSettings(path = join(getAgentDir(), "next-prompt.json")): ModelSettings {
  return {
    load() {
      try {
        const data: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!data || typeof data !== "object" || !("model" in data) || !isModelRef(data.model)) throw new Error("Invalid model setting");
        return data.model;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw new Error("Could not read next-prompt settings");
      }
    },
    save(model) {
      if (!isModelRef(model)) throw new Error("Invalid model setting");
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ model }, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
      } finally { rmSync(temporary, { force: true }); }
    },
  };
}

/** Pi supplies the available models, searchable list, input, theme and keyboard handling. */
export function pickModel(ctx: ExtensionContext, current: string): Promise<string | undefined> {
  const items = ctx.modelRegistry.getAvailable()
    .map(model => ({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}`, description: model.name }))
    .filter(item => isModelRef(item.value));
  if (!items.length) { ctx.ui.notify("No chat models available. Set up a model in Pi first.", "info"); return Promise.resolve(undefined); }
  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
    const search = new Input({ placeholder: "Search models" });
    const makeList = (query = "") => {
      const list = new SelectList(fuzzyFilter(items, query, item => `${item.value} ${item.description}`),
        Math.max(1, Math.min(10, tui.terminal.rows - 8)), {
          ...getSelectListTheme(), noMatch: () => theme.fg("muted", "  No matching models"),
        });
      list.onSelect = item => done(item.value);
      list.onCancel = () => done(undefined);
      return list;
    };
    let list = makeList();
    list.setSelectedIndex(Math.max(0, items.findIndex(item => item.value === current)));
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", "Next-prompt model"), 0, 0));
    container.addChild(search);
    container.addChild(list);
    return {
      get focused() { return search.focused; },
      set focused(value: boolean) { search.focused = value; },
      render: width => container.render(width).map(line => truncateToWidth(line, width)),
      invalidate: () => container.invalidate(),
      handleMouse: event => container.handleMouse(event),
      handleInput(data) {
        if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const)
          .some(key => keys.matches(data, key))) list.handleInput(data);
        else {
          const previous = search.getValue();
          search.handleInput(data);
          if (search.getValue() !== previous) {
            container.removeChild(list); list = makeList(search.getValue()); container.addChild(list);
          }
        }
        tui.requestRender();
      },
    };
  });
}
