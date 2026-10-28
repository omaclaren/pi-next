import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function checkSettings({ harness, jiti, host, tui, model, project, pause, KeybindingsManager }) {
  const { modelSettings, pickModel } = await jiti.import(join(project, "settings.ts"));
  const core = await jiti.import(join(project, "core.ts"));
  const folder = mkdtempSync(join(tmpdir(), "pi-next-settings-"));
  const beforeAgentDir = process.env.PI_CODING_AGENT_DIR;
  let checks = 0;
  const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
  const ok = (value, label) => { assert.ok(value, label); checks++; };
  const memory = (initial = "") => {
    let value = initial;
    const writes = [];
    return { load: () => value, save: next => { value = next; writes.push(next); }, writes };
  };
  const google = { ...model, provider: "google", id: "gemini-fixture", name: "Gemini fixture", api: "google-generative-ai" };
  const anthropic = { ...model, provider: "anthropic", id: "claude-fixture", api: "anthropic-messages" };
  const router = { ...model, provider: "openrouter", id: "org/model:free", name: "Router fixture" };
  const local = { ...model, provider: "llama-cpp", id: "local-model.gguf", name: "Local fixture" };
  const catalog = [model, google, anthropic, router, local];
  try {
    process.env.PI_CODING_AGENT_DIR = folder;
    host.initTheme("dark", false);
    // Files contain just the chosen reference, and writes replace the file atomically.
    const path = join(folder, "settings", "pi-next.json"), store = modelSettings(path);
    eq(store.load(), ""); store.save("openrouter/org/model:free");
    eq(store.load(), "openrouter/org/model:free");
    eq(JSON.parse(readFileSync(path, "utf8")), { model: "openrouter/org/model:free" });
    eq(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => store.save("not-a-reference")); checks++;
    eq(store.load(), "openrouter/org/model:free");
    writeFileSync(path, "{invalid"); assert.throws(() => store.load()); checks++;
    store.save("google/gemini-fixture"); eq(store.load(), "google/gemini-fixture");
    const directory = join(folder, "directory"); mkdirSync(directory);
    assert.throws(() => modelSettings(directory).save("google/gemini-fixture")); checks++;
    ok(!readdirSync(folder).some(name => name.endsWith(".tmp")), "failed save cleans its temporary file");
    for (const ref of ["openrouter/org/model:free", "llama-cpp/model.gguf", "custom/Model with spaces"]) ok(core.isModelRef(ref));
    for (const ref of ["", "model-only", "/model", "provider/", "provider/model\n", "provider/\x1b[31mmodel", "provider/\u202Emodel"]) eq(core.isModelRef(ref), false);

    // Default settings read the old file only if the new file is absent, without startup writes.
    const currentPath = join(folder, "pi-next.json"), legacyPath = join(folder, "next-prompt.json");
    const defaultStore = modelSettings();
    eq(defaultStore.load(), "");
    const legacyContents = JSON.stringify({ model: "openai/gpt-6-luna" }) + "\n";
    writeFileSync(legacyPath, legacyContents);
    eq(defaultStore.load(), "openai/gpt-6-luna"); eq(existsSync(currentPath), false);
    eq(readFileSync(legacyPath, "utf8"), legacyContents);
    const migrated = harness({ flag: null, settings: defaultStore }); migrated.models(catalog); await migrated.start();
    ok(migrated.editor, "the old saved choice enables startup without a picker or a rewrite");
    await migrated.namedCommand("next-prompt", "on"); await migrated.command("");
    eq(existsSync(currentPath), false); eq(readFileSync(legacyPath, "utf8"), legacyContents);
    eq(migrated.requests.length, 0); await migrated.shutdown();
    eq(modelSettings(join(folder, "explicit-absent.json")).load(), "", "explicit paths do not read unrelated legacy settings");
    defaultStore.save("google/gemini-fixture");
    eq(defaultStore.load(), "google/gemini-fixture"); eq(statSync(currentPath).mode & 0o777, 0o600);
    eq(JSON.parse(readFileSync(currentPath, "utf8")), { model: "google/gemini-fixture" });
    eq(readFileSync(legacyPath, "utf8"), legacyContents, "saving leaves the old choice alone");
    writeFileSync(legacyPath, "{invalid"); eq(defaultStore.load(), "google/gemini-fixture", "the new file takes precedence over a corrupt old file");
    writeFileSync(legacyPath, legacyContents); writeFileSync(currentPath, "{invalid");
    assert.throws(() => defaultStore.load(), /Could not read pi-next settings/); checks++;
    rmSync(currentPath); eq(defaultStore.load(), "openai/gpt-6-luna");
    writeFileSync(legacyPath, "{invalid");
    assert.throws(() => defaultStore.load(), /Could not read pi-next settings/); checks++;
    rmSync(legacyPath); eq(defaultStore.load(), "");
    mkdirSync(currentPath);
    assert.throws(() => defaultStore.load(), /Could not read pi-next settings/); checks++;
    rmSync(currentPath, { recursive: true });

    // Both flag names are explicit overrides; a bad new flag must not fall back to the old one.
    for (const [flag, legacyFlag, expected] of [
      [null, "google/gemini-fixture", google],
      ["openai/gpt-6-luna", "google/gemini-fixture", model],
      ["unknown/missing", "google/gemini-fixture", undefined],
      ["", "google/gemini-fixture", undefined],
    ]) {
      const saved = memory("anthropic/claude-fixture");
      const h = harness({ flag, legacyFlag, settings: saved }); h.models(catalog); await h.start();
      await h.begin(); await h.finish();
      eq(h.requests.length, expected ? 1 : 0);
      if (expected) { eq(h.requests[0].model, expected); await h.settleResponse(0); }
      eq(saved.writes, []); eq(h.ctx.model.id, "gpt-6.1-sol"); eq(h.ctx.thinkingLevel, "xhigh");
      await h.shutdown();
    }

    // Bare command and explicit on share first-use setup, then reuse the chosen model.
    for (const command of ["", "on"]) {
      const saved = memory(), h = harness({ flag: null, settings: saved }); h.models(catalog);
      let pickers = 0;
      h.ctx.ui.custom = async factory => {
        pickers++; await h.emit("ui_prompt_start", { kind: "custom" });
        try {
          return await new Promise(resolve => {
            const picker = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_color, text) => text }, new KeybindingsManager(), resolve);
            picker.focused = true; picker.render(80);
            for (const character of "gemini") picker.handleInput(character);
            picker.handleInput("\r");
          });
        } finally { await h.emit("ui_prompt_end", { kind: "custom" }); }
      };
      await h.start(); await h.command("status"); eq(pickers, 0); eq(saved.writes, []);
      await h.command(command); eq(pickers, 1); eq(saved.writes, ["google/gemini-fixture"]); ok(h.editor);
      eq(h.requests.length, 0, "first-use setup makes no prediction request");
      await h.command("off"); await h.command(command); await h.command(command);
      eq(pickers, 1, "an existing selection is reused without a picker"); eq(saved.writes.length, 1);
      await h.command("status"); ok(h.notices.at(-1).text.startsWith("Pi-next: on; model: google/gemini-fixture;"));
      eq(h.ctx.model.id, "gpt-6.1-sol"); eq(h.ctx.thinkingLevel, "xhigh");
      await h.begin(); await h.finish(); eq(h.requests.length, 1); eq(h.requests[0].model.provider, "google"); await h.shutdown();
      for (const emptyCatalog of [false, true]) {
        const store = memory(), cancelled = harness({ flag: null, settings: store });
        cancelled.models(emptyCatalog ? [] : catalog); await cancelled.start();
        cancelled.ctx.ui.custom = async () => undefined;
        await cancelled.command(command); eq(store.writes, []); eq(cancelled.editor, undefined);
        await cancelled.begin(); await cancelled.finish(); eq(cancelled.requests.length, 0); await cancelled.shutdown();
      }
    }

    // Every chat provider uses the same Pi registry/request path, with no credential inspection.
    for (const chosen of catalog) {
      const h = harness({ flag: `${chosen.provider}/${chosen.id}` }); h.selected(chosen);
      h.oauth(false); h.authSource("env"); await h.start(); await h.begin(); await h.finish();
      eq(h.requests.length, 1); eq(h.requests[0].model, chosen); eq(h.authReads, 0);
      eq(h.requests[0].options.transport, undefined); eq(h.requests[0].options.transformHeaders, undefined);
      eq(h.ctx.model.id, "gpt-6.1-sol"); eq(h.ctx.thinkingLevel, "xhigh"); await h.shutdown();
    }
    const saved = memory();
    const h = harness({ flag: null, settings: saved }); h.models(catalog); await h.start();
    eq(h.editor, undefined); await h.command("on"); eq(h.requests.length, 0);
    await h.command("model google/gemini-fixture"); eq(saved.writes, ["google/gemini-fixture"]); ok(h.editor);
    eq(h.requests.length, 0, "choosing a model is not an inference request");
    await h.begin(); await h.finish(); eq(h.requests[0].model.provider, "google");
    await h.command("off"); eq(saved.writes.length, 1, "on/off is session-local"); await h.shutdown();
    const resumed = harness({ flag: null, settings: saved }); resumed.models(catalog); await resumed.start();
    ok(resumed.editor); await resumed.begin(); await resumed.finish(); eq(resumed.requests[0].model.provider, "google"); await resumed.shutdown();
    const override = harness({ settings: saved }); override.models(catalog); await override.start();
    await override.begin(); await override.finish(); eq(override.requests[0].model.provider, "openai"); eq(saved.writes.length, 1); await override.shutdown();
    const invalid = harness({ flag: "unknown/missing", settings: saved }); invalid.models(catalog); await invalid.start();
    invalid.ctx.ui.custom = () => { throw new Error("An invalid override must not silently open a fallback picker"); };
    for (const command of ["", "on"]) { await invalid.command(command); eq(saved.writes.length, 1); }
    await invalid.begin(); await invalid.finish(); eq(invalid.requests.length, 0, "invalid override never falls back to the saved or main model"); await invalid.shutdown();

    // Pi's real Input/SelectList provide a bounded searchable picker.
    let component;
    const pickerContext = { modelRegistry: { getAvailable: () => [...catalog, ...Array.from({ length: 500 }, (_, i) => ({ ...router, id: `org/fixture-${i}` }))] },
      ui: { custom: factory => new Promise(resolve => {
        component = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_color, text) => text }, new KeybindingsManager(), resolve);
        component.focused = true;
      }), notify() {} } };
    const picked = pickModel(pickerContext, "openai/gpt-6-luna");
    ok(component.render(80).length < 25, "large model catalogs do not render hundreds of rows");
    for (const width of [1, 2, 8, 20, 80]) ok(component.render(width).every(line => tui.visibleWidth(line) <= width), `picker width ${width}`);
    for (const character of "gemini") component.handleInput(character);
    ok(component.render(80).join("\n").includes("google/gemini-fixture"), "search matches a model ID without a provider prefix");
    component.handleInput("\r"); const selected = await picked; eq(selected, "google/gemini-fixture");
    const cancelled = pickModel(pickerContext, selected); component.handleInput("\x1b"); eq(await cancelled, undefined);
    const arrow = pickModel(pickerContext, selected); component.handleInput("\x1b[A"); component.handleInput("\r"); eq(await arrow, "openai/gpt-6-luna");
    let completed = false;
    const noMatches = pickModel(pickerContext, selected).then(value => { completed = true; return value; });
    for (const character of "zzzzzz-not-a-model") component.handleInput(character);
    ok(component.render(80).join("\n").includes("No matching models"));
    component.handleInput("\r"); await pause(); eq(completed, false, "Enter cannot choose a nonexistent match");
    component.handleInput("\x1b"); eq(await noMatches, undefined);
    const mouse = pickModel(pickerContext, "openai/gpt-6-luna"); component.render(80);
    ok(component.handleMouse({ type: "click", button: "left", x: 4, y: 3 })?.handled);
    eq(await mouse, "google/gemini-fixture");

    // Cancellation, failures, busy/headless contexts and editor ownership never save a choice.
    for (const mode of ["rpc", "print", "json"]) for (const command of ["", "on", "model google/gemini-fixture"]) {
      const s = { load() { throw new Error("must not read"); }, save() { throw new Error("must not write"); } };
      const headless = harness({ flag: null, mode, settings: s }); await headless.start(); await headless.command(command); eq(headless.requests.length, 0); await headless.shutdown();
    }
    for (const command of ["", "on", "model"]) for (const block of [x => x.setIdle(false), x => x.queue(true), x => x.emit("ui_prompt_start")]) {
      const s = memory(), busy = harness({ flag: null, settings: s }); busy.models(catalog); await busy.start(); await block(busy);
      await busy.command(command); eq(s.writes, []); eq(busy.requests.length, 0); await busy.shutdown();
    }
    for (const command of ["", "on", "model"]) for (const stop of [x => x.command("off"), x => x.shutdown(), x => x.emit("session_before_tree")]) {
      const s = memory(), pending = harness({ flag: null, settings: s }); pending.models(catalog); await pending.start();
      let finish;
      pending.ctx.ui.custom = () => new Promise(resolve => { finish = resolve; });
      const choosing = pending.command(command); await pause(); await stop(pending);
      finish("google/gemini-fixture"); await choosing; eq(s.writes, []); eq(pending.requests.length, 0); await pending.shutdown();
    }
    const conflictStore = memory(), conflict = harness({ flag: null, conflict: true, settings: conflictStore }); conflict.models(catalog);
    await conflict.start(); const original = conflict.factory; await conflict.command("model google/gemini-fixture");
    eq(conflictStore.writes, []); eq(conflict.factory, original); await conflict.shutdown();
    const failedStore = { load: () => "", save() { throw new Error("PRIVATE_SETTING_DETAILS"); } };
    const failed = harness({ flag: null, settings: failedStore }); failed.models(catalog); await failed.start();
    await failed.command("model google/gemini-fixture"); await failed.begin(); await failed.finish(); eq(failed.requests.length, 0);
    ok(!JSON.stringify(failed.notices).includes("PRIVATE_SETTING_DETAILS")); await failed.shutdown();
    const corrupt = harness({ flag: null, settings: { load() { throw new Error("PRIVATE_CONFIG"); }, save() {} } });
    await corrupt.start(); await corrupt.command("status"); ok(corrupt.notices.at(-1).text.includes("settings-error"));
    ok(!JSON.stringify(corrupt.notices).includes("PRIVATE_CONFIG")); await corrupt.shutdown();
    const unavailableStore = memory(), unavailable = harness({ flag: null, settings: unavailableStore }); await unavailable.start();
    await unavailable.command("model classifier/not-chat"); eq(unavailableStore.writes, []); eq(unavailable.requests.length, 0); await unavailable.shutdown();
    return checks;
  } finally {
    if (beforeAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = beforeAgentDir;
    rmSync(folder, { recursive: true, force: true });
  }
}
