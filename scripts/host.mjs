import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function findSdk() {
  if (process.env.PI_PACKAGE_DIR) return resolve(process.env.PI_PACKAGE_DIR);
  const local = join(project, "node_modules/@earendil-works/pi-coding-agent");
  if (existsSync(join(local, "package.json"))) return local;
  const agent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
  const root = process.env.PI_MANAGED_INSTALL_ROOT ?? join(agent, "install");
  const version = readFileSync(join(root, "current-version"), "utf8").trim();
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error("Invalid managed Pi version; set PI_PACKAGE_DIR.");
  const sdk = join(root, "releases", version, "node_modules/@earendil-works/pi-coding-agent");
  if (!existsSync(join(sdk, "package.json"))) throw new Error("SDK missing; set PI_PACKAGE_DIR.");
  return sdk;
}
export const sdk = findSdk();
export const modules = resolve(sdk, "../..");
