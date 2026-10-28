import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, sdk, modules } from "./host.mjs";
const compiler = join(process.env.PI_TYPESCRIPT_DIR ?? join(project, "node_modules/typescript"), "bin/tsc");
if (!existsSync(compiler)) throw new Error("TypeScript is not installed here. Set PI_TYPESCRIPT_DIR to an existing compiler; no automatic installation occurs.");
const data = JSON.parse(readFileSync(join(project, "tsconfig.json"), "utf8"));
data.compilerOptions.paths = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-tui"].map(name => ["@earendil-works/" + name, [join(modules, "@earendil-works", name, "dist/index.d.ts")]]));
data.compilerOptions.typeRoots = [join(modules, "@types"), join(project, "node_modules/@types")];
delete data.include;
data.files = readdirSync(project).filter(name => name.endsWith(".ts")).map(name => join(project, name));
const scratch = mkdtempSync(join(tmpdir(), "pi-next-typecheck-"));
try {
 const path = join(scratch, "tsconfig.json");
 writeFileSync(path, JSON.stringify(data));
 execFileSync(process.execPath, [compiler, "--project", path], { stdio: "inherit" });
 console.log("Typecheck passed against Pi " + JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")).version);
} catch (error) { process.exitCode = error.status || 1; }
finally { rmSync(scratch, { recursive: true, force: true }); }
