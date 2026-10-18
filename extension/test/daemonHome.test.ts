import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultSocketPath as daemonSocket } from "../src/daemonClient";
import { resolveDaemonHome } from "../src/daemonHome";
import { defaultSocketPath as sessionSocket } from "../src/sessionClient";

afterEach(() => vi.unstubAllEnvs());
it("prefers the setting, expands ~/ and rejects relative settings", () => {
  vi.stubEnv("TITHON_HOME", "/tmp/inherited-home");
  expect(resolveDaemonHome(" /tmp/workspace-home ")).toBe("/tmp/workspace-home");
  expect(resolveDaemonHome("~/demo")).toBe(join(homedir(), "demo"));
  expect(() => resolveDaemonHome("./relative")).toThrow("absolute path");
});
it("keeps client defaults on the same environment fallback", () => {
  vi.stubEnv("TITHON_HOME", "/tmp/inherited-home");
  expect(resolveDaemonHome("")).toBe(resolve("/tmp/inherited-home"));
  expect(daemonSocket()).toBe(join(resolveDaemonHome(), "daemon.sock"));
  expect(sessionSocket()).toBe(daemonSocket());
  delete process.env.TITHON_HOME;
  expect(resolveDaemonHome()).toBe(join(homedir(), ".tithon"));
});
