import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Resolve on the extension host; the selected home stays fixed until reload. */
export function resolveDaemonHome(setting = ""): string {
  const configured = setting.trim();
  const home = configured || process.env.TITHON_HOME || join(homedir(), ".tithon");
  const expanded =
    home === "~" ? homedir() : home.startsWith("~/") ? join(homedir(), home.slice(2)) : home;
  if (configured && !isAbsolute(expanded)) {
    throw new Error(
      "tithon.homePath must be an absolute path on the extension host (or start with ~/).",
    );
  }
  return resolve(expanded);
}

export function defaultSocketPath(): string {
  return join(resolveDaemonHome(), "daemon.sock");
}
